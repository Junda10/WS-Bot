'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');
const sharp = require('sharp');

const { closeDatabase, getDatabase } = require('../db/connection');
const { migrateDatabase } = require('../db/migrate');
const { createRepositories } = require('../db/repositories');
const { PermissionService } = require('../services/permission-service');
const { IssueService } = require('../services/issue-service');
const { AttachmentStorage } = require('../services/attachment-storage');
const { AttachmentProcessingQueue } = require('../services/attachment-processing-queue');
const { AttachmentService } = require('../services/attachment-service');
const { detectAttachmentType } = require('../services/attachment-type');
const { pdfPageNeedsOcr } = require('../services/attachment-extractors');
const { AttachmentImagePreprocessor } = require('../services/attachment-image-preprocessor');
const { AttachmentOcrService } = require('../services/attachment-ocr-service');
const { AttachmentExtractionProcessor } = require('../services/attachment-extraction-processor');
const { OcrWorkerService } = require('../services/ocr-worker-service');
const { PdfOcrRenderer } = require('../services/attachment-pdf-ocr-renderer');

const CHAT_JID = '120300000000000000@g.us';
const MEMBER_JID = '60111111111@c.us';
const FIXTURES = path.join(__dirname, 'fixtures', 'attachments');
const LIMITS = Object.freeze({
  maxFileBytes: 20 * 1024 * 1024,
  maxPdfPages: 100,
  maxPdfTextItems: 500_000,
  maxExtractedItems: 500_000,
  parserMaxOldSpaceMb: 128,
  maxImagePixels: 2_000_000,
  maxDocxUncompressedBytes: 100 * 1024 * 1024,
  maxExtractedChars: 1_000_000,
  processingTimeoutMs: 5000,
  maxZipEntries: 10_000,
  maxDocxCompressionRatio: 100,
  minPdfTextCharsPerPage: 20,
  maxOcrPdfPages: 3,
  ocrDesiredWidth: 800,
  maxOcrImageBytes: 2 * 1024 * 1024,
  ocrRecognizeTimeoutMs: 1000,
  imagePreprocessTimeoutMs: 1000,
  pdfOcrRenderTimeoutMs: 5000,
  minPdfTextItemsPerPage: 2,
  minPdfMeaningfulCharsPerPage: 20,
  minPdfTextCoverage: 0.005,
  ocrLanguages: 'eng+chi_sim',
  ocrEnabled: true,
});

async function image(width = 120, height = 60, orientation) {
  let pipeline = sharp({
    create: { width, height, channels: 3, background: '#f5f5f5' },
  }).jpeg();
  if (orientation) pipeline = pipeline.withMetadata({ orientation });
  return pipeline.toBuffer();
}

function fakeOcrWorker(createRecognize) {
  const workers = [];
  const calls = [];
  const createWorker = async (...args) => {
    calls.push(args);
    const index = workers.length;
    const worker = {
      terminated: 0,
      async recognize(input) { return createRecognize(input, index, worker); },
      async terminate() { worker.terminated += 1; },
    };
    workers.push(worker);
    return worker;
  };
  return { createWorker, workers, calls };
}

