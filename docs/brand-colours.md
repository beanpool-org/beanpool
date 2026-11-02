# Brand colours

**Change a colour in `packages/beanpool-core/src/brand-colours.ts`, never in a screen.** That file is the one place
the phone, the web app and the manager take their brand and status colours from. Change a value there and every app
follows; a screen names a role (`colors.brand.fill`, `var(--bp-cta-fill)`), never a hex.

There are two sets, light and dark. The phone's old "Light Color Scheme" choice (Classic / Earth / Slate) is gone.

## The rule (option C, Marty 14 Oct 2026)

1. **Calls to action and commit buttons** (terracotta, emerald, red, orange): white words on a fill one step
   deeper than before. Hover (web) and pressed (phone) go darker, never lighter.
2. **Gold** (Vouch, Approve, rating): charcoal words on amber-500, amber-400 on hover. Never white words on gold.
3. **Small badges and chips** (the verified tick, Offer/Need, counts): dark ink on a pale tint in light, pale ink on a
   deep tint in dark.

Buttons keep the same deep fill in both themes; only inks and chips change with the theme.

**The accent is sage green.** Who decided what:

- Marty, 14 Oct 2026: the accent is sage, the web's nature-600, `#647664`, as the fill under white words in light.
- Built by #1904, then kept by Marty on 14 Oct 2026 after he saw it: in dark the accent is a light sage (nature-300,
  `#c0ccc0`) as both words and fill, with charcoal words on the fill, as gold has; pressing lightens it.
- #1904's own calls, which Marty has not been asked about: as words in light the accent is a half step deeper, `#5b6b5b`
  (between nature-600 and 700), because `#647664` reaches only 4.23:1 on the phone's sunken rows and 4.43 on the web's
  page; and the accent's border is `chip.accent.border` (nature-200 in light, nature-800 in dark).

- Director, 16 Oct 2026 (PR #1997, the web app opens dark): a sage **button with words** is `sage`, the accent's light
  values in both themes, so it is a deep button in dark as every other button is (the accent's light sage drew a light
  block on the dark page). The accent's light sage in dark stays for the send button, unread and count badges,
  progress and selected toggles.

On the phone, words and icons on `accent.fill` use `text.onAccent`, never `text.inverse` or white
(`accent-fill-words.test.ts` fails on any other).

## The bar

Every pair is at least **4.5:1** (WCAG 2.x AA for normal text), in both themes. Members read at 320 dp with text at
130 %, in the sun, where a button label is still "small" text; 3.0 is allowed only for a role listed in
`LARGE_TEXT_ROLES` (none today). `packages/beanpool-core/src/__tests__/brand-colours.test.ts` computes every pair and
fails below the bar: words on each fill and its hover, each chip's ink on its tint, and each ink on every page and
card of both apps (`INK_GROUNDS`; the test reads the web's three grounds per theme from `apps/pwa/src/index.css`, so
a new or changed web ground is judged too). In dark the web's `--bg-secondary` (`#384038`) is the hardest ground.

That test judges the library's own pairs. A screen can still set them wrong: the Save Profile button was `text.heading`
under `text.inverse`, the same `#ffffff` in dark, for two weeks. Two checks read the screens: `pwa_dark_classes` draws the
web app's class strings in dark, and `native_dark_contrast` (`apps/native/utils/button-contrast.ts`, run by
`scripts/test-all.sh`) reads the phone's `app/`, `components/` and `tools/`, pairs each piece of words with the background its own
screen sets behind it, and fails below the bar in light or dark, naming `file:line` and both colours. A fill under words
is `brand.fill` / `accent.fill` / `feedback.*.solid` with `text.onBrand` / `onAccent` / `onDanger` / `onGold`, never a
`text.*` token under `text.inverse`. A reviewed exception goes in `apps/native/utils/button-contrast-exceptions.ts` with a
reason and the two lines the report prints beside the colours (it excuses that pair, not the same colours elsewhere in the
file); one that excuses nothing fails. The report also says how much it could not read (a style table built in another file,
or handed to a child as a prop adds no colours), and the check fails when that number grows.

## The roles

Fill roles have `fill`, `hover` (pressed on the phone) and `on` (the words). The test checks that every row below
matches the file.

