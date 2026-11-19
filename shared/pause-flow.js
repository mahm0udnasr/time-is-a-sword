/**
 * pause-flow.js — "Pause for 5 min": check a pause is possible, run the
 * friction step (countdown + typing a reminder), then ask the worker to grant
 * it. Used by the settings page (popup's Pause button) and the blocked page.
 *
 * Returns { ok, kind: 'ok' | 'info' | 'error', message } for the caller to show.
 */
import { runFriction } from '../options/friction.js';
import { t, ltr } from './i18n.js';
import { formatClock } from './format.js';

/** Can `domain` be paused now? Resolves { ok, status, row, message? } without asking anything. */
export async function pauseAvailability(domain) {
  const status = await chrome.runtime.sendMessage({ type: 'status' }).catch(() => null);
  const row = status?.rows?.find((r) => r.domain === domain);
  const site = ltr(domain);
  const message = !status || status.error ? t('pause.unreachable')
    : !row || !row.enabled ? t('pause.notActive', { site })
    : status.pausesLeft <= 0 ? t('pause.noneLeft')
    : null;
  return { ok: !message, status, row, message };
}

export async function runPauseFlow(domain) {
  const site = ltr(domain);
  const check = await pauseAvailability(domain);
  if (!check.ok) return { ok: false, kind: 'error', message: check.message };
  const { status } = check;

  const confirmed = await runFriction({
    title: t('pause.title', { site }),
    reasons: [
      t('pause.r1', { site, n: status.pauseMinutes }),
      t('pause.r2', { n: status.pausesLeft - 1 })
    ],
    note: t('pause.note'),
    confirmLabel: t('pause.confirm', { n: status.pauseMinutes })
  });
  if (!confirmed) return { ok: false, kind: 'info', message: t('pause.cancelled') };

  const res = await chrome.runtime.sendMessage({ type: 'pause', domain }).catch(() => null);
  if (res?.ok) return { ok: true, kind: 'ok', message: t('pause.done', { site, time: formatClock(res.until) }) };
  const key = { notActive: 'pause.notActive', noneLeft: 'pause.noneLeft' }[res?.code] || 'pause.failed';
  return { ok: false, kind: 'error', message: t(key, { site }) };
}
