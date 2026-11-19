/**
 * service-worker.js — entry point. Wires browser events to the enforcer
 * (redirect blocked tabs) and the tracker (count active time).
 *
 * MV3 workers are killed when idle and restarted on the next event, so:
 *  - every listener is registered synchronously at top level, and
 *  - no state is kept in memory; everything is read from storage per event.
 */
import { ensureSeeded, load } from './storage.js';
import { enforceTab, enforceAllTabs } from './enforcer.js';
import {
  refresh, setupTimers, getStatus, recordActivity, forgetTab, debugTracking, requestPause, ALARMS
} from './tracker.js';
import { syncContentScripts } from './content-scripts.js';
import { refreshPrayerTimes, maybeRefreshPrayer, schedulePrayerAlarms, PRAYER_ALARMS, normalizePrayer, cfgKey, hasLocation } from './prayer.js';

// ---------------------------------------------------------------------------
// Lifecycle

chrome.runtime.onInstalled.addListener(async () => {
  await ensureSeeded();
  await setupTimers();
  await syncContentScripts();
  await maybeRefreshPrayer();
  await schedulePrayerAlarms();
  await refresh();
  await enforceAllTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureSeeded();
  await setupTimers();
  await syncContentScripts();
  // A session left over from the last run must not be credited: the browser
  // was closed for an unknown time.
  await refresh({ discardSession: true });
  await maybeRefreshPrayer();
  await schedulePrayerAlarms();
  await enforceAllTabs();
});

// ---------------------------------------------------------------------------
// Alarms

chrome.alarms.onAlarm.addListener(async ({ name }) => {
  if (name === ALARMS.tick) {
    await refresh();
    // Also re-check background tabs: an allowed window may have just ended
    // for a site that is open but not in front (e.g. WhatsApp in another tab).
    await enforceAllTabs();
  } else if (name === ALARMS.budget) {
    // The active site's budget ran out or its window ended: flush, then the
    // tracker redirects every tab of it.
    await refresh();
    await enforceAllTabs();
  } else if (name === ALARMS.warn) {
    await refresh(); // sends the "N minutes left" warning
  } else if (name === PRAYER_ALARMS.boundary) {
    // A prayer lock starts (close every website) or ends (blocked pages return by themselves).
    await enforceAllTabs();
    await schedulePrayerAlarms();
  } else if (name === PRAYER_ALARMS.refresh) {
    await maybeRefreshPrayer();
  } else if (name === ALARMS.reset) {
    await refresh(); // splits the running session across the two days
    await setupTimers(); // schedule tomorrow's reset
    await enforceAllTabs();
  }
});

// ---------------------------------------------------------------------------
// Navigation: catch a blocked site as early as possible, in the main frame only.

chrome.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId, url }) => {
  if (frameId === 0) enforceTab(tabId, url);
});

// Single-page apps change URL without a real navigation (pushState).
chrome.webNavigation.onHistoryStateUpdated.addListener(({ tabId, frameId, url }) => {
  if (frameId === 0) enforceTab(tabId, url);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    // Safety net for URL changes not seen above (restored tabs, bfcache…).
    enforceTab(tabId, changeInfo.url);
    refresh();
  } else if ('audible' in changeInfo) {
    refresh(); // audio started/stopped: matters while the user is idle
  }
});

// Prerendered pages swap in as a new tab id.
chrome.tabs.onReplaced.addListener(async (addedTabId) => {
  try {
    const tab = await chrome.tabs.get(addedTabId);
    enforceTab(tab.id, tab.url);
  } catch { /* tab already gone */ }
  refresh();
});

// ---------------------------------------------------------------------------
// Anything that changes what the user is looking at → re-evaluate tracking.

chrome.tabs.onActivated.addListener(() => refresh());
chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
  refresh();
});
chrome.windows.onFocusChanged.addListener(() => refresh());
chrome.idle.onStateChanged.addListener(() => refresh());

// ---------------------------------------------------------------------------
// Rules or settings changed (options page): apply to open tabs at once.

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) await setupTimers(); // reset hour / idle threshold
  if (changes.sites) await syncContentScripts(); // run the page script on the new list
  if (changes.prayer) {
    // New city / method → times for the old place are stale: fetch now.
    const was = normalizePrayer(changes.prayer.oldValue);
    const now = normalizePrayer(changes.prayer.newValue);
    if (hasLocation(now) && cfgKey(was) !== cfgKey(now)) await refreshPrayerTimes();
  }
  if (changes.prayer || changes.prayerTimes) {
    await schedulePrayerAlarms();
    await enforceAllTabs();
  }
  if (changes.sites || changes.groups || changes.settings || changes.pauses) {
    await enforceAllTabs();
    await refresh(); // a changed limit moves the budget alarm
  }
});

// ---------------------------------------------------------------------------
// Messages from extension pages

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'activity' && sender.tab?.id != null) {
    // Heartbeat from content/activity.js on a listed site.
    load(['settings']).then(({ settings }) => recordActivity(sender.tab.id, msg, settings.idleThresholdSec));
    return false;
  }
  if (msg?.type === 'pause' && typeof msg.domain === 'string') {
    // Sent by the options page after the friction step.
    requestPause(msg.domain).then(sendResponse);
    return true;
  }
  if (msg?.type === 'prayer-refresh') {
    // "Refresh times" in the Salah First tab.
    refreshPrayerTimes({ force: true }).then(sendResponse, (e) => sendResponse({ ok: false, code: 'fetch', message: String(e) }));
    return true;
  }
  if (msg?.type === 'status') {
    getStatus(msg.url).then(sendResponse, (e) => sendResponse({ error: String(e) }));
    return true; // keep the channel open for the async reply
  }
  return false;
});

// Diagnostics: in the service-worker console run `await slDebug()`, then
// switch to the site within 5 seconds.
self.slDebug = debugTracking;

// Make sure the timers exist whenever the worker wakes (e.g. after an update
// that cleared alarms). Cheap and idempotent.
setupTimers();
