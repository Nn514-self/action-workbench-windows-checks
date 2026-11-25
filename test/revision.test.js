import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createBackend } from 'action-workbench';
import { createAssistant } from 'action-workbench/assistant';
import { ordersModule } from '../starter/orders.ts';
const actor={id:'one',tenantId:'north',permissions:['orders:write','orders:read']};
function setup(t) { const db=new DatabaseSync(':memory:');t.after(()=>db.close());return createBackend({database:db,modules:[ordersModule(db)]}); }
const place=(type,item)=>({type,name:'orders.place',args:{item}});

test('a question may query without writing; a revision invalidates only the old proposal',async t=>{
  const api=setup(t), steps=[()=>place('call','铅笔'),turn=>{assert.deepEqual(turn.pending.input,{item:'铅笔'});return {type:'call',name:'orders.list',args:{}}},turn=>{assert.deepEqual(turn.history.at(-1).result,[]);return {type:'reply',text:'当前没有订单；准备新建铅笔订单。'}},()=>place('call','不应另起订单'),turn=>{assert.match(turn.history.at(-1).error,/REVIEW_PENDING/);return {type:'reply',text:'请先处理原提议。'}},()=>place('revise','钢笔')];
  const chat=createAssistant(api,{label:'contract',async decide(turn){return steps.shift()(turn)}});
  const first=await chat.say(actor,{message:'订铅笔'}), id=first.conversationId;
  const question=await chat.say(actor,{conversationId:id,message:'我已经有订单了吗？这笔是做什么的？'});
  assert.equal(question.type,'reply'); assert.deepEqual(question.pending,first.invocation);
  const still=await chat.say(actor,{conversationId:id,message:'看看原提议'}); assert.equal(still.pending.id,first.invocation.id);
  const next=await chat.say(actor,{conversationId:id,message:'改成钢笔'});assert.notEqual(first.invocation.id,next.invocation.id);
  assert.equal((await api.confirm(actor,first.invocation.id)).status,'cancelled');assert.deepEqual((await api.invoke(actor,'orders.list',{})).result,[]);
  assert.deepEqual(api.pending(actor).items.map(x=>x.id),[next.invocation.id]);
  assert.equal((await api.confirm(actor,next.invocation.id)).result.item,'钢笔');
});

test('revision is owner, tenant, permission, input, state and source bound',async t=>{
  const api=setup(t), p=await api.invoke(actor,'orders.place',{item:'纸'},{source:'ai'});
  for(const other of [{...actor,id:'two'},{...actor,tenantId:'south'},{...actor,permissions:['orders:read']}]) assert.throws(()=>api.revise(other,p.id,{item:'新'}),{code:'NOT_FOUND'});
  assert.throws(()=>api.revise(actor,p.id,{item:''}),{code:'INVALID_INPUT'});
  assert.deepEqual(api.revise(actor,p.id,{item:'纸'}),p);
  const existing=(await api.invoke(actor,'orders.place',{item:'胶带'})).result;
  const manual=await api.invoke(actor,'orders.cancel',{orderId:existing.orderId});assert.throws(()=>api.revise(actor,manual.id,{orderId:existing.orderId}),{code:'NOT_FOUND'});
  const sameTarget=await api.invoke(actor,'orders.cancel',{orderId:existing.orderId},{source:'ai'});
  const otherOrder=(await api.invoke(actor,'orders.place',{item:'闹钟'})).result;
  assert.throws(()=>api.revise(actor,sameTarget.id,{orderId:otherOrder.orderId}),{code:'REVISION_TARGET_CHANGED'});
  assert.deepEqual(api.status(actor,sameTarget.id).input,{orderId:existing.orderId});
  assert.equal(api.status(actor,p.id).status,'pending');
  t.mock.timers.enable({apis:['Date'],now:p.expiresAt});assert.throws(()=>api.revise(actor,p.id,{item:'新'}),{code:'PROPOSAL_CHANGED'});
  assert.deepEqual(api.pending(actor).items.filter(x=>x.action==='orders.place'),[]);
});

test('an independent confirmation wins while the model is preparing a revision; no second command is created',async t=>{
  const api=setup(t);let release, entered; const wait=new Promise(r=>release=r), ready=new Promise(r=>entered=r);
  const session=createAssistant(api,{label:'contract',async decide(turn){if(!turn.pending)return place('call','第一笔');entered();await wait;return place('revise','第二笔')}});
  const p=await session.say(actor,{message:'办理'});const racing=session.say(actor,{message:'修改',conversationId:p.conversationId});await ready;
  await api.confirm(actor,p.invocation.id);release();await assert.rejects(racing,{code:'PROPOSAL_CHANGED'});
  assert.deepEqual(api.pending(actor).items,[]);assert.deepEqual((await api.invoke(actor,'orders.list',{})).result.map(x=>x.item),['第一笔']);
});
