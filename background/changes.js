/**
 * changes.js — apply a set of site/group changes (ops from loosen.js) to storage.
 * Stricter changes are applied straight away; looser ones only after the
 * friction step has been passed (options/commit.js). Either way they take
 * effect immediately.
 */
import { load } from './storage.js';
import { applyOps } from './loosen.js';

export async function applyChanges(ops) {
  if (!ops.length) return;
  const { sites, groups } = await load(['sites', 'groups']);
  await chrome.storage.local.set(applyOps({ sites, groups }, ops));
}
