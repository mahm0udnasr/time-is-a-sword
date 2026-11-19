/**
 * options.js — the settings page: tabs, overview, sites, groups, pause
 * requests, toasts and the theme switch.
 *
 * Every change to sites and groups goes through commit() (commit.js):
 * stricter changes apply at once; looser ones need the friction step first,
 * then apply at once. The chart is chart.js. Settings are fixed
 * (storage.js DEFAULT_SETTINGS) and reminders come from data/quotes.json.
 *
 * URL hash: #overview, #sites, … selects a tab; #pause=<domain> (from the
 * popup) starts a pause request.
 */
import { load, makeSite, makeGroup, normalizeDomain } from '../background/storage.js';
import { dayKey, usedSeconds, todayLimitSec } from '../background/rules.js';
import { createRulesEditor, describeRules, h } from './rule-editor.js';
import { commit } from './commit.js';
import { runPauseFlow } from '../shared/pause-flow.js';
import { renderChart } from './chart.js';
import { initPrayer, renderPrayer } from './prayer.js';
import { renderAbout } from './about.js';
import { formatClock, formatDuration } from '../shared/format.js';
import { icon, hydrateIcons } from '../shared/icons.js';
import { t, ltr, initPageLanguage, toggleLanguage } from '../shared/i18n.js';

const $ = (id) => document.getElementById(id);
const TABS = ['overview', 'sites', 'groups', 'prayer', 'about'];

/** Which editor is open: { kind: 'site' | 'group', id } or null. */
let openEditor = null;
let siteQuery = '';

// Language first: everything below renders text in it.
await initPageLanguage();
hydrateIcons();
$('lang-toggle').addEventListener('click', toggleLanguage);

// ---------------------------------------------------------------------------
// Tabs

function selectTab(name, { focus = false } = {}) {
  if (!TABS.includes(name)) name = 'overview';
  for (const t of TABS) {
    const tab = $(`tab-${t}`);
    const on = t === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`panel-${t}`).hidden = !on;
  }
  if (focus) $(`tab-${name}`).focus();
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  try { localStorage.setItem('tab', name); } catch { /* storage unavailable: fine */ }
  if (name === 'overview') renderOverview();
  if (name === 'prayer') renderPrayer();
  if (name === 'about') renderAbout();
}

document.querySelector('.tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[role=tab]');
  if (!tab) return;
  selectTab(tab.dataset.tab);
  closeMenu();
});

// ---------------------------------------------------------------------------
// ⓘ next to each page title: the page description as a tooltip. Hover/focus
// shows it (CSS); a tap toggles it, for touch screens. Tap elsewhere or Esc closes.

function closeTips(except = null) {
  for (const info of document.querySelectorAll('.info.open')) {
    if (info === except) continue;
    info.classList.remove('open');
    info.querySelector('.info-btn').setAttribute('aria-expanded', 'false');
  }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.info-btn');
  const info = btn?.parentElement;
  closeTips(info);
  if (!info) return;
  const open = info.classList.toggle('open');
  btn.setAttribute('aria-expanded', String(open));
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTips(); });

// ---------------------------------------------------------------------------
// Narrow screens: the menu button opens the drawer with the tabs, theme and language.

const drawer = $('drawer');
const narrow = window.matchMedia('(max-width: 860px)');

function openMenu() {
  drawer.classList.add('open');
  $('scrim').hidden = false;
  $('menu-btn').setAttribute('aria-expanded', 'true');
  document.body.style.overflow = 'hidden';
  drawer.querySelector('[role=tab][aria-selected=true]')?.focus();
}

function closeMenu({ restoreFocus = false } = {}) {
  if (!drawer.classList.contains('open')) return;
  drawer.classList.remove('open');
  $('scrim').hidden = true;
  $('menu-btn').setAttribute('aria-expanded', 'false');
  document.body.style.overflow = '';
  if (restoreFocus) $('menu-btn').focus();
}

