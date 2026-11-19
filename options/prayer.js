/**
 * prayer.js (options) — the "Salah First" tab: city + method, lock length,
 * today's times with a switch and a ± minutes adjustment per prayer, and a
 * live status line ("Websites close in 12m").
 *
 * Location: "Use my location" asks the browser (navigator.geolocation; the
 * manifest's geolocation permission) only when pressed, keeps coordinates
 * rounded to ~1 km, and saves; or the user types a city.
 *
 * Saving: setting up while the feature is off is free; once on, anything
 * that weakens it (background/prayer.js prayerLoosening) needs the friction
 * step first. The service worker fetches the times when the city changes.
 */
import {
  PRAYERS, METHODS, normalizePrayer, normalizeCoords, hasLocation, prayerLoosening, lockWindows,
  activeLock, nextLock, todayTimes, adjustedTime
} from '../background/prayer.js';
import { runFriction } from './friction.js';
import { h } from '../shared/dom.js';
import { icon } from '../shared/icons.js';
import { t, ltr } from '../shared/i18n.js';
import { formatClock, formatDuration } from '../shared/format.js';

const $ = (id) => document.getElementById(id);

/** The rows' controls, rebuilt by renderTimes(). */
let rowControls = {};
/** True while the form has unsaved edits (so live updates don't overwrite them). */
let dirty = false;
/** Coordinates in the form ({ lat, lng } or null = use the typed city). */
let formCoords = null;

async function loadPrayer() {
  const { prayer, prayerTimes } = await chrome.storage.local.get(['prayer', 'prayerTimes']);
  return { p: normalizePrayer(prayer), cache: prayerTimes || { days: {} } };
}

// ---------------------------------------------------------------------------
// Status line

async function renderStatus() {
  const { p, cache } = await loadPrayer();
  const box = $('prayer-status');
  const now = Date.now();
  const lock = activeLock(lockWindows(p, cache), now);
  $('prayer-dot').hidden = !lock;

  let iconName = 'moon-star';
  let lines;
  if (!hasLocation(p)) lines = [t('ps.noAddress')];
  else if (!p.enabled) lines = [t('ps.off')];
  else if (lock) {
    iconName = 'lock';
    lines = [t('ps.locked', { name: t(`prayer.${lock.prayer}`), time: formatClock(lock.end) })];
  } else {
    const next = nextLock(lockWindows(p, cache), now);
    lines = next
      ? [t('ps.next', { name: t(`prayer.${next.prayer}`), time: formatClock(next.at) }),
         t('ps.nextIn', { dur: formatDuration((next.start - now) / 1000) })]
      : [t('ps.noNext')];
  }
  if (cache.error && hasLocation(p)) lines.push(t('prayer.fetchError', { msg: cache.error }));

  box.className = `card prayer-status${lock ? ' locked' : ''}${!p.enabled ? ' off' : ''}`;
  box.replaceChildren(
    h('span', { class: 'status-icon' }, icon(iconName)),
    h('div', { class: 'status-text' }, h('strong', {}, lines[0]), ...lines.slice(1).map((l) => h('p', { class: 'muted small' }, l))));
}

// ---------------------------------------------------------------------------
// Form

function fillSelects() {
  const method = $('pr-method');
  if (!method.options.length) {
    for (const m of METHODS) method.add(new Option(t(`method.${m}`), String(m)));
    $('pr-school').add(new Option(t('prayer.school0'), '0'));
    $('pr-school').add(new Option(t('prayer.school1'), '1'));
  }
}

function fillForm(p) {
  fillSelects();
  $('pr-enabled').checked = p.enabled;
  $('pr-address').value = p.address;
  formCoords = p.coords;
  showLocation();
  $('pr-method').value = String(p.method);
  $('pr-school').value = String(p.school);
  $('pr-before').value = p.before;
  $('pr-after').value = p.after;
}

/** With coordinates: show the "Your location · 30.04, 31.24" chip instead of the city field. */
function showLocation() {
  $('pr-here').hidden = !formCoords;
  $('pr-address-field').hidden = !!formCoords;
  $('pr-locate').hidden = !!formCoords;
  if (formCoords) $('pr-coords').textContent = `${formCoords.lat.toFixed(2)}, ${formCoords.lng.toFixed(2)}`;
}

/** Ask the browser for the position (only on the user's click). Resolves { lat, lng } or rejects with a message. */
function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(t('prayer.locUnavailable'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(normalizeCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude })),
      (err) => reject(t({ 1: 'prayer.locDenied', 3: 'prayer.locTimeout' }[err.code] || 'prayer.locUnavailable')),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60 * 1000 }
    );
  });
}

