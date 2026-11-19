/**
 * blocked.js — shows one reminder (text + source) and nothing else.
 *
 * Query string (set by background/enforcer.js): d = domain, u = original URL,
 * t = when the site opens again (optional). None of it is shown; it is used
 * only to return to the site by itself once it is allowed again: after a
 * pause, when the next allowed hours start, at the daily reset, or when a
 * rule change takes effect.
 *
 * Prayer lock ("Salah First"): r=prayer, p=prayer key, at=prayer time. Then
 * the reminder is a hadith about salah (data/salah.json) under a small line
 * "حان وقت صلاة الظهر · 11:40", and the page returns when the lock ends.
 */
import { pickQuote, load } from '../background/storage.js';
import { findSite, evaluate } from '../background/rules.js';
import { renderReminderText, autoJustify } from '../shared/poetry.js';
import { t, initPageLanguage } from '../shared/i18n.js';
import { currentPrayerLock, PRAYERS } from '../background/prayer.js';
import { formatClock } from '../shared/format.js';
import { pauseAvailability, runPauseFlow } from '../shared/pause-flow.js';

const params = new URLSearchParams(location.search);
const until = Number(params.get('t')) || null;
const originalUrl = safeHttpUrl(params.get('u'));
const prayer = params.get('r') === 'prayer' && PRAYERS.includes(params.get('p')) ? params.get('p') : null;
const prayerAt = Number(params.get('at')) || null;
const $ = (id) => document.getElementById(id);

/** Only ever go back to a plain http(s) page. */
function safeHttpUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

async function showReminder() {
  const quote = await pickQuote(prayer ? 'data/salah.json' : 'data/quotes.json');
  if (!quote) return;
  const isPoem = renderReminderText($('quote-text'), quote);
  $('reminder').classList.toggle('is-poem', isPoem);
  $('quote-source').textContent = quote.source || '';
  $('reminder').hidden = false;
  if (isPoem) autoJustify($('reminder')); // needs to be visible to measure
}

// ---------------------------------------------------------------------------
// Return to the site once it is allowed again (no buttons, no text).

let leaving = false;

async function returnIfAllowed() {
  if (leaving || !originalUrl) return;
  if (await currentPrayerLock()) return; // still prayer time: every website stays closed
  const ctx = await load(['sites', 'groups', 'settings', 'usage', 'pauses']);
  const site = findSite(originalUrl, ctx.sites);
  if (site && evaluate(site, { ...ctx, now: Date.now() }).blocked) return;
  leaving = true;
  location.replace(originalUrl); // replace: Back does not land on this page again
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.pauses || changes.sites || changes.groups || changes.prayer || changes.prayerTimes)) returnIfAllowed();
});

// At the moment it opens again (if known), and as a slow safety net: timers
// in background tabs are throttled, so also check when the tab is shown.
if (until) setTimeout(returnIfAllowed, Math.max(0, until - Date.now()) + 1000);
setInterval(returnIfAllowed, 30000);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && returnIfAllowed());

// ---------------------------------------------------------------------------
// "Pause for 5 min" link: only for a site blocked by its own rules, while
// pauses are left (a pause doesn't lift a prayer lock, so none then).

const domain = params.get('d');

async function showPauseLink() {
  if (prayer || !domain || !originalUrl) return;
  const { ok, status } = await pauseAvailability(domain);
  if (!ok) return;
  const link = $('pause-link');
  link.textContent = t('pp.pauseBtn', { n: status.pauseMinutes, left: status.pausesLeft });
  $('pause-area').hidden = false;
}

$('pause-link').addEventListener('click', async () => {
  const link = $('pause-link');
  const msg = $('pause-msg');
  link.disabled = true;
  msg.hidden = true;
  const res = await runPauseFlow(domain);
  msg.textContent = res.message;
  msg.className = `pause-msg${res.kind === 'error' ? ' error' : ''}`;
  msg.hidden = false;
  link.disabled = false;
  // On success the stored pause makes returnIfAllowed() take the tab back to the site.
  if (res.ok) returnIfAllowed();
});

// Only the tab title and the pause link are translated: the page itself is just the reminder.
initPageLanguage().then(() => {
  showPauseLink();
  document.title = t(prayer ? 'blocked.prayerTitle' : 'blocked.title');
  if (prayer) {
    const line = $('prayer-line');
    line.textContent = t('blocked.prayerNow', { name: t(`prayer.${prayer}`) }) + (prayerAt ? ` · ${formatClock(prayerAt)}` : '');
    line.hidden = false;
  }
});
showReminder();
