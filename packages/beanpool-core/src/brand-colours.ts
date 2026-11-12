/**
 * BeanPool's brand colours: the one place the phone, the web app and the manager take them from.
 *
 *     CHANGE A VALUE HERE, NEVER IN A SCREEN.
 *
 * Every app follows this file: the phone imports it in apps/native/constants/colors.ts, and the web app and the
 * manager turn it into CSS custom properties with `brandCssVariables()` below. A screen that paints a brand or
 * status colour names a role (the phone's `colors.brand.fill`, the web's `var(--bp-cta-fill)`), never a hex.
 *
 * The values are option C of the light-mode brand pass (Marty, 14 Oct 2026; scratch/global-node/
 * DESIGN-light-brand-pass-fable.md §2), a rule by role:
 *   1. Calls to action and commit buttons (terracotta, emerald, red, orange) are WHITE words on a fill one step deeper
 *      than before, and "hover"/pressed goes darker still, never lighter.
 *   2. Gold (Vouch, Approve, rating) is CHARCOAL words on amber-500, amber-400 when hovered/pressed: bronze stops
 *      reading as gold.
 *   3. Small badges and chips (the verified tick, Offer/Need, counts) are dark ink on a pale tint in light, and a pale
 *      ink on a deep tint in dark.
 * Buttons keep the same deep fill in both themes; only the inks and the chips change with the theme.
 *
 * The accent is sage green. Marty, 14 Oct 2026: the web's nature-600, white words on #647664 in light. Built by #1904
 * and kept by Marty the same day: in dark a light sage (nature-300) with charcoal words, as gold is, so it reads on
 * the near-black pages as words and as a fill. #1904's own calls: as words in light a half step deeper (#5b6b5b),
 * because #647664 is only 4.23:1 on the phone's sunken row and the web's oat page; the border, chip.accent.border.
 *
 * Every words-on-fill pair, and every ink on every page or card it can sit on in either app, is at least 4.5:1 (WCAG
 * 2.x AA for normal text; the audience reads at 320 dp with 130 % text, where a button label is still "small").
 * `__tests__/brand-colours.test.ts` computes them all and fails below the bar. A role may drop to 3.0 only if it is
 * listed in LARGE_TEXT_ROLES, which is empty.
 *
 * Not here on purpose: the logo (an image), the phone's GlobalHeader and map pins, and the web map's pin colours,
 * which keep their own hex and are not re-coloured by this file.
 *
 * SETS (DESIGN-themes-fable.md, with Marty and Damo's decisions of 12 Nov 2026). A set is one complete column of values:
 *   `light`  BeanPool Classic in light. Members see it as "Light".
 *   `dark`   BeanPool Classic in dark: the olive pages and the green doodle. Members see it as "Classic", and it is the
 *            default on both apps (DEFAULT_BRAND_SET; the phone still opens Light until the picker, slice T3, moves it).
 *   `night`  charcoal and bright blue, always dark. Members see it as "Dark".
 * So the word "dark" in code is Classic's dark column, as it always was; the look a member calls Dark is `night`. Each set
 * has a scheme (`light` or `dark`, BrandTheme): `night` is dark, so everything that asks "is it dark?" keeps asking that.
 * A set changes the hue of a colour, never how light or dark it is (the tests hold it), and only the sage accent family,
 * the own chat bubble and the grey base may change at all: green stays money and yes, red danger, gold Vouch, orange Need,
 * violet events, in every set.
 *
 * Pure: no I/O, no Node built-ins, no regular expressions (the barrel is bundled for the phone,
 * barrel-is-universal.test.ts).
 */

/** A scheme: light or dark. Every set is one of the two (brandScheme). */
export type BrandTheme = 'light' | 'dark';

/** A complete column of colours: `light` and `dark` are BeanPool Classic ("Light", "Classic"); `night` is "Dark". */
export type BrandSet = BrandTheme | 'night';

/** Every set, in the order the docs and the tests list them. */
export const BRAND_SETS: readonly BrandSet[] = ['light', 'dark', 'night'];

/** The set both apps open in (Marty and Damo, 12 Nov 2026): BeanPool Classic, the code's `dark`. */
export const DEFAULT_BRAND_SET: BrandSet = 'dark';

/** A set's scheme: whether it is a light or a dark look. `night` is always dark. */
export function brandScheme(set: BrandSet): BrandTheme {
    return set === 'light' ? 'light' : 'dark';
}

/**
 * One colour as each set draws it. `light` and `dark` are always given; a set with no value of its own (`night`) takes its
 * scheme's. Only the leaves the tests list may carry a `night` value.
 */
export interface Themed {
    readonly light: string;
    readonly dark: string;
    readonly night?: string;
}

/** The sets beyond Classic's two, where a leaf has its own value. */
type SetValues = { readonly night?: string };

const same = (hex: string, sets: SetValues = {}): Themed => ({ light: hex, dark: hex, ...sets });
const themed = (light: string, dark: string, sets: SetValues = {}): Themed => ({ light, dark, ...sets });

/** A leaf's value in one set: its own, or its scheme's. */
export function colourIn(colour: Themed, set: BrandSet): string {
    return set === 'night' ? (colour.night ?? colour.dark) : colour[set];
}