$('menu-btn').addEventListener('click', openMenu);
$('menu-close').addEventListener('click', () => closeMenu({ restoreFocus: true }));
$('scrim').addEventListener('click', () => closeMenu({ restoreFocus: true }));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawer.classList.contains('open')) closeMenu({ restoreFocus: true });
});
narrow.addEventListener('change', () => closeMenu()); // rotated / resized to desktop width
document.querySelector('.tabs').addEventListener('keydown', (e) => {
  const i = TABS.indexOf(document.activeElement?.dataset?.tab);
  if (i < 0) return;
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
  if (step) {
    e.preventDefault();
    selectTab(TABS[(i + step + TABS.length) % TABS.length], { focus: true });
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    selectTab(TABS[e.key === 'Home' ? 0 : TABS.length - 1], { focus: true });
  }
});

function initialTab() {
  const fromHash = location.hash.slice(1);
  if (TABS.includes(fromHash)) return fromHash;
  try { return localStorage.getItem('tab') || 'overview'; } catch { return 'overview'; }
}

// ---------------------------------------------------------------------------
// Theme switch (appearance only: written directly, never needs confirmation)

async function renderThemeSwitch() {
  const { settings } = await load(['settings']);
  const current = settings.theme || 'system';
  for (const b of document.querySelectorAll('[data-theme-value]')) {
    const on = b.dataset.themeValue === current;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

document.querySelector('.theme-switch').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-theme-value]');
  if (!b) return;
  const { settings } = await load(['settings']);
  await chrome.storage.local.set({ settings: { ...settings, theme: b.dataset.themeValue } });
});

// ---------------------------------------------------------------------------
// Toasts

function toast(text, kind = 'info') {
  const name = { ok: 'check', error: 'triangle-alert', info: 'info' }[kind];
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(name), h('p', {}, text));
  const close = h('button', { type: 'button', 'aria-label': t('dismiss'), onclick: () => el.remove() }, icon('x', { size: 16 }));
  el.append(close);
  $('toasts').append(el);
  setTimeout(() => el.remove(), 7000);
}

/** Tell the user what happened after commit(). */
function reportCommit(result, what = t('saved')) {
  if (!result.ok) toast(t('cancelled'));
  else toast(`${what}.`, 'ok');
}

// ---------------------------------------------------------------------------
// Overview

async function renderOverview() {
  if ($('panel-overview').hidden) return;
  const status = await chrome.runtime.sendMessage({ type: 'status' }).catch(() => null);
  if (!status || status.error) return;

  const total = status.rows.reduce((sum, r) => sum + r.usedSec, 0);
  $('stat-time').textContent = formatDuration(total);
  $('stat-blocked').textContent = String(status.rows.filter((r) => r.blocked).length);
  $('stat-pauses').textContent = String(status.pausesLeft);
  $('reset-at').textContent = t('newDayAt', { time: formatClock(status.resetAt) });

  const rows = status.rows
    .filter((r) => (r.enabled && (r.mode || r.groupName)) || r.usedSec >= 1)
    .sort((a, b) => b.usedSec - a.usedSec || a.domain.localeCompare(b.domain));

  const groupItems = status.groups.filter((g) => g.limitSec != null).map((g) => usageItem({
    name: g.name, badge: t('badge.group'), used: g.usedSec, limit: g.limitSec, blocked: g.usedSec >= g.limitSec,
    value: `${formatDuration(g.usedSec)} / ${formatDuration(g.limitSec)}`
  }));
  const siteItems = rows.map((r) => usageItem({
    name: r.domain,
    badge: r.pausedUntil ? t('badge.paused') : r.groupName,
    used: r.usedSec,
    limit: r.limitSec,
    blocked: r.blocked,
    value: r.blocked
      ? `${t(`reason.${r.reason || 'blocked'}`)} · ${formatDuration(r.usedSec)}`
      : r.limitSec != null ? `${formatDuration(r.usedSec)} / ${formatDuration(r.limitSec)}` : formatDuration(r.usedSec)
  }));
  $('today-list').replaceChildren(...groupItems, ...siteItems);
  $('today-empty').hidden = groupItems.length + siteItems.length > 0;
}

function usageItem({ name, badge, used, limit, blocked, value }) {
  const li = h('li', {},
    h('div', { class: 'usage-head' },
      h('span', { class: 'usage-name' }, name, badge ? h('span', { class: 'badge neutral' }, badge) : null),
      h('span', { class: `usage-value${blocked ? ' blocked' : ''}` }, value)));
  if (limit != null) li.append(progress(used, limit));
  return li;
}

