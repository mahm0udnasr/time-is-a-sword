/**
 * chart.js — "Last 7 days": one bar per day (total active time), plain SVG.
 * Hover or focus a bar for that day's details (date, total, top sites).
 *
 * Single series, so no legend: the title and the site filter name it.
 */
import { load } from '../background/storage.js';
import { dayKey, logicalDate } from '../background/rules.js';
import { formatDuration } from '../shared/format.js';
import { h } from '../shared/dom.js';
import { t, locale, inLtrContext } from '../shared/i18n.js';

const SVG = 'http://www.w3.org/2000/svg';
const W = 640;
const H = 220;
const M = { top: 16, right: 8, bottom: 28, left: 64 }; // left: room for "1 س 30 د"

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
}

/** The last 7 logical days, oldest first: [{ key, date }] */
function lastDays(now, resetHour) {
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = logicalDate(now, resetHour);
    d.setDate(d.getDate() - i);
    out.push({ key: dayKey(d.getTime(), 0), date: d });
  }
  return out;
}

/** A "nice" axis step in seconds for a maximum value. */
function niceStep(maxSec) {
  const steps = [60, 300, 600, 900, 1800, 3600, 7200, 10800, 14400, 21600];
  return steps.find((st) => maxSec / st <= 4) || 21600;
}

/** Bar with a 4px rounded top, square bottom on the baseline. */
function barPath(x, y, w, hgt) {
  const r = Math.min(4, w / 2, hgt);
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}

export async function renderChart(container, select) {
  const now = Date.now();
  const { usage, settings } = await load(['usage', 'settings']);
  const days = lastDays(now, settings.resetHour);

  // Site filter: every domain seen in the history.
  const domains = [...new Set(days.flatMap((d) => Object.keys(usage[d.key]?.seconds || {})))].sort();
  const chosen = select.value;
  select.replaceChildren(h('option', { value: '' }, t('chart.allSites')), ...domains.map((d) => h('option', { value: d }, d)));
  select.value = domains.includes(chosen) ? chosen : '';
  const only = select.value;

  const data = days.map((d) => {
    const seconds = usage[d.key]?.seconds || {};
    const total = only ? seconds[only] || 0 : Object.values(seconds).reduce((a, b) => a + b, 0);
    const top = Object.entries(seconds).filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1]).slice(0, 3);
    return { ...d, total, top };
  });

  const max = Math.max(...data.map((d) => d.total), 60);
  const step = niceStep(max);
  const yMax = Math.ceil(max / step) * step;
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const slot = plotW / data.length;
  const barW = Math.min(44, slot * 0.6);
  const y = (v) => M.top + plotH - (v / yMax) * plotH;

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', class: 'chart-svg',
    'aria-label': t('chart.aria', { what: only || t('chart.allSites') }) });

  // Recessive grid + y labels
  for (let v = 0; v <= yMax; v += step) {
    svg.append(
      s('line', { x1: M.left, x2: W - M.right, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }),
      s('text', { x: M.left - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, v === 0 ? '0' : inLtrContext(formatDuration(v)))
    );
  }

  const tooltip = h('div', { class: 'chart-tooltip', role: 'tooltip', hidden: true });
  const todayKey = days[days.length - 1].key;

  data.forEach((d, i) => {
    const cx = M.left + slot * i + slot / 2;
    const label = i === data.length - 1 ? t('chart.today') : d.date.toLocaleDateString(locale(), { weekday: 'short' });
    svg.append(s('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'tick' }, inLtrContext(label)));

    if (d.total > 0) {
      const top = y(d.total);
      svg.append(s('path', { d: barPath(cx - barW / 2, top, barW, M.top + plotH - top), class: `bar${d.key === todayKey ? ' today' : ''}` }));
    }
    // Today's value is labelled directly; the rest are on hover.
    if (d.key === todayKey && d.total > 0) {
      svg.append(s('text', { x: cx, y: y(d.total) - 6, 'text-anchor': 'middle', class: 'value' }, inLtrContext(formatDuration(d.total))));
    }

    // Hit target: the whole column, bigger than the bar.
    const hit = s('rect', { x: cx - slot / 2, y: M.top, width: slot, height: plotH, class: 'hit', tabindex: '0',
      'aria-label': `${d.date.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'short' })}: ${formatDuration(d.total)}` });
    const show = () => {
      const lines = [
        h('strong', {}, d.date.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'short' })),
        h('span', {}, only ? t('chart.on', { time: formatDuration(d.total), site: only }) : t('chart.inTotal', { time: formatDuration(d.total) }))
      ];
      if (!only) d.top.forEach(([dom, sec]) => lines.push(h('span', { class: 'muted' }, `${dom} · ${formatDuration(sec)}`)));
      tooltip.replaceChildren(...lines);
      tooltip.hidden = false;
      tooltip.style.left = `${(cx / W) * 100}%`;
    };
    hit.addEventListener('mouseenter', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('mouseleave', () => { tooltip.hidden = true; });
    hit.addEventListener('blur', () => { tooltip.hidden = true; });
    svg.append(hit);
  });

  container.replaceChildren(svg, tooltip);
}