// Tailwind's steps, named so a reader can place each value. terra-600′ is the brand terracotta deepened 4 %.
const WHITE = '#ffffff';
const CHARCOAL = '#1d231d'; // nature-950, the brand charcoal
const TERRA_600_DEEP = '#b85236';
const TERRA_700 = '#a3472e';
const TERRA_400 = '#e5967f'; // the web's terra-400
const EMERALD_100 = '#d1fae5';
const EMERALD_200 = '#a7f3d0';
const EMERALD_300 = '#6ee7b7';
const EMERALD_400 = '#34d399';
const EMERALD_500 = '#10b981';
const EMERALD_600 = '#059669';
const EMERALD_700 = '#047857';
const EMERALD_800 = '#065f46';
const EMERALD_900 = '#064e3b';
const EMERALD_950 = '#022c22';
const AMBER_100 = '#fef3c7';
const AMBER_300 = '#fcd34d';
const AMBER_400 = '#fbbf24';
const AMBER_500 = '#f59e0b';
const AMBER_800 = '#92400e';
const AMBER_950 = '#451a03';
const ORANGE_100 = '#ffedd5';
const ORANGE_300 = '#fdba74';
const ORANGE_700 = '#c2410c';
const ORANGE_800 = '#9a3412';
const ORANGE_900 = '#7c2d12';
const RED_100 = '#fee2e2';
const RED_300 = '#fca5a5';
const RED_400 = '#f87171';
const RED_500 = '#ef4444';
const RED_700 = '#b91c1c';
const RED_800 = '#991b1b';
const RED_950 = '#450a0a';
const GREY_555 = '#555555';
const GREY_333 = '#333333';
const BLUE_300 = '#93c5fd';
const BLUE_600 = '#2563eb';
const BLUE_700 = '#1d4ed8';
const VIOLET_300 = '#c4b5fd';
const VIOLET_700 = '#6d28d9';
const VIOLET_800 = '#5b21b6';
// The web's sage scale (tailwind `nature`). sage-650 sits halfway between nature-600 and 700.
const NATURE_100 = '#eef1ee';
const NATURE_200 = '#dce3dc';
const NATURE_300 = '#c0ccc0';
const NATURE_600 = '#647664';
const SAGE_650 = '#5b6b5b';
const NATURE_700 = '#526052';
const NATURE_800 = '#434e43';
const NATURE_900 = '#384038';
// Dark (`night`, DESIGN-themes-fable.md §3.2): the bright blue accent, its deep button blue, and the charcoal greys, each
// as light as the Classic grey it stands in for.
const NIGHT_BLUE = '#4cc2ff';
const NIGHT_300 = '#c5c9d1';
const NIGHT_800 = '#474b55';
const NIGHT_900 = '#3a3e46';
const NIGHT_950 = '#202126';

/** A filled control: words (`on`) on a `fill`, and the darker `hover` (web) / pressed (phone) fill. */
export interface FillRole {
    readonly fill: Themed;
    readonly hover: Themed;
    readonly on: Themed;
}

/** A small badge or chip: `ink` on a pale (light) or deep (dark) `tint`, and an outline where it has one. */
export interface ChipRole {
    readonly tint: Themed;
    readonly ink: Themed;
    readonly border?: Themed;
}

/** A category tile: `ink` words and icon outline on a pale (light) or deep (dark) `tint`. */
export interface TileRole {
    readonly tint: Themed;
    readonly ink: Themed;
}

/** A card caption band: `ink` words and "…" on a pale (light) or deep (dark) `tint`. */
export interface CardRole {
    readonly tint: Themed;
    readonly ink: Themed;
}

/**
 * The roles. Keys are lowercase single words so the CSS names below are the path joined by dashes
 * (`chip.ok.ink` → `--bp-chip-ok-ink`).
 */
