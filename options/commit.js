/**
 * commit.js — the one way the options page changes sites and groups.
 *
 *   mutate(current) → next state
 *   → diff into ops (background/loosen.js)
 *   → stricter/neutral changes apply at once
 *   → if anything is looser: the friction step first (countdown + typing a
 *     reminder), then everything applies at once
 */
import { load } from '../background/storage.js';
import { diffState, describeLoosening } from '../background/loosen.js';
import { applyChanges } from '../background/changes.js';
import { runFriction } from './friction.js';
import { t } from '../shared/i18n.js';

/**
 * @param {(state: {sites, groups}) => {sites, groups}} mutate
 *   receives a deep copy; may modify it in place and return it
 * @param {{ title?: string }} [opts]
 * @returns {Promise<{ ok: boolean }>} ok:false = cancelled (nothing changed)
 */
export async function commit(mutate, { title = t('fr.defaultTitle') } = {}) {
  const cur = await load(['sites', 'groups']);
  const next = mutate(structuredClone({ sites: cur.sites, groups: cur.groups }));
  const ops = diffState(cur, next);
  if (!ops.length) return { ok: true };

  const looser = ops.filter((o) => o.reasons.length);
  if (looser.length) {
    const confirmed = await runFriction({
      title,
      reasons: describeLoosening(looser),
      note: t('fr.note'),
      confirmLabel: t('fr.apply')
    });
    if (!confirmed) return { ok: false };
  }
  await applyChanges(ops);
  return { ok: true };
}
