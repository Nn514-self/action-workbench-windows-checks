import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBackend } from 'action-workbench';
import { expensesModule } from '../starter/expenses.ts';

const author = { id:'one', tenantId:'north', permissions:['expenses:read','expenses:write'] };
const stranger = { ...author, id:'two' }, otherTenant = { ...author, tenantId:'south' };
const viewer = { ...author, permissions:['expenses:read'] };
const draft = { title:'外出交通', amount:'36.09' };
function book(file=':memory:') {
  const db = new DatabaseSync(file);
  return { api:createBackend({database:db,modules:[expensesModule(db)]}), close:()=>db.close() };
}
function workspace(t) { const b=book(); t.after(b.close); return b.api; }

test('manual draft and pending submission survive restart with exact cents; retries and confirmations do not duplicate writes',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'aw-test-'));let next;
  t.after(()=>{try {next?.close();} finally {rmSync(dir,{recursive:true,force:true});}});
  const file=join(dir,'book.sqlite'), first=book(file); let draftId,submissionId;
  try {
    const saved=await first.api.invoke(author,'expenses.create',draft,{idempotencyKey:'first'});
    draftId=saved.result.id;
    const sub=await first.api.invoke(author,'expenses.submit',{id:draftId});
    assert.equal(sub.status,'pending'); submissionId=sub.id;
  } finally { first.close(); }
  next=book(file);
  const replay=await next.api.invoke(author,'expenses.create',{amount:draft.amount,title:draft.title},{idempotencyKey:'first'});
  assert.equal(replay.result.id,draftId);
  await assert.rejects(next.api.invoke(author,'expenses.create',{...draft,amount:'37'},{idempotencyKey:'first'}),{code:'IDEMPOTENCY_CONFLICT'});
  const expected={id:draftId,...draft,status:'已提交'};
  assert.deepEqual((await next.api.confirm(author,submissionId)).result,expected);
  assert.deepEqual((await next.api.confirm(author,submissionId)).result,expected);
  assert.deepEqual((await next.api.invoke(author,'expenses.list',{})).result,[expected]);
});

test('privileges, ownership, tenant isolation and strict inputs hold at direct module entry points',async t=>{
  const api=workspace(t);
  const {result:{id}}=await api.invoke(author,'expenses.create',draft);
  assert.deepEqual(api.discover(viewer).map(x=>x.name),['expenses.list']);
  await assert.rejects(api.invoke(viewer,'expenses.submit',{id}),{status:404});
  await assert.rejects(api.invoke(null,'expenses.list',{}),{status:401});
  await assert.rejects(api.invoke(author,'expenses.create',{...draft,owner:'two'}),{status:400});
  await assert.rejects(api.invoke(author,'expenses.create',{...draft,amount:'0.00'}),{status:400});
  for(const user of [stranger,otherTenant]){
    const p=await api.invoke(user,'expenses.submit',{id});
    assert.equal((await api.confirm(user,p.id)).error.code,'EXPENSE_NOT_FOUND');
    assert.deepEqual((await api.invoke(user,'expenses.list',{})).result,[]);
  }
  assert.equal((await api.invoke(author,'expenses.list',{})).result[0].status,'草稿');
});

test('AI proposals cannot write until confirmed, cannot be claimed by another tenant or user, and cannot execute twice',async t=>{
  const api=workspace(t), proposal=await api.invoke(author,'expenses.create',draft,{source:'ai'});
  assert.deepEqual((await api.invoke(author,'expenses.list',{})).result,[]);
  for(const user of [stranger,otherTenant]) await assert.rejects(api.confirm(user,proposal.id),{status:404});
  const [first,second]=await Promise.all([api.confirm(author,proposal.id),api.confirm(author,proposal.id)]);
  assert.equal(first.status,'succeeded'); assert.ok(['running','succeeded'].includes(second.status));
  assert.deepEqual((await api.invoke(author,'expenses.list',{})).result,[{id:'1',...draft,status:'草稿'}]);
});

test('cancelled proposals and revoked permissions cannot create a draft',async t=>{
  const api=workspace(t);
  const cancelled=await api.invoke(author,'expenses.create',draft,{source:'ai'});
  assert.equal(api.cancel(author,cancelled.id).status,'cancelled');
  assert.equal((await api.confirm(author,cancelled.id)).status,'cancelled');
  const fresh=await api.invoke(author,'expenses.create',draft,{source:'ai'});
  await assert.rejects(api.confirm(viewer,fresh.id),{status:404});
  assert.deepEqual((await api.invoke(author,'expenses.list',{})).result,[]);
});