function progress(used, limit) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 1;
  const bar = h('div', { class: `bar${ratio >= 1 ? ' full' : ratio >= 0.75 ? ' warn' : ''}`,
    role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(Math.round(limit)), 'aria-valuenow': String(Math.round(Math.min(used, limit))) },
  h('span', {}));
  bar.firstChild.style.width = `${ratio * 100}%`;
  return bar;
}


// ---------------------------------------------------------------------------
// Sites and groups

async function render() {
  if (openEditor) return; // re-rendered when the editor closes
  const { sites, groups, usage, settings } = await load(['sites', 'groups', 'usage', 'settings']);
  const now = Date.now();
  const ctx = { usage, now, resetHour: settings.resetHour };

  const q = siteQuery.trim().toLowerCase();
  const shown = q ? sites.filter((s) => s.domain.includes(q)) : sites;
  $('site-list').replaceChildren(...shown.map((s) => siteRow(s, groups, ctx)));
  $('sites-empty').hidden = shown.length > 0;
  $('sites-empty-text').textContent = q ? t('sites.noMatch', { q: siteQuery.trim() }) : t('sites.empty');
  $('count-sites').textContent = String(sites.filter((s) => s.enabled).length || '');

  $('group-list').replaceChildren(...groups.map((g) => groupRow(g, sites)));
  $('groups-empty').hidden = groups.length > 0;
  $('count-groups').textContent = String(groups.length || '');

}

function toggleSwitch(checked, label, onchange) {
  return h('label', { class: 'switch' },
    h('input', { type: 'checkbox', checked, 'aria-label': label, onchange: (e) => onchange(e.target.checked) }),
    h('span', { 'aria-hidden': 'true' }));
}


function iconButton(name, label, onclick, extra = '') {
  return h('button', { type: 'button', class: `ghost icon-only ${extra}`, title: label, 'aria-label': label, onclick }, icon(name));
}

function siteRow(site, groups, { usage, now, resetHour }) {
  const group = groups.find((g) => g.id === site.groupId);
  const used = usedSeconds(usage, site.domain, now, resetHour);
  const limit = site.enabled ? todayLimitSec(site, now, resetHour) : null;
  const row = h('li', { class: `entity${site.enabled ? '' : ' off'}` });

  const usageCell = h('div', { class: 'entity-usage' },
    h('span', {}, limit != null ? `${formatDuration(used)} / ${formatDuration(limit)}` : used >= 1 ? t('usage.today', { time: formatDuration(used) }) : ''));
  if (limit != null) usageCell.append(progress(used, limit));

  const site_ = ltr(site.domain); // domains stay left-to-right inside Arabic sentences
  const editBtn = iconButton('pencil', t('site.edit', { site: site.domain }), () => openSiteEditor(site, row, editBtn));

  row.append(
    toggleSwitch(site.enabled, t('site.apply', { site: site.domain }), async (on) => {
      const result = await commit((st) => {
        st.sites.find((s) => s.id === site.id).enabled = on;
        return st;
      }, { title: t('site.switchOffTitle', { site: site_ }) });
      reportCommit(result, t(on ? 'site.switchedOn' : 'site.switchedOff', { site: site_ }));
      render(); // puts the switch back if cancelled
    }),
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, site.domain.replace(/^(web|m|mobile)\./, '')[0]),
    h('div', { class: 'entity-main' },
      h('span', { class: 'entity-name' }, site.domain,
        group ? h('span', { class: 'badge' }, group.name) : null),
      h('span', { class: 'entity-summary' },
        describeRules(site.rules, t(group ? 'rules.groupOnly' : 'rules.trackedOnly')))),
    usageCell,
    h('div', { class: 'entity-actions' },
      editBtn,
      iconButton('trash-2', t('site.remove', { site: site.domain }), async () => {
        const result = await commit((st) => ({ ...st, sites: st.sites.filter((s) => s.id !== site.id) }),
          { title: t('site.removeTitle', { site: site_ }) });
        reportCommit(result, t('site.removed', { site: site_ }));
      }, 'danger-hover'))
  );
  return row;
}