export const BRAND_COLOURS = {
    /** Calls to action: Start a community, + ADD POST, Save. */
    cta: { fill: same(TERRA_600_DEEP), hover: same(TERRA_700), on: same(WHITE) },
    /** Commit buttons and the brand's own fill: Accept, Send Beans, Message, Join; the phone's `brand.fill`. */
    commit: { fill: same(EMERALD_700), hover: same(EMERALD_800), on: same(WHITE) },
    /**
     * An event's answer: the chosen Going / Interested, Edit event, Let in ✓ (DESIGN-detail-pages-fable.md §2.7, Marty 4 Nov 2026:
     * "all Fable's picks"). One deep violet fill in both themes under white words, as `commit` is one deep green; `ink.event` is
     * the same violet as words. The two event pages still draw the raw #7c3aed / violet-* classes; they move to this role in
     * the detail-pages slices (DP1 / DW1), not here.
     */
    event: { fill: same(VIOLET_700), hover: same(VIOLET_800), on: same(WHITE) },
    /** The orange action: the phone's floating + button, the Need toggle. */
    action: { fill: same(ORANGE_700), hover: same(ORANGE_800), on: same(WHITE) },
    /** Destructive: Submit report, Remove, Delete; alert badges. */
    danger: { fill: same(RED_700), hover: same(RED_800), on: same(WHITE) },
    /**
     * The web's onboarding blue: Next, Join, Open, Install, Save my area. #2563eb in both themes (white words 5.17), as
     * the web app has always drawn it in light (Marty/Damo 13 Oct: light unchanged unless contrast needs it).
     */
    info: { fill: same(BLUE_600), hover: same(BLUE_700), on: same(WHITE) },
    /** Grey under white words: a web button while it sends (fill), the install banner's How? while its steps show (hover). */
    neutral: { fill: same(GREY_555), hover: same(GREY_333), on: same(WHITE) },
    /** Gold: Vouch, Approve, rating. Charcoal words, never white. */
    gold: { fill: same(AMBER_500), hover: same(AMBER_400), on: same(CHARCOAL) },
    /**
     * The sage accent as a fill: chat's unread badge and send button, progress bars, selected toggles. White words on
     * nature-600 in light; charcoal words on a light sage in dark (pressed goes lighter there, as gold does). Dark
     * (`night`): the bright blue under near-black words, pressing lighter, as Classic's dark does.
     */
    accent: {
        fill: themed(NATURE_600, NATURE_300, { night: NIGHT_BLUE }),
        hover: themed(NATURE_700, NATURE_200, { night: '#8ad8ff' }),
        on: themed(WHITE, CHARCOAL, { night: '#0e1620' }),
    },
    /**
     * The sage accent as a button with words: the web's + Create Group, + Propose, Submit Decision. Light is the accent's
     * own (white words on nature-600); dark keeps that deep fill, as every other button does, where the accent's light
     * sage drew a light block on the dark page (director, 16 Oct 2026, PR #1997: the web app now opens dark). Dark
     * (`night`): a deep blue under the same white words, pressing deeper.
     */
    sage: { fill: same(NATURE_600, { night: '#0f73c6' }), hover: same(NATURE_700, { night: '#0c5ea2' }), on: same(WHITE) },
    /** Small badges and chips. `ok` is also the Offer chip, `need` the Need chip, `accent` a selected sage chip. */
    chip: {
        ok: { tint: themed(EMERALD_100, EMERALD_950), ink: themed(EMERALD_800, EMERALD_300) },
        need: { tint: themed(ORANGE_100, ORANGE_900), ink: themed(ORANGE_800, ORANGE_300) },
        warn: { tint: themed(AMBER_100, AMBER_950), ink: themed(AMBER_800, AMBER_300) },
        danger: { tint: themed(RED_100, RED_950), ink: themed(RED_700, RED_300) },
        accent: {
            tint: themed(NATURE_100, NATURE_900, { night: '#174061' }),
            ink: themed(SAGE_650, NATURE_300, { night: NIGHT_BLUE }),
            border: themed(NATURE_200, NATURE_800, { night: '#1f4e73' }),
        },
        /**
         * The three chips the Market's cards drew with raw hex until the one style box (DESIGN-card-style-box-fable.md §1.2,
         * Marty 4 Nov 2026: "make them look like they came out of the same style box"). `poll`: the POLL chip, the `card.plum`
         * pair, so a poll and an event (`tile.event`, violet) are two hues. `quiet`: the grey chip that carries no news (RECURRING,
         * a category, a group's lock, "Closes in {n}d", Closed); amber keeps meaning money or caution. `info`: the blue 👤 YOU
         * chip, the `tile.services` pair.
         */
        poll: { tint: themed('#fae8ff', '#4a044e'), ink: themed('#86198f', '#f0abfc') },
        /** In Dark (`night`) the quiet chip takes that set's own grey, never the blue: colour stays sparing. */
        quiet: { tint: themed(NATURE_100, NATURE_800, { night: NIGHT_800 }), ink: themed(NATURE_700, NATURE_300, { night: NIGHT_300 }) },
        info: { tint: themed('#dbeafe', '#172554'), ink: themed('#1e40af', '#93c5fd') },
        /**
         * Learn and Local knowledge (DESIGN-local-knowledge-fable.md §3.1: a teal role, AA in both themes, never a literal):
         * the topic chip, "LOCAL KNOWLEDGE" on a page, the 📖 tile. The `card.teal` pair, so it is not an Offer's emerald.
         */
        learn: { tint: themed('#ccfbf1', '#042f2e'), ink: themed('#115e59', '#5eead4') },
    },
    /**
     * A trade's lines in a direct message: Beans held in trust, released to the provider, cancelled. Light is the web's
     * look from before the library (Marty, 15 Oct: light as is); dark is new (the old lines were 1.5-2.2:1 there). The
     * tints are the phone's too: the web lays a tint at DEAL_TINT_ALPHA over the chat, the phone at its own 0.7.
     */
    deal: {
        held: { tint: themed(EMERALD_100, EMERALD_950), ink: themed(EMERALD_800, EMERALD_300), border: themed(EMERALD_500, EMERALD_400) },
        released: { tint: themed(EMERALD_200, EMERALD_900), ink: themed(EMERALD_800, EMERALD_300), border: themed(EMERALD_600, EMERALD_500) },
        cancelled: { tint: themed(RED_100, RED_950), ink: themed(RED_800, RED_300), border: themed(RED_500, RED_400) },
    },
    /**
     * Category tiles for listings, events, and Pulse. `tint` is the ground; `ink` is the category word and sticker
     * outline.
     */
    tile: {
        food: { tint: themed('#ffedd5', '#431407'), ink: themed('#9a3412', '#fdba74') },
        services: { tint: themed('#dbeafe', '#172554'), ink: themed('#1e40af', '#93c5fd') },
        labour: { tint: themed('#fef3c7', '#451a03'), ink: themed('#92400e', '#fcd34d') },
        tools: { tint: themed('#e7e5e4', '#292524'), ink: themed('#292524', '#d6d3d1') },
        goods: { tint: themed('#ebe6df', '#5b5046'), ink: themed('#5b5046', '#ebe6df') },
        garden: { tint: themed('#ecfccb', '#1a2e05'), ink: themed('#3f6212', '#bef264') },
        housing: { tint: themed('#fcedea', '#3c180e'), ink: themed('#863b28', '#f0bcab') },
        transport: { tint: themed('#cffafe', '#083344'), ink: themed('#155e75', '#67e8f9') },
        education: { tint: themed('#e0e7ff', '#1e1b4b'), ink: themed('#3730a3', '#a5b4fc') },
        arts: { tint: themed('#fce7f3', '#500724'), ink: themed('#9d174d', '#f9a8d4') },
        health: { tint: themed('#ccfbf1', '#042f2e'), ink: themed('#115e59', '#5eead4') },
        care: { tint: themed('#ffe4e6', '#4c0519'), ink: themed('#9f1239', '#fda4af') },
        animals: { tint: themed('#d1fae5', '#022c22'), ink: themed('#065f46', '#6ee7b7') },
        tech: { tint: themed('#e0f2fe', '#082f49'), ink: themed('#075985', '#7dd3fc') },
        energy: { tint: themed('#fef9c3', '#422006'), ink: themed('#854d0e', '#fde047') },
        mindset: { tint: themed('#fae8ff', '#4a044e'), ink: themed('#86198f', '#f0abfc') },
        /** The grey tile; in Dark (`night`) that set's own grey. */
        general: { tint: themed('#eef1ee', '#384038', { night: NIGHT_900 }), ink: themed('#434e43', '#c0ccc0', { night: NIGHT_300 }) },
        event: { tint: themed('#ede9fe', '#2e1065'), ink: themed('#5b21b6', '#c4b5fd') },
        pulse: { tint: themed('#fef3c7', '#451a03'), ink: themed('#92400e', '#fcd34d') },
    },
    /**
     * Card caption bands: `tint` fill, `ink` caption words, "Tune" and "…".
     */
    card: {
        /** The default Home card band; in Dark (`night`) that set's own grey, never the blue. */
        sage: { tint: themed('#eef1ee', '#384038', { night: NIGHT_900 }), ink: themed('#5b6b5b', '#c0ccc0', { night: NIGHT_300 }) },
        sky: { tint: themed('#e0f2fe', '#082f49'), ink: themed('#075985', '#7dd3fc') },
        blue: { tint: themed('#dbeafe', '#172554'), ink: themed('#1e40af', '#93c5fd') },
        indigo: { tint: themed('#e0e7ff', '#1e1b4b'), ink: themed('#3730a3', '#a5b4fc') },
        violet: { tint: themed('#ede9fe', '#2e1065'), ink: themed('#5b21b6', '#c4b5fd') },
        plum: { tint: themed('#fae8ff', '#4a044e'), ink: themed('#86198f', '#f0abfc') },
        pink: { tint: themed('#fce7f3', '#500724'), ink: themed('#9d174d', '#f9a8d4') },
        rose: { tint: themed('#ffe4e6', '#4c0519'), ink: themed('#9f1239', '#fda4af') },
        clay: { tint: themed('#fcedea', '#3c180e'), ink: themed('#863b28', '#f0bcab') },
        orange: { tint: themed('#ffedd5', '#431407'), ink: themed('#9a3412', '#fdba74') },
        yellow: { tint: themed('#fef9c3', '#422006'), ink: themed('#854d0e', '#fde047') },
        lime: { tint: themed('#ecfccb', '#1a2e05'), ink: themed('#3f6212', '#bef264') },
        green: { tint: themed('#d1fae5', '#022c22'), ink: themed('#065f46', '#6ee7b7') },
        teal: { tint: themed('#ccfbf1', '#042f2e'), ink: themed('#115e59', '#5eead4') },
        sand: { tint: themed('#ebe6df', '#5b5046'), ink: themed('#5b5046', '#ebe6df') },
        amber: { tint: themed('#fef3c7', '#451a03'), ink: themed('#92400e', '#fcd34d') },
    },
    /** Words and icons drawn straight on a page or card (never on one of the fills above). */
    ink: {
        /** The brand green as text, icons, links-in-green: the phone's `brand.primary`. */
        brand: themed(EMERALD_700, EMERALD_400),
        /** Success messages and ticks. */
        success: themed(EMERALD_700, EMERALD_400),
        /** Errors and destructive links. */
        danger: themed(RED_700, RED_300),
        /** Gold as words and icons (Action Required, a tip, a nudge): never the gold fill as words. */
        warning: themed(AMBER_800, AMBER_400),
        /** The sage accent as text and icons; the blue in Dark (`night`). */
        accent: themed(SAGE_650, NATURE_300, { night: NIGHT_BLUE }),
        /** Terracotta as words and icons: the manager's links, section labels and hovered titles. */
        terra: themed(TERRA_700, TERRA_400),
        /** The event violet as words and outlines: when, the answer's outline and words, "You're hosting". The `tile.event` inks. */
        event: themed(VIOLET_800, VIOLET_300),
        /** Learn's teal as words and icons: "See all ›", "In Learn: …" (DESIGN-local-knowledge-fable.md §3.1). The `chip.learn` ink. */
        learn: themed('#115e59', '#5eead4'),
        /**
         * The onboarding blue as words, outlines, rings and progress (the web's --link pair). Web only: see WEB_ONLY_INKS.
         */
        info: themed(BLUE_600, BLUE_300),
    },
    /**
     * Lines drawn on a map, never words. `ring` is a community's area (map-area-ring.ts): the two themes are picked apart
     * (Marty, 2 Nov: "make sure its visible - but not overly visible on dark map"). In light a deep amber that is easy to
     * find on land, parks and water, where the old amber-500 was 2:1. In dark a muted amber that shows on the land and stays
     * under the map's own labels. A map's theme is its own, so read it with the map's, not the app's: areaRingColour.
     */
    map: {
        ring: themed(AMBER_800, '#d4a24e'),
    },
    /**
     * Your own chat bubble on the phone: `ink` words on the `tint` ground (DESIGN-themes-fable.md §3.2). Classic's values are
     * the phone's own until now (constants/colors.ts `chat.messageMeBg` / `messageTextMe`), moved here unchanged; slice T2
     * points colors.ts at them. Phone only (PHONE_ONLY_ROLES): the web's own bubble is the `sage` button, white words.
     */
    bubble: {
        tint: themed('#d8f2e1', '#1e2923', { night: '#0f283c' }),
        ink: themed('#1e291e', '#e6f4ea', { night: '#e8f4ff' }),
    },
} as const satisfies {
    readonly [role: string]: FillRole | { readonly [name: string]: ChipRole } | { readonly [name: string]: Themed };
};