/** Today's five prayers: name, time, lock window, ± adjustment, switch. */
function renderTimes(p, cache) {
  const day = todayTimes(p, cache);
  $('pr-empty').hidden = !!day;
  rowControls = {};
  $('pr-list').replaceChildren(...PRAYERS.map((k) => {
    const name = t(`prayer.${k}`);
    const adjust = h('input', { type: 'number', class: 'adjust', min: '-60', max: '60', step: '1', inputmode: 'numeric', value: String(p.prayers[k].adjust), 'aria-label': t('prayer.adjustLabel', { name }) });
    const toggle = h('input', { type: 'checkbox', checked: p.prayers[k].on, 'aria-label': t('prayer.toggleLabel', { name }) });
    rowControls[k] = { adjust, toggle };

    let time = '—';
    let windowText = '';
    if (day) {
      const at = adjustedTime(day, k, p);
      const [hh, mm] = at.split(':').map(Number);
      const shift = (mins) => {
        const total = (hh * 60 + mm + mins + 1440) % 1440;
        return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
      };
      time = at;
      windowText = t('prayer.window', { from: ltr(shift(-p.before)), to: ltr(shift(p.after)) });
    }
    return h('li', { class: `prayer-row${p.prayers[k].on ? '' : ' off'}` },
      h('span', { class: 'prayer-name' }, name),
      h('span', { class: 'prayer-time' }, ltr(time), day?.approx ? h('span', { class: 'badge neutral', title: t('prayer.approx') }, '≈') : null),
      h('span', { class: 'prayer-window muted small' }, windowText),
      h('label', { class: 'adjust-wrap' }, h('span', { class: 'muted small' }, '±'), adjust),
      h('label', { class: 'switch' }, toggle, h('span', { 'aria-hidden': 'true' })));
  }));
}

/** Read the form into a settings object (not yet validated). */
function readForm() {
  return {
    enabled: $('pr-enabled').checked,
    address: $('pr-address').value.trim(),
    coords: formCoords,
    method: Number($('pr-method').value),
    school: Number($('pr-school').value),
    before: Number($('pr-before').value),
    after: Number($('pr-after').value),
    prayers: Object.fromEntries(PRAYERS.map((k) => [k, {
      on: rowControls[k]?.toggle.checked ?? true,
      adjust: Number(rowControls[k]?.adjust.value ?? 0)
    }]))
  };
}

function validate(raw) {
  const errors = [];
  if (raw.enabled && !raw.address && !raw.coords) errors.push(t('prayer.needAddress'));
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!int(raw.before, 0, 60) || !int(raw.after, 0, 120) || PRAYERS.some((k) => !int(raw.prayers[k].adjust, -60, 60))) {
    errors.push(t('prayer.badNumbers'));
  }
  return errors;
}

/** Render the whole tab from storage (skips the form while it has unsaved edits). */
export async function renderPrayer({ force = false } = {}) {
  const { p, cache } = await loadPrayer();
  await renderStatus();
  if (dirty && !force) return;
  fillForm(p);
  renderTimes(p, cache);
}

/**
 * Wire the form. `toast(text, kind)` reports results; returns nothing.
 */
export function initPrayer(toast) {
  const form = $('prayer-form');
  form.addEventListener('input', () => { dirty = true; });
  form.addEventListener('change', () => { dirty = true; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorsBox = $('pr-errors');
    const raw = readForm();
    const errors = validate(raw);
    errorsBox.replaceChildren(...errors.map((m) => h('li', {}, m)));
    if (errors.length) return;

    const { prayer: stored } = await chrome.storage.local.get('prayer');
    const next = normalizePrayer(raw);
    const reasons = prayerLoosening(stored, next);
    if (reasons.length) {
      const ok = await runFriction({ title: t('prayer.loosenTitle'), reasons, note: t('fr.note'), confirmLabel: t('fr.apply') });
      if (!ok) {
        toast(t('cancelled'));
        return;
      }
    }
    dirty = false;
    await chrome.storage.local.set({ prayer: next }); // the worker fetches times if the city changed
    toast(t('prayer.saved') + '.', 'ok');
    renderPrayer({ force: true });
  });

  // "Use my location": find it, then save right away (the friction step still
  // applies if Salah First is on, since a new location changes the times).
  $('pr-locate').addEventListener('click', async () => {
    const btn = $('pr-locate');
    btn.disabled = true;
    btn.lastElementChild.textContent = t('prayer.locating');
    try {
      formCoords = await locate();
      dirty = true;
      showLocation();
      toast(t('prayer.located'), 'ok');
      form.requestSubmit();
    } catch (message) {
      toast(String(message), 'error');
    } finally {
      btn.disabled = false;
      btn.lastElementChild.textContent = t('prayer.locate');
    }
  });

  $('pr-type-city').addEventListener('click', () => {
    formCoords = null;
    dirty = true;
    showLocation();
    $('pr-address').focus();
  });

  $('pr-refresh').addEventListener('click', async () => {
    const btn = $('pr-refresh');
    btn.disabled = true;
    toast(t('prayer.fetching'));
    const res = await chrome.runtime.sendMessage({ type: 'prayer-refresh' }).catch(() => null);
    btn.disabled = false;
    if (res?.ok) toast(t('prayer.fetched'), 'ok');
    else if (res?.code === 'noAddress') toast(t('ps.noAddress'), 'error');
    else toast(t('prayer.fetchError', { msg: res?.message || '?' }), 'error');
  });

  // Live: times arrive from the worker; the status counts down.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.prayer || changes.prayerTimes)) renderPrayer();
  });
  setInterval(renderStatus, 30000);
}
