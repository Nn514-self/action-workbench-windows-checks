import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ActionError, createBackend, defineModule, sqliteCommand } from 'action-workbench';
import { ordersModule } from '../starter/orders.ts';

const actor = {id:'buyer',tenantId:'shop',permissions:['orders:read','orders:write']};
const item = {item:'蓝色笔记本'}, options = {idempotencyKey:'checkout-17'};
function open(file) {
  const db = new DatabaseSync(file);
  return {db, api:createBackend({database:db,modules:[ordersModule(db)]})};
}
// Only the disposable child exits. Its business INSERT has returned; the success receipt has not been written.
const childCode = `
  import { DatabaseSync } from 'node:sqlite';
  import { createBackend } from 'action-workbench';
  import { ordersModule } from ${JSON.stringify(new URL('../starter/orders.ts',import.meta.url).href)};
  const [file, id] = process.argv.slice(1), db = new DatabaseSync(file);
  const api = createBackend({database:db,modules:[ordersModule(db)]});
  db.function('interrupt_receipt', () => process.exit(73));
  db.exec(\"CREATE TEMP TRIGGER interrupted BEFORE UPDATE OF state ON aw_invocations WHEN NEW.state='succeeded' BEGIN SELECT interrupt_receipt(); END\");
  if (id) await api.confirm(${JSON.stringify(actor)},id);
  else await api.invoke(${JSON.stringify(actor)},'orders.place',${JSON.stringify(item)},${JSON.stringify(options)});
`;
for (const confirmation of [false,true]) {
  test(`crash between order write and receipt: ${confirmation?'AI confirmation remains pending':'HTTP retry can claim the original key'}`, async t=>{
    const dir=mkdtempSync(join(tmpdir(),'aw-atomic-'));let reopened;
    t.after(()=>{try {reopened?.db.close();} finally {rmSync(dir,{recursive:true,force:true});}});
    const file = join(dir,'product.sqlite'); let id;
    const first = open(file);
    try {
      first.db.exec('PRAGMA journal_mode=WAL');
      if (confirmation) id=(await first.api.invoke(actor,'orders.place',item,{source:'ai'})).id;
    } finally {first.db.close()}
    const stopped=spawnSync(process.execPath,['--input-type=module','-e',childCode,file,...(id?[id]:[])],{cwd:fileURLToPath(new URL('..',import.meta.url)),timeout:10000,encoding:'utf8'});
    assert.equal(stopped.status,73,stopped.error?.message ?? stopped.stderr);
    reopened=open(file);const {api}=reopened;
    assert.deepEqual((await api.invoke(actor,'orders.list',{})).result,[]);
    if (id) assert.deepEqual(api.pending(actor).items.map(p=>p.id),[id]);
    const retry=()=>id?api.confirm(actor,id):api.invoke(actor,'orders.place',item,options);
    const recovered=await retry(); assert.equal(recovered.status,'succeeded');
    assert.deepEqual(await retry(),recovered);
    assert.deepEqual((await api.invoke(actor,'orders.list',{})).result,[recovered.result]);
  });
}

test('business rejection and invalid output both undo partial local work and persist the appropriate failure',async t=>{
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close());
  db.exec('CREATE TABLE inventory(n INTEGER); INSERT INTO inventory VALUES(10)');
  const stock=db.prepare('SELECT n FROM inventory'), subtract=db.prepare('UPDATE inventory SET n=n-1');
  const reserve=sqliteCommand(db,{description:'预留一件库存',permission:'orders:write',http:{method:'POST',path:'/reserve'},confirmation:'none',
    input:z.strictObject({reason:z.enum(['closed','invalid','open'])}),output:z.int(),run(_ctx,{reason}) {
      subtract.run();
      if (reason==='closed') throw new ActionError(409,'WAREHOUSE_CLOSED','库房已关闭。');
      return reason==='invalid' ? 'private upstream detail' : stock.get().n;
    }});
  const api=createBackend({database:db,modules:[defineModule('stock',{reserve})]});
  for (const [reason,code] of [['closed','WAREHOUSE_CLOSED'],['invalid','ACTION_ROLLED_BACK']]) {
    const request=()=>api.invoke(actor,'stock.reserve',{reason},{idempotencyKey:reason});
    const r=await request(); assert.equal(r.status,'failed'); assert.equal(r.error.code,code);
    assert.deepEqual(await request(),r); assert.deepEqual(api.status(actor,r.id),r);
    assert.equal(stock.get().n,10); assert.ok(!JSON.stringify(r).includes('private upstream detail'));
  }
  assert.equal((await api.invoke(actor,'stock.reserve',{reason:'open'})).result,9);
});

test('local commands reject an async handler or a different SQLite connection at setup',t=>{
  const a=new DatabaseSync(':memory:'), b=new DatabaseSync(':memory:'); t.after(()=>{a.close();b.close()});
  assert.throws(()=>createBackend({database:b,modules:[ordersModule(a)]}),/database connection/);
  assert.throws(()=>sqliteCommand(a,{description:'预留',permission:'x',http:{method:'POST',path:'/reserve'},input:z.strictObject({}),output:z.int(),run:async()=>1}),/synchronous handler/);
});
