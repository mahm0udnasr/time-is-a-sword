/**
 * tracker.js — counts active time per site, sends the "N minutes left"
 * warnings, and grants pauses.
 *
 * Time counts only while a listed site is the active tab, its page has focus,
 * and you have used the page in the last minute or media is playing in it
 * (see currentTarget below for the signals and their fallbacks).
 *
 * Because the MV3 worker can die at any moment, nothing lives in memory.
 * The live state is `session` in storage: { domain, tabId, windowId, since, lastFlush }.
 * Every event and every 30 s tick "flushes": adds now − lastFlush to today's
 * usage, then decides afresh what (if anything) is being tracked.
 *
 * Only one session exists at a time, so a site open in many tabs or windows
 * is never counted twice.
 */
import { load } from './storage.js';
import {
  findSite, evaluate, dayKey, nextResetAt, logicalDate,
  activeRule, todayLimitSec, membersOf, groupUsedSeconds
} from './rules.js';
import { enforceAllTabs } from './enforcer.js';

export const ALARMS = { tick: 'tick', budget: 'budget', warn: 'warn', reset: 'daily-reset' };
const TICK_MINUTES = 0.5; // Chrome 120+ allows 30 s alarms

/**
 * The longest gap a single flush may credit. Ticks arrive every ~30 s, so a
 * bigger gap means the machine slept or the browser was frozen: we credit at
 * most this much instead of hours of phantom time.
 */
export const MAX_GAP_MS = 75 * 1000;

export const HISTORY_DAYS = 7;

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)

/**
 * Add the time between `from` and `to` to usage[day].seconds[domain], splitting
 * across days when the span crosses the daily reset. Mutates and returns usage.
 */
export function creditTime(usage, domain, from, to, resetHour = 0) {
  if (!(to > from)) return usage;
  to = Math.min(to, from + MAX_GAP_MS);
  let t = from;
  while (t < to) {
    const end = Math.min(to, nextResetAt(t, resetHour));
    const key = dayKey(t, resetHour);
    const day = (usage[key] ||= { seconds: {}, warned: {}, pausesUsed: 0 });
    const prev = day.seconds[domain] || 0;
    day.seconds[domain] = Math.round((prev + (end - t) / 1000) * 1000) / 1000;
    t = end;
  }
  return usage;
}

/**
 * Which warnings are due now. thresholds are minutes (e.g. [5, 1]); `done`
 * the ones already shown for this stretch. Returns { due, next }:
 *   due   thresholds to mark as shown now (secondsLeft has reached them)
 *   next  the largest threshold still ahead, or null
 */
export function dueWarnings(thresholds, done, secondsLeft) {
  const pending = [...new Set(thresholds)].filter((t) => t > 0 && !done.includes(t)).sort((a, b) => b - a);
  const due = pending.filter((t) => secondsLeft <= t * 60 + 1);
  const ahead = pending.filter((t) => secondsLeft > t * 60 + 1);
  return { due, next: ahead.length ? ahead[0] : null };
}

/** Keep only the last HISTORY_DAYS logical days (today included). */
export function pruneUsage(usage, now, resetHour = 0) {
  const cutoff = logicalDate(now, resetHour);
  cutoff.setDate(cutoff.getDate() - (HISTORY_DAYS - 1));
  const minKey = dayKey(cutoff.getTime(), 0); // already a logical date at noon
  const out = {};
  for (const key of Object.keys(usage)) if (key >= minKey) out[key] = usage[key];
  return out;
}

// ---------------------------------------------------------------------------
// What is the user looking at right now?

//
// Two sources, in order of trust:
//  1. Page heartbeats from content/activity.js (stored in chrome.storage.session
//     as `activity[tabId]`). The page knows for sure whether it has focus and
//     when it last got input. Works the same on every OS.
//  2. Browser APIs (windows focus + chrome.idle), only for a tab whose page
//     script is not reporting (e.g. a tab opened before the extension loaded).
//     These depend on the OS and can be wrong on Linux/Wayland/Flatpak.

/** A heartbeat older than this is ignored (pages beat every 10 s). */
export const ACTIVITY_FRESH_MS = 25 * 1000;

async function getActivity() {
  return (await chrome.storage.session.get('activity')).activity || {};
}

