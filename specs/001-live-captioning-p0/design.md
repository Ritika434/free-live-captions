# Design 001: Live Captioning — P0 Technical Design

Implements: [spec.md](./spec.md)

## 1. Architecture Overview

Manifest V3 forces the background script to be a headless, non-persistent service worker — it cannot touch `AudioContext`, `getUserMedia`, or DOM audio APIs. So the pipeline splits across four contexts that only talk to each other via `chrome.runtime` messaging:

```
┌─────────────┐   click    ┌────────────────────┐   streamId    ┌──────────────────────────┐
│  popup.html  │ ─────────▶│ background.js       │──────────────▶│ offscreen.html/.js        │
│ (controls)   │◀───status──│ (service worker,    │                │ (DOM context, owns:       │
└─────────────┘            │  orchestration only)│                │  - tabCapture stream       │
       ▲                    └────────────────────┘                │  - AudioWorklet chunking   │
       │ prefs (chrome.storage.local)                              │  - Transformers.js model   │
       │                                                            │    (Whisper/Moonshine,     │
       │                     text results (chrome.runtime.sendMessage)   WebGPU→WASM fallback)  │
       │                    ┌────────────────────┐                └──────────────┬─────────────┘
       └────────────────────│ content.js/.css     │◀────────────────────────────┘
                             │ (Shadow DOM overlay │
                             │  on the active tab) │
                             └────────────────────┘
```

Why an offscreen document: `chrome.tabCapture.getMediaStreamId()` is called from the background worker, but the actual `getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId } } })` call and all subsequent `AudioContext` work must happen in a real DOM document — that's what `chrome.offscreen` exists for in MV3.

## 2. Component Breakdown

### 2.1 `manifest.json`
```json
{
  "manifest_version": 3,
  "name": "Free Live Captions",
  "version": "0.1.0",
  "permissions": ["tabCapture", "offscreen", "activeTab", "storage", "downloads"],
  "host_permissions": ["http://*/*", "https://*/*", "file://*/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "popup.html" },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"],
    "css": ["content.css"],
    "run_at": "document_idle"
  }]
}
```
`file://*/*` is only exercised once the user has explicitly flipped "Allow access to file URLs" in `chrome://extensions` (FR7) — the permission being declared does not itself grant local-file access; that's a separate user toggle.

### 2.2 `background.js` (service worker)
Responsibilities only:
- On toolbar click / popup message: get the active tab, call `chrome.tabCapture.getMediaStreamId({ targetTabId })`, ensure an offscreen document exists (`chrome.offscreen.createDocument` if not already open — MV3 allows only one offscreen document per extension, so this must be idempotent), and forward `{ type: 'start-capture', streamId, tabId }`.
- Relay `stop-capture` on toggle-off or tab close (`chrome.tabs.onRemoved`).
- Relay transcript results from offscreen → content script of the correct tab, and → popup if open.
- No model logic, no audio logic, no persistent state beyond what's needed to re-derive session status on wake (service worker can be evicted mid-session; treat it as stateless and re-query `chrome.offscreen.hasDocument()` / offscreen-held state on every wake).

### 2.3 `offscreen.js` (offscreen document)
Owns the entire audio → text pipeline:

1. **Capture**: `getUserMedia` with the tab `streamId` → `MediaStream`.
2. **Chunking**: `AudioContext({ sampleRate: 16000 })` → `MediaStreamAudioSourceNode` → **`AudioWorkletNode`** (not `ScriptProcessorNode`, which is deprecated and runs on the main thread — the worklet runs on the audio rendering thread and avoids jank). The worklet posts `Float32Array` frames back to `offscreen.js` via its port.
3. **Buffering strategy**: accumulate ~2s chunks with a small overlap (stride ~0.5–1s) between chunks so words aren't cut at chunk boundaries, mirroring the `chunk_length_s` / `stride_length_s` parameters Transformers.js exposes on the ASR pipeline.
4. **Voice activity gating (P0-lite)**: a cheap energy-threshold check skips running inference on near-silent chunks — reduces wasted compute during pauses without needing a full VAD model.
5. **Inference**: Transformers.js `pipeline('automatic-speech-recognition', <model id>, { device: 'webgpu' })`, with a caught-exception fallback that re-initializes the same pipeline with `device: 'wasm'`. Model choice is configurable (§4).
6. **Output**: post `{ type: 'SUBTITLE_UPDATE', text, isFinal, timestampMs }` to `background.js` for relay, and append finalized segments to an in-memory transcript array (source of truth for export, §6).

