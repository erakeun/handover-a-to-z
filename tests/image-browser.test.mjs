// These are browser API plumbing tests with explicit codec/canvas substitutes.
// They do not claim a real browser decoded, pasted, selected, or downloaded files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { preparePhoto, verifyDocumentImages } from '../src/image-browser.js';
import { IMAGE_LIMITS, encodeBase64 } from '../src/image-data.js';

const png = new Uint8Array(await readFile(new URL('../fixtures/images/landscape.png', import.meta.url)));
const jpeg = new Uint8Array(await readFile(new URL('../fixtures/images/landscape.jpg', import.meta.url)));
const webp = new Uint8Array(await readFile(new URL('../fixtures/images/landscape.webp', import.meta.url)));
const WIDTH = 480;
const HEIGHT = 300;
const globalSnapshots = new WeakMap();

function replaceGlobal(t, key, value) {
  if (!globalSnapshots.has(t)) {
    const snapshots = new Map();
    globalSnapshots.set(t, snapshots);
    t.after(() => {
      for (const [name, descriptor] of snapshots) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    });
  }
  const snapshots = globalSnapshots.get(t);
  if (!snapshots.has(key)) snapshots.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

function file(bytes = png, type = 'image/png') {
  return new File([bytes], 'synthetic-photo', { type });
}

function photo(overrides = {}) {
  return {
    id: 'photo-1', section: 'method', caption: '가상 화면 — 실제 개인정보 없음',
    mime: 'image/png', width: WIDTH, height: HEIGHT, data: encodeBase64(png), ...overrides,
  };
}

function browserMocks(t, options = {}) {
  const log = { decoded: [], encoded: [], canvases: [], draws: [], fills: [], closes: 0, fetches: 0 };
  replaceGlobal(t, 'fetch', () => { log.fetches++; throw new Error('Network is forbidden in image tests'); });
  replaceGlobal(t, 'createImageBitmap', options.decode || (async blob => {
    log.decoded.push(blob);
    return { width: WIDTH, height: HEIGHT, close: () => log.closes++ };
  }));
  replaceGlobal(t, 'document', {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = {
        width: 0, height: 0,
        getContext(kind) {
          assert.equal(kind, '2d');
          return {
            fillStyle: '',
            fillRect: (...args) => log.fills.push(args),
            drawImage: (...args) => log.draws.push(args),
          };
        },
        toBlob(callback, mime, quality) {
          const call = { width: canvas.width, height: canvas.height, mime, quality };
          log.encoded.push(call);
          if (options.encode) options.encode(callback, call);
          else callback(new Blob([mime === 'image/jpeg' ? jpeg : png], { type: mime }));
        },
      };
      log.canvases.push(canvas);
      return canvas;
    },
  });
  return log;
}

test('image API plumbing: full-resolution PNG is prepared without resize or JPEG compression', async t => {
  const log = browserMocks(t);
  const input = file();
  const before = new Uint8Array(await input.arrayBuffer());
  const result = await preparePhoto(input);
  assert.deepEqual(result.original, { width: WIDTH, height: HEIGHT, bytes: png.length, mime: 'image/png' });
  assert.deepEqual(result.lossless, { mime: 'image/png', width: WIDTH, height: HEIGHT, data: encodeBase64(png) });
  assert.equal(result.compact, null);
  assert.deepEqual(log.encoded, [{ width: WIDTH, height: HEIGHT, mime: 'image/png', quality: undefined }]);
  assert.equal(log.decoded[0].type, 'image/png');
  assert.equal(log.closes, 1);
  assert.equal(log.fetches, 0);
  assert.equal(log.canvases[0].width, 0);
  assert.equal(log.canvases[0].height, 0);
  assert.deepEqual(new Uint8Array(await input.arrayBuffer()), before, 'source file stays unchanged');
});

test('image API plumbing: JPEG and static WebP are locally normalized to PNG; empty MIME is accepted by signature', async t => {
  const log = browserMocks(t);
  for (const [bytes, mime] of [[jpeg, 'image/jpeg'], [webp, 'image/webp'], [png, '']]) {
    const result = await preparePhoto(file(bytes, mime));
    assert.equal(result.lossless.mime, 'image/png');
    assert.equal(result.lossless.data, encodeBase64(png));
    assert.equal(result.compact, null);
  }
  assert.deepEqual(log.decoded.map(blob => blob.type), ['image/jpeg', 'image/webp', 'image/png']);
  assert.equal(log.closes, 3);
  assert.equal(log.fetches, 0);
});