export type BrandColours = typeof BRAND_COLOURS;

export type CardHue = keyof typeof BRAND_COLOURS.card;

/** The same tree with each `{ light, dark }` replaced by one theme's hex. */
export type BrandColoursFor<T = BrandColours> = {
    readonly [K in keyof T]: T[K] extends Themed ? string : BrandColoursFor<T[K]>;
};

/** The steps of the web's grey ramp (Tailwind's `nature` scale). */
export type RampStep = '50' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900' | '950';

/**
 * The grounds: the pages, cards and rows words sit on, per set (DESIGN-themes-fable.md §3.2 "Grounds"; Marty and Damo,
 * 12 Nov 2026, for Dark's doodle and banner). Classic's values are the ones the apps declare today (the phone's
 * constants/colors.ts and app/ThemeContext.tsx, the web's index.css and tailwind.config.js); slices T1 and T2 point the
 * apps at these. Dark (`night`) changes the hue of a ground, never how light it is.
 */
export const BRAND_GROUNDS = {
    /**
     * The doodle wallpaper both apps draw behind their pages, one baked tile per scheme (the phone's
     * assets/images/pattern-*.webp, the web's public/pattern-*.webp). `ground` is the tile's own ground (the phone's
     * surface.chrome and pattern ground, the web's --pattern-bg). `line` is the doodle's line as a member sees it: the
     * median, by lightness, of the @2x tile's pixels that stand 1.3:1 or more off the ground (measured 12 Nov 2026 on main
     * 6513fb9e: light #c1c4b3 at 1.56:1, Classic dark #303a37 at 1.50:1, the "lift" of #998). Dark (`night`) re-draws the
     * doodle in charcoal (slice T5): the ground and the line are each as light as Classic dark's, with the hue of Dark's
     * greys, so the doodle stands off its ground as much as Classic's does.
     */
    doodle: {
        ground: themed('#f1f1e4', '#141a1a', { night: '#17191c' }),
        line: themed('#c1c4b3', '#303a37', { night: '#343841' }),
    },
    /** The phone: the page (surface.app), the card (surface.card) and the sunken row (surface.subtle). */
    phone: {
        page: themed('#faf9f6', '#0a0a0a'),
        card: themed(WHITE, '#222822', { night: '#24262c' }),
        sunken: themed('#f1efea', '#262626'),
    },
    /**
     * The web app: the page (--bg-primary), the card (--bg-card), the sunken row (--bg-secondary: message rows, the
     * radius picker), the banner (--header-bg: the ground of the leafy header banner, and the browser bar's colour that
     * runs on from it), and the grey ramp (the `nature` scale, the same steps in light and dark; Dark's is its own).
     */
    web: {
        page: themed('#f6f4f0', CHARCOAL, { night: NIGHT_950 }),
        card: themed(WHITE, '#2a322a', { night: '#2d3036' }),
        sunken: themed('#fbfaf8', NATURE_900, { night: NIGHT_900 }),
        banner: themed('#fbfaf8', CHARCOAL, { night: NIGHT_950 }),
        ramp: {
            '50': same('#f6f7f6', { night: '#f6f7f8' }),
            '100': same(NATURE_100, { night: '#f0f1f3' }),
            '200': same(NATURE_200, { night: '#e0e2e6' }),
            '300': same(NATURE_300, { night: NIGHT_300 }),
            '400': same('#9eaf9e', { night: '#a5abb8' }),
            '500': same('#809380', { night: '#878ea0' }),
            '600': same(NATURE_600, { night: '#6b7180' }),
            '700': same(NATURE_700, { night: '#575c69' }),
            '800': same(NATURE_800, { night: NIGHT_800 }),
            '900': same(NATURE_900, { night: NIGHT_900 }),
            '950': same(CHARCOAL, { night: NIGHT_950 }),
        } satisfies { readonly [S in RampStep]: Themed },
    },
} as const;

