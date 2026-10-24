# Native HTML Canvas Engine
## Guida tecnico-operativa all'implementazione

**Versione:** 1.0 — 23 ottobre 2026  
**Destinatari:** sviluppatori JavaScript e agenti di coding  
**Vincolo:** esclusivamente HTML, CSS, JavaScript vanilla, Chrome/Chromium e API browser native  
**Approccio al codice:** implementazioni concrete dove i contratti sono definiti; pseudocodice etichettato soltanto per scelte ancora da validare.

> **Obiettivo pratico.** Partire da uno smoke test dell'API WICG, costruire un compositore WebGPU 2D minimo, aggiungere sincronizzazione della geometria DOM, scene e interazioni, poi misurare e ottimizzare. Questo documento non dichiara i frammenti già eseguiti: la compatibilità reale deve essere verificata sulla build Chromium fissata dal progetto.

## 0. Regole di esecuzione

1. **No React, TypeScript, Vite, bundler, Virtual DOM, CSS engine proprietario o polyfill.** ES Modules e browser API native.
2. **Fail fast** quando API o GPU richieste non esistono. Non mascherare un errore con fallback WebGL o canvas raster.
3. **Una build target:** registrare versione esatta, canale, piattaforma, GPU, flag, commit/snapshot se disponibile. Non dichiarare genericamente «funziona su Chrome».
4. **Codice WICG concentrato** in uno strato browser piccolo. Non per supportare altri browser: per isolare le revisioni sperimentali.
5. **Prima test, poi astrazioni.** Aggiungere un modulo solo quando elimina duplicazione reale o gestisce un'invariante precisa.
6. **Il DOM resta la fonte di verità del contenuto.** La scena conserva solo lo stato necessario al rendering.
7. **Consegne incrementali:** ogni fase deve produrre un demo HTML apribile e un elenco di test superati/falliti.

## 1. Riferimento API vincolante

Le firme seguenti vengono dall'explainer WICG aggiornato e dalle note ufficiali Chrome sul passaggio alle API di Chrome 155+. Sono **contratti della proposta**, non prova di comportamento su tutte le build.

| Primitiva | Firma / uso | Ruolo |
|---|---|---|
| Canvas opt-in | `<canvas content="drawable">` | Attiva layout dei discendenti nel Canvas |
| Drawable | `<article drawable>` | Definisce una superficie disegnabile |
| Evento paint | `canvas.addEventListener('paint', handler)` | Legge snapshot aggiornati; `event.changedElements` |
| Scheduling | `canvas.requestPaint()` | Richiede un `paint` anche senza mutazione DOM |
| 2D | `ctx.drawElementImage(element, dx, dy)` | Disegna HTML e sincronizza automaticamente geometria |
| WebGPU | `device.queue.drawElementImageToTexture(source, destination)` | Disegna snapshot in texture preallocata |
| Dimensioni | `canvas.getElementImageDefaultSize(element)` | Dimensione sorgente nell'unità della griglia Canvas |
| Geometria | `canvas.updateElementGeometry(element, {canvasTransform})` | Allinea hit test e informazioni di posizione |
| Cleanup geometria | `canvas.clearElementGeometry(element)` | Rimuove la geometria associata |
| Snapshot transfer | `canvas.captureElementImage(element)` | Sorgente trasferibile ad OffscreenCanvas/Worker, fase successiva |

**Firma WebGPU per la baseline selezionata:**

```js
// Contratto della proposta Chrome 155+; verificare sulla build target.
device.queue.drawElementImageToTexture(
  {
    source: element,
    sourceX: 0,
    sourceY: 0,
    sourceWidth: width,
    sourceHeight: height
  },
  {
    texture,
    size: { width, height }
  }
);
```

La chiamata con i soli campi `{source: element}` e `{texture, size}` è ammessa nella bozza per gli argomenti opzionali; nella fase iniziale preferire la firma esplicita dopo aver verificato le dimensioni. **Non usare** vecchie guide con `layoutsubtree` o `copyElementImageToTexture` senza una motivazione legata alla build.

## 2. Ambiente Chrome e preflight

### 2.1 Preparazione manuale

- Installare una versione di Chrome Canary/Chromium che implementi la proposta desiderata.
- Abilitare `chrome://flags/#canvas-draw-element` e, se richiesto dalla build, `chrome://flags/#enable-experimental-web-platform-features`.
- Riavviare il browser.
- Eseguire i file tramite `http://localhost`, non con `file://`; WebGPU richiede un secure context e localhost è considerato attendibile.
- Registrare la versione in `docs/CHROMIUM_TARGET.md`, assieme a esito dei test.

Server locale minimale, **solo per servire file statici**:

