/**
 * content-scripts.js — keeps the page scripts (activity heartbeat + warning
 * overlay) registered on exactly the listed sites, and nowhere else, and
 * injects them into tabs already open.
 */
import { getSites } from './storage.js';
import { findSite } from './rules.js';

const SCRIPT_ID = 'activity';
const FILES = ['content/activity.js', 'content/overlay.js'];

/** "*.youtube.com" matches youtube.com itself and every subdomain. */
const patternsFor = (sites) => [...new Set(sites.map((s) => `*://*.${s.domain}/*`))];

let chain = Promise.resolve();

/** Re-register the script for the current site list. Serialized. */
export function syncContentScripts() {
  chain = chain.then(doSync).catch((e) => console.error('[content-scripts]', e));
  return chain;
}

async function doSync() {
  const sites = await getSites();
  const matches = patternsFor(sites);

  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (matches.length) {
    await chrome.scripting.registerContentScripts([{
      id: SCRIPT_ID, js: FILES, matches, runAt: 'document_idle', allFrames: false
    }]);
  }

  // Registration only affects future page loads: inject into open tabs too.
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs
    .filter((t) => t.url && findSite(t.url, sites))
    .map((t) => chrome.scripting.executeScript({ target: { tabId: t.id }, files: FILES }).catch(() => {})));
}