async function currentTarget(sites, settings) {
  const now = Date.now();
  const idleMs = Math.max(15, settings.idleThresholdSec) * 1000;
  const activity = await getActivity();
  const isFresh = (a) => a && now - a.at < ACTIVITY_FRESH_MS;

  // 1. The most recent page that says it has focus.
  const focused = Object.entries(activity)
    .filter(([, a]) => a.focused && isFresh(a))
    .sort((x, y) => y[1].at - x[1].at);
  for (const [tabId, a] of focused) {
    let tab;
    try {
      tab = await chrome.tabs.get(Number(tabId));
    } catch {
      continue; // tab closed
    }
    const site = tab.active && findSite(tab.url || '', sites);
    if (!site) continue;
    const engaged = now - a.lastInputAt < idleMs || a.playing || tab.audible;
    return engaged ? { site, tab } : null;
  }

  // 2. Fallback: browser focus + system idle.
  let win;
  try {
    win = await chrome.windows.getLastFocused();
  } catch {
    return null;
  }
  if (!win?.focused) return null;

  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  const site = tab && findSite(tab.url || '', sites);
  if (!site) return null;
  // Its page is reporting and did not claim focus above → not focused.
  if (isFresh(activity[tab.id])) return null;

  const state = await chrome.idle.queryState(Math.max(15, settings.idleThresholdSec));
  if (state === 'locked') return null;
  if (state === 'idle' && !tab.audible) return null;
  return { site, tab };
}

/**
 * Store a heartbeat from a page. Re-evaluates tracking straight away when the
 * page gains/loses focus or becomes engaged/idle; otherwise the 30 s tick will.
 */
export function recordActivity(tabId, msg, idleThresholdSec = 60) {
  const now = Date.now();
  const lastInputAt = Number(msg.lastInputAt) || 0;
  const next = {
    at: now,
    focused: !!msg.focused,
    lastInputAt,
    playing: !!msg.playing,
    // Engaged *as of this heartbeat*, so the next one can detect a change.
    engaged: now - lastInputAt < idleThresholdSec * 1000 || !!msg.playing
  };
  chain = chain.then(async () => {
    const activity = await getActivity();
    const prev = activity[tabId];
    activity[tabId] = next;
    await chrome.storage.session.set({ activity });
    const changed = !prev || now - prev.at >= ACTIVITY_FRESH_MS ||
      prev.focused !== next.focused || prev.engaged !== next.engaged;
    if (changed) await doRefresh();
  }).catch((e) => console.error('[tracker]', e));
  return chain;
}

/** Forget a closed tab's heartbeat. */
export function forgetTab(tabId) {
  chain = chain.then(async () => {
    const activity = await getActivity();
    if (activity[tabId]) {
      delete activity[tabId];
      await chrome.storage.session.set({ activity });
    }
  }).catch(() => {});
  return chain;
}

/**
 * Diagnostics, callable from the service-worker console as `await slDebug()`.
 * Waits 5 s first so you can switch back to the site you want to test.
 */
export async function debugTracking() {
  await new Promise((r) => setTimeout(r, 5000));
  const { sites, settings, session, usage } = await load(['sites', 'settings', 'session', 'usage']);
  const win = await chrome.windows.getLastFocused().catch(() => null);
  const [tab] = win ? await chrome.tabs.query({ active: true, windowId: win.id }) : [];
  const report = {
    windowFocused: win?.focused ?? null,
    idleState: await chrome.idle.queryState(Math.max(15, settings.idleThresholdSec)),
    activeTabUrl: tab?.url ?? null,
    matchedSite: tab ? findSite(tab.url || '', sites)?.domain ?? null : null,
    pageHeartbeat: tab ? (await getActivity())[tab.id] ?? null : null,
    trackingTarget: (await currentTarget(sites, settings))?.site.domain ?? null,
    session,
    today: usage[dayKey(Date.now(), settings.resetHour)] ?? null
  };
  console.table(report);
  return report;
}

// ---------------------------------------------------------------------------
// The flush. All calls are serialized so two events never interleave their
// read-modify-write of `usage`.

let chain = Promise.resolve();

/**
 * Flush elapsed time and re-evaluate what is being tracked.
 * @param {{discardSession?: boolean}} opts  discardSession: drop a stale
 *   session without crediting it (used on browser start-up).
 */
