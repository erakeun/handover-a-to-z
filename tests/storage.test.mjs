import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument,createTask,stringifyDocument} from '../src/model.js';
import {DATA_KEY,PROGRESS_KEY,loadDocuments,saveDocuments,loadProgress,markProgress} from '../src/storage.js';
function memory(){const data=new Map();return {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)}}
test('autosave reload preserves Korean newlines and original document separately from dated progress',()=>{
 const s=memory(),doc=createDocument({title:'한글 인수인계',tasks:[createTask({title:'월말 업무',method:'첫째 줄\n둘째 줄\t표 셀'})]});
 saveDocuments(s,[doc]);const before=s.getItem(DATA_KEY);
 const progress=markProgress(s,{},doc.id,doc.tasks[0].id+'@2026-10-31',true);
 assert.equal(s.getItem(DATA_KEY),before);assert.deepEqual(loadDocuments(s),[doc]);
 assert.deepEqual(JSON.parse(JSON.stringify(loadProgress(s))),progress);
 const later=markProgress(s,progress,doc.id,doc.tasks[0].id+'@2026-11-30',true);
 assert.equal(Object.keys(later[doc.id]).length,2);
 assert.equal(stringifyDocument(loadDocuments(s)[0]),stringifyDocument(doc));
});
test('bad document cache fails without deleting its recoverable raw value',()=>{
 const s=memory();s.setItem(DATA_KEY,'{broken');assert.throws(()=>loadDocuments(s));assert.equal(s.getItem(DATA_KEY),'{broken');
 const d=createDocument();s.setItem(DATA_KEY,JSON.stringify([d,d]));assert.throws(()=>loadDocuments(s),/중복/);
});
test('bad progress cache fails separately, preserving original document and raw progress',()=>{
 const s=memory(),d=createDocument();saveDocuments(s,[d]);s.setItem(PROGRESS_KEY,'{"__proto__":{}}');assert.throws(()=>loadProgress(s));assert.deepEqual(loadDocuments(s),[d]);assert.equal(s.getItem(PROGRESS_KEY),'{"__proto__":{}}');
});
test('quota failure leaves passed-in progress untouched',()=>{
 const old={document:{task:{checked:false,at:'2026-10-20T00:00:00Z'}}};const serialized=JSON.stringify(old);const s={getItem(){return serialized;},setItem(){throw new Error('QuotaExceeded')}};
 assert.throws(()=>markProgress(s,old,'document','task',true),/Quota/);assert.equal(JSON.stringify(old),serialized);
});
