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
 * Pure: no I/O, no Node built-ins, no regular expressions (the barrel is bundled for the phone,
 * barrel-is-universal.test.ts).
 */

export type BrandTheme = 'light' | 'dark';

/** One colour as each theme draws it. */
export interface Themed {
    readonly light: string;
    readonly dark: string;
}

const same = (hex: string): Themed => ({ light: hex, dark: hex });
const themed = (light: string, dark: string): Themed => ({ light, dark });

// Tailwind's steps, named so a reader can place each value. terra-600′ is the brand terracotta deepened 4 %.
const WHITE = '#ffffff';
const CHARCOAL = '#1d231d'; // nature-950, the brand charcoal
const TERRA_600_DEEP = '#b85236';
const TERRA_700 = '#a3472e';
const TERRA_400 = '#e5967f'; // the web's terra-400
const EMERALD_100 = '#d1fae5';
const EMERALD_300 = '#6ee7b7';
const EMERALD_400 = '#34d399';
const EMERALD_700 = '#047857';
const EMERALD_800 = '#065f46';
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
const RED_700 = '#b91c1c';
const RED_800 = '#991b1b';
const RED_950 = '#450a0a';
const GREY_555 = '#555555';
const GREY_333 = '#333333';
const BLUE_300 = '#93c5fd';
const BLUE_600 = '#2563eb';
const BLUE_700 = '#1d4ed8';
// The web's sage scale (tailwind `nature`). sage-650 sits halfway between nature-600 and 700.
const NATURE_100 = '#eef1ee';
const NATURE_200 = '#dce3dc';
const NATURE_300 = '#c0ccc0';
const NATURE_600 = '#647664';
const SAGE_650 = '#5b6b5b';
const NATURE_700 = '#526052';
const NATURE_800 = '#434e43';
const NATURE_900 = '#384038';

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

/**
 * The roles. Keys are lowercase single words so the CSS names below are the path joined by dashes
 * (`chip.ok.ink` → `--bp-chip-ok-ink`).
 */
export const BRAND_COLOURS = {
    /** Calls to action: Start a community, + ADD POST, Save. */
    cta: { fill: same(TERRA_600_DEEP), hover: same(TERRA_700), on: same(WHITE) },
    /** Commit buttons and the brand's own fill: Accept, Send Beans, Message, Join; the phone's `brand.fill`. */
    commit: { fill: same(EMERALD_700), hover: same(EMERALD_800), on: same(WHITE) },
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
     * nature-600 in light; charcoal words on a light sage in dark (pressed goes lighter there, as gold does).
     */
    accent: { fill: themed(NATURE_600, NATURE_300), hover: themed(NATURE_700, NATURE_200), on: themed(WHITE, CHARCOAL) },
    /** Small badges and chips. `ok` is also the Offer chip, `need` the Need chip, `accent` a selected sage chip. */
    chip: {
        ok: { tint: themed(EMERALD_100, EMERALD_950), ink: themed(EMERALD_800, EMERALD_300) },
        need: { tint: themed(ORANGE_100, ORANGE_900), ink: themed(ORANGE_800, ORANGE_300) },
        warn: { tint: themed(AMBER_100, AMBER_950), ink: themed(AMBER_800, AMBER_300) },
        danger: { tint: themed(RED_100, RED_950), ink: themed(RED_700, RED_300) },
        accent: { tint: themed(NATURE_100, NATURE_900), ink: themed(SAGE_650, NATURE_300), border: themed(NATURE_200, NATURE_800) },
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
        /** The sage accent as text and icons. */
        accent: themed(SAGE_650, NATURE_300),
        /** Terracotta as words and icons: the manager's links, section labels and hovered titles. */
        terra: themed(TERRA_700, TERRA_400),
        /**
         * The onboarding blue as words, outlines, rings and progress (the web's --link pair). Web only: see WEB_ONLY_INKS.
         */
        info: themed(BLUE_600, BLUE_300),
    },
} as const satisfies {
    readonly [role: string]: FillRole | { readonly [name: string]: ChipRole } | { readonly [name: string]: Themed };
};

export type BrandColours = typeof BRAND_COLOURS;

/** The same tree with each `{ light, dark }` replaced by one theme's hex. */
export type BrandColoursFor<T = BrandColours> = {
    readonly [K in keyof T]: T[K] extends Themed ? string : BrandColoursFor<T[K]>;
};

/**
 * The pages and cards an `ink.*` role may be drawn on, in either app, per theme: the phone's app background, card,
 * sunken row and doodle-pattern ground; the web app's page, card and sunken background. An ink must reach 4.5 on all.
 */
