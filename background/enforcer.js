/**
 * enforcer.js — redirects tabs whose site is not allowed right now.
 *
 * Two reasons a tab is sent to the blocked page:
 *   1. "Salah First" (prayer.js): during a prayer lock, every website.
 *   2. The site's own rules (rules.js): blocked, out of time, outside hours.
 */
import { load } from './storage.js';
import { findSite, evaluate, hostOf } from './rules.js';
import { lockWindows, activeLock, normalizePrayer } from './prayer.js';

export const BLOCKED_PAGE = chrome.runtime.getURL('blocked/blocked.html');

/** Load everything a verdict needs, once, to share across many tabs. */
export async function loadContext() {
  const ctx = await load(['sites', 'groups', 'settings', 'usage', 'pauses']);
  const { prayer, prayerTimes } = await chrome.storage.local.get(['prayer', 'prayerTimes']);
  ctx.prayerLock = activeLock(lockWindows(normalizePrayer(prayer), prayerTimes), Date.now());
  return ctx;
}

async function redirect(tabId, params) {
  try {
    await chrome.tabs.update(tabId, { url: `${BLOCKED_PAGE}?${params}` });
  } catch {
    // Tab closed, or a prerender tab that does not exist yet (onReplaced covers it).
  }
}

/**
 * Check one tab and redirect it if its site is not allowed.
 * @param {number} tabId
 * @param {string} url  the URL the tab is on or navigating to
 * @param {object} [ctx] preloaded (see loadContext)
 */
export async function enforceTab(tabId, url, ctx) {
  if (!url || url.startsWith(BLOCKED_PAGE)) return;
  ctx = ctx || (await loadContext());

  // Salah First: every website (http/https) closes during a prayer lock.
  const host = hostOf(url);
  if (ctx.prayerLock && host) {
    const lock = ctx.prayerLock;
    return redirect(tabId, new URLSearchParams({
      r: 'prayer', p: lock.prayer, at: String(lock.at), t: String(lock.end), d: host, u: url
    }));
  }

  const site = findSite(url, ctx.sites);
  if (!site) return;

  const verdict = evaluate(site, { ...ctx, now: Date.now() });
  if (!verdict.blocked) return;

  const params = new URLSearchParams({ d: site.domain, r: verdict.reason, u: url });
  if (verdict.until) params.set('t', String(verdict.until));
  if (verdict.group) params.set('g', verdict.group.name);
  return redirect(tabId, params);
}

/** Re-check every open tab, e.g. after rules change, a budget runs out or a prayer lock starts. */
export async function enforceAllTabs() {
  const ctx = await loadContext();
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((t) => enforceTab(t.id, t.pendingUrl || t.url, ctx)));
}
