import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createBackend} from 'action-workbench';
import {createHttpServer} from 'action-workbench/http';
import {ordersModule} from '../starter/orders.ts';

test('cookie-bearing writes need an explicitly configured, matching origin; malformed identities and sources fail closed',async t=>{
  const db=new DatabaseSync(':memory:'), api=createBackend({database:db,modules:[ordersModule(db)]});
  const actor={id:'member',tenantId:'org',permissions:['orders:write','orders:read']}, allowed='https://app.example';
  const authenticate=req=>req.headers.cookie==='account=member'?actor:null;
  const locked=createHttpServer(api,{authenticate}), same=createHttpServer(api,{authenticate,allowedOrigin:allowed});
  t.after(async()=>{await locked.close();await same.close();db.close()});
  const place=(http,origin)=>http.inject({method:'POST',url:'/orders',headers:{cookie:'account=member',...(origin?{origin}:{})},payload:{item:'纸'}});
  assert.equal((await place(locked,allowed)).statusCode,403);assert.equal((await place(same)).statusCode,403);assert.equal((await place(same,'https://other.example')).statusCode,403);
  assert.deepEqual((await api.invoke(actor,'orders.list',{})).result,[]);assert.equal((await place(same,allowed)).statusCode,200);
  assert.throws(()=>createHttpServer(api,{authenticate,allowedOrigin:'null'}),/exact/);
  for(const bad of [{...actor,tenantId:17},{...actor,id:' '},{...actor,permissions:[false]}]) await assert.rejects(api.invoke(bad,'orders.list',{}),{code:'UNAUTHENTICATED'});
  await assert.rejects(api.invoke(actor,'orders.place',{item:'额外'},{source:'unset'}),{code:'NOT_FOUND'});
});
