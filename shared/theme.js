/**
 * theme.js — applies the Appearance setting (settings.theme: 'system' | 'light' | 'dark')
 * to the current page by setting <html data-theme>. Import it from any page.
 */
import { load } from '../background/storage.js';

export function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

load(['settings']).then(({ settings }) => applyTheme(settings.theme));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) applyTheme(changes.settings.newValue?.theme);
});
