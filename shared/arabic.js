/**
 * arabic.js — normalization for the "type the reminder" check.
 *
 * Differences that are ignored:
 *   - tashkeel (harakat, tanween, shadda, sukun, dagger alef, Quranic marks)
 *   - tatweel (ـ)
 *   - أ إ آ ٱ → ا ,  ى → ي ,  ة → ه
 *   - extra spaces (any run of whitespace counts as one; leading/trailing ignored)
 *   - the verse separator "..." / "…" in poetry (counts as a space, so the two
 *     halves can be typed on two lines or one)
 * Everything else (letters, punctuation) must match.
 */

// U+0610–061A Quranic signs, U+064B–065F harakat, U+0670 dagger alef,
// U+06D6–06ED Quranic annotation marks, U+0640 tatweel.
const DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

export function normalizeArabic(text) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\.{3}|…/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True if what was typed matches the reminder text, ignoring the above. */
export function matchesReminder(typed, original) {
  return normalizeArabic(typed) === normalizeArabic(original);
}

/**
 * Progress feedback: how many of the original's words have been typed
 * correctly so far, and the first word that differs (null if none).
 */
export function typingProgress(typed, original) {
  const t = normalizeArabic(typed).split(' ').filter(Boolean);
  const o = normalizeArabic(original).split(' ');
  let ok = 0;
  while (ok < t.length && ok < o.length && t[ok] === o[ok]) ok++;
  // The word being typed right now may be an unfinished prefix: not an error yet.
  const typingLast = ok === t.length - 1 && o[ok]?.startsWith(t[ok]) && !/\s$/.test(typed);
  const wrongWord = ok < t.length && !typingLast ? ok : null;
  return { correctWords: ok, totalWords: o.length, wrongWordIndex: wrongWord, expected: wrongWord != null ? o[wrongWord] : null };
}
