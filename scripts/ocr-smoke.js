#!/usr/bin/env node
'use strict';

// Optional manual live OCR smoke. The default test suite is fake/network-free.
// This command requires local eng + chi_sim traineddata and never uses a CDN.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { OcrWorkerService } = require('../services/ocr-worker-service');
const { AttachmentOcrService } = require('../services/attachment-ocr-service');

function parseArgs(argv) {
  const args = [...argv];
  let expected = process.env.PM_OCR_SMOKE_EXPECT || '';
  const expectedIndex = args.indexOf('--expect');
  if (expectedIndex !== -1) {
    expected = args[expectedIndex + 1] || '';
    args.splice(expectedIndex, 2);
  }
  if (args.length !== 1) {
    throw new Error('Usage: npm run ocr:smoke -- [--expect "known text"] image.png');
  }
  return { input: args[0], expected };
}

function assertLocalLanguages(runtime) {
  const missing = runtime.media.ocrLanguages.split('+').filter((language) => (
    !fs.existsSync(path.join(runtime.media.ocrLangPath, `${language}.traineddata.gz`))
    && !fs.existsSync(path.join(runtime.media.ocrLangPath, `${language}.traineddata`))
  ));
  if (missing.length > 0) {
    throw new Error(
      `Missing local traineddata for ${missing.join(', ')} in ${runtime.media.ocrLangPath}. `
      + 'The smoke requires local eng + chi_sim traineddata and does not download it.'
    );
  }
}

async function main() {
  const { input, expected } = parseArgs(process.argv.slice(2));
  const filePath = fs.realpathSync(path.resolve(input));
  const runtime = config.validateConfig(config.loadConfig(process.env), { requirePm: false });
  assertLocalLanguages(runtime);
  const worker = new OcrWorkerService({
    languages: runtime.media.ocrLanguages,
    cachePath: runtime.media.ocrCachePath,
    langPath: runtime.media.ocrLangPath,
    timeoutMs: runtime.media.ocrRecognizeTimeoutMs,
    initializeTimeoutMs: runtime.media.ocrInitializeTimeoutMs,
    shutdownTimeoutMs: runtime.media.ocrShutdownTimeoutMs,
    logger: console,
  });
  const service = new AttachmentOcrService({ worker });
  try {
    const result = await service.extractImage(filePath, {
      kind: 'image', displayName: path.basename(filePath),
    }, { ...runtime.storage, ...runtime.media, ocrEnabled: true });
    process.stdout.write(`${JSON.stringify({
      status: result.status,
      errorCode: result.errorCode,
      metadata: result.metadata,
      text: result.text,
    }, null, 2)}\n`);
    if (result.status !== 'PARSED') throw new Error(`OCR smoke failed: ${result.errorCode}`);
    if (expected && !result.text.includes(expected)) {
      throw new Error(`OCR smoke output did not contain expected substring: ${JSON.stringify(expected)}`);
    }
  } finally {
    try {
      await service.terminate();
    } catch (error) {
      console.error(`OCR shutdown warning: ${error.message}`);
    }
  }
}

main().catch((error) => {
  console.error(`OCR smoke error: ${error.message}`);
  process.exitCode = 1;
});
