import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = resolve(root, '.audit', 'm1-browser-results.json');
const screenshotPath = resolve(root, '.audit', 'm1-browser.png');
const targetPort = Number(process.env.WICG_TEST_PORT ?? process.argv[2] ?? 8000);
const debuggingPort = Number(process.env.WICG_CDP_PORT ?? process.argv[3] ?? 9222);
const targetUrl = `http://127.0.0.1:${targetPort}/tests/gpu-single.html`;
const targets = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`).then((response) => response.json());
const page = targets.find((target) => target.type === 'page' && target.url === targetUrl);
if (!page) throw new Error(`Pagina M1 non trovata nel target Chrome: ${targetUrl}`);

const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
const exceptions = [];
const badResponses = [];
let nextId = 0;

socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    exceptions.push(message.params.entry.text);
  }
  if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) {
    badResponses.push({ status: message.params.response.status, url: message.params.response.url });
  }
  if (message.id && pending.has(message.id)) {
    const { resolve: resolveCommand, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolveCommand(message.result);
  }
});

function command(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolveCommand, reject) => {
    pending.set(id, { resolve: resolveCommand, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(expression, description) {
  for (let attempt = 0; attempt < 80; attempt++) {
    await delay(250);
    const result = await evaluate(expression);
    if (result) return result;
  }
  throw new Error(`Timeout aspettando ${description}.`);
}

await new Promise((resolveOpen, reject) => {
  socket.addEventListener('open', resolveOpen, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
await command('Runtime.enable');
await command('Log.enable');
await command('Network.enable');
await command('Page.enable');
await command('Page.bringToFront');

const ready = await waitFor(`document.querySelector('#status').textContent.startsWith('M1 pronto')`, 'render iniziale WebGPU');
const beforeInput = await evaluate(`(() => {
  const rect = (id) => {
    const { x, y, width, height } = document.querySelector(id).getBoundingClientRect();
    return { x, y, width, height };
  };
  const input = document.querySelector('#name');
  const inputRect = input.getBoundingClientRect();
  const buttonRect = document.querySelector('#action').getBoundingClientRect();
  return {
    status: document.querySelector('#status').textContent,
    state: { ...window.m1State },
    canvas: {
      ...rect('#stage'),
      backingWidth: document.querySelector('#stage').width,
      backingHeight: document.querySelector('#stage').height,
      clientWidth: document.querySelector('#stage').clientWidth,
      clientHeight: document.querySelector('#stage').clientHeight,
      devicePixelRatio
    },
    card: rect('#card'),
    input: rect('#name'),
    button: rect('#action'),
    inputHitTarget: document.elementFromPoint(inputRect.x + inputRect.width / 2, inputRect.y + inputRect.height / 2)?.id,
    buttonHitTarget: document.elementFromPoint(buttonRect.x + buttonRect.width / 2, buttonRect.y + buttonRect.height / 2)?.id
  };
})()`);

async function clickAt(rect) {
  const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}

await clickAt(beforeInput.input);
await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', modifiers: 2, windowsVirtualKeyCode: 17 });
await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
const selection = await evaluate(`({
  activeElement: document.activeElement?.id,
  start: document.querySelector('#name').selectionStart,
  end: document.querySelector('#name').selectionEnd
})`);
await command('Input.insertText', { text: 'M1 input aggiornato' });
await waitFor(`window.m1State.uploadCount >= 2`, 'upload dello snapshot aggiornato');
const afterInput = await evaluate(`({
  activeElement: document.activeElement?.id,
  value: document.querySelector('#name').value,
  uploadCount: window.m1State.uploadCount
})`);

const afterInputRects = await evaluate(`(() => {
  const element = document.querySelector('#action');
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height, hitTarget: document.elementFromPoint(x + width / 2, y + height / 2)?.id };
})()`);
await clickAt(afterInputRects);
await waitFor(`document.querySelector('#title').textContent.startsWith('Titolo aggiornato') && window.m1State.uploadCount >= 3`, 'click HTML e nuovo upload');

const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
const afterButton = await evaluate(`({
  title: document.querySelector('#title').textContent,
  status: document.querySelector('#status').textContent,
  state: { ...window.m1State },
  pageErrors: [...window.m1Errors]
})`);

const checks = {
  gpuPipelineReady: ready && beforeInput.state.ready,
  webGpuTextureUpload: beforeInput.state.uploadCount >= 1,
  canvasBackingMatchesDevicePixels: Math.abs(beforeInput.canvas.backingWidth / beforeInput.canvas.clientWidth - beforeInput.canvas.devicePixelRatio) < 0.05,
  cardPositionedInsideCanvas: Math.abs(beforeInput.card.x - beforeInput.canvas.x - 64 * beforeInput.canvas.devicePixelRatio) < 1 &&
    Math.abs(beforeInput.card.y - beforeInput.canvas.y - 48 * beforeInput.canvas.devicePixelRatio) < 1,
  inputHitTestingAligned: beforeInput.inputHitTarget === 'name' && selection.activeElement === 'name' &&
    selection.start === 0 && selection.end === 'M1 input pronto'.length && afterInput.value === 'M1 input aggiornato',
  buttonHitTestingAligned: afterInputRects.hitTarget === 'action' && afterButton.title.startsWith('Titolo aggiornato'),
  contentChangeUploadedAgain: afterInput.uploadCount >= 2 && afterButton.state.uploadCount >= 3,
  noBrowserErrors: afterButton.pageErrors.length === 0 && exceptions.length === 0 && badResponses.length === 0
};
const report = { targetUrl, beforeInput, selection, afterInput, afterInputRects, afterButton, exceptions, badResponses, screenshotPath, checks };
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
socket.close();
