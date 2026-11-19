/**
 * about.js (options) — the "About" tab: the author's card (photo, name, bio,
 * links) and the extension's card (version, source code, issues, licence, credits).
 *
 * To change the author's details, edit AUTHOR below (and images/author.png).
 */
import { h } from '../shared/dom.js';
import { icon, brandIcon } from '../shared/icons.js';
import { t, getLang, ltr } from '../shared/i18n.js';

export const REPO = 'https://github.com/mahm0udnasr/time-is-a-sword';

const AUTHOR = {
  name: { ar: 'محمود نصر', en: 'Mahmoud Nasr' },
  bio: {
    ar: 'طالب نظم معلومات الأعمال (BIS)، أنتقل من تطوير الويب إلى تعلّم الآلة والذكاء الاصطناعي، وأحلّ المسائل البرمجية بلغة C++.',
    en: 'BIS student, transitioning from web development to machine learning & AI. Problem solver in C++.'
  },
  location: { ar: 'مصر', en: 'Egypt' },
  photo: '../images/author.png',
  // [label, url, icon]: brand logos from Simple Icons; LinkedIn, Kaggle (wordmark-only
  // logo) and the website use Lucide icons.
  links: [
    ['about.website', 'https://mahm0udnasr.vercel.app/', { lucide: 'globe' }],
    ['GitHub', 'https://github.com/mahm0udnasr', { brand: 'github' }],
    ['LinkedIn', 'https://linkedin.com/in/mahm0udnasr', { lucide: 'briefcase-business' }],
    ['Telegram', 'https://t.me/mahm0udnasr', { brand: 'telegram' }],
    ['Kaggle', 'https://kaggle.com/mahm0udnasr', { lucide: 'trophy' }],
    ['Facebook', 'https://facebook.com/mhm0udnasr/', { brand: 'facebook' }]
  ]
};

/** Built when rendering, so the note is in the page's language. */
const credits = () => [
  ['Amiri', 'https://github.com/aliftype/amiri', 'OFL'],
  ['IBM Plex Sans Arabic', 'https://github.com/IBM/plex', 'OFL'],
  ['Lucide', 'https://lucide.dev', 'ISC'],
  ['Simple Icons', 'https://simpleicons.org', 'CC0'],
  ['Aladhan API', 'https://aladhan.com/prayer-times-api', t('about.prayerApi')]
];

/** An external link that opens in a new tab. */
const ext = (href, ...children) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, ...children);

function linkButton([label, url, ic]) {
  const text = label.startsWith('about.') ? t(label) : label;
  return ext(url, ic.brand ? brandIcon(ic.brand) : icon(ic.lucide), h('span', {}, text));
}

export function renderAbout() {
  const lang = getLang();
  const manifest = chrome.runtime.getManifest?.() || {};

  const author = h('section', { class: 'card about-author' },
    h('img', { class: 'about-photo', src: AUTHOR.photo, alt: AUTHOR.name[lang], width: '112', height: '112' }),
    h('div', { class: 'about-who' },
      h('p', { class: 'about-kicker' }, t('about.madeBy')),
      h('h2', { class: 'about-name' }, AUTHOR.name[lang]),
      h('p', { class: 'about-bio' }, AUTHOR.bio[lang].replace('C++', ltr('C++'))), // "C++" stays C++ inside Arabic
      h('p', { class: 'about-place muted small' }, icon('map-pin', { size: 15 }), AUTHOR.location[lang])),
    h('nav', { class: 'about-links', 'aria-label': t('about.linksLabel') }, AUTHOR.links.map(linkButton)));

  const extension = h('section', { class: 'card about-ext' },
    h('div', { class: 'about-ext-head' },
      h('img', { src: '../icons/icon.svg', alt: '', width: '44', height: '44' }),
      h('div', {},
        h('h2', {}, t('app.name')),
        h('p', { class: 'muted small' }, t('about.version', { v: manifest.version || '—' }), ' · ', t('about.license')))),
    h('p', { class: 'about-desc' }, t('about.desc')),
    h('div', { class: 'about-actions' },
      ext(REPO, icon('code-xml', { size: 16 }), h('span', {}, t('about.source'))),
      ext(`${REPO}/issues`, icon('bug', { size: 16 }), h('span', {}, t('about.issue'))),
      ext(`${REPO}/blob/main/LICENSE`, icon('scale', { size: 16 }), h('span', {}, 'MIT'))),
    h('h3', {}, t('about.credits')),
    h('ul', { class: 'about-credits' }, credits().map(([name, url, note]) =>
      h('li', {}, ext(url, name, icon('external-link', { size: 13 })), h('span', { class: 'muted small' }, note)))),
    h('p', { class: 'about-footer muted small' }, icon('heart', { size: 14 }), t('about.footer')));

  document.getElementById('about-content').replaceChildren(author, extension);
}
