# Spec 001: Live Captioning — P0 (Must-Ship)

Status: Draft
Depends on: [constitution.md](../../constitution.md)

## 1. Problem Statement

Real-time captioning for browser video/audio (YouTube, web meetings, lecture recordings) is treated as a paid feature by most third-party tools:

| Extension | Free tier | Paid tier |
|---|---|---|
| Tablingo | 10 min/month | ~$9.99/mo |
| Felo Subtitles | ~1-day trial | $9.90–$199/mo |
| LessonScriptor | Free only via live mic (no headphones) | Pay-per-hour for tab-audio capture |

These companies pay per-minute for cloud ASR (Whisper API, Deepgram, etc.) and pass that cost to users. For someone who needs captions as an accessibility accommodation — not a convenience — this is a barrier to something that should be a right.

Chrome's built-in Live Caption is free but has real gaps this product must close:
- **Ephemeral only** — no transcript save/search/export.
- **Minimal styling** — caption appearance is buried in OS-level accessibility settings, not adjustable per-session.
- **Narrow scope** — tuned for simple HTML5 media, not robust across web meeting apps.
- **Single mode** — no per-user choice of accuracy vs. speed tradeoff.

## 2. Goal

Ship a browser extension that matches or exceeds the caption quality and UX of paid tools, entirely free, entirely local (no cloud dependency, no account), by running open-weight ASR models (Whisper / Moonshine) on-device via WebGPU/WASM.

## 3. Users

- **Primary**: Deaf and hard-of-hearing users captioning any tab audio (video sites, web-based meetings, local recordings).
- **Secondary**: Language learners and non-native speakers who benefit from captions on arbitrary content.
- **Secondary**: Students captioning/transcribing downloaded lecture recordings or class Zoom/Meet recordings played back locally.

## 4. In Scope for P0

Everything required for a user to: install the extension → turn on captions on any tab with audio → get accurate, low-latency, styled captions → optionally export the transcript. Nothing beyond that ships in P0.

## 5. Out of Scope for P0 (explicitly deferred)

- Cloud/API-based translation or transcription (any paid-API integration).
- Speaker diarization ("Speaker 1 / Speaker 2" labels).
- In-meeting bot / headless joining of Zoom/Teams/Meet (P0 only captions audio in a tab the user already has open).
- Multi-language extension UI (localization).
- Firefox/Safari ports (Chrome/Edge Manifest V3 only for P0).
- Mobile browser support.
- Real-time translation overlay (local M2M100/NLLB) — candidate for P1.
- Custom vocabulary / dictionary boosting — candidate for P1.
- Accurate song-lyric transcription. Confirmed via real-world testing (2026-09-20) that accuracy on music is meaningfully worse than on spoken dialogue — expected, since Whisper/Moonshine are trained on speech, not singing, and proper lyric transcription needs a vocal-isolation preprocessing step this project doesn't implement. Documented as a known limitation (extension/README.md) rather than pursued, since it's outside this project's actual target use case (accessibility captioning for speech: meetings, lectures, video dialogue).

## 6. Functional Requirements

### FR1 — Tab Audio Capture
- WHEN the user activates captions on a tab THE SYSTEM SHALL capture that tab's audio via `chrome.tabCapture` without requiring the tab's own audio to be muted or rerouted through the user's microphone.
- WHEN captions are active THE SYSTEM SHALL continue capturing audio even if the video is fullscreened.
- IF the user does not have an active/audible tab THEN THE SYSTEM SHALL show a clear inactive state rather than silently failing.
- WHEN the user navigates away from or closes the captioned tab THE SYSTEM SHALL stop capture and release all audio/media resources within 1 second.

### FR2 — Local Transcription Engine
- THE SYSTEM SHALL perform speech-to-text entirely on-device using an open-weight model (Whisper or Moonshine family) run through Transformers.js.
- WHEN WebGPU is available THE SYSTEM SHALL use it for inference; WHEN it is not available THE SYSTEM SHALL fall back to WASM automatically without user intervention.
- THE SYSTEM SHALL NOT transmit raw audio or transcribed text to any remote server as part of core transcription.
- WHEN a model is used for the first time THE SYSTEM SHALL download and cache its weights locally so subsequent sessions load without re-downloading.

### FR3 — Caption Overlay & Rendering
- WHEN transcription produces a result THE SYSTEM SHALL render it as an overlay positioned over the active tab content within 500ms of receipt.
- THE SYSTEM SHALL render interim (in-progress) results distinctly from finalized results so text appears responsively rather than only after long pauses.
- THE SYSTEM SHALL render the overlay inside the Fullscreen API element WHEN the host page's video enters fullscreen, so captions remain visible.
- THE SYSTEM SHALL isolate overlay styles (via Shadow DOM) so the host page's CSS cannot break caption legibility and the extension's styles cannot leak into the host page.
- THE SYSTEM SHALL let the user reposition and resize the caption box by dragging, and persist that position per-device.
- THE SYSTEM SHALL replace, not accumulate, on-screen finalized text as each new segment completes (one utterance visible at a time, like conventional captions) — so continuous, pause-free speech (e.g. movie/show dialogue) cannot grow the caption box to cover an unbounded portion of the viewport, and so old text doesn't visibly linger/blend with new text. (Added 2026-09-19 after real-world testing surfaced both problems on continuous-dialogue content; see design.md §2.4 and tasks.md Phase 3. An unusually long single segment is still word-trimmed from the front, keeping the most recent words.)

