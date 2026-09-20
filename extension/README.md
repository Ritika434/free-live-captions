# Free Live Captions — extension

Implements [`specs/001-live-captioning-p0`](../specs/001-live-captioning-p0/) (see that folder for the actual requirements/design/task tracking — this file is just "how do I run it").

## Build

```sh
npm install
npm run build      # -> dist/
npm run watch       # rebuild on change
```

`dist/` is the load-unpacked target. Only `offscreen.js` has npm dependencies (`@huggingface/transformers`); everything else is plain script, copied as-is. The build also copies the ONNX runtime's WASM assets (`ort-wasm-simd-threaded.jsep.{mjs,wasm}`) into `dist/ort/` so the extension never depends on transformers.js's default CDN — see the comment at the top of `src/offscreen.js`.

## Install (unpacked)

1. `npm install && npm run build`
2. Open `chrome://extensions`
3. Enable **Developer mode** (top right)
4. **Load unpacked** → select `extension/dist`
5. Open a tab with audio (YouTube, a web Meet/Zoom/Teams call, or a local video file — see below), click the toolbar icon, **Turn captions on**

First run downloads the selected model tier from the Hugging Face hub (tens to hundreds of MB depending on tier) and caches it via the browser's Cache API — every session after that is offline.

### Local file captioning

Local `.mp4`/`.webm`/etc. files dropped into a Chrome tab need one extra manual step: open `chrome://extensions` → this extension's **Details** → enable **"Allow access to file URLs"**. The popup detects and prompts for this automatically when you try to caption a `file://` tab without it.

## Known limitations (P0)

- **One captioned tab at a time.** Manifest V3 allows only one offscreen document per extension, and that document owns the entire audio pipeline — starting captions on a new tab stops whichever tab was previously captioned.
- **Default model tier isn't hardware-aware yet.** Every install defaults to "base" regardless of the machine's actual GPU/RAM; `navigator.gpu`/`navigator.deviceMemory`-based auto-recommendation is tracked as a follow-up (see `tasks.md` Phase 2).
- **Moonshine is the default engine** (`onnx-community/moonshine-{tiny,base}-ONNX`), switched from Whisper after real-world testing showed Whisper-tiny/base accuracy was too poor to be usable. That was a real-use judgment call, not a controlled WER benchmark — worth revisiting with actual numbers if accuracy needs further tuning. Moonshine only ships two sizes, so the "small" tier currently aliases to "base."
- **DRM-protected streams** (e.g. Netflix) may block `chrome.tabCapture` outright — not a bug, a platform restriction.
- **Song lyrics are meaningfully less accurate than spoken dialogue** (found 2026-09-20). This is expected, not a bug to chase: Whisper/Moonshine are trained on natural speech, not singing (sustained/pitch-bent vowels, rhythmic rather than conversational timing, vocals mixed at comparable loudness to continuous instrumentation rather than sparse background music). Our silence-based segmentation also doesn't work well on music specifically — instrumentation keeps the volume up continuously, so segments rarely finalize on a real pause and instead get cut at an arbitrary 15s mark rather than at a lyric line boundary. Real lyric transcription tools solve this with a vocal-isolation preprocessing step (separating vocals from instrumentation before ASR) — a genuinely heavy addition (a second, larger model run before every transcription pass) that's out of scope for a real-time, on-device tool built around accessibility for speech content (meetings, lectures, video dialogue), which is this project's actual target use case per spec.md.
- Latency/WER numbers and a full accessibility audit are not yet recorded — they require driving a real Chrome session with live audio, which is tracked in `tasks.md` Phases 7–8 rather than claimed here.

## Manual test checklist

Quick smoke test after loading unpacked:
1. Open a YouTube video with speech, turn captions on, confirm text appears within a few seconds and the video's own audio still plays normally (not silenced).
2. Fullscreen the video — captions should stay visible, not get clipped.
3. Drag the caption box to a new position, reload the page — position should persist.
4. Change font size / color / background opacity in the popup — should apply live, no reload needed.
5. Let a sentence or two accumulate, then **Download .srt** — open it in a text editor and confirm timestamps and text look right.
6. Open DevTools → Network tab, clear it, let a captioning session run for a minute — after the initial model download, confirm no further requests fire.
7. Switch to a different tab, turn captions on there — the first tab's captions should stop and its popup should reflect "off" next time you open it.
