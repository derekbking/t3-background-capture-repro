const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

// A new process and throwaway profile; never opens an installed application's data.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-repro-'));
app.setName('Background Capture Repro');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const output = path.join(__dirname, 'evidence');
fs.mkdirSync(output, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = async (work, ms) => {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Observation deadline: ${ms} ms`)), ms);
  })]); } finally { clearTimeout(timer); }
};
const evidence = {
  kind: 'Isolated Electron reproduction; not a full T3 provider/MCP test',
  environment: { platform: process.platform, arch: process.arch,
    electron: process.versions.electron, chromium: process.versions.chrome },
};
let win;
const host = expression => win.webContents.executeJavaScript(expression);
const frames = () => host('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
const place = async offscreen => {
  await host(`Object.assign(document.querySelector('#guest').style, {left:'${offscreen ? '-100000' : '0'}px',top:'${offscreen ? '-100000' : '0'}px'})`);
  await frames();
};
const show = async data => { await host(`window.report(${JSON.stringify(data)})`); await frames(); };
const saveWindow = async name => {
  win.setContentSize(560, Math.ceil(await host("document.querySelector('#surface').getBoundingClientRect().height")));
  await frames();
  fs.writeFileSync(path.join(output, name), (await bounded(win.capturePage(), 8000)).toPNG());
};

async function run(guest) {
  guest.setBackgroundThrottling(false);
  guest.debugger.attach('1.3');
  const evaluate = async expression => (await guest.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  const state = () => evaluate(`({draft:document.querySelector('#draft').value, counter:document.querySelector('#counter').textContent, session:sessionStorage.getItem('test'), timeOrigin:performance.timeOrigin})`);
  const cdpCapture = () => guest.debugger.sendCommand('Page.captureScreenshot', { format: 'png' });

  await place(false);
  const controlStart = performance.now();
  await bounded(cdpCapture(), 8000);
  evidence.paintableControlMs = performance.now() - controlStart;
  await place(true);
  await evaluate(`document.querySelector('#counter').textContent='1';document.querySelector('#draft').value='unsaved sample';`);
  const beforeState = await state();
  const domStart = performance.now();
  await evaluate('document.body.innerText');
  evidence.offscreenDomReadMs = performance.now() - domStart;

  let settled = false, queuedRan = false;
  const started = performance.now();
  const pending = cdpCapture().finally(() => { settled = true; });
  const queued = pending.then(() => { queuedRan = true; });
  // Attach a handler immediately; failure must not create an unhandled rejection.
  queued.catch(() => {});
  await pause(15000);
  evidence.before = { observationMs: performance.now() - started, capturePending: !settled, queuedActionRan: queuedRan };
  await show({heading: settled ? 'Capture completed on this platform' : 'Before · capture stalls', rows:[['Guest position','Fully offscreen'],['DOM read',`${evidence.offscreenDomReadMs.toFixed(1)} ms`],['Screenshot',settled?'Completed':'Still pending after 15 s'],['Next queued action',queuedRan?'Ran':'Waiting']],note:'Standalone Electron with a serial Promise queue. This measures the capture mechanism.'});
  await saveWindow('before.png');
  if (settled) throw new Error('Offscreen stall did not reproduce; do not report this run as a failure reproduction.');

  // Release the old request before testing the repair, then return offscreen.
  await place(false);
  await bounded(queued, 8000);
  evidence.releasedAfterPaintableMs = performance.now() - started;
  await place(true);

  const samples = [];
  let lastImage;
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    try {
      // Temporary rendering lease: prepare a frame before native capture.
      await bounded(place(false), 2000);
      lastImage = await bounded(guest.capturePage(undefined, {stayHidden:true, stayAwake:true}), 8000);
      assert.equal(lastImage.isEmpty(), false);
    } finally { await place(true); }
    samples.push(performance.now() - start);
  }
  const afterState = await state();
  assert.deepEqual(afterState, beforeState);
  evidence.after = { captures: samples.length, elapsedMs: samples, statePreserved: true,
    guestReturnedOffscreen: await host("document.querySelector('#guest').style.left === '-100000px'"),
    pngPixels: lastImage.getSize() };
  assert.equal(evidence.after.guestReturnedOffscreen, true);
  fs.writeFileSync(path.join(output, 'captured-fixture.png'), lastImage.toPNG());
  await show({heading:'After · capture completes', rows:[['Starting / final position','Fully offscreen'],['Rendering + native capture',`${Math.min(...samples).toFixed(0)}–${Math.max(...samples).toFixed(0)} ms · 5/5`],['Draft / session / document','Preserved']],note:'Actual returned PNG below. Full T3/MCP integration remains a separate check.',pass:true,image:lastImage.toDataURL()});
  await saveWindow('after.png');
  evidence.status = 'reproduced';
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(evidence, null, 2)+'\n');
  console.log(JSON.stringify(evidence));
}

app.whenReady().then(() => {
  win = new BrowserWindow({width:560,height:560,useContentSize:true,title:'Background Capture Repro',webPreferences:{webviewTag:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  win.webContents.once('did-attach-webview', (_, guest) => guest.once('did-finish-load', () => {
    run(guest).catch(error => {
      evidence.status = 'incomplete'; evidence.error = error.message;
      fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(evidence,null,2)+'\n');
      console.error(error.message); process.exitCode = 1;
    }).finally(() => app.quit());
  }));
  return win.loadFile(path.join(__dirname, 'window.html'));
});
app.on('window-all-closed', () => app.quit());
app.on('quit', () => fs.rmSync(profile, {recursive:true,force:true}));
