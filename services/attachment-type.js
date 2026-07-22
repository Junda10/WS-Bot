'use strict';

const path = require('path');
const { TextDecoder } = require('util');
const sanitizeFilename = require('sanitize-filename');
const yauzl = require('yauzl');

const TEXT_EXTENSIONS = new Set(['txt', 'text']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);
const EXECUTABLE_EXTENSIONS = new Set([
  'app', 'bat', 'bin', 'cmd', 'com', 'cpl', 'dll', 'dmg', 'elf', 'exe', 'hta',
  'jar', 'js', 'jse', 'lnk', 'msi', 'msp', 'pif', 'ps1', 'scr', 'sh', 'vbs', 'wsf',
]);
const GENERIC_MIMES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
const MIME_BY_KIND = Object.freeze({
  markdown: new Set(['text/markdown', 'text/plain', 'text/x-markdown']),
  text: new Set(['text/plain']),
  pdf: new Set(['application/pdf']),
  docx: new Set([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
  ]),
  jpeg: new Set(['image/jpeg', 'image/jpg']),
  png: new Set(['image/png']),
  gif: new Set(['image/gif']),
  webp: new Set(['image/webp']),
  bmp: new Set(['image/bmp', 'image/x-ms-bmp']),
});

class AttachmentValidationError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AttachmentValidationError';
    this.code = code;
    this.retryable = options.retryable === true;
  }
}

function normalizeMime(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function fileExtension(value) {
  const normalized = String(value || '').replaceAll('\\', '/');
  const extension = path.posix.extname(path.posix.basename(normalized)).slice(1).toLowerCase();
  return /^[a-z0-9]{1,16}$/u.test(extension) ? extension : '';
}

function sanitizeDisplayName(value, options = {}) {
  const fallbackExtension = String(options.fallbackExtension || '').replace(/[^a-z0-9]/giu, '').toLowerCase();
  const fallback = fallbackExtension ? `attachment.${fallbackExtension}` : 'attachment';
  const leaf = path.posix.basename(String(value || '').replaceAll('\\', '/'));
  let safe = sanitizeFilename(leaf.replace(/[\p{Cc}\p{Cf}]/gu, ''), { replacement: '_' })
    .replace(/^\.+|[. ]+$/gu, '')
    .trim();
  if (!safe) safe = fallback;
  if (safe.length > 180) {
    const extension = path.extname(safe).slice(0, 17);
    safe = `${safe.slice(0, Math.max(1, 180 - extension.length))}${extension}`;
  }
  return safe || fallback;
}

function startsWith(buffer, bytes) {
  return buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);
}

function executableMagic(buffer) {
  if (startsWith(buffer, [0x4d, 0x5a])) return 'PE/MZ executable';
  if (startsWith(buffer, [0x7f, 0x45, 0x4c, 0x46])) return 'ELF executable';
  const magic = buffer.length >= 4 ? buffer.readUInt32BE(0) : 0;
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) {
    return 'Mach-O executable';
  }
  if (startsWith(buffer, [0x23, 0x21])) return 'script executable';
  return null;
}

function checkedPixels(width, height, maxImagePixels) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new AttachmentValidationError('INVALID_IMAGE', 'Image dimensions are invalid');
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > maxImagePixels) {
    throw new AttachmentValidationError(
      'IMAGE_PIXEL_LIMIT',
      `Image has ${pixels} pixels; limit is ${maxImagePixels}`
    );
  }
  return { width, height, pixels };
}

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    let marker = buffer[offset + 1];
    while (marker === 0xff) marker = buffer[++offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]
      .includes(marker) && length >= 7) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  throw new AttachmentValidationError('INVALID_IMAGE', 'JPEG dimensions are missing or malformed');
}

