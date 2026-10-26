import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const cdpPort = Number(process.env.CDP_PORT ?? 9224);
const serverPort = Number(process.env.SERVER_PORT ?? 8002);
const profileSuffix = process.env.PROFILE_SUFFIX ?? 'm4';
assert(/^[A-Za-z0-9_-]+$/.test(profileSuffix), 'PROFILE_SUFFIX contains unsupported characters');
const benchmarkMemoryBudgetBytes = 300_000_000;
const cdpUrl = `http://127.0.0.1:${cdpPort}`;
const pageUrl = `http://127.0.0.1:${serverPort}/tests/gpu-infinite-canvas.html`;
const result = {
  environment: { chromeVersion: null, pageVisibility: null, canvas: null, logicalProcessors: null, processorLoadPercent: null },
  functional: {},
  benchmark: [],
  benchmarkMemoryBudgetBytes,
  deviceLoss: { status: 'not-run' },
  artifacts: {},
  cleanup: { status: 'pending' },
  errors: []
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function percentile50(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

const targets = await (await fetch(`${cdpUrl}/json/list`)).json();
const page = targets.find(({ type, url }) => type === 'page' && url.includes('/tests/gpu-infinite-canvas.html'))
  ?? targets.find(({ type }) => type === 'page');
assert(page, `M3 target not found on CDP port ${cdpPort}`);

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  const resolve = pending.get(message.id);
  if (!resolve) return;
  pending.delete(message.id);
  resolve(message);
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP command timed out: ${method}`));
    }, 120000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 120000
  });
  if (response.result.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails.text);
  }
  return response.result.result.value;
}

async function waitFor(expression, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function waitForStableCounters() {
  let previous = await evaluate('({ renders: m3State.renderCount, uploads: m3Scene.getStats().snapshotUploadCount, paints: window.__m4PaintEvents.length })');
  let stableSamples = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const current = await evaluate('({ renders: m3State.renderCount, uploads: m3Scene.getStats().snapshotUploadCount, paints: window.__m4PaintEvents.length })');
    if (current.renders === previous.renders && current.uploads === previous.uploads && current.paints === previous.paints) stableSamples += 1;
    else stableSamples = 0;
    if (stableSamples >= 10) return;
    previous = current;
  }
  throw new Error('Initial paint activity did not settle');
}

async function snapshot() {
  return evaluate(`({
    status: document.querySelector('#status').textContent,
    errors: [...window.m3Errors],
    state: { ...window.m3State },
    stats: window.m3Scene.getStats(),
    camera: window.m3Scene.getCamera()
  })`);
}

async function simulateGpuProcessLoss() {
  const version = await (await fetch(`${cdpUrl}/json/version`)).json();
  const browserSocket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    browserSocket.addEventListener('open', resolve, { once: true });
    browserSocket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  browserSocket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    const resolve = pending.get(message.id);
    if (!resolve) return;
    pending.delete(message.id);
    resolve(message);
  });
  const sendBrowser = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, (message) => {
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
    });
    browserSocket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const { processInfo } = await sendBrowser('SystemInfo.getProcessInfo');
  const gpu = processInfo.find(({ type }) => type.toLowerCase() === 'gpu');
  assert(gpu && Number.isSafeInteger(gpu.id), 'Could not identify the browser GPU process');
  const versionNumber = version.Browser.match(/Chrome\/(\d+(?:\.\d+)+)/)?.[1];
  assert(versionNumber, `Unexpected browser version: ${version.Browser}`);
  const expectedProfile = `profile-canary-${versionNumber}-${profileSuffix}`;
  const command = `$gpu = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ${gpu.id} -and $_.Name -eq 'chrome.exe' -and $_.CommandLine -match '--type=gpu-process' -and $_.CommandLine -like '*${expectedProfile}*' }); if ($gpu.Count -ne 1) { throw 'GPU process is not uniquely bound to the isolated M4 profile.' }; Stop-Process -Id ${gpu.id} -Force`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { stdio: 'pipe' });
  try {
    await waitFor('window.m3State?.failed === true && window.m3Errors.length > 0', 'The page did not report the induced WebGPU process loss');
    let replacementGpu = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const info = await sendBrowser('SystemInfo.getProcessInfo');
      replacementGpu = info.processInfo.find(({ type }) => type.toLowerCase() === 'gpu');
      if (replacementGpu && replacementGpu.id !== gpu.id) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(replacementGpu && replacementGpu.id !== gpu.id, 'Chromium did not restart its GPU process');
    return { processType: gpu.type, processId: gpu.id, replacementProcessId: replacementGpu.id, expectedProfile, page: await snapshot() };
  } finally {
    browserSocket.close();
  }
}

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.bringToFront');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.navigate', { url: pageUrl });
  await waitFor('window.m3State?.ready === true && window.m3State?.failed === false', 'M3 page did not initialize');
  await send('Page.bringToFront');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await waitFor('window.m3Scene.getStats().allocatedSurfaceCount === 10', 'Initial 10 surface snapshots did not complete');
  await evaluate(`(() => {
    window.__m4Frames = [];
    const render = m3Scene.render.bind(m3Scene);
    m3Scene.render = () => { render(); window.__m4Frames.push(m3Scene.getStats().frame); };
  })()`);
  await evaluate(`(() => {
    const canvas = document.querySelector('#stage');
    window.__m4PaintEvents = [];
    canvas.addEventListener('paint', (event) => window.__m4PaintEvents.push((event.changedElements ?? []).map((element) => element.id)));
  })()`);
  await waitFor('window.m3Scene.getStats().allocatedSurfaceCount === 10', 'Initial 10 surface snapshots did not complete');
  await waitFor('window.m3Scene.getStats().frame.drawCount === 10', 'Initial 10 surface draw did not complete');

  const verificationScreenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await mkdir('.audit', { recursive: true });
  await writeFile('.audit/m4-browser.png', Buffer.from(verificationScreenshot.result.data, 'base64'));
  result.artifacts.screenshot = '.audit/m4-browser.png';
  const paintCountBeforeSettle = await evaluate('window.__m4PaintEvents.length');
  await evaluate('stage.requestPaint()');
  await waitFor(`window.__m4PaintEvents.slice(${paintCountBeforeSettle}).some((ids) => ids.includes('card-10'))`, 'Initial visible paint did not include card 10');
  await waitForStableCounters();
  await evaluate('window.__m4PaintEvents = []');
  const initial = await snapshot();
  assert(initial.stats.scene.visible === 10, `Expected 10 initially visible surfaces, got ${initial.stats.scene.visible}`);
  assert(initial.stats.snapshotUploadCount >= 10, `Expected at least 10 initial uploads, got ${initial.stats.snapshotUploadCount}`);
  result.environment.chromeVersion = (await (await fetch(`${cdpUrl}/json/version`)).json()).Browser;
  result.environment.pageVisibility = await evaluate('document.visibilityState');
  result.environment.canvas = await evaluate(`({ width: stage.width, height: stage.height, cssWidth: stage.clientWidth, cssHeight: stage.clientHeight, dpr: devicePixelRatio })`);
  result.environment.logicalProcessors = Number(process.env.LOGICAL_PROCESSORS ?? 0) || null;
  result.environment.processorLoadPercent = Number(process.env.PROCESSOR_LOAD_PERCENT ?? 0) || null;
  result.benchmarkClaim = 'Report CPU time through queue.submit and estimated RGBA8 texture bytes for 1, 10, 100, 500, and 1000 surfaces. Keep the 1000-surface estimate within 300,000,000 bytes. No speedup claim because this run has no pre-M4 baseline.';
  result.functional.initial = initial.stats;

  await evaluate('m3Scene.panBy(-2000, 0); m3Scene.render()');
  const culled = await snapshot();
  assert(culled.stats.scene.visible === 0 && culled.stats.frame.drawCount === 0, 'All offscreen surfaces must be culled');
  assert(culled.stats.gpu.estimatedBytes === initial.stats.gpu.estimatedBytes, 'Culling must preserve allocated texture bytes');
  result.functional.culling = culled.stats;

  const renderCountBeforeMutation = await evaluate('window.m3State.renderCount');
  const paintEventCountBeforeMutation = await evaluate('window.__m4PaintEvents.length');
  await evaluate(`(() => {
    const input = document.querySelector('#front-input');
    input.value = 'M4 offscreen update';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    stage.requestPaint();
  })()`);
  await waitFor(`window.__m4PaintEvents.slice(${paintEventCountBeforeMutation}).some((ids) => ids.includes('card-10'))`, 'Offscreen mutation did not produce a new paint event for card 10');
  await waitFor(`window.m3State.renderCount > ${renderCountBeforeMutation}`, 'Offscreen mutation render did not finish');
  const offscreenMutation = await snapshot();
  assert(offscreenMutation.stats.frame.uploadCount === 0, 'Offscreen mutation must not upload a snapshot');
  assert(offscreenMutation.stats.snapshotUploadCount === initial.stats.snapshotUploadCount, 'Offscreen mutation must defer cumulative uploads');
  result.functional.offscreenMutation = { paintEvents: await evaluate('window.__m4PaintEvents'), stats: offscreenMutation.stats };

  await evaluate('m3Scene.panBy(2000, 0); m3Scene.render()');
  const restored = await snapshot();
  assert(restored.stats.scene.visible === 10, 'Restored viewport should show all 10 surfaces');
  assert(restored.stats.frame.uploadCount === 1, `Returning the dirty surface should upload once, got ${restored.stats.frame.uploadCount}`);
  assert(restored.stats.snapshotUploadCount === initial.stats.snapshotUploadCount + 1, 'Returning the dirty surface should add one cumulative upload');
  result.functional.deferredUpload = restored.stats;

  await evaluate(`m3Scene.raise(document.querySelector('#card-10')); m3Scene.panBy(35, 28); m3Scene.zoomAt(1.2, { x: 300, y: 250 }); m3Scene.render()`);
  const inputPoint = await evaluate(`(() => { const r = document.querySelector('#front-input').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: r.toJSON() }; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type,
      x: inputPoint.x,
      y: inputPoint.y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: 1
    });
  }
  await evaluate(`document.querySelector('#front-input').value = '';`);
  await send('Input.insertText', { text: 'm4-native-input' });
  const inputResult = await evaluate(`({ focused: document.activeElement === document.querySelector('#front-input'), value: document.querySelector('#front-input').value, title: document.querySelector('#front-title').textContent })`);
  assert(inputResult.focused && inputResult.value === 'm4-native-input', 'Native input did not receive focus and text after pan, zoom, and raise');
  result.functional.inputHitTest = { point: inputPoint, ...inputResult };

  const benchmarkCounts = [1, 10, 100, 500, 1000];
  for (const surfaceCount of benchmarkCounts) {
    await evaluate(`(() => {
      const canvas = document.querySelector('#stage');
      for (const element of [...canvas.querySelectorAll('.card')]) { m3Scene.remove(element); element.remove(); }
      stage.requestPaint();
    })()`);
    await waitFor('window.m3Scene.getStats().nodeCount === 0', 'Previous benchmark surfaces were not released');
    await evaluate(`(() => {
      const canvas = document.querySelector('#stage');
      window.__m4BenchmarkCards = Array.from({ length: ${surfaceCount} }, (_, index) => {
        const card = document.createElement('article');
        card.className = 'card';
        card.id = 'bench-' + index;
        card.setAttribute('drawable', '');
        card.dataset.x = '0';
        card.dataset.y = '0';
        card.innerHTML = '<h2>Benchmark ' + index + '</h2><p>Surface di misura</p>';
        canvas.append(card);
        m3Scene.add(card, { x: 0, y: 0 });
        return card;
      });
      canvas.requestPaint();
    })()`);
    await waitFor(`window.m3Scene.getStats().allocatedSurfaceCount === ${surfaceCount}`, `Surface allocation failed at ${surfaceCount}`);
    await waitFor(`window.__m4BenchmarkCards.every((card) => window.__m4PaintEvents.some((ids) => ids.includes(card.id)))`, `Native paint records did not arrive for ${surfaceCount} surfaces`);
    await evaluate('m3Scene.render()');
    const warm = await snapshot();
    assert(warm.stats.frame.drawCount === surfaceCount, `${surfaceCount} surface benchmark did not draw all surfaces`);
    const samplesMs = [];
    for (let run = 0; run < 5; run += 1) {
      const sample = await evaluate('m3Scene.render(); m3Scene.getStats()');
      assert(sample.frame.drawCount === surfaceCount, `${surfaceCount} surface run ${run + 1} did not draw all surfaces`);
      samplesMs.push(sample.frame.cpuMs);
    }
    const geometryOnly = await evaluate('m3Scene.panBy(1, 1); m3Scene.render(); m3Scene.getStats()');
    assert(geometryOnly.frame.uploadCount === 0, `${surfaceCount} geometry-only run unexpectedly uploaded snapshots`);
    const renderCountBeforeContentChange = await evaluate('window.m3State.renderCount');
    const uploadCountBeforeContentChange = await evaluate('m3Scene.getStats().snapshotUploadCount');
    const frameCountBeforeContentChange = await evaluate('window.__m4Frames.length');
    await evaluate(`(() => { window.__m4BenchmarkCards[0].querySelector('h2').textContent = 'Changed ' + Math.random(); stage.requestPaint(); })()`);
    await waitFor(`window.__m4PaintEvents.some((ids) => ids.includes('bench-0'))`, `${surfaceCount} surface content mutation produced no native paint event`);
    await waitFor(`window.m3State.renderCount > ${renderCountBeforeContentChange} && window.m3Scene.getStats().snapshotUploadCount > ${uploadCountBeforeContentChange}`, `${surfaceCount} surface content update did not upload and render`);
    const mutation = await evaluate('m3Scene.getStats()');
    const mutationFrames = await evaluate(`window.__m4Frames.slice(${frameCountBeforeContentChange}).filter((frame) => frame.uploadCount > 0)`);
    const mutationPaintEvents = await evaluate('window.__m4PaintEvents.slice(-5)');
    const mutationUploadCount = mutationFrames.reduce((total, frame) => total + frame.uploadCount, 0);
    assert(mutationUploadCount === 1, `${surfaceCount} content mutation should upload one snapshot, got ${mutationUploadCount}`);
    const bytes = mutation.gpu.estimatedBytes;
    assert(bytes <= benchmarkMemoryBudgetBytes, `${surfaceCount} surfaces exceed the ${benchmarkMemoryBudgetBytes}-byte benchmark budget`);
    result.benchmark.push({
      surfaceCount,
      samples: 5,
      cpuMs: { p50: percentile50(samplesMs), min: Math.min(...samplesMs), max: Math.max(...samplesMs), values: samplesMs },
      bytes,
      geometryOnly: { cpuMs: geometryOnly.frame.cpuMs, uploads: geometryOnly.frame.uploadCount, draws: geometryOnly.frame.drawCount },
      oneSurfaceMutation: {
        cpuMs: mutationFrames[0]?.cpuMs ?? null,
        uploads: mutationUploadCount,
        draws: mutationFrames[0]?.drawCount ?? mutation.frame.drawCount,
        paintEvents: mutationPaintEvents.map((ids) => ({ count: ids.length, includesTarget: ids.includes('bench-0') }))
      }
    });
  }

  await evaluate(`(() => { for (const card of [...document.querySelectorAll('.card')]) { m3Scene.remove(card); card.remove(); } })()`);
  result.functional.finalErrors = await evaluate('window.m3Errors');
  assert(result.functional.finalErrors.length === 0, `Browser reported errors: ${result.functional.finalErrors.join('; ')}`);
  if (process.argv.includes('--induce-gpu-loss')) {
    result.deviceLoss = await simulateGpuProcessLoss();
    assert(result.deviceLoss.page.state.failed, 'WebGPU process loss must switch the page to its failure state');
  }
} catch (error) {
  result.errors.push(error.stack ?? String(error));
} finally {
  if (result.deviceLoss.page?.state.failed) {
    try {
      const version = await (await fetch(`${cdpUrl}/json/version`)).json();
      const versionNumber = version.Browser.match(/Chrome\/(\d+(?:\.\d+)+)/)?.[1];
      const expectedProfile = `profile-canary-${versionNumber}-${profileSuffix}`;
      const command = `$root = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine.Contains('${expectedProfile} --incognito') }); if ($root.Count -ne 1) { throw 'Root Chrome process is not uniquely bound to the isolated M4 profile.' }; Stop-Process -Id $root[0].ProcessId -Force`;
      execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { stdio: 'pipe' });
      result.cleanup = { status: 'browser-closed-after-device-loss', profile: expectedProfile };
    } catch (error) {
      result.cleanup = { status: 'browser-close-failed', error: error.message };
    }
  } else {
    try {
      await send('Page.reload', { ignoreCache: true });
      await waitFor('window.m3State?.ready === true && window.m3State?.failed === false && window.m3Scene.getStats().allocatedSurfaceCount === 10', 'M3 page did not restore after benchmark');
      result.cleanup = { status: 'page-restored' };
    } catch (error) {
      result.cleanup = { status: 'page-restore-failed', error: error.message };
    }
  }
  await mkdir('.audit', { recursive: true });
  await writeFile('.audit/m4-browser-results.json', `${JSON.stringify(result, null, 2)}\n`);
  socket.close();
}