export function refresh(opts = {}) {
  chain = chain.then(() => doRefresh(opts)).catch((e) => console.error('[tracker]', e));
  return chain;
}

async function doRefresh({ discardSession = false } = {}) {
  const now = Date.now();
  const { sites, groups, settings, usage: storedUsage, session: storedSession, pauses: storedPauses } =
    await load(['sites', 'groups', 'settings', 'usage', 'session', 'pauses']);
  const resetHour = settings.resetHour;
  const old = discardSession ? null : storedSession;

  // 1. Credit the time since the last flush.
  let usage = storedUsage;
  if (old) creditTime(usage, old.domain, old.lastFlush, now, resetHour);
  usage = pruneUsage(usage, now, resetHour);

  // Drop pauses that have ended.
  const pauses = Object.fromEntries(Object.entries(storedPauses).filter(([, p]) => p.until > now));
  const pausesChanged = Object.keys(pauses).length !== Object.keys(storedPauses).length;

  // 2. Decide what to track from now on. A site that is not allowed is not
  //    tracked (it is about to be redirected anyway).
  const ctx = { now, settings, usage, sites, groups, pauses };
  const target = await currentTarget(sites, settings);
  const verdict = target ? evaluate(target.site, ctx) : null;
  let session = null;
  if (target && !verdict.blocked) {
    const same = old && old.domain === target.site.domain && old.tabId === target.tab.id;
    session = {
      domain: target.site.domain,
      tabId: target.tab.id,
      windowId: target.tab.windowId,
      since: same ? old.since : now,
      lastFlush: now
    };
  }

  // 3. "N minutes left" warnings for the site in front of you.
  let warning = null;
  let nextWarnAt = null;
  if (session && verdict.blockAt && verdict.blockKind !== 'pause') {
    const secondsLeft = (verdict.blockAt - now) / 1000;
    // A window end is a fixed moment, so each window gets its own warnings;
    // a budget is one per day.
    const key = verdict.blockKind === 'schedule'
      ? `${session.domain}@${new Date(verdict.blockAt).toTimeString().slice(0, 5)}`
      : session.domain;
    const day = (usage[dayKey(now, resetHour)] ||= { seconds: {}, warned: {}, pausesUsed: 0 });
    day.warned ||= {};
    const { due, next } = dueWarnings(settings.warningMinutes || [], day.warned[key] || [], secondsLeft);
    if (due.length) {
      day.warned[key] = [...(day.warned[key] || []), ...due];
      warning = { tabId: session.tabId, domain: session.domain, kind: verdict.blockKind, blockAt: verdict.blockAt, secondsLeft };
    }
    if (next != null) nextWarnAt = verdict.blockAt - next * 60 * 1000;
  }

  if (old || session || discardSession || warning || pausesChanged) {
    await chrome.storage.local.set({ usage, session, ...(pausesChanged ? { pauses } : {}) });
  }

  if (warning) {
    chrome.tabs.sendMessage(warning.tabId, { type: 'warn', ...warning }).catch(() => {
      // The page script is not there (e.g. tab opened before install): no overlay.
    });
  }

  // 4. If the site we were just on has run out (its own budget or its group's),
  //    redirect every tab of it and of its group.
  const flushedSite = old && sites.find((s) => s.domain === old.domain);
  if (flushedSite && evaluate(flushedSite, ctx).blocked) {
    await enforceAllTabs();
  }

  // 5. Wake up exactly when the current site will become blocked (budget runs
  //    out, window ends, pause ends) and when the next warning is due.
  if (session && verdict.blockAt) {
    await chrome.alarms.create(ALARMS.budget, { when: Math.max(verdict.blockAt, now + 1000) + 250 });
  } else {
    await chrome.alarms.clear(ALARMS.budget);
  }
  if (nextWarnAt) {
    await chrome.alarms.create(ALARMS.warn, { when: Math.max(nextWarnAt, now + 1000) + 250 });
  } else {
    await chrome.alarms.clear(ALARMS.warn);
  }
}

// ---------------------------------------------------------------------------
// Pauses

/**
 * Grant a pause for a site (the friction step has already been passed in the
 * page that asks). At most settings.pause.maxPerDay per day, each at most
 * settings.pause.maxMinutes (never more than 5).
 * @returns {Promise<{ok: true, until: number, left: number} | {ok: false, code: 'notActive' | 'noneLeft' | 'failed'}>}
 *   (codes, not sentences: the page shows them in the user's language)
 */
