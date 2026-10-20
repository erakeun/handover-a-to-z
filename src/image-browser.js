import {
  IMAGE_LIMITS, inspectImageBytes, decodeBase64, encodeBase64, validateImage,
} from './image-data.js';

const DECODE_TIMEOUT = 15_000;
const INPUT_MIMES = new Set(['', 'application/octet-stream', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const decodeError = () => new Error('사진을 읽지 못했습니다. 손상된 파일인지 확인하고 PNG·JPEG·WebP 사진으로 다시 넣어 주세요.');
const sizeLabel = bytes => bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;

function dimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 1 || height < 1
    || width > IMAGE_LIMITS.maxDimension || height > IMAGE_LIMITS.maxDimension
    || width * height > IMAGE_LIMITS.maxPixels) {
    throw new Error('사진 크기가 너무 크거나 올바르지 않습니다. 한 변 8,192픽셀, 전체 1,600만 픽셀 이하의 사진을 사용해 주세요.');
  }
}

// Construct the Blob only after checking its binary signature. No URL supplied
// by the document is ever loaded, and no file leaves this browser.
async function openImage(bytes, mime) {
  const blob = new Blob([bytes], { type: mime });
  if (typeof globalThis.createImageBitmap === 'function') {
    let expired = false;
    let timer;
    const bitmap = await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error('사진을 읽는 데 시간이 너무 오래 걸립니다. 더 작은 사진으로 다시 시도해 주세요.'));
      }, DECODE_TIMEOUT);
      Promise.resolve().then(() => globalThis.createImageBitmap(blob)).then(value => {
        clearTimeout(timer);
        if (expired) { value?.close?.(); return; }
        resolve(value);
      }, () => {
        clearTimeout(timer);
        if (!expired) reject(decodeError());
      });
    });
    try {
      dimensions(bitmap.width, bitmap.height);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch (error) {
      bitmap?.close?.();
      throw error;
    }
  }
  if (typeof globalThis.Image !== 'function' || typeof globalThis.URL?.createObjectURL !== 'function') {
    throw new Error('이 브라우저에서는 사진을 읽을 수 없습니다. 최신 Chrome·Edge·Safari·Firefox에서 다시 시도해 주세요.');
  }
  const source = new Image();
  const url = URL.createObjectURL(blob);
  let timer;
  const close = () => {
    clearTimeout(timer);
    source.onload = null;
    source.onerror = null;
    source.src = '';
    URL.revokeObjectURL(url);
  };
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('사진을 읽는 데 시간이 너무 오래 걸립니다. 더 작은 사진으로 다시 시도해 주세요.')), DECODE_TIMEOUT);
      source.onload = () => { clearTimeout(timer); resolve(); };
      source.onerror = () => { clearTimeout(timer); reject(decodeError()); };
      source.src = url;
    });
    dimensions(source.naturalWidth, source.naturalHeight);
    return { source, width: source.naturalWidth, height: source.naturalHeight, close };
  } catch (error) {
    close();
    throw error;
  }
}

function canvasBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error('사진을 준비하는 데 시간이 너무 오래 걸립니다. 더 작은 사진으로 다시 시도해 주세요.'));
    }, DECODE_TIMEOUT);
    try {
      canvas.toBlob(blob => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!blob || !blob.size) reject(new Error('사진 파일을 만들지 못했습니다. 다른 사진으로 다시 시도해 주세요.'));
        else resolve(blob);
      }, mime, quality);
    } catch {
      settled = true;
      clearTimeout(timer);
      reject(new Error('사진을 준비하지 못했습니다. 이 브라우저에서 사진 처리가 가능한지 확인해 주세요.'));
    }
  });
}

