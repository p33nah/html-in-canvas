import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = resolve(root, '.audit', 'm0-browser-results.json');
const screenshotPath = resolve(root, '.audit', 'm0-browser.png');
const targetPort = Number(process.env.WICG_TEST_PORT ?? process.argv[2] ?? 8000);
const debuggingPort = Number(process.env.WICG_CDP_PORT ?? process.argv[3] ?? 9222);
const targetUrl = `http://127.0.0.1:${targetPort}/tests/wicg-smoke.html`;
const targets = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`).then((response) => response.json());
const page = targets.find((target) => target.type === 'page' && target.url === targetUrl);

if (!page) throw new Error(`Pagina M0 non trovata nel target Chrome: ${targetUrl}`);

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
  const result = await command('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

await new Promise((resolveOpen, reject) => {
  socket.addEventListener('open', resolveOpen, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

await command('Runtime.enable');
await command('Log.enable');
await command('Network.enable');
await command('Page.enable');
let initialPaint = '';
for (let attempt = 0; attempt < 40; attempt++) {
  await delay(250);
  initialPaint = await evaluate(`document.querySelector('#runtime-status').textContent`);
  if (initialPaint.startsWith('Evento paint ricevuto')) break;
}

const browser = await evaluate(`(() => {
  const canvas = document.querySelector('#stage');
  const card = document.querySelector('#card');
  const input = document.querySelector('#name');
  const button = document.querySelector('#action');
  const rect = (element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  };
  const capabilityRows = [...document.querySelectorAll('#capabilities code')];
  return {
    userAgent: navigator.userAgent,
    devicePixelRatio,
    capabilities: [...document.querySelectorAll('#capabilities li')].map((item) => ({
      id: item.querySelector('code')?.textContent,
      available: item.classList.contains('available'),
      detail: item.textContent
    })),
    runtimeStatus: document.querySelector('#runtime-status').textContent,
    initialChangedElementIds: [...(window.m0LatestPaintChangedElementIds ?? [])],
    card: rect(card),
    button: rect(button),
    input: rect(input),
    buttonHitTarget: document.elementFromPoint(rect(button).x + rect(button).width / 2, rect(button).y + rect(button).height / 2)?.id,
    canvas: Boolean(canvas),
    capabilityCount: capabilityRows.length
  };
})()`);
const browserErrorScenario = await evaluate(`(() => {
  const row = [...document.querySelectorAll('#scenarios li')]
    .find((item) => item.querySelector('code')?.textContent === 'browser-errors');
  return row?.className ?? 'missing';
})()`);

let idle = browser.runtimeStatus;
let idleSamples = 0;
let previousStatus = idle;
for (let sample = 0; sample < 20 && idleSamples < 4; sample++) {
  await delay(250);
  idle = await evaluate(`document.querySelector('#runtime-status').textContent`);
  idleSamples = idle === previousStatus ? idleSamples + 1 : 0;
  previousStatus = idle;
}

const gpuAdapter = await evaluate(`(async () => {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  return {
    info: adapter.info ? {
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      device: adapter.info.device,
      description: adapter.info.description
    } : null,
    features: [...adapter.features]
  };
})()`);

const buttonPoint = {
  x: browser.button.x + browser.button.width / 2,
  y: browser.button.y + browser.button.height / 2
};
await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...buttonPoint });
await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...buttonPoint, button: 'left', clickCount: 1 });
await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...buttonPoint, button: 'left', clickCount: 1 });
await delay(400);
const afterClick = await evaluate(`({
  title: document.querySelector('#title').textContent,
  clickStatus: document.querySelector('#scenarios').textContent.includes('card-button-click: pass'),
  paintStatus: document.querySelector('#runtime-status').textContent
})`);

const inputPoint = {
  x: browser.input.x + browser.input.width / 2,
  y: browser.input.y + browser.input.height / 2
};
await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...inputPoint });
await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...inputPoint, button: 'left', clickCount: 1 });
await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...inputPoint, button: 'left', clickCount: 1 });
await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', modifiers: 2, windowsVirtualKeyCode: 17 });
await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
const selection = await evaluate(`({
  start: document.querySelector('#name').selectionStart,
  end: document.querySelector('#name').selectionEnd
})`);
await command('Input.insertText', { text: 'M0 input check' });
const afterInput = await evaluate(`({
  activeElement: document.activeElement?.id,
  value: document.querySelector('#name').value,
  selection: [document.querySelector('#name').selectionStart, document.querySelector('#name').selectionEnd],
  paintStatus: document.querySelector('#runtime-status').textContent
})`);

const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));

const missingCapabilities = browser.capabilities.filter((item) => !item.available).map((item) => item.id);
const results = {
  browser,
  gpuAdapter,
  changedElementIds: browser.initialChangedElementIds,
  afterClick,
  selection,
  afterInput,
  browserErrorScenario,
  idle,
  idleSamples,
  exceptions,
  badResponses,
  screenshotPath,
  checks: {
    allCapabilitiesPresent: missingCapabilities.length === 0,
    initialPaintReceived: initialPaint.startsWith('Evento paint ricevuto'),
    buttonClickReachedCanvasContent: afterClick.title.startsWith('Titolo aggiornato (') && afterClick.clickStatus,
    inputFocusedSelectedAndEdited: afterInput.activeElement === 'name' &&
      selection.start === 0 && selection.end === 5 && afterInput.value === 'M0 input check',
    nestedDrawablesReported: browser.initialChangedElementIds.includes('card') &&
      browser.initialChangedElementIds.includes('nested-card'),
    paintReachedIdle: idleSamples === 4,
    noBrowserErrors: browserErrorScenario !== 'fail' && exceptions.length === 0 && badResponses.length === 0
  },
  missingCapabilities
};
await writeFile(reportPath, `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
if (Object.values(results.checks).some((passed) => !passed)) process.exitCode = 1;
socket.close();
