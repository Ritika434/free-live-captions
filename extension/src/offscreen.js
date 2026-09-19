// Owns the entire audio -> text pipeline. This is the only context that can
// hold an AudioContext / getUserMedia stream in MV3 (background is headless).
// See specs/001-live-captioning-p0/design.md §2.3.

import { pipeline, env } from '@huggingface/transformers';

// --- Local-first runtime config -------------------------------------------------
// Never fetch the ONNX runtime itself from a CDN: it ships inside the extension
// (see build.js, which copies onnxruntime-web's wasm assets into dist/ort/).
// Model *weights* still come from the Hugging Face hub on first run and are then
// cached by the browser's Cache API — that one-time fetch is the only network
// traffic this product ever makes (spec.md §8 success metric).
env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/');
env.backends.onnx.wasm.numThreads = 1; // extension pages aren't cross-origin-isolated

// --- Model tiers -----------------------------------------------------------------
// Moonshine is the default engine (switched from Whisper after real-world testing
// showed Whisper-tiny/base accuracy was too poor on real tab audio — matches
// Moonshine's own paper, which reports better accuracy than Whisper at
// comparable-or-smaller size specifically for live/streaming-style short audio).
// Moonshine only ships two sizes (tiny/base); "small" reuses "base" since there's
// no larger checkpoint yet — see specs/001-live-captioning-p0/tasks.md Phase 2.
const MODEL_TIERS = {
  tiny: 'onnx-community/moonshine-tiny-ONNX',
  base: 'onnx-community/moonshine-base-ONNX',
  small: 'onnx-community/moonshine-base-ONNX',
};
const TIER_STEP_DOWN = { small: 'base', base: 'tiny', tiny: null };

const SAMPLE_RATE = 16000;
const INFERENCE_INTERVAL_MS = 1000; // how often we re-transcribe the growing segment
const SILENCE_FINALIZE_MS = 800; // pause length that commits a segment as final
// Force-finalize long segments even without a silence gap — continuous dialogue
// (movies, shows with background music) can easily never hit SILENCE_FINALIZE_MS.
// This is a real tradeoff, not just a safety cap: a shorter value chops mid-
// sentence more often, which *hurts* transcription accuracy (the model loses
// grammatical/semantic context it uses to disambiguate words) — found via
// real-world testing 2026-09-19 after an earlier, more aggressive cap (8s)
// visibly made accuracy worse despite fixing the on-screen overflow bug the
// 8s cap was originally added for. That overflow bug is now fixed
// independently on the display side (content.js: replace-per-segment,
// character cap, max-height/overflow) rather than by keeping segments short,
// so this can be loosened back up for better context without reintroducing
// the overflow problem.
const MAX_SEGMENT_MS = 15000;
const SILENCE_RMS_THRESHOLD = 0.008;
const MIN_INFER_SAMPLES = SAMPLE_RATE * 0.5; // finalize threshold — keep low so short complete utterances ("Yes.") still work
// Interim passes need a higher bar: transcribing on <1s of audio is a near-blind
// guess for a small model, and that low-confidence guess is exactly what shows
// up on screen and then gets silently replaced a second later — the "wrong
// text flashes, then corrects itself" complaint. Waiting for more context
// before showing the *first* guess doesn't fix raw model accuracy, but it
// does stop the worst, most-guaranteed-wrong guesses from ever being shown.
const MIN_INFER_SAMPLES_INTERIM = SAMPLE_RATE * 1.5;

const transcriberCache = new Map(); // tier -> { transcriber, device }

let audioContext = null;
let workletNode = null;
let mediaStream = null;
let sourceNode = null;
let inferenceTimer = null;

let session = null; // { tabId, modelTier, segments, currentChunks, currentStartedAt, silenceMs, running }

function rms(float32) {
  let sum = 0;
  for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
  return Math.sqrt(sum / float32.length);
}