async function renderVersion(decoded, width, height, mime) {
  dimensions(width, height);
  if (!globalThis.document?.createElement) throw new Error('사진을 준비할 수 있는 브라우저 화면이 필요합니다.');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('이 브라우저에서는 사진을 준비할 수 없습니다.');
    if (mime === 'image/jpeg') {
      // JPEG has no alpha channel. This is disclosed beside the compact choice.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(decoded.source, 0, 0, width, height);
    const blob = await canvasBlob(canvas, mime, mime === 'image/jpeg' ? 0.9 : undefined);
    if (blob.size > IMAGE_LIMITS.imageBytes) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const inspected = inspectImageBytes(bytes);
    if (inspected.mime !== mime || inspected.width !== width || inspected.height !== height) {
      throw new Error('사진의 변환 결과를 확인하지 못했습니다. 다른 사진으로 다시 시도해 주세요.');
    }
    return { mime, width, height, data: encodeBase64(bytes) };
  } finally {
    // Release large pixel buffers even when encoding or validation fails.
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Prepare options, never choose or save a lossy image for the user.
 * lossless is a full-resolution PNG with browser-decoded pixels preserved.
 * compact is offered only when that PNG exceeds the per-image byte budget.
 */
export async function preparePhoto(file) {
  if (!file || typeof file.arrayBuffer !== 'function' || !Number.isSafeInteger(file.size) || file.size < 1) {
    throw new Error('비어 있거나 읽을 수 없는 사진 파일입니다.');
  }
  if (file.size > IMAGE_LIMITS.inputBytes) throw new Error(`사진 원본은 ${sizeLabel(IMAGE_LIMITS.inputBytes)} 이하로 선택해 주세요.`);
  const declaredMime = String(file.type || '').toLowerCase();
  if (!INPUT_MIMES.has(declaredMime)) throw new Error('PNG·JPEG·WebP 사진만 넣을 수 있습니다. SVG·HTML·움직이는 사진은 지원하지 않습니다.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > IMAGE_LIMITS.inputBytes || bytes.byteLength !== file.size) {
    throw new Error(`사진 파일의 크기를 확인하지 못했습니다. ${sizeLabel(IMAGE_LIMITS.inputBytes)} 이하의 사진을 다시 선택해 주세요.`);
  }
  const inspected = inspectImageBytes(bytes, { allowWebP: true });
  const normalizedMime = declaredMime === 'image/jpg' ? 'image/jpeg' : declaredMime;
  if (normalizedMime.startsWith('image/') && normalizedMime !== inspected.mime) {
    throw new Error('사진의 표시 형식과 실제 내용이 다릅니다. 원본 프로그램에서 PNG·JPEG·WebP로 저장한 뒤 다시 선택해 주세요.');
  }
  dimensions(inspected.width, inspected.height);
  const decoded = await openImage(bytes, inspected.mime);
  try {
    // Browsers apply JPEG EXIF orientation. Allow the dimensions to swap, but
    // reject any unrelated discrepancy between the header and decoded bitmap.
    const same = decoded.width === inspected.width && decoded.height === inspected.height;
    const rotated = inspected.mime === 'image/jpeg' && decoded.width === inspected.height && decoded.height === inspected.width;
    if (!same && !rotated) throw decodeError();
    const original = { width: decoded.width, height: decoded.height, bytes: bytes.byteLength, mime: inspected.mime };
    const lossless = await renderVersion(decoded, decoded.width, decoded.height, 'image/png');
    if (lossless) return { original, lossless, compact: null };
    let scale = Math.min(1, 1600 / Math.max(decoded.width, decoded.height));
    for (let attempt = 0; attempt < 6; attempt++) {
      const width = Math.max(1, Math.floor(decoded.width * scale));
      const height = Math.max(1, Math.floor(decoded.height * scale));
      const compact = await renderVersion(decoded, width, height, 'image/jpeg');
      if (compact) {
        return {
          original, lossless: null, compact,
          compactNotice: '용량을 줄이면 사진의 글자가 흐려질 수 있습니다. JPEG로 압축하며 투명한 부분은 흰색이 됩니다. 확대해서 확인한 뒤 추가해 주세요.',
        };
      }
      scale *= 0.8;
    }
    throw new Error(`사진 한 장의 저장 한도 ${sizeLabel(IMAGE_LIMITS.imageBytes)}에 맞추지 못했습니다. 필요한 부분만 잘라서 다시 넣어 주세요. 원본 사진은 바뀌지 않았습니다.`);
  } finally {
    decoded.close();
  }
}

/**
 * After structural JSON validation, also ask the browser's image codec to read
 * each payload before importing it. Work sequentially to bound decoded memory.
 */
export async function verifyDocumentImages(document, { isCurrent = () => true } = {}) {
  if (typeof isCurrent !== 'function') throw new TypeError('사진 검토 상태를 확인할 함수가 필요합니다.');
  let count = 0;
  for (const task of document.tasks) {
    for (const image of task.images || []) {
      if (!isCurrent()) return { cancelled: true, count };
      validateImage(image);
      const decoded = await openImage(decodeBase64(image.data), image.mime);
      try {
        // The browser codec itself cannot be aborted, so an obsolete import may
        // finish at most this one bounded decode; its bitmap is still closed.
        if (!isCurrent()) return { cancelled: true, count };
        if (decoded.width !== image.width || decoded.height !== image.height) {
          throw new Error('전달 파일의 사진 크기와 실제 사진이 다릅니다. 원본 전달 파일을 확인해 주세요.');
        }
        count++;
      } finally {
        decoded.close();
      }
    }
  }
  return { count };
}
