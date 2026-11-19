/**
 * rule-editor.js — a self-contained editor for a list of rules, shared by the
 * site editor and the group editor, plus rule summaries (in the current language).
 *
 * A rule: { days: [0..6], mode, limitMinutes, windows: [{ start, end }] }
 * The first rule containing today's weekday applies; days no rule covers are
 * unrestricted. To keep that unambiguous, the editor rejects a day that
 * appears in two rules.
 */
import { ALL_DAYS, defaultRule } from '../background/storage.js';
import { hasLimit, hasSchedule } from '../background/rules.js';
import { dayName, describeDays } from '../shared/format.js';
import { t, ltr } from '../shared/i18n.js';
import { icon } from '../shared/icons.js';
import { h } from '../shared/dom.js';

export { h };

export { describeDays };

const MODE_KEYS = {
  block: 'mode.block',
  limit: 'mode.limit',
  schedule: 'mode.schedule',
  'limit+schedule': 'mode.limitSchedule'
};

const DEFAULT_WINDOW = { start: '13:00', end: '13:30' };

// ---------------------------------------------------------------------------
// Summaries

/** Word joiner: no line break on either side of the dash in "13:00–13:30". */
const WJ = String.fromCharCode(0x2060);

/** "13:00–13:30, 21:00–21:30", each range kept left-to-right and on one line. */
function describeWindows(windows) {
  return (windows || []).map((w) => ltr(`${w.start}${WJ}–${WJ}${w.end}`)).join(t('list.sep'));
}

export function describeRule(rule) {
  const days = describeDays(rule.days);
  const n = rule.limitMinutes;
  const w = describeWindows(rule.windows);
  switch (rule.mode) {
    case 'block': return t('sum.blocked', { days });
    case 'limit': return t('sum.limit', { days, n });
    case 'schedule': return t('sum.schedule', { days, w });
    case 'limit+schedule': return t('sum.limitSchedule', { days, n, w });
    default: return days;
  }
}

export function describeRules(rules, emptyText = t('sum.noRule')) {
  return rules?.length ? rules.map(describeRule).join(' · ') : emptyText;
}

// ---------------------------------------------------------------------------
// Editor

/**
 * @param {Array} initialRules
 * @param {{ allowEmpty?: boolean, emptyText?: string, label?: string }} opts
 * @returns {{ el: HTMLElement, read: () => { rules: Array, errors: string[] } }}
 */