function webpDimensions(buffer) {
  if (buffer.length < 30) throw new AttachmentValidationError('INVALID_IMAGE', 'WEBP header is truncated');
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (chunk === 'VP8 ' && buffer.length >= 30 && buffer[23] === 0x9d
      && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  throw new AttachmentValidationError('INVALID_IMAGE', 'WEBP dimensions are missing or malformed');
}

function detectImage(buffer, maxImagePixels) {
  let kind;
  let mime;
  let extension;
  let dimensions;
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    if (buffer.length < 24 || buffer.toString('ascii', 12, 16) !== 'IHDR') {
      throw new AttachmentValidationError('INVALID_IMAGE', 'PNG IHDR is missing');
    }
    kind = 'png'; mime = 'image/png'; extension = 'png';
    dimensions = { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } else if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    kind = 'jpeg'; mime = 'image/jpeg'; extension = 'jpg'; dimensions = jpegDimensions(buffer);
  } else if (buffer.length >= 10 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) {
    kind = 'gif'; mime = 'image/gif'; extension = 'gif';
    dimensions = { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  } else if (buffer.length >= 16 && buffer.toString('ascii', 0, 4) === 'RIFF'
      && buffer.toString('ascii', 8, 12) === 'WEBP') {
    kind = 'webp'; mime = 'image/webp'; extension = 'webp'; dimensions = webpDimensions(buffer);
  } else if (startsWith(buffer, [0x42, 0x4d]) && buffer.length >= 26) {
    kind = 'bmp'; mime = 'image/bmp'; extension = 'bmp';
    dimensions = {
      width: Math.abs(buffer.readInt32LE(18)),
      height: Math.abs(buffer.readInt32LE(22)),
    };
  } else {
    return null;
  }
  return { kind, mime, extension, ...checkedPixels(dimensions.width, dimensions.height, maxImagePixels) };
}

function findZipEnd(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function zipError(code, message) {
  return new AttachmentValidationError(code, message);
}

function decodeZipName(bytes, utf8) {
  if (!utf8 && bytes.some((byte) => byte > 0x7f)) {
    throw zipError('UNSAFE_DOCX_PATH', 'DOCX uses a non-UTF-8 non-ASCII ZIP name');
  }
  try {
    return utf8
      ? new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      : bytes.toString('ascii');
  } catch {
    throw zipError('UNSAFE_DOCX_PATH', 'DOCX contains an invalid UTF-8 ZIP name');
  }
}

function safeZipName(name) {
  if (!name || name.includes('\\') || name.startsWith('/') || /^[a-z]:/iu.test(name)
      || /[\p{Cc}\p{Cf}]/gu.test(name)) {
    throw zipError('UNSAFE_DOCX_PATH', 'DOCX contains an unsafe ZIP path');
  }
  const parts = name.split('/');
  const fileParts = name.endsWith('/') ? parts.slice(0, -1) : parts;
  if (fileParts.length === 0 || fileParts.some((part) => !part || part === '.' || part === '..')) {
    throw zipError('UNSAFE_DOCX_PATH', 'DOCX contains an unsafe ZIP path');
  }
  return name.normalize('NFC');
}

function parseCentralDirectory(buffer, limits) {
  const end = findZipEnd(buffer);
  if (end < 0 || end + 22 > buffer.length) throw zipError('INVALID_DOCX', 'DOCX ZIP directory is missing');
  const disk = buffer.readUInt16LE(end + 4);
  const centralDisk = buffer.readUInt16LE(end + 6);
  const diskEntries = buffer.readUInt16LE(end + 8);
  const entryCount = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);
  const commentLength = buffer.readUInt16LE(end + 20);
  if (end + 22 + commentLength !== buffer.length) throw zipError('INVALID_DOCX', 'DOCX ZIP trailer is inconsistent');
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount
      || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw zipError('UNSUPPORTED_DOCX_ZIP', 'Multi-disk/ZIP64 DOCX is not supported');
  }
  if (entryCount < 1 || entryCount > limits.maxZipEntries) {
    throw zipError('DOCX_ENTRY_LIMIT', `DOCX has ${entryCount} ZIP entries`);
  }
  if (centralOffset + centralSize !== end) throw zipError('INVALID_DOCX', 'DOCX ZIP directory bounds are invalid');

  const entries = [];
  const canonicalNames = new Set();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw zipError('INVALID_DOCX', 'DOCX ZIP directory entry is malformed');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc32 = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const entryCommentLength = buffer.readUInt16LE(offset + 32);
    const diskStart = buffer.readUInt16LE(offset + 34);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameEnd = offset + 46 + nameLength;
    const next = nameEnd + extraLength + entryCommentLength;
    if (next > end || diskStart !== 0) throw zipError('INVALID_DOCX', 'DOCX ZIP entry bounds are invalid');
    if ((flags & 0x1) !== 0) throw zipError('ENCRYPTED_DOCX', 'Encrypted DOCX files are not supported');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw zipError('UNSUPPORTED_DOCX_ZIP', 'ZIP64 DOCX entries are not supported');
    }
    if (![0, 8].includes(method)) throw zipError('UNSUPPORTED_DOCX_ZIP', 'DOCX uses an unsupported compression method');
    if (((externalAttributes >>> 16) & 0xf000) === 0xa000) {
      throw zipError('UNSAFE_DOCX_PATH', 'DOCX ZIP symlink entries are rejected');
    }
    const rawName = buffer.subarray(offset + 46, nameEnd);
    const name = safeZipName(decodeZipName(rawName, (flags & 0x800) !== 0));
    const canonical = name.normalize('NFKC').toLocaleLowerCase('en-US');
    if (canonicalNames.has(canonical)) throw zipError('DUPLICATE_DOCX_ENTRY', `DOCX repeats ZIP path ${name}`);
    canonicalNames.add(canonical);
    entries.push({
      name, rawName: Buffer.from(rawName), flags, method, crc32,
      compressedSize, uncompressedSize, localOffset,
    });
    offset = next;
  }
  if (offset !== end) throw zipError('INVALID_DOCX', 'DOCX ZIP directory size does not match');
  return { entries, centralOffset };
}

