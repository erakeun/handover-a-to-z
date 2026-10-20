import { stringifyDocument } from './model.js';
import { DATA_KEY, loadDocuments } from './storage.js';

export const DATABASE_NAME = 'handover.az.documents';
export const DATABASE_VERSION = 1;
export const STORE_NAME = 'documents';
export const RECORD_KEY = 'current';
export const MAX_STORED_BYTES = 64 * 1024 * 1024;
const LEGACY_MAX_LENGTH = 20 * 1024 * 1024;
const encoder = new TextEncoder();
const FALLBACK_WARNING = '이 브라우저는 IndexedDB를 지원하지 않아 용량이 작은 기존 기기 저장소를 사용합니다. 사진이 많은 문서는 JSON 파일로도 백업해 주세요.';
const BACKUP_NOTICE = '자동저장을 완료하지 못했습니다. 현재 문서와 저장 원본을 JSON으로 백업해 주세요.';

function problem(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function storageProblem(cause, message = '기기 저장소를 사용할 수 없습니다.') {
  if (cause?.code && typeof cause.code === 'string') return cause;
  if (cause?.name === 'QuotaExceededError') {
    return problem('STORAGE_QUOTA', `기기 저장 공간이 부족합니다. ${BACKUP_NOTICE}`, cause);
  }
  return problem('STORAGE_UNAVAILABLE', `${message} ${BACKUP_NOTICE}`, cause);
}

function invalid(cause) {
  return problem('STORAGE_INVALID', '저장된 문서를 안전하게 읽을 수 없습니다. 저장 원본을 내려받아 보관해 주세요.', cause);
}

function serializeDocuments(documents) {
  if (!Array.isArray(documents) || Object.getPrototypeOf(documents) !== Array.prototype) throw invalid();
  if (documents.length > 30) {
    throw problem('STORAGE_LIMIT', '기기 안에 문서를 30개까지 보관합니다. 백업 후 필요 없는 문서를 정리해 주세요.');
  }
  const keys = Reflect.ownKeys(documents);
  if (keys.length !== documents.length + 1) throw invalid();
  const ids = new Set();
  const parts = [];
  let bytes = 2; // opening and closing brackets
  for (let index = 0; index < documents.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(documents, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
    const document = descriptor.value;
    stringifyDocument(document);
    if (ids.has(document.id)) throw problem('STORAGE_INVALID', '임시저장 문서 ID가 중복됩니다. 원본을 보관해 주세요.');
    ids.add(document.id);
    const part = JSON.stringify(document);
    bytes += encoder.encode(part).byteLength + (index ? 1 : 0);
    if (bytes > MAX_STORED_BYTES) throw aggregateLimit();
    parts.push(part);
  }
  // At most 64 MiB is assembled, even if the input has thirty 24 MiB documents.
  return `[${parts.join(',')}]`;
}

function aggregateLimit() {
  return problem('STORAGE_LIMIT', '기기에 보관하는 문서 전체 용량은 UTF-8 기준 64 MiB까지입니다. JSON 백업 후 필요 없는 문서를 정리해 주세요.');
}

function checkRawSize(raw) {
  if (raw.length > MAX_STORED_BYTES || encoder.encode(raw).byteLength > MAX_STORED_BYTES) {
    throw aggregateLimit();
  }
}

function parseDocuments(raw, legacy = false) {
  if (raw === null) return [];
  if (typeof raw !== 'string') throw invalid();
  if (legacy) {
    try { return loadDocuments({ getItem: () => raw }); }
    catch (cause) { throw invalid(cause); }
  }
  checkRawSize(raw);
  let documents;
  try { documents = JSON.parse(raw); }
  catch (cause) { throw invalid(cause); }
  try { serializeDocuments(documents); }
  catch (cause) { throw cause.code ? cause : invalid(cause); }
  return documents;
}

function parseRecord(record) {
  if (!record || record.version !== 1 ||
      !(record.raw === null || typeof record.raw === 'string') ||
      !(record.legacyRaw === null || typeof record.legacyRaw === 'string')) throw invalid();
  return { raw: record.raw, documents: parseDocuments(record.raw), legacyRaw: record.legacyRaw };
}

function readLegacy(storage) {
  if (!storage || typeof storage.getItem !== 'function') {
    throw problem('STORAGE_LEGACY_UNAVAILABLE', '이전 기기 저장소를 확인할 수 없습니다. 원본을 보호하기 위해 자동저장을 중단했습니다.');
  }
  try {
    const raw = storage.getItem(DATA_KEY);
    if (raw !== null && typeof raw !== 'string') throw invalid();
    return raw;
  } catch (cause) {
    if (cause?.code === 'STORAGE_INVALID') throw cause;
    throw problem('STORAGE_LEGACY_UNAVAILABLE', '이전 기기 저장소를 읽을 수 없습니다. 원본을 보호하기 위해 자동저장을 중단했습니다.', cause);
  }
}

function openDatabase(factory, timeoutMs) {
  return new Promise((resolve, reject) => {
    let request;
    let finished = false;
    let blocked = false;
    let upgradeError;
    const fail = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { request?.transaction?.abort(); } catch {}
      reject(error);
    };
    const timer = setTimeout(() => fail(problem(
      blocked ? 'STORAGE_BLOCKED' : 'STORAGE_TIMEOUT',
      blocked
        ? '다른 창이 기기 저장소의 변경을 막고 있습니다. 다른 창을 닫고 다시 열어 주세요. 저장 원본은 유지됩니다.'
        : '기기 저장소를 여는 데 시간이 너무 오래 걸립니다. 저장 원본은 유지됩니다.',
    )), timeoutMs);
    try {
      request = factory.open(DATABASE_NAME, DATABASE_VERSION);
      request.onblocked = () => { blocked = true; };
      request.onupgradeneeded = () => {
        if (finished) {
          try { request.transaction?.abort(); } catch {}
          try { request.result.close(); } catch {}
          return;
        }
        try {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
        } catch (cause) {
          upgradeError = storageProblem(cause, '기기 저장소를 준비하지 못했습니다.');
          try { request.transaction?.abort(); } catch {}
        }
      };
      request.onerror = () => fail(upgradeError || storageProblem(request.error, '기기 저장소를 열지 못했습니다.'));
      request.onsuccess = () => {
        if (finished) {
          request.result.close();
          return;
        }
        finished = true;
        clearTimeout(timer);
        resolve(request.result);
      };
    } catch (cause) { fail(storageProblem(cause, '기기 저장소를 열지 못했습니다.')); }
  });
}

// Requests succeeding is not enough: transaction completion is the commit point.
function transaction(database, mode, timeoutMs, action) {
  return new Promise((resolve, reject) => {
    let tx;
    let value;
    let failure;
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = (cause) => {
      failure = storageProblem(cause);
      try { tx.abort(); }
      catch { finish(failure); }
    };
    try {
      tx = database.transaction(STORE_NAME, mode);
      tx.oncomplete = () => finish(failure);
      tx.onabort = () => finish(failure || storageProblem(tx.error, '기기 저장 작업이 취소되었습니다.'));
      tx.onerror = (event) => {
        failure ||= storageProblem(event?.target?.error || tx.error);
      };
      timer = setTimeout(() => {
        abort(problem('STORAGE_TIMEOUT', `기기 저장 완료를 확인하는 데 시간이 너무 오래 걸립니다. ${BACKUP_NOTICE}`));
        // A broken implementation may never dispatch an abort event.
        finish(failure);
      }, timeoutMs);
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(RECORD_KEY);
      request.onsuccess = () => {
        if (settled || failure) return;
        try { value = action(request.result, store); }
        catch (cause) { abort(cause); }
      };
      request.onerror = () => { failure ||= storageProblem(request.error); };
    } catch (cause) { finish(storageProblem(cause)); }
  });
}

/**
 * Browser-only persistence. `raw` is the optimistic concurrency token.
 * Read failures return a read-only memory view with recoverable source text;
 * they never silently replace persisted documents or fall back to writing LS.
 */
export async function openDocumentStore({ storage, indexedDB, timeoutMs = 5000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
  let kind = 'memory';
  let snapshot = { documents: [], raw: null };
  let warning = '';
  let failure = null;
  let readOnly = false;
  let database = null;
  let legacyRaw = null;
  let legacyError = null;
  let baseline;
  const recovery = new Map();

  function remember(source, raw) {
    if (typeof raw === 'string') recovery.set(source, raw);
    else if (raw === null) recovery.delete(source);
  }
  function stop(cause) {
    failure = storageProblem(cause);
    warning = failure.message;
    readOnly = true;
    kind = 'memory';
    if (database) {
      try { database.close(); } catch {}
      database = null;
    }
    return failure;
  }
  function noteFailure(cause) {
    failure = storageProblem(cause);
    warning = failure.message;
    return failure;
  }
  function confirmLegacy(expected) {
    const current = readLegacy(storage);
    remember('localStorage', current);
    if (current !== expected) {
      throw problem('STORAGE_LEGACY_CHANGED', '이전 버전의 다른 창에서 문서가 변경되었습니다. 새 저장소와 이전 저장소의 원본을 모두 백업한 뒤 확인해 주세요. 덮어쓰기를 중단했습니다.');
    }
  }
  function adopt(raw, documents) {
    snapshot = { raw, documents };
    remember('indexedDB', raw);
  }
  function view() {
    return { documents: structuredClone(snapshot.documents), raw: snapshot.raw };
  }
  function assertWritable() {
    if (readOnly) throw failure || problem('STORAGE_CLOSED', '기기 저장소가 닫혀 있습니다.');
  }
  const api = {
    get kind() { return kind; },
    get documents() { return structuredClone(snapshot.documents); },
    get raw() { return snapshot.raw; },
    get warning() { return warning; },
    get readOnly() { return readOnly; },
    get errorCode() { return failure?.code || ''; },
    get recoveryRecords() { return [...recovery].map(([source, raw]) => ({ source, raw })); },
    async save(documents, expectedRaw = snapshot.raw) {
      assertWritable();
      const raw = serializeDocuments(documents);
      if (kind === 'localStorage') {
        if (raw.length > LEGACY_MAX_LENGTH) {
          throw noteFailure(problem('STORAGE_LIMIT', '기존 기기 저장소의 읽기 한도를 초과했습니다. 현재 문서를 JSON으로 백업해 주세요.'));
        }
        try {
          if (readLegacy(storage) !== expectedRaw) {
            throw problem('STORAGE_CONFLICT', '다른 창에서 문서가 바뀌었습니다. 현재 내용을 JSON으로 백업하고 변경된 저장을 불러와 주세요.');
          }
          storage.setItem(DATA_KEY, raw);
          snapshot = { raw, documents: JSON.parse(raw) };
          remember('localStorage', raw);
          failure = null;
          warning = FALLBACK_WARNING;
          return raw;
        } catch (cause) { throw noteFailure(cause); }
      }
      try {
        await transaction(database, 'readwrite', timeoutMs, (record, store) => {
          remember('indexedDB', record?.raw);
          const current = parseRecord(record);
          confirmLegacy(current.legacyRaw);
          if (current.raw !== expectedRaw) {
            throw problem('STORAGE_CONFLICT', '다른 창에서 문서가 바뀌었습니다. 현재 내용을 JSON으로 백업하고 변경된 저장을 불러와 주세요.');
          }
          store.put({ version: 1, raw, legacyRaw: current.legacyRaw }, RECORD_KEY);
        });
        adopt(raw, JSON.parse(raw));
        assertWritable();
        confirmLegacy(baseline);
        failure = null;
        warning = '';
        return raw;
      } catch (cause) {
        if (['STORAGE_LEGACY_CHANGED', 'STORAGE_LEGACY_UNAVAILABLE', 'STORAGE_INVALID', 'STORAGE_TIMEOUT'].includes(cause?.code)) throw stop(cause);
        throw noteFailure(cause);
      }
    },
    async reload() {
      assertWritable();
      if (kind === 'localStorage') {
        try {
          const raw = readLegacy(storage);
          remember('localStorage', raw);
          const documents = parseDocuments(raw, true);
          snapshot = { raw, documents };
          warning = FALLBACK_WARNING;
          failure = null;
          return view();
        } catch (cause) { throw stop(cause); }
      }
      try {
        await transaction(database, 'readonly', timeoutMs, (record) => {
          remember('indexedDB', record?.raw);
          const current = parseRecord(record);
          adopt(current.raw, current.documents);
          baseline = current.legacyRaw;
          confirmLegacy(baseline);
        });
        assertWritable();
        confirmLegacy(baseline);
        failure = null;
        warning = '';
        return view();
      } catch (cause) { throw stop(cause); }
    },
    close() {
      stop(problem('STORAGE_CLOSED', '기기 저장소 연결을 닫았습니다. 다시 열어 저장 상태를 확인해 주세요.'));
    },
  };

  try {
    legacyRaw = readLegacy(storage);
    remember('localStorage', legacyRaw);
    snapshot = { raw: legacyRaw, documents: parseDocuments(legacyRaw, true) };
  } catch (cause) {
    legacyError = cause;
    snapshot.raw = legacyRaw;
  }
  if (indexedDB === undefined) {
    try { indexedDB = globalThis.indexedDB; }
    catch (cause) { stop(cause); return api; }
  }
  // Unsupported is distinct from present-but-denied, blocked or broken.
  if (indexedDB === undefined || indexedDB === null) {
    if (legacyError) stop(legacyError);
    else { kind = 'localStorage'; warning = FALLBACK_WARNING; }
    return api;
  }
  try {
    database = await openDatabase(indexedDB, timeoutMs);
    database.onversionchange = () => stop(problem('STORAGE_VERSION_CHANGED', '다른 창에서 기기 저장소 버전이 변경되어 연결을 닫았습니다. 현재 내용을 JSON으로 백업하고 화면을 새로 열어 주세요.'));
    database.onclose = () => {
      if (!readOnly) stop(problem('STORAGE_CLOSED', `기기 저장소 연결이 예기치 않게 닫혔습니다. ${BACKUP_NOTICE}`));
    };
    await transaction(database, 'readwrite', timeoutMs, (record, store) => {
      if (record !== undefined) {
        remember('indexedDB', record?.raw);
        const current = parseRecord(record);
        // Preserve a successfully read IDB snapshot even if a later check or
        // the transaction itself fails. Never substitute older LS documents.
        adopt(current.raw, current.documents);
        baseline = current.legacyRaw;
        confirmLegacy(baseline);
      } else {
        if (legacyError) throw legacyError;
        confirmLegacy(legacyRaw);
        baseline = legacyRaw;
        store.put({ version: 1, raw: legacyRaw, legacyRaw }, RECORD_KEY);
      }
    });
    remember('indexedDB', snapshot.raw);
    assertWritable();
    confirmLegacy(baseline);
    kind = 'indexedDB';
    warning = '';
  } catch (cause) { stop(cause); }
  return api;
}
