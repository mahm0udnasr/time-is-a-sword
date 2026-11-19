# Development notes

Technical notes for contributors: how the extension works inside, where things live,
and how to test it. For what the extension does and how to install it, see the
[README](../README.md).

## Running it from source

1. Clone the repository.
2. Open `chrome://extensions` (Brave: `brave://extensions`, Edge: `edge://extensions`), turn on
   **Developer mode**, click **Load unpacked** and choose the repository folder.
3. After changing a file, press the reload ↻ icon on the extension's card.

No build step and no dependencies: plain JavaScript modules, HTML and CSS.

## Tests

`node tests/run.mjs` (Node 18+) runs the logic tests (domain matching, days and reset, time crediting, limits,
schedules, groups, heartbeat tracking, loosening detection, Arabic matching, warnings, pauses,
immediate changes, clean-up of old stored data) with a simulated `chrome` API.

## Permissions
| Permission | Why it is needed |
|---|---|
| `storage` | Saves your sites, settings, reminders and usage, locally. |
| `tabs` | Reads the URL of open tabs so tabs that are *already open* can be redirected when a rule starts applying, and redirects them to the blocked page. |
| `webNavigation` | Sees a navigation to a blocked site before the page loads, including in-app URL changes in single-page apps (WhatsApp, YouTube…). |
| `alarms` | A 30-second tick that saves running time, a one-shot alarm at the exact moment a budget runs out, and the daily reset. Needed because the background worker is shut down when idle. |
| `idle` | Fallback idle/lock detection for tabs whose page script is not running yet. |
| `scripting` + host access (`<all_urls>`) | Runs two small scripts **only on the sites in your list**, never on other sites: `content/activity.js` reports whether the page has focus, when you last scrolled/typed in it, and whether a video is playing (the OS-level focus and idle signals are unreliable on some systems, e.g. Linux Wayland or Flatpak browsers); `content/overlay.js` shows the "minutes left" warning. Host access is broad only because you can add any site; the scripts are registered just for listed domains. |

| `geolocation` | Only for **Use my location** in the Salah First tab, and only when you press it. Chrome doesn't let extensions request location access at runtime, so it is declared here; the position is rounded to about 1 km and used only to get prayer times. |

`web_accessible_resources` exposes only the warning card's stylesheet (`content/overlay.css`),
so the card can load it inside listed sites.

## Project layout
```
manifest.json
background/
  service-worker.js   event wiring only: browser events → enforcer / tracker / prayer
  enforcer.js         redirects tabs that aren't allowed right now (prayer lock or site rules)
  tracker.js          active-time tracking, warnings, pauses, alarms, popup status
  rules.js            pure logic: domain matching, days and reset hour, allowed or not
  prayer.js           Salah First: prayer times (Aladhan), time zones, lock windows, alarms
  loosen.js           pure logic: which changes make the rules looser
  changes.js          applies confirmed site/group changes
  content-scripts.js  registers the page scripts on listed sites only
  storage.js          storage shape, defaults, first-install clean-up, reminder picker
content/
  activity.js         page heartbeat: focus, last input, media playing
  overlay.js/.css     the "N minutes left" card (follows theme and language)
blocked/              the page shown instead of a blocked site: the reminder + a pause link;
                      returns to the site by itself once it is allowed again
popup/                toolbar popup: this site (time left, pause), today's usage
options/
  options.js          settings page: tabs, overview, sites, groups, theme/language, pause requests
  rule-editor.js      the shared rules editor
  commit.js           every change goes through here (stricter now / looser → friction)
  friction.js         countdown + type-the-reminder dialog
  chart.js            7-day SVG bar chart
  prayer.js           the Salah First tab
  about.js            the About tab (author card, links, credits)
shared/
  base.css            colour tokens (light + dark), fonts, base controls
  ui.css              components shared by the settings page, popup and blocked page
  i18n.js             every interface string in Arabic (default) and English, t(), RTL helpers
  theme.js            applies the System / Light / Dark choice to every page
  format.js           duration / time / day formatting
  arabic.js           Arabic normalization for the typing check
  poetry.js           verse layout (two offset lines per verse) + kashida justification
  pause-flow.js       the pause steps (check → confirmation → grant)
  icons.js, dom.js    inline icon helper, tiny element builder
data/
  quotes.json         the reminders (edit this file to change them)
  salah.json          hadiths about salah, shown during prayer locks
fonts/                Amiri + IBM Plex Sans Arabic (SIL Open Font License)
icons/                icon.svg + PNGs; icons/original/ = the first colour version
images/author.png     the author's photo (About tab)
vendor/               Lucide (ISC) and Simple Icons (CC0): only the icons used, with licences
tests/                `node tests/run.mjs` (plain Node, not part of the extension)
docs/                 these notes and the README screenshots
```

