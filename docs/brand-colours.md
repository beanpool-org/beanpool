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

On the phone, words and icons on `accent.fill` use `text.onAccent`, never `text.inverse` or white
(`accent-fill-words.test.ts` fails on any other).

## The bar

Every pair is at least **4.5:1** (WCAG 2.x AA for normal text), in both themes. Members read at 320 dp with text at
130 %, in the sun, where a button label is still "small" text; 3.0 is allowed only for a role listed in
`LARGE_TEXT_ROLES` (none today). `packages/beanpool-core/src/__tests__/brand-colours.test.ts` computes every pair and
fails below the bar: words on each fill and its hover, each chip's ink on its tint, and each ink on every page and
card of both apps (`INK_GROUNDS`; the test reads the web's three grounds per theme from `apps/pwa/src/index.css`, so
a new or changed web ground is judged too). In dark the web's `--bg-secondary` (`#384038`) is the hardest ground.

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
| `ink.brand` | `#047857` | `#34d399` |
| `ink.success` | `#047857` | `#34d399` |
| `ink.danger` | `#b91c1c` | `#fca5a5` |
| `ink.warning` | `#92400e` | `#fbbf24` |
| `ink.accent` | `#5b6b5b` | `#c0ccc0` |
| `ink.terra` | `#a3472e` | `#e5967f` |
| `ink.info` | `#2563eb` | `#93c5fd` |

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
| `chip.ok` / `need` / `warn` / `danger` | verified tick and Offer (`ok`), Need, counts | 6.78 / 6.38 / 6.37 / 5.30 | 9.94 / 5.56 / 10.39 / 8.51 |
| `chip.accent` | a selected sage chip, the accent's pale ground | 4.99 | 6.45 |
| `ink.brand` | the brand green as words and icons | 4.77 | 5.58 |
| `ink.success` | success messages, ticks | 4.77 | 5.58 |
| `ink.danger` | errors, destructive links | 5.63 | 5.65 |
| `ink.warning` | gold as words: Action Required, tips, nudges | 6.17 | 6.42 |
| `ink.accent` | the sage accent as words and icons | 4.94 | 6.45 |
| `ink.terra` | terracotta as words: the manager's links, labels, hovered titles | 5.22 | 4.60 |
| `ink.info` | the onboarding blue as words, outlines, rings, progress (web only, judged on the web's grounds: `WEB_ONLY_INKS`) | 4.71 | 5.95 |

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
