/**
 * storage.js — the single place that knows the shape of chrome.storage.local.
 *
 * Shared by the service worker and the extension pages (options, blocked),
 * which import it as an ES module. Keep it free of DOM and worker-only APIs.
 *
 * Top-level keys (see README "Data model"):
 *   settings   only { theme, lang }: everything else is the fixed DEFAULT_SETTINGS
 *   sites      per-site rules
 *   groups     shared-budget groups
 *   lastQuoteId  id of the last reminder shown (no repeats in a row);
 *              the reminders themselves are data/quotes.json
 *   usage      { "YYYY-MM-DD": { seconds: { domain: n }, warned, pausesUsed } }, 7 days
 *   session    live tracking state, see tracker.js
 *   pauses     { domain: { until } } short pauses granted after the friction step
 */

import { applyOps } from './loosen.js';

export const SCHEMA_VERSION = 1;

/**
 * The project's fixed settings. They are not editable in the UI; change them
 * here. Only `theme` and `lang` (appearance) are stored and changed by the user.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  resetHour: 0,
  warningMinutes: [5, 1],
  idleThresholdSec: 60,
  friction: { countdownSec: 30 },
  pause: { maxMinutes: 5, maxPerDay: 3 },
  theme: 'system', // 'system' | 'light' | 'dark' — appearance only, not a rule
  lang: 'ar' // 'ar' | 'en' — interface language (shared/i18n.js), appearance only
});

export const DEFAULT_DOMAINS = [
  'web.whatsapp.com', 'web.telegram.org', 'facebook.com', 'instagram.com',
  'tiktok.com', 'x.com', 'twitter.com', 'youtube.com', 'reddit.com',
  'linkedin.com', 'snapchat.com'
];

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export const MODES = ['block', 'limit', 'schedule', 'limit+schedule'];

/** Short random id with a type prefix, e.g. "s_k3j9x2". */
export function newId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}

/** A rule that applies every day. */
export function defaultRule(mode = 'block') {
  return { days: [...ALL_DAYS], mode, limitMinutes: 20, windows: [] };
}

/** A new site entry for a (normalized) domain. */
export function makeSite(domain, { enabled = true, mode = 'block' } = {}) {
  return { id: newId('s'), domain, enabled, groupId: null, rules: [defaultRule(mode)] };
}

/** A new group with a shared 30 min/day budget. */
export function makeGroup(name) {
  return { id: newId('g'), name, enabled: true, rules: [{ ...defaultRule('limit'), limitMinutes: 30 }] };
}

/**
 * Normalize what a user typed into a bare domain, or return null if invalid.
 *   "https://www.YouTube.com/watch?v=1" -> "youtube.com"
 *   "m.facebook.com."                   -> "m.facebook.com"
 * Only a leading "www." is stripped; other subdomains (web., m.) are kept
 * because the user may want to target exactly that subdomain.
 */
export function normalizeDomain(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  // Let the URL parser deal with schemes, paths, ports, credentials.
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = 'http://' + s;
  let host;
  try {
    host = new URL(s).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.+$/, '').replace(/^www\./, '');
  // Require at least one dot and only valid hostname labels.
  const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
  const parts = host.split('.');
  if (parts.length < 2 || !parts.every((p) => label.test(p) || /^xn--/.test(p))) return null;
  return host;
}

// ---------------------------------------------------------------------------
// Reading / writing

/** Read several keys at once, filling in defaults for missing ones. */
export async function load(keys) {
  const data = await chrome.storage.local.get(keys);
  if (keys.includes('settings')) {
    data.settings = {
      ...DEFAULT_SETTINGS,
      theme: data.settings?.theme ?? DEFAULT_SETTINGS.theme,
      lang: data.settings?.lang ?? DEFAULT_SETTINGS.lang
    };
  }
  if (keys.includes('sites')) data.sites = data.sites || [];
  if (keys.includes('groups')) data.groups = data.groups || [];
  if (keys.includes('usage')) data.usage = data.usage || {};
  if (keys.includes('session')) data.session = data.session || null;
  if (keys.includes('pauses')) data.pauses = data.pauses || {};
  return data;
}

export async function getSites() {
  return (await load(['sites'])).sites;
}

export async function saveSites(sites) {
  await chrome.storage.local.set({ sites });
}

// ---------------------------------------------------------------------------
// First-install seeding and clean-up

/**
 * Fill in any missing top-level keys, and drop data from older versions that
 * is no longer used. Safe to call on every install/update/start-up: it never
 * touches usage, and only changes sites/groups to apply confirmed changes.
 */
export async function ensureSeeded() {
  const existing = await chrome.storage.local.get(['settings', 'sites', 'groups', 'quotes', 'pending', 'prayerTest']);
  const patch = {};

  if (!existing.groups) patch.groups = [];
  if (!existing.sites) {
    // Seeded switched OFF so installing never cuts you off mid-conversation.
    // Switching a site on is a stricter change, so it is always instant.
    patch.sites = DEFAULT_DOMAINS.map((d) => makeSite(d, { enabled: false }));
  }

  // Settings are fixed now: keep only the appearance choices.
  const theme = existing.settings?.theme ?? DEFAULT_SETTINGS.theme;
  const lang = existing.settings?.lang ?? DEFAULT_SETTINGS.lang;
  if (!existing.settings || Object.keys(existing.settings).some((k) => k !== 'theme' && k !== 'lang') || !existing.settings.lang) {
    patch.settings = { theme, lang };
  }

  // Older versions queued confirmed looser changes until the next day. Changes
  // now apply at once, so apply any that were still waiting (they were
  // already confirmed). Old queued settings changes are dropped.
  if (existing.pending?.length) {
    const ops = existing.pending.flatMap((p) => p.ops || []).filter((o) => o.kind === 'site' || o.kind === 'group');
    Object.assign(patch, applyOps({ sites: patch.sites || existing.sites || [], groups: patch.groups || existing.groups || [] }, ops));
  }

  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  // Reminders used to be copied into storage; they are read from the file now.
  const obsolete = ['quotes', 'pending', 'prayerTest'].filter((k) => k in existing);
  if (obsolete.length) await chrome.storage.local.remove(obsolete);
}

// ---------------------------------------------------------------------------
// Reminders (data/quotes.json)

const quoteFiles = new Map();

/**
 * All reminders from a data file (default data/quotes.json; data/salah.json
 * holds the hadiths shown during prayer locks), each with a stable id.
 */
export function getQuotes(file = 'data/quotes.json') {
  if (!quoteFiles.has(file)) {
    const prefix = file.includes('salah') ? 's' : 'q';
    quoteFiles.set(file, fetch(chrome.runtime.getURL(file))
      .then((res) => res.json())
      .then((list) => list.map((q, i) => ({ id: `${prefix}${i}`, text: q.text, source: q.source, type: q.type })))
      .catch(() => {
        quoteFiles.delete(file); // try again next time
        return [];
      }));
  }
  return quoteFiles.get(file);
}

/**
 * Pick a random reminder from `file`, never the same as the previous one from
 * that file, and remember it. Returns null if the list is empty.
 */
export async function pickQuote(file = 'data/quotes.json') {
  const quotes = await getQuotes(file);
  if (!quotes.length) return null;
  const key = file.includes('salah') ? 'lastSalahId' : 'lastQuoteId';
  const { [key]: lastId = null } = await chrome.storage.local.get(key);
  const pool = quotes.length > 1 ? quotes.filter((q) => q.id !== lastId) : quotes;
  const quote = pool[Math.floor(Math.random() * pool.length)];
  await chrome.storage.local.set({ [key]: quote.id });
  return quote;
}