function deferredPromise() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeForkChild(onSend) {
  const child = new EventEmitter();
  child.killCount = 0;
  child.send = (message) => onSend?.(child, message);
  child.kill = () => { child.killCount += 1; return true; };
  return child;
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('Sharp applies EXIF rotation, bounded resize, grayscale PNG, and pre-decode pixel limits', async () => {
  const preprocessor = new AttachmentImagePreprocessor();
  const rotated = await preprocessor.preprocess(await image(40, 20, 6), {
    ...LIMITS, ocrDesiredWidth: 100,
  });
  const rotatedMetadata = await sharp(rotated.buffer).metadata();
  assert.equal(rotatedMetadata.format, 'png');
  assert.equal(rotatedMetadata.width, 20);
  assert.equal(rotatedMetadata.height, 40);
  assert.equal(rotatedMetadata.space, 'b-w');
  assert.equal(rotated.metadata.exifOrientation, 6);
  assert.deepEqual(rotated.metadata.operations,
    ['rotate-exif', 'resize-bounded', 'grayscale', 'normalize', 'sharpen']);

  const resized = await preprocessor.preprocess(await image(400, 200), {
    ...LIMITS, ocrDesiredWidth: 100,
  });
  assert.equal(resized.metadata.width, 100);
  assert.equal(resized.metadata.height, 50);
  assert.ok(resized.metadata.pixels <= LIMITS.maxImagePixels);

  await assert.rejects(
    preprocessor.preprocess(await image(200, 200), { ...LIMITS, maxImagePixels: 10_000 }),
    (error) => error.code === 'IMAGE_PIXEL_LIMIT'
  );
  await assert.rejects(
    preprocessor.preprocess(await image(100, 100), { ...LIMITS, maxOcrImageBytes: 10 }),
    (error) => error.code === 'OCR_IMAGE_BYTE_LIMIT'
  );
});

test('mock eng+chi_sim OCR is framed as untrusted evidence with persisted-safe metadata', async () => {
  const fake = fakeOcrWorker(async () => ({
    data: { text: 'Merchant login fixed 商户登录已修复', confidence: 94.5 },
  }));
  const worker = new OcrWorkerService({
    createWorker: fake.createWorker,
    languages: 'eng+chi_sim',
    timeoutMs: 1000,
  });
  const ocr = new AttachmentOcrService({ worker });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-ocr-image-'));
  const filePath = path.join(root, 'sample.jpg');
  fs.writeFileSync(filePath, await image());
  const result = await ocr.extractImage(filePath, {
    kind: 'jpeg', displayName: 'sample.jpg',
  }, LIMITS);
  await ocr.terminate();
  fs.rmSync(root, { recursive: true, force: true });

  assert.equal(result.status, 'PARSED');
  assert.match(result.text, /BEGIN UNTRUSTED ATTACHMENT EVIDENCE/u);
  assert.match(result.text, /Merchant login fixed 商户登录已修复/u);
  assert.equal(result.metadata.languages, 'eng+chi_sim');
  assert.equal(result.metadata.confidence, 94.5);
  assert.equal(result.metadata.image.outputFormat, 'png');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0][0], 'eng+chi_sim');
  assert.equal(fake.calls[0][2].cacheMethod, 'readOnly');
});

test('captured Tesseract errorHandler contains initialization/recognition faults and restart works', async () => {
  const handlers = [];
  let createCount = 0;
  const workers = [];
  const createWorker = (_languages, _oem, options) => {
    handlers.push(options.errorHandler);
    const index = createCount++;
    if (index === 0) return new Promise(() => {});
    const worker = {
      terminated: 0,
      recognize() {
        if (index === 1) return new Promise(() => {});
        return Promise.resolve({ data: { text: 'restarted after callback fault' } });
      },
      terminate() { worker.terminated += 1; return Promise.resolve(); },
    };
    workers.push(worker);
    return Promise.resolve(worker);
  };
  const service = new OcrWorkerService({
    createWorker, initializeTimeoutMs: 200, timeoutMs: 200, terminateTimeoutMs: 20,
  });

  const initializing = service.initialize();
  await nextTurn();
  assert.equal(typeof handlers[0], 'function');
  assert.doesNotThrow(() => handlers[0](new Error('traineddata callback failed')));
  await assert.rejects(initializing, (error) => error.code === 'OCR_INITIALIZATION_FAILED');

  const recognizing = service.recognize(Buffer.from('active'));
  await nextTurn();
  await nextTurn();
  assert.equal(typeof handlers[1], 'function');
  assert.doesNotThrow(() => handlers[1](new Error('wasm callback crashed')));
  await assert.rejects(recognizing, (error) => error.code === 'OCR_WORKER_FAILED');
  assert.equal(workers[0].terminated, 1);

  const restarted = await service.recognize(Buffer.from('restart'));
  assert.equal(restarted.data.text, 'restarted after callback fault');
  assert.equal(createCount, 3);
  await service.terminate();
});

test('hanging worker initialization is bounded; late settle is quarantined; later init succeeds', async (t) => {
  await t.test('timeout followed by late resolve with hanging terminate', async () => {
    const late = deferredPromise();
    let calls = 0;
    const stale = {
      terminated: 0,
      recognize() { throw new Error('stale worker must never be used'); },
      terminate() { stale.terminated += 1; return new Promise(() => {}); },
    };
    const healthy = {
      recognize: async () => ({ data: { text: 'healthy' } }),
      terminate: async () => {},
    };
    const service = new OcrWorkerService({
      createWorker: () => (calls++ === 0 ? late.promise : Promise.resolve(healthy)),
      initializeTimeoutMs: 8,
      timeoutMs: 100,
      terminateTimeoutMs: 8,
      shutdownTimeoutMs: 25,
    });

    await assert.rejects(service.initialize(), (error) => error.code === 'OCR_INITIALIZATION_TIMEOUT');
    assert.equal(await service.initialize(), healthy);
    late.resolve(stale);
    await nextTurn();
    assert.equal(stale.terminated, 1, 'late worker is terminated, never installed');
    assert.equal((await service.recognize(Buffer.from('ok'))).data.text, 'healthy');
    const started = Date.now();
    await service.terminate();
    assert.ok(Date.now() - started < 150, 'shutdown does not await hanging stale terminate');
  });

  await t.test('abort followed by late reject', async () => {
    const late = deferredPromise();
    const healthy = {
      recognize: async () => ({ data: { text: 'after abort' } }),
      terminate: async () => {},
    };
    let calls = 0;
    const service = new OcrWorkerService({
      createWorker: () => (calls++ === 0 ? late.promise : Promise.resolve(healthy)),
      initializeTimeoutMs: 200,
      timeoutMs: 100,
      terminateTimeoutMs: 8,
      shutdownTimeoutMs: 25,
    });
    const controller = new AbortController();
    const initializing = service.initialize({ signal: controller.signal });
    await nextTurn();
    controller.abort();
    await assert.rejects(initializing, (error) => error.name === 'AbortError');
    assert.equal(await service.initialize(), healthy);
    late.reject(new Error('late createWorker rejection'));
    await nextTurn();
    assert.equal((await service.recognize(Buffer.from('ok'))).data.text, 'after abort');
    await service.terminate();
  });
});

