import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { command, createBackend, defineModule } from 'action-workbench';
import { createHttpServer } from 'action-workbench/http';
import { expensesModule } from '../starter/expenses.ts';
import { ordersModule } from '../starter/orders.ts';

const alice={id:'alice',tenantId:'A',permissions:['expenses:write','orders:write']};
const restricted={...alice,permissions:['expenses:write']};
const expense={title:'出差',amount:'9.50'};

test('pending inbox paginates visible items across confirmation, filtering by current grants, owner, tenant and expiry',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1700000000000});
  const db=new DatabaseSync(':memory:'); const backend=createBackend({database:db,modules:[ordersModule(db),expensesModule(db)],confirmationTtlMs:1000});
  const identities=new Map([['alice',restricted],['bob',{...restricted,id:'bob'}],['other-tenant',{...restricted,tenantId:'B'}]]);
  const http=createHttpServer(backend,{authenticate:req=>identities.get(req.headers.authorization) ?? null});
  t.after(async()=>{await http.close();db.close()});
  const path='/_aw/invocations/pending';
  const get=(query='',user='alice')=>http.inject({method:'GET',url:path+query,headers:{authorization:user}});
  const propose=(actor=alice)=>backend.invoke(actor,'expenses.create',expense,{source:'ai'});
  await propose(); t.mock.timers.tick(1001); // Not looked up, so its persisted state has not been expired lazily.
  const valid=[await propose(),await propose()]; // Identical timestamp; second sort key must be stable.
  const cancelled=await propose(); backend.cancel(alice,cancelled.id);
  await backend.invoke(alice,'orders.place',{item:'私人订单'},{source:'ai'});
  const b=await propose(identities.get('bob')), other=await propose(identities.get('other-tenant'));
  const first=(await get('?limit=1')).json();
  const ordered=valid.map(p=>p.id).sort().reverse();
  assert.equal(first.items.length,1); assert.deepEqual(first.items[0],{id:ordered[0],action:'expenses.create',source:'ai',status:'pending',input:expense,createdAt:Date.now(),expiresAt:Date.now()+1000});
  assert.equal((await backend.confirm(restricted,ordered[0])).status,'succeeded');
  t.mock.timers.tick(1); await propose(); // New requests must not shift the next page.
  const second=(await get('?limit=1&cursor='+encodeURIComponent(first.nextCursor))).json();
  assert.deepEqual(second.items.map(p=>p.id),[ordered[1]]); assert.equal(second.nextCursor,null);
  for (const [user,expected] of [['bob',b.id],['other-tenant',other.id]]) {
    assert.deepEqual((await get('',user)).json().items.map(p=>p.id),[expected]);
    assert.ok((await get('?cursor='+encodeURIComponent(first.nextCursor),user)).json().items.every(p=>p.id===expected));
  }
  assert.equal((await get('','nobody')).statusCode,401);
  for (const q of ['?limit=0','?limit=101','?limit=2&limit=3','?cursor=bad','?tenant=A']) assert.equal((await get(q)).statusCode,400,q);
});

test('inbox hides stale action versions and AI proposals whose exposure was revoked, preserving HTTP proposals',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const app=(version,ai)=>createBackend({database:db,modules:[defineModule('expense',{submit:command({description:'提交费用',permission:'expenses:write',version,ai,http:{method:'POST',path:'/submit'},input:z.strictObject({}),output:z.boolean(),run:()=>true})})]});
  const original=app(1,true), manual=await original.invoke(alice,'expense.submit',{}), chat=await original.invoke(alice,'expense.submit',{},{source:'ai'});
  const noModelAccess=app(1,false);
  assert.deepEqual(noModelAccess.pending(alice).items.map(p=>[p.id,p.source]),[[manual.id,'http']]);
  await assert.rejects(noModelAccess.confirm(alice,chat.id),{status:404});
  const changed=app(2,true); assert.deepEqual(changed.pending(alice),{items:[],nextCursor:null});
  await assert.rejects(changed.confirm(alice,manual.id),{code:'ACTION_CHANGED'});
});