## Data model
All in `chrome.storage.local`:

- `settings` — only `{ theme }` (System / Light / Dark). All other settings are the fixed
  `DEFAULT_SETTINGS` in `background/storage.js`.
- `sites` — `[{ id, domain, enabled, groupId, rules: [{ days, mode, limitMinutes, windows }] }]`
  The first rule whose `days` (0 = Sunday) contains today applies; no matching rule = unrestricted today.
  `mode` is `block`, `limit`, `schedule` or `limit+schedule`.
- `groups` — `[{ id, name, enabled, rules }]`. A site joins a group through its `groupId`.
  A member site must satisfy both its own rule and the group's (the stricter wins). The
  group's budget is the *combined* time of its members. A switched-off site is fully
  unrestricted and does not count toward its group.
- Time windows are `"HH:MM"` local time. A window whose end is earlier than its start crosses
  midnight (`22:00`–`01:00`); an end of `00:00` means midnight. The day's rule is picked by the
  logical day (it starts at the reset hour); windows use the wall clock.
- `lastQuoteId` — so the same reminder never shows twice in a row. The reminders themselves
  are `data/quotes.json` (`[{ text, source, type }]`), not stored.
- `usage` — `{ "2026-11-18": { seconds: { "youtube.com": 742.5 }, warned: {}, pausesUsed: 0 } }`.
  The key is the *logical* day (it starts at the reset hour). Only the last 7 days are kept.
- `session` — `{ domain, tabId, windowId, since, lastFlush }` or `null`: what is being timed right now.
- `usage[day].warned` — which warnings were already shown (per site, per window end), so each fires once.
- `pauses` — `{ "youtube.com": { until } }`: a paused site is allowed until then (its time still counts).

**What counts as looser** (needs the friction step): switching a site or group off, removing
a site or group that restricts something, a site leaving a group, and for any day of the week:
a rule removed, "always blocked" relaxed, a limit raised or removed, allowed hours widened or
removed. Everything else (adding sites, lowering limits, narrowing hours, switching on,
joining a group) applies at once. One save that
mixes both applies the stricter entities now and queues the looser ones.

**How time is counted:** time counts only while a listed site is the active tab and its
page has focus, and you have used the page (mouse, keyboard, scroll, touch) in the last
60 s, or a video/audio is playing in it. These signals come from the page itself
(`content/activity.js`, a heartbeat every 10 s, kept in `chrome.storage.session` as
`activity`). For a tab whose page script is not running yet, the browser's window-focus
and `chrome.idle` signals are used instead. On every
tab/window/idle event and every 30 s, the worker adds `now − lastFlush` to today's usage.
One flush credits at most 75 s, so laptop sleep or a frozen browser never adds phantom
time. A flush that spans the reset hour is split between the two days. Only one session
exists at a time, so a site open in many tabs is counted once. After a browser restart
the leftover session is discarded, not credited.

**Domain matching:** a host matches a site when it equals the domain or ends with
`"." + domain`, so `x.com` matches `mobile.x.com` but never `box.com`. If two sites
match (`whatsapp.com` and `web.whatsapp.com`), the longer one wins. A leading `www.`
is ignored.

## Defaults
Not editable in the UI; change them in the project files and reload the extension.

| What | Default | Where |
|---|---|---|
| New day (daily reset) | 00:00 | `DEFAULT_SETTINGS.resetHour` in `background/storage.js` |
| Warnings | 5 and 1 minutes left | `warningMinutes` |
| Idle after | 60 s without input | `idleThresholdSec` |
| Looser changes | apply as soon as the confirmation step is passed | `options/commit.js` |
| Confirmation countdown | 30 s | `friction.countdownSec` |
| Pauses | 3 per day, 5 min each (5 max) | `pause.maxPerDay`, `pause.maxMinutes` |
| Reminders | the built-in list | `data/quotes.json` |

When upgrading from an older version, previously saved settings and reminders are discarded on
the first start (only the theme is kept). Looser changes that were still waiting for the next
day are applied right away, since they were already confirmed.

## Language
The interface is **Arabic by default**, laid out right to left, with the bundled IBM Plex Sans
Arabic font. The language button (*EN* in Arabic, *ع* in English, beside the theme switch) at the bottom of the settings sidebar,
or the small one in the popup header, switches every page at once: settings, popup, the
confirmation dialog, the warning card and the blocked page's tab title. The choice is stored in
`settings.lang` next to the theme; it is appearance only, so it never needs confirmation.

All strings live in `shared/i18n.js` (`t('key', { params })`); static page text uses
`data-i18n` attributes. Not `chrome.i18n`, because that follows the browser's language and
can't be switched with a button. Numbers use Western digits in both languages; times like
`13:00–13:30` and domains are wrapped in direction-isolation marks so they never come out
reversed inside Arabic text. Reminders are always shown in Arabic.

