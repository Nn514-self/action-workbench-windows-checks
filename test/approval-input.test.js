import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { createBackend, defineModule, command } from 'action-workbench';

test('confirmation binds the original wire input, normalizing it like direct HTTP input',async t=>{
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close());
  const actor={id:'rider',tenantId:'t',permissions:['reserve']};
  const api=createBackend({database:db,modules:[defineModule('booking',{seats:command({
    description:'预订席位，以分返回费用',permission:'reserve',http:{method:'POST',path:'/reserve'},ai:true,confirmation:'none',
    input:z.strictObject({seats:z.string().regex(/^[1-9]$/).transform(Number)}),output:z.int(),run:(_ctx,{seats})=>seats*500,
  })})]});
  const args={seats:'3'};
  const p=await api.invoke(actor,'booking.seats',args,{source:'ai'}); args.seats='8'; p.input.seats='7';
  assert.equal((await api.confirm(actor,p.id)).result,1500);
  assert.equal((await api.invoke(actor,'booking.seats',{seats:'3'})).result,1500);
});