export function requestPause(domain) {
  let result;
  chain = chain.then(async () => {
    const now = Date.now();
    const { sites, settings, usage, pauses } = await load(['sites', 'settings', 'usage', 'pauses']);
    const site = sites.find((s) => s.domain === domain && s.enabled);
    if (!site) {
      result = { ok: false, code: 'notActive' };
      return;
    }
    const day = (usage[dayKey(now, settings.resetHour)] ||= { seconds: {}, warned: {}, pausesUsed: 0 });
    const max = settings.pause?.maxPerDay ?? 3;
    if ((day.pausesUsed || 0) >= max) {
      result = { ok: false, code: 'noneLeft' };
      return;
    }
    const minutes = Math.min(5, Math.max(1, settings.pause?.maxMinutes ?? 5));
    const until = now + minutes * 60 * 1000;
    day.pausesUsed = (day.pausesUsed || 0) + 1;
    await chrome.storage.local.set({ usage, pauses: { ...pauses, [domain]: { until } } });
    result = { ok: true, until, left: max - day.pausesUsed };
  }).catch((e) => {
    console.error('[tracker] pause', e);
    result = { ok: false, code: 'failed' };
  });
  return chain.then(() => result);
}

// ---------------------------------------------------------------------------
// Status for the popup

/**
 * Flush, then summarize today for every site and group.
 * @param {string} [url] the popup's active tab URL, to report "this site".
 */
export async function getStatus(url) {
  await refresh();
  const now = Date.now();
  const { sites, groups, settings, usage, pauses } = await load(['sites', 'groups', 'settings', 'usage', 'pauses']);
  const rh = settings.resetHour;
  const ctx = { now, settings, usage, sites, groups, pauses };
  const today = usage[dayKey(now, rh)]?.seconds || {};

  const rows = sites.map((site) => {
    const v = evaluate(site, ctx);
    const rule = site.enabled ? activeRule(site, now, rh) : null;
    const group = site.groupId ? groups.find((g) => g.id === site.groupId) : null;
    return {
      domain: site.domain,
      enabled: site.enabled,
      mode: rule?.mode ?? null, // the site's own rule today; null = none
      groupName: group?.enabled && site.enabled ? group.name : null,
      usedSec: today[site.domain] || 0,
      limitSec: site.enabled ? todayLimitSec(site, now, rh) : null,
      blocked: v.blocked,
      reason: v.reason ?? null,
      blockedByGroup: v.group?.name ?? null,
      until: v.until ?? null,
      remainingSec: v.remainingSec ?? null,
      blockAt: v.blockAt ?? null,
      pausedUntil: v.paused ? v.blockAt : null
    };
  });

  const groupRows = groups.filter((g) => g.enabled).map((g) => {
    const rule = activeRule(g, now, rh);
    return {
      name: g.name,
      members: membersOf(g, sites).map((s) => s.domain),
      mode: rule?.mode ?? null,
      usedSec: groupUsedSeconds(g, sites, usage, now, rh),
      limitSec: todayLimitSec(g, now, rh)
    };
  });

  const current = url ? findSite(url, sites) : null;
  const maxPauses = settings.pause?.maxPerDay ?? 3;
  const pausesUsed = usage[dayKey(now, rh)]?.pausesUsed || 0;
  return {
    rows,
    groups: groupRows,
    currentDomain: current?.domain ?? null,
    resetAt: nextResetAt(now, rh),
    pausesLeft: Math.max(0, maxPauses - pausesUsed),
    pauseMinutes: Math.min(5, settings.pause?.maxMinutes ?? 5)
  };
}

// ---------------------------------------------------------------------------
// Alarms and idle detection

/** Create the periodic tick and the next daily-reset alarm; set idle interval. */
export async function setupTimers() {
  const { settings } = await load(['settings']);
  chrome.idle.setDetectionInterval(Math.max(15, settings.idleThresholdSec));
  if (!(await chrome.alarms.get(ALARMS.tick))) {
    await chrome.alarms.create(ALARMS.tick, { periodInMinutes: TICK_MINUTES });
  }
  await chrome.alarms.create(ALARMS.reset, { when: nextResetAt(Date.now(), settings.resetHour) + 1000 });
}
