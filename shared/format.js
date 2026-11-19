/** format.js — small display helpers, in the current language (shared/i18n.js). */
import { t, getLang, locale } from './i18n.js';

/**
 * Human duration.
 *   en: 45 → "45s", 754 → "12m", 3900 → "1h 05m"
 *   ar: 45 → "45 ث", 754 → "12 د", 3900 → "1 س 05 د"
 * With precise=true, durations under 10 minutes include seconds: "4m 30s".
 */
export function formatDuration(sec, { precise = false } = {}) {
  sec = Math.max(0, Math.floor(sec));
  const sp = getLang() === 'ar' ? ' ' : '';
  const u = (n, unit) => `${n}${sp}${t(unit)}`;
  const two = (n) => String(n).padStart(2, '0');
  if (sec < 60) return u(sec, 'dur.s');
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${u(h, 'dur.h')} ${u(two(m), 'dur.m')}`;
  if (precise && sec < 600) return `${u(m, 'dur.m')} ${u(two(s), 'dur.s')}`;
  return u(m, 'dur.m');
}

/** "13:00" / "01:00 م" in the current language. */
export function formatClock(ts) {
  return new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
}

/** "today at 13:00" / "tomorrow at 00:00" / "Monday at 13:00" (ar: "اليوم 01:00 م" …) */
export function formatWhen(ts) {
  const d = new Date(ts);
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const time = formatClock(ts);
  if (d.toDateString() === now.toDateString()) return t('when.today', { time });
  if (d.toDateString() === tomorrow.toDateString()) return t('when.tomorrow', { time });
  return t('when.day', { day: d.toLocaleDateString(locale(), { weekday: 'long' }), time });
}

/** Short weekday names, Sunday first. */
const DAY_NAMES = {
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  ar: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']
};

/** Name of weekday d (0 = Sunday) in the current language. */
export const dayName = (d) => DAY_NAMES[getLang()][d];

/** [0,1,2,3,4] → "Sun–Thu"; [5,6] → "Fri, Sat"; all → "Every day" (ar: "الأحد–الخميس" …) */
export function describeDays(days) {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return t('days.every');
  if (!sorted.length) return t('days.none');
  const runs = [];
  for (const d of sorted) {
    const last = runs[runs.length - 1];
    if (last && d === last[1] + 1) last[1] = d;
    else runs.push([d, d]);
  }
  const sep = t('list.sep');
  return runs
    .map(([a, b]) => (b - a >= 2 ? `${dayName(a)}–${dayName(b)}` : a === b ? dayName(a) : `${dayName(a)}${sep}${dayName(b)}`))
    .join(sep);
}
