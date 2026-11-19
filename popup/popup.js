/**
 * popup.js — the site in the current tab (time left, pause) and today's usage
 * per group and site. Asks the service worker for a fresh status (which
 * flushes running time first) every few seconds while open.
 */
import { formatDuration, formatClock, formatWhen } from '../shared/format.js';
import { icon, hydrateIcons } from '../shared/icons.js';
import { h } from '../shared/dom.js';
import { t, initPageLanguage, toggleLanguage } from '../shared/i18n.js';

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 5000;

const reasonText = (r) => t(`reason.${r || 'blocked'}`);

let activeUrl = '';

await initPageLanguage();
hydrateIcons();

async function update() {
  const status = await chrome.runtime.sendMessage({ type: 'status', url: activeUrl }).catch(() => null);
  if (!status || status.error) return;
  renderCurrent(status);
  renderToday(status);
  $('reset').textContent = t('newDayAt', { time: formatClock(status.resetAt) });
}

/** A progress bar element (or fill an existing one) for used/limit. */
function fillBar(bar, used, limit) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 1;
  bar.hidden = false;
  bar.className = `bar${ratio >= 1 ? ' full' : ratio >= 0.75 ? ' warn' : ''}`;
  bar.firstElementChild.style.width = `${ratio * 100}%`;
  return bar;
}

// ---------------------------------------------------------------------------
// Current site

function setBadge(text, kind = '') {
  const b = $('current-badge');
  b.textContent = text;
  b.className = `badge ${kind}`;
}

function renderPause(row, { pausesLeft, pauseMinutes }) {
  const btn = $('pause');
  const restricted = row.enabled && (row.mode || row.groupName);
  btn.hidden = !restricted;
  if (!restricted) return;
  let label;
  if (row.pausedUntil) {
    btn.disabled = true;
    label = t('pp.pausedUntil', { time: formatClock(row.pausedUntil) });
  } else if (pausesLeft <= 0) {
    btn.disabled = true;
    label = t('pp.noPauses');
  } else {
    btn.disabled = false;
    label = t('pp.pauseBtn', { n: pauseMinutes, left: pausesLeft });
  }
  btn.replaceChildren(icon('pause', { size: 16 }), label);
  btn.onclick = () => {
    // The confirmation step runs in the settings page (it needs room to type).
    chrome.tabs.create({ url: chrome.runtime.getURL(`options/options.html#pause=${encodeURIComponent(row.domain)}`) });
    window.close();
  };
}

function renderCurrent(status) {
  const row = status.rows.find((r) => r.domain === status.currentDomain);
  const card = $('current');
  card.hidden = !row;
  if (!row) return;

  $('current-domain').textContent = row.domain;
  $('current-avatar').textContent = row.domain.replace(/^(web|m|mobile)\./, '')[0];
  $('current-sub').textContent = row.groupName ? t('pp.inGroup', { name: row.groupName }) : t('usage.today', { time: formatDuration(row.usedSec) });
  card.classList.toggle('blocked', row.blocked);
  renderPause(row, status);

  const time = $('current-left');
  const note = $('current-note');
  const bar = $('current-bar');
  bar.hidden = true;
  note.hidden = true;
  const showNote = (text) => { note.textContent = text; note.hidden = false; };
  const now = Date.now();

  if (row.blocked) {
    setBadge(reasonText(row.reason), 'danger');
    time.textContent = row.until ? t('pp.opens', { when: formatWhen(row.until) }) : t('pp.blockedRule');
    if (row.blockedByGroup) showNote(t('pp.byGroup', { name: row.blockedByGroup }));
    return;
  }

  if (row.pausedUntil) {
    setBadge(t('badge.paused'), 'neutral');
    time.replaceChildren(formatDuration((row.pausedUntil - now) / 1000, { precise: true }), ' ', h('small', {}, t('pp.pauseLeft')));
    return;
  }

  if (row.remainingSec != null) {
    setBadge(t('badge.limited'));
    time.replaceChildren(formatDuration(row.remainingSec, { precise: true }), ' ', h('small', {}, t('pp.leftToday')));
    if (row.limitSec) fillBar(bar, row.usedSec, row.limitSec);
  } else if (row.blockAt) {
    setBadge(t('badge.allowedNow'));
    time.replaceChildren(formatDuration((row.blockAt - now) / 1000, { precise: true }), ' ', h('small', {}, t('pp.left')));
  } else if (row.enabled && (row.mode || row.groupName)) {
    setBadge(t('badge.allowed'));
    time.replaceChildren(formatDuration(row.usedSec), ' ', h('small', {}, t('pp.today')));
  } else {
    setBadge(t('badge.off'), 'neutral');
    time.replaceChildren(formatDuration(row.usedSec), ' ', h('small', {}, t('pp.today')));
  }

  const windowCloses = row.blockAt && (row.remainingSec == null || row.blockAt < now + row.remainingSec * 1000 - 1000);
  if (windowCloses) showNote(t('pp.allowedUntil', { time: formatClock(row.blockAt) }));
}

// ---------------------------------------------------------------------------
// Today

function usageItem({ name, badge, used, limit, blocked, value }) {
  const li = h('li', {},
    h('div', { class: 'usage-head' },
      h('span', { class: 'usage-name' }, name, badge ? h('span', { class: 'badge neutral' }, badge) : null),
      h('span', { class: `usage-value${blocked ? ' blocked' : ''}` }, value)));
  if (limit != null) li.append(fillBar(h('div', { class: 'bar' }, h('span', {})), used, limit));
  return li;
}

function renderToday({ rows, groups }) {
  const shown = rows
    .filter((r) => (r.enabled && (r.mode || r.groupName)) || r.usedSec >= 1)
    .sort((a, b) => b.usedSec - a.usedSec || a.domain.localeCompare(b.domain));

  const groupItems = groups.filter((g) => g.limitSec != null).map((g) => usageItem({
    name: g.name, badge: t('badge.group'), used: g.usedSec, limit: g.limitSec, blocked: g.usedSec >= g.limitSec,
    value: `${formatDuration(g.usedSec)} / ${formatDuration(g.limitSec)}`
  }));
  const siteItems = shown.map((r) => usageItem({
    name: r.domain,
    badge: r.pausedUntil ? t('badge.paused') : null,
    used: r.usedSec,
    limit: r.limitSec,
    blocked: r.blocked,
    value: r.blocked
      ? reasonText(r.reason)
      : r.limitSec != null ? `${formatDuration(r.usedSec)} / ${formatDuration(r.limitSec)}` : formatDuration(r.usedSec)
  }));

  $('rows').replaceChildren(...groupItems, ...siteItems);
  $('empty').hidden = groupItems.length + siteItems.length > 0;
  $('total').textContent = t('pp.total', { time: formatDuration(rows.reduce((s, r) => s + r.usedSec, 0)) });
}

// ---------------------------------------------------------------------------

$('lang-toggle').addEventListener('click', toggleLanguage);
$('settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
activeUrl = tab?.url || '';
// On our own blocked page, report the site it is standing in for.
if (activeUrl.startsWith(chrome.runtime.getURL('blocked/'))) {
  const d = new URL(activeUrl).searchParams.get('d');
  activeUrl = d ? `https://${d}/` : '';
}
await update();
setInterval(update, REFRESH_MS);