/**
 * The manager's grounds: dark only (its index.html sets `dark`), Classic only (it has no picker), with its own deeper
 * sage scale (apps/manager/tailwind.config.js): page (nature-950), card (nature-900), raised row and input (nature-800).
 */
export const MANAGER_GROUNDS = { page: '#0b110b', card: '#151e16', raised: '#2b422c' } as const;

/** BRAND_GROUNDS with each leaf resolved to one set's hex. */
export type BrandGroundsFor = BrandColoursFor<typeof BRAND_GROUNDS>;

/** One set's grounds, the same shape as BRAND_GROUNDS with plain hex leaves. */
export function brandGrounds(set: BrandSet): BrandGroundsFor {
    return mapThemed(BRAND_GROUNDS, set) as BrandGroundsFor;
}

const unique = (values: readonly string[]): string[] => values.filter((v, i) => values.indexOf(v) === i);

/**
 * The web app's own grounds in one set: page, card and sunken row, and first any of them the phone shares (light's white
 * card), so Classic's lists keep the order apps index into (server routes read WEB_INK_GROUNDS.light[1] as the page).
 */
export function brandWebInkGrounds(set: BrandSet): string[] {
    const g = brandGrounds(set);
    const phone = [g.phone.page, g.phone.card, g.phone.sunken];
    const web = [g.web.page, g.web.card, g.web.sunken];
    return unique([...web.filter((v) => phone.includes(v)), ...web]);
}

