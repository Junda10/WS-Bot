'use strict';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { AttachmentExtractionError } = require('./attachment-extractors');

class PdfOcrRenderer {
  constructor(options = {}) {
    this.fork = options.fork || fork;
    this.childPath = options.childPath || path.join(__dirname, 'attachment-pdf-ocr-child.js');
  }

  async renderPages(filePath, pageNumbers, limits, options = {}) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)
        || fs.realpathSync(filePath) !== path.resolve(filePath)) {
      throw new TypeError('PDF OCR rendering requires a canonical absolute path');
    }
    if (!Array.isArray(pageNumbers) || pageNumbers.length < 1
        || pageNumbers.length > (limits.maxOcrPdfPages ?? 10)
        || !pageNumbers.every((page) => Number.isSafeInteger(page) && page > 0)
        || new Set(pageNumbers).size !== pageNumbers.length) {
      throw new TypeError('PDF OCR page selection is invalid');
    }
    if (options.signal?.aborted) throw this._abortError();

    const results = [];
    for (const pageNumber of pageNumbers) {
      if (options.signal?.aborted) {
        const error = this._abortError();
        error.partialResults = results;
        throw error;
      }
      try {
        const page = await this._renderPage(filePath, pageNumber, limits, options);
        results.push({ pageNumber, ok: true, ...page });
      } catch (error) {
        if (error?.name === 'AbortError') {
          error.partialResults = results;
          throw error;
        }
        results.push({
          pageNumber,
          ok: false,
          error: {
            code: error?.code || 'PDF_OCR_RENDER_FAILED',
            message: String(error?.message || error).slice(0, 1000),
            retryable: error?.retryable === true,
          },
        });
      }
    }
    return results;
  }

  _renderPage(filePath, pageNumber, limits, options) {
    const memoryMb = limits.parserMaxOldSpaceMb ?? 128;
    const timeoutMs = limits.pdfOcrRenderTimeoutMs ?? 120_000;
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
        if (message?.type === 'page' && message.pageNumber === pageNumber) {
          const buffer = Buffer.isBuffer(message.data)
            ? message.data : Buffer.from(message.data || []);
          finish(resolve, {
            buffer,
            width: message.width,
            height: message.height,
          });
          return;
        }
        const source = message?.error || {};
        finish(reject, new AttachmentExtractionError(
          source.code || 'PDF_OCR_RENDER_FAILED',
          source.message || 'PDF OCR page rendering failed',
          { retryable: source.retryable === true }
        ));
      });
      child.once('error', (error) => stop(new AttachmentExtractionError(
        'PDF_OCR_CHILD_ERROR',
        `PDF OCR renderer error: ${String(error?.message || error)}`,
        { retryable: true }
      )));
      child.once('exit', (code, signal) => {
        if (settled) return;
        stop(new AttachmentExtractionError(
          'PDF_OCR_CHILD_EXIT',
          `PDF OCR page ${pageNumber} renderer exited before completion (${JSON.stringify({ code, signal })})`,
          { retryable: true }
        ));
      });
      // This timer ends as soon as the raster arrives. OCR runs later in the
      // parent and is governed only by the recognition timeout.
      timer = setTimeout(() => stop(new AttachmentExtractionError(
        'PDF_OCR_RENDER_TIMEOUT',
        `PDF OCR page ${pageNumber} rendering exceeded ${timeoutMs}ms`,
        { retryable: true }
      )), timeoutMs);
      timer.unref?.();
      try { child.send({ filePath, pageNumber, limits }); } catch (error) { stop(error); }
    });
  }

  _abortError() {
    const error = new AttachmentExtractionError(
      'PROCESSING_TIMEOUT',
      'PDF OCR rendering was aborted',
      { retryable: true }
    );
    error.name = 'AbortError';
    return error;
  }
}

module.exports = { PdfOcrRenderer };
