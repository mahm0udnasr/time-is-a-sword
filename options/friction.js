/**
 * friction.js — the anti-cheat step before any change that loosens a rule.
 *
 *   1. A countdown (30 s by default) that only runs while this page is visible.
 *   2. A random reminder that must be typed exactly (ignoring tashkeel, extra
 *      spaces, أ/إ/آ/ا, ى/ي, ة/ه). Pasting and dropping text are blocked.
 * Confirm is enabled only when both are done.
 */
import { pickQuote, load } from '../background/storage.js';
import { matchesReminder, typingProgress } from '../shared/arabic.js';
import { h } from '../shared/dom.js';
import { renderReminderText, autoJustify } from '../shared/poetry.js';
import { t } from '../shared/i18n.js';

/** Used only if the reminders list is empty. */
const FALLBACK_QUOTE = { text: 'الوقت سيف، فإن قطعته وإلا قطعك', source: 'منقول عن الإمام الشافعي' };

/** The reminder as a <blockquote>, laid out as verse if it is poetry. */
function renderedQuote(quote) {
  const box = h('blockquote', { class: 'quote', lang: 'ar', dir: 'rtl' });
  renderReminderText(box, quote);
  return box;
}

/**
 * @param {{ title: string, reasons: string[], note?: string, confirmLabel?: string }} opts
 * @returns {Promise<boolean>} true if the user completed the step
 */
export async function runFriction({ title, reasons, note, confirmLabel = t('fr.confirm') }) {
  const { settings } = await load(['settings']);
  const total = Math.max(1, settings.friction?.countdownSec ?? 30);
  const quote = (await pickQuote()) || FALLBACK_QUOTE;

  return new Promise((resolve) => {
    let remaining = total;
    let timer = null;

    const countdown = h('span', { class: 'countdown' });
    const status = h('p', { class: 'typing-status', 'aria-live': 'polite' });
    const input = h('textarea', {
      class: 'typing quote', dir: 'rtl', lang: 'ar', rows: '3',
      autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false',
      'aria-label': t('fr.typeLabel')
    });
    const confirm = h('button', { type: 'button', class: 'primary danger', disabled: true }, confirmLabel);
    const cancel = h('button', { type: 'button' }, t('cancel'));

    const dialog = h('dialog', { class: 'friction', 'aria-labelledby': 'friction-title' },
      h('h2', { id: 'friction-title' }, title),
      reasons.length ? h('ul', { class: 'reasons' }, reasons.map((r) => h('li', {}, r))) : null,
      note ? h('p', { class: 'hint' }, note) : null,
      h('figure', { class: 'friction-quote', 'data-poem-room': true },
        renderedQuote(quote),
        h('figcaption', { class: 'quote source', lang: 'ar', dir: 'rtl' }, quote.source)),
      h('label', { class: 'typing-label' }, t(quote.type === 'poetry' ? 'fr.typeVerse' : 'fr.typeQuote')),
      input,
      status,
      h('div', { class: 'friction-actions' }, countdown, cancel, confirm));

    // No shortcuts: block paste, drop and autofill-style insertions.
    for (const ev of ['paste', 'drop', 'dragover']) input.addEventListener(ev, (e) => e.preventDefault());
    input.addEventListener('beforeinput', (e) => {
      if (/^insertFrom(Paste|Drop|Yank)|insertReplacementText/.test(e.inputType)) e.preventDefault();
    });

    const matched = () => matchesReminder(input.value, quote.text);

    function update() {
      const ok = matched();
      confirm.disabled = !(ok && remaining <= 0);
      countdown.textContent = remaining > 0 ? t('fr.wait', { n: remaining }) : '';
      if (!input.value.trim()) {
        status.textContent = '';
        status.className = 'typing-status';
      } else if (ok) {
        status.textContent = t(remaining > 0 ? 'fr.matchesWait' : 'fr.matches');
        status.className = 'typing-status ok';
      } else {
        const p = typingProgress(input.value, quote.text);
        status.textContent = p.wrongWordIndex != null
          ? t('fr.wordDiffers', { n: p.wrongWordIndex + 1, w: p.expected })
          : t('fr.progress', { a: p.correctWords, b: p.totalWords });
        status.className = `typing-status${p.wrongWordIndex != null ? ' bad' : ''}`;
      }
    }

    // The countdown only runs while the page is visible.
    timer = setInterval(() => {
      if (document.visibilityState === 'visible' && remaining > 0) {
        remaining--;
        update();
      }
    }, 1000);

    function finish(result) {
      clearInterval(timer);
      dialog.close();
      dialog.remove();
      resolve(result);
    }

    input.addEventListener('input', update);
    cancel.addEventListener('click', () => finish(false));
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); }); // Esc
    confirm.addEventListener('click', () => {
      if (matched() && remaining <= 0) finish(true);
    });

    document.body.append(dialog);
    dialog.showModal();
    autoJustify(dialog); // poetry: stretch both halves to the same width
    input.focus();
    update();
  });
}