/**
 * Every page, card and row an `ink.*` role may be drawn on in one set, in either app: a ground both apps share (light's
 * white card) first, then the phone's page, card, sunken row and the doodle's ground, then the web's page, card and
 * sunken row, then the manager's (Classic dark only). An ink must reach 4.5 on all of them.
 */
export function brandInkGrounds(set: BrandSet): string[] {
    const g = brandGrounds(set);
    const phone = [g.phone.page, g.phone.card, g.phone.sunken, g.doodle.ground];
    const web = [g.web.page, g.web.card, g.web.sunken];
    const manager = set === 'dark' ? [MANAGER_GROUNDS.page, MANAGER_GROUNDS.card, MANAGER_GROUNDS.raised] : [];
    return unique([...phone.filter((v) => web.includes(v)), ...phone, ...web, ...manager]);
}

/**
 * Classic's ink grounds per scheme, derived from BRAND_GROUNDS (brandInkGrounds): light is
 * [card both apps, phone page, phone sunken, doodle ground, web page, web sunken]; dark is
 * [phone page, phone card, phone sunken, doodle ground, web page, web card, web sunken, manager page, card, raised].
 */
export const INK_GROUNDS: { readonly [T in BrandTheme]: readonly string[] } = {
    light: brandInkGrounds('light'),
    dark: brandInkGrounds('dark'),
};

/** The web app's own grounds in Classic, a subset of INK_GROUNDS: light [card, page, sunken], dark [page, card, sunken]. */
export const WEB_INK_GROUNDS: { readonly [T in BrandTheme]: readonly string[] } = {
    light: brandWebInkGrounds('light'),
    dark: brandWebInkGrounds('dark'),
};

/**
 * Roles only the phone draws: not written as CSS variables or Tailwind names, so the web and the manager never get one.
 * `bubble`: the web's own chat bubble is the `sage` button (white words), not a tint.
 */
export const PHONE_ONLY_ROLES: readonly string[] = ['bubble'];

/**
 * Inks only the web app draws, judged on WEB_INK_GROUNDS (still 4.5). The phone's colors.ts never reads them
 * (__tests__/brand-colours.test.ts checks). `info`: #2563eb is 4.71-5.17 on the web's grounds but 4.498 on the phone's
 * sunken row (#f1efea), where it is never drawn; deepening it would change the web's light mode, which needs no change.
 */
export const WEB_ONLY_INKS: readonly string[] = ['info'];

/**
 * How much of a deal tint the web lays over the chat (its old rgba alpha). Its words are judged on that composite; the
 * web draws it from the `--bp-deal-<name>-wash` variable brandCssVariableMap() writes.
 */