| role | light | dark |
|---|---|---|
| `cta.fill` | `#b85236` | `#b85236` |
| `cta.hover` | `#a3472e` | `#a3472e` |
| `cta.on` | `#ffffff` | `#ffffff` |
| `commit.fill` | `#047857` | `#047857` |
| `commit.hover` | `#065f46` | `#065f46` |
| `commit.on` | `#ffffff` | `#ffffff` |
| `action.fill` | `#c2410c` | `#c2410c` |
| `action.hover` | `#9a3412` | `#9a3412` |
| `action.on` | `#ffffff` | `#ffffff` |
| `danger.fill` | `#b91c1c` | `#b91c1c` |
| `danger.hover` | `#991b1b` | `#991b1b` |
| `danger.on` | `#ffffff` | `#ffffff` |
| `info.fill` | `#2563eb` | `#2563eb` |
| `info.hover` | `#1d4ed8` | `#1d4ed8` |
| `info.on` | `#ffffff` | `#ffffff` |
| `neutral.fill` | `#555555` | `#555555` |
| `neutral.hover` | `#333333` | `#333333` |
| `neutral.on` | `#ffffff` | `#ffffff` |
| `gold.fill` | `#f59e0b` | `#f59e0b` |
| `gold.hover` | `#fbbf24` | `#fbbf24` |
| `gold.on` | `#1d231d` | `#1d231d` |
| `accent.fill` | `#647664` | `#c0ccc0` |
| `accent.hover` | `#526052` | `#dce3dc` |
| `accent.on` | `#ffffff` | `#1d231d` |
| `sage.fill` | `#647664` | `#647664` |
| `sage.hover` | `#526052` | `#526052` |
| `sage.on` | `#ffffff` | `#ffffff` |
| `chip.ok.tint` | `#d1fae5` | `#022c22` |
| `chip.ok.ink` | `#065f46` | `#6ee7b7` |
| `chip.need.tint` | `#ffedd5` | `#7c2d12` |
| `chip.need.ink` | `#9a3412` | `#fdba74` |
| `chip.warn.tint` | `#fef3c7` | `#451a03` |
| `chip.warn.ink` | `#92400e` | `#fcd34d` |
| `chip.danger.tint` | `#fee2e2` | `#450a0a` |
| `chip.danger.ink` | `#b91c1c` | `#fca5a5` |
| `chip.accent.tint` | `#eef1ee` | `#384038` |
| `chip.accent.ink` | `#5b6b5b` | `#c0ccc0` |
| `chip.accent.border` | `#dce3dc` | `#434e43` |
| `deal.held.tint` | `#d1fae5` | `#022c22` |
| `deal.held.ink` | `#065f46` | `#6ee7b7` |
| `deal.held.border` | `#10b981` | `#34d399` |
| `deal.released.tint` | `#a7f3d0` | `#064e3b` |
| `deal.released.ink` | `#065f46` | `#6ee7b7` |
| `deal.released.border` | `#059669` | `#10b981` |
| `deal.cancelled.tint` | `#fee2e2` | `#450a0a` |
| `deal.cancelled.ink` | `#991b1b` | `#fca5a5` |
| `deal.cancelled.border` | `#ef4444` | `#f87171` |
| `tile.food.tint` | `#ffedd5` | `#431407` |
| `tile.food.ink` | `#9a3412` | `#fdba74` |
| `tile.services.tint` | `#dbeafe` | `#172554` |
| `tile.services.ink` | `#1e40af` | `#93c5fd` |
| `tile.labour.tint` | `#fef3c7` | `#451a03` |
| `tile.labour.ink` | `#92400e` | `#fcd34d` |
| `tile.tools.tint` | `#e7e5e4` | `#292524` |
| `tile.tools.ink` | `#292524` | `#d6d3d1` |
| `tile.goods.tint` | `#ebe6df` | `#5b5046` |
| `tile.goods.ink` | `#5b5046` | `#ebe6df` |
| `tile.garden.tint` | `#ecfccb` | `#1a2e05` |
| `tile.garden.ink` | `#3f6212` | `#bef264` |
| `tile.housing.tint` | `#fcedea` | `#3c180e` |
| `tile.housing.ink` | `#863b28` | `#f0bcab` |
| `tile.transport.tint` | `#cffafe` | `#083344` |
| `tile.transport.ink` | `#155e75` | `#67e8f9` |
| `tile.education.tint` | `#e0e7ff` | `#1e1b4b` |
| `tile.education.ink` | `#3730a3` | `#a5b4fc` |
| `tile.arts.tint` | `#fce7f3` | `#500724` |
| `tile.arts.ink` | `#9d174d` | `#f9a8d4` |
| `tile.health.tint` | `#ccfbf1` | `#042f2e` |
| `tile.health.ink` | `#115e59` | `#5eead4` |
| `tile.care.tint` | `#ffe4e6` | `#4c0519` |
| `tile.care.ink` | `#9f1239` | `#fda4af` |
| `tile.animals.tint` | `#d1fae5` | `#022c22` |
| `tile.animals.ink` | `#065f46` | `#6ee7b7` |
| `tile.tech.tint` | `#e0f2fe` | `#082f49` |
| `tile.tech.ink` | `#075985` | `#7dd3fc` |
| `tile.energy.tint` | `#fef9c3` | `#422006` |
| `tile.energy.ink` | `#854d0e` | `#fde047` |
| `tile.mindset.tint` | `#fae8ff` | `#4a044e` |
| `tile.mindset.ink` | `#86198f` | `#f0abfc` |
| `tile.general.tint` | `#eef1ee` | `#384038` |
| `tile.general.ink` | `#434e43` | `#c0ccc0` |
| `tile.event.tint` | `#ede9fe` | `#2e1065` |
| `tile.event.ink` | `#5b21b6` | `#c4b5fd` |
| `tile.pulse.tint` | `#fef3c7` | `#451a03` |
| `tile.pulse.ink` | `#92400e` | `#fcd34d` |
| `ink.brand` | `#047857` | `#34d399` |
| `ink.success` | `#047857` | `#34d399` |
| `ink.danger` | `#b91c1c` | `#fca5a5` |
| `ink.warning` | `#92400e` | `#fbbf24` |
| `ink.accent` | `#5b6b5b` | `#c0ccc0` |
| `ink.terra` | `#a3472e` | `#e5967f` |
| `ink.info` | `#2563eb` | `#93c5fd` |
| `map.ring` | `#92400e` | `#d4a24e` |

