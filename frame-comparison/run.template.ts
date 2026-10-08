import { app, BrowserWindow, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import * as Effect from 'effect/Effect';
import * as Stream from 'effect/Stream';
import * as Fiber from 'effect/Fiber';
import * as Two from '__T3_SOURCE__/apps/desktop/src/preview/DesktopBrowserHost.ts';
import * as Adaptive from './AdaptiveHost.ts';

const lab = '__LAB__';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 't3-frame-comparison-'));
app.setName('T3 Isolated Frame Comparison');
app.setPath('userData', profile); app.setPath('sessionData', profile);
const output = path.join(lab, 'results'); fs.mkdirSync(output,{recursive:true});
const results = {kind:'Real Electron guests through current DesktopBrowserHost; synthetic renderer/lease adapter, not full MCP/app', source:'7aaff447496ef8fdc3889dde9801ec3db8417754', electron:process.versions.electron,chrome:process.versions.chrome,platform:process.platform,arch:process.arch,records:[] as any[]};
const pause = (ms:number) => new Promise(r=>setTimeout(r,ms));
const limit = async <A>(p:Promise<A>, ms:number) => {let t;try{return await Promise.race([p,new Promise<never>((_,reject)=>{t=setTimeout(()=>reject(Error(`Harness deadline ${ms}ms`)),ms)})])}finally{clearTimeout(t)}};
const deferred = <A>() => Promise.withResolvers<A>();
let sequence=0;
let win:BrowserWindow, cover:BrowserWindow|undefined;
let current:any;
let imageCount=0;

