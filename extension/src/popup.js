const DEFAULT_STYLE = { fontSize: 28, color: '#ffffff', bgOpacity: 0.85 };

const toggleBtn = document.getElementById('toggle-btn');
const statusEl = document.getElementById('status');
const fileWarning = document.getElementById('file-access-warning');
const openExtensionsBtn = document.getElementById('open-extensions-btn');
const tierRadios = document.querySelectorAll('input[name="model-tier"]');
const fontSizeInput = document.getElementById('font-size');
const textColorInput = document.getElementById('text-color');
const bgOpacityInput = document.getElementById('bg-opacity');
const resetPositionBtn = document.getElementById('reset-position-btn');
const exportTxtBtn = document.getElementById('export-txt-btn');
const exportSrtBtn = document.getElementById('export-srt-btn');
const clearBtn = document.getElementById('clear-btn');

let currentTabId = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function setToggleState(active) {
  toggleBtn.setAttribute('aria-pressed', String(active));
  toggleBtn.textContent = active ? 'Turn captions off' : 'Turn captions on';
}

function pad(n, len = 2) { return String(n).padStart(len, '0'); }

function srtTimestamp(ms) {
  const totalMs = Math.max(0, ms | 0);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const msRem = totalMs % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(msRem, 3)}`;
}

function buildSrt(segments) {
  const start = segments.length ? segments[0].startMs : 0;
  return segments
    .map((seg, i) => {
      const from = srtTimestamp(seg.startMs - start);
      const to = srtTimestamp(seg.endMs - start);
      return `${i + 1}\n${from} --> ${to}\n${seg.text}\n`;
    })
    .join('\n');
}

function buildTxt(segments) {
  return segments.map((s) => s.text).join('\n');
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: false }, () => {
    // Revoke shortly after; downloads.download reads the blob synchronously enough for small text files.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab && tab.id;

  if (tab && tab.url && tab.url.startsWith('file://')) {
    chrome.extension.isAllowedFileSchemeAccess((allowed) => {
      fileWarning.hidden = !!allowed;
    });
  }

  const { modelTier, captionStyle } = await chrome.storage.local.get(['modelTier', 'captionStyle']);
  const tier = modelTier || 'base';
  tierRadios.forEach((r) => { r.checked = r.value === tier; });

  const style = captionStyle || DEFAULT_STYLE;
  fontSizeInput.value = style.fontSize;
  textColorInput.value = style.color;
  bgOpacityInput.value = style.bgOpacity;

  if (currentTabId != null) {
    chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATUS', tabId: currentTabId }, (resp) => {
      const session = resp && resp.session;
      const active = !!(session && session.active);
      setToggleState(active);
      if (session && session.error) {
        // Surfaces an error even if the popup was closed when it happened.
        setStatus(session.error);
      } else {
        setStatus(active ? 'Captions are on for this tab.' : 'Captions are off for this tab.');
      }
    });
  }
}

toggleBtn.addEventListener('click', () => {
  if (currentTabId == null) return;
  const active = toggleBtn.getAttribute('aria-pressed') === 'true';
  const tier = document.querySelector('input[name="model-tier"]:checked').value;

  if (active) {
    chrome.runtime.sendMessage({ target: 'background', type: 'STOP_CAPTURE', tabId: currentTabId }, () => {
      setToggleState(false);
      setStatus('Captions are off for this tab.');
    });
  } else {
    setStatus('Starting captions…');
    chrome.runtime.sendMessage(
      { target: 'background', type: 'START_CAPTURE', tabId: currentTabId, modelTier: tier },
      (resp) => {
        if (resp && resp.ok) {
          setToggleState(true);
          setStatus('Captions are on. Loading the model the first time may take a moment.');
        } else {
          setStatus(`Could not start captions: ${(resp && resp.error) || 'unknown error'}`);
        }
      }
    );
  }
});

tierRadios.forEach((r) => {
  r.addEventListener('change', () => {
    chrome.storage.local.set({ modelTier: r.value });
  });
});

function saveStyle() {
  const style = {
    fontSize: Number(fontSizeInput.value),
    color: textColorInput.value,
    bgOpacity: Number(bgOpacityInput.value),
  };
  chrome.storage.local.set({ captionStyle: style });
}
[fontSizeInput, textColorInput, bgOpacityInput].forEach((el) => el.addEventListener('input', saveStyle));

resetPositionBtn.addEventListener('click', async () => {
  const { captionPosition } = await chrome.storage.local.get('captionPosition');
  if (!currentTabId) return;
  const tab = await chrome.tabs.get(currentTabId);
  try {
    const hostname = new URL(tab.url).hostname;
    const all = captionPosition || {};
    delete all[hostname];
    await chrome.storage.local.set({ captionPosition: all });
    setStatus('Caption position reset. Reload the page to see it take effect.');
  } catch {
    // non-http(s) URL (e.g. chrome://) — nothing to reset
  }
});

openExtensionsBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

async function withTranscript(callback) {
  chrome.runtime.sendMessage({ target: 'background', type: 'GET_TRANSCRIPT', tabId: currentTabId }, (resp) => {
    callback((resp && resp.segments) || []);
  });
}

exportTxtBtn.addEventListener('click', () => {
  withTranscript((segments) => {
    if (!segments.length) { setStatus('No transcript to export yet.'); return; }
    download('live-captions.txt', buildTxt(segments), 'text/plain');
  });
});

exportSrtBtn.addEventListener('click', () => {
  withTranscript((segments) => {
    if (!segments.length) { setStatus('No transcript to export yet.'); return; }
    download('live-captions.srt', buildSrt(segments), 'application/x-subrip');
  });
});

clearBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ target: 'background', type: 'CLEAR_TRANSCRIPT', tabId: currentTabId }, () => {
    setStatus('Transcript cleared.');
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.target !== 'popup') return;
  if (message.tabId != null && message.tabId !== currentTabId) return; // not this tab's session

  if (message.type === 'MODEL_PROGRESS' && message.progress && message.progress.status === 'progress') {
    const pct = Math.round(message.progress.progress || 0);
    setStatus(`Downloading model… ${pct}%`);
  } else if (message.type === 'MODEL_FALLBACK') {
    setStatus(message.message);
  } else if (message.type === 'CAPTURE_ERROR') {
    setToggleState(false);
    setStatus(message.error);
  }
});

init();
