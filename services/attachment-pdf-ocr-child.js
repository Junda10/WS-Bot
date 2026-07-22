'use strict';

const fs = require('fs');
const path = require('path');
const { PDFParse, VerbosityLevel } = require('pdf-parse');

function send(message) {
  if (typeof process.send !== 'function' || !process.connected) return Promise.resolve();
  return new Promise((resolve, reject) => process.send(message, (error) => (
    error ? reject(error) : resolve()
  )));
}

async function canonicalInput(inputPath, maxBytes) {
  if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath)) {
    throw Object.assign(new Error('PDF OCR input path must be absolute'), { code: 'EXTRACTION_INPUT_INVALID' });
  }
  const canonical = await fs.promises.realpath(inputPath);
  if (canonical !== path.resolve(inputPath)) {
    throw Object.assign(new Error('PDF OCR input path must be canonical'), { code: 'EXTRACTION_INPUT_INVALID' });
  }
  const stat = await fs.promises.stat(canonical);
  if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) {
    throw Object.assign(new Error(`PDF OCR input exceeds ${maxBytes} bytes`), { code: 'EXTRACTION_INPUT_LIMIT' });
  }
  return canonical;
}

function serializeError(error, fallback = 'PDF_OCR_RENDER_FAILED') {
  return {
    code: error?.code || fallback,
    message: String(error?.message || error || fallback).slice(0, 1500),
    retryable: error?.retryable === true,
  };
}

async function renderOne(input) {
  const maxFileBytes = input.limits.maxFileBytes;
  const desiredWidth = input.limits.ocrDesiredWidth;
  const maxPixels = input.limits.maxImagePixels;
  const maxPageBytes = input.limits.maxOcrImageBytes;
  const pageNumber = input.pageNumber;
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
    throw Object.assign(new Error('PDF OCR page selection is invalid'), { code: 'PDF_OCR_PAGE_SELECTION' });
  }
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > 100_000_000) {
    throw Object.assign(new Error('PDF OCR pixel limit is invalid'), { code: 'PDF_OCR_PIXEL_LIMIT' });
  }
  const filePath = await canonicalInput(input.filePath, maxFileBytes);
  const data = await fs.promises.readFile(filePath);
  const parser = new PDFParse({
    data: new Uint8Array(data),
    isEvalSupported: false,
    maxImageSize: maxPixels,
    stopAtErrors: true,
    useSystemFonts: false,
    verbosity: VerbosityLevel.ERRORS,
  });
  try {
    const info = await parser.getInfo({ partial: [pageNumber], parsePageInfo: true });
    const pageInfo = info?.pages?.find((page) => page.pageNumber === pageNumber);
    if (!Number.isFinite(pageInfo?.width) || !Number.isFinite(pageInfo?.height)
        || pageInfo.width <= 0 || pageInfo.height <= 0) {
      throw Object.assign(new Error('PDF page dimensions are unavailable'), {
        code: 'PDF_OCR_DIMENSIONS_INVALID',
      });
    }
    const safeWidth = Math.max(1, Math.min(
      desiredWidth,
      Math.floor(Math.sqrt(maxPixels * pageInfo.width / pageInfo.height))
    ));
    const expectedHeight = Math.ceil(pageInfo.height * safeWidth / pageInfo.width);
    if (!Number.isSafeInteger(safeWidth) || !Number.isSafeInteger(expectedHeight)
        || safeWidth > 5000 || safeWidth * expectedHeight > maxPixels) {
      throw Object.assign(new Error('PDF page cannot fit the OCR pixel limit'), {
        code: 'PDF_OCR_PIXEL_LIMIT',
      });
    }
    const result = await parser.getScreenshot({
      partial: [pageNumber],
      desiredWidth: safeWidth,
      imageBuffer: true,
      imageDataUrl: false,
    });
    const page = result?.pages?.[0];
    const width = Math.round(page?.width);
    const height = Math.round(page?.height);
    const pixels = width * height;
    const buffer = Buffer.from(page?.data || []);
    if (page?.pageNumber !== pageNumber || !Number.isSafeInteger(width)
        || !Number.isSafeInteger(height) || width < 1 || height < 1
        || !Number.isSafeInteger(pixels) || pixels > maxPixels
        || width > safeWidth + 1 || width > 5001) {
      throw Object.assign(new Error('Rendered PDF page exceeds dimension limits'), {
        code: 'PDF_OCR_PIXEL_LIMIT',
      });
    }
    if (buffer.length < 1 || buffer.length > maxPageBytes) {
      throw Object.assign(new Error(`Rendered PDF page exceeds ${maxPageBytes} bytes`), {
        code: 'PDF_OCR_PAGE_BYTE_LIMIT',
      });
    }
    return { pageNumber, width, height, data: buffer };
  } finally {
    try { await parser.destroy?.(); } catch {}
  }
}

process.once('message', async (input) => {
  try {
    const page = await renderOne(input);
    await send({ type: 'page', ...page });
  } catch (error) {
    await send({ type: 'page-error', pageNumber: input?.pageNumber, error: serializeError(error) });
  } finally {
    // One page per process prevents a corrupt page from poisoning siblings.
    process.disconnect?.();
  }
});
