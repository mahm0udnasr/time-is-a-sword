/**
 * loosen.js — pure functions: turn "current state → next state" into a list of
 * change operations, and say which of them make the rules looser.
 *
 * Stricter (or neutral) changes apply at once. Looser changes need the
 * friction step first (options/commit.js); both then apply at once.
 *
 * An op is one entity or one setting:
 *   { kind: 'site' | 'group', id, op: 'put' | 'delete', value, label, reasons: [] }
 * reasons is empty for a change that is not looser.
 * (Settings are fixed in storage.js DEFAULT_SETTINGS, so they are never diffed.)
 */
import { hasLimit, hasSchedule, parseHM } from './rules.js';
import { describeDays } from '../shared/format.js';
import { t } from '../shared/i18n.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// Rules

const ruleForDay = (rules, d) => (rules || []).find((r) => r.days.includes(d)) || null;

/** Minutes of the day (0..1439) that a rule's windows allow. */
function allowedMinutes(rule) {
  const set = new Uint8Array(1440);
  for (const w of rule.windows || []) {
    const a = parseHM(w.start);
    const b = parseHM(w.end);
    if (a === b) continue;
    for (let m = a; m !== b; m = (m + 1) % 1440) set[m] = 1;
  }
  return set;
}

/** Why `next` is looser than `prev` for one day, or null if it is not. */
function ruleLoosening(prev, next) {
  if (!prev) return null; // was unrestricted: anything is at least as strict
  if (!next) return t('lo.ruleRemoved');
  if (prev.mode === 'block') return next.mode === 'block' ? null : t('lo.unblocked');
  if (next.mode === 'block') return null;
  if (hasLimit(prev.mode)) {
    if (!hasLimit(next.mode)) return t('lo.limitRemoved');
    if (Number(next.limitMinutes) > Number(prev.limitMinutes)) {
      return t('lo.limitRaised', { a: prev.limitMinutes, b: next.limitMinutes });
    }
  }
  if (hasSchedule(prev.mode)) {
    if (!hasSchedule(next.mode)) return t('lo.hoursRemoved');
    const p = allowedMinutes(prev);
    const n = allowedMinutes(next);
    if (n.some((v, m) => v && !p[m])) return t('lo.hoursWidened');
  }
  return null;
}

/** Compare two rule lists day by day; returns e.g. ["Sat, Sun: limit raised from 20 to 45 min"]. */
export function rulesLoosening(prevRules, nextRules) {
  const byReason = new Map();
  for (let d = 0; d < 7; d++) {
    const why = ruleLoosening(ruleForDay(prevRules, d), ruleForDay(nextRules, d));
    if (why) byReason.set(why, [...(byReason.get(why) || []), d]);
  }
  return [...byReason].map(([why, days]) => `${describeDays(days)}: ${why}`);
}

// ---------------------------------------------------------------------------
// Entities

function siteLoosening(prev, next, groups) {
  if (!prev.enabled) return []; // it was not restricting anything
  if (!next.enabled) return [t('lo.switchedOff')];
  const reasons = [];
  const oldGroup = prev.groupId && groups.find((g) => g.id === prev.groupId && g.enabled);
  if (oldGroup && next.groupId !== prev.groupId) reasons.push(t('lo.leavesGroup', { name: oldGroup.name }));
  return reasons.concat(rulesLoosening(prev.rules, next.rules));
}

function groupLoosening(prev, next) {
  if (!prev.enabled) return [];
  if (!next.enabled) return [t('lo.switchedOff')];
  return rulesLoosening(prev.rules, next.rules);
}

/** Restricts anything at all? (Removing an entity that restricts nothing is not looser.) */
const siteRestricts = (s, groups) => s.enabled && (s.rules?.length > 0 || groups.some((g) => g.id === s.groupId && g.enabled));
const groupRestricts = (g) => g.enabled && g.rules?.length > 0;

// ---------------------------------------------------------------------------
// Diff and apply

/**
 * @param cur  { sites, groups }
 * @param next { sites, groups }
 * @returns ops (see top of file); only entities that changed
 */
export function diffState(cur, next) {
  const ops = [];
  const curGroups = cur.groups || [];

  // Sites
  const nextSites = new Map((next.sites || []).map((s) => [s.id, s]));
  for (const prev of cur.sites || []) {
    const n = nextSites.get(prev.id);
    if (!n) {
      ops.push({ kind: 'site', id: prev.id, op: 'delete', label: prev.domain,
        reasons: siteRestricts(prev, curGroups) ? [t('lo.removed')] : [] });
    } else if (!same(prev, n)) {
      ops.push({ kind: 'site', id: prev.id, op: 'put', value: n, label: n.domain,
        reasons: siteLoosening(prev, n, curGroups) });
    }
  }
  const curSiteIds = new Set((cur.sites || []).map((s) => s.id));
  for (const n of next.sites || []) {
    if (!curSiteIds.has(n.id)) ops.push({ kind: 'site', id: n.id, op: 'put', value: n, label: n.domain, reasons: [] });
  }

  // Groups
  const nextGroups = new Map((next.groups || []).map((g) => [g.id, g]));
  for (const prev of curGroups) {
    const n = nextGroups.get(prev.id);
    const label = t('group.label', { name: prev.name });
    if (!n) {
      ops.push({ kind: 'group', id: prev.id, op: 'delete', label, reasons: groupRestricts(prev) ? [t('lo.removed')] : [] });
    } else if (!same(prev, n)) {
      ops.push({ kind: 'group', id: prev.id, op: 'put', value: n, label: t('group.label', { name: n.name }), reasons: groupLoosening(prev, n) });
    }
  }
  const curGroupIds = new Set(curGroups.map((g) => g.id));
  for (const n of next.groups || []) {
    if (!curGroupIds.has(n.id)) ops.push({ kind: 'group', id: n.id, op: 'put', value: n, label: t('group.label', { name: n.name }), reasons: [] });
  }

  return ops;
}

/** Apply ops to { sites, groups }. A put for a missing entity adds it. Returns a new state. */
export function applyOps(state, ops) {
  const sites = [...(state.sites || [])];
  const groups = [...(state.groups || [])];
  for (const o of ops) {
    if (o.kind !== 'site' && o.kind !== 'group') continue; // e.g. old 'setting' ops
    const list = o.kind === 'site' ? sites : groups;
    const i = list.findIndex((e) => e.id === o.id);
    if (o.op === 'delete') {
      if (i >= 0) list.splice(i, 1);
    } else if (i >= 0) {
      list[i] = o.value;
    } else {
      list.push(o.value);
    }
  }
  return { sites, groups };
}

/** Human list: ["youtube.com: Sat, Sun: limit raised from 20 to 45 min", …] */
export function describeLoosening(ops) {
  return ops.flatMap((o) => o.reasons.map((r) => `${o.label}: ${r}`));
}

