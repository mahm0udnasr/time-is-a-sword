/** icons.js — build an inline Lucide icon: icon('trash-2') → <svg class="icon">… */
import { ICONS } from '../vendor/lucide/icons.js';
import { BRAND_PATHS } from '../vendor/simple-icons/icons.js';

const SVG = 'http://www.w3.org/2000/svg';

export function icon(name, { size = 18, label } = {}) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', 'icon');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  // Trusted, bundled markup (vendor/lucide/icons.js), never user input.
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

/** Replace every <i data-icon="name"></i> placeholder in the page with its SVG. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('i[data-icon]')) el.replaceWith(icon(el.dataset.icon));
}


/** A filled brand logo (Simple Icons): brandIcon('github'). */
export function brandIcon(name, { size = 18 } = {}) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', BRAND_PATHS[name] || '');
  svg.append(path);
  return svg;
}