Offscreen documents are also DOM contexts, so this is where model downloads land in the browser's cache (via the default Transformers.js/Hugging Face caching, which uses the Cache API) — no custom caching layer needed for P0.

### 2.4 `content.js` / `content.css` (per-tab overlay)
- Injects a single host element with `attachShadow({ mode: 'closed' })` so host-page CSS cannot bleed in or out.
- Renders two text states inside the shadow root: an "interim" line (lighter/italic) and the "final" text — mirrors how native OS captions distinguish in-progress vs. committed text.
- **Each finalized segment replaces the previous displayed text**, rather than accumulating into one growing string — matches conventional caption behavior (one utterance visible at a time) and fixes an earlier bug where old and new text blended together and only trimmed word-by-word off the front, so stale text visibly lingered (found via real-world testing, 2026-09-19). A single unusually long segment is still capped at ~160 characters (`MAX_FINAL_CHARS`) by dropping whole words off the *front*, keeping the most recent words — never cut mid-word. This matters because a single finalized segment can itself be long: continuous, pause-free dialogue (movies, shows) can go a long time without tripping the offscreen document's silence-based finalize trigger, so `MAX_SEGMENT_MS` (offscreen.js, currently 8s) force-finalizes periodically regardless. `.box` also carries a hard `max-height: 40vh; overflow: hidden` as a defense-in-depth cap regardless of the above.
- Listens for `document.fullscreenchange`; when the host page's video enters fullscreen, re-parents the caption host element into `document.fullscreenElement` so it isn't clipped, and moves it back on exit.
- Implements drag-to-reposition and a resize handle; persists `{x, y, width}` to `chrome.storage.local` keyed by hostname (so YouTube and Meet can remember different preferred positions).
- Applies live style updates (font size/color/bg opacity/position) pushed from the popup via `chrome.storage.onChanged`, not via a message round-trip through background — simpler and works even if background is asleep.

### 2.5 `popup.html` / `popup.js`
- On/off toggle for the current tab (reflects live session state, queried from background on open).
- Model tier selector (tiny/base/small) with one-line tradeoff copy per option (§4).
- Style controls (font size, color, bg opacity, position reset).
- Export buttons: "Download .txt", "Download .srt", "Clear transcript" — these request the accumulated transcript from the offscreen document (via background relay) and build the file client-side, then trigger `chrome.downloads.download()` on a generated Blob URL.
- Must be fully keyboard-navigable with ARIA labels (FR9) — no custom widgets without a corresponding role/label.

## 3. Model & Hardware Strategy (FR2, FR5)

| Tier | Model candidates | Size | Target hardware | Expected latency |
|---|---|---|---|---|
| Tiny | `onnx-community/moonshine-tiny-ONNX` | ~60MB | Any laptop, integrated GPU or CPU-only | Fast, lower accuracy on accents/jargon |
| Base | `onnx-community/moonshine-base-ONNX` | ~130MB | 8GB+ RAM laptop | Default recommendation for most users |
| Small | *(aliases to Base)* | — | — | Moonshine only ships two sizes; no larger checkpoint exists yet |