export const DEAL_TINT_ALPHA = 0.4;

/**
 * What a line on a map is drawn over. Light: Google's rural land, town, buildings and water, read off the emulator's map on
 * 2 Nov 2026, then OSM's land, water, forest and streets, the only map the web has. Dark: the phone's dark map, the land and
 * water of apps/native/utils/map-scheme.ts, whose test holds these to it.
 */
export const MAP_GROUNDS: { readonly [T in BrandTheme]: readonly string[] } = {
    light: ['#d3f8e2', '#f7f6f6', '#e9eaef', '#8fd8ec', '#f2efe9', '#aad3df', '#add19e', '#e0dfdf'],
    dark: ['#414e61', '#0f2f4d'],
};

/** Roles allowed 3.0 instead of 4.5 because their words are always 24 px or larger (WCAG "large text"). None today. */
export const LARGE_TEXT_ROLES: readonly string[] = [];

function isThemed(node: unknown): node is Themed {
    return typeof node === 'object' && node !== null && typeof (node as Themed).light === 'string' && typeof (node as Themed).dark === 'string';
}

function mapThemed(node: unknown, set: BrandSet): unknown {
    if (isThemed(node)) return colourIn(node, set);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) out[key] = mapThemed(child, set);
    return out;
}

/**
 * One set's brand colours, the same shape as BRAND_COLOURS with plain hex leaves. `brandColours('light')` and
 * `brandColours('dark')` are Classic, exactly as before sets (the test holds them to a snapshot of main).
 */
export function brandColours(set: BrandSet): BrandColoursFor {
    return mapThemed(BRAND_COLOURS, set) as BrandColoursFor;
}

/** The three dots a look's row in the picker starts with: the page, the card and the accent, as that set draws them. */
export interface BrandSwatch {
    /** The page as members see it by default: the doodle wallpaper's ground (both apps draw the doodle unless it is off). */
    page: string;
    /** That app's card. */
    card: string;
    /** The accent as a fill (`accent.fill`): a selected chip, an unread badge. */
    accent: string;
}

/**
 * The swatch for a look's row in the picker (slice T3), read from the library so it cannot drift from the real colours.
 * "Same as phone" draws two dots: `brandSwatch('light', app).page` and `brandSwatch('dark', app).page`.
 */
export function brandSwatch(set: BrandSet, app: 'phone' | 'web'): BrandSwatch {
    const g = brandGrounds(set);
    return { page: g.doodle.ground, card: g[app].card, accent: brandColours(set).accent.fill };
}

/** Every `{ light, dark }` leaf with its dotted path (`cta.fill`, `chip.ok.ink`, `ink.brand`), in source order. */
export function brandColourLeaves(): Array<{ path: string; colour: Themed }> {
    const out: Array<{ path: string; colour: Themed }> = [];
    const walk = (node: unknown, path: string[]) => {
        if (isThemed(node)) {
            out.push({ path: path.join('.'), colour: node });
            return;
        }
        for (const [key, child] of Object.entries(node as Record<string, unknown>)) walk(child, [...path, key]);
    };
    walk(BRAND_COLOURS, []);
    return out;
}

// ── Contrast ─────────────────────────────────────────────────────────────────────────────────────────────────────

