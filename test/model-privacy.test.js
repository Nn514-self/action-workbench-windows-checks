import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {ActionError,createBackend,defineModule,query,command} from 'action-workbench';
import {createAssistant} from 'action-workbench/assistant';

const actor={id:'ann',tenantId:'north',permissions:['account']};
const out=z.strictObject({name:z.string(),billing:z.strictObject({plan:z.string(),note:z.string()})});
const view=z.object({name:z.string(),billing:z.object({plan:z.string()})});
const full={name:'Ann',billing:{plan:'standard',note:'staff-only billing note'}}, visible={name:'Ann',billing:{plan:'standard'}};
const base={description:'账户概要',permission:'account',ai:true,input:z.strictObject({}),output:out,run:()=>full};
const done={type:'reply',text:'已核对。'};
function app(t,actions){const db=new DatabaseSync(':memory:');t.after(()=>db.close());return createBackend({database:db,modules:[defineModule('accounts',actions)]})}

test('public HTTP result and durable receipt keep full detail; provider gets only nested allowlisted fields',async t=>{
  const api=app(t,{get:query({...base,http:{method:'GET',path:'/account'},modelOutput:view}),save:command({...base,http:{method:'POST',path:'/account'},modelOutput:view})});
  assert.deepEqual((await api.invoke(actor,'accounts.get',{})).result,full);
  assert.deepEqual((await api.invoke(actor,'accounts.get',{},{source:'ai'})).result,visible);
  const turns=[];const decisions=[{type:'call',name:'accounts.get',args:{}},done,{type:'call',name:'accounts.save',args:{}},done];
  const chat=createAssistant(api,{label:'contract',async decide(turn){turns.push(turn);return decisions.shift()}});
  const first=await chat.say(actor,{message:'查询账户'});assert.deepEqual(turns[1].history.at(-1).result,visible);
  const p=await chat.say(actor,{message:'保存',conversationId:first.conversationId});
  assert.deepEqual((await api.confirm(actor,p.invocation.id)).result,full);assert.deepEqual(api.status(actor,p.invocation.id).result,full);
  await chat.say(actor,{message:'办完了吗？',conversationId:first.conversationId});
  assert.deepEqual(turns.at(-1).history.at(-2).result,{status:'succeeded',result:visible});
  assert.ok(!JSON.stringify(turns).includes(full.billing.note));
  assert.throws(()=>api.status({...actor,tenantId:'south'},p.invocation.id,'ai'),{code:'NOT_FOUND'});
});

test('a missing view, a schema mismatch, a private rejection or oversized result never falls back to raw model data',async t=>{
  assert.throws(()=>query({...base,http:{method:'GET',path:'/account'}}),/modelOutput/);
  const invalid=z.object({absent:z.string()});const api=app(t,{
    bad:query({...base,http:{method:'GET',path:'/bad'},modelOutput:invalid}),
    rejected:query({...base,http:{method:'GET',path:'/declined'},modelOutput:view,run(){throw new ActionError(409,'ACCOUNT_CLOSED',full.billing.note)}}),
    large:query({...base,http:{method:'GET',path:'/large'},output:z.string(),modelOutput:z.string(),run:()=> 'large-data-'.repeat(1800)}),
    save:command({...base,http:{method:'POST',path:'/save'}}),mismatch:command({...base,http:{method:'POST',path:'/mismatch'},modelOutput:invalid}),
  });
  for(const [name,code] of [['bad','MODEL_VIEW_UNAVAILABLE'],['rejected','ACTION_REJECTED'],['large','MODEL_RESULT_TOO_LARGE']]){
    const turns=[];const chat=createAssistant(api,{label:'contract',async decide(turn){turns.push(turn);return turns.length===1?{type:'call',name:'accounts.'+name,args:{}}:done}});
    await chat.say(actor,{message:'读取'});assert.equal(turns[1].history.at(-1).error,code);assert.ok(!JSON.stringify(turns).includes(full.billing.note));assert.ok(!JSON.stringify(turns).includes('large-data-'));
  }
  for(const name of ['save','mismatch']){
    const options={source:'ai',idempotencyKey:name}, p=await api.invoke(actor,'accounts.'+name,{},options);await api.confirm(actor,p.id);
    assert.deepEqual(await api.invoke(actor,'accounts.'+name,{},options),{id:p.id,action:'accounts.'+name,status:'succeeded'});
    assert.deepEqual(api.status(actor,p.id,'ai'),{id:p.id,action:'accounts.'+name,status:'succeeded'});assert.deepEqual(api.status(actor,p.id).result,full);
  }
  const manual=await api.invoke(actor,'accounts.save',{});assert.throws(()=>api.status(actor,manual.id,'ai'),{code:'NOT_FOUND'});
});

test('an upgraded command cannot share an old receipt under its new model view',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const open=(version,modelOutput)=>createBackend({database:db,modules:[defineModule('accounts',{save:command({...base,version,modelOutput,http:{method:'POST',path:'/account'}})})]});
  const v1=open(1,view), proposal=await v1.invoke(actor,'accounts.save',{},{source:'ai'});await v1.confirm(actor,proposal.id);
  const v2=open(2,out);assert.deepEqual(v2.status(actor,proposal.id,'ai'),{id:proposal.id,action:'accounts.save',status:'succeeded'});assert.deepEqual(v2.status(actor,proposal.id).result,full);
});