## Salah First (الصلاة أولًا)
A tab in the settings page. Press **Use my location** (or type your city), pick the calculation
method and the Asr school, and turn it on. For every prayer you leave switched on, **every website** (not only listed
sites) closes from *N* minutes before the prayer (default 5) until *M* minutes after it
(default 15). Open tabs go to the blocked page, which shows a hadith about salah from
`data/salah.json` under a small line like "حان وقت صلاة الظهر · 11:40", and they return by
themselves when the lock ends. Each prayer can be switched off or moved ± up to 60 minutes.

- **Location:** press **Use my location** (the browser's position, read only when you press it,
  rounded to 2 decimals ≈ 1 km) or type a city. Some browsers have location services off
  (e.g. some Brave/Linux setups); then the page says so and you type the city instead.
- **Times** come from the Aladhan API (`/v1/timings/{DD-MM-YYYY}?latitude&longitude` or
  `/v1/timingsByAddress/{DD-MM-YYYY}?address`). **Only the rounded coordinates or the city you
  typed are sent.** Times are in the city's own time zone and are
  converted with it, so they are right even if the computer's clock is set to another zone.
- Today's and tomorrow's times are cached; the worker refreshes them every 2 hours if they are
  missing or older than 12 hours, and right away when the city or method changes. Offline, a
  cached day's times stand in (shown with ≈) so locking keeps working.
- An exact alarm fires at every lock start and end; the 30-second tick is a safety net.
- **Anti-cheat:** setting it up while it is off is free. Once on, anything that weakens it
  (switching it off, turning off a prayer, fewer minutes, changing the city/method or a
  prayer's time) needs the countdown + typed reminder, like site rules.
- Storage: `prayer` (settings) and `prayerTimes` (cache); code in `background/prayer.js`
  (logic, fetch, alarms) and `options/prayer.js` (the tab).

## Blocked page
Shows one reminder from `data/quotes.json` (text and source) and, under it, one quiet link:
**Pause for 5 min · N left**. It opens the same confirmation step (30-second countdown + typing
a reminder) right on the page; once confirmed, the tab goes back to the site. The link only
appears for a site blocked by its own rules while pauses are left today: never during a prayer
lock, which a pause doesn't lift. No site name, reason or other buttons. Reminders with `"type": "poetry"` are laid out as verse: each
verse on two lines, the first half (صدر) starting at the right and the second (عجز) ending at
the left. In the file, separate the two halves with ` ... ` and verses with a new line (`\n`). The
confirmation dialog shows poetry the same way; when typing it, the ` ... ` is not needed: the
two halves can be typed on one line or two.

Every half of a poem is stretched with kashida (tatweel, `ـ`) to the same width, about 15%
wider than its longest half (never wider than the screen), like a printed diwan: الحــفــر.
Browsers cannot do kashida justification themselves, so `shared/poetry.js` measures each half
and inserts tatweels in pairs at the joins between connected letters, starting from the end
of each word. It never splits the لا ligature, never stretches right after the article ال,
puts at most 4 at one join, and re-justifies when the window is resized. The typing check
ignores tatweel, so you never have to type them. It goes back to the site by itself as soon as the site is allowed
again: when a pause starts, when its next allowed hours begin, at the daily reset, or when a
looser change takes effect. Opening the popup on it still shows the site, why it is blocked
and when it opens.

## Settings page
Sidebar tabs: **Overview** (today's stats and usage, 7-day chart), **Sites** (add, search,
switch, edit, remove) and **Groups**. On narrow screens the sidebar becomes a top bar with a
menu button (☰) that slides in a drawer with the tabs, theme and language; picking a tab,
tapping outside or pressing Esc closes it.
The System / Light / Dark switch at the bottom of the
sidebar applies to the popup and the blocked page too; it is appearance only, so it never needs
confirmation. Arrow keys move between tabs; the URL keeps the tab (`options.html#sites`).

## Troubleshooting
**Time is not counted.** Open `chrome://extensions` (or `brave://extensions`) → this
extension → *Service worker* → Console, type `await slDebug()` and press Enter, then switch
to the site's tab within 5 seconds and use it. The table shows what the tracker sees:

- `pageHeartbeat` empty → the page script isn't running there: reload that tab.
- `pageHeartbeat.focused: false` → the page doesn't have focus (click inside the page).
- `trackingTarget` = the site → it is being counted; `today` shows the seconds.
- `windowFocused` / `idleState` are the OS signals; on Linux Wayland/Flatpak they may be
  wrong, which is fine as long as the page heartbeat is present.
