/**
 * prayer.js — "Salah First" (الصلاة أولًا): lock every website from a few
 * minutes before each prayer until some minutes after it.
 *
 * Storage:
 *   prayer       settings: { enabled, address, coords, method, school, before, after,
 *                prayers: { fajr: { on, adjust }, … } }  (see DEFAULT_PRAYER)
 *   prayerTimes  cache: { days: { "YYYY-MM-DD": { y, m, d, cfg, timings, timezone, approx? } },
 *                error, fetchedAt }
 *
 * Times come from the Aladhan API (api.aladhan.com). The location is either
 * the address the user typed (timingsByAddress) or, after the user pressed
 * "Use my location", coordinates rounded to 2 decimals (~1 km, timings);
 * nothing else is sent. The API answers in the location's own time zone, so
 * times are converted with that zone, not the computer's.
 *
 * No storage.js import (keeps the module graph free of cycles); reads
 * chrome.storage directly where needed.
 */
import { t } from '../shared/i18n.js';

export const PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
const API_NAMES = { fajr: 'Fajr', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' };

/** Aladhan calculation methods offered in the settings page, most common in the region first. */
export const METHODS = [5, 4, 3, 2, 1, 8, 9, 10, 16, 23, 13, 12, 18, 19, 21, 11, 15];

export const DEFAULT_PRAYER = Object.freeze({
  enabled: false,
  address: '',
  coords: null, // { lat, lng } from "Use my location"; used instead of the address when set
  method: 5, // Egyptian General Authority of Survey
  school: 0, // Asr: 0 = Shafi'i/Maliki/Hanbali, 1 = Hanafi
  before: 5, // minutes before the prayer time
  after: 15, // minutes after the prayer time
  prayers: Object.fromEntries(PRAYERS.map((p) => [p, { on: true, adjust: 0 }]))
});

/** Fill in defaults and clamp numbers. */
export function normalizePrayer(raw = {}) {
  const int = (v, lo, hi, d) => (Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : d);
  return {
    enabled: !!raw.enabled,
    address: typeof raw.address === 'string' ? raw.address.trim() : '',
    coords: normalizeCoords(raw.coords),
    method: METHODS.includes(Number(raw.method)) ? Number(raw.method) : DEFAULT_PRAYER.method,
    school: Number(raw.school) === 1 ? 1 : 0,
    before: int(raw.before, 0, 60, DEFAULT_PRAYER.before),
    after: int(raw.after, 0, 120, DEFAULT_PRAYER.after),
    prayers: Object.fromEntries(PRAYERS.map((p) => [p, {
      on: raw.prayers?.[p]?.on !== false,
      adjust: int(raw.prayers?.[p]?.adjust, -60, 60, 0)
    }]))
  };
}

/** Valid { lat, lng } rounded to 2 decimals (about 1 km: plenty for prayer times), or null. */
export function normalizeCoords(c) {
  const lat = Number(c?.lat);
  const lng = Number(c?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const r = (x) => Math.round(x * 100) / 100;
  return { lat: r(lat), lng: r(lng) };
}

/** True if a location is set (coordinates or an address). */
export const hasLocation = (p) => !!(p.coords || p.address);

/** Everything that changes the times themselves (not the lock length). */
export const cfgKey = (p) => [p.coords ? `@${p.coords.lat},${p.coords.lng}` : p.address.toLowerCase(), p.method, p.school].join('|');

// ---------------------------------------------------------------------------
// Time zones (Intl, no library)

const pad = (n) => String(n).padStart(2, '0');

/** Offset of `tz` from UTC at instant ts, in ms (Cairo in winter: +2h). */
export function tzOffsetMs(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(ts);
  const g = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ts / 1000) * 1000;
}

/** The instant when the wall clock in `tz` shows y-m-d h:mi. Falls back to the local zone. */
export function zonedToEpoch(y, m, d, h, mi, tz) {
  const wall = Date.UTC(y, m - 1, d, h, mi);
  if (!tz) return new Date(y, m - 1, d, h, mi).getTime();
  try {
    let ts = wall - tzOffsetMs(wall, tz);
    ts = wall - tzOffsetMs(ts, tz); // second pass settles DST edges
    return ts;
  } catch {
    return new Date(y, m - 1, d, h, mi).getTime();
  }
}

/** The calendar date at instant ts in `tz`: { y, m, d }. */
export function zonedDate(ts, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ts);
    const g = (type) => Number(parts.find((p) => p.type === type).value);
    return { y: g('year'), m: g('month'), d: g('day') };
  } catch {
    const d = new Date(ts);
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
  }
}

const dayKeyOf = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// ---------------------------------------------------------------------------
// Fetching