console.log(JSON.stringify({
  environment: result.environment,
  functional: {
    initial: result.functional.initial,
    culling: result.functional.culling,
    offscreenMutation: result.functional.offscreenMutation?.stats,
    deferredUpload: result.functional.deferredUpload,
    inputHitTest: result.functional.inputHitTest,
    finalErrors: result.functional.finalErrors
  },
  benchmark: result.benchmark.map(({ surfaceCount, samples, cpuMs, bytes, geometryOnly, oneSurfaceMutation }) => ({
    surfaceCount, samples, cpuMs, bytes, geometryOnly, oneSurfaceMutation: { ...oneSurfaceMutation, paintEvents: undefined }
  })),
  benchmarkMemoryBudgetBytes: result.benchmarkMemoryBudgetBytes,
  deviceLoss: result.deviceLoss.status === 'not-run' ? result.deviceLoss : {
    processId: result.deviceLoss.processId,
    replacementProcessId: result.deviceLoss.replacementProcessId,
    failed: result.deviceLoss.page?.state.failed,
    errors: result.deviceLoss.page?.errors
  },
  artifacts: result.artifacts,
  cleanup: result.cleanup,
  errors: result.errors
}, null, 2));
if (result.errors.length || !['page-restored', 'browser-closed-after-device-loss'].includes(result.cleanup.status)) process.exitCode = 1;
