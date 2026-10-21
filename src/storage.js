import {validateDocument, stringifyDocument} from './model.js';
export const DATA_KEY='handover.az.documents.v3';
export const LEGACY_DATA_KEY='handover.az.documents.v1';
export const MIGRATION_KEY='handover.az.migration.v3';
export const PROGRESS_KEY='handover.az.progress.v1';
export const CURRENT_KEY='handover.az.current.v3';
export const LEGACY_CURRENT_KEY='handover.az.current.v1';
export function loadDocuments(storage) {
  const raw=storage.getItem(DATA_KEY);
  if (!raw) return [];
  if(raw.length>20*1024*1024) throw new Error('임시저장 용량이 너무 큽니다. 저장 원본을 내려받아 확인해 주세요.');
  let docs; try{ docs=JSON.parse(raw); }catch{throw new Error('임시저장을 읽지 못했습니다. 저장 원본을 내려받아 복구할 수 있습니다.');}
  if(!Array.isArray(docs) || docs.length>30 || docs.some(d=>!validateDocument(d).ok)) throw new Error('이 버전에서 읽을 수 없는 임시저장입니다. 원본을 내려받아 보관해 주세요.');
  if(new Set(docs.map(d=>d.id)).size!==docs.length) throw new Error('임시저장 문서 ID가 중복됩니다. 원본을 보관해 주세요.');
  return docs;
}
export function saveDocuments(storage,docs,expectedRaw=undefined){
 if(expectedRaw!==undefined&&storage.getItem(DATA_KEY)!==expectedRaw){const error=new Error("다른 창에서 문서가 바뀌었습니다. 현재 내용을 JSON으로 백업하고 변경된 저장을 불러와 주세요.");error.code="STORAGE_CONFLICT";throw error;}
 if(docs.length>30)throw new Error('기기 안에 문서를 30개까지 보관합니다. 백업 후 필요 없는 문서를 정리해 주세요.');
 docs.forEach(d=>stringifyDocument(d));
 storage.setItem(DATA_KEY,JSON.stringify(docs));
}
export function loadProgress(storage){
 try{
  const raw=storage.getItem(PROGRESS_KEY);if(!raw)return {};
  if(raw.length>2*1024*1024)throw new Error('size');
  const value=JSON.parse(raw);
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('shape');
  const clean=Object.create(null);
  for(const [docId,records] of Object.entries(value)){
   if(['__proto__','constructor','prototype'].includes(docId)||!records||typeof records!=='object'||Array.isArray(records))throw new Error('shape');
   clean[docId]=Object.create(null);
   for(const [id,v] of Object.entries(records)){
    if(['__proto__','constructor','prototype'].includes(id)||!v||typeof v.checked!=='boolean'||typeof v.at!=='string')throw new Error('shape');
    clean[docId][id]={checked:v.checked,at:v.at};
   }
  }
  return clean;
 }catch{throw new Error('수행 기록을 읽지 못했습니다. 원본 문서에는 영향이 없습니다. 기록 원본을 내려받아 보관해 주세요.');}
}
export function markProgress(storage,progress,docId,key,checked){
 const next=structuredClone(loadProgress(storage));
 next[docId]??={}; next[docId][key]={checked,at:new Date().toISOString()};
 const raw=JSON.stringify(next);if(raw.length>2*1024*1024)throw new Error('수행 기록 한도에 도달했습니다. 기록을 내려받아 보관한 후 초기화해 주세요.');
 storage.setItem(PROGRESS_KEY,raw);return next;
}