export function createRulesEditor(initialRules, { allowEmpty = false, emptyText = '', label = '' } = {}) {
  const list = h('div', { class: 'rule-list' });
  const empty = h('p', { class: 'hint rule-empty' }, emptyText);

  const syncEmpty = () => { empty.hidden = list.children.length > 0 || !emptyText; };

  const addBtn = h('button', {
    type: 'button',
    class: 'add-rule',
    onclick: () => {
      // Pre-select the days no other rule uses yet.
      const used = new Set(readRules().flatMap((r) => r.days));
      const free = ALL_DAYS.filter((d) => !used.has(d));
      list.append(ruleCard({ ...defaultRule('limit'), days: free }));
      syncEmpty();
    }
  }, t('re.addRule'));

  function ruleCard(rule) {
    const card = h('div', { class: 'rule-card' });

    // Days
    const dayChips = [0, 1, 2, 3, 4, 5, 6].map((d) =>
      h('button', {
        type: 'button',
        class: 'chip',
        'data-day': String(d),
        'aria-pressed': String(rule.days.includes(d)),
        onclick: (e) => {
          const b = e.currentTarget;
          b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
        }
      }, dayName(d))
    );
    const days = h('div', { class: 'days', role: 'group', 'aria-label': t('re.daysFor', { label }) }, dayChips);

    // Mode
    const mode = h('select', { class: 'rule-mode', 'aria-label': t('re.ruleType') },
      Object.entries(MODE_KEYS).map(([value, key]) => h('option', { value }, t(key))));
    mode.value = rule.mode;

    // Minutes
    const minutes = h('input', {
      type: 'number', class: 'rule-minutes', min: '0', max: '1440', step: '1',
      inputmode: 'numeric', value: String(rule.limitMinutes ?? 20), 'aria-label': t('re.minutesLabel')
    });
    const minutesWrap = h('label', { class: 'minutes-wrap' }, minutes, h('span', { class: 'unit' }, t('re.minPerDay')));

    // Windows
    const windowList = h('div', { class: 'window-list' });
    const windowRow = (w) => {
      const row = h('div', { class: 'window-row' },
        h('input', { type: 'time', class: 'w-start', value: w.start, 'aria-label': t('re.from') }),
        h('span', { class: 'unit' }, t('re.to')),
        h('input', { type: 'time', class: 'w-end', value: w.end, 'aria-label': t('re.until') }),
        h('button', { type: 'button', class: 'ghost icon-only', title: t('re.removeHours'), 'aria-label': t('re.removeHours'), onclick: () => row.remove() }, icon('x', { size: 16 }))
      );
      return row;
    };
    (rule.windows || []).forEach((w) => windowList.append(windowRow(w)));
    const addWindow = h('button', {
      type: 'button', class: 'link-btn',
      onclick: () => windowList.append(windowRow(DEFAULT_WINDOW))
    }, t('re.addHours'));
    const windowsWrap = h('div', { class: 'windows-wrap' },
      h('span', { class: 'unit' }, t('re.allowedBetween')), windowList, addWindow);

    const syncMode = () => {
      minutesWrap.hidden = !hasLimit(mode.value);
      windowsWrap.hidden = !hasSchedule(mode.value);
      if (hasSchedule(mode.value) && !windowList.children.length) windowList.append(windowRow(DEFAULT_WINDOW));
    };
    mode.addEventListener('change', syncMode);
    syncMode();

    const remove = h('button', {
      type: 'button', class: 'ghost icon-only remove-rule', title: t('re.removeRule'), 'aria-label': t('re.removeRule'),
      onclick: () => { card.remove(); syncEmpty(); }
    }, icon('trash-2', { size: 16 }));

    card.append(
      h('div', { class: 'rule-head' }, days, remove),
      h('div', { class: 'rule-body' }, mode, minutesWrap),
      windowsWrap
    );
    return card;
  }

  function readRules() {
    return [...list.children].map((card) => {
      const mode = card.querySelector('.rule-mode').value;
      return {
        days: [...card.querySelectorAll('.chip[aria-pressed="true"]')].map((c) => Number(c.dataset.day)),
        mode,
        limitMinutes: Number(card.querySelector('.rule-minutes').value),
        windows: hasSchedule(mode)
          ? [...card.querySelectorAll('.window-row')].map((r) => ({
              start: r.querySelector('.w-start').value,
              end: r.querySelector('.w-end').value
            }))
          : []
      };
    });
  }

  /** Parse the editor and validate. */
  function read() {
    const rules = readRules();
    const errors = [];
    if (!allowEmpty && !rules.length) errors.push(t('err.atLeastOneRule'));

    const seen = new Map();
    rules.forEach((r, i) => {
      const n = rules.length > 1 ? t('err.rulePrefix', { n: i + 1 }) : '';
      if (!r.days.length) errors.push(n + t('err.pickDay'));
      for (const d of r.days) {
        if (seen.has(d)) errors.push(t('err.dayTwice', { day: dayName(d) }));
        seen.set(d, i);
      }
      if (hasLimit(r.mode) && !(Number.isInteger(r.limitMinutes) && r.limitMinutes >= 0 && r.limitMinutes <= 1440)) {
        errors.push(n + t('err.minutes'));
      }
      if (hasSchedule(r.mode)) {
        if (!r.windows.length) errors.push(n + t('err.oneRange'));
        for (const w of r.windows) {
          if (!w.start || !w.end) errors.push(n + t('err.bothTimes'));
          else if (w.start === w.end) errors.push(n + t('err.sameTime', { t: ltr(w.start) }));
        }
      }
      r.days.sort((a, b) => a - b);
    });
    return { rules, errors: [...new Set(errors)] };
  }

  (initialRules || []).forEach((r) => list.append(ruleCard(r)));
  syncEmpty();

  const el = h('div', { class: 'rules-editor' }, list, empty, addBtn);
  return { el, read };
}
