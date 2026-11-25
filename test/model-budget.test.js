import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTick} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {createBackend} from 'action-workbench';
import {createHttpServer} from 'action-workbench/http';
import {createAssistant} from 'action-workbench/assistant';
import {ordersModule} from '../starter/orders.ts';
const a={id:'one',tenantId:'north',permissions:['orders:write','orders:read']}, b={...a,tenantId:'south'};
const reply={type:'reply',text:'您好。'}, late={type:'call',name:'orders.place',args:{item:'过期意图'}};
function setup(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());return createBackend({database:db,modules:[ordersModule(db)]})}

test('a client cancellation cannot free a still-running provider slot or retain abandoned instructions',async t=>{
  const api=setup(t), gate=Promise.withResolvers(), gateB=Promise.withResolvers(), events=[];let count=0;
  const chat=createAssistant(api,{label:'contract',async decide(turn,signal){events.push({turn,signal});count++;return count===2?gate.promise:count===3?gateB.promise:reply}},{maxConcurrent:2,maxConcurrentPerUser:1});
  const first=await chat.say(a,{message:'开始'}), stop=new AbortController();
  const cancelled=assert.rejects(chat.say(a,{conversationId:first.conversationId,message:'已放弃的请求'},stop.signal),{code:'CHAT_CANCELLED'});
  await assert.rejects(chat.say(a,{message:'另一个对话'}),{status:429,code:'MODEL_BUSY'});
  const other=chat.say(b,{message:'独立租户同名用户'});
  await assert.rejects(chat.say({...a,id:'three'},{message:'实例已满'}),{status:429});
  stop.abort();await cancelled;assert.equal(events[1].signal.aborted,true);
  gateB.resolve(reply);await other;
  await assert.rejects(chat.say(a,{message:'提供方还没退出'}),{code:'MODEL_BUSY'});
  gate.resolve(late);await nextTick();assert.deepEqual(api.pending(a).items,[]);
  await chat.say(a,{message:'继续',conversationId:first.conversationId});assert.ok(!JSON.stringify(events.at(-1).turn).includes('已放弃的请求'));
});

test('whole-turn timeout aborts the adapter; a late model decision cannot create a proposal',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const api=setup(t), gate=Promise.withResolvers();let seen;
  const chat=createAssistant(api,{label:'contract',async decide(_turn,signal){seen=signal;return gate.promise}},{maxConcurrent:1,turnTimeoutMs:100});
  const rejected=assert.rejects(chat.say(a,{message:'查询'}),{status:504,code:'MODEL_TIMEOUT'});t.mock.timers.tick(100);await rejected;assert.equal(seen.aborted,true);
  await assert.rejects(chat.say(b,{message:'查询'}),{code:'MODEL_BUSY'});
  gate.resolve(late);await nextTick();assert.deepEqual(api.pending(a).items,[]);
});

test('HTTP disconnect reaches the provider; ordinary HTTP is available while model work is saturated',async t=>{
  const db=new DatabaseSync(':memory:'), api=createBackend({database:db,modules:[ordersModule(db)]});
  const entered=Promise.withResolvers(), stopped=Promise.withResolvers();
  const http=createHttpServer(api,{authenticate:()=>a,assistantLimits:{maxConcurrent:1,turnTimeoutMs:5000},provider:{label:'contract',async decide(_turn,signal){entered.resolve();signal.addEventListener('abort',()=>stopped.resolve(),{once:true});await stopped.promise;return late}}});
  t.after(async()=>{await http.close();db.close()});const url=await http.listen({host:'127.0.0.1',port:0}), ctrl=new AbortController();
  const request=fetch(url+'/_aw/assistant/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'读取'}),signal:ctrl.signal});
  await entered.promise;
  assert.equal((await http.inject({method:'POST',url:'/_aw/assistant/messages',payload:{message:'再问'}})).statusCode,429);
  assert.deepEqual((await http.inject({method:'GET',url:'/orders'})).json().result,[]);
  const aborted=assert.rejects(request,{name:'AbortError'});ctrl.abort();await aborted;await stopped.promise;await nextTick();
  assert.deepEqual(api.pending(a).items,[]);
});

test('oversized model decisions do not create proposals or consume a new session',async t=>{
  const api=setup(t);let large=true;
  const chat=createAssistant(api,{label:'contract',async decide(){return large?{...late,args:{item:'x'.repeat(20_000)}}:reply}});
  await assert.rejects(chat.say(a,{message:'检查'}),{code:'MODEL_RESPONSE_TOO_LARGE'});
  assert.deepEqual(api.pending(a).items,[]);large=false;assert.equal((await chat.say(a,{message:'继续'})).text,reply.text);
});