```sh
python3 -m http.server 8000
# Aprire http://localhost:8000/tests/wicg-smoke.html
```

### 2.2 Preflight JavaScript reale

```js
export function assertNativeCapabilities(canvas) {
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new TypeError('È richiesto un HTMLCanvasElement');
  }
  if (canvas.getAttribute('content') !== 'drawable') {
    throw new Error('Impostare content="drawable" nel markup');
  }
  const required = [
    'requestPaint',
    'updateElementGeometry',
    'clearElementGeometry',
    'getElementImageDefaultSize'
  ];
  for (const name of required) {
    if (typeof canvas[name] !== 'function') {
      throw new Error(`API WICG assente: canvas.${name}`);
    }
  }
  if (!navigator.gpu) {
    throw new Error('WebGPU non disponibile in questa build');
  }
  if (typeof GPUQueue === 'undefined' ||
      typeof GPUQueue.prototype.drawElementImageToTexture !== 'function') {
    throw new Error('API WICG WebGPU non disponibile');
  }
}
```

**Non aggiungere** in questa fase la detection di metodi legacy: supportiamo una sola API-target.

## 3. M0 — Smoke test nativo 2D completo

Creare `tests/wicg-smoke.html` con il seguente contenuto. È un **test di integrazione da eseguire**, non una verifica dichiarata già superata.

```html
<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WICG smoke test</title>
  <style>
    body { margin: 24px; font: 16px system-ui; background: #142033; }
    #stage { display: block; width: 800px; height: 480px; }
    #card {
      width: 280px; padding: 20px; box-sizing: border-box;
      background: white; color: #111; border-radius: 12px;
    }
    input, button { display: block; margin-top: 12px; }
  </style>
</head>
<body>
  <canvas id="stage" content="drawable" width="800" height="480">
    <article id="card" drawable>
      <h2 id="title">Card nativa</h2>
      <label>Nome <input id="name" value="Alice"></label>
      <button id="action" type="button">Aggiorna titolo</button>
    </article>
  </canvas>
  <script type="module">
    const canvas = document.querySelector('#stage');
    const card = document.querySelector('#card');
    const title = document.querySelector('#title');
    const ctx = canvas.getContext('2d');
    if (typeof ctx?.drawElementImage !== 'function' ||
        typeof canvas.requestPaint !== 'function') {
      throw new Error('API HTML-in-Canvas 2D non disponibili');
    }
    let paints = 0;
    canvas.addEventListener('paint', (event) => {
      paints++;
      ctx.reset();
      ctx.drawElementImage(card, 100, 80);
      console.debug('paint', paints, event.changedElements);
    });
    document.querySelector('#action').addEventListener('click', () => {
      title.textContent = `Aggiornato (${++paints})`;
    });
    canvas.requestPaint();
  </script>
</body>
</html>
```

Il test usa intenzionalmente 800×480 pixel CSS e 800×480 pixel di backing, senza gestione DPR: serve solo a verificare API, paint e interazione. In M1 si introdurrà un resize coerente con DPR e griglia Canvas. La variabile `paints` qui è un semplice contatore diagnostico, non un modello di scheduling dell'engine.

**Checklist M0:** la card è visibile; il bottone riceve click; l'input riceve focus, testo, copy/paste e selezione; le modifiche del titolo appaiono; `paint` non entra in un ciclo infinito; il browser non produce errori; DevTools espone l'esistenza delle API richieste. Ripetere con elementi `drawable` annidati per verificare esclusione dallo snapshot del padre e ordine degli eventi.

**Gate M0:** registrare ogni esito in `docs/CHROMIUM_TARGET.md`. Se M0 fallisce, non iniziare la GPU: il problema è il prerequisito sperimentale.

## 4. Struttura repository minimale

```text
native-html-canvas/
├── index.html
├── style.css
├── src/
│   ├── main.js                # boot e demo
│   ├── engine.js              # lifecycle pubblico
│   ├── capabilities.js        # assertNativeCapabilities
│   ├── scene.js               # registrazione, stato e ordine nodi
│   ├── scheduler.js           # invalidazioni e richiesta paint
│   ├── geometry.js            # matrici e hit-test sync
│   ├── surfaces.js            # snapshot e ownership texture
│   ├── gpu.js                 # inizializzazione WebGPU, pass grafici
│   └── resources.js           # allocazione e cleanup texture/buffer
├── shaders/
│   └── composite.wgsl
├── tests/
│   ├── wicg-smoke.html
│   ├── gpu-single.html
│   ├── interactions.html
│   └── benchmarks.html
└── docs/
    ├── CHROMIUM_TARGET.md
    └── DECISIONS.md
```