test('image API plumbing: unsupported declarations, mismatched formats, empty and oversized input stop before codec', async t => {
  const log = browserMocks(t);
  await assert.rejects(preparePhoto(file(png, 'text/html')), /PNG·JPEG·WebP/);
  await assert.rejects(preparePhoto(file(png, 'image/svg+xml')), /PNG·JPEG·WebP/);
  await assert.rejects(preparePhoto(file(png, 'image/jpeg')), /표시 형식과 실제 내용/);
  await assert.rejects(preparePhoto(file(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))));
  await assert.rejects(preparePhoto(file(new Uint8Array())), /비어 있거나/);
  let reads = 0;
  await assert.rejects(preparePhoto({
    size: IMAGE_LIMITS.inputBytes + 1, type: 'image/png', arrayBuffer: () => { reads++; },
  }), /8 MiB/);
  await assert.rejects(preparePhoto({
    size: 1, type: 'image/png', arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
  }), /크기를 확인/);
  assert.equal(reads, 0);
  assert.equal(log.decoded.length, 0);
  assert.equal(log.encoded.length, 0);
});

test('image API plumbing: codec rejects damaged payload; decoded dimension discrepancy and oversized pixels close bitmaps', async t => {
  const log = browserMocks(t);
  globalThis.createImageBitmap = async () => { throw new Error('codec error'); };
  await assert.rejects(preparePhoto(file()), /사진을 읽지 못했습니다/);
  globalThis.createImageBitmap = async () => ({ width: WIDTH + 1, height: HEIGHT, close: () => log.closes++ });
  await assert.rejects(preparePhoto(file()), /사진을 읽지 못했습니다/);
  globalThis.createImageBitmap = async () => ({ width: 9000, height: HEIGHT, close: () => log.closes++ });
  await assert.rejects(preparePhoto(file()), /8,192/);
  assert.equal(log.closes, 2);
  assert.equal(log.canvases.length, 0);
});