/**
 * Prayer times for one date. Throws Error(message) on a bad address or
 * network failure (the API's own message when it gives one).
 */
export async function fetchTimings({ y, m, d }, p, fetchImpl = fetch) {
  const date = `${pad(d)}-${pad(m)}-${y}`;
  const common = { method: String(p.method), school: String(p.school) };
  const url = p.coords
    ? `https://api.aladhan.com/v1/timings/${date}?${new URLSearchParams({ latitude: String(p.coords.lat), longitude: String(p.coords.lng), ...common })}`
    : `https://api.aladhan.com/v1/timingsByAddress/${date}?${new URLSearchParams({ address: p.address, ...common })}`;
  const res = await fetchImpl(url);
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.code !== 200) {
    throw new Error(typeof body?.data === 'string' ? body.data : `HTTP ${res.status}`);
  }
  const timings = {};
  for (const k of PRAYERS) {
    const match = String(body.data.timings?.[API_NAMES[k]] ?? '').match(/(\d{1,2}):(\d{2})/);
    if (!match) throw new Error('Unexpected answer from the prayer-times service.');
    timings[k] = `${match[1].padStart(2, '0')}:${match[2]}`;
  }
  return { timings, timezone: body.data.meta?.timezone || null };
}

/**
 * Make sure today's and tomorrow's times (in the location's zone) are cached
 * for the current settings. `force` refetches even if cached. If a fetch
 * fails, a nearby day's times stand in (marked approx) so locking keeps
 * working offline. Returns { ok, code?, message?, timezone? }.
 */
export async function refreshPrayerTimes({ force = false, fetchImpl = fetch } = {}) {
  const stored = await chrome.storage.local.get(['prayer', 'prayerTimes']);
  const p = normalizePrayer(stored.prayer);
  if (!hasLocation(p)) return { ok: false, code: 'noAddress' };

  const cache = { days: {}, ...(stored.prayerTimes || {}) };
  cache.days = { ...cache.days };
  const key = cfgKey(p);
  let tz = Object.values(cache.days).find((d) => d.cfg === key)?.timezone || localZone();
  const now = Date.now();
  let error = null;

  for (const offset of [0, 1]) {
    const dp = zonedDate(now + offset * 86400000, tz);
    const k = dayKeyOf(dp);
    const have = cache.days[k];
    if (!force && have?.cfg === key && !have.approx) continue;
    try {
      const r = await fetchTimings(dp, p, fetchImpl);
      if (r.timezone) tz = r.timezone;
      cache.days[k] = { ...dp, cfg: key, timings: r.timings, timezone: r.timezone || tz };
    } catch (e) {
      error = e.message || String(e);
      const near = Object.values(cache.days).find((d) => d.cfg === key && !d.approx);
      if (near && have?.cfg !== key) cache.days[k] = { ...dp, cfg: key, timings: near.timings, timezone: near.timezone, approx: true };
    }
  }

  // Keep yesterday (an Isha lock can run past midnight), today and tomorrow.
  const oldest = dayKeyOf(zonedDate(now - 86400000, tz));
  for (const k of Object.keys(cache.days)) if (k < oldest) delete cache.days[k];

  cache.error = error;
  cache.fetchedAt = now;
  await chrome.storage.local.set({ prayerTimes: cache });
  return error ? { ok: false, code: 'fetch', message: error } : { ok: true, timezone: tz };
}

/** True if today's or tomorrow's times are missing (worth a retry). */
export function needsRefresh(p, cache, now = Date.now()) {
  if (!hasLocation(p)) return false;
  const key = cfgKey(p);
  const tz = Object.values(cache?.days || {}).find((d) => d.cfg === key)?.timezone || localZone();
  return [0, 1].some((o) => {
    const day = cache?.days?.[dayKeyOf(zonedDate(now + o * 86400000, tz))];
    return !day || day.cfg !== key || day.approx;
  });
}

// ---------------------------------------------------------------------------
// Lock windows

/** The prayer time (ms) of `prayer` on a cached day, including the user's adjustment. */
function prayerAt(day, prayer, p) {
  const [h, mi] = day.timings[prayer].split(':').map(Number);
  return zonedToEpoch(day.y, day.m, day.d, h, mi, day.timezone) + p.prayers[prayer].adjust * 60000;
}

/**
 * Lock windows from the cache, for the current settings:
 * [{ prayer, at, start, end }] sorted by start. Empty if the feature is off.
 */
