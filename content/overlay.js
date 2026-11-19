/**
 * overlay.js — the small "N minutes left" card shown inside a listed site.
 * The service worker sends { type: 'warn', domain, kind, blockAt, secondsLeft }
 * when 5 and 1 minutes (configurable) are left.
 *
 * Rendered in a closed shadow root so the site's CSS cannot touch it, and
 * vice versa. Plain script (content scripts cannot be ES modules).
 */
(() => {
  // A newer injection replaces an older one (see activity.js).
  const token = Math.random().toString(36).slice(2);
  window.__socialLockOverlayToken = token;
  const alive = () => window.__socialLockOverlayToken === token && !!chrome.runtime?.id;

  const AUTO_HIDE_MS = 15000;
  let host = null;
  let tick = null;
  let hideTimer = null;

  function clock(ts, lang) {
    return new Date(ts).toLocaleTimeString(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en', { hour: '2-digit', minute: '2-digit' });
  }

  function left(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function hide() {
    clearInterval(tick);
    clearTimeout(hideTimer);
    host?.remove();
    host = null;
  }

  // Lucide icons (ISC, see vendor/lucide/LICENSE), inlined: content scripts can't import modules.
  const ICONS = {
    hourglass: '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
  };

  function svgIcon(name, size) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of Object.entries({
      viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
      'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'
    })) svg.setAttribute(k, v);
    svg.innerHTML = ICONS[name]; // constant markup above, never page or user input
    return svg;
  }

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  /** The user's appearance choices: theme ('light' | 'dark' | null) and language ('ar' | 'en'). */
  async function prefs() {
    try {
      const { settings } = await chrome.storage.local.get('settings');
      return {
        theme: settings?.theme === 'light' || settings?.theme === 'dark' ? settings.theme : null,
        lang: settings?.lang === 'en' ? 'en' : 'ar'
      };
    } catch {
      return { theme: null, lang: 'ar' };
    }
  }

  // Strings for the card (content scripts can't import shared/i18n.js).
  const TEXT = {
    ar: {
      minutes: (n) => `باقي ${n} د`,
      seconds: (s) => `باقي ${s}`,
      limit: (d) => `${d} · الحد اليومي`,
      until: (d, t) => `${d} · مسموح حتى ${t}`,
      dismiss: 'إغلاق'
    },
    en: {
      minutes: (n) => `${n} min left`,
      seconds: (s) => `${s} left`,
      limit: (d) => `${d} · daily limit`,
      until: (d, t) => `${d} · allowed until ${t}`,
      dismiss: 'Dismiss'
    }
  };

  async function show({ domain, kind, blockAt, secondsLeft }) {
    const { theme, lang } = await prefs();
    const T = TEXT[lang];
    hide(); // after the await, so two warnings in a row never leave two cards
    host = document.createElement('social-lock-warning');
    const root = host.attachShadow({ mode: 'closed' });

    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = chrome.runtime.getURL('content/overlay.css');

    const card = el('div', 'card');
    card.setAttribute('role', 'status');
    card.setAttribute('aria-live', 'polite');
    if (theme) card.dataset.theme = theme;
    card.lang = lang;
    card.dir = lang === 'ar' ? 'rtl' : 'ltr';

    const tile = el('span', 'tile');
    tile.append(svgIcon('hourglass', 18));

    const title = el('p', 'title');
    const site = `${String.fromCharCode(0x2066)}${domain}${String.fromCharCode(0x2069)}`; // keep the domain LTR
    const sub = el('p', 'sub', kind === 'schedule' ? T.until(site, clock(blockAt, lang)) : T.limit(site));
    const text = el('div', 'text');
    text.append(title, sub);

    const close = el('button', 'close');
    close.type = 'button';
    close.setAttribute('aria-label', T.dismiss);
    close.append(svgIcon('x', 16));
    close.addEventListener('click', hide);

    // Drains from the moment the warning appears to the moment the site closes.
    const bar = el('div', 'bar');
    const fill = el('span');
    bar.append(fill);
    const total = Math.max(1, (secondsLeft || (blockAt - Date.now()) / 1000) * 1000);

    const head = el('div', 'head');
    head.append(tile, text, close);
    card.append(head, bar);
    root.append(css, card);
    (document.body || document.documentElement).append(host);

    const update = () => {
      const ms = blockAt - Date.now();
      const minutes = Math.ceil(ms / 60000);
      title.textContent = minutes > 1 ? T.minutes(minutes) : T.seconds(left(ms));
      fill.style.width = `${Math.max(0, Math.min(1, ms / total)) * 100}%`;
      card.classList.toggle('urgent', ms <= 60000);
      if (ms <= 0) hide();
    };
    update();
    tick = setInterval(update, 1000);
    hideTimer = setTimeout(hide, AUTO_HIDE_MS);
    card.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    card.addEventListener('mouseleave', () => { hideTimer = setTimeout(hide, AUTO_HIDE_MS); });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!alive()) return;
    if (msg?.type === 'warn') show(msg);
  });
})();