test('image API plumbing: a compact JPEG is only returned as an explicit choice and discloses quality/transparency loss', async t => {
  const log = browserMocks(t, {
    encode(callback, { mime }) {
      callback(mime === 'image/png'
        ? new Blob([new Uint8Array(IMAGE_LIMITS.imageBytes + 1)], { type: mime })
        : new Blob([jpeg], { type: mime }));
    },
  });
  const result = await preparePhoto(file());
  assert.equal(result.lossless, null);
  assert.equal(result.compact.mime, 'image/jpeg');
  assert.equal(result.compact.data, encodeBase64(jpeg));
  assert.match(result.compactNotice, /흐려질 수/);
  assert.match(result.compactNotice, /투명한 부분은 흰색/);
  assert.deepEqual(log.encoded.map(({ mime, quality }) => [mime, quality]), [['image/png', undefined], ['image/jpeg', 0.9]]);
  assert.deepEqual(log.fills, [[0, 0, WIDTH, HEIGHT]]);
  assert.equal(log.closes, 1);
  assert.ok(log.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('image API plumbing: compact attempts are bounded and never silently return an oversized image', async t => {
  const log = browserMocks(t, {
    encode: callback => callback(new Blob([new Uint8Array(IMAGE_LIMITS.imageBytes + 1)])),
  });
  await assert.rejects(preparePhoto(file()), /사진 한 장의 저장 한도/);
  assert.equal(log.encoded.length, 7, 'one lossless attempt and at most six compact attempts');
  assert.ok(log.encoded.every(({ width, height }) => width <= WIDTH && height <= HEIGHT));
  assert.ok(log.encoded[6].width < log.encoded[1].width);
  assert.equal(log.closes, 1);
  assert.ok(log.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('image API plumbing: failed or unexpected canvas output releases all image resources', async t => {
  const log = browserMocks(t, { encode: callback => callback(null) });
  await assert.rejects(preparePhoto(file()), /사진 파일을 만들지/);
  assert.equal(log.closes, 1);
  assert.ok(log.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  const second = browserMocks(t, { encode: callback => callback(new Blob([jpeg], { type: 'image/jpeg' })) });
  await assert.rejects(preparePhoto(file()), /변환 결과를 확인/);
  assert.equal(second.closes, 1);
  assert.ok(second.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('image API plumbing: JSON photo verification is sequential, immutable, and does not re-encode', async t => {
  let active = 0;
  let maximum = 0;
  let closed = 0;
  const log = browserMocks(t, {
    decode: async () => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      return { width: WIDTH, height: HEIGHT, close: () => { active--; closed++; } };
    },
  });
  const input = { tasks: [{ images: [photo(), photo({ id: 'photo-2', section: 'steps', caption: '단계 2 참고' })] }, {}] };
  const before = JSON.stringify(input);
  assert.deepEqual(await verifyDocumentImages(input), { count: 2 });
  assert.equal(JSON.stringify(input), before);
  assert.equal(maximum, 1);
  assert.equal(closed, 2);
  assert.equal(log.canvases.length, 0);
  assert.equal(log.fetches, 0);
});

test('image API plumbing: JSON photos with invalid bytes or decoded dimensions cannot be imported', async t => {
  const log = browserMocks(t);
  await assert.rejects(verifyDocumentImages({ tasks: [{ images: [photo({ data: 'PHN2Zz4=' })] }] }));
  assert.equal(log.decoded.length, 0);
  globalThis.createImageBitmap = async () => ({ width: HEIGHT, height: WIDTH, close: () => log.closes++ });
  await assert.rejects(verifyDocumentImages({ tasks: [{ images: [photo()] }] }), /실제 사진이 다릅니다/);
  assert.equal(log.closes, 1);
});

test('image API plumbing: cancelled JSON verification closes the in-flight bitmap and skips remaining photos', async t => {
  let current = true;
  let decoded = 0;
  let closed = 0;
  browserMocks(t, {
    decode: async () => {
      decoded++;
      current = false;
      return { width: WIDTH, height: HEIGHT, close: () => closed++ };
    },
  });
  const input = { tasks: [{ images: [photo(), photo({ id: 'photo-2' })] }] };
  assert.deepEqual(await verifyDocumentImages(input, { isCurrent: () => current }), { cancelled: true, count: 0 });
  assert.equal(decoded, 1);
  assert.equal(closed, 1);
  assert.deepEqual(await verifyDocumentImages(input, { isCurrent: () => false }), { cancelled: true, count: 0 });
  assert.equal(decoded, 1, 'an already obsolete request never starts a codec');
});

test('image API plumbing: decoding times out and a late bitmap is closed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish;
  let closed = 0;
  browserMocks(t, { decode: () => new Promise(resolve => { finish = resolve; }) });
  const operation = verifyDocumentImages({ tasks: [{ images: [photo()] }] });
  const rejected = assert.rejects(operation, /시간이 너무 오래/);
  await Promise.resolve();
  t.mock.timers.tick(15_001);
  await rejected;
  finish({ width: WIDTH, height: HEIGHT, close: () => closed++ });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(closed, 1);
});

function fallbackMocks(t, outcome = 'load') {
  const log = browserMocks(t);
  globalThis.createImageBitmap = undefined;
  const urls = [];
  const revoked = [];
  replaceGlobal(t, 'URL', {
    createObjectURL(blob) {
      assert.equal(blob.type, 'image/png');
      const url = `blob:synthetic-${urls.length + 1}`;
      urls.push(url);
      return url;
    },
    revokeObjectURL: url => revoked.push(url),
  });
  replaceGlobal(t, 'Image', class {
    naturalWidth = WIDTH;
    naturalHeight = HEIGHT;
    onload = null;
    onerror = null;
    set src(value) {
      if (!value) return;
      assert.match(value, /^blob:/);
      if (outcome === 'load') queueMicrotask(() => this.onload?.());
      else if (outcome === 'error') queueMicrotask(() => this.onerror?.());
    }
  });
  return { log, urls, revoked };
}

test('image API plumbing: Image fallback uses only a temporary blob URL and revokes it after verification', async t => {
  const { log, urls, revoked } = fallbackMocks(t);
  assert.deepEqual(await verifyDocumentImages({ tasks: [{ images: [photo()] }] }), { count: 1 });
  assert.deepEqual(urls, ['blob:synthetic-1']);
  assert.deepEqual(revoked, urls);
  assert.equal(log.fetches, 0);
});

test('image API plumbing: Image fallback errors and timeouts revoke the blob URL', async t => {
  const first = fallbackMocks(t, 'error');
  await assert.rejects(verifyDocumentImages({ tasks: [{ images: [photo()] }] }), /사진을 읽지/);
  assert.deepEqual(first.revoked, first.urls);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const second = fallbackMocks(t, 'wait');
  const operation = verifyDocumentImages({ tasks: [{ images: [photo()] }] });
  const rejected = assert.rejects(operation, /시간이 너무 오래/);
  t.mock.timers.tick(15_001);
  await rejected;
  assert.deepEqual(second.revoked, second.urls);
});
