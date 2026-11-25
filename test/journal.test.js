import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {createBackend,defineModule,command,migrate} from 'action-workbench';

const actor={id:'one',tenantId:'alpha',permissions:['send']};
function app(db,run,version=1,extra={}) {
  return createBackend({database:db,...extra,modules:[defineModule('mail',{send:command({description:'发送通知',permission:'send',version,http:{method:'POST',path:'/send'},input:z.strictObject({}),output:z.string(),run})})]});
}
test('unknown downstream result remains inspectable and cannot be blindly retried', async t=>{
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close()); let writes=0;
  const b=app(db,()=>{writes++;throw new Error('private downstream data')});
  const p=await b.invoke(actor,'mail.send',{}, {idempotencyKey:'once'});
  const result=await b.confirm(actor,p.id); assert.equal(result.status,'unknown'); assert.equal(result.error.code,'OUTCOME_UNKNOWN');
  assert.equal((await b.invoke(actor,'mail.send',{}, {idempotencyKey:'once'})).status,'unknown');
  assert.equal((await b.confirm(actor,p.id)).status,'unknown'); assert.equal(writes,1);
  assert.ok(!JSON.stringify(b.status(actor,p.id)).includes('private downstream data'));
});
test('changed action version and expired proposals cannot run under new semantics',async t=>{
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close()); let writes=0;const run=()=>String(++writes);
  const old=app(db,run);const p=await old.invoke(actor,'mail.send',{});
  const revised=app(db,run,2);await assert.rejects(revised.confirm(actor,p.id),{code:'ACTION_CHANGED'});
  t.mock.timers.enable({apis:['Date'],now:1_000_000});
  const proposal=await revised.invoke(actor,'mail.send',{});t.mock.timers.tick(301_000);
  assert.equal((await revised.confirm(actor,proposal.id)).status,'expired');assert.equal(writes,0);
});
test('a failed schema migration rolls back both data changes and migration markers',()=>{
  const db=new DatabaseSync(':memory:');try{
    assert.throws(()=>migrate(db,'inventory',['CREATE TABLE stock(n INTEGER)','INSERT INTO missing VALUES(1)']));
    migrate(db,'inventory',['CREATE TABLE stock(n INTEGER)','INSERT INTO stock VALUES(17)']);
    assert.equal(db.prepare('SELECT n FROM stock').get().n,17);
    assert.throws(()=>migrate(db,'inventory',['CREATE TABLE stock(n TEXT)','INSERT INTO stock VALUES(17)']),/Migration changed/);
  }finally{db.close()}
});
