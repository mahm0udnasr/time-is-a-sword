const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
let NOW = new Date(2026, 10, 18, 10, 0, 0).getTime();
Date.now = () => NOW;
const mkArea = () => { const d = {}; return { d,
  get: async (k) => { const ks = Array.isArray(k) ? k : [k]; const o = {}; for (const x of ks) if (x in d) o[x] = structuredClone(d[x]); return o; },
  set: async (o) => { Object.assign(d, structuredClone(o)); } }; };
const tabs = { 7: { id: 7, windowId: 1, active: true, url: 'https://www.youtube.com/', audible: false } };
const sent = [], alarms = {}, redirected = [];
globalThis.chrome = {
  runtime: { getURL: (p) => 'chrome-extension://x/' + p },
  storage: { local: mkArea(), session: mkArea() },
  tabs: { get: async (id) => tabs[id], query: async () => Object.values(tabs),
          update: async (id, o) => { redirected.push(o.url); tabs[id].url = o.url; },
          sendMessage: async (id, m) => { sent.push(m); } },
  windows: { getLastFocused: async () => ({ id: 1, focused: true }) },
  idle: { queryState: async () => 'active' },
  alarms: { create: async (n, o) => { alarms[n] = o.when; }, clear: async (n) => { delete alarms[n]; } }
};
const { makeSite, DEFAULT_SETTINGS } = await import(root + '/background/storage.js');
const tr = await import(root + '/background/tracker.js');
const { applyChanges } = await import(root + '/background/changes.js');
const { diffState } = await import(root + '/background/loosen.js');
let fails = 0;
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.log('FAIL', m, '\n  got ', JSON.stringify(a), '\n  want', JSON.stringify(b)); fails++; } else console.log('ok  ', m); };

eq(tr.dueWarnings([5, 1], [], 400), { due: [], next: 5 }, 'dueWarnings ahead');
eq(tr.dueWarnings([5, 1], [], 290), { due: [5], next: 1 }, 'dueWarnings 5');
eq(tr.dueWarnings([5, 1], [], 30), { due: [5, 1], next: null }, 'dueWarnings both when opened late');

const yt = makeSite('youtube.com'); yt.rules[0].mode = 'limit'; yt.rules[0].limitMinutes = 10;
await chrome.storage.local.set({ sites: [yt], groups: [], settings: { ...DEFAULT_SETTINGS } });
const beat = () => tr.recordActivity(7, { focused: true, lastInputAt: NOW, playing: false });
// Use the site, with a heartbeat + tick every 10 s, for 10 minutes.
await beat();
const alarmAtStart = alarms.warn;
eq(alarmAtStart, NOW + 5 * 60000 + 250, 'warn alarm set for 5 min before the end');
for (let t = 0; t < 60; t++) { NOW += 10000; await beat(); await tr.refresh(); }
eq(sent.map((m) => Math.round(m.secondsLeft / 60)), [5, 1], 'two warnings sent: 5 and 1 minute');
eq(redirected.length, 1, 'redirected when the budget ran out');
eq(redirected[0]?.includes('r=limit'), true, 'reason limit');

// Pause: 1 of 3, then the tab is allowed again.
tabs[7].url = 'https://www.youtube.com/';
const res = await tr.requestPause('youtube.com');
eq([res.ok, res.left, res.until], [true, 2, NOW + 5 * 60000], 'pause granted');
await tr.requestPause('youtube.com'); await tr.requestPause('youtube.com');
eq((await tr.requestPause('youtube.com')).ok, false, 'fourth pause refused');
const { pauses } = await chrome.storage.local.get('pauses');
eq(!!pauses['youtube.com'], true, 'pause stored');

// Confirmed changes apply at once (no waiting until tomorrow).
const cur = (await chrome.storage.local.get(['sites', 'groups']));
const next = structuredClone(cur); next.sites[0].rules[0].limitMinutes = 60;
const ops = diffState(cur, next);
eq(ops[0].reasons.length > 0, true, 'raising the limit is looser');
await applyChanges(ops);
let st = await chrome.storage.local.get(['sites']);
eq(st.sites[0].rules[0].limitMinutes, 60, 'applied immediately');

// Clean-up of data from older versions: settings → only theme, quotes removed,
// changes still waiting for tomorrow applied now (settings ones dropped);
// reminders come from data/quotes.json.
const fs = await import('node:fs');
globalThis.fetch = async (url) => ({ json: async () => JSON.parse(fs.readFileSync(root + '/' + url.replace('chrome-extension://x/', ''), 'utf8')) });
chrome.storage.local.remove = async (k) => { for (const key of [].concat(k)) delete chrome.storage.local.d[key]; };
await chrome.storage.local.set({
  settings: { ...DEFAULT_SETTINGS, resetHour: 4, theme: 'dark' },
  quotes: [{ id: 'old', text: 'x' }],
  pending: [{ id: 'p', effectiveDay: '2026-11-20', reasons: ['a', 'b'], ops: [
    { kind: 'setting', id: 'resetHour', op: 'put', value: 4, label: 'New day starts at', reasons: ['changed'] },
    { kind: 'site', id: yt.id, op: 'put', value: { ...yt, enabled: false }, label: 'youtube.com', reasons: ['switched off'] }] }]
});
const { ensureSeeded, load, pickQuote, getQuotes } = await import(root + '/background/storage.js');
await ensureSeeded();
const after = await chrome.storage.local.get(['settings', 'quotes', 'pending', 'sites']);
eq(after.settings, { theme: 'dark', lang: 'ar' }, 'stored settings trimmed to theme + language (Arabic by default)');
eq(after.quotes, undefined, 'stored reminders removed');
eq(after.pending, undefined, 'waiting queue removed');
eq(after.sites.find((x) => x.id === yt.id).enabled, false, 'a change that was waiting is applied now');
eq((await load(['settings'])).settings.resetHour, 0, 'settings are the fixed defaults');
eq((await load(['settings'])).settings.theme, 'dark', 'theme kept');
const qs = await getQuotes();
eq(qs.length >= 1 && qs[0].id === 'q0', true, 'reminders read from data/quotes.json');
const a1 = await pickQuote(), a2 = await pickQuote();
eq(a1.id !== a2.id, true, 'no reminder twice in a row');

console.log(fails ? `${fails} failed` : "all passed");
if (fails) process.exitCode = 1;