test('recognition resolving after its deadline remains OCR_TIMEOUT despite slow termination', async () => {
  let creates = 0;
  const poisoned = {
    recognize: () => new Promise((resolve) => setTimeout(
      () => resolve({ data: { text: 'too late' } }), 25
    )),
    terminate: () => new Promise(() => {}),
  };
  const healthy = {
    recognize: async () => ({ data: { text: 'fresh worker' } }),
    terminate: async () => {},
  };
  const service = new OcrWorkerService({
    createWorker: async () => (creates++ === 0 ? poisoned : healthy),
    timeoutMs: 7,
    initializeTimeoutMs: 100,
    terminateTimeoutMs: 7,
    shutdownTimeoutMs: 25,
  });
  const started = Date.now();
  await assert.rejects(
    service.recognize(Buffer.from('late')),
    (error) => error.code === 'OCR_TIMEOUT'
  );
  assert.ok(Date.now() - started < 150, 'timeout is not delayed by terminate()');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await service.recognize(Buffer.from('next'))).data.text, 'fresh worker');
  await service.terminate();
});

test('OCR worker shares initialization, serializes concurrency one, and reuses worker', async () => {
  let active = 0;
  let maxActive = 0;
  const fake = fakeOcrWorker(async (_input, index) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return { data: { text: `worker-${index}` } };
  });
  const worker = new OcrWorkerService({ createWorker: fake.createWorker, timeoutMs: 1000 });
  const [initializedOne, initializedTwo] = await Promise.all([worker.initialize(), worker.initialize()]);
  assert.equal(initializedOne, initializedTwo);
  const results = await Promise.all([
    worker.recognize(Buffer.from('one')),
    worker.recognize(Buffer.from('two')),
    worker.recognize(Buffer.from('three')),
  ]);
  assert.deepEqual(results.map((result) => result.data.text), ['worker-0', 'worker-0', 'worker-0']);
  assert.equal(fake.calls.length, 1);
  assert.equal(maxActive, 1);
  await worker.terminate();
  assert.equal(fake.workers[0].terminated, 1);
  await worker.terminate();
  assert.equal(fake.workers[0].terminated, 1, 'termination is idempotent');
});

test('OCR timeout/abort terminate poisoned workers and later calls restart cleanly', async () => {
  const fake = fakeOcrWorker(async (_input, index) => {
    if (index < 2) return new Promise(() => {});
    return { data: { text: 'restarted' } };
  });
  const worker = new OcrWorkerService({ createWorker: fake.createWorker, timeoutMs: 20 });
  await assert.rejects(worker.recognize(Buffer.from('timeout')),
    (error) => error.code === 'OCR_TIMEOUT');
  assert.equal(fake.workers[0].terminated, 1);

  const controller = new AbortController();
  const aborted = worker.recognize(Buffer.from('abort'), { signal: controller.signal, timeoutMs: 1000 });
  setImmediate(() => controller.abort());
  await assert.rejects(aborted, (error) => error.name === 'AbortError');
  assert.equal(fake.workers[1].terminated, 1);

  const result = await worker.recognize(Buffer.from('restart'));
  assert.equal(result.data.text, 'restarted');
  assert.equal(fake.calls.length, 3);
  await worker.terminate();
});

