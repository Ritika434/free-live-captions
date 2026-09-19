# Project Constitution

These principles are non-negotiable. Every spec, design decision, and PR is checked against them.

## 1. Accessibility is a right, not a tier
Live captioning is a basic accommodation for deaf and hard-of-hearing users, language learners, and students. There is no free tier vs. paid tier — there is one tier, and it is free forever. No feature that affects caption availability, accuracy, or core usability may ever sit behind payment, credits, or a subscription.

## 2. Privacy by default
Audio and transcribed text never leave the user's device for the P0 feature set. No cloud ASR calls, no analytics of speech content, no account required. Any future feature that *would* require network calls (e.g. cloud translation) must be strictly opt-in, off by default, and clearly disclosed at the point of use.

## 3. Local-first inference
Transcription runs on-device via WebGPU (preferred) or WASM (fallback) using open-weight models (Whisper / Moonshine, MIT-licensed). No server component is required for the product to function. This is what makes "free forever" sustainable — there is no per-minute cloud bill to recoup.

## 4. No account, no telemetry, no dark patterns
No sign-up, no login, no usage caps disguised as "trial minutes." No nagging upsells — there is nothing to upsell to. If diagnostics are ever added, they must be opt-in and off by default.

## 5. Accessible by design, not just in purpose
The extension's own UI (popup, overlay, settings) must meet WCAG 2.1 AA: keyboard operable, screen-reader labeled, sufficient contrast, resizable text, respects `prefers-reduced-motion`. A captioning tool that is itself inaccessible fails its own mission.

## 6. Honest about tradeoffs
Local models on modest hardware will not always match a data-center-scale cloud model. The product must communicate this plainly (e.g., model tier picker with clear accuracy/performance labels) rather than overpromise.

## 7. Respect the host page and the machine
Never degrade the page being captioned, never leak audio contexts or workers after a tab closes, clean up aggressively. The extension is a guest on every page it runs on.

## 8. Open and auditable
Ship as open source (MIT, matching the licensing of the models it depends on) so the privacy and no-cost claims are independently verifiable, not just asserted.
