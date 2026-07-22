'use strict';

const path = require('path');
const { fork } = require('child_process');
const sharp = require('sharp');
const { AttachmentExtractionError } = require('./attachment-extractors');

function positiveInteger(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function orientedDimensions(metadata) {
  if (metadata?.autoOrient?.width && metadata?.autoOrient?.height) {
    return { width: metadata.autoOrient.width, height: metadata.autoOrient.height };
  }
  const orientation = metadata?.orientation;
  const swap = [5, 6, 7, 8].includes(orientation);
  return {
    width: swap ? metadata?.height : metadata?.width,
    height: swap ? metadata?.width : metadata?.height,
  };
}

function boundedDimensions(width, height, desiredWidth, maxPixels) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new AttachmentExtractionError('INVALID_IMAGE', 'Image dimensions are missing or invalid');
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > maxPixels) {
    throw new AttachmentExtractionError(
      'IMAGE_PIXEL_LIMIT',
      `Image has ${pixels} oriented pixels; limit is ${maxPixels}`
    );
  }
  const widthForPixelLimit = Math.max(1, Math.floor(Math.sqrt(maxPixels * width / height)));
  const outputWidth = Math.min(width, desiredWidth, widthForPixelLimit);
  const outputHeight = Math.max(1, Math.round(height * outputWidth / width));
  if (outputWidth * outputHeight > maxPixels) {
    throw new AttachmentExtractionError('IMAGE_PIXEL_LIMIT', 'Bounded OCR image exceeds pixel limit');
  }
  return { width: outputWidth, height: outputHeight, pixels: outputWidth * outputHeight };
}

class AttachmentImagePreprocessor {
  constructor(options = {}) {
    this.sharp = options.sharp || sharp;
    this.fork = options.fork || fork;
    this.childPath = options.childPath || path.join(__dirname, 'attachment-image-preprocess-child.js');
    this.isolate = options.isolate ?? !options.sharp;
  }

  preprocess(input, limits = {}, options = {}) {
    const maxPixels = positiveInteger(limits.maxImagePixels, 40_000_000, 'maxImagePixels');
    if (maxPixels > 100_000_000) {
      return Promise.reject(new AttachmentExtractionError(
        'IMAGE_PIXEL_LIMIT',
        'OCR image pixel limit cannot exceed 100000000',
        { retryable: false }
      ));
    }
    const desiredWidth = positiveInteger(limits.ocrDesiredWidth, 1800, 'ocrDesiredWidth');
    if (desiredWidth > 5000) {
      return Promise.reject(new AttachmentExtractionError(
        'IMAGE_WIDTH_LIMIT',
        'OCR output width cannot exceed 5000 pixels',
        { retryable: false }
      ));
    }
    if (!this.isolate) return this._preprocessDirect(input, limits);
    if (options.signal?.aborted) return Promise.reject(this._abortError());
    return this._preprocessIsolated(input, limits, options);
  }

  _preprocessIsolated(input, limits, options) {
    const timeoutMs = positiveInteger(
      limits.imagePreprocessTimeoutMs,
      15_000,
      'imagePreprocessTimeoutMs'
    );
    const memoryMb = positiveInteger(limits.parserMaxOldSpaceMb, 128, 'parserMaxOldSpaceMb');
    const child = this.fork(this.childPath, [], {
      execArgv: [`--max-old-space-size=${memoryMb}`],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const stop = (error) => {
        try { child.kill('SIGKILL'); } catch {}
        finish(reject, error);
      };
      const onAbort = () => stop(this._abortError());
      options.signal?.addEventListener('abort', onAbort, { once: true });
      child.once('message', (message) => {
        if (message?.ok) {
          const data = Buffer.isBuffer(message.result?.buffer)
            ? message.result.buffer : Buffer.from(message.result?.buffer || []);
          finish(resolve, { ...message.result, buffer: data });
          return;
        }
        const error = new AttachmentExtractionError(
          message?.error?.code || 'IMAGE_DECODE_FAILED',
          message?.error?.message || 'Isolated image preprocessing failed',
          { retryable: message?.error?.retryable === true }
        );
        finish(reject, error);
      });
      child.once('error', (error) => stop(new AttachmentExtractionError(
        'IMAGE_PREPROCESS_CHILD_ERROR',
        `Image preprocessing child failed: ${String(error?.message || error)}`,
        { retryable: true }
      )));
      child.once('exit', (code, signal) => {
        if (settled) return;
        stop(new AttachmentExtractionError(
          'IMAGE_PREPROCESS_CHILD_EXIT',
          `Image preprocessing child exited before responding (${JSON.stringify({ code, signal })})`,
          { retryable: true }
        ));
      });
      timer = setTimeout(() => stop(new AttachmentExtractionError(
        'IMAGE_PREPROCESS_TIMEOUT',
        `Image preprocessing exceeded ${timeoutMs}ms`,
        { retryable: true }
      )), timeoutMs);
      timer.unref?.();
      try { child.send({ input, limits }); } catch (error) { stop(error); }
    });
  }

