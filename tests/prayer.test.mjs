// Salah First: time zones, lock windows, fetching (fake API), offline fallback, anti-cheat.
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const store = {};
globalThis.chrome = { storage: { local: {
  get: async (k) => { const ks = Array.isArray(k) ? k : [k]; const o = {}; for (const x of ks) if (x in store) o[x] = structuredClone(store[x]); return o; },
  set: async (o) => { Object.assign(store, structuredClone(o)); }
} } };
const P = await import(root + '/background/prayer.js');
const i18n = await import(root + '/shared/i18n.js');
i18n.setLanguage('en');
let fails = 0;
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.log('FAIL', m, '\n  got ', JSON.stringify(a), '\n  want', JSON.stringify(b)); fails++; } else console.log('ok  ', m); };

// Time zones: 11:40 in Cairo (UTC+2 in November) is 09:40 UTC, whatever the computer's zone.
eq(new Date(P.zonedToEpoch(2026, 11, 19, 11, 40, 'Africa/Cairo')).toISOString(), '2026-11-19T09:40:00.000Z', 'Cairo wall time → UTC');
eq(new Date(P.zonedToEpoch(2026, 7, 1, 12, 0, 'Europe/London')).toISOString(), '2026-07-01T11:00:00.000Z', 'London summer time (BST)');
eq(P.zonedDate(Date.UTC(2026, 10, 19, 23, 30), 'Africa/Cairo'), { y: 2026, m: 11, d: 20 }, 'date in the location zone (already tomorrow)');

// Defaults and clamping
const p0 = P.normalizePrayer({ enabled: true, address: ' Cairo, Egypt ', before: 999, prayers: { asr: { on: false, adjust: 5 } } });
eq([p0.address, p0.before, p0.after, p0.prayers.asr, p0.prayers.fajr], ['Cairo, Egypt', 5, 15, { on: false, adjust: 5 }, { on: true, adjust: 0 }], 'normalize');

// Fake Aladhan API
const day = { Fajr: '04:53', Sunrise: '06:23', Dhuhr: '11:40', Asr: '14:38', Maghrib: '16:57', Isha: '18:18 (EET)' };
let calls = [];
const okApi = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ code: 200, data: { timings: day, meta: { timezone: 'Africa/Cairo' } } }) }; };
const badApi = async () => ({ ok: false, status: 400, json: async () => ({ code: 400, status: 'BAD_REQUEST', data: 'Unable to geocode address: zzz' }) });
const downApi = async () => { throw new Error('Failed to fetch'); };

const r = await P.fetchTimings({ y: 2026, m: 11, d: 19 }, p0, okApi);
eq(r, { timings: { fajr: '04:53', dhuhr: '11:40', asr: '14:38', maghrib: '16:57', isha: '18:18' }, timezone: 'Africa/Cairo' }, 'parse timings (ignores " (EET)")');
eq(calls[0].startsWith('https://api.aladhan.com/v1/timingsByAddress/19-11-2026?address=Cairo%2C+Egypt&method=5&school=0'), true, 'request URL');
let err = null; try { await P.fetchTimings({ y: 2026, m: 11, d: 19 }, p0, badApi); } catch (e) { err = e.message; }
eq(err, 'Unable to geocode address: zzz', 'API error message passed through');

// refresh → cache today + tomorrow
store.prayer = { enabled: true, address: 'Cairo, Egypt', method: 5 };
calls = [];
eq((await P.refreshPrayerTimes({ fetchImpl: okApi })).ok, true, 'refresh ok');
eq([calls.length, Object.keys(store.prayerTimes.days).length], [2, 2], 'fetched today and tomorrow');
calls = [];
await P.refreshPrayerTimes({ fetchImpl: okApi });
eq(calls.length, 0, 'cached: no refetch');