async function runMode(mode:string, module:typeof Two) {
  win=new BrowserWindow({width:1300,height:900,show:false,title:'T3 isolated '+mode,webPreferences:{webviewTag:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const guestReady=deferred<Electron.WebContents>();
  win.webContents.once('did-attach-webview',(_,guest)=>guest.once('did-finish-load',()=>guestReady.resolve(guest)));
  await win.loadFile(path.join(lab,'window.html'));
  win.showInactive();
  const guest=await limit(guestReady.promise,8000);
  const rawNative=guest.capturePage.bind(guest);
  const rawCdp=guest.debugger.sendCommand.bind(guest.debugger);
  guest.capturePage=async (...args:any[])=>{
    const row=current;row?.native.push({start:performance.now()});const index=row?.native.length-1;
    try {const image=await rawNative(...args);if(row){row.native[index].end=performance.now();row.native[index].empty=image.isEmpty()}return image}
    catch(e){if(row)row.native[index].error=String(e);throw e}
  };
  guest.debugger.attach('1.3');
  guest.debugger.sendCommand=async (method,...args)=>{
    const row=current;if(method==='Page.captureScreenshot'&&row)row.cdpStart=performance.now();
    try {const value=await rawCdp(method,...args);if(method==='Page.captureScreenshot'&&row){row.cdpEnd=performance.now();row.cdpData=value.data}return value}
    catch(e){if(method==='Page.captureScreenshot'&&row)row.cdpError=String(e);throw e}
  };
  const host=await Effect.runPromise(module.make);
  const responses=new Map<number,ReturnType<typeof deferred<any>>>();
  let released=deferred<void>();
  const placement=async(active:boolean)=>{
    await win.webContents.executeJavaScript(`Object.assign(document.querySelector('#guest').style,{left:'${active?0:-100000}px',top:'${active?0:-100000}px'})`);
    if(active)await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  };
  const leases=Effect.runFork(host.captureRequests.pipe(Stream.runForEach(event=>Effect.promise(async()=>{
    if(event.active){await placement(true);current.leases++;host.acknowledgeCapture(event.requestId)}
    else {await placement(false);current.releases++;released.resolve()}
  }))));
  const replies=Effect.runFork(host.events.pipe(Stream.runForEach(line=>Effect.sync(()=>{
    const event=JSON.parse(new TextDecoder().decode(line));if(event.type==='cdp'){const reply=JSON.parse(event.message);responses.get(reply.id)?.resolve(reply)}
  }))));
  await pause(0);
  const key={threadId:'synthetic',tabId:'guest'};
  host.attach(key,{webContents:guest,debugger:guest.debugger,withCaptureActivity:capture=>Effect.acquireUseRelease(
    Effect.sync(()=>{win.webContents.setBackgroundThrottling(false);guest.setBackgroundThrottling(false)}),
    ()=>capture,
    ()=>Effect.sync(()=>{guest.setBackgroundThrottling(true);win.webContents.setBackgroundThrottling(true)})
  )});
  const evalGuest=async(expression:string)=>(await rawCdp('Runtime.evaluate',{expression,returnByValue:true})).result.value;
  for(const state of ['visible','covered','hidden','minimized']){
    if(win.isMinimized())win.restore();win.showInactive();
    if(state==='covered'){cover=new BrowserWindow({...win.getBounds(),show:false,frame:false,backgroundColor:'#fff'});await cover.loadURL('data:text/html,<title>Synthetic cover</title>');cover.showInactive();cover.moveTop()}
    if(state==='hidden')win.hide();
    if(state==='minimized'){win.minimize();for(let n=0;n<200&&!win.isMinimized();n++)await pause(10);assert.equal(win.isMinimized(),true)}
    for(const [width,height] of [[1280,800],[800,1280]])for(const zoom of [0.8,1.25])for(const scale of [0.5,1,2]){
      win.webContents.setBackgroundThrottling(false);
      await win.webContents.executeJavaScript(`Object.assign(document.querySelector('#guest').style,{width:'${width}px',height:'${height}px'})`);
      guest.setZoomFactor(zoom);
      for(const transition of ['mutation','reload']){
        if(transition==='reload'){const loaded=deferred<void>();guest.once('did-finish-load',()=>loaded.resolve());guest.reloadIgnoringCache();await limit(loaded.promise,8000)}
        const marker=++sequence;
        await evalGuest(`setMarker(${marker})`);
        const before=await evalGuest('probe()');
        const bounds=await win.webContents.executeJavaScript("document.querySelector('#guest').getBoundingClientRect().toJSON()");assert.equal(bounds.x,-100000);
        current={mode,state,width,height,zoom,scale,transition,marker,native:[],leases:0,releases:0};
        results.records.push(current);released=deferred<void>();
        const params={format:'png',clip:{x:0,y:0,width:width/zoom,height:height/zoom,scale},captureBeyondViewport:false};
        const reply=deferred<any>();responses.set(marker,reply);const start=performance.now();
        await Effect.runPromise(host.handleCommandLine(JSON.stringify({type:'cdp',...key,message:JSON.stringify({id:marker,method:'Page.captureScreenshot',params,sessionId:'t3-preview-page'})})));
        const response=await limit(reply.promise,11000);current.elapsedMs=performance.now()-start;
        await limit(released.promise,3000);responses.delete(marker);
        if(response.error){current.error=response.error.message;console.log(JSON.stringify({event:'failure',...current,cdpData:undefined}));
          const rescueStart=performance.now();await limit(rawNative(undefined,{stayHidden:true,stayAwake:false}),2000).catch(e=>{current.rescueError=String(e)});await pause(100);current.rescueCompletedCdp=Boolean(current.cdpEnd&&current.cdpEnd>=rescueStart);
        } else {
          const bytes=Buffer.from(response.result.data,'base64');const image=nativeImage.createFromBuffer(bytes);const size=image.getSize();const bitmap=image.toBitmap();
          let decoded=0;const samples=[];
          const pixel=(x:number)=>{const i=(5*size.width+x)*4;return [bitmap[i+2],bitmap[i+1],bitmap[i]]};
          let cellWidth=0;while(cellWidth<size.width&&pixel(cellWidth).every(v=>v>200))cellWidth++;
          current.cellWidth=cellWidth;assert(cellWidth>3&&cellWidth*18<size.width,'Invalid marker geometry');
          for(let bit=0;bit<16;bit++){const color=pixel(Math.floor(cellWidth*(bit+2.5)));samples.push(color);if(color.every(v=>v>200))decoded|=1<<bit;else assert(color.every(v=>v<55),'Unexpected marker color '+color)}
          current.imageSize=size;current.decodedMarker=decoded;current.markerSamples=samples;current.fresh=marker===decoded;
          const png=`${mode}-${marker}.png`;fs.writeFileSync(path.join(output,png),bytes);current.png=png;imageCount++;
        }
        const after=await evalGuest('probe()');current.preserved=JSON.stringify(before)===JSON.stringify(after);
        const afterBounds=await win.webContents.executeJavaScript("document.querySelector('#guest').getBoundingClientRect().toJSON()");current.restored=afterBounds.x===-100000&&afterBounds.y===-100000;
        current.windowPreserved=state==='hidden'?!win.isVisible():state==='minimized'?win.isMinimized():true;
        // Let diagnostic callbacks settle before the next separate capture. No pixels are requested here.
        await pause(0);
        delete current.cdpData;
        fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));
        if(current.error)throw Error('Capture failed; rescue recorded');
        assert.equal(current.fresh,true,JSON.stringify(current));assert.equal(current.preserved,true);assert.equal(current.restored,true);assert.equal(current.windowPreserved,true);assert.equal(current.leases,current.releases);
      }
    }
    console.log(JSON.stringify({event:'state-complete',mode,state,count:results.records.filter(r=>r.mode===mode&&r.state===state).length,maxNative:Math.max(...results.records.filter(r=>r.mode===mode&&r.state===state).map(r=>r.native.length))}));
    if(cover){cover.destroy();cover=undefined}
  }
  host.detach(key);await Effect.runPromise(Fiber.interrupt(leases));await Effect.runPromise(Fiber.interrupt(replies));win.destroy();
}
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{await runMode('two',Two);await runMode('adaptive',Adaptive);console.log(JSON.stringify({event:'complete',captures:imageCount}));}).catch(e=>{results.error=String(e);console.error(e);process.exitCode=1}).finally(()=>{fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));app.exit(process.exitCode===1?1:0)});
app.on('quit',()=>fs.rmSync(profile,{recursive:true,force:true}));
