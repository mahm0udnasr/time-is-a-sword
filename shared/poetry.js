/**
 * poetry.js — lay out a poem like a printed diwan: each verse on two lines,
 * the first half (sadr) starting at the right, the second (ajuz) ending at the
 * left, and every half stretched with kashida (tatweel, "ـ") to the same
 * width, as in "الحـفـر". Used by the blocked page and the confirmation dialog.
 *
 * In data/quotes.json the two halves of a verse are separated by " ... "
 * (also accepted: "…"), and verses by a line break.
 *
 * Browsers cannot justify Arabic with kashida themselves (CSS
 * `text-justify: kashida` is not implemented), so it is done here: measure
 * each half, then insert tatweels at the joins between connected letters
 * until it reaches the width of the longest half.
 */

/** Split a poem into hemistichs. */
export function hemistichs(text) {
  return String(text).split(/\s*(?:\.{3}|…|\n)\s*/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Fill `container` with the poem. Returns false (and leaves the container
 * alone) if the text has no verse separator.
 */
export function renderPoem(container, text) {
  const halves = hemistichs(text);
  if (halves.length < 2) return false;
  const poem = document.createElement('div');
  poem.className = 'poem';
  for (let i = 0; i < halves.length; i += 2) {
    const verse = document.createElement('div');
    verse.className = 'verse';
    [halves[i], halves[i + 1]].forEach((part, j) => {
      if (!part) return;
      const line = document.createElement('span');
      line.className = j === 0 ? 'sadr' : 'ajuz';
      line.textContent = part;
      verse.append(line);
    });
    poem.append(verse);
  }
  container.replaceChildren(poem);
  return true;
}

/** Show a reminder in `container`: as verse if it is poetry, else as plain text. */
export function renderReminderText(container, quote) {
  const isPoem = quote.type === 'poetry' && renderPoem(container, quote.text);
  if (!isPoem) container.textContent = quote.text;
  return isPoem;
}

// ---------------------------------------------------------------------------
// Kashida justification. Code points are written as numbers on purpose.

const TATWEEL = String.fromCharCode(0x0640);
/** Letters that join only to the letter before them (never to the next one). */
const RIGHT_JOINING = new Set([0x0622, 0x0623, 0x0624, 0x0625, 0x0627, 0x0629, 0x062F, 0x0630, 0x0631, 0x0632, 0x0648, 0x0671, 0x0698]);
const ALEFS = new Set([0x0622, 0x0623, 0x0625, 0x0627, 0x0671]);
const HAMZA = 0x0621; // joins nothing
const LAM = 0x0644;
const ALEF = 0x0627;

/** Harakat, tanween, shadda, sukun, dagger alef and Quranic marks. */
const isMark = (cp) => (cp >= 0x0610 && cp <= 0x061A) || (cp >= 0x064B && cp <= 0x065F) || cp === 0x0670 || (cp >= 0x06D6 && cp <= 0x06ED);
const isLetter = (cp) => (cp >= 0x0620 && cp <= 0x064A) || (cp >= 0x066E && cp <= 0x06D3);
const joinsNext = (cp) => isLetter(cp) && cp !== HAMZA && !RIGHT_JOINING.has(cp);
const joinsPrev = (cp) => isLetter(cp) && cp !== HAMZA;

/**
 * Where a tatweel may go: between a letter that joins forward and the next
 * letter (after any harakat). Skipped: lam + alef (keeps the لا ligature) and
 * the lam of a word-initial definite article (الـدهر looks wrong).
 * Returns string indices grouped by word, each word's list ordered from its
 * end (classic typesetting stretches the last joins first).
 */
export function kashidaSlots(text) {
  const words = [];
  let current = [];
  let wordStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      if (current.length) words.push(current);
      current = [];
      wordStart = i + 1;
      continue;
    }
    const cp = text.charCodeAt(i);
    if (!joinsNext(cp)) continue;
    let j = i + 1;
    while (j < text.length && isMark(text.charCodeAt(j))) j++;
    if (j >= text.length) continue;
    const next = text.charCodeAt(j);
    if (!joinsPrev(next)) continue;
    if (cp === LAM && ALEFS.has(next)) continue;
    // "ال" at the start of a word (also after و / ف / ب / ك as in "والدهر").
    const articleAt = (k) => text.charCodeAt(k) === ALEF && i === k + 1;
    if (cp === LAM && (articleAt(wordStart) || (i === wordStart + 2 && articleAt(wordStart + 1) && 'وفبك'.includes(text[wordStart])))) continue;
    current.push(j); // insert just before the next letter, after this letter's harakat
  }
  if (current.length) words.push(current);
  return words.map((w) => w.reverse());
}