function channel(hex: string, offset: number): number {
    const v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** WCAG 2.x relative luminance of a `#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
    if (hex.length !== 7 || hex[0] !== '#') throw new Error(`brand colours are #rrggbb, got ${hex}`);
    return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** `hex` laid at `alpha` (0 to 1) over the opaque `ground`, as the opaque `#rrggbb` a reader sees. */
export function blendOver(hex: string, alpha: number, ground: string): string {
    let out = '#';
    for (const offset of [1, 3, 5]) {
        const v = Math.round(parseInt(hex.slice(offset, offset + 2), 16) * alpha + parseInt(ground.slice(offset, offset + 2), 16) * (1 - alpha));
        out += v.toString(16).padStart(2, '0');
    }
    return out;
}

/** `#d1fae5` at 0.7 → `rgba(209, 250, 229, 0.7)`: a library colour where a screen needs it translucent. */
export function rgbaOf(hex: string, alpha: number): string {
    const [r, g, b] = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** WCAG 2.x contrast ratio between two `#rrggbb` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** One pair a reader sees: `ink` words on `ground`, the bar it must clear, and what it reaches. */
export interface BrandContrastPair {
    /** The set the pair is drawn in (`light`, `dark` or `night`); the field keeps its old name. */
    theme: BrandSet;
    /** The role, e.g. `cta`, `chip.ok`, `ink.brand`. */
    role: string;
    /** What is being judged, e.g. `on / fill`, `on / hover`, `ink / tint`, `ink / #faf9f6`. */
    pair: string;
    ink: string;
    ground: string;
    ratio: number;
    min: number;
}

/** Every words-on-colour pair the brand colours make, in every set, each ink on that set's own grounds. */
export function brandContrastPairs(): BrandContrastPair[] {
    const pairs: BrandContrastPair[] = [];
    const min = (role: string) => (LARGE_TEXT_ROLES.includes(role) ? 3 : 4.5);
    for (const set of BRAND_SETS) {
        const at = (colour: Themed) => colourIn(colour, set);
        const add = (role: string, pair: string, ink: string, ground: string) =>
            pairs.push({ theme: set, role, pair, ink, ground, ratio: contrastRatio(ink, ground), min: min(role) });
        const webGrounds = brandWebInkGrounds(set);
        const inkGrounds = brandInkGrounds(set);
        for (const [role, node] of Object.entries(BRAND_COLOURS)) {
            // A line on a map is not words: __tests__/map-area-ring.test.ts judges it on MAP_GROUNDS.
            if (role === 'map') continue;
            if (role === 'deal') {
                // Only the web draws these words, over the chat: judged on the web's grounds through the tint.
                for (const [name, line] of Object.entries(node as BrandColours['deal'])) {
                    for (const ground of webGrounds) {
                        add(`deal.${name}`, `ink / tint at ${DEAL_TINT_ALPHA} over ${ground}`, at(line.ink), blendOver(at(line.tint), DEAL_TINT_ALPHA, ground));
                    }
                }
            } else if (role === 'chip' || role === 'tile' || role === 'card') {
                for (const [name, chip] of Object.entries(node as { [name: string]: ChipRole })) {
                    add(`${role}.${name}`, 'ink / tint', at(chip.ink), at(chip.tint));
                }
            } else if (role === 'bubble') {
                const bubble = node as BrandColours['bubble'];
                add(role, 'ink / tint', at(bubble.ink), at(bubble.tint));
            } else if (role === 'ink') {
                for (const [name, ink] of Object.entries(node as BrandColours['ink'])) {
                    for (const ground of WEB_ONLY_INKS.includes(name) ? webGrounds : inkGrounds) add(`ink.${name}`, `ink / ${ground}`, at(ink), ground);
                }
            } else {
                const fill = node as FillRole;
                add(role, 'on / fill', at(fill.on), at(fill.fill));
                add(role, 'on / hover', at(fill.on), at(fill.hover));
            }
        }
    }
    return pairs;
}

// ── For the web app and the manager ─────────────────────────────────────────────────────────────────────────────

/** `cta.fill` → `--bp-cta-fill`. */
export function brandCssVariableName(path: string): string {
    return `--bp-${path.split('.').join('-')}`;
}

/** The leaves the web and the manager get as CSS variables and Tailwind names: all but PHONE_ONLY_ROLES'. */
function webLeaves(): Array<{ path: string; colour: Themed }> {
    return brandColourLeaves().filter(({ path }) => !PHONE_ONLY_ROLES.includes(path.split('.')[0]));
}

/**
 * One set's custom properties: `{ '--bp-cta-fill': '#b85236', … }`, and each deal tint as the web lays it, a plain
 * rgba (`--bp-deal-held-wash: rgba(209, 250, 229, 0.4)`): no color-mix(), which old Android WebViews drop. A phone-only
 * role (PHONE_ONLY_ROLES) is not written. `'light'` and `'dark'` are Classic, exactly as before sets.
 */
export function brandCssVariableMap(set: BrandSet): Record<string, string> {
    const out: Record<string, string> = {};
    for (const { path, colour } of webLeaves()) out[brandCssVariableName(path)] = colourIn(colour, set);
    for (const [name, line] of Object.entries(BRAND_COLOURS.deal)) out[`--bp-deal-${name}-wash`] = rgbaOf(colourIn(line.tint, set), DEAL_TINT_ALPHA);
    return out;
}

export interface BrandCssOptions {
    /** Where the light values go. Default `:root`. */
    lightSelector?: string;
    /** Where the dark values go. Default `:root.dark` (the web app adds `dark` and `dark-theme`; the manager `dark`). */
    darkSelector?: string;
}

/**
 * The stylesheet text the web app and the manager include: every role as a CSS custom property, light under
 * `:root` and dark under `:root.dark`. Write it to a file at build time (or paste it into a `<style>`), then use
 * `var(--bp-cta-fill)` in CSS or `brandTailwindColours()` in a Tailwind config.
 */
export function brandCssVariables(options: BrandCssOptions = {}): string {
    const block = (selector: string, theme: BrandTheme) => {
        const lines = Object.entries(brandCssVariableMap(theme)).map(([name, hex]) => `  ${name}: ${hex};`);
        return `${selector} {\n${lines.join('\n')}\n}\n`;
    };
    const header = '/* Generated from @beanpool/core brand-colours.ts. Change a value there, never here or in a screen. */\n';
    return header + block(options.lightSelector ?? ':root', 'light') + block(options.darkSelector ?? ':root.dark', 'dark');
}

/**
 * For a Tailwind config's `theme.extend.colors`: `{ bp: { 'cta-fill': 'var(--bp-cta-fill)', … } }`, so screens write
 * `bg-bp-cta-fill text-bp-cta-on hover:bg-bp-cta-hover` and the theme switch is the CSS variables' job.
 */
export function brandTailwindColours(): { bp: Record<string, string> } {
    const bp: Record<string, string> = {};
    for (const { path } of webLeaves()) bp[path.split('.').join('-')] = `var(${brandCssVariableName(path)})`;
    return { bp };
}
