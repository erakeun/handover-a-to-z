import test from 'node:test';
import assert from 'node:assert/strict';
import { caseState, caseStateLabel, distinctInstructions, firstActionText } from '../src/handover-flow.js';

test('a legacy case record is retained but is not a confirmed real-world state',()=>{
 for(const status of ['todo','doing','waiting','done']){
  const item={status};const original=JSON.stringify(item);
  assert.equal(caseState(item),'unknown');assert.equal(caseStateLabel(item),'상태 미확인');
  assert.equal(JSON.stringify(item),original);
  assert.equal(caseState({...item,statusConfirmed:true}),status);
 }
 assert.equal(caseState({status:'unknown',statusConfirmed:true}),'unknown');
});
test('reading instructions omit only exact repetition and do not invent a first action',()=>{
 assert.deepEqual(distinctInstructions({method:'1. 확인',steps:'1. 확인'}).map(x=>x.key),['method']);
 assert.equal(distinctInstructions({method:'1. 확인',steps:'1. 확인\n'}).length,2);
 assert.equal(distinctInstructions({method:'1. 확인',steps:'조건이 다르면 중단'}).length,2);
 assert.equal(firstActionText({method:'첫 문장은 반드시 행동이 아닐 수 있다.'}),'');
});
