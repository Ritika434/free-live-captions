# Free Live Captions

A browser extension that captions any tab's audio in real time — YouTube, web-based Zoom/Meet/Teams calls, local lecture recordings — entirely on-device, entirely free, with no account and no cloud dependency.

## Why

Real-time captioning is an accessibility accommodation, not a premium feature. Existing tools gate this behind free-minute caps or monthly subscriptions because they route audio through paid cloud ASR APIs. This project instead runs open-weight speech models (Whisper / Moonshine, both MIT-licensed) locally in the browser via WebGPU/WASM — no per-minute cost to pass on, so there's nothing to charge for.

See [constitution.md](./constitution.md) for the non-negotiable principles this project is held to (free forever, privacy by default, local-first, accessible by design).

## Status

Spec-driven; Phases 0–6 of P0 are implemented and build cleanly. Code lives in [`extension/`](./extension/) — see [`extension/README.md`](./extension/README.md) to build and load it. See:

- [`specs/001-live-captioning-p0/spec.md`](./specs/001-live-captioning-p0/spec.md) — what P0 must do and why, with testable acceptance criteria
- [`specs/001-live-captioning-p0/design.md`](./specs/001-live-captioning-p0/design.md) — technical architecture (Manifest V3, offscreen document, Transformers.js pipeline, messaging contract)
- [`specs/001-live-captioning-p0/tasks.md`](./specs/001-live-captioning-p0/tasks.md) — phased implementation checklist, kept current with what's actually done vs. what still needs a live browser to verify

## P0 at a glance

- Caption any tab's audio, including local `file://` video playback, via `chrome.tabCapture` + an offscreen document (MV3's audio-capable context).
- Transcription runs fully on-device via Transformers.js — Moonshine (`onnx-community/moonshine-{tiny,base}-ONNX`) is the default engine after real-world testing showed the initial Whisper-tiny/base default wasn't accurate enough — WebGPU-accelerated with automatic WASM fallback, and designed to make zero network requests during a session beyond the one-time model download (not yet verified in a live browser — DevTools Network-panel check is on the manual test checklist).
- Styled, draggable, fullscreen-aware caption overlay rendered in a Shadow DOM so it can't be broken by host-page CSS.
- User-selectable model tier (tiny/base/small) with honest accuracy/speed tradeoff labels — hardware-based auto-recommendation is designed but not yet implemented (every install currently defaults to "base").
- Session transcript export to `.txt` / `.srt` — closing the "captions vanish forever" gap in Chrome's built-in Live Caption.
- No account, no telemetry (confirmed by grep, not just by design), no paid tier. The extension's own UI is built with accessible, semantic markup targeting WCAG 2.1 AA — not yet audited with axe-core/Lighthouse.

## Next step

Load it and run through the manual test checklist in [`extension/README.md`](./extension/README.md#manual-test-checklist) — that's the remaining gap between "builds cleanly" and "verified working." Then Phase 7–8 in [`tasks.md`](./specs/001-live-captioning-p0/tasks.md): the Whisper-vs-Moonshine benchmark, hardware-aware tier defaults, and the accessibility/WER/latency audits.