test('worker recognition failure is isolated and the next request creates a fresh worker', async () => {
  const fake = fakeOcrWorker(async (_input, index) => {
    if (index === 0) throw new Error('wasm crashed');
    return { data: { text: 'healthy worker' } };
  });
  const worker = new OcrWorkerService({ createWorker: fake.createWorker, timeoutMs: 1000 });
  await assert.rejects(worker.recognize(Buffer.from('bad')),
    (error) => error.code === 'OCR_WORKER_FAILED');
  assert.equal(fake.workers[0].terminated, 1);
  assert.equal((await worker.recognize(Buffer.from('good'))).data.text, 'healthy worker');
  assert.equal(fake.calls.length, 2);
  await worker.terminate();
});

test('low-density heuristic selects header/tiny coverage but not adequate page text', () => {
  const thresholds = {
    minPdfTextCharsPerPage: 20,
    minPdfTextItemsPerPage: 2,
    minPdfMeaningfulCharsPerPage: 20,
    minPdfTextCoverage: 0.005,
  };
  assert.equal(pdfPageNeedsOcr({
    textChars: 24, textItemCount: 3, meaningfulChars: 8, textCoverage: 0.02,
  }, thresholds), true, 'short repeated header is not adequate page evidence');
  assert.equal(pdfPageNeedsOcr({
    textChars: 80, textItemCount: 4, meaningfulChars: 70, textCoverage: 0.0004,
  }, thresholds), true, 'tiny text coverage is selected even with enough characters');
  assert.equal(pdfPageNeedsOcr({
    textChars: 80, textItemCount: 4, meaningfulChars: 70, textCoverage: 0.02,
  }, thresholds), false, 'adequately populated page stays native-text only');
});

test('scanned/low-density PDF OCR selects only needed pages and retains partial page provenance', async () => {
  const renderedSelections = [];
  const ocrCalls = [];
  const processor = new AttachmentExtractionProcessor({
    pdfTextExtractor: async () => ({
      status: 'NEEDS_OCR',
      text: null,
      errorCode: 'PDF_NEEDS_OCR',
      errorMessage: 'low density',
      retryable: true,
      pageTexts: ['Page one has enough native searchable report text.', '', 'x'],
      ocrPageNumbers: [2, 3],
      metadata: { pageCount: 3, pageTextChars: [45, 0, 1], adapter: 'mock-pdf-text' },
    }),
    pdfRenderer: {
      async renderPages(_filePath, pages) {
        renderedSelections.push([...pages]);
        return pages.map((pageNumber) => ({
          pageNumber, ok: true, buffer: Buffer.from(`page-${pageNumber}`),
          width: 800, height: 1000,
        }));
      },
    },
    ocrService: {
      async recognize(_buffer, metadata) {
        ocrCalls.push(metadata.pdfPageNumber);
        if (metadata.pdfPageNumber === 3) {
          throw Object.assign(new Error('page recognition failed'), { code: 'OCR_WORKER_FAILED', retryable: true });
        }
        return { text: '第二页扫描内容', confidence: 90, metadata: {} };
      },
      async extractImage() { throw new Error('not used'); },
    },
  });
  const result = await processor.process(
    fs.realpathSync(path.join(FIXTURES, 'scanned-image.pdf')),
    { kind: 'pdf', displayName: 'scan.pdf' },
    LIMITS
  );
  assert.equal(result.status, 'PARSED');
  assert.deepEqual(renderedSelections, [[2, 3]]);
  assert.deepEqual(ocrCalls, [2, 3]);
  assert.match(result.text, /PDF PAGE 1 \| source=TEXT/u);
  assert.match(result.text, /PDF PAGE 2 \| source=OCR[\s\S]*第二页扫描内容/u);
  assert.match(result.text, /PDF PAGE 3 \| source=TEXT[\s\S]*x/u);
  assert.equal(result.metadata.ocrStatus, 'PARTIAL');
  assert.deepEqual(result.metadata.ocrProcessedPages, [2]);
  assert.deepEqual(result.metadata.failedPages.map((page) => page.pageNumber), [3]);
});

test('scanned PDF uses real bounded getScreenshot with an injected fake OCR worker only', async () => {
  const fake = fakeOcrWorker(async () => ({
    data: { text: 'Scanned merchant report 扫描报告', confidence: 88 },
  }));
  const worker = new OcrWorkerService({
    createWorker: fake.createWorker, languages: 'eng+chi_sim', timeoutMs: 1000,
  });
  const ocr = new AttachmentOcrService({ worker });
  const processor = new AttachmentExtractionProcessor({ ocrService: ocr });
  const result = await processor.process(
    fs.realpathSync(path.join(FIXTURES, 'scanned-image.pdf')),
    { kind: 'pdf', displayName: 'scanned-image.pdf' },
    { ...LIMITS, ocrDesiredWidth: 400 }
  );
  await processor.terminate();
  assert.equal(result.status, 'PARSED');
  assert.match(result.text, /PDF PAGE 1 \| source=OCR/u);
  assert.match(result.text, /Scanned merchant report 扫描报告/u);
  assert.equal(result.metadata.ocrStatus, 'SUCCEEDED');
  assert.deepEqual(result.metadata.ocrRequestedPages, [1]);
  assert.equal(fake.calls.length, 1);
});