### FR4 — Extension Controls
- THE SYSTEM SHALL provide a toolbar popup to toggle captions on/off for the current tab.
- THE SYSTEM SHALL provide user controls for: font size, text color, background opacity, and caption position — all applied live without reloading the page.
- THE SYSTEM SHALL persist these preferences across sessions via `chrome.storage.local`.

### FR5 — Model & Hardware Management
- WHEN the extension is first installed THE SYSTEM SHALL detect available hardware capability (WebGPU support, approximate device memory) and recommend a default model tier (tiny/base/small).
- THE SYSTEM SHALL let the user manually override the model tier from the popup/options page, with each option labeled with an honest accuracy/speed/size tradeoff (see NFR3).
- IF a selected model fails to load (e.g., insufficient memory) THEN THE SYSTEM SHALL fall back to the next-smaller tier and notify the user why.

### FR6 — Transcript Export
- THE SYSTEM SHALL accumulate timestamped transcript segments for the duration of a captioning session.
- THE SYSTEM SHALL let the user export the session transcript as `.txt` and `.srt` from the popup.
- THE SYSTEM SHALL let the user clear the current session's transcript.
- Exported files SHALL be generated and saved locally (e.g. via `chrome.downloads`); no transcript data is ever uploaded.

### FR7 — Local File Support
- THE SYSTEM SHALL caption audio/video played from `file://` URLs when the user has granted "Allow access to file URLs" for the extension.
- WHEN file:// access has not been granted AND the user attempts to caption a local file THEN THE SYSTEM SHALL show in-product instructions for enabling it at `chrome://extensions`.

### FR8 — Privacy & Data Handling
- THE SYSTEM SHALL require no account, sign-in, or network authentication to use any P0 feature.
- THE SYSTEM SHALL make no network requests other than the one-time model weight download from the model host (e.g. Hugging Face CDN).
- THE SYSTEM SHALL NOT include any analytics, telemetry, or crash reporting that transmits data off-device in P0.

### FR9 — Accessibility of the Extension's Own UI
- THE SYSTEM'S popup and options UI SHALL be fully keyboard-navigable and screen-reader labeled (WCAG 2.1 AA).
- THE SYSTEM SHALL maintain a minimum 4.5:1 contrast ratio for default caption text against its background.
- THE SYSTEM SHALL respect `prefers-reduced-motion` for any caption entrance/exit animation.

## 7. Non-Functional Requirements

**NFR1 — Latency**: Caption text SHALL appear within 2–3 seconds of the corresponding speech, at the "base" model tier, on mid-range hardware (per the hardware tiers in design.md).

**NFR2 — Resource usage**: THE SYSTEM SHALL NOT cause audible/video playback stutter attributable to the extension on hardware meeting the minimum spec for the selected model tier.

**NFR3 — Quality bar (WER targets)**: Word Error Rate on clear conversational English audio SHALL be documented per model tier and SHALL be within the published benchmark ranges for the underlying open model (e.g. Whisper-base ≈ comparable to its published WER), not degraded by the extension's chunking strategy by more than 10% relative.

**NFR4 — Browser support**: Chrome and Edge (Manifest V3), current stable + 2 prior major versions.

**NFR5 — Reliability**: A crash or unhandled error in the transcription pipeline SHALL NOT crash the host tab; captions SHALL be able to be manually restarted from the popup without reloading the page.

**NFR6 — Security**: Extension SHALL request the minimum permission set needed (`tabCapture`, `offscreen`, `activeTab`, `storage`, `downloads`, and host permissions) and SHALL justify each in the manifest/store listing.

## 8. Success Metrics

- Caption latency (perceived lag) ≤ 3s at default tier — measured manually against a known-timestamp source video.
- Caption accuracy (WER) at "base" tier competitive with Chrome's built-in Live Caption on the same clip.
- Zero network requests during a captioning session beyond first-run model download (verifiable via DevTools Network panel — this is a testable P0 acceptance check, not just a claim).
- Extension passes an axe-core or Lighthouse accessibility audit on its popup/options UI with zero critical issues.

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `ScriptProcessorNode` is deprecated | Use `AudioWorkletNode` in the offscreen document instead (see design.md). |
| Service worker (background.js) is unloaded when idle, mid-session | Keep session state in the offscreen document / `chrome.storage.session`; background worker only orchestrates start/stop and re-derives state on wake. |
| WebGPU not available on all machines | WASM fallback is mandatory, not optional, and must be tested as a first-class path, not an afterthought. |
| Large model downloads on first run feel slow | Show explicit progress UI; default to the smallest tier; cache aggressively so it's a one-time cost. |
| DRM-protected video (e.g. Netflix) blocks tab audio access in some cases | Document as a known limitation; not a P0 blocker since most target use cases (YouTube, web meetings, lecture recordings) are unaffected. |
| Users on very low-end hardware get poor accuracy and blame the product | Be explicit in-UI about tier tradeoffs (constitution §6); never silently degrade without explanation. |

## 10. Open Questions

- ~~Which default model pairing ships in P0: Moonshine vs. Whisper-tiny/base?~~ **Resolved 2026-09-19: Moonshine.** Whisper-tiny/base.en shipped first (best-documented integration path) but real-world testing showed accuracy too poor to be usable; switched to `onnx-community/moonshine-{tiny,base}-ONNX`. This was a real-use judgment call, not a controlled WER benchmark — worth revisiting with actual numbers if accuracy needs further tuning (see tasks.md Phase 2/8).
- Should file:// support ship in P0 or slip to a fast-follow, given it requires an extra manual permission step? → Kept in P0 per user's stated priority (students transcribing lecture recordings), but flagged as the highest-risk FR to cut first if P0 timeline slips.