// Windows: 5 min before → 15 min after, adjust applied, prayer switches respected
const p = P.normalizePrayer(store.prayer);
const w = P.lockWindows(p, store.prayerTimes);
eq(w.length, 10, '5 prayers × 2 days');
const dhuhr = w.find((x) => x.prayer === 'dhuhr');
eq([new Date(dhuhr.start).toISOString().slice(11, 16), new Date(dhuhr.end).toISOString().slice(11, 16)], ['09:35', '09:55'], 'Dhuhr 11:40 Cairo → locked 11:35–11:55 (UTC 09:35–09:55)');
eq(P.activeLock(w, dhuhr.start + 1000)?.prayer, 'dhuhr', 'locked just after the start');
eq(P.activeLock(w, dhuhr.start - 1000), null, 'open just before');
eq(P.activeLock(w, dhuhr.end), null, 'open at the end');
eq(P.nextBoundary(w, dhuhr.start + 1000), dhuhr.end, 'next boundary = end of the current lock');
eq(P.nextLock(w, dhuhr.start - 1000)?.prayer, 'dhuhr', 'next lock (for the status line)');
const adj = P.normalizePrayer({ ...store.prayer, prayers: { dhuhr: { on: true, adjust: 10 } } });
eq(P.lockWindows(adj, store.prayerTimes).find((x) => x.prayer === 'dhuhr').at - dhuhr.at, 600000, '+10 min adjustment moves the lock');
const noAsr = P.normalizePrayer({ ...store.prayer, prayers: { asr: { on: false } } });
eq(P.lockWindows(noAsr, store.prayerTimes).some((x) => x.prayer === 'asr'), false, 'a switched-off prayer never locks');
eq(P.lockWindows(P.normalizePrayer({ ...store.prayer, enabled: false }), store.prayerTimes), [], 'feature off → no locks');
eq(P.adjustedTime(P.todayTimes(adj, store.prayerTimes), 'dhuhr', adj), '11:50', 'displayed adjusted time');

// Offline: a missing day borrows a cached day's times (approx) so locking keeps working
store.prayerTimes.days = Object.fromEntries(Object.entries(store.prayerTimes.days).slice(0, 1));
const res = await P.refreshPrayerTimes({ fetchImpl: downApi });
eq([res.ok, res.code, Object.values(store.prayerTimes.days).some((d) => d.approx)], [false, 'fetch', true], 'offline → approximate from cache');
eq(P.needsRefresh(p, store.prayerTimes), true, 'approx day → retry later');

// Address change → times are for the old place: refresh refetches
store.prayer = { ...store.prayer, address: 'Alexandria, Egypt' };
calls = [];
await P.refreshPrayerTimes({ fetchImpl: okApi });
eq(calls.length, 2, 'new address → refetch');

// Anti-cheat
const on = { enabled: true, address: 'Cairo', before: 5, after: 15 };
eq(P.prayerLoosening({ ...on, enabled: false }, { enabled: false, address: 'x', before: 0 }), [], 'setting up while off is free');
eq(P.prayerLoosening(on, { ...on, before: 10, after: 20 }), [], 'more minutes = stricter');
eq(P.prayerLoosening(on, { ...on, enabled: false }), ['Salah First switched off'], 'switch off');
eq(P.prayerLoosening(on, { ...on, before: 2, prayers: { isha: { on: false } } }),
  ['minutes before the prayer reduced from 5 to 2', 'Isha: switched off'], 'fewer minutes + prayer off');
eq(P.prayerLoosening(on, { ...on, address: 'London' }), ['location or calculation method changed'], 'location change');
eq(P.prayerLoosening(on, { ...on, prayers: { fajr: { on: true, adjust: 5 } } }), ['Fajr: time adjusted from 0 to 5 min'], 'time adjustment');

// Use my location: coordinates rounded to ~1 km, coordinates endpoint, cache key, anti-cheat
eq(P.normalizeCoords({ lat: 30.04442, lng: 31.235712 }), { lat: 30.04, lng: 31.24 }, 'rounded to 2 decimals');
eq(P.normalizeCoords({ lat: 200, lng: 0 }), null, 'invalid coordinates rejected');
const pc = P.normalizePrayer({ coords: { lat: 30.04442, lng: 31.235712 }, address: 'ignored when coords are set', method: 5 });
eq(P.hasLocation(pc), true, 'coordinates count as a location');
calls = [];
await P.fetchTimings({ y: 2026, m: 11, d: 19 }, pc, okApi);
eq(calls[0], 'https://api.aladhan.com/v1/timings/19-11-2026?latitude=30.04&longitude=31.24&method=5&school=0', 'coordinates URL (no address sent)');
eq(P.cfgKey(pc) !== P.cfgKey(P.normalizePrayer({ address: 'Cairo', method: 5 })), true, 'coords and city cache separately');
eq(P.prayerLoosening({ ...on }, { ...on, coords: { lat: 30.04, lng: 31.24 } }), ['location or calculation method changed'], 'switching to coordinates while on = looser');
eq(P.prayerLoosening({ ...on, enabled: false }, { ...on, enabled: false, coords: { lat: 1, lng: 2 } }), [], 'locating while off is free');

console.log(fails ? `${fails} failed` : 'all passed');
if (fails) process.exitCode = 1;
