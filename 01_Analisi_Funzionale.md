# Native HTML Canvas Engine
## Analisi funzionale e requisiti di prodotto

**Versione:** 1.0 — 23 ottobre 2026  
**Stato:** baseline progettuale; implementazione non ancora validata su una build Chrome specifica  
**Ambito:** framework grafico HTML-in-Canvas, esclusivamente Chrome/Chromium, solo HTML/CSS/JavaScript vanilla

> **Sintesi.** Costruire un runtime 2D capace di visualizzare e manipolare veri elementi HTML in una scena Canvas, sfruttando il motore DOM/CSS di Blink per contenuto, layout e semantica e WebGPU per composizione grafica ed effetti. La piattaforma deve introdurre solo le capacità non già fornite nativamente dal browser.

## 1. Visione e problema

Lo sviluppo di editor visuali, lavagne infinite, strumenti creativi e interfacce ibride richiede oggi due mondi difficili da unire: il DOM, ricco di layout CSS e semantica, e il rendering Canvas/GPU, efficiente nelle trasformazioni e negli effetti grafici. Le soluzioni tradizionali ricostruiscono tipografia, hit testing, focus, layout o intere gerarchie di componenti; producono spesso codice duplicato, comportamenti non nativi e costi di manutenzione.

La proposta [WICG HTML-in-Canvas](https://github.com/WICG/html-in-canvas) consente invece di disegnare snapshot di sottoalberi HTML in un Canvas 2D oppure in texture WebGL/WebGPU, mantenendo i contenuti nel DOM e sincronizzandone posizione, interazioni e informazioni di accessibilità. Il progetto vuole utilizzare direttamente queste primitive, senza simulare un browser dentro un browser.

**Risultato atteso:** una piccola piattaforma, indipendente da framework UI, che permetta a HTML e CSS di definire il contenuto e a JavaScript di governare posizione, trasformazioni, composizione e risorse GPU.

## 2. Decisioni già prese e vincoli non negoziabili

| Area | Decisione | Implicazione |
|---|---|---|
| Browser | **Solo Chrome/Chromium**, su versione sperimentale verificata | Nessun supporto Firefox/Safari; si accetta il vincolo di versione |
| Linguaggi | **HTML puro, CSS puro, JavaScript vanilla** | Niente TypeScript, JSX, React, Vue o Svelte |
| Moduli | ES Modules nativi | `import`/`export` senza bundler obbligatorio |
| DOM e stili | Motore nativo Blink | Nessun Virtual DOM, nessun motore CSS o layout proprietario |
| Rendering contenuti | API WICG HTML-in-Canvas | `content="drawable"`, `drawable`, evento `paint` |
| Composizione | WebGPU e WGSL | Renderer 2D proprietario ridotto al minimo indispensabile |
| Eventi nei contenuti | Eventi DOM nativi | Niente emulazione di input, focus o form |
| Compatibilità | Nessun polyfill e nessun fallback ad altri browser | Fallimento esplicito se la build non soddisfa i requisiti |
| Dipendenze runtime | Zero come obiettivo iniziale | Non introdurre PixiJS, Three.js, Konva o Fabric nel core |
| Build | Non obbligatoria | Avvio con semplici file statici serviti via HTTP |
| Priorità | **Rendering 2D prima del 3D** | Prima validazione, poi ottimizzazione e funzionalità avanzate |

**Nota sul carattere sperimentale.** La proposta è un documento in evoluzione. Le API documentate per Chrome 155+ rappresentano il riferimento iniziale, ma il supporto esatto dipende dalla build e dai flag abilitati. Non viene assunto che tutte le API funzionino già in produzione su ogni installazione di Chrome.

## 3. Che cosa è il prodotto

Il prodotto è un **runtime di composizione grafica nativo per Chrome**, non un nuovo framework applicativo e non una libreria di componenti visuali. Le applicazioni restano libere di manipolare direttamente i nodi DOM, utilizzare CSS e gestire lo stato con normali oggetti JavaScript.

Il runtime aggiunge quattro capacità:

1. **Scene:** collocare e organizzare elementi HTML reali e primitive GPU in una scena con coordinate, ordinamento e gerarchie.
2. **Composizione:** acquisire snapshot HTML e inserirli in un output WebGPU con trasformazioni, clipping ed effetti.
3. **Sincronizzazione:** mantenere coerenti il contenuto visivo e la geometria usata da input e accessibilità.
4. **Efficienza:** distinguere le modifiche al contenuto dalle modifiche geometriche e riutilizzare texture e risorse.

Non deve imporre un pattern per lo stato applicativo, creare template proprietari o nascondere le API browser dietro livelli inutili.

## 4. Attori e scenari d'uso

**Sviluppatore vanilla:** scrive HTML/CSS standard, importa un modulo JS, registra gli elementi `drawable`, associa trasformazioni e opzionalmente shader. Può usare direttamente `addEventListener`, `classList`, `dataset`, Web Animations API e CSS.

**Utente finale:** interagisce con pannelli, pulsanti, input e testo collocati dentro un Canvas; sposta e ingrandisce la scena, conserva focus e funzionalità del DOM quando supportate dall'implementazione sperimentale.

**Manutentore del motore:** verifica il comportamento su una build Chromium fissata, profila pipeline e memoria, aggiorna deliberatamente il binding WICG quando la proposta cambia.

### Scenari prioritari

- **Infinite canvas:** centinaia di card HTML posizionate in uno spazio navigabile con pan, zoom, drag, ordinamento e selezione.
- **Editor visuale:** superfici HTML autentiche accostate a figure o overlay GPU, senza riscrivere form e tipografia.
- **Pannelli grafici:** widget HTML che ricevono effetti WGSL preservando, entro i limiti delle trasformazioni supportate, gli eventi nativi.
- **Interfacce ricche in applicazioni grafiche:** testi con stili complessi, controlli e menu disegnati nella scena.

### Scenari successivi, non inclusi nel primo rilascio

- Elementi HTML proiettati su mesh 3D arbitrarie o deformate da shader con hit testing esatto.
- Collaborazione multiplayer, serializzazione completa della scena e motore undo/redo generalizzato.
- Worker rendering, scene graph 3D completo e importazione automatica di framework esterni.
- Agenti AI che compongono autonomamente la UI: possibile evoluzione, non requisito del nucleo.

## 5. Modello concettuale

### 5.1 DOM come sorgente di verità del contenuto

Ogni `HTML Surface` mantiene un riferimento a un vero `Element`. Il DOM custodisce testo, figli, attributi, stili, valori dei controlli e semantica. Il runtime non conserva una copia dell'intero albero HTML.

Un elemento `drawable` può includere discendenti ordinari; un discendente anch'esso marcato `drawable` definisce invece una superficie disegnabile indipendente ed è escluso dallo snapshot del suo antenato `drawable`. Questo deve essere considerato quando si compongono pannelli annidati.

### 5.2 Scene graph leggero

La scena deve conoscere **solo metadati grafici**: identità stabile del nodo, parent, trasformazione, ordine di disegno, visibilità, clipping, eventuale effetto, riferimenti alle risorse e dirty flags.

Tipi logici iniziali:

- **Group:** gerarchia delle trasformazioni, ordinamento e visibilità; non produce per forza pixel.
- **HTML Surface:** riferimento DOM + texture derivata dalla sorgente `drawable`.
- **Graphics Surface:** primitiva, shader o texture GPU disegnata senza sorgente DOM.

### 5.3 Coordinate

Distinguere rigorosamente: coordinate CSS, coordinate della griglia/backing Canvas, coordinate della scena, coordinate camera e clip-space WebGPU. Ogni conversione deve essere definita e testata. `devicePixelRatio` non va moltiplicato o ignorato implicitamente.

### 5.4 Separazione fra contenuto e geometria

- **Content dirty:** testo, CSS, input, dimensions o altri cambi che alterano lo snapshot; richiede un aggiornamento dell'immagine/texture.
- **Geometry dirty:** traslazione, scala, rotazione, camera, ordine o clipping; può richiedere solo nuova composizione GPU e aggiornamento della geometria DOM.
- **Resource dirty:** necessità di ricreare risorse GPU per dimensione, formato o device loss.

Questa separazione è un principio di prodotto, non un dettaglio opzionale.

## 6. Requisiti funzionali

| ID | Requisito | Priorità | Verifica |
|---|---|---|---|
| RF-01 | Registrare un elemento DOM `drawable` come superficie | P0 | Si vede nella scena |
| RF-02 | Usare CSS nativo per tipografia, colori, layout e form | P0 | Snapshot corretto di un form reale |
| RF-03 | Comporre più superfici con WebGPU | P0 | Ordine e trasparenze coerenti |
| RF-04 | Applicare posizione e scala senza rigenerare sempre lo snapshot | P0 | Metrica upload inferiore ai frame nei movimenti statici |
| RF-05 | Allineare hit testing con il rendering | P0 | Click/focus nella posizione visualizzata |
| RF-06 | Rilevare modifiche visuali dal ciclo `paint` | P0 | Mutazione DOM produce aggiornamento visivo |
| RF-07 | Gestire resize Canvas e DPR | P0 | Nessun disallineamento sostanziale |
| RF-08 | Rimuovere superfici e liberare risorse | P0 | Nessuna risorsa persistente dopo destroy |
| RF-09 | Pan e zoom camera di scena | P1 | Input e contenuti restano allineati |
| RF-10 | Drag delle superfici | P1 | Drag non interferisce con input e pulsanti |
| RF-11 | Ordinamento, gruppi e visibilità | P1 | Render order e hit order coerenti |
| RF-12 | Viewport culling | P1 | Nodi esterni non composti inutilmente |
| RF-13 | Effetti WGSL applicabili a una superficie | P2 | Effetto visivo senza perdita dei valori DOM |
| RF-14 | Rendering adattivo alla risoluzione | P2 | Nitidezza prevedibile durante zoom |
| RF-15 | Worker e OffscreenCanvas | P3 | Solo su benchmark favorevole |
| RF-16 | 3D avanzato e superfici deformabili | P3 | Progetto separato |

**P0 = necessario per validare il nucleo.** P1 = primo runtime usabile. P2 = evoluzione prestazionale/creativa. P3 = ricerca futura.

## 7. Requisiti non funzionali

### 7.1 Semplicità e dipendenze

Il percorso base deve poter essere importato con uno `<script type="module">` da file serviti in HTTP. Nessun transpiler, registro di componenti o framework di stato. Anche il codice WebGPU deve restare in moduli JS nativi. Eventuali dipendenze di sviluppo non devono diventare vincoli runtime.

### 7.2 Performance misurabili

La velocità è un obiettivo da misurare, non un'affermazione preventiva. Monitorare almeno: costo di snapshot/paint DOM, chiamate `drawElementImageToTexture`, memoria delle texture, frame time CPU, frame time GPU quando disponibile, latenza input e numero di nodi visibili. Non definire una promessa di 60 FPS senza benchmark su hardware reale.

### 7.3 Gestione memoria

Una card da 320×200 CSS px a DPR 2 costa circa 0,98 MiB per una sola texture RGBA8 non compressa, prima di overhead e buffer. Mille superfici residenti equivalgono teoricamente a circa 977 MiB: sono obbligatori culling, politiche di cache e cleanup. Non dedurre però dalla quantità di card che tutte debbano avere una texture dedicata residente.

### 7.4 Accessibilità

Il contenuto mantiene semantica DOM; la geometria di una superficie WebGPU deve essere aggiornata esplicitamente. Focus, selezione, tastiera, screen reader, caret e interazioni complesse vanno testati: la presenza della proposta API non garantisce che ogni combinazione funzioni correttamente nella build sperimentale.

### 7.5 Affidabilità

Errore leggibile se WebGPU o le API WICG richieste non sono disponibili. Gestione esplicita di GPU device loss, resize, texture destruction, nodi staccati, cancellazione di drag e race fra invalidazioni. Nessun fallback a WebGL o a browser alternativi nel runtime base.

### 7.6 Sicurezza e riservatezza

La specifica esclude dal rendering leggibile certe informazioni sensibili, in particolare contenuti cross-origin e informazioni di browser/OS. Non promettere che iframe cross-origin, contenuti autofill o alcuni elementi di UI di sistema vengano riprodotti nelle texture. Il framework non deve tentare di bypassare queste restrizioni.

## 8. Percorsi utente chiave e criteri di accettazione

### UC-01 — Aggiungere una card HTML

1. Lo sviluppatore inserisce una `article[drawable]` nel Canvas.
2. Registra l'elemento nel motore con coordinate iniziali.
3. La superficie compare nella scena dopo il primo snapshot valido.
4. La modifica del suo titolo in DOM aggiorna la rappresentazione senza sostituire l'elemento.

**Accettazione:** il click su un pulsante figlio invoca lo stesso listener DOM registrato prima del rendering.

### UC-02 — Spostare una card

1. Una trasformazione aggiorna il nodo scenico.
2. Il compositore riutilizza la texture esistente quando valida.
3. La geometria DOM viene sincronizzata con la posizione disegnata.

**Accettazione:** durante un drag senza modifiche al contenuto, il numero di upload HTML non cresce necessariamente uno-a-uno coi frame; i click rimangono nella posizione resa.

### UC-03 — Zoom della scena

1. La camera cambia scala e traslazione.
2. Il runtime ricompone le superfici visibili.
3. Se la qualità della texture degrada oltre soglia, pianifica una nuova cattura a risoluzione idonea.

**Accettazione:** assenza di salti di posizione, focus incoerente e riallocazioni incontrollate. Le politiche di risoluzione richiedono test specifici.

### UC-04 — Cambiare il contenuto

1. Cambia testo, stile o valore visibile dell'input.
2. Chrome genera il relativo nuovo snapshot e segnala le modifiche nel ciclo `paint`.
3. Il runtime invalida e aggiorna la superficie interessata.

**Accettazione:** valori e focus non vengono perduti; nessuna ricostruzione artificiale del DOM.

## 9. Non obiettivi espliciti

Non implementare: browser engine, DOM virtuale, parser HTML/CSS, flexbox o grid proprietari, sistemi di componenti JSX, cross-browser adapter, polyfill per versioni Chrome precedenti, game engine general-purpose, motore 3D completo, serializzazione d'applicazione, package manager obbligatorio, sincronizzazione remota del documento.

## 10. Milestone di prodotto

| Milestone | Obiettivo | Gate di uscita |
|---|---|---|
| M0 — Capability probe | Validazione Chrome e firma delle API | Smoke test WICG e WebGPU ripetibile |
| M1 — Single surface | HTML reale → texture → Canvas | Un input e un pulsante funzionano |
| M2 — Multiple surfaces | Compositore GPU e gestione nodi | Z-order, resize e cleanup verificati |
| M3 — Infinite canvas | Pan, zoom e drag | Hit testing e camera allineati |
| M4 — Scaling | Dirty tracking e culling | Benchmark tracciati, budget memoria definito |
| M5 — Effects | Primo shader WGSL modulare | Nessuna regressione dei casi M0–M4 |

Un gate non superato impone di correggere il nucleo: non aggiungere nuovi layer per mascherare un bug nella specifica o nell'integrazione.

## 11. Rischi, limiti e questioni aperte

| Rischio / decisione aperta | Gravità | Strategia |
|---|---|---|
| L'API cambia fra build sperimentali | Alta | Versione Chromium pin + probe + aggiornamenti deliberati |
| Mapping DOM/Canvas a zoom, rotazione e DPR | Alta | Matrici esplicite e test input/visuali |
| Snapshot iniziale non ancora disponibile | Alta | Rendere solo al primo `paint` valido; gestire eccezioni |
| Input complessi, IME, selezione, caret | Alta | Suite manuale e automatizzata su Chrome target |
| Eccessivo consumo VRAM | Alta | Culling, eviction, budget; misurare prima dell'atlas |
| Comportamento dei nested `drawable` | Media | Testare ordine e composizione per ogni gerarchia |
| Shader deformanti non invertibili | Alta | Fuori scope del primo runtime interattivo |
| Devtools/browser profiling insufficiente | Media | Telemetria interna senza promettere timing GPU accurato ovunque |
| CSS particolari e contenuti cross-origin | Media | Test matrice e limitazioni documentate |

**Questioni da decidere dopo M0–M2:** naming pubblico definitivo; shader plug-in API; camera con coordinate infinite/precisione elevata; atlasing; serializzazione della scena; worker; API 3D. Sono deliberatamente lasciate aperte, perché le misure e i limiti della build sperimentale possono influenzare la scelta migliore.

## 12. Definizione di successo

Il progetto è tecnicamente riuscito quando si può costruire un canvas infinito in HTML/CSS/JavaScript vanilla, renderizzato in WebGPU, con più card DOM reali, pan/zoom/drag, input e focus testati, risorse correttamente liberate e prestazioni osservabili. Non basta mostrare un effetto visivo convincente; devono funzionare contenuto, sincronizzazione e lifecycle.

Il valore differenziante è **la massima composizione con la minima duplicazione del browser**: Blink per le funzioni proprie di HTML e CSS; HTML-in-Canvas come ponte nativo; un runtime piccolo e misurabile solo per ciò che resta da orchestrare.

## 13. Fonti primarie e note di validazione

1. WICG HTML-in-Canvas, proposta vivente: https://github.com/WICG/html-in-canvas
2. Explainer con WebIDL, `paint`, geometria, demo e note di sicurezza: https://wicg.github.io/html-in-canvas/
3. Chrome Developers, aggiornamenti API in Chrome 150/155 e stato Origin Trial: https://developer.chrome.com/blog/html-in-canvas-ot-changes
4. Chrome Developers, introduzione tecnica HTML-in-Canvas: https://developer.chrome.com/blog/html-in-canvas-origin-trial

**Distinzione epistemica:** le primitive WICG e le loro firme sono documentazione pubblica; la separazione content/geometry dirty, la struttura del runtime e i gate di sviluppo sono decisioni progettuali; la compatibilità reale della build, la qualità delle interazioni e i benefici prestazionali sono ipotesi da verificare empiricamente.
