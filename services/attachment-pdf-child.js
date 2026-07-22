'use strict';

const fs = require('fs');
const path = require('path');
const {
  canonicalizeExtractedText,
  frameEvidence,
  savedUnparsed,
  validateLimits,
} = require('./attachment-extractors');

async function send(message) {
  if (typeof process.send !== 'function' || !process.connected) return;
  await new Promise((resolve) => process.send(message, () => resolve()));
}

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    code: error?.code || 'PDF_CHILD_FAILED',
    message: String(error?.message || error || 'PDF extraction failed').slice(0, 2000),
    retryable: error?.retryable === true,
  };
}

function pdfLoadFailure(error) {
  const detail = `${error?.name || ''} ${error?.code || ''} ${error?.message || ''}`;
  if (/password|encrypted|PasswordException/iu.test(detail)) {
    return savedUnparsed('PDF_ENCRYPTED', 'Encrypted PDF was saved but cannot be parsed');
  }
  return savedUnparsed('PDF_CORRUPT', 'Corrupt or unsupported PDF was saved but cannot be parsed');
}

async function canonicalInput(inputPath, maxBytes) {
  if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath)) {
    throw Object.assign(new Error('PDF input path must be absolute'), {
      code: 'EXTRACTION_INPUT_INVALID', retryable: false,
    });
  }
  const canonical = await fs.promises.realpath(inputPath);
  if (canonical !== path.resolve(inputPath)) {
    throw Object.assign(new Error('PDF input path must be canonical'), {
      code: 'EXTRACTION_INPUT_INVALID', retryable: false,
    });
  }
  const stat = await fs.promises.stat(canonical);
  if (!stat.isFile()) throw Object.assign(new Error('PDF input is not a regular file'), { code: 'EXTRACTION_INPUT_INVALID' });
  if (stat.size < 1 || stat.size > maxBytes) {
    throw Object.assign(new Error(`PDF input exceeds ${maxBytes} bytes`), { code: 'EXTRACTION_INPUT_LIMIT' });
  }
  return canonical;
}

/**
 * Use pdf-parse v2's modern bundled PDF.js dependency directly. The dedicated
 * child process supplies the hard memory/wall-clock boundary that PDF data
 * cannot enforce for itself.
 */
async function extractPdf(input) {
  const limits = validateLimits(input.limits);
  const filePath = await canonicalInput(input.filePath, limits.maxFileBytes);
  const data = await fs.promises.readFile(filePath);
  if (data.length > limits.maxFileBytes) {
    return savedUnparsed('EXTRACTION_INPUT_LIMIT', `PDF input exceeds ${limits.maxFileBytes} bytes`);
  }

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let loadingTask;
  let document;
  try {
    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(data),
      isEvalSupported: false,
      maxImageSize: limits.maxImagePixels,
      stopAtErrors: true,
      useSystemFonts: false,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    });
    try {
      document = await loadingTask.promise;
    } catch (error) {
      return pdfLoadFailure(error);
    }

    const pageCount = document?.numPages;
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
      return savedUnparsed('PDF_CORRUPT', 'PDF has an invalid page count');
    }
    if (pageCount > limits.maxPdfPages) {
      return savedUnparsed(
        'PDF_PAGE_LIMIT',
        `PDF has ${pageCount} pages; limit is ${limits.maxPdfPages}`,
        { pageCount }
      );
    }

    let textItems = 0;
    let rawChars = 0;
    let sourceTruncated = false;
    let sawText = false;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      let page;
      try {
        page = await document.getPage(pageNumber);
        const textContent = await page.getTextContent({
          disableNormalization: false,
          includeMarkedContent: false,
        });
        if (!Array.isArray(textContent?.items)) {
          return savedUnparsed(
            'PDF_PAGE_ERROR',
            `PDF page ${pageNumber} returned invalid text content`,
            { pageCount, pageNumber }
          );
        }

        const lines = [];
        let line = '';
        let lastY;
        for (const item of textContent.items) {
          // Marked-content records do not carry text and are excluded above,
          // but continue to reject malformed modern PDF.js output defensively.
          if (typeof item?.str !== 'string') continue;
          textItems += 1;
          if (textItems > limits.maxPdfTextItems) {
            return savedUnparsed(
              'PDF_RESOURCE_LIMIT',
              `PDF text items exceed limit ${limits.maxPdfTextItems}`,
              { pageCount, pageNumber, textItems }
            );
          }
          const value = item.str;
          if (/\S/u.test(value)) sawText = true;
          const y = Array.isArray(item.transform) ? item.transform[5] : undefined;
          if (lastY !== undefined && y !== undefined && y !== lastY) {
            lines.push(line);
            line = '';
          }
          if (rawChars < limits.maxExtractedChars) {
            const remaining = limits.maxExtractedChars - rawChars;
            line += value.slice(0, remaining);
          }
          rawChars += value.length;
          if (rawChars > limits.maxExtractedChars) sourceTruncated = true;
          lastY = y;
        }
        if (line) lines.push(line);
        pages.push(lines.join('\n'));
      } catch (error) {
        return savedUnparsed(
          'PDF_PAGE_ERROR',
          `PDF page ${pageNumber} text traversal failed: ${String(error?.message || error).slice(0, 500)}`,
          { pageCount, pageNumber }
        );
      } finally {
        try { page?.cleanup?.(); } catch {}
      }
    }

    if (!sawText) {
      return savedUnparsed(
        'PDF_NEEDS_OCR',
        'PDF was saved but contains no extractable text; OCR is required',
        { pageCount, textItems },
        'NEEDS_OCR'
      );
    }
    let content;
    try {
      content = canonicalizeExtractedText(pages.join('\n\n'));
    } catch (error) {
      return savedUnparsed(error.code || 'UNSAFE_EXTRACTED_TEXT', error.message, {
        pageCount, textItems,
      });
    }
    if (!content) {
      return savedUnparsed(
        'PDF_NEEDS_OCR',
        'PDF was saved but contains no extractable text; OCR is required',
        { pageCount, textItems },
        'NEEDS_OCR'
      );
    }
    return frameEvidence(content, { ...input.metadata, kind: 'pdf' }, limits, {
      adapter: `pdfjs-dist@${pdfjs.version}-child`,
      pageCount,
      textItems,
      sourceTruncated,
    });
  } finally {
    // PDFDocumentProxy.destroy() delegates to its loading task. Destroy the
    // task directly so failed loads and successful loads share one cleanup.
    try { await loadingTask?.destroy?.(); } catch {}
  }
}

process.once('message', async (input) => {
  try {
    await send({ ok: true, result: await extractPdf(input) });
  } catch (error) {
    await send({ ok: false, error: serializeError(error) });
  } finally {
    process.disconnect?.();
  }
});