What each is for, and its ratios (the same in both themes for fills; lowest page or card for inks):

| role | used for | light | dark |
|---|---|---|---|
| `cta` | Start a community, + ADD POST, Save | 4.89 / hover 6.00 | same |
| `commit` | Accept, Send Beans, Message, Join; the phone's `brand.fill` | 5.48 / 7.68 | same |
| `action` | the phone's floating + button, the Need toggle | 5.18 / 7.31 | same |
| `danger` | Submit report, Remove, Delete, alert badges | 6.47 / 8.31 | same |
| `info` | the web's onboarding blue: Next, Join, Open, Install, Save my area | 5.17 / hover 6.70 | same |
| `neutral` | grey: a web button while it sends; the install banner's How? while open (hover) | 7.46 / hover 12.63 | same |
| `gold` | Vouch, Approve, rating (charcoal words) | 7.46 / 9.60 | same |
| `accent` | chat's send and unread badge, progress, selected toggles | 4.86 / hover 6.66 | 9.65 / 12.26 (charcoal words) |
| `sage` | the sage accent as a button with words (web: + Create Group, + Propose, + Propose Decision, Submit Decision) | 4.86 / hover 6.66 | same |
| `chip.ok` / `need` / `warn` / `danger` | verified tick and Offer (`ok`), Need, counts | 6.78 / 6.38 / 6.37 / 5.30 | 9.94 / 5.56 / 10.39 / 8.51 |
| `chip.accent` | a selected sage chip, the accent's pale ground | 4.99 | 6.45 |
| `deal.held` / `released` / `cancelled` | a trade's lines in a DM (held in trust, released, cancelled): the web lays the tint at 40 % over the chat (`DEAL_TINT_ALPHA`, drawn from the plain rgba variable `--bp-deal-<name>-wash`: no color-mix, which old Android WebViews drop), the phone at 70 %; light is the web as it was | 6.88 / 6.55 / 7.25 | 8.23 / 6.85 / 7.10 |
| `tile.<cat>` | category tiles: listings, events, Pulse; sticker outline and word in ink on tint | 6.31 – 12.08 | 6.31 – 11.19 |
| `ink.brand` | the brand green as words and icons | 4.77 | 5.58 |
| `ink.success` | success messages, ticks | 4.77 | 5.58 |
| `ink.danger` | errors, destructive links | 5.63 | 5.65 |
| `ink.warning` | gold as words: Action Required, tips, nudges | 6.17 | 6.42 |
| `ink.accent` | the sage accent as words and icons | 4.94 | 6.45 |
| `ink.terra` | terracotta as words: the manager's links, labels, hovered titles | 5.22 | 4.60 |
| `ink.info` | the onboarding blue as words, outlines, rings, progress (web only, judged on the web's grounds: `WEB_ONLY_INKS`) | 4.71 | 5.95 |
| `map.ring` | a community's area on a map, a thin dashed line and never words: judged at 3:1 on the map's own grounds (`MAP_GROUNDS`), and read with the map's theme, not the app's (`areaRingColour`); the web and the manager only have OSM's light map, so they draw the light one in both themes | 4.18 | 3.65 |

## Not covered (they keep their own hex)

The logo (an image), the phone's `GlobalHeader.tsx`, `Map.web.tsx` and `UnifiedMapPin.tsx`, the map style, pins and
markers in `map.tsx`, and the web map's pin colours in `MapPage.tsx`. Do not point them at these roles. (Marty pointed
five colour lines of `map.tsx` at the roles on 14 Oct: the Reach chooser and category chip take `brand.fill` and
`action.fab`, the required `*` and a missing field's border `feedback.danger.fg`. The same day he pointed one line of
`GlobalHeader.tsx` at gold: the Settings icon, while Settings is open, is `feedback.warning.solid`, the library's
`gold.fill`, 9.78:1 on the header's black scrim in both themes.)

## How each app uses it

- **Phone** (`apps/native`): `constants/colors.ts` imports `brandColours('light')` and `brandColours('dark')` from
  `@beanpool/core` and builds its tokens from them. A fill under words uses `brand.fill` / `text.onBrand`,
  `accent.fill` / `text.onAccent` (charcoal in dark), `feedback.danger.solid`, `action.fab`; words and icons use `brand.primary`,
  `accent.primary`, `feedback.*.fg` (`feedback.warning.fg` is `ink.warning`). The Offer and Need chips
  (`market.offer`, `market.need`) are `chip.ok` and `chip.need`. One token can no longer serve as both, because no single dark value reads as
  words on the page and under white words.
- **Manager** (`apps/manager`, dark only): `tailwind.config.js` imports `brandTailwindColours()` into its colours and puts
  `brandCssVariableMap('light')` / `('dark')` under `:root` / `:root.dark` with `addBase` (the same blocks
  `brandCssVariables()` writes), so no stylesheet is generated or committed. Buttons with words use a fill role
  (`bg-bp-danger-fill hover:bg-bp-danger-hover text-bp-danger-on`); badges, chips and the tinted buttons that look like
  them use a chip role (`bg-bp-chip-warn-tint text-bp-chip-warn-ink`; terracotta chips are `chip.need`). Terracotta words and icons are `text-bp-ink-terra`;
  status dots, meters, rings and deep tints keep the two shades the config defines (`terra-500`, `terra-600`), never
  another: Tailwind drops an undefined shade without a warning. `src/brand-roles-sources.test.ts` fails on a raw terracotta, emerald, red,
  rose, amber, orange, green or yellow shade on a control, and on a fill whose words are not its own `on`.
- **Web app** (next): generate a stylesheet from the same file and use the variables.

  ```js
  import { brandCssVariables, brandTailwindColours } from '@beanpool/core/brand-colours';
  // a build step writes this to src/brand-colours.css, imported first:
  brandCssVariables();                                        // :root { --bp-cta-fill: … }  :root.dark { … }
  // tailwind.config.js → theme.extend.colors:
  ...brandTailwindColours();                                  // bg-bp-cta-fill text-bp-cta-on hover:bg-bp-cta-hover
  ```

  The web app sets `dark` and `dark-theme` on `<html>`, the manager `dark`, so the default `:root.dark` serves both.
