import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,watch,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {localCodex} from 'action-workbench/codex';

// The normal framework tests cover business decisions. This one crosses the Win32 executable boundary.
test('Windows adapter passes UTF-8 and spaced arguments, rejects shell wrappers and closes its child on cancellation', {skip:process.platform!=='win32',timeout:45_000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'业务 工具-')), home=join(dir,'home'), exe=join(dir,'适配 验收.exe');
  const oldHome=process.env.CODEX_HOME;
  try {
    mkdirSync(home);process.env.CODEX_HOME=home;
    for(const ext of ['cmd','ps1']) {
      const wrapper=join(dir,'codex.'+ext);writeFileSync(wrapper,'');assert.equal(localCodex({bin:wrapper}),null);
    }
    const compiler=join(process.env.SystemRoot,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
    execFileSync(compiler,['/nologo','/codepage:65001','/target:exe','/out:'+exe,fileURLToPath(new URL('./fixtures/windows-decision.cs',import.meta.url))],{timeout:20_000});
    const provider=localCodex({bin:exe,model:'验收 模型'});
    const turn=text=>({capabilities:[],tools:[],history:[{role:'user',text}],now:new Date().toISOString()});
    assert.deepEqual(await provider.decide(turn('查询运费')),{type:'reply',text:'运费八元'});
    const ready=Promise.withResolvers(), control=new AbortController(), marker=join(home,'started');
    const watcher=watch(home,(_,name)=>{if(name==='started' && existsSync(marker))ready.resolve()});
    const timer=setTimeout(()=>ready.reject(Error('Native child did not read its request')),10_000);
    const running=provider.decide(turn('等待取消'),control.signal);
    running.then(()=>ready.reject(Error('Native child returned before cancellation')),ready.reject);
    try {
      await ready.promise;const childWork=readFileSync(marker,'utf8');assert.ok(existsSync(childWork));
      const reason=Error('user cancelled');control.abort(reason);
      await assert.rejects(running,e=>e===reason);
      assert.ok(!existsSync(childWork),'Native child still holds its temporary working directory');
    } finally {clearTimeout(timer);watcher.close();control.abort();await running.catch(()=>{});}
  } finally {
    if(oldHome===undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME=oldHome;
    rmSync(dir,{recursive:true,force:true,maxRetries:3});
  }
});
