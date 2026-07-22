'use strict';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { Worker } = require('worker_threads');
const {
  AttachmentExtractionError,
  IMAGE_KINDS,
  frameEvidence,
  savedUnparsed,
} = require('./attachment-extractors');
const { PdfOcrRenderer } = require('./attachment-pdf-ocr-renderer');

class AttachmentExtractionProcessor {
  constructor(options = {}) {
    this.Worker = options.Worker || Worker;
    this.fork = options.fork || fork;
    this.workerPath = options.workerPath || path.join(__dirname, 'attachment-extraction-worker.js');
    this.pdfChildPath = options.pdfChildPath || path.join(__dirname, 'attachment-pdf-child.js');
    this.ocr = options.ocrService || null;
    this.pdfRenderer = options.pdfRenderer || new PdfOcrRenderer({ fork: this.fork });
    this.pdfTextExtractor = options.pdfTextExtractor || null;
  }

  terminate() {
    return this.ocr?.terminate?.() || Promise.resolve();
  }

  process(filePath, metadata = {}, limits = {}, options = {}) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      return Promise.reject(new TypeError('Attachment extraction requires an absolute canonical file path'));
    }
    let canonical;
    try {
      canonical = fs.realpathSync(filePath);
      if (canonical !== path.resolve(filePath)) {
        throw new TypeError('Attachment extraction path must already be canonical');
      }
    } catch (error) {
      return Promise.reject(error);
    }
    if (options.signal?.aborted) return Promise.reject(this._abortError());
    const kind = String(metadata.kind || '').toLowerCase();
    if (kind === 'pdf') return this._processPdf(canonical, metadata, limits, options);
    if (IMAGE_KINDS.has(kind)) return this._processImage(canonical, metadata, limits, options);
    return this._processWorker(canonical, metadata, limits, options);
  }

  _processWorker(filePath, metadata, limits, options) {
    const memoryMb = this._memoryLimit(limits);
    const worker = new this.Worker(this.workerPath, {
      resourceLimits: {
        maxOldGenerationSizeMb: memoryMb,
        maxYoungGenerationSizeMb: Math.max(4, Math.min(16, Math.floor(memoryMb / 4))),
        stackSizeMb: 4,
      },
    });
    return this._awaitIsolate({
      isolate: worker,
      signal: options.signal,
      timeoutMs: this._timeout(limits),
      send: () => worker.postMessage({ filePath, metadata, limits }),
      stop: () => worker.terminate(),
      exitEvent: 'exit',
      errorEvent: 'error',
      exitCode: (value) => value,
      label: 'Attachment extraction worker',
      exitCodeName: 'PARSER_WORKER_EXIT',
    });
  }

  async _processImage(filePath, metadata, limits, options) {
    if (!this.ocr) {
      return savedUnparsed(
        'OCR_UNAVAILABLE',
        'Image was saved but no OCR service is configured',
        { ocrStatus: 'DISABLED' },
        'NEEDS_OCR',
        false
      );
    }
    return this.ocr.extractImage(filePath, metadata, limits, options);
  }

  async _processPdf(filePath, metadata, limits, options) {
    const textResult = this.pdfTextExtractor
      ? await this.pdfTextExtractor(filePath, metadata, limits, options)
      : await this._processPdfText(filePath, metadata, limits, options);
    if (textResult.status !== 'NEEDS_OCR' || textResult.errorCode !== 'PDF_NEEDS_OCR') {
      return textResult;
    }
    if (!this.ocr || limits.ocrEnabled === false) {
      return {
        ...textResult,
        errorMessage: 'PDF was saved but OCR is disabled or unavailable',
        retryable: false,
        metadata: { ...textResult.metadata, ocrStatus: 'DISABLED' },
      };
    }

    const allRequested = Array.isArray(textResult.ocrPageNumbers)
      ? textResult.ocrPageNumbers : (textResult.metadata?.ocrPageNumbers || []);
    const maxPages = limits.maxOcrPdfPages ?? 10;
    const selected = allRequested.slice(0, maxPages);
    const failedPages = allRequested.slice(maxPages).map((pageNumber) => ({
      pageNumber,
      code: 'PDF_OCR_PAGE_LIMIT',
      message: `OCR page limit ${maxPages} reached`,
      retryable: false,
    }));
    const pageTexts = Array.isArray(textResult.pageTexts) ? textResult.pageTexts : [];
    let rendered = [];
    try {
      rendered = await this.pdfRenderer.renderPages(filePath, selected, limits, {
        signal: options.signal,
      });
    } catch (error) {
      rendered = error.partialResults || [];
      const completed = new Set(rendered.map((entry) => entry.pageNumber));
      for (const pageNumber of selected) {
        if (!completed.has(pageNumber)) failedPages.push({
          pageNumber,
          code: error.code || 'PDF_OCR_RENDER_FAILED',
          message: String(error.message || error).slice(0, 1000),
          retryable: error.retryable === true,
        });
      }
    }

    const ocrByPage = new Map();
    for (const result of rendered) {
      if (!result.ok || !result.buffer) {
        failedPages.push({
          pageNumber: result.pageNumber,
          code: result.error?.code || 'PDF_OCR_RENDER_FAILED',
          message: result.error?.message || 'PDF page rendering produced no image',
          retryable: result.error?.retryable === true,
        });
        continue;
      }
      try {
        const value = await this.ocr.recognize(result.buffer, {
          pdfPageNumber: result.pageNumber,
          renderedWidth: result.width,
          renderedHeight: result.height,
        }, limits, options);
        if (!value?.text) {
          failedPages.push({
            pageNumber: result.pageNumber,
            code: 'OCR_EMPTY',
            message: 'OCR found no text on this page',
            retryable: false,
          });
        } else {
          ocrByPage.set(result.pageNumber, value);
        }
      } catch (error) {
        failedPages.push({
          pageNumber: result.pageNumber,
          code: error?.code || 'OCR_PAGE_FAILED',
          message: String(error?.message || error).slice(0, 1000),
          retryable: error?.retryable === true,
        });
      }
    }

    const sections = [];
    const pageCount = textResult.metadata?.pageCount ?? pageTexts.length;
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const ocr = ocrByPage.get(pageNumber);
      const original = String(pageTexts[pageNumber - 1] || '').trim();
      const text = ocr?.text || original;
      if (!text) continue;
      sections.push(`=== PDF PAGE ${pageNumber} | source=${ocr ? 'OCR' : 'TEXT'} ===\n${text}`);
    }
    const succeededPages = [...ocrByPage.keys()].sort((a, b) => a - b);
    const retryable = failedPages.some((page) => page.retryable === true);
    const metadataResult = {
      ...textResult.metadata,
      adapter: `${textResult.metadata?.adapter || 'pdf-text'}+pdf-parse.getScreenshot+tesseract.js`,
      ocrStatus: failedPages.length > 0 ? (succeededPages.length > 0 ? 'PARTIAL' : 'NEEDS_OCR') : 'SUCCEEDED',
      ocrRequestedPages: allRequested,
      ocrProcessedPages: succeededPages,
      failedPages,
      ocrPagesLimited: allRequested.length > selected.length,
    };
    delete metadataResult.ocrPageNumbers;
    // Native headers/footers/noise cannot turn total selected-page OCR failure
    // into a contradictory PARSED result.
    if (selected.length > 0 && succeededPages.length === 0) {
      return savedUnparsed(
        failedPages.every((page) => page.code === 'OCR_EMPTY') ? 'OCR_EMPTY' : 'PDF_NEEDS_OCR',
        'PDF was saved but all selected-page OCR attempts failed',
        metadataResult,
        'NEEDS_OCR',
        retryable
      );
    }
    if (sections.length === 0) {
      return savedUnparsed(
        'OCR_EMPTY',
        'PDF was saved but selected-page OCR produced no text',
        metadataResult,
        'NEEDS_OCR',
        false
      );
    }
    return frameEvidence(sections.join('\n\n'), { ...metadata, kind: 'pdf' }, limits, metadataResult);
  }

  _processPdfText(filePath, metadata, limits, options) {
    const memoryMb = this._memoryLimit(limits);
    const child = this.fork(this.pdfChildPath, [], {
      execArgv: [`--max-old-space-size=${memoryMb}`],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'json',
    });
    return this._awaitIsolate({
      isolate: child,
      signal: options.signal,
      timeoutMs: this._timeout(limits),
      send: () => child.send({ filePath, metadata, limits }),
      stop: () => {
        child.kill('SIGKILL');
        return Promise.resolve();
      },
      exitEvent: 'exit',
      errorEvent: 'error',
      exitCode: (code, signal) => ({ code, signal }),
      label: 'PDF extraction child',
      exitCodeName: 'PDF_CHILD_EXIT',
      // The child destroys PDF.js, flushes IPC, disconnects, and exits itself.
      // SIGKILL is reserved for abort/timeout/error containment.
      stopOnMessage: false,
    });
  }

  _awaitIsolate(config) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stopping = false;
      let timer;
      const signal = config.signal;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const stopAndReject = (error) => {
        if (settled) return;
        stopping = true;
        Promise.resolve().then(config.stop).catch(() => {}).finally(() => finish(reject, error));
      };
      const onAbort = () => stopAndReject(this._abortError());
      signal?.addEventListener('abort', onAbort, { once: true });

      config.isolate.once('message', (message) => {
        if (config.stopOnMessage !== false) {
          stopping = true;
          Promise.resolve().then(config.stop).catch(() => {});
        }
        if (message?.ok) {
          finish(resolve, Object.freeze({
            ...message.result,
            metadata: Object.freeze({ ...(message.result?.metadata || {}) }),
          }));
          return;
        }
        const details = message?.error || {};
        finish(reject, new AttachmentExtractionError(
          details.code || 'EXTRACTION_FAILED',
          details.message || 'Attachment extraction failed',
          { retryable: details.retryable === true }
        ));
      });
      config.isolate.once(config.errorEvent, (error) => {
        const wrapped = new AttachmentExtractionError(
          error?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'PARSER_MEMORY_LIMIT' : config.exitCodeName,
          `${config.label} error: ${String(error?.message || error).slice(0, 1000)}`,
          { retryable: true }
        );
        finish(reject, wrapped);
      });
      config.isolate.once(config.exitEvent, (...values) => {
        if (settled || stopping) return;
        const detail = config.exitCode(...values);
        finish(reject, new AttachmentExtractionError(
          config.exitCodeName,
          `${config.label} exited before returning a result (${JSON.stringify(detail)})`,
          { retryable: true }
        ));
      });
      timer = setTimeout(() => {
        const error = new AttachmentExtractionError(
          'PARSER_TIMEOUT',
          `${config.label} exceeded ${config.timeoutMs}ms`,
          { retryable: true }
        );
        stopAndReject(error);
      }, config.timeoutMs);
      timer.unref?.();
      try { config.send(); } catch (error) { stopAndReject(error); }
    });
  }

  _memoryLimit(limits) {
    const value = limits.parserMaxOldSpaceMb ?? 128;
    if (!Number.isSafeInteger(value) || value < 16 || value > 2048) {
      throw new TypeError('parserMaxOldSpaceMb must be an integer from 16 to 2048');
    }
    return value;
  }

  _timeout(limits) {
    const value = limits.processingTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError('processingTimeoutMs must be a positive safe integer');
    }
    return value;
  }

  _abortError() {
    const error = new AttachmentExtractionError(
      'PROCESSING_TIMEOUT',
      'Attachment extraction was aborted',
      { retryable: true }
    );
    error.name = 'AbortError';
    return error;
  }
}

module.exports = { AttachmentExtractionProcessor };