/**
 * Insert `count` tatweels into `text`, spread round-robin: first the last join
 * of every word, then the one before it, and so on. They go in pairs (`unit`),
 * because a single tatweel is only a couple of pixels wide and reads as noise;
 * fewer, longer elongations give the printed-diwan look. At most `maxPerSlot`
 * at a single join. Returns { text, used } (used < count when there is no room).
 */
export function stretch(text, count, slots = kashidaSlots(text), maxPerSlot = 4, unit = 2) {
  const order = [];
  const longest = Math.max(0, ...slots.map((w) => w.length));
  for (let r = 0; r < longest; r++) for (const w of slots) if (w[r] != null) order.push(w[r]);
  const at = new Map();
  let used = 0;
  for (let round = 0; round * unit < maxPerSlot && used < count; round++) {
    for (const i of order) {
      if (used >= count) break;
      const add = Math.min(unit, count - used, maxPerSlot - (at.get(i) || 0));
      if (add <= 0) continue;
      at.set(i, (at.get(i) || 0) + add);
      used += add;
    }
  }
  let out = text;
  for (const i of [...at.keys()].sort((a, b) => b - a)) out = out.slice(0, i) + TATWEEL.repeat(at.get(i)) + out.slice(i);
  return { text: out, used };
}

/**
 * How much wider than its longest half a poem is set. Every half (the longest
 * too) gets some kashida, which gives the elongated diwan look rather than
 * just equal lengths.
 */
const STRETCH = 1.15;

/** Stretch every half of one rendered poem to the same, slightly wider, width. */
function justifyPoem(poem) {
  const lines = [...poem.querySelectorAll('.sadr, .ajuz')];
  for (const l of lines) {
    l.dataset.text ??= l.textContent; // the original, so re-justifying starts clean
    l.textContent = l.dataset.text;
    l.style.wordSpacing = '';
  }
  const width = (el) => el.getBoundingClientRect().width;
  const longest = Math.max(0, ...lines.map(width));
  if (!longest) return; // not visible yet
  // Never wider than the space available: the inner width of the nearest
  // element marked data-poem-room (the page, or the dialog's quote panel),
  // minus the offset between the two halves.
  const box = poem.closest('[data-poem-room]') || document.body;
  const pad = getComputedStyle(box);
  const inner = box.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
  const offset = parseFloat(getComputedStyle(lines[0]).marginInlineEnd) || 0;
  const room = inner - offset - 4;
  const target = Math.max(longest, Math.min(longest * STRETCH, room));

  for (const l of lines) {
    const base = l.dataset.text;
    const natural = width(l);
    if (target - natural < 2) continue;
    const slots = kashidaSlots(base);
    if (slots.length) {
      // Width of one tatweel at this size, then aim, measure, correct.
      l.textContent = stretch(base, 1, slots).text;
      const per = Math.max(1, width(l) - natural);
      let n = Math.max(0, Math.round((target - natural) / per));
      for (let tries = 0; tries < 6; tries++) {
        const out = stretch(base, n, slots);
        l.textContent = out.text;
        const diff = target - width(l);
        if (Math.abs(diff) < per / 2 || out.used < n) break;
        n = Math.max(0, n + Math.round(diff / per));
      }
      while (n > 0 && width(l) > target + 0.5) l.textContent = stretch(base, --n, slots).text;
    }
    // Whatever is left (less than one tatweel, or no room for more): widen spaces a little.
    const gap = target - width(l);
    const spaces = (base.match(/\s/g) || []).length;
    if (gap > 1 && spaces) l.style.wordSpacing = `${Math.min(gap / spaces, 24)}px`;
  }
}

/** Justify every poem inside `root`. Waits for the web font so widths are real. */
export async function justifyPoems(root = document) {
  await document.fonts?.ready;
  for (const poem of root.querySelectorAll('.poem')) justifyPoem(poem);
}

let resizeHooked = false;

/** Justify now and again whenever the window is resized (font size follows it). */
export function autoJustify(root = document) {
  justifyPoems(root);
  if (resizeHooked) return;
  resizeHooked = true;
  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => justifyPoems(document), 150);
  });
}