  _abortError() {
    const error = new AttachmentExtractionError(
      'PROCESSING_TIMEOUT',
      'Image preprocessing was aborted',
      { retryable: true }
    );
    error.name = 'AbortError';
    return error;
  }

  async _preprocessDirect(input, limits = {}) {
    const maxPixels = positiveInteger(limits.maxImagePixels, 40_000_000, 'maxImagePixels');
    if (maxPixels > 100_000_000) {
      throw new AttachmentExtractionError('IMAGE_PIXEL_LIMIT', 'OCR image pixel limit cannot exceed 100000000');
    }
    const desiredWidth = positiveInteger(limits.ocrDesiredWidth, 1800, 'ocrDesiredWidth');
    const maxOutputBytes = positiveInteger(
      limits.maxOcrImageBytes,
      20 * 1024 * 1024,
      'maxOcrImageBytes'
    );
    const options = {
      failOn: 'error',
      limitInputPixels: maxPixels,
      sequentialRead: true,
      unlimited: false,
      animated: false,
    };

    let metadata;
    try {
      // metadata() reads headers only. limitInputPixels rejects decompression
      // bombs before Sharp allocates a decoded raster.
      metadata = await this.sharp(input, options).metadata();
    } catch (error) {
      const message = String(error?.message || error);
      const code = /pixel limit|exceeds pixel/iu.test(message)
        ? 'IMAGE_PIXEL_LIMIT' : 'IMAGE_DECODE_FAILED';
      throw new AttachmentExtractionError(code, `Image metadata validation failed: ${message}`, {
        retryable: false,
      });
    }

    const pages = metadata.pages ?? 1;
    if (!Number.isSafeInteger(pages) || pages !== 1) {
      throw new AttachmentExtractionError(
        'IMAGE_ANIMATION_UNSUPPORTED',
        'Animated or multi-page images are saved but not decoded for OCR'
      );
    }
    const sourceWidth = metadata.width;
    const sourceHeight = metadata.height;
    if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight)
        || sourceWidth < 1 || sourceHeight < 1) {
      throw new AttachmentExtractionError('INVALID_IMAGE', 'Image dimensions are missing or invalid');
    }
    const sourcePixels = sourceWidth * sourceHeight;
    if (!Number.isSafeInteger(sourcePixels) || sourcePixels > maxPixels) {
      throw new AttachmentExtractionError(
        'IMAGE_PIXEL_LIMIT',
        `Image has ${sourcePixels} source pixels; limit is ${maxPixels}`
      );
    }
    const oriented = orientedDimensions(metadata);
    const bounded = boundedDimensions(oriented.width, oriented.height, desiredWidth, maxPixels);

    let output;
    try {
      output = await this.sharp(input, options)
        .rotate()
        .resize({
          width: bounded.width,
          height: bounded.height,
          fit: 'inside',
          withoutEnlargement: true,
          fastShrinkOnLoad: true,
        })
        .grayscale()
        .toColourspace('b-w')
        .normalize()
        .sharpen()
        .png({ compressionLevel: 9, adaptiveFiltering: true, force: true })
        .toBuffer({ resolveWithObject: true });
    } catch (error) {
      throw new AttachmentExtractionError(
        'IMAGE_DECODE_FAILED',
        `Image preprocessing failed: ${String(error?.message || error)}`,
        { retryable: false }
      );
    }

    const width = output.info?.width;
    const height = output.info?.height;
    const pixels = width * height;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width < 1 || height < 1 || !Number.isSafeInteger(pixels) || pixels > maxPixels) {
      throw new AttachmentExtractionError('IMAGE_PIXEL_LIMIT', 'Sharp produced unsafe OCR dimensions');
    }
    if (output.data.length > maxOutputBytes) {
      throw new AttachmentExtractionError(
        'OCR_IMAGE_BYTE_LIMIT',
        `Preprocessed OCR image exceeds ${maxOutputBytes} bytes`
      );
    }
    return {
      buffer: output.data,
      metadata: {
        sourceFormat: metadata.format || null,
        sourceWidth,
        sourceHeight,
        sourcePixels,
        exifOrientation: metadata.orientation ?? null,
        width,
        height,
        pixels,
        outputBytes: output.data.length,
        outputFormat: 'png',
        operations: ['rotate-exif', 'resize-bounded', 'grayscale', 'normalize', 'sharpen'],
      },
    };
  }
}

module.exports = {
  AttachmentImagePreprocessor,
  boundedDimensions,
  orientedDimensions,
};
