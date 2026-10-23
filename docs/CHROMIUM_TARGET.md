# Target Chromium M0

## Stato

Il preflight M0 e i controlli automatizzati sono passati su una build Chrome Canary fissata. Il test manuale di copia e incolla resta aperto. M1 non parte finché quel controllo non passa.

## Build registrata

| Campo | Valore |
|---|---|
| Data | 2026-10-23 |
| Prodotto | Chrome for Testing |
| Canale | Canary |
| Versione | `158.0.8119.0` |
| Revisione Chromium | `1725371` |
| Sistema | Windows 10 Pro, build `19045`, 64 bit |
| GPU | Intel HD Graphics 620, WebGPU `intel`, architettura `gen-9` |
| Driver GPU | `27.20.100.8854` |
| Device pixel ratio | `1.25` |
| Flag HTML-in-Canvas | `--enable-blink-features=CanvasDrawElement` |
| Feature Web Platform sperimentali | Non abilitata |
| Server | `http://127.0.0.1:8000`, bind locale |
| Porta DevTools | `127.0.0.1:9222`, attiva solo durante la sessione di prova |
| Commit o snapshot | Revisione `1725371` dal manifest Chrome for Testing |
| Adapter WebGPU | Disponibile. M0 non crea un `GPUDevice` e non invoca l'upload WICG |

Chrome for Testing proviene dal [manifest ufficiale Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json) e dal relativo bucket Google. Su Windows, `chrome.exe` risulta `NotSigned` secondo Authenticode. Versione rilevata: `158.0.8119.0`. SHA-256 dell'eseguibile: `53CE0A34579AC72736F203F05BAEAA352FE62A8B751312299089E18FEF2E9A99`.

Il vecchio flag UI `chrome://flags/#canvas-draw-element` ha scadenza al milestone 156 nel [metadata Chromium dei flag](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/flag-metadata.json). Per Canary 158 il launcher usa il nome runtime `CanvasDrawElement` con `--enable-blink-features`. Il [blog Chrome](https://developer.chrome.com/blog/html-in-canvas-ot-changes) mantiene HTML-in-Canvas nell'Origin Trial fino a Chrome 160.

## Esiti API

Il test `tests/m0-browser-check.mjs` ha rilevato tutte le 12 capacità elencate qui. Il report completo è in `.audit/m0-browser-results.json`.

| ID | Stato | Evidenza |
|---|---|---|
| `canvas-content-drawable` | pass | attributo letto dal DOM |
| `canvas-drawable-child` | pass | attributo letto dal DOM |
| `nested-drawable-child` | pass | attributo letto dal DOM |
| `canvas-requestPaint` | pass | metodo presente e primo evento ricevuto |
| `canvas-updateElementGeometry` | pass | metodo presente |
| `canvas-clearElementGeometry` | pass | metodo presente |
| `canvas-getElementImageDefaultSize` | pass | metodo presente |
| `canvas-2d-drawElementImage` | pass | metodo presente e card disegnata |
| `webgpu-navigator-gpu` | pass | `navigator.gpu` presente |
| `webgpu-GPUQueue-constructor` | pass | costruttore presente |
| `webgpu-drawElementImageToTexture` | pass | metodo presente; non invocato in M0 |
| `paint-event-changedElements` | pass | evento osservato con due elementi iniziali |

La richiesta WebGPU ha restituito un adapter Intel `gen-9`. L'API non crea un device GPU né una texture in questa fase.

## Scenari

| ID | Stato | Evidenza |
|---|---|---|
| `card-visible` | pass | screenshot `.audit/m0-browser.png` |
| `card-button-click` | pass | click CDP nel punto disegnato; listener attivato |
| `input-focus-selection-copy-paste` | not-run | focus, selezione e inserimento test passati; copia e incolla restano manuali |
| `title-refresh` | pass | il titolo aggiornato è visibile nello screenshot |
| `paint-idle` | pass | nessun nuovo paint per quattro controlli consecutivi a intervalli di 250 ms dopo il primo frame |
| `nested-drawable-exclusion-order` | pass | screenshot mostra la surface annidata disegnata a destra della card; il codice disegna prima `card`, poi `nested-card` |
| `browser-errors` | pass | listener della pagina per gli errori JavaScript durante il caricamento e il test; CDP per eccezioni durante il test; nessuna risposta HTTP 4xx osservata dopo l'attivazione di `Network.enable` |
| `devtools-api-presence` | pass | 12 capacità lette nel realm della pagina tramite Chrome DevTools Protocol |

`event.changedElements` ha riportato `nested-card` prima di `card`. Questo elenco segnala gli elementi modificati. L'ordine di disegno resta quello delle chiamate esplicite a `drawElementImage` nel listener `paint`.

## Avviare il test

Apri un terminale PowerShell nella root del progetto ed esegui:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-wicg-smoke.ps1
```

Chrome for Testing apre una finestra in incognito con un profilo dedicato sotto `%LOCALAPPDATA%\html-in-canvas-env`. Il server resta legato a `127.0.0.1`. Il flag `--enable-blink-features=CanvasDrawElement` abilita la singola feature. Non abilitare `--enable-experimental-web-platform-features` per questo test.

Quando la pagina è aperta, esegui il controllo automatico in un secondo terminale:

```powershell
node .\tests\m0-browser-check.mjs
```

Esegui il test una volta per ogni nuova finestra. Chiudi Chrome per fermare il server locale. Il test non usa il clipboard di Windows.

Per completare il controllo manuale, nel campo seleziona tutto con `Ctrl+A` e copia con `Ctrl+C`. Poi sostituisci il contenuto digitando `rimpiazza`. Seleziona tutto con `Ctrl+A`, incolla con `Ctrl+V` e verifica che ricompaia `M0 input check`. Il testo temporaneo diverso rende osservabile che l'incolla ha davvero ripristinato il valore copiato.

## Riferimenti

- [Explainer WICG HTML-in-Canvas](https://github.com/WICG/html-in-canvas) per gli attributi, l'evento `paint` e le API Canvas.
- [Aggiornamenti Chrome 150 e 155](https://developer.chrome.com/blog/html-in-canvas-ot-changes) per le firme recenti e le regole di sincronizzazione.
- [Chrome for Testing](https://developer.chrome.com/docs/automation-and-testing/download-test-binaries) per le build di test e il manifest dei download.
- [Flag Chromium](https://developer.chrome.com/blog/browser-flags/) per l'uso dei flag in un browser di sviluppo separato.
- [Runtime features Chromium](https://chromium.googlesource.com/chromium/src/+/HEAD/third_party/blink/renderer/platform/runtime_enabled_features.json5) per il nome `CanvasDrawElement`.
