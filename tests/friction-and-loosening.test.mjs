const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
globalThis.chrome = { runtime: { getURL: (p) => 'chrome-extension://x/' + p } };
const { matchesReminder, typingProgress } = await import(root + '/shared/arabic.js');
const i18n = await import(root + '/shared/i18n.js');
i18n.setLanguage('en'); // the English assertions below; Arabic is checked at the end
const { diffState, applyOps, describeLoosening, rulesLoosening } = await import(root + '/background/loosen.js');
const { evaluate } = await import(root + '/background/rules.js');
const { makeSite, makeGroup, DEFAULT_SETTINGS } = await import(root + '/background/storage.js');
let fails = 0;
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.log('FAIL', m, '\n  got ', JSON.stringify(a), '\n  want', JSON.stringify(b)); fails++; } };

// Arabic matching
const q = 'من حُسن إسلام المرء تركه ما لا يعنيه';
eq(matchesReminder('من حسن اسلام المرء تركه ما لا يعنيه', q), true, 'no tashkeel, plain alef');
eq(matchesReminder('  من   حسن إسلام المرء تركه ما لا يعنيه ', q), true, 'extra spaces');
eq(matchesReminder('من حسن اسلام المرء تركة ما لا يعنيه', q), true, 'ة/ه');
eq(matchesReminder('حتى يسال', 'حتي يُسأل'), true, 'ى/ي and hamza on alef');
eq(matchesReminder('من حسن اسلام المرء تركه', q), false, 'incomplete');
eq(matchesReminder('اغتنم خمسا قبل خمس', 'اغتنم خمسًا قبل خمس'), true, 'tanween');
eq(matchesReminder('والوقـــت', 'والوقتُ'), true, 'tatweel');
eq(typingProgress('من حسن اسل', q).wrongWordIndex, null, 'prefix being typed is not an error');
eq(typingProgress('من حسن اسلم ', q).expected, 'اسلام', 'finished wrong word flagged');

// Poetry: the "..." between the halves need not be typed; two lines or one both match.
const poem = 'والوقتُ أنفسُ ما عُنيتَ بحفظه ... وأراه أسهلَ ما عليك يضيعُ';
eq(matchesReminder('والوقت انفس ما عنيت بحفظه\nواراه اسهل ما عليك يضيع', poem), true, 'poem typed on two lines');
eq(matchesReminder('والوقت انفس ما عنيت بحفظه واراه اسهل ما عليك يضيع', poem), true, 'poem typed on one line');
eq(matchesReminder('والوقت انفس ما عنيت بحفظه', poem), false, 'only the first half');
const { hemistichs } = await import(root + '/shared/poetry.js');
eq(hemistichs(poem), ['والوقتُ أنفسُ ما عُنيتَ بحفظه', 'وأراه أسهلَ ما عليك يضيعُ'], 'split into halves');
eq(hemistichs('أ ... ب\nج … د').length, 4, 'two verses');

// Kashida: where tatweel may go, and how it is spread.
const { kashidaSlots, stretch } = await import(root + '/shared/poetry.js');
const T = String.fromCharCode(0x0640);
eq(stretch('الحفر', 2).text, 'الحفــر', 'pairs: الحفــر');
eq(stretch('الحفر', 4).text, 'الحــفــر', 'then the next join: الحــفــر');
eq(stretch('ولا الأمل', 1).text.includes('ل' + T + 'ا'), false, 'lam-alef ligature never split');
eq(stretch('الدهر', 3).text.startsWith('ال' + T), false, 'no kashida right after the article');
eq(stretch('ورد زاد', 5), { text: 'ورد زاد', used: 0 }, 'no joins → nothing inserted');
eq(stretch('يعشْ', 1).text, 'يعـشْ', 'inserted before the next letter, after the harakat');
eq(matchesReminder(stretch(poem, 9).text, poem), true, 'stretched text still matches the typing check');
eq(Math.max(...[...stretch('بين', 99).text.matchAll(new RegExp(T + '+', 'g'))].map((m) => m[0].length)), 4, 'at most 4 per join');
eq(kashidaSlots('بين بين').length, 2, 'slots grouped by word');

