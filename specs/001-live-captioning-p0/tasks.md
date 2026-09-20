# Tasks 001: Live Captioning — P0 Implementation Plan

Implements: [design.md](./design.md) · [spec.md](./spec.md)

Each task lists the requirement(s) it satisfies. Work top-to-bottom within a phase; phases are ordered so there's a runnable (if rough) extension as early as possible.

> **Progress note (2026-09-19)**: Phases 0–6 are implemented in `extension/src` and build cleanly (`npm install && npm run build` → `extension/dist`, syntax-checked, manifest JSON-validated). Checkboxes below distinguish *implemented* from *verified in a live browser* — the latter needs an actual Chrome session playing real tab audio, which wasn't possible to drive end-to-end in this environment. See `extension/README.md` (once added) for manual test steps.

## Phase 0 — Scaffolding
- [x] `manifest.json` with MV3 fields per design.md §2.1 (permissions, host_permissions, background, action, content_scripts)
- [x] `background.js`, `offscreen.html`+`offscreen.js`, `content.js`+`content.css`, `popup.html`+`popup.js` (fully implemented, not just stubs)
- [ ] Load unpacked in `chrome://extensions`, confirm toolbar icon renders and popup opens — **needs manual verification in a real browser**

## Phase 1 — Audio Pipeline (FR1)
- [x] `background.js`: popup-toggle handler → `chrome.tabCapture.getMediaStreamId({ targetTabId })` (handled via the popup's toggle button rather than a separate toolbar-click listener, since `default_popup` already owns the click)
- [x] `background.js`: `chrome.offscreen.createDocument` (idempotent via `chrome.runtime.getContexts` check)
- [x] `offscreen.js`: receives `start-capture`, calls `getUserMedia` with the tab stream id
- [x] `offscreen.js`: `AudioContext({ sampleRate: 16000 })` + `AudioWorkletNode` (not `ScriptProcessorNode`) wired to the stream
- [x] `background.js`: `chrome.tabs.onRemoved` / toggle-off → `stop-capture` message; offscreen's `stopSession()` tears down `AudioContext`, disconnects nodes, and stops all tracks
- [ ] Manual check: capture audio from a live YouTube tab, confirm resources release on stop within 1s — **needs a real browser**

## Phase 2 — Local ASR Engine (FR2, FR5)
- [x] Integrate Transformers.js in `offscreen.js`
- [x] Chunk buffering — implemented as VAD-gated growing segments (re-transcribe every 1s, finalize on ~800ms silence or a 30s cap) rather than the originally-sketched fixed-stride windows; same goal (no mid-word cuts, bounded compute), different mechanism
- [x] Energy-threshold VAD gate to skip inference on near-silent audio
- [x] `device: 'webgpu'` init with automatic `device: 'wasm'` fallback, and in-flight-promise caching to avoid duplicate concurrent model loads
- [x] **Whisper vs. Moonshine decided: Moonshine.** Started on Whisper-tiny/base.en (best-documented path first); real-world testing on live tab audio showed accuracy was too poor to ship. Switched to `onnx-community/moonshine-{tiny,base}-ONNX` (2026-09-19) — matches Moonshine's published claim of better accuracy than Whisper at comparable/smaller size for short/live-style audio. No formal WER benchmark numbers recorded (this was a real-use judgment call, not a controlled test) — a proper benchmark is still worth doing later if accuracy needs further tuning. `small` tier currently aliases to `base` since Moonshine only ships two sizes.
- [ ] Hardware detection (`navigator.gpu`, `navigator.deviceMemory`) → default tier recommendation logic — **not yet implemented**; popup currently defaults every install to "base" regardless of hardware
- [x] Fallback chain: tier load failure → retry on wasm → step down a tier → non-fatal `MODEL_FALLBACK` notice to the popup (doesn't kill the session)
- [x] Model tier selection wired popup → background → offscreen `start-capture` payload

## Phase 3 — Caption Overlay (FR3, FR9 partial)
- [x] `content.js`: closed Shadow DOM host, injected on `document_idle`, guarded against double-injection
- [x] Interim vs. final text rendered distinctly (italic/opacity vs. solid)
- [x] Message relay: offscreen → background → content `SUBTITLE_UPDATE`, scoped per-tab via `chrome.tabs.sendMessage` (see messaging-protocol note below)
- [x] Default caption styling at ≥4.5:1 contrast (white text, black background at 85% opacity)
- [x] `document.fullscreenchange` listener re-parents the overlay into `fullscreenElement` and back
- [x] Drag-to-reposition + resize handle; persisted to `chrome.storage.local` keyed by hostname
- [x] `prefers-reduced-motion` respected for caption transitions
- [ ] Manual check: YouTube fullscreen, a web Meet/Zoom/Teams tab, and a `file://` local video — **needs a real browser**

## Phase 4 — Popup Controls (FR4, FR9)
- [x] On/off toggle reflecting live per-tab session state (`GET_STATUS` on open)
- [x] Model tier radio group (semantic `<fieldset>`/`<legend>`) with tradeoff copy per tier
- [x] Style controls (font size, text color, background opacity, position reset) pushed via `chrome.storage.onChanged`, applied live with no page reload
- [x] Preferences persisted to `chrome.storage.local`
- [x] `aria-live="polite"` status region for state changes
- [ ] Full keyboard-nav / focus-order audit — markup is semantic and keyboard-operable by construction, but an actual pass hasn't been run

## Phase 5 — Transcript Export (FR6)
- [x] `offscreen.js` maintains in-memory `segments[]` with start/end timestamps
- [x] `GET_TRANSCRIPT` / `CLEAR_TRANSCRIPT` message path: popup → background → offscreen → response
- [x] `.txt` export (join finalized segments)
- [x] `.srt` export (numbered blocks, `HH:MM:SS,mmm` from segment timestamps)
- [ ] `chrome.downloads.download()` wired to generated Blob URLs — implemented, but saving/opening the file hasn't been verified in a real browser

## Phase 6 — Local File Support (FR7)
- [x] `file://*/*` host permission declared in manifest
- [x] Popup detects `chrome.extension.isAllowedFileSchemeAccess()` and shows an instructional state linking to `chrome://extensions/?id=<id>` if false
- [ ] Manual check: drag a local `.mp4` lecture recording into Chrome, enable file access, confirm captioning works — **needs a real browser**

## Phase 7 — Privacy & Reliability Verification (FR8, NFR5, NFR6)
- [ ] DevTools Network panel: full session after first-run model cache produces **zero** network requests — **needs a real browser**
- [x] No analytics/telemetry code paths anywhere in the codebase — grepped and confirmed (`grep -rniE "analytics|telemetry|sentry|gtag|..." extension/src` → no matches)
- [x] Fault injection (design-level): a failed inference pass is caught, logged, and does not touch session state (see offscreen.js `runInferencePass`) — a live "does the tab actually stay alive" check still needs a real browser
- [x] Manifest requests only the permissions actually used (`tabCapture`, `offscreen`, `activeTab`, `storage`, `downloads` — the earlier speculative `scripting` permission was removed since nothing uses it)

## Phase 8 — Accessibility & Quality Audit (FR9, NFR3, NFR4, success metrics)
- [ ] Run axe-core or Lighthouse against `popup.html`, drive to zero critical issues — **needs a real browser**
- [ ] WER benchmark recorded per tier against a known-transcript clip — **needs a real browser**
- [ ] Latency benchmark recorded per tier — **needs a real browser**
- [ ] Cross-check on Chrome stable + 2 prior majors, and Edge stable — **needs a real browser**

## Phase 9 — Packaging
- [x] README with install-unpacked instructions, model tier explanation, and known limitations
- [x] LICENSE (MIT, matching Whisper/Moonshine licensing per constitution.md §8)
- [ ] Store listing draft (if/when publishing) — not started

---
### Bugs found and fixed during implementation (worth remembering)

1. **Cross-tab message leakage.** `chrome.runtime.sendMessage()` broadcasts to **every** listening context in the extension, including every content-script instance in every open tab — unlike `chrome.tabs.sendMessage()`, which is scoped to one tab. The first pass had `offscreen.js` broadcasting `SUBTITLE_UPDATE` with `target: 'content'` directly, which would have leaked captions into unrelated tabs and double-rendered in the right one, plus a `target`/`type` mismatch that silently dropped `CAPTURE_ERROR`. Fixed by enforcing a strict rule: offscreen only ever talks to `background` (`target: 'background'`), and background is the *only* thing allowed to call `chrome.tabs.sendMessage()` to reach a specific tab's content script. Also moved from at most one active session per tab to exactly one active session for the whole extension, matching the real constraint that MV3 allows only one offscreen document (so only one tab can be captioned at a time) — the original per-tab session bookkeeping could otherwise show a stale tab as "captions on" after switching to a new one.

2. **English-only Whisper models reject generation options.** `Xenova/whisper-*.en` (used before the Moonshine switch) threw on every pass because `{ language, task }` options were being passed unconditionally — those only apply to multilingual checkpoints. Found via the offscreen console once transcription-failure logging was added (it had been failing silently before that).

3. **Missing content script on already-open tabs.** `Receiving end does not exist` when relaying to a tab — Chrome does not retroactively inject `content_scripts` into tabs that were already open before the extension was (re)loaded, and SPA-style client-side navigation (e.g. YouTube video-to-video) doesn't trigger re-injection either. Not a code bug, but a real gotcha worth remembering: always test on a fresh tab/navigation after reloading the extension.

4. **On-screen caption text accumulated instead of replacing.** Finalized segments were being concatenated into one continuously-growing string (trimmed word-by-word off the front only once over a length cap), so old and new text visibly blended instead of each new utterance cleanly replacing the last — not how conventional captions behave. Fixed by making each new finalized segment fully replace the displayed text. Separately, `MAX_SEGMENT_MS` was reduced from 30s to 8s at the same time, since continuous dialogue (movies/shows) rarely produces a silence gap on its own — **this 8s cap turned out to be a mistake**: real-world testing (2026-09-19) showed it measurably hurt transcription accuracy by chopping mid-sentence more often (the model loses grammatical context across the cut), and the display-side fix above already independently solves the overflow problem the cap was for. Raised back to 15s once that became clear — display protections don't depend on segment length, so this wasn't a tradeoff once diagnosed correctly.

5. **Finalize requests silently dropped mid-race.** The 1s interim-transcription timer and the silence/max-length finalize trigger frequently land close together. A finalize request arriving while another pass was already in flight hit the `session.inferring` guard and returned early — but `.then(resetSegmentState)` was chained onto that call unconditionally, so the segment's audio got reset/discarded without ever actually being transcribed. This surfaced as intermittent stale/blended caption text even after fix #4. Fixed by moving segment-reset responsibility inside `runInferencePass` itself (only reset after an actual outcome: success, genuine failure, or "nothing worth transcribing") and queuing a dropped finalize via a `pendingFinalize` flag serviced as soon as the in-flight pass completes, instead of silently discarding it.

6. **Encoder quantization was silently degrading accuracy on the WASM fallback path.** The `pipeline()` call specified no `dtype` at all, so Transformers.js used its unstated defaults — `fp32` on WebGPU, but `q8` on WASM (quantizing the encoder too). Whisper/Moonshine-style encoder-decoder ASR models are specifically documented as sensitive to encoder quantization, degrading into garbled/wrong output ([Transformers.js dtypes guide](https://huggingface.co/docs/transformers.js/en/guides/dtypes)) — a plausible contributor to reported accuracy complaints for anyone whose machine fell back to WASM. Fixed by explicitly pinning `dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }` on every load, confirmed against the actual `onnx-community/moonshine-{tiny,base}-ONNX` file listings first. User-reported accuracy improved noticeably after this fix.

7. **Interim results' last word flickers wrong, then self-corrects.** Interim passes re-transcribe the whole growing buffer every ~1s, including whatever's at the tail end — often a word that's only half-spoken so far, which the model has to guess a plausible (frequently wrong) completion for, until the next pass has the full word's audio. Standard streaming-ASR mitigation applied: interim display now drops the last word of each result (`trimTrailingWord` in offscreen.js) and shows it only once the next update confirms it — held back one cycle rather than shown wrong. Does not apply to finalized text, which already includes real trailing silence and isn't as prone to this.

8. **Finalized text lingered on screen stacked above the live interim line.** `content.js` renders the last finalized sentence and the currently-forming sentence as two separate lines (`finalEl` / `interimEl`) shown at the same time. The finalized line only cleared once the *new* segment finished, not when it started — so for the whole time a new sentence was being spoken, the old one sat frozen above it, which read as one blended paragraph where only the tail kept changing (reported 2026-09-19). Fixed: the moment a new segment's first interim update arrives (new speech has started), the previous finalized line clears immediately — only one line is ever visible at a time, either the sentence that just finished or the one being said right now, never both.

9. **Loosening MAX_SEGMENT_MS (8s→15s, bug #4) traded accuracy for latency.** Interim passes re-transcribe the *entire* growing buffer every ~1s — fine when segments were short, but once segments could grow to 15s, later interim passes in a long segment took proportionally longer to compute than early ones, showing up as increasing lag the longer someone talked without pausing (reported 2026-09-20). Fixed by decoupling interim responsiveness from final accuracy: interim passes are now windowed to only the most recent ~8s (`INTERIM_WINDOW_SAMPLES`/`tailChunks` in offscreen.js), bounding their compute cost regardless of segment length, while the *final* pass still sees the full segment (up to 15s) for maximum context. Also added per-pass timing + device diagnostics (`audio=Xms, inference=Yms, device=webgpu|wasm` in the offscreen console) so a "still laggy" report can be diagnosed as "genuinely running slower than real-time on this hardware" vs. a logic bug, and so WASM-fallback (slower than WebGPU) is visible rather than assumed.

10. **Caption lag confirmed NOT a compute problem — it was a deliberate throttle.** Real-world diagnostic data (2026-09-20, WebGPU): inference took only 164-337ms to transcribe 2-5s of audio — comfortably fast, ruling out "hardware too slow" as the cause. The actual source: interim passes were deliberately throttled to once per second (`INFERENCE_INTERVAL_MS`), stacked with the one-cycle holdback on each update's last word (bug #7's fix, `trimTrailingWord`) — together adding up to real, felt lag despite the hardware having plenty of headroom to spare. Halved `INFERENCE_INTERVAL_MS` to 500ms, since actual inference time was using only ~25-35% of the old 1000ms budget. The existing `session.inferring` guard already handles a single pass occasionally taking longer than the interval (e.g. a long windowed buffer) by skipping that tick rather than overlapping, so this was safe to lower without new logic.

11. **Old caption text could reappear after being replaced.** `SUBTITLE_UPDATE` travels through two independent async hops (offscreen → background via `chrome.runtime.sendMessage`, then background → content via `chrome.tabs.sendMessage`), neither of which guarantees messages arrive in the order they were sent — and halving `INFERENCE_INTERVAL_MS` (bug #10) increased how often updates overlap in flight, raising the odds of a later message's relay overtaking an earlier one's (reported 2026-09-20). Fixed with a strictly increasing `seq` on every outgoing message (`messageSeq` in offscreen.js); content.js now drops any update whose `seq` isn't newer than the last one it rendered, instead of trusting arrival order. Also found and fixed a related bug while investigating: when a segment finalized, any new speech that started *during* that final transcription pass was silently discarded by the unconditional `session.currentChunks = []` reset (onWorkletFrame keeps pushing new chunks into the same array during the await) — `resetSegmentState` now only splices off the chunks actually consumed by the pass that just finished (`consumedCount`), preserving anything that arrived after the snapshot as the start of the next segment.

---
**Definition of done for P0**: every checkbox above is checked, every FR in spec.md has a corresponding passed manual check, and the four success metrics in spec.md §8 are verified, not assumed.
