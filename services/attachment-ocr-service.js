'use strict';

const {
  AttachmentExtractionError,
  canonicalizeExtractedText,
  frameEvidence,
  savedUnparsed,
} = require('./attachment-extractors');
const { AttachmentImagePreprocessor } = require('./attachment-image-preprocessor');

class AttachmentOcrService {
  constructor(options = {}) {
    if (!options.worker?.recognize) throw new TypeError('AttachmentOcrService requires an OCR worker service');
    this.worker = options.worker;
    this.preprocessor = options.preprocessor || new AttachmentImagePreprocessor();
  }

  async recognize(input, metadata = {}, limits = {}, options = {}) {
    const processed = await this.preprocessor.preprocess(input, limits, { signal: options.signal });
    const result = await this.worker.recognize(processed.buffer, {
      signal: options.signal,
      timeoutMs: limits.ocrRecognizeTimeoutMs,
    });
    let text;
    try {
      text = canonicalizeExtractedText(result?.data?.text || '');
    } catch (error) {
      throw new AttachmentExtractionError(
        error.code || 'OCR_UNSAFE_TEXT',
        error.message,
        { retryable: false }
      );
    }
    return {
      text,
      confidence: Number.isFinite(result?.data?.confidence) ? result.data.confidence : null,
      metadata: {
        adapter: 'tesseract.js',
        languages: String(limits.ocrLanguages || 'eng+chi_sim'),
        confidence: Number.isFinite(result?.data?.confidence) ? result.data.confidence : null,
        image: processed.metadata,
        ...metadata,
      },
    };
  }

  async extractImage(filePath, metadata = {}, limits = {}, options = {}) {
    if (limits.ocrEnabled === false) {
      return savedUnparsed(
        'OCR_DISABLED',
        'Image was saved but OCR is disabled',
        { ocrStatus: 'NEEDS_OCR' },
        'NEEDS_OCR',
        false
      );
    }
    try {
      const result = await this.recognize(filePath, {}, limits, options);
      if (!result.text) {
        return savedUnparsed(
          'OCR_EMPTY',
          'Image was saved but OCR found no text',
          { ...result.metadata, ocrStatus: 'SAVED_UNPARSED' },
          'SAVED_UNPARSED',
          false
        );
      }
      return frameEvidence(result.text, metadata, limits, {
        ...result.metadata,
        ocrStatus: 'SUCCEEDED',
      });
    } catch (error) {
      const code = error.code || 'OCR_FAILED';
      const retryable = error.retryable === true;
      return savedUnparsed(
        code,
        `Image was saved but OCR failed: ${String(error.message || error).slice(0, 1000)}`,
        { ocrStatus: 'NEEDS_OCR', failureCode: code },
        'NEEDS_OCR',
        retryable
      );
    }
  }

  terminate() {
    return this.worker.terminate?.();
  }
}

module.exports = { AttachmentOcrService };