Questa struttura è una **proposta pratica**, non un obbligo di naming. Raggruppare moduli solo dove emerge una responsabilità autonoma. Non creare package separati prima di avere bisogno di distribuirli separatamente.

## 5. Contratti dati del nucleo

### 5.1 Nodi e ownership

Per il primo runtime è sufficiente una `Map` di record associati a nodi DOM. Evitare cloni del sottoalbero HTML.

```js
const node = {
  id: 'surface-42',
  kind: 'html',
  element,                 // riferimento DOM reale
  parentId: null,
  x: 120, y: 80,          // coordinate nello spazio scena
  scaleX: 1, scaleY: 1,
  rotation: 0,            // radianti
  zIndex: 10,
  visible: true,
  texture: null,          // GPUTexture, posseduta dal runtime
  textureWidth: 0,
  textureHeight: 0,
  contentDirty: true,
  geometryDirty: true,
  resourceDirty: true,
  destroyed: false
};
```

**Invarianti da implementare e testare:** ID unici; un elemento DOM ha al più una surface proprietaria; nessuna texture usata dopo `destroy`; rimozione di un nodo comporta pulizia della sua geometria; evitare references a elementi DOM staccati dalla pagina; l'ordine di disegno e l'ordine di hit testing devono essere esplicitamente sincronizzati.

### 5.2 API pubblica iniziale

```js
const engine = await Engine.create(document.querySelector('#stage'));
const card = engine.add(document.querySelector('#card'), {
  x: 100, y: 80, zIndex: 1
});
card.setPosition(350, 180);
card.setScale(1.25);
engine.remove(card.id);
engine.destroy();
```

È un **contratto di design**, non un'API già implementata. Metodi e naming possono evolvere; le semantiche di add/remove/destroy e l'ownership invece devono essere definite fin dall'inizio.

## 6. M1 — Inizializzazione WebGPU concreta

### 6.1 `src/gpu.js` (parte di bootstrap)

```js
export async function createGpu(canvas) {
  if (!navigator.gpu) throw new Error('WebGPU assente');

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Nessun adapter WebGPU disponibile');

  const device = await adapter.requestDevice();
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('Context WebGPU non disponibile');

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'premultiplied' });

  device.lost.then((info) => {
    console.error('WebGPU device lost', info.reason, info.message);
    // Nel primo runtime: arrestare il rendering e segnalare il problema.
    // Il recovery con ricreazione completa è una milestone separata.
  });

  return { adapter, device, context, format };
}
```

`getContext('webgpu')` e `getContext('2d')` non vanno richiesti sullo **stesso canvas**: M0 e M1 utilizzano pagine/demo separate.

### 6.2 Dimensioni e coordinate: regola di implementazione

- Misurare il CSS box del Canvas; calcolare dimensione desiderata del backing, inclusi DPR e limiti hardware.
- Modificare `canvas.width/height` **solo quando il valore cambia**; farlo a ogni frame invalida risorse e comportamenti.
- Centralizzare la conversione `scene → canvas CSS → backing pixel → clip-space`.
- Calcolare e aggiornare `updateElementGeometry()` con una matrice coerente col medesimo posizionamento del quad GPU. Verificare empiricamente la conversione richiesta dalla build, soprattutto per DPR ≠ 1.

**Pseudocodice intenzionale** (serve una validazione sul mapping WICG della build):

```text
resize(canvas):
  cssSize = misurazione effettiva elemento
  backingSize = arrotonda(cssSize × pixelRatio)
  se backingSize è cambiata:
    canvas.width/height = backingSize
    invalida viewport, pipeline uniforms e quad positions
  richiedi un nuovo paint
```

**Decisione importante:** non usare `getBoundingClientRect()` come unica fonte ingenua della dimensione di una surface dopo `updateElementGeometry()`, perché la geometria resa può influenzare le bounding rect del DOM. Per la dimensione sorgente usare inizialmente `getElementImageDefaultSize()` e testarne il rapporto con CSS layout e texture extent.

## 7. Acquisizione WICG e gestione texture: codice specifico

```js
export function readSurfaceExtent(canvas, element) {
  const size = canvas.getElementImageDefaultSize(element);
  const width = Math.max(1, Math.ceil(size.width));
  const height = Math.max(1, Math.ceil(size.height));
  return { width, height };
}

export function allocateSurfaceTexture(device, width, height) {
  return device.createTexture({
    size: { width, height, depthOrArrayLayers: 1 },
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT
  });
}

export function uploadHtmlSurface(device, element, texture, width, height) {
  device.queue.drawElementImageToTexture(
    { source: element },
    { texture, size: { width, height } }
  );
}
```