// Interim passes re-transcribe the whole growing buffer from scratch, including
// whatever's at the very tail end — which is very often a word that's only
// half-spoken so far. The model has to guess a plausible completion for an
// incomplete word, and that guess is frequently wrong until the *next* pass
// has the full word's audio (found via real-world testing, 2026-09-19: "last
// word or two flickers wrong, then self-corrects"). Standard mitigation:
// don't display an interim result's last word at all — hold it back one
// update cycle, since it's the one most likely to still be uncertain. Only
// applied to interim text; finalized segments already include real trailing
// silence (SILENCE_FINALIZE_MS), so the tail-word problem mostly doesn't
// apply there.
function trimTrailingWord(text) {
  const words = text.trim().split(/\s+/);
  if (words.length <= 1) return text; // nothing safe to trim — showing one uncertain word beats showing nothing
  return words.slice(0, -1).join(' ');
}

function concatFloat32(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// Caches the in-flight *promise*, not just the resolved value — otherwise the
// 1s inference timer (runInferencePass) can race the initial warm-load call
// from startSession() and trigger loading the same model a second time before
// the first load has finished.
function loadTranscriber(modelTier, onProgress) {
  if (transcriberCache.has(modelTier)) return transcriberCache.get(modelTier);
  const promise = loadTranscriberUncached(modelTier, onProgress).catch((err) => {
    transcriberCache.delete(modelTier); // allow a future retry instead of caching a permanent failure
    throw err;
  });
  transcriberCache.set(modelTier, promise);
  return promise;
}

async function loadTranscriberUncached(modelTier, onProgress) {
  const modelId = MODEL_TIERS[modelTier] || MODEL_TIERS.base;

  async function tryDevice(device) {
    return pipeline('automatic-speech-recognition', modelId, {
      device,
      // Whisper/Moonshine-style encoder-decoder ASR models are documented as
      // sensitive to *encoder* quantization specifically — quantizing it can
      // degrade feature quality into garbled output, especially on accented
      // or noisy audio (huggingface.co/docs/transformers.js/en/guides/dtypes).
      // Pinning fp32 here matters most on the WASM path, where the library's
      // unstated default is q8 for everything (including the encoder) if we
      // don't override it. The decoder tolerates quantization fine, so q4
      // keeps download size/memory down without the same accuracy risk.
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      progress_callback: onProgress,
    });
  }

  let transcriber;
  let device = 'webgpu';
  try {
    if (!('gpu' in navigator)) throw new Error('WebGPU not available');
    transcriber = await tryDevice('webgpu');
  } catch (webgpuErr) {
    device = 'wasm';
    try {
      transcriber = await tryDevice('wasm');
    } catch (wasmErr) {
      const next = TIER_STEP_DOWN[modelTier];
      if (next) {
        // Informational only — the session keeps running at the lower tier,
        // so this must NOT be a CAPTURE_ERROR (that marks the session inactive).
        chrome.runtime.sendMessage({
          target: 'background',
          type: 'MODEL_FALLBACK',
          tabId: session && session.tabId,
          message: `Model tier "${modelTier}" failed to load (${wasmErr.message}). Falling back to "${next}".`,
        }).catch(() => {});
        return loadTranscriber(next, onProgress);
      }
      throw wasmErr;
    }
  }

  return { transcriber, device, tierUsed: modelTier };
}

function resetSegmentState() {
  session.currentChunks = [];
  session.currentStartedAt = null;
  session.silenceMs = 0;
}

// isFinal requests must never be silently dropped: dropping one means the
// audio it covered gets reset/discarded without ever being transcribed —
// that was a real bug (found 2026-09-19). A finalize that arrives while a
// pass is already in flight (very common: the 1s interim timer and the
// silence/max-length finalize trigger frequently land close together) is
// queued via `pendingFinalize` and serviced as soon as the in-flight pass
// finishes, instead of being dropped on the `inferring` guard.
async function runInferencePass(isFinal) {
  if (!session) return;

  if (session.inferring) {
    if (isFinal) session.pendingFinalize = true;
    return;
  }

  if (session.currentChunks.length === 0) return;
  const audio = concatFloat32(session.currentChunks);
  const minSamples = isFinal ? MIN_INFER_SAMPLES : MIN_INFER_SAMPLES_INTERIM;
  if (audio.length < minSamples) {
    if (isFinal) resetSegmentState(); // nothing meaningful to transcribe — safe to clear
    return; // interim: just wait for more audio next tick, nothing to reset
  }

  // Capture a stable reference: `session` can be reassigned (stop/restart)
  // while we're mid-await below, so every subsequent step re-checks identity
  // rather than touching the (possibly different, possibly null) live session.
  const activeSession = session;
  activeSession.inferring = true;
  try {
    const { transcriber } = await loadTranscriber(activeSession.modelTier);
    if (session !== activeSession) return; // session was stopped/restarted mid-load

    // `.en` models (see MODEL_TIERS) are English-only and error out if given
    // `language`/`task` generation options at all — those only apply to
    // multilingual checkpoints, which P0 doesn't use.
    const result = await transcriber(audio);
    if (session !== activeSession) return;

    const text = (result && result.text || '').trim();
    console.log(`[Free Live Captions] transcribed (isFinal=${isFinal}, ${audio.length} samples):`, JSON.stringify(text));
    const displayText = isFinal ? text : trimTrailingWord(text);
    if (displayText) {
      const startMs = activeSession.currentStartedAt;
      const endMs = Date.now();
      chrome.runtime.sendMessage({
        target: 'background',
        type: 'SUBTITLE_UPDATE',
        tabId: activeSession.tabId,
        text: displayText,
        isFinal,
        startMs,
        endMs,
      }).then((resp) => {
        console.log('[Free Live Captions] SUBTITLE_UPDATE sent, background ack:', resp);
      }).catch((err) => {
        console.error('[Free Live Captions] SUBTITLE_UPDATE failed to send:', err);
      });
      if (isFinal) {
        activeSession.segments.push({ text, startMs, endMs });
      }
    }
    if (isFinal && session === activeSession) resetSegmentState();
  } catch (err) {
    // A single failed pass is not fatal (NFR5: transient errors must not kill
    // the session) — log for debugging via the offscreen document's DevTools
    // rather than surfacing a popup error on every noisy chunk.
    console.error('[Free Live Captions] transcription pass failed:', err);
    // Still clear on a failed finalize attempt — otherwise the same audio
    // would just keep re-triggering (and re-failing) forever.
    if (isFinal && session === activeSession) resetSegmentState();
  } finally {
    if (session === activeSession) {
      activeSession.inferring = false;
      if (activeSession.pendingFinalize) {
        activeSession.pendingFinalize = false;
        runInferencePass(true);
      }
    }
  }
}

// Throttled diagnostics: open this document's own DevTools (chrome://extensions
// -> this extension's Details -> "Inspect views: offscreen.html") to see these —
// they do NOT show up in the captioned page's own console. Useful for telling
// apart "no audio is reaching the pipeline at all" from "audio arrives but
// never crosses the silence threshold" from "audio is fine, transcription itself
// is failing" (which logs separately in runInferencePass's catch).
let debugStats = { frames: 0, maxRms: 0, lastLogAt: 0 };

function onWorkletFrame(float32) {
  if (!session) return;

  const level = rms(float32);
  debugStats.frames += 1;
  debugStats.maxRms = Math.max(debugStats.maxRms, level);
  const now = Date.now();
  if (now - debugStats.lastLogAt > 2000) {
    console.log(
      `[Free Live Captions] audio check: ${debugStats.frames} frames in last ~2s, peak RMS ${debugStats.maxRms.toFixed(4)} ` +
      `(silence threshold ${SILENCE_RMS_THRESHOLD}) — ${debugStats.maxRms > SILENCE_RMS_THRESHOLD ? 'speech-level audio detected' : 'no audio above silence threshold'}`
    );
    debugStats = { frames: 0, maxRms: 0, lastLogAt: now };
  }

  const loud = level > SILENCE_RMS_THRESHOLD;
  if (loud) {
    if (session.currentChunks.length === 0) session.currentStartedAt = Date.now();
    session.currentChunks.push(float32);
    session.silenceMs = 0;
  } else if (session.currentChunks.length > 0) {
    // Still append a little trailing silence so we don't clip word endings,
    // but track it separately to decide when to finalize.
    session.currentChunks.push(float32);
    session.silenceMs += (float32.length / SAMPLE_RATE) * 1000;
  }

  // Reset is now handled inside runInferencePass itself (only after an actual
  // finalize outcome — success, genuine failure, or "nothing to transcribe" —
  // not unconditionally like this used to do, which discarded audio whenever
  // a finalize request landed while another pass was already in flight).
  const segmentMs = session.currentStartedAt ? Date.now() - session.currentStartedAt : 0;
  if (session.currentChunks.length && session.silenceMs >= SILENCE_FINALIZE_MS) {
    runInferencePass(true);
  } else if (segmentMs >= MAX_SEGMENT_MS) {
    runInferencePass(true);
  }
}

async function setupAudioProcessing(stream) {
  audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  await audioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-worklet-processor.js'));

  sourceNode = audioContext.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(audioContext, 'pcm-capture-processor');

  // Keep the tab's audio audible: without this, capturing via getUserMedia
  // silently swallows playback instead of just tapping it.
  sourceNode.connect(audioContext.destination);
  sourceNode.connect(workletNode);

  workletNode.port.onmessage = (event) => onWorkletFrame(event.data);

  inferenceTimer = setInterval(() => runInferencePass(false), INFERENCE_INTERVAL_MS);
}

async function startSession(streamId, tabId, modelTier) {
  await stopSession();

  session = {
    tabId,
    modelTier,
    segments: [],
    currentChunks: [],
    currentStartedAt: null,
    silenceMs: 0,
    inferring: false,
    pendingFinalize: false,
  };

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  const tracks = mediaStream.getAudioTracks();
  console.log(
    `[Free Live Captions] tab audio captured: ${tracks.length} track(s)`,
    tracks.map((t) => ({ label: t.label, muted: t.muted, readyState: t.readyState, enabled: t.enabled }))
  );
  if (tracks.length === 0) {
    console.warn('[Free Live Captions] no audio track on the captured stream — the tab may be silent, or the site (DRM, ads, etc.) may be blocking capture.');
  }

  await setupAudioProcessing(mediaStream);

  // Warm the model in the background; inference passes no-op until it's ready.
  loadTranscriber(modelTier, (progress) => {
    chrome.runtime.sendMessage({ target: 'popup', type: 'MODEL_PROGRESS', tabId, progress }).catch(() => {});
  }).catch((err) => {
    chrome.runtime.sendMessage({
      target: 'background',
      type: 'CAPTURE_ERROR',
      tabId,
      error: `Could not load any model tier: ${err.message}`,
    }).catch(() => {});
  });
}

async function stopSession() {
  if (inferenceTimer) clearInterval(inferenceTimer);
  inferenceTimer = null;

  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (audioContext) {
    await audioContext.close().catch(() => {});
    audioContext = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  session = null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return false;

  switch (message.type) {
    case 'start-capture':
      startSession(message.streamId, message.tabId, message.modelTier)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => {
          chrome.runtime.sendMessage({
            target: 'background',
            type: 'CAPTURE_ERROR',
            tabId: message.tabId,
            error: err.message,
          }).catch(() => {});
          sendResponse({ ok: false, error: String(err) });
        });
      return true;
    case 'stop-capture':
      stopSession().then(() => sendResponse({ ok: true }));
      return true;
    case 'GET_TRANSCRIPT':
      sendResponse({ ok: true, segments: session ? session.segments : [] });
      return true;
    case 'CLEAR_TRANSCRIPT':
      if (session) session.segments = [];
      sendResponse({ ok: true, segments: [] });
      return true;
    default:
      return false;
  }
});