test('PDF renderer forks a fresh child per page and page failure never poisons the next page', async (t) => {
  for (const failure of ['crash', 'timeout']) {
    await t.test(failure, async () => {
      const children = [];
      const renderer = new PdfOcrRenderer({
        fork: () => {
          const index = children.length;
          const child = fakeForkChild((instance, message) => {
            if (index === 0 && failure === 'crash') {
              setImmediate(() => instance.emit('exit', 9, null));
            } else if (index === 0) {
              // Keep the event loop alive beyond the unref'ed renderer timer.
              setTimeout(() => {}, 25);
            } else {
              setImmediate(() => instance.emit('message', {
                type: 'page', pageNumber: message.pageNumber,
                data: Buffer.from(`png-${message.pageNumber}`), width: 20, height: 30,
              }));
            }
          });
          children.push(child);
          return child;
        },
      });
      const results = await renderer.renderPages(
        fs.realpathSync(path.join(FIXTURES, 'scanned-image.pdf')),
        [1, 2],
        { ...LIMITS, pdfOcrRenderTimeoutMs: 8 },
        {}
      );
      assert.equal(children.length, 2);
      assert.notEqual(children[0], children[1]);
      assert.equal(results[0].ok, false);
      assert.equal(results[0].error.code,
        failure === 'crash' ? 'PDF_OCR_CHILD_EXIT' : 'PDF_OCR_RENDER_TIMEOUT');
      assert.equal(results[1].ok, true);
      assert.equal(results[1].buffer.toString(), 'png-2');
      assert.equal(children[0].killCount, 1);
      assert.equal(children[1].killCount, 0);
    });
  }
});

