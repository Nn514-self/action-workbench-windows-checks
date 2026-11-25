import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {release,tmpdir} from 'node:os';
import {basename,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline';

const root=fileURLToPath(new URL('../',import.meta.url));
const json=(dir,file='package.json')=>JSON.parse(readFileSync(join(dir,file),'utf8'));
const manifest=json(root), example=join(root,'example','meeting-rooms');
const baseline=join(root,'action-workbench-0.4.0.tgz');
const baselineIntegrity='sha512-R9+VbEaL82AuL2lDoVNh4tqtPTS7JzooKVhUm94TQ7qtaZ1+EgSW0rLkZoJgBkgLWh+zRIjF5lj1OC4+uFPTuQ==';
const digest=file=>'sha512-'+createHash('sha512').update(readFileSync(file)).digest('base64');
const install=['install','--engine-strict','--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org'];
function npm(cwd,...args){
  if(!process.env.npm_execpath) throw Error('Run compatibility checks via npm run.');
  return execFileSync(process.execPath,[process.env.npm_execpath,...args],{cwd,stdio:['ignore','pipe','inherit'],timeout:180_000,encoding:'utf8'});
}
function installArchive(dir,archive){
  mkdirSync(dir);writeFileSync(join(dir,'package.json'),JSON.stringify({name:'compat-consumer',private:true,type:'module'}));
  npm(dir,...install,archive);
  return join(dir,'node_modules',manifest.name);
}
function verifyFiles(pkg,reference){
  for(const file of [...manifest.files,'package.json','README.md',...(existsSync(join(reference,'LICENSE'))?['LICENSE']:[])]) {
    assert.ok(readFileSync(join(pkg,file)).equals(readFileSync(join(reference,file))),`Candidate differs from ${file}`);
  }
}
// Run old code in its own process with its own dependency tree. Never synthesize journal rows.
function seedLegacy(legacy,store){
  const pkg=installArchive(legacy,baseline);assert.equal(json(pkg).version,'0.4.0');
  copyFileSync(join(pkg,'starter','orders.ts'),join(legacy,'orders.ts'));
  const output=execFileSync(process.execPath,['--input-type=module','-e',`
    import {DatabaseSync} from 'node:sqlite';import {createBackend} from 'action-workbench';import {ordersModule} from './orders.ts';
    const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA journal_mode=WAL');
    try {const api=createBackend({database:db,modules:[ordersModule(db)]});
      const actor={id:'developer',tenantId:'local',permissions:['orders:write','orders:read']};
      const order=await api.invoke(actor,'orders.place',{item:'升级前的订单'},{idempotencyKey:'compat-before-upgrade'});
      const proposal=await api.invoke(actor,'orders.cancel',{orderId:order.result.orderId},{source:'ai'});
      console.log(JSON.stringify({order,proposal}));
    } finally {db.close();}`,join(store,'product.sqlite')],{cwd:legacy,encoding:'utf8',stdio:['ignore','pipe','inherit'],timeout:30_000});
  const seeded=JSON.parse(output);assert.equal(seeded.order.status,'succeeded');assert.equal(seeded.proposal.status,'pending');return seeded;
}
async function withStarter(cwd,store,token,check){
  const env={...process.env,PORT:'0',WORKBENCH_TOKEN:token,ACTION_DATA_DIR:store,CODEX_BIN:join(store,'not-installed.exe')};
  const child=spawn(process.execPath,['server.ts','--ai'],{cwd,env,stdio:['ignore','pipe','inherit']});
  const ready=Promise.withResolvers(), closed=Promise.withResolvers();
  const lines=createInterface({input:child.stdout});lines.on('line',line=>{const match=/^Business API: (http:\/\/127\.0\.0\.1:\d+) \|/.exec(line);if(match)ready.resolve(match[1]);});
  child.once('error',e=>ready.reject(e));child.once('close',(code,signal)=>{closed.resolve();ready.reject(Error(`Starter stopped before ready: ${code ?? signal}`));});
  const timer=setTimeout(()=>ready.reject(Error('Starter did not bind a loopback port')),20_000);
  try {const url=await ready.promise;clearTimeout(timer);await check(url);}
  finally {clearTimeout(timer);if(child.exitCode===null && child.signalCode===null) child.kill('SIGTERM');
    const force=setTimeout(()=>child.kill('SIGKILL'),3000);try {await closed.promise;} finally {clearTimeout(force);lines.close();}}
}
async function exercise(product,store,{order,proposal}){
  const token=randomBytes(32).toString('hex');
  await withStarter(product,store,token,async url=>{
    async function api(method,path,status,body,extra={}){
      const r=await fetch(url+path,{method,headers:{authorization:'Bearer '+token,'connection':'close',...(body?{'content-type':'application/json'}:{}),...extra},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
      const data=await r.json();assert.equal(r.status,status,`${method} ${path}: ${r.status} ${data.error?.code ?? ''}`);return data;
    }
    await api('GET','/orders',401,undefined,{authorization:'Bearer synthetic-wrong'});
    assert.equal((await api('POST','/_aw/assistant/messages',503,{message:'你好'})).error.code,'AI_DISABLED');
    assert.equal((await api('GET','/_aw/openapi.json',200)).info.version,manifest.version);
    assert.deepEqual((await api('GET','/orders',200)).result,[order.result]);
    assert.deepEqual(await api('POST','/orders',200,{item:'升级前的订单'},{'idempotency-key':'compat-before-upgrade'}),order);
    const pending=await api('GET','/_aw/invocations/pending',200);assert.equal(pending.items.length,1);assert.equal(pending.items[0].id,proposal.id);assert.equal(pending.items[0].source,'ai');
    const route=`/_aw/invocations/${proposal.id}/confirm`;const done=await api('POST',route,200);assert.equal(done.result.status,'cancelled');
    assert.deepEqual(await api('POST',route,200),done);assert.deepEqual((await api('GET','/_aw/invocations/pending',200)).items,[]);
    assert.equal((await api('POST','/orders',200,{item:'升级后的订单'})).result.status,'placed');
    const list=(await api('GET','/orders',200)).result;assert.equal(list.length,2);assert.equal(list.find(row=>row.orderId===order.result.orderId).status,'cancelled');
  });
}
function windowsScaffold(consumer,work,filename){
  // Exercise the installed .cmd shim for users whose PowerShell execution policy blocks npm.ps1.
  // No npm parent is present: this also exercises the CLI's fallback to the npm bundled with node.exe.
  const dest=join(work,'独立 PowerShell 项目');
  const env={...process.env,AW_TEST_CLI:join(consumer,'node_modules','.bin','create-action-backend.cmd'),AW_TEST_DEST:dest};
  for(const key of Object.keys(env)) if(key.toLowerCase()==='npm_execpath') delete env[key];
  const exe=join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  execFileSync(exe,['-NoLogo','-NoProfile','-NonInteractive','-Command','& $env:AW_TEST_CLI $env:AW_TEST_DEST; exit $LASTEXITCODE'],{cwd:consumer,env,timeout:60_000});
  assert.equal(json(dest).dependencies[manifest.name],`file:./${filename}`);assert.ok(existsSync(join(dest,filename)));
}
async function windowsRestart(product,store,seeded){
  const moved=store+' 已移动';renameSync(store,moved); // An open Windows database handle can block this move.
  const token=randomBytes(32).toString('hex');
  await withStarter(product,moved,token,async url=>{
    const r=await fetch(url+'/orders',{headers:{authorization:'Bearer '+token,connection:'close'},signal:AbortSignal.timeout(10000)});
    assert.equal(r.status,200);const {result}=await r.json();
    assert.equal(result.length,2);assert.equal(result.find(o=>o.orderId===seeded.order.result.orderId)?.status,'cancelled');
    assert.equal(result.find(o=>o.item==='升级后的订单')?.status,'placed');
  });
}
export async function checkCompatibility({archive,integrity,verifyBuild=false,audit=false}){
  assert.equal(digest(archive),integrity,'Candidate archive does not match approved SHA-512');
  assert.equal(digest(baseline),baselineIntegrity,'Legacy fixture bytes changed');
  const work=mkdtempSync(join(tmpdir(),'aw-compat-'));
  try {
    const consumer=join(work,'consumer'), product=join(work,'业务 backend'), store=join(work,'旧 数据');mkdirSync(store);
    const seeded=seedLegacy(join(work,'legacy'),store), installed=installArchive(consumer,archive);
    assert.deepEqual(json(installed).engines,manifest.engines);assert.equal(json(installed).version,manifest.version);
    if(verifyBuild) verifyFiles(installed,root);
    npm(consumer,'exec','--offline','--call','create-action-backend "../业务 backend"');
    const generated=json(product);assert.deepEqual(generated.engines,manifest.engines);assert.equal(generated.dependencies[manifest.name],`file:./${basename(archive)}`);
    npm(product,...install);npm(product,'run','check');verifyFiles(join(product,'node_modules',manifest.name),installed);
    if(audit) process.stdout.write(npm(product,'audit','--audit-level=low','--registry=https://registry.npmjs.org'));
    await exercise(product,store,seeded);
    let windows;
    if(process.platform==='win32'){
      windowsScaffold(consumer,work,basename(archive));await windowsRestart(product,store,seeded);
      windows={kernel:release(),powershellCmdShim:'passed',sqliteMoveAndRestart:'passed'};
    }
    console.log('COMPAT PASS '+JSON.stringify({os:process.platform,arch:process.arch,node:process.versions.node,npm:npm(consumer,'--version').trim(),from:'0.4.0',to:manifest.version,integrity,windows}));
  } finally {rmSync(work,{recursive:true,force:true,maxRetries:3});}
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const args=process.argv.slice(2);assert.ok(args.length===0 || args.length===1 && args[0]==='--verify-build','Usage: npm run compat:check [-- --verify-build]');
  const pinned=json(example,'package-lock.json').packages['node_modules/'+manifest.name], name=`${manifest.name}-${manifest.version}.tgz`;
  assert.equal(pinned.resolved,`file:${name}`);assert.equal(pinned.version,manifest.version);
  await checkCompatibility({archive:join(example,name),integrity:pinned.integrity,verifyBuild:args.includes('--verify-build')});
}
