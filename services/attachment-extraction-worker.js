'use strict';

const fs = require('fs');
const path = require('path');
const { parentPort } = require('worker_threads');
const { extractAttachmentFile } = require('./attachment-extractors');

if (!parentPort) throw new Error('attachment-extraction-worker must run in a worker thread');

async function canonicalFilePath(inputPath) {
  if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath)) {
    throw Object.assign(new Error('Extraction input path must be absolute'), {
      code: 'EXTRACTION_INPUT_INVALID', retryable: false,
    });
  }
  const canonical = await fs.promises.realpath(inputPath);
  if (canonical !== path.resolve(inputPath)) {
    throw Object.assign(new Error('Extraction input path must be canonical'), {
      code: 'EXTRACTION_INPUT_INVALID', retryable: false,
    });
  }
  return canonical;
}

parentPort.once('message', async (input) => {
  try {
    const filePath = await canonicalFilePath(input.filePath);
    const result = await extractAttachmentFile(filePath, input.metadata, input.limits);
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: {
        name: error?.name || 'Error',
        code: error?.code || 'EXTRACTION_FAILED',
        message: String(error?.message || 'Attachment extraction failed').slice(0, 2000),
        retryable: error?.retryable === true,
      },
    });
  }
});