test('resource-isolated pdf-parse getScreenshot renders one bounded selected page', async () => {
  const renderer = new PdfOcrRenderer();
  const seen = [];
  const results = await renderer.renderPages(
    fs.realpathSync(path.join(FIXTURES, 'scanned-image.pdf')),
    [1],
    { ...LIMITS, ocrDesiredWidth: 400 },
    {}
  );
  assert.equal(results[0].ok, true);
  seen.push(results[0]);
  assert.equal(results[0].buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(results[0].buffer.length <= LIMITS.maxOcrImageBytes);
  assert.equal(seen[0].pageNumber, 1);
  assert.ok(seen[0].width <= 401);
  assert.ok(seen[0].width * seen[0].height <= LIMITS.maxImagePixels);
});

test('all selected OCR pages failing remains NEEDS_OCR despite native header noise', async () => {
  const processor = new AttachmentExtractionProcessor({
    pdfTextExtractor: async () => ({
      status: 'NEEDS_OCR', text: null, errorCode: 'PDF_NEEDS_OCR',
      errorMessage: 'low density', retryable: true,
      pageTexts: ['Confidential report header'], ocrPageNumbers: [1],
      metadata: { pageCount: 1, adapter: 'mock', pageTextChars: [24] },
    }),
    pdfRenderer: {
      async renderPages() {
        return [{ pageNumber: 1, ok: true, buffer: Buffer.from('page'), width: 20, height: 30 }];
      },
    },
    ocrService: {
      async recognize() {
        throw Object.assign(new Error('recognizer unavailable'), {
          code: 'OCR_WORKER_FAILED', retryable: true,
        });
      },
      async extractImage() { throw new Error('not used'); },
    },
  });
  const result = await processor.process(
    fs.realpathSync(path.join(FIXTURES, 'scanned-image.pdf')),
    { kind: 'pdf', displayName: 'noise.pdf' },
    LIMITS
  );
  assert.equal(result.status, 'NEEDS_OCR');
  assert.equal(result.text, null);
  assert.equal(result.errorCode, 'PDF_NEEDS_OCR');
  assert.equal(result.retryable, true);
  assert.equal(result.metadata.ocrStatus, 'NEEDS_OCR');
  assert.deepEqual(result.metadata.ocrProcessedPages, []);
  assert.equal(result.metadata.failedPages[0].code, 'OCR_WORKER_FAILED');
});

test('text PDF result never invokes renderer or OCR', async () => {
  let renderCalls = 0;
  let ocrCalls = 0;
  const processor = new AttachmentExtractionProcessor({
    pdfTextExtractor: async () => ({ status: 'PARSED', text: 'native text', metadata: {} }),
    pdfRenderer: { async renderPages() { renderCalls += 1; } },
    ocrService: {
      async recognize() { ocrCalls += 1; },
      async extractImage() { ocrCalls += 1; },
    },
  });
  const result = await processor.process(
    fs.realpathSync(path.join(FIXTURES, 'valid-text.pdf')),
    { kind: 'pdf', displayName: 'text.pdf' },
    LIMITS
  );
  assert.equal(result.status, 'PARSED');
  assert.equal(renderCalls, 0);
  assert.equal(ocrCalls, 0);
});

test('image preprocess child crash/hang/abort are contained and unsafe pixel config is rejected', async (t) => {
  await t.test('child crash', async () => {
    let child;
    const preprocessor = new AttachmentImagePreprocessor({
      fork: () => {
        child = fakeForkChild((instance) => setImmediate(() => instance.emit('exit', 7, null)));
        return child;
      },
    });
    await assert.rejects(
      preprocessor.preprocess(Buffer.from('image'), { ...LIMITS, imagePreprocessTimeoutMs: 50 }),
      (error) => error.code === 'IMAGE_PREPROCESS_CHILD_EXIT'
    );
    assert.equal(child.killCount, 1);
  });

  await t.test('child hang timeout', async () => {
    let child;
    const preprocessor = new AttachmentImagePreprocessor({
      fork: () => {
        child = fakeForkChild(() => setTimeout(() => {}, 25));
        return child;
      },
    });
    await assert.rejects(
      preprocessor.preprocess(Buffer.from('image'), { ...LIMITS, imagePreprocessTimeoutMs: 8 }),
      (error) => error.code === 'IMAGE_PREPROCESS_TIMEOUT'
    );
    assert.equal(child.killCount, 1);
  });

  await t.test('abort', async () => {
    let child;
    const controller = new AbortController();
    const preprocessor = new AttachmentImagePreprocessor({
      fork: () => {
        child = fakeForkChild(() => {});
        return child;
      },
    });
    const operation = preprocessor.preprocess(Buffer.from('image'), LIMITS, {
      signal: controller.signal,
    });
    setImmediate(() => controller.abort());
    await assert.rejects(operation, (error) => (
      error.name === 'AbortError' && error.code === 'PROCESSING_TIMEOUT'
    ));
    assert.equal(child.killCount, 1);
  });

  const neverFork = new AttachmentImagePreprocessor({
    fork: () => { throw new Error('must reject before fork'); },
  });
  await assert.rejects(
    neverFork.preprocess(Buffer.from('image'), { ...LIMITS, maxImagePixels: 100_000_001 }),
    (error) => error.code === 'IMAGE_PIXEL_LIMIT' && error.retryable === false
  );
});

function lifecycleContext(t, extractor, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-ocr-lifecycle-'));
  const db = getDatabase({ filename: path.join(root, 'test.sqlite3'), busyTimeoutMs: 1000 });
  migrateDatabase(db, { now: () => 1 });
  const repositories = createRepositories(db);
  const chat = repositories.chats.create({
    chatUid: 'ocr-chat', jid: CHAT_JID, timezone: 'UTC', now: 2,
  }).record;
  repositories.permissions.set({ chatId: chat.id, canonicalJid: MEMBER_JID, role: 'MEMBER', now: 3 });
  let now = 100;
  const clock = () => now++;
  const permissionService = new PermissionService({ repositories, authorizedChatJid: CHAT_JID });
  const issueService = new IssueService({ repositories, permissionService, clock });
  const storage = new AttachmentStorage({
    rootDir: path.join(root, 'archive'), tempDir: path.join(root, 'tmp'),
  });
  const queue = new AttachmentProcessingQueue({ concurrency: 1, maxPending: 10 });
  let redownloads = 0;
  const adapter = {
    async downloadAttachment() { throw new Error('not used'); },
    async downloadQuotedAttachment() { throw new Error('not used'); },
    async downloadAttachmentByMessageId() { redownloads += 1; throw new Error('must not re-download'); },
  };
  const processor = {
    async process(buffer, metadata, limits) {
      return {
        detected: await detectAttachmentType(buffer, metadata, limits),
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      };
    },
  };
  const service = new AttachmentService({
    repositories, permissionService, issueService, storage, queue, adapter, processor, extractor,
    limits: options.limits || LIMITS, clock, logger: { warn() {}, error() {} },
  });
  const message = repositories.messages.create({
    whatsappMessageId: 'ocr-image-message', chatId: chat.id, senderJid: MEMBER_JID,
    body: 'image', sentAt: 10, receivedAt: 10,
  }).record;
  const attachment = repositories.attachments.create({
    idempotencyKey: 'ocr-image-attachment', messageId: message.id,
    mediaWhatsappMessageId: message.whatsapp_message_id,
    displayName: 'scan.jpg', declaredMime: 'image/jpeg', sizeBytes: 0,
    processingStatus: 'PENDING', now: clock(),
  }).record;
  t.after(async () => {
    service.stopRecovery();
    queue.stopAccepting();
    await queue.drain({ timeoutMs: 2000 });
    await service.terminate();
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { repositories, storage, queue, service, attachment, redownloads: () => redownloads };
}

test('OCR-disabled image and scanned PDF are terminal and repeated recovery queues neither', async (t) => {
  const disabledLimits = { ...LIMITS, ocrEnabled: false };
  const ocr = new AttachmentOcrService({
    worker: {
      async recognize() { throw new Error('disabled OCR must not initialize'); },
      async terminate() {},
    },
  });
  const extractor = new AttachmentExtractionProcessor({
    ocrService: ocr,
    pdfTextExtractor: async () => ({
      status: 'NEEDS_OCR', text: null, errorCode: 'PDF_NEEDS_OCR',
      errorMessage: 'scanned page', retryable: true,
      pageTexts: [''], ocrPageNumbers: [1],
      metadata: { pageCount: 1, adapter: 'mock-pdf', ocrPageNumbers: [1] },
    }),
  });
  const context = lifecycleContext(t, extractor, { limits: disabledLimits });
  const imagePayload = await image(100, 50);
  await context.service.enqueue(context.attachment.id, async () => ({
    buffer: imagePayload, fileName: 'scan.jpg', mimeType: 'image/jpeg',
    sizeBytes: imagePayload.length,
  }));

  const pdfAttachment = context.repositories.attachments.create({
    idempotencyKey: 'ocr-disabled-pdf', messageId: context.attachment.message_id,
    mediaWhatsappMessageId: context.attachment.media_whatsapp_message_id,
    displayName: 'scan.pdf', declaredMime: 'application/pdf', sizeBytes: 0,
    processingStatus: 'PENDING', now: 100,
  }).record;
  const pdfPayload = fs.readFileSync(path.join(FIXTURES, 'scanned-image.pdf'));
  await context.service.enqueue(pdfAttachment.id, async () => ({
    buffer: pdfPayload, fileName: 'scan.pdf', mimeType: 'application/pdf',
    sizeBytes: pdfPayload.length,
  }));

  for (const id of [context.attachment.id, pdfAttachment.id]) {
    const record = context.repositories.attachments.findById(id);
    assert.equal(record.processing_status, 'UNPARSED');
    assert.equal(record.parse_status, 'NEEDS_OCR');
    assert.equal(record.retryable, 0);
  }
  const firstRecovery = await context.service.recoverPending();
  const secondRecovery = await context.service.recoverPending();
  assert.deepEqual(firstRecovery.queued, []);
  assert.deepEqual(secondRecovery.queued, []);
  assert.equal(context.redownloads(), 0);
});

test('automatic image OCR failure preserves archive and restart recovery uses blob without download', async (t) => {
  let recognizeCalls = 0;
  const ocr = {
    async extractImage(filePath, metadata, limits) {
      recognizeCalls += 1;
      assert.ok(fs.existsSync(filePath));
      if (recognizeCalls === 1) {
        return {
          status: 'NEEDS_OCR', text: null, errorCode: 'OCR_WORKER_FAILED',
          errorMessage: 'saved but OCR worker failed', retryable: true,
          metadata: { ocrStatus: 'NEEDS_OCR', languages: limits.ocrLanguages },
        };
      }
      return {
        status: 'PARSED',
        text: '[UNTRUSTED ATTACHMENT EVIDENCE]\nrecovered 商户图片',
        errorCode: null, errorMessage: null, retryable: false,
        metadata: { ocrStatus: 'SUCCEEDED', languages: limits.ocrLanguages, truncated: false },
      };
    },
    async terminate() {},
  };
  const extractor = new AttachmentExtractionProcessor({ ocrService: ocr });
  const context = lifecycleContext(t, extractor);
  const payload = await image(160, 80);
  await context.service.enqueue(context.attachment.id, async () => ({
    buffer: payload, fileName: 'scan.jpg', mimeType: 'image/jpeg', sizeBytes: payload.length,
  }));

  const failed = context.repositories.attachments.findById(context.attachment.id);
  assert.equal(failed.processing_status, 'UNPARSED');
  assert.equal(failed.parse_status, 'NEEDS_OCR');
  assert.equal(failed.retryable, 1);
  assert.equal(failed.last_error_code, 'OCR_WORKER_FAILED');
  assert.ok(failed.blob_sha256);
  assert.ok(fs.existsSync(context.storage.resolve(failed.storage_key)));
  assert.deepEqual(JSON.parse(failed.extraction_metadata_json), {
    ocrStatus: 'NEEDS_OCR', languages: 'eng+chi_sim',
  });
  const failedAttempts = context.repositories.attachments.listAttempts(failed.id);
  assert.deepEqual(failedAttempts.map((attempt) => attempt.operation), ['DOWNLOAD', 'OCR']);
  assert.equal(failedAttempts[1].status, 'FAILED');
  assert.equal(failedAttempts[1].error_code, 'OCR_WORKER_FAILED');
  assert.match(failedAttempts[1].error_message, /worker failed/u);
  assert.equal(failedAttempts[1].retryable, 1);

  const recovery = await context.service.recoverPending();
  assert.deepEqual(recovery.queued, [failed.id]);
  await context.queue.drain({ timeoutMs: 2000 });
  const recovered = context.repositories.attachments.findById(failed.id);
  assert.equal(recovered.processing_status, 'READY');
  assert.equal(recovered.parse_status, 'PARSED');
  assert.match(recovered.extracted_text, /recovered 商户图片/u);
  assert.equal(JSON.parse(recovered.extraction_metadata_json).ocrStatus, 'SUCCEEDED');
  assert.equal(context.redownloads(), 0);
  assert.deepEqual(
    context.repositories.attachments.listAttempts(failed.id).map((attempt) => attempt.operation),
    ['DOWNLOAD', 'OCR', 'OCR']
  );
});

test('illegal failed OCR repository transition rolls back attempt and attachment state', async (t) => {
  const extractor = new AttachmentExtractionProcessor({
    ocrService: {
      async extractImage() {
        return {
          status: 'NEEDS_OCR', text: null, errorCode: 'OCR_WORKER_FAILED',
          errorMessage: 'temporary OCR fault', retryable: true,
          metadata: { ocrStatus: 'NEEDS_OCR' },
        };
      },
      async terminate() {},
    },
  });
  const context = lifecycleContext(t, extractor);
  const payload = await image(80, 40);
  await context.service.enqueue(context.attachment.id, async () => ({
    buffer: payload, fileName: 'scan.jpg', mimeType: 'image/jpeg', sizeBytes: payload.length,
  }));
  const claimId = 'illegal-state-claim';
  assert.ok(context.repositories.attachments.claimForQueue({
    attachmentId: context.attachment.id, claimId, now: 10_000,
  }));
  const attempt = context.repositories.attachments.startAttempt({
    idempotencyKey: 'illegal-state-attempt', attachmentId: context.attachment.id,
    operation: 'OCR', claimId, now: 10_001, leaseUntil: 20_000,
  }).record;

  assert.throws(() => context.repositories.attachments.completeAttempt({
    attemptId: attempt.id,
    status: 'FAILED',
    attachmentStatus: 'READY',
    parseStatus: 'PARSED',
    errorCode: 'IMPOSSIBLE',
    errorMessage: 'must roll back',
    retryable: true,
    now: 10_002,
  }), /failed attempt may preserve only/u);
  const persistedAttempt = context.repositories.attachments.listAttempts(context.attachment.id)
    .find((entry) => entry.id === attempt.id);
  const persistedAttachment = context.repositories.attachments.findById(context.attachment.id);
  assert.equal(persistedAttempt.status, 'STARTED');
  assert.equal(persistedAttempt.error_code, null);
  assert.equal(persistedAttachment.processing_status, 'PROCESSING');
  assert.equal(persistedAttachment.parse_status, 'PARSING');
  assert.equal(persistedAttachment.processing_claim_id, claimId);
});

test('OCR smoke CLI rejects bad args and missing local traineddata without OCR/network', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsb-ocr-smoke-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(__dirname, '..', 'scripts', 'ocr-smoke.js');
  const common = {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 3000,
    env: {
      ...process.env,
      PM_OCR_ENABLED: 'true',
      PM_OCR_LANGUAGES: 'eng+chi_sim',
      PM_OCR_LANG_PATH: root,
      PM_OCR_CACHE_PATH: path.join(root, 'cache'),
    },
  };

  const badArgs = spawnSync(process.execPath, [script], common);
  assert.notEqual(badArgs.status, 0);
  assert.match(badArgs.stderr, /Usage: npm run ocr:smoke/u);
  assert.equal(badArgs.error, undefined);

  const missingData = spawnSync(process.execPath, [script, __filename], common);
  assert.notEqual(missingData.status, 0);
  assert.match(missingData.stderr, /Missing local traineddata for eng, chi_sim/u);
  assert.match(missingData.stderr, /does not download/u);
  assert.equal(missingData.error, undefined);
});
