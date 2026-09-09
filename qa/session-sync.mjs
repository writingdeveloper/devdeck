// Real host + two viewers, isolated profiles, fixture CLI, real TLS and real title controls.
// Never starts a paid provider or modifies the user's projects, pairings, or installed application.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { closeElectron } from './electron-lifecycle.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sandbox = mkdtempSync(join(tmpdir(), 'devdeck-session-sync-'));
const repo = join(sandbox, 'release-workspace');
const bin = join(sandbox, 'bin');
const out = resolve(process.env.DEVDECK_SYNC_OUT || join(root, 'qa/shots/session-sync'));
for (const p of [repo, bin, out]) mkdirSync(p, {recursive:true});
execFileSync('git', ['init','-q','-b','qa-sync'], {cwd:repo});
for (const name of ['claude','codex','antigravity']) writeFileSync(join(bin,name+'.cmd'), '@echo off\r\necho DEVDECK_SYNC_FIXTURE_READY\r\n');
const nodes=[]; const passed=[]; const errors=[];
async function launch(name, reuse) {
  const profile=reuse?.profile ?? join(sandbox,name); mkdirSync(profile,{recursive:true});
  const home=join(profile,'home'); mkdirSync(home,{recursive:true});
  if(!reuse) writeFileSync(join(profile,'state.json'), JSON.stringify({projects:{},settings:{language:'en',machineName:name,folders:[{path:repo,kind:'repo'}],viewMode:'list'}}));
  const env={...process.env,HOME:home,USERPROFILE:home,CLAUDECODE:'',CLAUDE_CODE_SSE_PORT:'',CLAUDE_CODE_ENTRYPOINT:''};
  const pathKey=Object.keys(env).find(k=>k.toLowerCase()==='path')||'PATH'; env[pathKey]=bin+';'+env[pathKey];
  const executablePath=process.env.DEVDECK_EXECUTABLE;
  const app=await electron.launch({...(executablePath?{executablePath:resolve(executablePath)}:{}),args:[...(executablePath?[]:['.']),'--user-data-dir='+profile,'--no-sandbox','--disable-gpu'],cwd:root,env});
  const n={name,profile,app,win:await app.firstWindow()}; nodes.push(n);
  n.win.setDefaultTimeout(10000); n.win.on('pageerror',e=>errors.push(name+': '+String(e)));
  await n.win.waitForSelector('#cards .prow, #cards .card',{state:'attached',timeout:30000});
  // Fixture-only stub: no router port mappings are opened by this test.
  await app.evaluate(({app})=>{
    const require=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json');
    require(app.getAppPath()+'/dist/main/link/portMap.js').mapPort=async()=>({state:'not-found'});
  });
  return n;
}
async function stop(n){ if(n.app){ const a=n.app; n.app=null; await closeElectron(a); } }
async function check(name,fn){await fn(); passed.push(name); console.log('PASS '+name);}
async function freePort(){return new Promise((res,rej)=>{const s=createServer();s.on('error',rej);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>res(p));});});}
async function pair(host,viewer){
  const status=await host.win.evaluate(()=>window.devdeck.link.createInvite(['observe','control','spawn','write']));
  assert.ok(status.listening); assert.ok(status.invite?.code);
  const added=await viewer.win.evaluate(code=>window.devdeck.link.addMachine(code),status.invite.code); assert.equal(added.ok,true);
  await viewer.win.waitForSelector('#shell-session-groups .shell-session');
  await viewer.win.locator('#shell-session-groups .shell-session').first().click();
  return status.machineId;
}
async function rename(n,title){
  await n.win.locator('#ck-header button[title="Rename"]').click();
  const input=n.win.locator('#ck-header .ck-rename-input'); await input.fill(title); await input.press('Enter');
  await input.waitFor({state:'detached'});
}
async function expectTitle(n,title){
  await n.win.waitForFunction(title=>document.querySelector('#ck-header')?.textContent.includes(title) && [...document.querySelectorAll('#shell-session-groups .shell-session')].some(e=>e.textContent.includes(title)),title,{timeout:8000});
  const saved=await n.win.evaluate(()=>window.devdeck.cockpit.loadSessions());
  assert.ok(saved.some(s=>s.label===title), n.name+' persisted label');
  const until=Date.now()+5000;
  while(Date.now()<until){
    const disk=JSON.parse(readFileSync(join(n.profile,'state.json'),'utf8'));
    if(disk.settings?.cockpitSessions?.some(s=>s.label===title)) return;
    await new Promise(r=>setTimeout(r,25));
  }
  assert.fail(n.name+' on-disk title did not converge');
}
try {
  if(process.platform!=='win32') {console.log('SKIP: Windows native PTY required');}
  else {
    const host=await launch('Build workstation');
    await host.win.locator('#cards .provider-open-primary').first().click();
    await host.win.waitForFunction(()=>document.querySelector('.ck-term.show')?.textContent.includes('DEVDECK_SYNC_FIXTURE_READY'));
    await host.win.evaluate(p=>window.devdeck.link.setPort(p),await freePort());
    let viewer=await launch('Review laptop'); const machine=await pair(host,viewer);
    const other=await launch('QA viewer'); await pair(host,other);
    await check('viewer rename converges on host and both viewer screens and saved lists',async()=>{
      await rename(viewer,'Release checklist');
      for(const n of [host,viewer,other]) await expectTitle(n,'Release checklist');
    });
    await check('host rename converges without remounting terminals',async()=>{
      for(const n of [host,viewer,other]) await n.win.evaluate(()=>{globalThis.qaTerm=document.querySelector('.ck-term.show');});
      await rename(host,'Shipping build');
      for(const n of [host,viewer,other]){await expectTitle(n,'Shipping build'); assert.equal(await n.win.evaluate(()=>globalThis.qaTerm===document.querySelector('.ck-term.show')),true);}
    });

    const editor=n=>n.win.locator('#ck-header .ck-rename-input');
    const startEdit=async(n,text)=>{await n.win.locator('#ck-header button[title="Rename"]').click();await editor(n).fill(text);};
    const ownerRename=async(n,text)=>n.win.evaluate(async text=>{
      const [m]=await window.devdeck.link.machines();
      const [s]=await window.devdeck.machine(m.machineId).cockpit.liveSessions();
      return window.devdeck.cockpit.renameSession(s.id,text,s);
    },text);
    await check('concurrent edits keep draft, reject stale save and Escape reveals current owner title',async()=>{
      await startEdit(viewer,'My unfinished title');
      assert.equal((await ownerRename(other,'Peer accepted title')).ok,true);
      await expectTitle(host,'Peer accepted title');
      assert.equal(await editor(viewer).inputValue(),'My unfinished title');
      await editor(viewer).press('Enter');
      await viewer.win.waitForFunction(()=>document.querySelector('#ck-header .ck-rename-status')?.textContent.includes('Another device'));
      assert.equal(await editor(viewer).inputValue(),'My unfinished title');
      await expectTitle(host,'Peer accepted title');
      await editor(viewer).press('Escape');
      await expectTitle(viewer,'Peer accepted title');
    });
    await check('host disk failure is returned to viewer, keeps draft and commits nowhere until retry',async()=>{
      await startEdit(viewer,'Retry after disk recovery');
      const temp=join(host.profile,'state.json.tmp'); mkdirSync(temp);
      try {
        await editor(viewer).press('Enter');
        await viewer.win.waitForFunction(()=>document.querySelector('#ck-header .ck-rename-input')?.getAttribute('aria-invalid')==='true');
        assert.equal(await editor(viewer).inputValue(),'Retry after disk recovery');
        const [running]=await host.win.evaluate(()=>window.devdeck.cockpit.liveSessions());
        assert.equal(running.label,'Peer accepted title');
        assert.ok(JSON.parse(readFileSync(join(host.profile,'state.json'),'utf8')).settings.cockpitSessions.some(s=>s.label==='Peer accepted title'));
      } finally {rmSync(temp,{recursive:true,force:true});}
      await editor(viewer).press('Enter'); await editor(viewer).waitFor({state:'detached'});
      for(const n of [host,viewer,other]) await expectTitle(n,'Retry after disk recovery');
    });
    await check('permission removal refuses rename at the originating UI and leaves host unchanged',async()=>{
      const who=await viewer.win.evaluate(()=>window.devdeck.link.hostStatus());
      const status=await host.win.evaluate(()=>window.devdeck.link.hostStatus());
      const device=status.devices.find(d=>d.machineId===who.machineId);assert.ok(device);
      await host.win.evaluate(fp=>window.devdeck.link.setDevicePermissions(fp,['observe']),device.fingerprint);
      await startEdit(viewer,'Not allowed');await editor(viewer).press('Enter');
      await viewer.win.waitForFunction(()=>document.querySelector('#ck-header .ck-rename-input')?.getAttribute('aria-invalid')==='true');
      assert.equal(await editor(viewer).inputValue(),'Not allowed');
      await expectTitle(host,'Retry after disk recovery');
      await editor(viewer).press('Escape');
      await host.win.evaluate(fp=>window.devdeck.link.setDevicePermissions(fp,['observe','control','spawn','write']),device.fingerprint);
    });
    await check('offline rename stays a draft; reconnect requires an explicit retry',async()=>{
      await startEdit(viewer,'Recovered network');
      await host.win.evaluate(()=>window.devdeck.link.setHostMode(false));
      await viewer.win.waitForFunction(async m=>(await window.devdeck.link.machines()).find(x=>x.machineId===m)?.state!=='connected',machine);
      await editor(viewer).press('Enter');
      await viewer.win.waitForFunction(()=>document.querySelector('#ck-header .ck-rename-input')?.getAttribute('aria-invalid')==='true');
      assert.equal(await editor(viewer).inputValue(),'Recovered network');
      await expectTitle(host,'Retry after disk recovery');
      await host.win.evaluate(()=>window.devdeck.link.setHostMode(true));
      await viewer.win.evaluate(m=>window.devdeck.link.reconnect(m),machine);
      await viewer.win.waitForFunction(async m=>(await window.devdeck.link.machines()).find(x=>x.machineId===m)?.state==='connected',machine);
      await editor(viewer).press('Enter');await editor(viewer).waitFor({state:'detached'});
      for(const n of [host,viewer,other]) await expectTitle(n,'Recovered network');
    });
    await check('explicit clear survives a viewer restart without publishing its stale cached title',async()=>{
      const profile=viewer.profile; await stop(viewer);
      await rename(host,'');
      const [cleared]=await host.win.evaluate(()=>window.devdeck.cockpit.liveSessions());assert.equal(cleared.label,null);
      const disk=JSON.parse(readFileSync(join(profile,'state.json'),'utf8'));
      assert.ok(disk.settings.cockpitSessions.some(s=>s.label==='Recovered network'),'viewer really holds old cache');
      viewer=await launch('Review laptop',{profile});
      await viewer.win.waitForSelector('#shell-session-groups .shell-session');
      await viewer.win.locator('#shell-session-groups .shell-session').first().click();
      await viewer.win.waitForFunction(()=>document.querySelector('#ck-header')?.textContent.includes('release-workspace'));
      const records=await viewer.win.evaluate(()=>window.devdeck.cockpit.loadSessions());
      assert.equal(records.filter(s=>s.machineId===machine).length,1, 'no duplicate Previous entry for an id-less live terminal');
      assert.ok(records.some(s=>s.machineId===machine && s.label===null));
      assert.equal((await host.win.evaluate(()=>window.devdeck.cockpit.liveSessions()))[0].label,null);
      await rename(viewer,'Restored connection');
      for(const n of [host,viewer,other]) await expectTitle(n,'Restored connection');
    });
    await check('repeated rename cycles converge across all clients with exactly one terminal per view',async()=>{
      for(let i=0;i<6;i++){
        const title='Converged '+i;
        await rename(i%2?host:viewer,title);
        for(const n of [host,viewer,other]){await expectTitle(n,title);assert.equal(await n.win.locator('.ck-term').count(),1);}
      }
    });
    assert.deepEqual(errors,[],'unexpected renderer errors');
    for(const n of [host,viewer,other]) await n.win.screenshot({path:join(out,n.name.replaceAll(' ','-')+'.png')});
  }
} catch(e) { errors.push(String(e)); for(const n of nodes) if(n.app) console.error(n.name, await n.win.evaluate(() => ({header:document.querySelector('#ck-header')?.textContent, input:document.querySelector('#ck-header input')?.value, status:document.querySelector('.ck-rename-status')?.textContent})).catch(()=>({}))); for(const n of nodes) if(n.app) await n.win.screenshot({path:join(out,n.name.replaceAll(' ','-')+'-failure.png')}).catch(()=>{}); throw e; }
finally {
  try {for(const n of [...nodes].reverse()) await stop(n);}
  finally {writeFileSync(join(out,'results.json'),JSON.stringify({passed,errors},null,2)); rmSync(sandbox,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