**Resolved (2026-09-19)**: shipped Whisper-tiny/base.en first (best-documented integration path through Transformers.js), but real-world testing on live tab audio showed accuracy too poor to be usable. Switched to Moonshine, whose architecture targets exactly this use case (variable-length chunks without Whisper's fixed 30s-window assumption, and its paper claims better accuracy than Whisper at comparable/smaller size for short/live-style audio) — matches what real-world testing showed. This was a judgment call from one real test, not a controlled side-by-side WER benchmark; worth revisiting with actual numbers later (tasks.md Phase 8) if accuracy needs further tuning.

**Quantization (`dtype`) — pinned explicitly (2026-09-19)**: Transformers.js lets encoder-decoder ASR models specify per-module quantization, e.g. `dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }`. This matters because such models — Whisper and Moonshine both included — are documented as sensitive to *encoder* quantization specifically: quantizing it can degrade feature quality into garbled/wrong output, worse on accented or noisy audio ([Transformers.js dtypes guide](https://huggingface.co/docs/transformers.js/en/guides/dtypes)). The library's unstated default dtype is `fp32` on WebGPU but `q8` on WASM — meaning the WASM fallback path was silently running a quantized encoder the whole time we didn't specify `dtype` at all, plausibly contributing to reported accuracy complaints for anyone whose machine fell back to WASM. Now pinned explicitly on every load: `encoder_model: 'fp32'` (protects accuracy, the component that's sensitive) + `decoder_model_merged: 'q4'` (keeps size/memory down, the component that tolerates quantization fine per the same docs). Confirmed both `onnx-community/moonshine-{tiny,base}-ONNX` repos publish these exact per-module ONNX file variants before relying on this.

**Hardware detection** (`background.js` or popup, on first install):
- `'gpu' in navigator` → WebGPU candidate.
- `navigator.deviceMemory` (where available) as a rough RAM signal.
- Recommend Tiny if no WebGPU + <8GB signaled; Base otherwise; never auto-select Small (opt-in only, given its size).

**Fallback chain** (FR5): selected tier fails to load (OOM, WebGPU init error) → retry once on `wasm` device → if that also fails, step down one tier → surface a non-blocking toast explaining what happened and why.

## 4. Messaging Contract

All cross-context messages go through `chrome.runtime.sendMessage` / `onMessage`, tagged with a `target` field so each context can ignore messages not meant for it (background, offscreen, content, popup all share one listener namespace in MV3):

```ts
// start
{ target: 'offscreen', type: 'start-capture', streamId: string, tabId: number, modelTier: 'tiny'|'base'|'small' }
// stop
{ target: 'offscreen', type: 'stop-capture' }
// result (offscreen -> background -> content/popup)
{ target: 'content', tabId: number, type: 'SUBTITLE_UPDATE', text: string, isFinal: boolean, tsMs: number }
// status query (popup -> background)
{ target: 'background', type: 'GET_STATUS', tabId: number }
// export request (popup -> background -> offscreen)
{ target: 'offscreen', type: 'GET_TRANSCRIPT' } -> responds with segment array
```

## 5. Transcript Export (FR6)

`offscreen.js` maintains `segments: { text: string, startMs: number, endMs: number }[]` for the active session, reset on stop or explicit "Clear."

- `.txt`: join finalized segment text with newlines.
- `.srt`: standard SRT numbering + `HH:MM:SS,mmm --> HH:MM:SS,mmm` blocks derived from `startMs`/`endMs`.
- Both built as strings client-side (no library needed), turned into a `Blob`, and saved via `chrome.downloads.download({ url: URL.createObjectURL(blob), filename })`.

## 6. Local File Support (FR7)

No special-cased code path — `chrome.tabCapture` on a `file://` tab works identically to `http(s)://` once the extension has file-URL access. The only P0 work here is: (a) declaring `file://*/*` in `host_permissions`, and (b) an in-popup instructional state (FR7's IF/THEN) that detects `chrome.extension.isAllowedFileSchemeAccess()` and links to `chrome://extensions` if false.

## 7. Accessibility Implementation Notes (FR9)

- Popup built with semantic HTML (`<button>`, `<label for>`, `<fieldset>`/`<legend>` for the model-tier radio group) — no `<div onclick>` controls.
- Live region (`aria-live="polite"`) is **not** used for the on-page caption overlay itself (captions are a visual accommodation, not meant to also spam screen readers reading the host page) — but the popup's status text ("Captions: On", model download progress) does use `aria-live="polite"` so state changes are announced.
- Default caption style ships at ≥4.5:1 contrast (e.g., white text, black background at ≥80% opacity) before any user customization.
- All caption entrance/exit transitions check `matchMedia('(prefers-reduced-motion: reduce)')` and skip animation when set.

## 8. Error Handling & Edge Cases

| Case | Handling |
|---|---|
| User denies tab-capture prompt (rare, but Chrome may prompt) | Popup shows "Capture permission needed" with a retry action. |
| Model download fails (offline on first run) | Show retry UI; do not silently fall back to a broken state. |
| WebGPU context lost mid-session (e.g. GPU driver reset) | Catch and reinitialize on `wasm`; resume without dropping the whole session. |
| Tab audio is silent/muted | VAD gate naturally produces no output; popup shows "Listening..." not an error. |
| DRM-protected stream blocks capture | Detect capture failure, show a clear "This site restricts audio capture" message rather than a generic error. |
| Service worker evicted mid-session | Offscreen document keeps running independently (it's the one holding the audio graph and model); background worker just re-attaches its message relay on next wake. |

## 9. Testing Strategy (maps to spec.md §8 Success Metrics)

- Manual latency check: play a video with known burned-in timestamps, compare caption appearance time.
- WER check: run against a short benchmark clip with a known transcript, at each model tier.
- Network isolation check: DevTools Network panel open during a full session (after first-run model cache) — assert zero requests.
- Accessibility audit: axe-core (or Lighthouse) run against `popup.html`.