export function lockWindows(p, cache) {
  if (!p.enabled) return [];
  const key = cfgKey(p);
  const out = [];
  for (const day of Object.values(cache?.days || {})) {
    if (day.cfg !== key) continue;
    for (const prayer of PRAYERS) {
      if (!p.prayers[prayer].on || !day.timings?.[prayer]) continue;
      const at = prayerAt(day, prayer, p);
      out.push({ prayer, at, start: at - p.before * 60000, end: at + p.after * 60000 });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export const activeLock = (windows, now = Date.now()) => windows.find((w) => w.start <= now && now < w.end) || null;
export const nextLock = (windows, now = Date.now()) => windows.find((w) => w.start > now) || null;

/** The next moment a lock starts or ends (for an exact alarm), or null. */
export function nextBoundary(windows, now = Date.now()) {
  const times = windows.flatMap((w) => [w.start, w.end]).filter((x) => x > now);
  return times.length ? Math.min(...times) : null;
}

/** Load settings + cache and return the lock active now (or null). */
export async function currentPrayerLock(now = Date.now()) {
  const { prayer, prayerTimes } = await chrome.storage.local.get(['prayer', 'prayerTimes']);
  return activeLock(lockWindows(normalizePrayer(prayer), prayerTimes), now);
}

/** Today's times for display: { timings, timezone, approx } for the location's today, or null. */
export function todayTimes(p, cache, now = Date.now()) {
  const key = cfgKey(p);
  const tz = Object.values(cache?.days || {}).find((d) => d.cfg === key)?.timezone || localZone();
  const day = cache?.days?.[dayKeyOf(zonedDate(now, tz))];
  return day && day.cfg === key ? day : null;
}

/** Display time "HH:MM" of a prayer today, with the adjustment applied. */
export function adjustedTime(day, prayer, p) {
  const [h, mi] = day.timings[prayer].split(':').map(Number);
  const total = (h * 60 + mi + p.prayers[prayer].adjust + 1440) % 1440;
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

// ---------------------------------------------------------------------------
// Anti-cheat

/**
 * Why `next` weakens "Salah First" compared with `prev` (empty = not looser).
 * Setting it up while it is off is never looser.
 */
export function prayerLoosening(prev, next) {
  prev = normalizePrayer(prev);
  next = normalizePrayer(next);
  if (!prev.enabled) return [];
  if (!next.enabled) return [t('pl.off')];
  const reasons = [];
  if (cfgKey(prev) !== cfgKey(next)) reasons.push(t('pl.location'));
  if (next.before < prev.before) reasons.push(t('pl.before', { a: prev.before, b: next.before }));
  if (next.after < prev.after) reasons.push(t('pl.after', { a: prev.after, b: next.after }));
  for (const k of PRAYERS) {
    const name = t(`prayer.${k}`);
    if (prev.prayers[k].on && !next.prayers[k].on) reasons.push(t('pl.prayerOff', { name }));
    else if (next.prayers[k].on && prev.prayers[k].adjust !== next.prayers[k].adjust) {
      reasons.push(t('pl.adjust', { name, a: prev.prayers[k].adjust, b: next.prayers[k].adjust }));
    }
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Alarms (service worker)

export const PRAYER_ALARMS = { boundary: 'prayer', refresh: 'prayer-refresh' };

/** Wake exactly when the next lock starts or ends; keep a periodic refresh while a city is set. */
export async function schedulePrayerAlarms(now = Date.now()) {
  const { prayer, prayerTimes } = await chrome.storage.local.get(['prayer', 'prayerTimes']);
  const p = normalizePrayer(prayer);
  const next = nextBoundary(lockWindows(p, prayerTimes), now);
  if (next) await chrome.alarms.create(PRAYER_ALARMS.boundary, { when: next + 500 });
  else await chrome.alarms.clear(PRAYER_ALARMS.boundary);
  if (hasLocation(p)) {
    if (!(await chrome.alarms.get(PRAYER_ALARMS.refresh))) {
      await chrome.alarms.create(PRAYER_ALARMS.refresh, { periodInMinutes: 120 });
    }
  } else {
    await chrome.alarms.clear(PRAYER_ALARMS.refresh);
  }
}

/**
 * Refresh only when useful: today's/tomorrow's times are missing or
 * approximate (retry at most every 15 min), or the cache is over 12 h old.
 */
export async function maybeRefreshPrayer(now = Date.now()) {
  const { prayer, prayerTimes } = await chrome.storage.local.get(['prayer', 'prayerTimes']);
  const p = normalizePrayer(prayer);
  if (!hasLocation(p)) return null;
  const age = now - (prayerTimes?.fetchedAt || 0);
  if ((needsRefresh(p, prayerTimes, now) && age > 15 * 60000) || age > 12 * 3600000) return refreshPrayerTimes();
  return null;
}