Questi sono frammenti **con sintassi effettiva**, non pseudocodice. Restano da validare: supporto della combinazione di `GPUTextureUsage` nel percorso WICG sperimentale, corrispondenza delle dimensioni e comportamento del colore/alpha. Il motore deve trattare ogni errore come errore di API o integrazione, non nasconderlo.

### Ownership e riallocazione

```js
export function replaceTexture(node, device, width, height) {
  if (node.texture &&
      node.textureWidth === width &&
      node.textureHeight === height) {
    return;
  }
  node.texture?.destroy();
  node.texture = allocateSurfaceTexture(device, width, height);
  node.textureWidth = width;
  node.textureHeight = height;
  node.resourceDirty = false;
  node.contentDirty = true;
}
```

Questo è il **percorso semplice** per M1; il pool e l'eviction si aggiungono solo dopo il profiling. Se la texture cambia, ricreare anche gli eventuali `GPUTextureView` e bind group associati: non conservare bind group che puntano a texture distrutte.

## 8. M1 — Il compositore GPU minimo

### 8.1 Shader WGSL reale (`shaders/composite.wgsl`)

Il primo shader disegna una texture sopra un quad rettangolare. Convenzione: `rect` e `viewport` sono espressi in **pixel backing Canvas**. Origine (0,0) in alto a sinistra.

```wgsl
struct Params {
  rect: vec4f,      // x, y, width, height
  viewport: vec4f,  // canvasWidth, canvasHeight, reserved, reserved
};

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var image: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

struct VertexOutput {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VertexOutput {
  let corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0)
  );
  let uv = corners[i];
  let px = params.rect.xy + uv * params.rect.zw;
  let clip = vec2f(
    2.0 * px.x / params.viewport.x - 1.0,
    1.0 - 2.0 * px.y / params.viewport.y
  );
  var result: VertexOutput;
  result.pos = vec4f(clip, 0.0, 1.0);
  result.uv = uv;
  return result;
}

@fragment
fn fs(in: VertexOutput) -> @location(0) vec4f {
  return textureSample(image, samp, in.uv);
}
```

Per M1 **niente rotazione, camera o gerarchia**: prima dimostrare un singolo quad rettangolare ben posizionato. La gestione del blending richiede la verifica del modello alpha della texture HTML acquisita; non assumere che una configurazione errata sia innocua.

### 8.2 Pipeline JavaScript reale

```js
export async function createQuadPipeline(device, format) {
  const wgsl = await fetch('./shaders/composite.wgsl')
    .then(async (res) => {
      if (!res.ok) throw new Error(`WGSL HTTP ${res.status}`);
      return res.text();
    });
  const module = device.createShaderModule({ code: wgsl });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: {
      module, entryPoint: 'fs',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }
        }
      }]
    },
    primitive: { topology: 'triangle-list' }
  });
  const sampler = device.createSampler({
    magFilter: 'linear', minFilter: 'linear'
  });
  return { pipeline, sampler };
}
```

L'uso di `srcFactor: 'one'` assume una sorgente premoltiplicata (da validare con un test visivo su contenuti semitrasparenti). Dopo il test alpha, fissare il contratto e il formato una volta, non in ogni chiamata di draw.

### 8.3 Rendering del frame — pseudocodice mirato

Il codice di pass encoder e binding GPU è standard WebGPU; i dettagli dei nodi e del caching dei bind group dipendono invece dalla struttura scelta. La parte seguente è **pseudocodice di orchestrazione**, non un esempio da copiare come JS:

```text
onPaint(event):
  per ogni element in event.changedElements:
    se esiste la surface registrata: surface.contentDirty = true

  per ogni surface visibile:
    se primo snapshot non ancora disponibile: non disegnare; ritentare al paint
    extent = canvas.getElementImageDefaultSize(element)
    se texture assente o extent cambiato: rialloca texture e bind group
    se contentDirty: device.queue.drawElementImageToTexture(...)

  aggiorna i uniform per rect/viewport
  beginRenderPass clear oppure load secondo la strategia scelta
  per ogni surface visibile in ordine di zIndex:
    set pipeline, bind group, draw(6)
  endRenderPass e queue.submit

  aggiorna geometria DOM nello stesso ordine visivo:
    canvas.updateElementGeometry(element, { canvasTransform })
```

**Per il primo compositore:** usare un render pass con clear su ogni nuovo frame richiesto, un draw per superficie, un uniform buffer per superficie e nessun batching. In seguito misurare il costo di draw call, allocation e memory.

### 8.4 Perché non un `requestAnimationFrame` infinito?

Se la scena è immobile e il contenuto non cambia, non va ridisegnata solo perché il monitor ha 60/120 Hz. Usare `paint` per reagire agli snapshot e `requestPaint()` quando cambia soltanto la camera o la geometria. `requestAnimationFrame` serve per calcolare le trasformazioni delle animazioni attive, non per forzare all'infinito un rendering statico.