function assertLocalHeader(buffer, central, centralOffset) {
  const offset = central.localOffset;
  if (offset + 30 > centralOffset || buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw zipError('INVALID_DOCX', 'DOCX local ZIP header is missing');
  }
  const flags = buffer.readUInt16LE(offset + 6);
  const method = buffer.readUInt16LE(offset + 8);
  const crc32 = buffer.readUInt32LE(offset + 14);
  const compressedSize = buffer.readUInt32LE(offset + 18);
  const uncompressedSize = buffer.readUInt32LE(offset + 22);
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const nameStart = offset + 30;
  const dataStart = nameStart + nameLength + extraLength;
  if (dataStart > centralOffset || dataStart + central.compressedSize > centralOffset
      || flags !== central.flags || method !== central.method
      || !buffer.subarray(nameStart, nameStart + nameLength).equals(central.rawName)) {
    throw zipError('DOCX_HEADER_MISMATCH', 'DOCX local and central ZIP headers disagree');
  }
  const descriptor = (flags & 0x8) !== 0;
  if ((!descriptor && (crc32 !== central.crc32 || compressedSize !== central.compressedSize
      || uncompressedSize !== central.uncompressedSize))
      || (descriptor && ((crc32 !== 0 && crc32 !== central.crc32)
        || (compressedSize !== 0 && compressedSize !== central.compressedSize)
        || (uncompressedSize !== 0 && uncompressedSize !== central.uncompressedSize)))) {
    throw zipError('DOCX_HEADER_MISMATCH', 'DOCX local sizes/CRC disagree with its central directory');
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();

function updateCrc32(crc, chunk) {
  let value = crc;
  for (const byte of chunk) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

function openZip(buffer) {
  return new Promise((resolve, reject) => yauzl.fromBuffer(buffer, {
    lazyEntries: true,
    autoClose: false,
    decodeStrings: true,
    strictFileNames: true,
    validateEntrySizes: false,
  }, (error, zip) => (error ? reject(zipError('INVALID_DOCX', error.message)) : resolve(zip))));
}

function openEntryStream(zip, entry) {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => (
    error ? reject(zipError('INVALID_DOCX', error.message)) : resolve(stream)
  )));
}

async function inspectDocxZip(buffer, limits) {
  const parsed = parseCentralDirectory(buffer, limits);
  for (const entry of parsed.entries) assertLocalHeader(buffer, entry, parsed.centralOffset);
  const zip = await openZip(buffer);
  let index = 0;
  let totalOutput = 0;
  let totalCompressed = 0;
  const names = new Set();
  try {
    await new Promise((resolve, reject) => {
      const fail = (error) => reject(error instanceof AttachmentValidationError
        ? error : zipError('INVALID_DOCX', error.message));
      zip.once('error', fail);
      zip.on('entry', async (entry) => {
        try {
          const central = parsed.entries[index++];
          if (!central || entry.fileName.normalize('NFC') !== central.name
              || entry.compressedSize !== central.compressedSize
              || entry.uncompressedSize !== central.uncompressedSize
              || entry.crc32 !== central.crc32) {
            throw zipError('DOCX_HEADER_MISMATCH', 'DOCX parser observed inconsistent central metadata');
          }
          names.add(central.name);
          if (central.name.endsWith('/')) { zip.readEntry(); return; }
          const stream = await openEntryStream(zip, entry);
          let output = 0;
          let crc = 0xffffffff;
          for await (const chunk of stream) {
            output += chunk.length;
            totalOutput += chunk.length;
            crc = updateCrc32(crc, chunk);
            if (output > limits.maxDocxUncompressedBytes
                || totalOutput > limits.maxDocxUncompressedBytes) {
              stream.destroy();
              throw zipError('DOCX_UNCOMPRESSED_LIMIT', `DOCX expands beyond ${limits.maxDocxUncompressedBytes} bytes`);
            }
            const ratio = output / Math.max(1, central.compressedSize);
            if (ratio > limits.maxDocxCompressionRatio) {
              stream.destroy();
              throw zipError('DOCX_COMPRESSION_RATIO', `DOCX entry exceeds compression ratio ${limits.maxDocxCompressionRatio}`);
            }
          }
          if (((crc ^ 0xffffffff) >>> 0) !== central.crc32) {
            throw zipError('DOCX_CRC_MISMATCH', `DOCX entry ${central.name} failed CRC validation`);
          }
          totalCompressed += central.compressedSize;
          if (totalOutput / Math.max(1, totalCompressed) > limits.maxDocxCompressionRatio) {
            throw zipError('DOCX_COMPRESSION_RATIO', `DOCX exceeds compression ratio ${limits.maxDocxCompressionRatio}`);
          }
          zip.readEntry();
        } catch (error) { fail(error); }
      });
      zip.once('end', resolve);
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  if (index !== parsed.entries.length) throw zipError('INVALID_DOCX', 'DOCX entry count is inconsistent');
  for (const required of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) {
    if (!names.has(required)) throw zipError('INVALID_DOCX', `DOCX is missing ${required}`);
  }
  return { entryCount: index, uncompressedBytes: totalOutput, compressedBytes: totalCompressed };
}

function assertExtension(kind, extension) {
  const allowed = {
    markdown: MARKDOWN_EXTENSIONS,
    text: TEXT_EXTENSIONS,
    pdf: new Set(['pdf']),
    docx: new Set(['docx']),
    jpeg: new Set(['jpg', 'jpeg', 'jpe']),
    png: new Set(['png']),
    gif: new Set(['gif']),
    webp: new Set(['webp']),
    bmp: new Set(['bmp']),
  }[kind];
  // Strong-magic formats can safely infer an extension when WhatsApp supplies
  // no name. A supplied extension is always binding and must never mislead.
  if (!extension && ['pdf', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(kind)) return;
  if (!allowed?.has(extension)) {
    throw new AttachmentValidationError(
      'EXTENSION_MISMATCH',
      `File extension .${extension || '(none)'} does not match detected ${kind}`
    );
  }
}

function assertDeclaredMime(kind, declaredMime) {
  const mime = normalizeMime(declaredMime);
  if (GENERIC_MIMES.has(mime)) return;
  if (!MIME_BY_KIND[kind]?.has(mime)) {
    throw new AttachmentValidationError(
      'MIME_MISMATCH',
      `Declared MIME ${mime || '(none)'} does not match detected ${kind}`
    );
  }
}

function detectText(buffer, extension) {
  const kind = MARKDOWN_EXTENSIONS.has(extension)
    ? 'markdown'
    : (TEXT_EXTENSIONS.has(extension) ? 'text' : null);
  if (!kind) return null;
  if (buffer.includes(0)) {
    throw new AttachmentValidationError('INVALID_TEXT', 'Text/Markdown must not contain NUL bytes');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new AttachmentValidationError('INVALID_UTF8', 'Text/Markdown must be valid UTF-8');
  }
  if (/[^\t\n\r\x20-\x7e\x80-\u{10ffff}]/u.test(text)
      || /[\u0080-\u009f\p{Cf}]/u.test(text)) {
    throw new AttachmentValidationError(
      'UNSAFE_TEXT_CONTROLS',
      'Text/Markdown contains C1, bidi, zero-width, or format control characters'
    );
  }
  return {
    kind,
    mime: kind === 'markdown' ? 'text/markdown' : 'text/plain',
    extension: kind === 'markdown' ? 'md' : 'txt',
  };
}

async function detectAttachmentType(buffer, metadata = {}, limits = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Attachment payload must be a Buffer');
  const resolvedLimits = {
    maxFileBytes: limits.maxFileBytes ?? 20 * 1024 * 1024,
    maxImagePixels: limits.maxImagePixels ?? 40_000_000,
    maxDocxUncompressedBytes: limits.maxDocxUncompressedBytes ?? 100 * 1024 * 1024,
    maxDocxCompressionRatio: limits.maxDocxCompressionRatio ?? 100,
    maxZipEntries: limits.maxZipEntries ?? 10_000,
  };
  if (buffer.length > resolvedLimits.maxFileBytes) {
    throw new AttachmentValidationError('FILE_TOO_LARGE', `File exceeds ${resolvedLimits.maxFileBytes} bytes`);
  }
  if (buffer.length === 0) throw new AttachmentValidationError('EMPTY_FILE', 'Empty attachments are rejected');

  const extension = fileExtension(metadata.fileName);
  if (extension === 'doc') {
    throw new AttachmentValidationError('LEGACY_DOC_REJECTED', 'Legacy .doc files are not supported');
  }
  if (EXECUTABLE_EXTENSIONS.has(extension)) {
    throw new AttachmentValidationError('EXECUTABLE_REJECTED', 'Executable file extensions are rejected');
  }
  const executable = executableMagic(buffer);
  if (executable) {
    throw new AttachmentValidationError('EXECUTABLE_REJECTED', `${executable} content is rejected`);
  }

  let detected = detectImage(buffer, resolvedLimits.maxImagePixels);
  if (!detected && buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-') {
    detected = { kind: 'pdf', mime: 'application/pdf', extension: 'pdf' };
  }
  if (!detected && startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) {
    detected = {
      kind: 'docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extension: 'docx',
      docx: await inspectDocxZip(buffer, resolvedLimits),
    };
  }
  if (!detected) detected = detectText(buffer, extension);
  if (!detected) {
    throw new AttachmentValidationError('UNKNOWN_TYPE', 'Unknown or unsupported attachment type');
  }

  assertExtension(detected.kind, extension);
  assertDeclaredMime(detected.kind, metadata.mimeType);
  return Object.freeze(detected);
}

function inferredDisplayName(value, detected) {
  const safe = sanitizeDisplayName(value);
  if (fileExtension(safe)) return safe;
  const stem = safe === 'attachment' ? 'attachment' : safe;
  return sanitizeDisplayName(`${stem}.${detected.extension}`, {
    fallbackExtension: detected.extension,
  });
}

function assertPdfPageLimit(pageCount, limits) {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new AttachmentValidationError('INVALID_PDF_PAGE_COUNT', 'PDF page count is invalid');
  }
  if (pageCount > limits.maxPdfPages) {
    throw new AttachmentValidationError('PDF_PAGE_LIMIT', `PDF has ${pageCount} pages; limit is ${limits.maxPdfPages}`);
  }
}

function limitExtractedText(text, limits) {
  const value = String(text ?? '');
  if (value.length > limits.maxExtractedChars) {
    throw new AttachmentValidationError(
      'EXTRACTED_TEXT_LIMIT',
      `Extracted text exceeds ${limits.maxExtractedChars} characters`
    );
  }
  return value;
}

module.exports = {
  AttachmentValidationError,
  detectAttachmentType,
  fileExtension,
  inferredDisplayName,
  inspectDocxZip,
  limitExtractedText,
  normalizeMime,
  sanitizeDisplayName,
  assertPdfPageLimit,
};
