/**
 * activity.js — runs only on listed sites (registered by background/content-scripts.js).
 *
 * Reports what only the page itself reliably knows, so time tracking does not
 * depend on the OS focus/idle signals (which can be wrong under Wayland, Flatpak,
 * some window managers…):
 *   focused      document.hasFocus() and the page is visible
 *   lastInputAt  last mouse / keyboard / scroll / touch input inside the page
 *   playing      a <video> or <audio> element is playing
 *
 * It sends a heartbeat every 10 s while visible, and immediately on focus,
 * blur, visibility changes and when input resumes after a pause.
 * Plain script (content scripts cannot be ES modules).
 */
(() => {
  // Each injection gets a token; an older copy (e.g. left over from before the
  // extension was reloaded) sees a newer token and stops itself.
  const token = Math.random().toString(36).slice(2);
  window.__socialLockActivityToken = token;
  const alive = () => window.__socialLockActivityToken === token && !!chrome.runtime?.id;

  const HEARTBEAT_MS = 10000;
  const RESUME_GAP_MS = 30000;
  let lastInputAt = Date.now();
  let timer = null;

  function playing() {
    for (const m of document.querySelectorAll('video, audio')) {
      if (!m.paused && !m.ended && m.readyState > 2) return true;
    }
    return false;
  }

  function beat() {
    if (!alive()) return stop();
    const visible = document.visibilityState === 'visible';
    try {
      chrome.runtime.sendMessage({
        type: 'activity',
        focused: visible && document.hasFocus(),
        lastInputAt,
        playing: visible && playing()
      }).catch(() => {});
    } catch {
      stop(); // extension was reloaded or removed
    }
  }

  function onInput() {
    const now = Date.now();
    const resumed = now - lastInputAt > RESUME_GAP_MS;
    lastInputAt = now;
    if (resumed) beat(); // tell the tracker straight away that you are back
  }

  function stop() {
    clearInterval(timer);
    for (const ev of INPUT_EVENTS) removeEventListener(ev, onInput, true);
    for (const ev of MEDIA_EVENTS) document.removeEventListener(ev, beat, true);
    removeEventListener('focus', beat);
    removeEventListener('blur', beat);
    document.removeEventListener('visibilitychange', beat);
  }

  const INPUT_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'];
  const MEDIA_EVENTS = ['play', 'playing', 'pause', 'ended'];
  for (const ev of INPUT_EVENTS) addEventListener(ev, onInput, { capture: true, passive: true });
  addEventListener('focus', beat);
  addEventListener('blur', beat);
  document.addEventListener('visibilitychange', beat);
  // Media events don't bubble, but capturing listeners on the document see them.
  for (const ev of MEDIA_EVENTS) document.addEventListener(ev, beat, true);
  timer = setInterval(() => document.visibilityState === 'visible' && beat(), HEARTBEAT_MS);
  beat();
})();