```js
export function createFrameInvalidator(canvas) {
  let scheduled = false;
  return function invalidate() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      canvas.requestPaint();
    });
  };
}
```

Il codice sopra raggruppa richieste multiple in un frame. La sua correttezza temporale e l'interazione con la fase `paint` sono un test esplicito, soprattutto quando `invalidate` è richiamata durante un evento `paint`.

## 9. Geometria, hit testing e ordine

### 9.1 Contratto geometricamente esplicito

Per ogni HTML Surface, il sistema conosce:

- dimensione sorgente nell'unità della griglia Canvas;
- matrice scene-to-canvas CSS;
- rapporto fra dimensioni CSS e backing Canvas;
- trasformazione effettiva del quad GPU;
- eventuale area di clipping;
- ordine finale di hit testing.

**Invariante essenziale:** la posizione del contenuto resa da WebGPU e la `canvasTransform` passata a `updateElementGeometry()` devono descrivere **la stessa trasformazione apparente**, con unità coerenti. Non basta copiare `x` e `y` e sperare che DPR e camera coincidano.

```js
canvas.updateElementGeometry(element, {
  canvasTransform: new DOMMatrix()
    .translate(100, 80)
    .scale(1.2)
});
```

Questo è codice WICG concreto per una trasformazione affine 2D. **Non è un mapping universale** per quad renderizzati in pixel backing, e il rapporto di coordinate va misurato sulla build in M1.

### 9.2 Ordine di hit test

Per default, `updateElementGeometry` può portare l'elemento in cima allo stack di hit testing. Se il compositore disegna dal fondo verso il primo piano, sincronizzare le geometrie **nello stesso ordine**, oppure gestire consapevolmente `preserveHitTestOrder`. Evitare di aggiornare l'ordine in maniera accidentale a ogni dirty tick.

Per le superfici nascoste o eliminate chiamare `clearElementGeometry(element)`; per elementi mantenuti nel DOM ma non più attivi valutare `inert`/semantica accessibile separatamente. Culling grafico e invisibilità semantica non sono concetti identici.

### 9.3 Input: non rubare eventi ai controlli

Per implementare il drag usare una **maniglia dedicata** oppure una verifica esplicita del target. Non intercettare ciecamente tutti i `pointerdown` della card: interromperebbe selezione del testo, input, pulsanti e comportamento standard.

```js
export function makeDragHandle(handle, moveBy) {
  let previous = null;
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    previous = { id: event.pointerId, x: event.clientX, y: event.clientY };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', (event) => {
    if (!previous || event.pointerId !== previous.id) return;
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    previous.x = event.clientX;
    previous.y = event.clientY;
    moveBy(dx, dy); // conversione camera/zoom demandata al caller
  });
  function end(event) {
    if (!previous || event.pointerId !== previous.id) return;
    previous = null;
    if (handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
  }
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('lostpointercapture', end);
}
```