function groupRow(group, sites) {
  const members = sites.filter((s) => s.groupId === group.id);
  const row = h('li', { class: `entity${group.enabled ? '' : ' off'}` });
  const editBtn = iconButton('pencil', t('group.edit', { name: group.name }), () => openGroupEditor(group, sites, row, editBtn));

  row.append(
    toggleSwitch(group.enabled, t('group.apply', { name: group.name }), async (on) => {
      const result = await commit((st) => {
        st.groups.find((g) => g.id === group.id).enabled = on;
        return st;
      }, { title: t('group.switchOffTitle', { name: group.name }) });
      reportCommit(result, t(on ? 'group.switchedOn' : 'group.switchedOff', { name: group.name }));
      render();
    }),
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, icon('layers')),
    h('div', { class: 'entity-main' },
      h('span', { class: 'entity-name' }, group.name),
      h('span', { class: 'entity-summary' }, describeRules(group.rules)),
      h('span', { class: 'entity-summary' },
        members.length ? members.map((m) => ltr(m.domain)).join(t('list.sep')) : t('group.noSites'))),
    h('div', { class: 'entity-usage' }),
    h('div', { class: 'entity-actions' },
      editBtn,
      iconButton('trash-2', t('group.remove', { name: group.name }), async () => {
        const result = await commit((st) => ({
          ...st,
          groups: st.groups.filter((g) => g.id !== group.id),
          sites: st.sites.map((s) => (s.groupId === group.id ? { ...s, groupId: null } : s))
        }), { title: t('group.removeTitle', { name: group.name }) });
        reportCommit(result, t('group.removed', { name: group.name }));
      }, 'danger-hover'))
  );
  return row;
}

// ---------------------------------------------------------------------------
// Editors

/** Mount an editor panel under a row. onSave returns error strings, or a commit result. */
function mountEditor(row, editBtn, kind, id, content, onSave) {
  if (openEditor) {
    document.querySelector('.editor')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  openEditor = { kind, id };
  editBtn.disabled = true;

  const errors = h('ul', { class: 'error-list', role: 'alert' });
  const close = () => {
    panel.remove();
    openEditor = null;
    render();
  };
  const save = h('button', { type: 'button', class: 'primary' }, icon('check'), t('save'));
  const panel = h('li', { class: 'editor' },
    content,
    errors,
    h('div', { class: 'editor-actions' },
      h('button', { type: 'button', onclick: close }, t('cancel')),
      save));

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const out = await onSave();
      if (Array.isArray(out)) {
        errors.replaceChildren(...out.map((p) => h('li', {}, p)));
      } else if (!out.ok) {
        errors.replaceChildren(h('li', {}, t('cancelled')));
      } else {
        reportCommit(out);
        close();
      }
    } finally {
      save.disabled = false;
    }
  });
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  row.after(panel);
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  panel.querySelector('input, select, button')?.focus({ preventScroll: true });
}

function openSiteEditor(site, row, editBtn) {
  const editor = createRulesEditor(site.rules, {
    allowEmpty: true,
    label: site.domain,
    emptyText: t(site.groupId ? 'editor.noOwnRule' : 'editor.noRule')
  });
  const content = h('div', {}, h('h3', {}, t('editor.rulesFor', { site: ltr(site.domain) })), editor.el);
  mountEditor(row, editBtn, 'site', site.id, content, async () => {
    const { rules, errors } = editor.read();
    if (errors.length) return errors;
    return commit((st) => {
      st.sites.find((s) => s.id === site.id).rules = rules;
      return st;
    }, { title: t('site.loosenTitle', { site: ltr(site.domain) }) });
  });
}

