/**
 * rules.js — pure functions: which site does a URL belong to, and is it
 * allowed right now? No chrome.* calls here, so it is easy to reason about.
 */

/**
 * Return the hostname of an http(s) URL without a leading "www.", or null.
 */
export function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** True if host is exactly the domain or a subdomain of it. x.com ≠ box.com. */
export function hostMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

/**
 * Find the site entry for a URL. When several match (whatsapp.com and
 * web.whatsapp.com) the longest, most specific domain wins.
 * Disabled sites are included; callers decide what "disabled" means.
 */
export function findSite(url, sites) {
  const host = hostOf(url);
  if (!host) return null;
  let best = null;
  for (const site of sites) {
    if (hostMatches(host, site.domain) && (!best || site.domain.length > best.domain.length)) {
      best = site;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Days and the daily reset
//
// A "day" runs from resetHour to resetHour (local time). All of these use
// calendar arithmetic (setDate) rather than adding 24h, so DST changes are safe.

/**
 * The "logical" date: the calendar day that a moment belongs to once the
 * daily reset hour is taken into account. With resetHour = 4, 02:00 Saturday
 * still belongs to Friday.
 */
export function logicalDate(ts, resetHour = 0) {
  const d = new Date(ts);
  if (d.getHours() < resetHour) d.setDate(d.getDate() - 1);
  d.setHours(12, 0, 0, 0); // noon: a safe point inside the day
  return d;
}

/** Storage key for the logical day containing ts, e.g. "2026-11-18". */
export function dayKey(ts, resetHour = 0) {
  const d = logicalDate(ts, resetHour);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Timestamp of the next daily reset strictly after ts. */
export function nextResetAt(ts, resetHour = 0) {
  const d = new Date(ts);
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate(), resetHour, 0, 0, 0);
  if (r.getTime() <= ts) r.setDate(r.getDate() + 1);
  return r.getTime();
}

/** Seconds used today on a domain, from the `usage` object. */
export function usedSeconds(usage, domain, now, resetHour = 0) {
  return usage?.[dayKey(now, resetHour)]?.seconds?.[domain] || 0;
}

// ---------------------------------------------------------------------------
// Rules
//
// A rule: { days: [0..6], mode, limitMinutes, windows: [{ start: "HH:MM", end: "HH:MM" }] }
//   mode 'block'          always blocked on those days
//        'limit'          up to limitMinutes per day
//        'schedule'       only inside the windows
//        'limit+schedule' only inside the windows, and only up to limitMinutes
// A window whose end is before its start crosses midnight (22:00–01:00).
// An end of "00:00" means midnight (21:00–00:00).

/** The first rule whose days include today, or null (unrestricted today). */
export function activeRule(entity, now, resetHour = 0) {
  const weekday = logicalDate(now, resetHour).getDay();
  return (entity.rules || []).find((r) => r.days.includes(weekday)) || null;
}

export const hasLimit = (mode) => mode === 'limit' || mode === 'limit+schedule';
export const hasSchedule = (mode) => mode === 'schedule' || mode === 'limit+schedule';

/** "13:30" → 810 */
export function parseHM(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return h * 60 + m;
}

/** Minutes since local midnight, with fractions. */
function minuteOfDay(ts) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60 + d.getMilliseconds() / 60000;
}

/** Is a minute-of-day inside a window? Handles windows that cross midnight. */
export function inWindow(minute, w) {
  const a = parseHM(w.start);
  const b = parseHM(w.end);
  if (a === b) return false; // empty window
  return a < b ? minute >= a && minute < b : minute >= a || minute < b;
}

/** If ts is inside one of the rule's windows, the timestamp that window ends; else null. */
function windowEndAt(rule, ts) {
  const minute = minuteOfDay(ts);
  let best = null;
  for (const w of rule.windows || []) {
    if (!inWindow(minute, w)) continue;
    const b = parseHM(w.end);
    const end = new Date(ts);
    end.setHours(Math.floor(b / 60), b % 60, 0, 0);
    if (end.getTime() <= ts) end.setDate(end.getDate() + 1);
    if (best === null || end.getTime() > best) best = end.getTime();
  }
  return best;
}

const limitSecondsOf = (rule) => Math.max(0, Number(rule.limitMinutes) || 0) * 60;

/** Check one rule at time t with usedSec already spent that day. */
function checkRule(rule, t, usedSec) {
  if (!rule) return { blocked: false };
  if (rule.mode === 'block') return { blocked: true, reason: 'blocked' };
  if (hasLimit(rule.mode)) {
    const remainingSec = limitSecondsOf(rule) - usedSec;
    if (remainingSec <= 0) return { blocked: true, reason: 'limit' };
    if (hasSchedule(rule.mode) && !(rule.windows || []).some((w) => inWindow(minuteOfDay(t), w))) {
      return { blocked: true, reason: 'schedule' };
    }
    return { blocked: false, remainingSec };
  }
  if (hasSchedule(rule.mode) && !(rule.windows || []).some((w) => inWindow(minuteOfDay(t), w))) {
    return { blocked: true, reason: 'schedule' };
  }
  return { blocked: false };
}

// ---------------------------------------------------------------------------
// Groups

/** The enabled group a site belongs to, or null. */
export function groupOf(site, groups = []) {
  return (site.groupId && groups.find((g) => g.id === site.groupId && g.enabled)) || null;
}

/** Enabled member sites of a group. A switched-off site is out of its group. */
export function membersOf(group, sites = []) {
  return sites.filter((s) => s.groupId === group.id && s.enabled);
}

/** Seconds used today by all enabled members of a group, together. */
export function groupUsedSeconds(group, sites, usage, now, resetHour = 0) {
  return membersOf(group, sites).reduce((sum, s) => sum + usedSeconds(usage, s.domain, now, resetHour), 0);
}

// ---------------------------------------------------------------------------
// Verdict

/**
 * The rule holders that apply to a site: the site itself, plus its group.
 * The stricter of the two wins, because a site is allowed only when both allow it.
 */
function partsFor(site, { usage, sites = [], groups = [] }, now, resetHour) {
  const parts = [{ entity: site, used: usedSeconds(usage, site.domain, now, resetHour), group: null }];
  const group = groupOf(site, groups);
  if (group) {
    parts.push({ entity: group, used: groupUsedSeconds(group, sites, usage, now, resetHour), group });
  }
  return parts;
}

/** Check all parts at time t. `fresh` = t is on a later day, so usage is 0. */
function checkParts(parts, t, resetHour, fresh) {
  let remainingSec = null;
  for (const p of parts) {
    const r = checkRule(activeRule(p.entity, t, resetHour), t, fresh ? 0 : p.used);
    if (r.blocked) return { ...r, group: p.group };
    if (r.remainingSec != null) remainingSec = Math.min(remainingSec ?? Infinity, r.remainingSec);
  }
  return { blocked: false, remainingSec };
}

/**
 * When does a blocked site open again? Access can only start at a window's
 * start or at a daily reset (new budget, maybe a different day's rule), so we
 * test just those moments over the next 8 days. Assumes no more time is spent.
 * Returns null if it never opens in that range (e.g. blocked every day).
 */
function nextOpenAt(parts, now, resetHour) {
  const today = dayKey(now, resetHour);
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  const candidates = new Set();
  for (let i = 0; i <= 8; i++) {
    const day = new Date(base);
    day.setDate(base.getDate() + i);
    candidates.add(new Date(day).setHours(resetHour, 0, 0, 0));
    for (const p of parts) {
      for (const rule of p.entity.rules || []) {
        for (const w of rule.windows || []) {
          const m = parseHM(w.start);
          candidates.add(new Date(day).setHours(Math.floor(m / 60), m % 60, 0, 0));
        }
      }
    }
  }
  const sorted = [...candidates].filter((t) => t > now).sort((a, b) => a - b);
  for (const t of sorted) {
    if (!checkParts(parts, t, resetHour, dayKey(t, resetHour) !== today).blocked) return t;
  }
  return null;
}

/**
 * Decide whether a site may be shown right now.
 *
 * @param site
 * @param ctx { now, settings, usage, sites, groups }  (sites/groups for group budgets)
 * @returns
 *   allowed: { blocked: false, remainingSec, blockAt, blockKind, paused }
 *     remainingSec  seconds of budget left (site or group, whichever is less), or null
 *     blockAt       when it will be blocked if used continuously from now
 *                   (budget runs out, the current window ends, or a pause ends), or null
 *     blockKind     what blockAt is: 'limit' | 'schedule' | 'pause' | null
 *     paused        true while a pause is active for this site
 *   blocked: { blocked: true, reason, until, group }
 *     reason  'blocked' | 'limit' | 'schedule'
 *     until   when it opens again, or null if not within the next week
 *     group   the group whose rule blocks it, or null if it is the site's own rule
 *
 * A switched-off site is fully unrestricted (and not counted in its group).
 * ctx.pauses = { [domain]: { until } }: a paused site is allowed until then.
 */
export function evaluate(site, ctx = {}) {
  const free = { blocked: false, remainingSec: null, blockAt: null, blockKind: null, paused: false };
  if (!site || !site.enabled) return free;
  const now = ctx.now ?? Date.now();
  const resetHour = ctx.settings?.resetHour ?? 0;

  const pauseUntil = ctx.pauses?.[site.domain]?.until;
  if (pauseUntil > now) return { ...free, blockAt: pauseUntil, blockKind: 'pause', paused: true };

  const parts = partsFor(site, ctx, now, resetHour);

  const v = checkParts(parts, now, resetHour, false);
  if (v.blocked) {
    return { blocked: true, reason: v.reason, group: v.group, until: nextOpenAt(parts, now, resetHour) };
  }

  let blockAt = v.remainingSec != null ? now + v.remainingSec * 1000 : null;
  let blockKind = blockAt != null ? 'limit' : null;
  for (const p of parts) {
    const rule = activeRule(p.entity, now, resetHour);
    const end = rule && hasSchedule(rule.mode) ? windowEndAt(rule, now) : null;
    if (end != null && (blockAt == null || end < blockAt)) {
      blockAt = end;
      blockKind = 'schedule';
    }
  }
  return { ...free, remainingSec: v.remainingSec, blockAt, blockKind };
}

/** Today's limit in seconds for a site or group, or null if it has none today. */
export function todayLimitSec(entity, now, resetHour = 0) {
  const rule = activeRule(entity, now, resetHour);
  return rule && hasLimit(rule.mode) ? limitSecondsOf(rule) : null;
}