Questo helper è JS eseguibile. Il chiamante deve convertire il delta dal viewport allo spazio scena (es. dividendo per lo zoom quando non c'è rotazione di camera). CSS `touch-action` va applicato solo all'area dedicata al drag, non indiscriminatamente a input e contenuti scrollabili.

## 10. M2–M3 — Scene, camera e trasformazioni

### 10.1 Schema matrici

La gerarchia delle trasformazioni si calcola dal parent alla superficie:

```text
world(node) = world(parent) × local(node)
canvasCss(node) = camera × world(node)
gpuBacking(node) = cssToBacking × canvasCss(node)
clipPosition = backingToClip × gpuBacking(node)
```

Questo è **pseudocodice matematico** per evitare di imporre un naming delle classi o uno storage di matrici prima di aver scelto le performance desiderate. Usare `DOMMatrix` per il 2D; misurare prima di scrivere una libreria matematica proprietaria.

### 10.2 Interfaccia camera semplice

```js
const camera = { x: 0, y: 0, zoom: 1 };

function worldToScreen(x, y) {
  return {
    x: x * camera.zoom + camera.x,
    y: y * camera.zoom + camera.y
  };
}

function screenToWorld(x, y) {
  return {
    x: (x - camera.x) / camera.zoom,
    y: (y - camera.y) / camera.zoom
  };
}
```

Questo codice è **esatto per pan + zoom uniforme senza rotazione**, con unità CSS in input e output. Se verranno aggiunte rotazioni/trasformazioni gerarchiche, sostituirlo con l'inversa della matrice completa e testare la conversione.

### 10.3 Selezione/drag/zoom

Ordine consigliato: (1) movimento di un nodo singolo; (2) pan camera; (3) zoom sul punto di puntamento; (4) z-order; (5) gruppi; (6) clipping; (7) rotazione. Testare ogni funzione sia visivamente sia tramite click/input DOM.

## 11. Dirty flags, scheduling e condizioni di gara

Il runtime non deve affidarsi esclusivamente a `MutationObserver`: non tutte le modifiche visive si riducono a mutazioni osservabili del DOM. L'evento `paint` è la sorgente principale delle invalidazioni visuali documentata dalla proposta. `MutationObserver` può essere utile per registrazione/rimozione di nodi, non per sostituire la semantica `paint`.

### Politica iniziale

- All'aggiunta: `contentDirty = true`, `resourceDirty = true`, `geometryDirty = true`.
- Su `event.changedElements`: invalidare le surface interessate.
- Su movimento/camera: invalidare geometria e frame, **non** marcare automaticamente content dirty.
- Su resize/dimensione di snapshot: ricreare texture e invalidare contenuto.
- Su remove/destroy: cancellare geometry state e liberare texture/buffer/view e listeners gestiti dall'engine.
- Su frame successivo: consumare il set di nodi dirty, non le singole mutazioni una per volta.

**Pseudocodice — scheduler transazionale:**

```text
requestSceneUpdate(reason):
  aggiungi reason all'insieme pending
  se non esiste già un render richiesto:
    pianifica un solo requestPaint (eventualmente via rAF)

onPaint(changedElements):
  unisci changedElements ai content dirty
  determina le surface visibili
  rialloca dove necessario
  esegui upload solo dei content dirty validi
  componi il frame
  sincronizza la geometria
  cancella le dirty flags effettivamente consumate
  se invalidazioni ulteriori sono comparse DURANTE paint:
    pianifica un paint successivo (evita ricorsione immediata)
```

**Caso limite da testare:** una mutazione DOM eseguita dentro un listener `paint` sarà disponibile visivamente solo nell'aggiornamento successivo. Non aspettarsi che l'upload appena effettuato rifletta una mutazione inserita a metà dello stesso ciclo.

## 12. M4 — Memoria, performance e caching

### 12.1 Contabilità texture

Per una texture RGBA8 non compressa:

```js
export function estimateTextureBytes(width, height) {
  return Math.ceil(width) * Math.ceil(height) * 4;
}
```

La cifra **esclude** mipmaps, copie temporanee, alignment e overhead del browser/GPU. Esempio: superficie 320×200 CSS con DPR 2 → texture 640×400 × 4 = 1.024.000 byte (~0,98 MiB). Non allocare centinaia di texture permanenti senza un budget esplicito.

### 12.2 Culling e politiche progressive

1. **Subito:** non comporre né caricare snapshot dei nodi fuori dalla viewport; continuare a gestire correttamente gli elementi DOM e la loro accessibilità. Conservare e aggiornare la geometria DOM di tutte le surface registrate, anche quando sono fuori schermo.
2. **Dopo benchmark:** eviction di texture di nodi lontani e poco usati; la scena conserva il riferimento DOM.
3. **Dopo misure:** texture pooling per dimensioni compatibili e caching di snapshot.
4. **Solo se necessario:** atlas, batching, level of detail, risoluzione adattiva con isteresi.

**Pseudocodice — eviction sperimentale:**

```text
se memoryEstimate > budget:
  ordina le texture NON VISIBILI per lastUsed più vecchio
  distruggi le texture fino a rientrare nel budget
  marca le surface corrispondenti come resourceDirty + contentDirty
non evictare texture ancora in uso da un render pass
```

**Pseudocodice — resolution hysteresis:**

```text
risoluzione desiderata = dimensione base × DPR × scala apparente
se desiderata supera significativamente quella residente:
  pianifica nuova texture più nitida
se desiderata è molto minore della residente per un intervallo stabile:
  pianifica downgrade della texture
```

La qualità del campionamento, gli zoom estremi e la risoluzione di cattura disponibile nell'API devono essere misurati: non dare per scontato che `drawElementImageToTexture` sia un renderer arbitrario a risoluzione infinita.

### 12.3 Metriche minime per gli esperimenti

| Metrica | Definizione operativa |
|---|---|
| `frame.cpuMs` | Tempo sincrono dall'ingresso in `render()` al ritorno di `queue.submit()`; non misura esecuzione GPU né presentazione |
| `frame.uploadCount` | Chiamate WICG `drawElementImageToTexture` emesse dal render |
| `frame.drawCount` | Chiamate `pass.draw(6)` emesse dal render |
| `scene.visible` | Surface allocate con intersezione ad area positiva con la viewport in pixel backing |
| `scene.total` | Nodi registrati nella scena, inclusi quelli senza snapshot |
| `gpu.estimatedBytes` | Stima RGBA8 pari alla somma di `surface.width * surface.height * 4` per tutte le texture allocate, incluse quelle fuori schermo |
| `input.latencyMs` | Latenza percepita/strumentata nei test di input |
| `gpu.deviceLost` | Conteggio dei device loss |

La stima RGBA8 esclude mipmap, copie temporanee, alignment, overhead del browser/GPU e memoria del canvas. Il contatore `frame.cpuMs` si ferma subito dopo il ritorno sincrono di `queue.submit()` e non comprende l'esecuzione GPU né la presentazione. L'uso di GPU timestamp queries va verificato come feature separata.

La scena conserva l'ordine autorevole in una `Map<Element, SceneNode>`. `geometryDirty` rappresenta cambi di posizione, camera o z-order; `surface.contentDirty` rappresenta solo contenuto da acquisire nuovamente. Ogni render proietta le surface allocate, aggiorna la geometria DOM se sporca o non ancora registrata, quindi carica e disegna soltanto le surface con intersezione positiva. Le intersezioni parziali restano visibili e vengono ritagliate dalla viewport GPU. Un upload dirty fuori schermo resta in sospeso fino a quando la surface torna visibile. Dopo `raise()`, la geometria viene riapplicata in ordine scena completo per riallineare hit testing e composizione.

## 13. Testing: matrici e benchmark

### 13.1 Test funzionali prioritari

| Area | Casi da testare |
|---|---|
| Preflight | API mancanti, flag spenti, WebGPU assente |
| Snapshot | Primo paint, CSS change, testo, immagini, font caricati |
| HTML | Form, input, focus, selezione, copy/paste, caret |
| Geometry | Coordinate 0/negative, DPR 1/2, zoom 0,5/1/2, resize |
| Layers | Overlap, z-order, gruppi, nested drawable, clip |
| Lifecycle | add → remove → re-add, detached DOM, texture destruction |
| GPU | Semi-trasparenza, texture resize, device loss, resize framebuffer |
| Security | Contenuti cross-origin esclusi o ridotti secondo specifica |
| Interactions | Click, drag handle, pointercancel, touch, tastiera, wheel |
| A11y | Elementi fuori viewport, focus order, screen reader manuale |

### 13.2 Benchmark ripetibili

Scegliere una macchina e GPU di riferimento; documentare risoluzione, DPR, build e flag. Misurare scene con 1, 10, 100, 500 e 1.000 superfici, distinguendo **nodi totali** da **nodi visibili**. Eseguire quattro workload: scena statica, movimento solo geometrico, modifiche frequenti a testo/stili, pan+zoom con culling. Ripetere più volte, riportando mediana e percentili dei frame time, memoria stimata e numero di upload. Confrontare almeno due strategie *nello stesso browser*: baseline senza caching vs invalidazione selettiva.

### 13.3 Test automatizzati

Il core matematico può usare `node --test` con file `.test.mjs` e `node:assert/strict`; i comportamenti WICG/WebGPU devono essere verificati **nel browser target** con pagine di test e, se utile, un runner browser automation di sviluppo. L'automazione non modifica il requisito di zero dipendenze runtime.

## 14. Gestione errori e lifecycle

L'engine deve avere stati espliciti: `new → initializing → ready → stopped → destroyed`, più `failed` per errori irrimediabili. Non permettere `add()` prima di `ready` se l'API pubblica non prevede una coda; non chiamare WebGPU dopo `destroy()`; non aggiornare geometry per nodi rimossi.

**Pseudocodice — destroy:**

```text
destroy(engine):
  passa allo stato destroyed; blocca nuovi paint e input gestiti
  cancella rAF pendenti e stacca ResizeObserver/listener proprietari
  per ciascuna surface:
    canvas.clearElementGeometry(element)
    distruggi texture e uniform buffer posseduti
    rimuovi references in registri e cache
  libera le risorse generali possedute (buffer, pipeline references, cache)
  svuota scene e code dirty
  non rimuovere automaticamente i veri elementi DOM applicativi
```

Per M1, in caso di `device.lost` arrestare chiaramente il motore e segnalare lo stato; solo dopo aver stabilizzato le risorse introdurre un recovery con nuovo `GPUDevice`, ricreazione pipeline, texture, buffer e piena invalidazione del contenuto.

## 15. Piano di lavoro esecutivo

### Step 0 — Capability probe (obbligatorio)

**Artefatti:** `tests/wicg-smoke.html`, `docs/CHROMIUM_TARGET.md`.  
**Done se:** il form funziona nell'esempio Canvas 2D e le API WebGPU sono rilevate, con versione/flag registrati.

### Step 1 — Una surface HTML in WebGPU

**Artefatti:** init GPU, acquisizione texture, shader WGSL, quad pipeline, pagina `gpu-single.html`.  
**Done se:** card e input sono visibili, posizionati correttamente, con alfa corretto e click allineato; non ci sono validation errors.

### Step 2 — Più surface

**Artefatti:** `scene.js`, `surfaces.js`, registrazione e cleanup, z-order.  
**Done se:** 10 card con overlap ricevono l'input sulla card in primo piano, e `remove` pulisce hit geometry e VRAM.

### Step 3 — Trasformazioni interattive

**Artefatti:** camera pan/zoom, drag handle, sincronizzazione matrici.  
**Done se:** click/input restano allineati dopo pan, zoom e resize, compreso DPR 2.

### Step 4 — Scheduler e invalidazione

**Artefatti:** `scheduler.js`, telemetria; cambi content vs geometry.  
**Done se:** muovere una card senza modificarne il contenuto non determina un upload HTML a ogni frame; la modifica del testo produce aggiornamento.

### Step 5 — Prestazioni e robustezza

**Artefatti:** benchmark, culling, budget memoria, error logging e lifecycle test.  
**Done se:** risultati ripetibili e nessun leak osservato nei cicli add/remove; soglie di performance stabilite in base ai dati misurati.

### Step 6 — Primo effetto WGSL

**Artefatti:** shader effect minimale, test input e alpha.  
**Done se:** l'effetto è disattivabile e non rompe rendering, focus, layering e cleanup. Gli effetti deformanti complessi restano fuori scope.

## 16. Checklist di revisione per ogni PR

- La modifica introduce davvero una capacità assente nelle API native?
- Il codice è JavaScript ES Modules vanilla senza dipendenze runtime o build obbligatorie?
- Ogni riferimento DOM mantiene il ciclo di vita corretto?
- Ogni `GPUTexture`/buffer ha un owner e un percorso di distruzione?
- Gli stati dirty distinguono contenuto, geometria e risorse?
- La stessa matrice governa composizione visiva e geometria DOM?
- Il test è stato eseguito sulla build Chromium registrata?
- I fallimenti sono visibili e spiegati, invece di usare fallback silenziosi?
- Le metriche dichiarate sono misurate e riproducibili?
- Le nuove astrazioni sono minime e motivate?

## 17. Definizioni di done e regole per l'agente di implementazione

**M0–M3 non sono done** se mancano i test di input, se non è registrata la versione Chromium o se la demo funziona visivamente ma il click non coincide col rendering. Ogni step deve consegnare sorgenti, istruzioni di avvio, esiti dei test e una breve nota su limitazioni/rischi.

Per un agente di coding:

1. Leggere integralmente questo documento e l'analisi funzionale.
2. Non cambiare stack o obiettivi per comodità. No TypeScript, React, Vite, Three.js o WebGL fallback.
3. Implementare **uno step alla volta** e misurarne l'esito.
4. Utilizzare le firme documentate; non inventare metodi WICG.
5. Se Chrome target non espone il metodo previsto, raccogliere evidenza (versione/API/errore), fermare quello step e riportare il blocco.
6. Non creare astrazioni generiche o classi premature; preferire funzioni e moduli piccoli.
7. Trattare come incerti i casi che richiedono verifica empirica: DPR, correttezza hit test, alpha, performance, comportamenti IME, timeline `paint`.
8. Documentare esplicitamente ciò che è codice eseguibile, pseudocodice, ipotesi, test superato o test non eseguito.

## 18. Fonti e gerarchia delle evidenze

**Primarie:**

- https://wicg.github.io/html-in-canvas/ — semantiche `content`, `drawable`, `paint`, `drawElementImageToTexture`, `updateElementGeometry`, WebIDL, sicurezza.
- https://github.com/WICG/html-in-canvas — repository di riferimento, esempi e issue.
- https://developer.chrome.com/blog/html-in-canvas-ot-changes — differenze Chrome 150/155, nuovi nomi/firme, Origin Trial.
- https://developer.chrome.com/blog/html-in-canvas-origin-trial — contesto e benefici attesi.

**Gerarchia:** (1) prove effettuate e registrate sulla build target; (2) documentazione ufficiale WICG/Chrome aggiornata; (3) decisioni progettuali; (4) ipotesi da benchmark. In caso di divergenze, non «correggere» ciecamente l'API: creare un caso minimo riproducibile e aggiornare la baseline dopo averne capito il motivo.

---

**Conclusione operativa:** la prima vera prova del framework non è lo shader più spettacolare, ma la sincronizzazione perfetta di una card HTML reale fra contenuto Blink, texture GPU, trasformazioni e interazioni native. Tutto il resto deve crescere su questa base verificata.