export const INK_GROUNDS: { readonly [T in BrandTheme]: readonly string[] } = {
    light: [
        '#ffffff', // card, both apps
        '#faf9f6', // phone surface.app
        '#f1efea', // phone surface.subtle
        '#f1f1e4', // phone pattern ground
        '#f6f4f0', // web --bg-primary (oat-100)
        '#fbfaf8', // web --bg-secondary (oat-50)
    ],
    dark: [
        '#0a0a0a', // phone surface.app
        '#1a1a1a', // phone surface.card
        '#262626', // phone surface.subtle
        '#141a1a', // phone pattern ground
        '#1d231d', // web --bg-primary (nature-950)
        '#2a322a', // web --bg-card
        '#384038', // web --bg-secondary (nature-900): message rows, consent cards, the radius picker
        // The manager is dark only (index.html sets `dark`) and has its own deeper sage scale (tailwind.config.js):
        '#0b110b', // manager page (nature-950)
        '#151e16', // manager card (nature-900)
        '#2b422c', // manager raised row and input (nature-800)
    ],
};

/** The web app's own grounds, a subset of INK_GROUNDS: page, card and sunken background in each theme. */
export const WEB_INK_GROUNDS: { readonly [T in BrandTheme]: readonly string[] } = {
    light: ['#ffffff', '#f6f4f0', '#fbfaf8'],
    dark: ['#1d231d', '#2a322a', '#384038'],
};

/**
 * Inks only the web app draws, judged on WEB_INK_GROUNDS (still 4.5). The phone's colors.ts never reads them
 * (__tests__/brand-colours.test.ts checks). `info`: #2563eb is 4.71-5.17 on the web's grounds but 4.498 on the phone's
 * sunken row (#f1efea), where it is never drawn; deepening it would change the web's light mode, which needs no change.
 */
export const WEB_ONLY_INKS: readonly string[] = ['info'];

/** Roles allowed 3.0 instead of 4.5 because their words are always 24 px or larger (WCAG "large text"). None today. */
export const LARGE_TEXT_ROLES: readonly string[] = [];

function isThemed(node: unknown): node is Themed {
    return typeof node === 'object' && node !== null && typeof (node as Themed).light === 'string' && typeof (node as Themed).dark === 'string';
}

function mapThemed(node: unknown, theme: BrandTheme): unknown {
    if (isThemed(node)) return node[theme];
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) out[key] = mapThemed(child, theme);
    return out;
}

/** One theme's brand colours, the same shape as BRAND_COLOURS with plain hex leaves. */
export function brandColours(theme: BrandTheme): BrandColoursFor {
    return mapThemed(BRAND_COLOURS, theme) as BrandColoursFor;
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

/** WCAG 2.x contrast ratio between two `#rrggbb` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** One pair a reader sees: `ink` words on `ground`, the bar it must clear, and what it reaches. */
export interface BrandContrastPair {
    theme: BrandTheme;
    /** The role, e.g. `cta`, `chip.ok`, `ink.brand`. */
    role: string;
    /** What is being judged, e.g. `on / fill`, `on / hover`, `ink / tint`, `ink / #faf9f6`. */
    pair: string;
    ink: string;
    ground: string;
    ratio: number;
    min: number;
}

/** Every words-on-colour pair the brand colours make, in both themes. */
export function brandContrastPairs(): BrandContrastPair[] {
    const pairs: BrandContrastPair[] = [];
    const min = (role: string) => (LARGE_TEXT_ROLES.includes(role) ? 3 : 4.5);
    const add = (theme: BrandTheme, role: string, pair: string, ink: string, ground: string) =>
        pairs.push({ theme, role, pair, ink, ground, ratio: contrastRatio(ink, ground), min: min(role) });
    for (const theme of ['light', 'dark'] as const) {
        for (const [role, node] of Object.entries(BRAND_COLOURS)) {
            if (role === 'chip') {
                for (const [name, chip] of Object.entries(node as BrandColours['chip'])) {
                    add(theme, `chip.${name}`, 'ink / tint', chip.ink[theme], chip.tint[theme]);
                }
            } else if (role === 'ink') {
                for (const [name, ink] of Object.entries(node as BrandColours['ink'])) {
                    const grounds = WEB_ONLY_INKS.includes(name) ? WEB_INK_GROUNDS[theme] : INK_GROUNDS[theme];
                    for (const ground of grounds) add(theme, `ink.${name}`, `ink / ${ground}`, ink[theme], ground);
                }
            } else {
                const fill = node as FillRole;
                add(theme, role, 'on / fill', fill.on[theme], fill.fill[theme]);
                add(theme, role, 'on / hover', fill.on[theme], fill.hover[theme]);
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

/** One theme's custom properties: `{ '--bp-cta-fill': '#b85236', … }`. */
export function brandCssVariableMap(theme: BrandTheme): Record<string, string> {
    const out: Record<string, string> = {};
    for (const { path, colour } of brandColourLeaves()) out[brandCssVariableName(path)] = colour[theme];
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
    for (const { path } of brandColourLeaves()) bp[path.split('.').join('-')] = `var(${brandCssVariableName(path)})`;
    return { bp };
}