// Loosening
const R = (days, mode, limitMinutes = 20, windows = []) => ({ days, mode, limitMinutes, windows });
const ALL = [0,1,2,3,4,5,6];
eq(rulesLoosening([R(ALL,'limit',20)], [R(ALL,'limit',10)]), [], 'lower limit = stricter');
eq(rulesLoosening([R(ALL,'limit',20)], [R(ALL,'limit',30)]), ['Every day: limit raised from 20 to 30 min'], 'raise limit');
eq(rulesLoosening([R(ALL,'block')], [R(ALL,'limit')]), ['Every day: no longer always blocked'], 'unblock');
eq(rulesLoosening([R(ALL,'limit')], [R(ALL,'block')]), [], 'block = stricter');
eq(rulesLoosening([R(ALL,'limit')], [R([0,1,2,3,4],'limit')]), ['Fri, Sat: rule removed'], 'fewer days');
eq(rulesLoosening([], [R(ALL,'limit')]), [], 'new rule = stricter');
const W = (start, end) => ({ start, end });
eq(rulesLoosening([R(ALL,'schedule',0,[W('13:00','14:00')])], [R(ALL,'schedule',0,[W('13:15','13:45')])]), [], 'narrower window');
eq(rulesLoosening([R(ALL,'schedule',0,[W('13:00','14:00')])], [R(ALL,'schedule',0,[W('13:00','14:30')])]), ['Every day: allowed hours widened'], 'wider window');
eq(rulesLoosening([R(ALL,'schedule',0,[W('22:00','01:00')])], [R(ALL,'schedule',0,[W('23:00','00:30')])]), [], 'midnight narrower');
eq(rulesLoosening([R(ALL,'schedule',0,[W('13:00','14:00')])], [R(ALL,'limit+schedule',30,[W('13:00','14:00')])]), [], 'add limit = stricter');
eq(rulesLoosening([R(ALL,'limit+schedule',30,[W('13:00','14:00')])], [R(ALL,'schedule',0,[W('13:00','14:00')])]), ['Every day: daily limit removed'], 'drop limit');

const yt = makeSite('youtube.com'); yt.rules = [R(ALL,'limit',20)];
const g = makeGroup('Messaging');
const wa = makeSite('web.whatsapp.com'); wa.rules = []; wa.groupId = g.id;
const off = makeSite('tiktok.com', { enabled: false });
const cur = { sites: [yt, wa, off], groups: [g], settings: { ...DEFAULT_SETTINGS } };
const clone = (x) => structuredClone(x);

let next = clone(cur); next.sites[0].rules[0].limitMinutes = 30; next.sites[0].rules[0].days = [0,1,2,3,4];
let ops = diffState(cur, next);
eq(describeLoosening(ops), ['youtube.com: Sun–Thu: limit raised from 20 to 30 min', 'youtube.com: Fri, Sat: rule removed'], 'site diff reasons');
next = clone(cur); next.sites = next.sites.filter((s) => s.id !== off.id);
eq(diffState(cur, next).map((o) => [o.op, o.reasons.length]), [['delete', 0]], 'removing a disabled site is not looser');
next = clone(cur); next.sites = next.sites.filter((s) => s.id !== wa.id);
eq(describeLoosening(diffState(cur, next)), ['web.whatsapp.com: removed'], 'removing a group member is looser');
next = clone(cur); next.sites[1].groupId = null;
eq(describeLoosening(diffState(cur, next)), ['web.whatsapp.com: leaves the “Messaging” group'], 'leaving group');
next = clone(cur); next.sites[2].enabled = true;
eq(diffState(cur, next)[0].reasons, [], 'switching on is stricter');
next = clone(cur); next.groups[0].enabled = false;
eq(describeLoosening(diffState(cur, next)), ['Group “Messaging”: switched off'], 'group off');
const added = makeSite('reddit.com');
next = clone(cur); next.sites.push(added);
ops = diffState(cur, next);
eq([ops.length, ops[0].reasons.length, applyOps(cur, ops).sites.length], [1, 0, 4], 'adding a site');

// Pause in evaluate
const now = Date.now();
const blocked = makeSite('x.com');
eq(evaluate(blocked, { now, settings: DEFAULT_SETTINGS, usage: {} }).blocked, true, 'blocked before pause');
const v = evaluate(blocked, { now, settings: DEFAULT_SETTINGS, usage: {}, pauses: { 'x.com': { until: now + 300000 } } });
eq([v.blocked, v.paused, v.blockAt, v.blockKind], [false, true, now + 300000, 'pause'], 'paused');
eq(evaluate(blocked, { now, settings: DEFAULT_SETTINGS, usage: {}, pauses: { 'x.com': { until: now - 1 } } }).blocked, true, 'expired pause');
// Arabic (the default language)
const { formatDuration, describeDays } = await import(root + '/shared/format.js');
i18n.setLanguage('ar');
eq(describeDays([0,1,2,3,4]), 'الأحد–الخميس', 'ar day range');
eq(describeDays([5,6]), 'الجمعة، السبت', 'ar two days');
eq(describeDays([0,1,2,3,4,5,6]), 'كل يوم', 'ar every day');
eq(formatDuration(3900), '1 س 05 د', 'ar duration');
eq(formatDuration(45), '45 ث', 'ar seconds');
eq(rulesLoosening([R(ALL,'limit',20)], [R(ALL,'limit',30)]), ['كل يوم: رُفع الحد من 20 إلى 30 دقيقة'], 'ar loosening reason');
eq(i18n.t('site.removed', { site: 'x.com' }), 'تم حذف x.com', 'ar t() with params');
eq(i18n.t('no.such.key'), 'no.such.key', 'missing key falls back to the key');
i18n.setLanguage('en');
eq(formatDuration(3900), '1h 05m', 'en duration');

console.log(fails ? `${fails} failed` : "all passed");
if (fails) process.exitCode = 1;
