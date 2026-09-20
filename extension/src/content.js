// Per-tab caption overlay. Rendered inside a closed Shadow DOM so host-page
// CSS can't break caption legibility and our styles can't leak out.
// See specs/001-live-captioning-p0/design.md §2.4.

(() => {
  if (window.__freeLiveCaptionsInjected) return;
  window.__freeLiveCaptionsInjected = true;

  const HOST_TAG = 'free-live-captions-host';
  const DEFAULT_STYLE = { fontSize: 28, color: '#ffffff', bgOpacity: 0.85 };
  const hostname = location.hostname || 'unknown';
  const MAX_FINAL_CHARS = 160; // roughly 2-3 caption lines — oldest words drop first once exceeded

  let hostEl = null;
  let shadow = null;
  let finalEl = null;
  let interimEl = null;
  let box = null;
  let finalText = '';
  let visible = false;
  let lastSeq = -1; // drops out-of-order SUBTITLE_UPDATE deliveries — see offscreen.js's messageSeq comment

  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function ensureHost() {
    if (hostEl) return;

    hostEl = document.createElement(HOST_TAG);
    hostEl.style.cssText = [
      'all: initial',
      'position: fixed',
      'left: 0', 'right: 0',
      'bottom: 8%',
      'display: flex',
      'justify-content: center',
      'z-index: 2147483647', // max int32 — stay above host page + most video players
      'pointer-events: none',
    ].join(';');
    document.documentElement.appendChild(hostEl);

    shadow = hostEl.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      .box {
        pointer-events: auto;
        max-width: min(80vw, 900px);
        max-height: 40vh;
        overflow: hidden;
        padding: 10px 18px;
        border-radius: 8px;
        font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
        font-weight: 600;
        line-height: 1.35;
        text-align: center;
        cursor: grab;
        user-select: none;
      }
      .box.dragging { cursor: grabbing; }
      .final { display: block; }
      .interim { display: block; opacity: 0.75; font-style: italic; }
      .resize-handle {
        position: absolute;
        width: 14px; height: 14px;
        right: 2px; bottom: 2px;
        cursor: nwse-resize;
        border-right: 2px solid currentColor;
        border-bottom: 2px solid currentColor;
        opacity: 0.5;
      }
      .box { position: relative; }
      ${reducedMotion() ? '' : '.final, .interim { transition: opacity 120ms ease-out; }'}
    `;
    shadow.appendChild(style);

    box = document.createElement('div');
    box.className = 'box';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-label', 'Live captions');

    finalEl = document.createElement('div');
    finalEl.className = 'final';
    interimEl = document.createElement('div');
    interimEl.className = 'interim';

    const handle = document.createElement('div');
    handle.className = 'resize-handle';

    box.appendChild(finalEl);
    box.appendChild(interimEl);
    box.appendChild(handle);
    shadow.appendChild(box);

    setupDrag(box, handle);
    hostEl.style.display = 'none';

    loadStyle();
    loadPosition();
  }

  function applyStyle(s) {
    if (!box) return;
    box.style.fontSize = `${s.fontSize}px`;
    box.style.color = s.color;
    box.style.background = hexToRgba(s.color === '#000000' ? '#ffffff' : '#000000', s.bgOpacity);
  }

  function hexToRgba(hex, alpha) {
    const v = hex.replace('#', '');
    const r = parseInt(v.substring(0, 2), 16);
    const g = parseInt(v.substring(2, 4), 16);
    const b = parseInt(v.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function loadStyle() {
    chrome.storage.local.get('captionStyle', ({ captionStyle }) => {
      applyStyle(captionStyle || DEFAULT_STYLE);
    });
  }

  function loadPosition() {
    chrome.storage.local.get('captionPosition', ({ captionPosition }) => {
      const pos = (captionPosition || {})[hostname];
      if (pos && box) {
        box.style.width = pos.width ? `${pos.width}px` : '';
        if (pos.x != null && pos.y != null) {
          hostEl.style.justifyContent = 'flex-start';
          hostEl.style.bottom = 'auto';
          box.style.position = 'fixed';
          box.style.left = `${pos.x}px`;
          box.style.top = `${pos.y}px`;
        }
      }
    });
  }

  function savePosition(x, y, width) {
    chrome.storage.local.get('captionPosition', ({ captionPosition }) => {
      const all = captionPosition || {};
      all[hostname] = { x, y, width };
      chrome.storage.local.set({ captionPosition: all });
    });
  }

  function setupDrag(el, resizeHandle) {
    let dragging = false;
    let resizing = false;
    let startX, startY, startLeft, startTop, startWidth;

    el.addEventListener('pointerdown', (e) => {
      if (e.target === resizeHandle) {
        resizing = true;
      } else {
        dragging = true;
        el.classList.add('dragging');
      }
      const rect = el.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      startWidth = rect.width;
      el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', (e) => {
      if (dragging) {
        const x = startLeft + (e.clientX - startX);
        const y = startTop + (e.clientY - startY);
        hostEl.style.justifyContent = 'flex-start';
        hostEl.style.bottom = 'auto';
        el.style.position = 'fixed';
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
      } else if (resizing) {
        const width = Math.max(200, startWidth + (e.clientX - startX));
        el.style.width = `${width}px`;
      }
    });

    function endInteraction(e) {
      if (!dragging && !resizing) return;
      dragging = false;
      resizing = false;
      el.classList.remove('dragging');
      const rect = el.getBoundingClientRect();
      savePosition(rect.left, rect.top, rect.width);
    }
    el.addEventListener('pointerup', endInteraction);
    el.addEventListener('pointercancel', endInteraction);
  }

  function show() {
    ensureHost();
    hostEl.style.display = 'flex';
    visible = true;
  }

  function hide() {
    if (hostEl) hostEl.style.display = 'none';
    visible = false;
  }

  function appendFinal(text) {
    // Each finalized segment REPLACES the previous one (like real captions —
    // one sentence/utterance at a time), rather than accumulating into one
    // growing string. Accumulating was the bug: old and new text blended
    // together and only got trimmed word-by-word off the front once too long,
    // so stale text lingered on screen instead of clearing per new segment.
    finalText = text;
    if (finalText.length <= MAX_FINAL_CHARS) return;
    // A single segment can still occasionally run long — keep the tail (most
    // recent words), never cut mid-word.
    const words = finalText.split(' ');
    while (words.length > 1 && words.join(' ').length > MAX_FINAL_CHARS) {
      words.shift();
    }
    finalText = words.join(' ');
  }

  function render(text, isFinal) {
    ensureHost();
    show();
    if (isFinal) {
      appendFinal(text);
      interimEl.textContent = '';
    } else {
      // New speech has started forming — clear the previously finalized line
      // now, not once this segment completes. Otherwise the old sentence sits
      // stacked above the live one, which reads as one blended paragraph
      // where only the tail changes (reported 2026-09-19). One thing visible
      // at a time: either the sentence that just finished, or the one being
      // said right now — never both at once.
      if (finalText) {
        finalText = '';
        finalEl.textContent = '';
      }
      interimEl.textContent = text;
    }
    finalEl.textContent = finalText;
  }

  function reparentForFullscreen() {
    if (!hostEl) return;
    const target = document.fullscreenElement || document.documentElement;
    if (hostEl.parentElement !== target) target.appendChild(hostEl);
  }
  document.addEventListener('fullscreenchange', reparentForFullscreen);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.captionStyle) applyStyle(changes.captionStyle.newValue || DEFAULT_STYLE);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.target !== 'content') return;
    if (message.type === 'SUBTITLE_UPDATE') {
      // Neither async hop this message traveled through (offscreen ->
      // background -> content) guarantees delivery order across separate
      // calls. Dropping anything that arrives out of sequence — rather than
      // trusting arrival order — is what actually fixes "old text reappears
      // after being replaced" (reported 2026-09-20), regardless of which hop
      // the reordering happened in.
      if (typeof message.seq === 'number' && message.seq <= lastSeq) {
        console.log(`[Free Live Captions] dropped out-of-order update (seq ${message.seq} <= ${lastSeq}):`, JSON.stringify(message.text));
        return;
      }
      if (typeof message.seq === 'number') lastSeq = message.seq;

      render(message.text, message.isFinal);
      // Check on the page's own DevTools console (F12 on the captioned tab —
      // NOT the offscreen document's console) — confirms the message arrived
      // here and whether the overlay element is actually still in the DOM
      // (some sites aggressively strip unrecognized injected elements).
      console.log(
        `[Free Live Captions] rendered "${message.text}" (isFinal=${message.isFinal}); ` +
        `overlay in DOM: ${hostEl && hostEl.isConnected}, display: ${hostEl && hostEl.style.display}`
      );
    } else if (message.type === 'CAPTIONS_STOPPED') {
      finalText = '';
      lastSeq = -1;
      hide();
    }
  });

  console.log('[Free Live Captions] content script loaded on', location.href);
})();
