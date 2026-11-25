import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createBackend } from 'action-workbench';
import { createHttpServer } from 'action-workbench/http';
import { ordersModule } from '../starter/orders.ts';
import { expensesModule } from '../starter/expenses.ts';

const actor={id:'one',tenantId:'A',permissions:['orders:read','orders:write','orders:ship','expenses:read','expenses:write']};
function api(t,provider) {
  const db=new DatabaseSync(':memory:');
  const server=createHttpServer(createBackend({modules:[ordersModule(db),expensesModule(db)],database:db}),{provider, authenticate:req=>{
    if (req.headers.authorization==='user-a') return actor;
    if (req.headers.authorization==='user-b') return {...actor,tenantId:'B'};
    return null;
  }});
  t.after(async()=>{await server.close();db.close()});
  return (method,url,payload,headers={})=>server.inject({method,url,payload,headers:{authorization:'user-a',...headers}});
}

test('without a model the full HTTP lifecycle works; auth, origin and parameter ambiguity are rejected',async t=>{
  const call=api(t);
  assert.equal((await call('GET','/orders',undefined,{authorization:'none'})).statusCode,401);
  assert.equal((await call('POST','/orders',{item:'A'},{origin:'https://different.invalid'})).statusCode,403);
  assert.equal((await call('POST','/_aw/assistant/messages',{message:'hello'})).json().error.code,'AI_DISABLED');
  const {result:{orderId}}=(await call('POST','/orders',{item:'笔记本'})).json();
  assert.equal((await call('POST',`/orders/${orderId}/cancel`,{orderId:'other'})).json().error.code,'DUPLICATE_INPUT');
  const proposal=await call('POST',`/orders/${orderId}/cancel`); assert.equal(proposal.statusCode,202);
  const addr=`/_aw/invocations/${proposal.json().id}`;
  assert.equal((await call('GET',addr,undefined,{authorization:'user-b'})).statusCode,404);
  assert.equal((await call('POST',addr+'/confirm',{confirmed:true})).statusCode,400);
  assert.equal((await call('POST',addr+'/confirm')).json().result.status,'cancelled');
  assert.equal((await call('GET',addr)).json().status,'succeeded');
});

test('a model cannot call an HTTP-only action; a shipping race wins over an older AI confirmation',async t=>{
  let orderId;
  const call=api(t,{label:'contract test',async decide({tools,history}) {
    assert.ok(!tools.some(x=>x.name==='orders.ship'));
    if (history.at(-1).role==='tool') {
      assert.match(history.at(-1).error,/NOT_FOUND/);
      return {type:'call',name:'orders.cancel',args:{orderId}};
    }
    return {type:'call',name:'orders.ship',args:{orderId}};
  }});
  ({result:{orderId}}=(await call('POST','/orders',{item:'铅笔'})).json());
  const chat=(await call('POST','/_aw/assistant/messages',{message:'取消订单'})).json();
  assert.equal(chat.invocation.action,'orders.cancel');
  assert.equal((await call('POST','/_aw/assistant/messages',{conversationId:chat.conversationId,message:'继续'}, {authorization:'user-b'})).statusCode,404);
  assert.equal((await call('GET','/orders')).json().result[0].status,'placed');
  assert.equal((await call('POST',`/orders/${orderId}/ship`)).json().result.status,'shipped');
  const res=await call('POST',`/_aw/invocations/${chat.invocation.id}/confirm`);
  assert.equal(res.statusCode,409); assert.equal(res.json().error.code,'ORDER_ALREADY_SHIPPED');
  assert.equal((await call('GET','/orders')).json().result[0].status,'shipped');
});

test('a second module supports submit over HTTP, withdraw by assistant and read back the same state',async t=>{
  let id;
  const call=api(t,{label:'contract test',async decide(){return {type:'call',name:'expenses.withdraw',args:{id}}}});
  ({result:{id}}=(await call('POST','/expenses',{title:'差旅',amount:'9.21'})).json());
  const sub=(await call('POST',`/expenses/${id}/submit`)).json();
  assert.equal((await call('POST',`/_aw/invocations/${sub.id}/confirm`)).json().result.status,'已提交');
  const chat=(await call('POST','/_aw/assistant/messages',{message:'撤回申请'})).json();
  assert.equal(chat.invocation.status,'pending');
  assert.equal((await call('POST',`/_aw/invocations/${chat.invocation.id}/confirm`)).json().result.status,'草稿');
  assert.equal((await call('GET','/expenses')).json().result[0].amount,'9.21');
});
