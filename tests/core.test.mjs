// Phases 1–3: domain matching, days/reset, time crediting, limits, schedules, groups,
// and tracking with page heartbeats when the OS focus/idle signals are wrong.
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
let NOW = new Date(2026, 10, 18, 10, 0, 0).getTime();
const realNow = Date.now;
const mkArea = () => { const d = {}; return {
  get: async (k) => { const ks = Array.isArray(k) ? k : [k]; const o = {}; for (const x of ks) if (x in d) o[x] = structuredClone(d[x]); return o; },
  set: async (o) => { Object.assign(d, structuredClone(o)); } }; };
const tabs = { 7: { id: 7, windowId: 1, active: true, url: 'https://www.youtube.com/watch?v=1', audible: false } };
globalThis.chrome = {
  runtime: { getURL: (p) => 'chrome-extension://x/' + p },
  storage: { local: mkArea(), session: mkArea() },
  tabs: { get: async (id) => tabs[id], query: async () => Object.values(tabs), update: async () => {}, sendMessage: async () => {} },
  windows: { getLastFocused: async () => ({ id: 1, focused: false }) }, // broken OS signal
  idle: { queryState: async () => 'locked' },                           // broken OS signal
  alarms: { create: async () => {}, clear: async () => {} }
};
const { normalizeDomain, makeSite, makeGroup } = await import(root + '/background/storage.js');
const R = await import(root + '/background/rules.js');
const tr = await import(root + '/background/tracker.js');
let fails = 0;
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.log('FAIL', m, '\n  got ', JSON.stringify(a), '\n  want', JSON.stringify(b)); fails++; } else console.log('ok  ', m); };
const T = (d, h, mi = 0, s = 0) => new Date(2026, 10, d, h, mi, s).getTime();
const settings = { resetHour: 0 };

// Domains
eq(normalizeDomain('https://www.YouTube.com/watch?v=1'), 'youtube.com', 'normalize URL');
eq(normalizeDomain('hello'), null, 'reject non-domain');
const sites = [makeSite('x.com'), makeSite('whatsapp.com'), makeSite('web.whatsapp.com')];
eq(R.findSite('https://box.com/', sites), null, 'x.com does not match box.com');
eq(R.findSite('https://x.com.evil.io/', sites), null, 'no suffix trick');
eq(R.findSite('https://mobile.x.com/a', sites)?.domain, 'x.com', 'subdomain');
eq(R.findSite('https://web.whatsapp.com/', sites)?.domain, 'web.whatsapp.com', 'longest match wins');

// Days and reset
eq(R.dayKey(T(19, 2), 4), '2026-11-18', 'logical day with reset 04:00');
eq(R.nextResetAt(T(18, 10), 4), T(19, 4), 'next reset');
const u = tr.creditTime({}, 'x.com', T(18, 23, 59, 40), T(19, 0, 0, 20));
eq([u['2026-11-18'].seconds['x.com'], u['2026-11-19'].seconds['x.com']], [20, 20], 'midnight split');
eq(tr.creditTime({}, 'x.com', T(18, 10), T(18, 14))['2026-11-18'].seconds['x.com'], 75, 'sleep gap capped');

// Limit
const yt = makeSite('youtube.com'); yt.rules[0] = { ...yt.rules[0], mode: 'limit', limitMinutes: 20 };
const use = (n) => ({ '2026-11-18': { seconds: { 'youtube.com': n } } });
eq(R.evaluate(yt, { now: T(18, 12), settings, usage: use(1190) }).remainingSec, 10, 'limit remaining');
eq(R.evaluate(yt, { now: T(18, 12), settings, usage: use(1200) }).until, T(19, 0), 'limit hit → next reset');

// Schedule, combined, days
const W = (start, end) => ({ start, end });
const wa = makeSite('web.whatsapp.com');
wa.rules = [{ days: [0,1,2,3,4,5,6], mode: 'schedule', limitMinutes: 0, windows: [W('13:00','13:30'), W('21:00','21:30')] }];
eq(R.evaluate(wa, { now: T(18, 13, 10), settings, usage: {} }).blockAt, T(18, 13, 30), 'window end');
eq(R.evaluate(wa, { now: T(18, 14), settings, usage: {} }).until, T(18, 21), 'next window');
eq(R.inWindow(R.parseHM('00:30'), W('22:00','01:00')), true, 'window across midnight');
wa.rules[0].mode = 'limit+schedule'; wa.rules[0].limitMinutes = 20;
eq(R.evaluate(wa, { now: T(18, 13, 10), settings, usage: { '2026-11-18': { seconds: { 'web.whatsapp.com': 1200 } } } }).until, T(19, 13), 'combined: spent → tomorrow\'s window');
const days = makeSite('reddit.com');
days.rules = [{ days: [0,1,2,3,4], mode: 'block', limitMinutes: 0, windows: [] }, { days: [5,6], mode: 'limit', limitMinutes: 45, windows: [] }];
eq(R.evaluate(days, { now: T(18, 10), settings, usage: {} }).until, T(20, 0), 'weekday block until Friday');

// Groups
const g = makeGroup('Messaging'); g.rules[0].limitMinutes = 30;
const m1 = makeSite('web.whatsapp.com'); m1.rules = []; m1.groupId = g.id;
const m2 = makeSite('web.telegram.org'); m2.rules = []; m2.groupId = g.id;
const gu = { '2026-11-18': { seconds: { 'web.whatsapp.com': 1000, 'web.telegram.org': 800 } } };
const gv = R.evaluate(m2, { now: T(18, 10), settings, usage: gu, sites: [m1, m2], groups: [g] });
eq([gv.blocked, gv.reason, gv.group?.name], [true, 'limit', 'Messaging'], 'shared group budget');

// Tracking with broken OS signals, via page heartbeats
Date.now = () => NOW;
await chrome.storage.local.set({ sites: [yt], groups: [] });
const used = async () => (await chrome.storage.local.get('usage')).usage?.['2026-11-18']?.seconds?.['youtube.com'] || 0;
const beat = (o = {}) => tr.recordActivity(7, { focused: true, lastInputAt: NOW, playing: false, ...o });
await beat();
for (let i = 0; i < 6; i++) { NOW += 10000; await beat(); }
await tr.refresh();
eq(await used(), 60, 'heartbeats: 60 s counted despite broken OS signals');
const last = NOW;
for (let i = 0; i < 12; i++) { NOW += 10000; await beat({ lastInputAt: last }); }
await tr.refresh();
eq(await used(), 120, 'idle in page: stops after 60 s');
Date.now = realNow;
console.log(fails ? `${fails} failed` : 'all passed');
if (fails) process.exitCode = 1;