function openGroupEditor(group, sites, row, editBtn) {
  const name = h('input', { type: 'text', value: group.name, maxlength: '40', 'aria-label': t('group.nameLabel') });
  const memberBoxes = sites.map((s) => {
    const other = s.groupId && s.groupId !== group.id;
    return h('label', { class: 'member' },
      h('input', { type: 'checkbox', checked: s.groupId === group.id, 'data-site': s.id }),
      s.domain,
      other ? h('span', { class: 'hint' }, t('group.movesHere')) : null);
  });

  const editor = createRulesEditor(group.rules, { label: group.name });
  const content = h('div', {},
    h('h3', {}, t('group.name')),
    name,
    h('h3', {}, t('group.sites')),
    sites.length ? h('div', { class: 'members' }, memberBoxes) : h('p', { class: 'hint' }, t('group.addSitesFirst')),
    h('h3', {}, t('group.sharedRules')),
    editor.el);

  mountEditor(row, editBtn, 'group', group.id, content, async () => {
    const { rules, errors } = editor.read();
    const newName = name.value.trim();
    if (!newName) errors.unshift(t('err.groupNameMissing'));
    const { groups } = await load(['groups']);
    if (groups.some((g) => g.id !== group.id && g.name.toLowerCase() === newName.toLowerCase())) {
      errors.unshift(t('err.groupNameDup', { name: newName }));
    }
    if (errors.length) return errors;

    const checked = new Set(memberBoxes.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.dataset.site));
    return commit((st) => ({
      ...st,
      groups: st.groups.map((g) => (g.id === group.id ? { ...g, name: newName, rules } : g)),
      sites: st.sites.map((s) => {
        if (checked.has(s.id)) return { ...s, groupId: group.id };
        if (s.groupId === group.id) return { ...s, groupId: null };
        return s;
      })
    }), { title: t('group.loosenTitle', { name: newName }) });
  });
}

// ---------------------------------------------------------------------------
// Adding (always stricter, so no friction)

function showError(id, text) {
  $(id).textContent = text;
  $(id).hidden = !text;
}

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('add-domain');
  const domain = normalizeDomain(input.value);
  showError('add-error', '');
  if (!domain) return showError('add-error', t('err.badDomain'));
  const { sites } = await load(['sites']);
  if (sites.some((s) => s.domain === domain)) return showError('add-error', t('err.dupDomain', { site: ltr(domain) }));
  await commit((st) => ({ ...st, sites: [...st.sites, makeSite(domain, { enabled: true })] }));
  input.value = '';
  toast(t('site.added', { site: ltr(domain) }), 'ok');
});

$('site-search').addEventListener('input', (e) => {
  siteQuery = e.target.value;
  render();
});

$('group-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('group-name');
  const name = input.value.trim();
  showError('group-error', '');
  if (!name) return showError('group-error', t('err.groupNameEmpty'));
  const { groups } = await load(['groups']);
  if (groups.some((g) => g.name.toLowerCase() === name.toLowerCase())) {
    return showError('group-error', t('err.groupNameDup', { name }));
  }
  await commit((st) => ({ ...st, groups: [...st.groups, makeGroup(name)] }));
  input.value = '';
  toast(t('group.added', { name }), 'ok');
});

// ---------------------------------------------------------------------------
// Pause (from the popup: options.html#pause=<domain>)

async function handlePauseRequest() {
  const match = location.hash.match(/^#pause=(.+)$/);
  if (!match) return false;
  selectTab('overview');
  const res = await runPauseFlow(decodeURIComponent(match[1]));
  toast(res.message, res.kind === 'info' ? undefined : res.kind);
  renderOverview();
  return true;
}

window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#pause=')) handlePauseRequest();
  else if (TABS.includes(location.hash.slice(1))) selectTab(location.hash.slice(1));
});

// ---------------------------------------------------------------------------
// Chart

const chartArgs = [$('chart'), $('chart-site')];
let lastChartAt = Date.now();
$('chart-site').addEventListener('change', () => renderChart(...chartArgs));

// ---------------------------------------------------------------------------
// Live updates

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.sites || changes.groups) render();
  if (changes.settings) renderThemeSwitch();
  // Usage is saved every 30 s: refresh at most once a minute, and not while a
  // chart tooltip is open.
  if (changes.usage && Date.now() - lastChartAt > 60000 && !document.querySelector('.chart .hit:hover, .chart .hit:focus')) {
    lastChartAt = Date.now();
    renderChart(...chartArgs);
    renderOverview();
    render();
  }
});

// ---------------------------------------------------------------------------
// Start

render();
renderThemeSwitch();
renderChart(...chartArgs);
initPrayer(toast);
renderPrayer();
handlePauseRequest().then((handled) => { if (!handled) selectTab(initialTab()); });
