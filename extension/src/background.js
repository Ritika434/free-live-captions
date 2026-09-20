// Service worker: orchestration only. No audio/model logic lives here —
// MV3 service workers are headless and can't touch AudioContext/getUserMedia.
// See specs/001-live-captioning-p0/design.md §2.2.

const OFFSCREEN_URL = 'offscreen.html';

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab audio and run on-device speech recognition for live captions.',
  });
}

// There is at most ONE active capture session for the whole extension: MV3
// allows only one offscreen document, so only one tab can be captioned at a
// time. Session state (which tab, if any) survives service worker eviction
// via chrome.storage.session (in-memory, cleared on browser close).
async function getActiveSession() {
  const { activeSession } = await chrome.storage.session.get('activeSession');
  return activeSession || null;
}

async function setActiveSession(session) {
  await chrome.storage.session.set({ activeSession: session });
}

async function startCapture(tabId, modelTier) {
  // Starting a new capture implicitly replaces any previous one (the
  // offscreen document is a singleton) — tell that tab's content script and
  // popup its session ended before claiming the new tab.
  const previous = await getActiveSession();
  if (previous && previous.tabId !== tabId) {
    chrome.tabs.sendMessage(previous.tabId, { target: 'content', type: 'CAPTIONS_STOPPED' }).catch(() => {});
  }

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreenDocument();
  await setActiveSession({ tabId, modelTier, startedAt: Date.now(), active: true });
  chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start-capture',
    streamId,
    tabId,
    modelTier,
  });
}

async function stopCapture(tabId) {
  const active = await getActiveSession();
  if (!active || active.tabId !== tabId) return; // nothing to stop for this tab
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop-capture', tabId });
  chrome.tabs.sendMessage(tabId, { target: 'content', type: 'CAPTIONS_STOPPED' }).catch(() => {});
  await setActiveSession(null);
}

// IMPORTANT: chrome.runtime.sendMessage() broadcasts to every listening context
// in the extension, INCLUDING every content-script instance across every tab —
// unlike chrome.tabs.sendMessage(), it is not scoped to one tab. So offscreen.js
// never addresses content scripts directly; it always sends `target: 'background'`
// and background is the only thing that calls chrome.tabs.sendMessage() to reach
// a specific tab's content script. (Background/offscreen/popup are singletons,
// so broadcast + target-filtering is safe for them; content scripts are not
// singletons, so they must only ever receive tab-scoped messages.)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Guard on target, not just type: background relays messages onward with
  // target 'offscreen'/'popup', and if a self-broadcast were ever received
  // back here, an unguarded type-only switch would re-forward it forever.
  if (!message || message.target !== 'background') return false;

  switch (message.type) {
    // --- Relayed from the offscreen document ---
    case 'SUBTITLE_UPDATE': {
      console.log(`[Free Live Captions] relaying SUBTITLE_UPDATE to tab ${message.tabId}:`, JSON.stringify(message.text));
      if (message.tabId != null) {
        chrome.tabs.sendMessage(message.tabId, {
          target: 'content',
          type: 'SUBTITLE_UPDATE',
          text: message.text,
          isFinal: message.isFinal,
          startMs: message.startMs,
          endMs: message.endMs,
          seq: message.seq,
        }).then(() => {
          console.log(`[Free Live Captions] tab ${message.tabId} acked the relay`);
        }).catch((err) => {
          // Was previously swallowed silently — surfacing it, since "content
          // script not ready yet" and "content script never injected here"
          // look identical unless we log which one actually happened.
          console.error(`[Free Live Captions] failed to relay to tab ${message.tabId}:`, err.message);
        });
      }
      return false;
    }
    case 'CAPTURE_ERROR': {
      if (message.tabId != null) {
        // Keep the error on the session (rather than clearing to null) so
        // GET_STATUS can still surface it if the popup was closed when this
        // fired and gets reopened later — otherwise the failure is silently
        // lost the moment the popup isn't actively listening.
        setActiveSession({ tabId: message.tabId, active: false, error: message.error }).then(() => {
          chrome.runtime.sendMessage({ target: 'popup', type: 'CAPTURE_ERROR', tabId: message.tabId, error: message.error }).catch(() => {});
        });
      }
      return false;
    }
    case 'MODEL_PROGRESS': {
      chrome.runtime.sendMessage({ target: 'popup', type: 'MODEL_PROGRESS', tabId: message.tabId, progress: message.progress }).catch(() => {});
      return false;
    }
    case 'MODEL_FALLBACK': {
      // Informational: session keeps running at a lower model tier, no session-state change.
      chrome.runtime.sendMessage({ target: 'popup', type: 'MODEL_FALLBACK', tabId: message.tabId, message: message.message }).catch(() => {});
      return false;
    }

    // --- RPCs from the popup ---
    case 'START_CAPTURE': {
      startCapture(message.tabId, message.modelTier)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true; // async response
    }
    case 'STOP_CAPTURE': {
      stopCapture(message.tabId)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    case 'GET_STATUS': {
      getActiveSession().then((session) => {
        const forThisTab = session && session.tabId === message.tabId ? session : null;
        sendResponse({ session: forThisTab });
      });
      return true;
    }
    case 'GET_TRANSCRIPT':
    case 'CLEAR_TRANSCRIPT': {
      // Forward to offscreen and relay its single response back to the popup.
      chrome.runtime.sendMessage({ target: 'offscreen', type: message.type, tabId: message.tabId })
        .then((resp) => sendResponse(resp))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stopCapture(tabId).catch(() => {});
});
