# Chrome Web Store listing kit

Everything to paste into the [Developer Dashboard](https://chrome.google.com/webstore/devconsole).
Build the upload with `node tools/package.mjs` → `dist/time-is-a-sword-<version>.zip`.

---

## 1. Package

Upload `dist/time-is-a-sword-1.0.0.zip`. Each later upload needs a higher `version` in `manifest.json`.

## 2. Store listing tab

**Default language:** Arabic. Then add **English** under "Add a language" with the English texts below.

**Category:** Productivity → Workflow & Planning (or Tools)

### Summary (shown under the name; it comes from the manifest, max 132 characters)

- ar: يحجب المواقع المشتّتة أو يحدّ وقتها، ويذكّرك بقيمة الوقت.
- en: Blocks or time-limits distracting sites, closes websites at prayer time, and reminds you of the value of time.

### Description — Arabic

```
الوقت سيف: إضافة تحمي وقتك من المواقع المشتّتة.

«نعمتان مغبون فيهما كثير من الناس: الصحة والفراغ» — رواه البخاري

ضع لكل موقع قاعدته، وتحسب الإضافة وقتك الفعلي بدقة، وحين ينتهي الوقت تُغلق الموقع وتعرض لك حديثًا أو أثرًا أو بيت شعر عن قيمة الوقت.

المميزات:
• قواعد لكل موقع: حجب دائم، أو حدّ يومي بالدقائق، أو ساعات مسموحة فقط، أو الاثنان معًا، ولكل يوم من أيام الأسبوع قاعدته.
• المجموعات: مواقع تتشارك وقتًا واحدًا، فلا تكسب وقتًا إضافيًا بالتنقّل بينها.
• حساب دقيق: يُحسب الوقت فقط حين تكون الصفحة أمامك وتستخدمها، ولا يُحسب مرتين في عدة تبويبات.
• الصلاة أولًا: قبل كل صلاة بخمس دقائق تُغلق كل المواقع ويظهر حديث عن الصلاة، وتُفتح بعدها بربع ساعة. المواقيت حسب مدينتك أو موقعك، وكل ذلك قابل للتعديل.
• حاجز ضد التحايل: أي تخفيف للقواعد يحتاج عدًّا تنازليًا 30 ثانية وكتابة تذكير كما هو، دون نسخ ولصق.
• إيقاف مؤقت محدود: 5 دقائق، 3 مرات في اليوم.
• تنبيهات قبل انتهاء الوقت بخمس دقائق ثم دقيقة.
• واجهة عربية أولًا مع الإنجليزية، ووضع فاتح وداكن.

الخصوصية:
كل بياناتك تبقى على جهازك: لا خوادم ولا تحليلات ولا حسابات. الاستثناء الوحيد: «الصلاة أولًا» ترسل اسم مدينتك أو موقعك التقريبي إلى api.aladhan.com لجلب المواقيت.

مفتوح المصدر (MIT): https://github.com/mahm0udnasr/time-is-a-sword
```

### Description — English

```
Time Is a Sword (الوقت سيف): guard your time from distracting websites.

"There are two blessings in which many people are deceived: health and free time." — Sahih al-Bukhari

Give each site its own rule. The extension measures the time you actually spend, and when time is up it closes the site and shows a hadith, a saying of the salaf or a line of poetry about the value of time.

Features:
• Per-site rules: always blocked, a daily limit in minutes, allowed hours only, or both, with a different rule per weekday if you like.
• Groups: sites that share one budget, so switching between them doesn't buy extra time.
• Accurate tracking: time counts only while the page is in front of you and in use, and never twice across tabs.
• Salah First: five minutes before each prayer every website closes and a hadith about salah appears; they reopen fifteen minutes after. Times follow your city or location, and everything is adjustable.
• Anti-cheat: loosening a rule needs a 30-second countdown and typing a reminder exactly, with copy and paste disabled.
• Limited pauses: 5 minutes, 3 times a day.
• Warnings at 5 minutes and 1 minute left.
• Arabic-first interface with English; light and dark themes.

Privacy:
Everything stays on your device: no servers, no analytics, no accounts. The one exception: Salah First sends your city or approximate location to api.aladhan.com to get prayer times.

Open source (MIT): https://github.com/mahm0udnasr/time-is-a-sword
```

### Graphics

| Field | File |
|---|---|
| Store icon (128×128) | `icons/icon128.png` |
| Screenshots, Arabic listing (1280×800) | `store/screenshots/ar/1-…5-*.png` (upload in order) |
| Screenshots, English listing (1280×800) | `store/screenshots/en/1-…5-*.png` |
| Small promo tile (440×280) | `store/promo-small-440x280.png` |
| Marquee promo tile (1400×560), optional | `store/promo-marquee-1400x560.png` |

### Links

- **Homepage URL:** https://github.com/mahm0udnasr/time-is-a-sword
- **Support URL:** https://github.com/mahm0udnasr/time-is-a-sword/issues

---

## 3. Privacy practices tab

### Single purpose

```
Helps the user limit time on distracting websites: it blocks or time-limits the sites the user chooses, and closes websites during prayer times, showing a reminder about the value of time.
```

### Permission justifications

**storage**
```
Saves the user's sites, groups, rules, daily usage totals and settings locally in chrome.storage.local. Nothing is sent to any server.
```

**tabs**
```
Needed to know which site the active tab is on, so time is counted for the right site, and to redirect a tab to the extension's reminder page when that site is blocked or its daily limit is reached.
```

**webNavigation**
```
Used to catch navigation to a blocked site (including in-page/single-page-app navigation) before it loads, and redirect it to the extension's reminder page.
```

**alarms**
```
Schedules the moments the extension must act: saving usage every 30 seconds, the exact time a daily limit runs out, the start and end of each prayer-time lock, warnings before time runs out, and the daily reset at midnight.
```

**idle**
```
Stops counting time when the user is away from the computer, so the daily limits measure real use only.
```

**scripting**
```
Registers a small content script only on the domains the user has added to their list (and injects it into tabs already open on those domains). It reports whether the page is visible and in use (or playing video) so time is measured accurately, and shows a small warning card when 1 or 5 minutes are left. It does not read page content.
```

**geolocation**
```
Used only when the user presses "Use my location" in the Salah First settings, to find their approximate coordinates (rounded to about 1 km) and fetch local prayer times. Never read in the background.
```

**Host permission (<all_urls>)**
```
The sites to limit are chosen by the user at run time, so they cannot be listed in advance. Host access lets the extension (1) register its time-tracking script on exactly the domains the user adds, and (2) during the user's prayer-time lock, redirect any website to the reminder page, as the user configured. Page content is never read, collected or transmitted. The only network request the extension makes is to api.aladhan.com for prayer times.
```

**Remote code:** No, I am not using remote code. *(All JavaScript ships in the package; the Aladhan API returns JSON data only.)*

### Data usage

Tick only:
- **Location** (approximate coordinates or city, for Salah First prayer times).

Leave everything else unticked: no personally identifiable information, health, financial, authentication, personal communications, web history, user activity or website content is collected. *(Usage minutes stay on the device and are never collected.)*

Tick all three certifications:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

### Privacy policy URL

```
https://github.com/mahm0udnasr/time-is-a-sword/blob/main/PRIVACY.md
```

---

## 4. Distribution tab

- **Visibility:** Public
- **Regions:** All regions
- **Pricing:** Free

Then **Submit for review**. Broad host access usually means a longer review (often a few days, sometimes more).

---

## Microsoft Edge Add-ons (optional, free)

[partner.microsoft.com/dashboard/microsoftedge](https://partner.microsoft.com/dashboard/microsoftedge): upload the same ZIP and reuse the texts, images and privacy policy URL above.
