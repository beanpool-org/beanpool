/**
 * BeanPool · Native color system
 * ------------------------------------------------------------------
 * Two layers:
 *   1. `palette` — primitive scale. Raw, role-agnostic colors. Add a new
 *      entry ONLY when a genuinely new hue/step is needed; reuse otherwise.
 *   2. `colors`  — semantic tokens. What screens actually reference
 *      (text.body, surface.card, market.offer, trust.steward …). Import
 *      from here; never hardcode hex in a component.
 *
 * Two sets, light and dark (the old Classic / Earth / Slate choice is gone).
 * Brand and status roles — the brand green, buttons, danger, gold, the FAB,
 * the accent — come from @beanpool/core's brand-colours.ts, the one library
 * the phone, the web app and the manager share (docs/brand-colours.md).
 * CHANGE THOSE THERE, NEVER HERE OR IN A SCREEN.
 *
 * Fill vs ink: one token cannot be both in dark mode (emerald-500 reads on the
 * page but not under white words; emerald-700 the other way round). So a FILL
 * under words uses brand.fill / accent.fill / feedback.*.solid / action.fab
 * with text.onBrand / onAccent / onDanger / onGold; WORDS and icons use
 * brand.primary, accent.primary, feedback.*.fg.
 *
 * Color roles at a glance:
 *   emerald  → brand + OFFER + success      (the "bean"; commit buttons)
 *   orange   → NEED + primary action (FAB)
 *   amber    → TRUST tiers + star rating     (deepens with tier)
 *   violet   → app accent (chat, nav, projects, currency UI)
 *   red      → danger / destructive
 *   gray     → text, surfaces, metadata      (the calm majority)
 */

import { brandColours } from '@beanpool/core';

const brandLight = brandColours('light');
const brandDark = brandColours('dark');

// ── 1. Primitive palette ──────────────────────────────────────────
export const palette = {
    white: '#ffffff',
    black: '#000000',

    // Gray — neutral spine: text, surfaces, borders
    gray50: '#f9fafb',
    gray100: '#f3f4f6',
    gray200: '#e5e7eb',
    gray300: '#d1d5db',
    gray400: '#9ca3af',
    gray500: '#6b7280',
    gray600: '#4b5563',
    gray700: '#374151',
    gray800: '#1f2937',
    gray900: '#111827',
    grayAlt100: '#f2f4f7',
    slate50: '#f8fafc',
    slate100: '#f1f5f9',
    slate200: '#e2e8f0',
    slate300: '#cbd5e1',
    slate400: '#94a3b8',
    slate500: '#64748b',
    slate600: '#475569',
    slate700: '#334155',
    slate800: '#1e293b', // translucent scrims over imagery
    slate900: '#0f172a',
    zinc700: '#3f3f46',
    neutral600: '#333333',
    neutral700: '#404040',
    neutral800: '#262626',
    neutral900: '#1a1a1a',
    neutral950: '#0a0a0a',

    // Emerald — brand / offer / success
    emerald50: '#ecfdf5',
    emerald100: '#d1fae5',
    emerald200: '#a7f3d0',
    emerald300: '#6ee7b7',
    emerald400: '#34d399',
    emerald500: '#10b981',
    emerald600: '#059669',
    emerald700: '#047857',
    emerald800: '#065f46',
    emerald900: '#064e3b',
    emerald950: '#022c22',

    // Amber / gold — trust + warning
    amber50: '#fffbeb',
    amber100: '#fef3c7',
    amber200: '#fde68a',
    amber300: '#fcd34d',
    amber400: '#fbbf24',
    amber500: '#f59e0b',
    amber600: '#d97706',
    amber700: '#b45309',
    amber800: '#92400e',
    amber900: '#78350f',
    amber950: '#451a03',
    yellow50: '#fefce8',
    yellow200: '#fef08a',
    yellow300: '#fde047',
    yellow500: '#eab308',

    // Orange — need + action
    orange50: '#fff7ed',
    orange100: '#ffedd5',
    orange200: '#fed7aa',
    orange300: '#fdba74',
    orange500: '#f97316',
    orange600: '#ea580c',
    orange700: '#c2410c',
    orange800: '#9a3412',
    orange900: '#7c2d12',
    orangeAlt500: '#d97757',

    // Green / lime — founding / "live" / new-members (distinct from emerald brand)
    green50: '#f0fdf4',
    greenAlt50: '#e0fae5',
    green100: '#dcfce7',
    green200: '#bbf7d0',
    green500: '#22c55e',
    green600: '#16a34a',
    green700: '#15803d',
    green800: '#166534',
    green950: '#1a2e1a',
    lime500: '#84cc16',

    // Red — danger
    red50: '#fef2f2',
    red100: '#fee2e2',
    red200: '#fecaca',
    red300: '#fca5a5',
    red400: '#f87171',
    red500: '#ef4444',
    red600: '#dc2626',
    red700: '#b91c1c',
    red800: '#991b1b',
    red900: '#7f1d1d',
    red950: '#450a0a',

    // Violet / purple — app accent + For-You / favorites
    violet50: '#f5f3ff',
    violet100: '#ede9fe',
    violet200: '#ddd6fe',
    violet300: '#c4b5fd',
    violet500: '#8b5cf6',
    violet600: '#7c3aed',
    violet700: '#6d28d9',
    purple50: '#faf5ff',
    purple100: '#f3e8ff',
    purple700: '#7e22ce',
    purple800: '#6b21a8',

    // Indigo — category picker + circulation / forecast accents
    indigo50: '#eef2ff',
    indigo100: '#e0e7ff',
    indigo200: '#c7d2fe',
    indigo300: '#a5b4fc',
    indigo400: '#818cf8',
    indigo500: '#6366f1',
    indigo600: '#4f46e5',
    indigo700: '#4338ca',
    indigo800: '#3730a3',
    indigo900: '#312e81',
    indigo950: '#1e1b4b',

    // Blue — informational / links
    blue50: '#eff6ff',
    blue100: '#dbeafe',
    blue200: '#bfdbfe',
    blue400: '#60a5fa',
    blue500: '#3b82f6',
    blue600: '#2563eb',
    blue700: '#1d4ed8',
    blue800: '#1e40af',

    // Teal / cyan / pink — occasional accents
    teal500: '#14b8a6',
    cyan200: '#a5f3fc',
    cyan500: '#06b6d4',
    pink500: '#ec4899',
} as const;

// ── 2. Semantic tokens ────────────────────────────────────────────
export const lightColors = {
    // Text
    text: {
        heading: '#1c1d1a',      // warm charcoal
        body: '#2d2f2a',         // soft dark charcoal
        secondary: '#6b6d66',    // warm gray
        muted: '#a0a29a',        // warm light gray
        inverse: palette.white,
        link: palette.indigo600,
        onBrand: brandLight.commit.on,   // words on brand.fill
        onAccent: brandLight.accent.on,  // words on accent.fill
        onDanger: brandLight.danger.on,  // words on feedback.danger.solid
        onGold: brandLight.gold.on,      // charcoal words on feedback.warning.solid (gold), never white
    },

    // Surfaces & borders
    surface: {
        app: '#faf9f6',          // premium warm off-white (Claude-like)
        page: '#faf9f6' as string, // page background; 'transparent' when the doodle pattern is on
        chrome: '#faf9f6' as string, // bars and floating control blocks; the pattern's ground when it is on
        card: palette.white,
        subtle: '#f1efea',       // sunken warm off-white/gray
    },
    border: {
        default: '#ebebe6',
        strong: '#dfdfd9',
    },

    // Brand + accent
    brand: {
        primary: brandLight.ink.brand,      // words and icons in the brand green
        fill: brandLight.commit.fill,       // a brand-green fill under text.onBrand
        dark: brandLight.commit.hover,      // the deeper green: pressed fills, emphasis
        tint: palette.emerald50,
    },
    accent: {
        primary: brandLight.ink.accent, // professional indigo-slate accent instead of violet
        fill: brandLight.accent.fill,   // an indigo fill under text.onAccent
        tint: palette.indigo50,
        border: palette.indigo100,
    },

    // Marketplace listing type — the one loud signal per card
    market: {
        offer: { fg: palette.emerald700, bg: palette.emerald100 },
        need: { fg: palette.orange700, bg: palette.orange100 },
        author: palette.gray600, // seller name on listing cards
    },

    // Trust tiers — one warm "gold" family that deepens with tier; the
    // intensity encodes the ranking. Newcomer stays neutral grey (no trust
    // earned yet). Single source of truth for PostAuthorTrust, the Ledger,
    // and the Trust info modal.
    trust: {
        newcomer: { fg: palette.gray600, bg: palette.gray100, border: palette.gray300 }, // fg 6.87:1 on bg (gray500 was 4.39)
        parent: { fg: palette.amber700, bg: palette.amber50, border: palette.amber200 },
        resident: { fg: palette.amber700, bg: palette.amber50, border: palette.amber200 },
        steward: { fg: palette.amber700, bg: palette.amber100, border: palette.amber300 },
        elder: { fg: palette.amber800, bg: palette.amber200, border: palette.amber500 },
        star: palette.amber400,
        founding: { fg: palette.green700, bg: 'rgba(34, 197, 94, 0.12)', border: 'rgba(34, 197, 94, 0.35)' },
    },

    // Status / feedback
    feedback: {
        danger: { fg: brandLight.ink.danger, bg: palette.red50, border: palette.red200, solid: brandLight.danger.fill, disabled: 'rgba(239, 68, 68, 0.4)' },
        warning: { fg: palette.amber700, bg: palette.amber50, border: palette.amber200, solid: brandLight.gold.fill },
        success: { fg: brandLight.ink.success, bg: palette.emerald50, border: palette.emerald200, solid: brandLight.commit.fill },
        info: { fg: palette.blue600, bg: palette.blue50, border: palette.blue500, solid: palette.blue500 },
    },

    // Discrete actions
    action: {
        fab: brandLight.action.fill,
        cta: brandLight.cta.fill,   // terracotta call to action (white words)
    },

    // Translucent overlays on imagery (price / recurring badges over photos)
    overlay: {
        scrim: 'rgba(30,41,59,0.85)', // slate-800 @ 85%
        scrimEdge: 'rgba(255,255,255,0.15)',
        lightFill: 'rgba(255,255,255,0.2)', // translucent white pill on colored chips
        imageViewerBg: 'rgba(0,0,0,0.92)',
        imageViewerCloseBg: 'rgba(0,0,0,0.5)',
        hero: 'rgba(0, 0, 0, 0.3)',
    },

    // Chat specific tokens
    chat: {
        tickUnread: 'rgba(30, 41, 30, 0.45)',
        messageTimeMe: 'rgba(30, 41, 30, 0.55)',
        daySeparatorBg: '#ebebe6',
        quoteMeBg: 'rgba(0, 0, 0, 0.05)',
        quoteOtherBg: 'rgba(0, 0, 0, 0.04)',
        quoteTextMe: '#1e291e',
        messageMeBg: '#d8f2e1',       // soft sage/mint green (WhatsApp-like sender bubble)
        messageOtherBg: '#ffffff',     // clean white receiver bubble
        messageTextMe: '#1e291e',      // dark forest charcoal text
        messageTextOther: '#1f2937',    // dark gray text
    },

    // Onboarding specific cards & buttons
    onboarding: {
        transferBg: 'rgba(37, 99, 235, 0.08)',
        transferBorder: 'rgba(37, 99, 235, 0.4)',
        recoverBg: 'rgba(245, 158, 11, 0.08)',
        recoverBorder: 'rgba(245, 158, 11, 0.4)',
        socialRecoverBg: 'rgba(16, 185, 129, 0.08)',
        socialRecoverBorder: 'rgba(16, 185, 129, 0.4)',
        trinityActiveBg: 'rgba(37, 99, 235, 0.08)',
        highlightBg: 'rgba(34, 197, 94, 0.08)',
        highlightBorder: 'rgba(34, 197, 94, 0.2)',
    },

    // Profile specific colors
    profile: {
        roleProviderBg: 'rgba(16, 185, 129, 0.12)',
        roleReceiverBg: 'rgba(99, 102, 241, 0.12)',
    },

    // Chat system messages colors
    chatSystem: {
        defaultBg: 'rgba(243, 244, 246, 0.8)',
        defaultBorder: 'rgba(229, 231, 235, 1)',
        fundedBg: 'rgba(209, 250, 229, 0.7)',
        releasedBg: 'rgba(167, 243, 208, 0.7)',
        cancelledBg: 'rgba(254, 226, 226, 0.7)',
    },
} as const;

export const darkColors = {
    // Text
    text: {
        heading: palette.white,
        body: palette.gray100,
        secondary: palette.gray400,
        muted: palette.gray500,
        inverse: palette.white,
        link: palette.blue400,
        onBrand: brandDark.commit.on,
        onAccent: brandDark.accent.on,
        onDanger: brandDark.danger.on,
        onGold: brandDark.gold.on,
    },

    // Surfaces & borders
    surface: {
        app: palette.neutral950, // screen background (dark)
        page: palette.neutral950 as string, // page background; 'transparent' when the doodle pattern is on
        chrome: palette.neutral950 as string, // bars and floating control blocks; the pattern's ground when it is on
        card: palette.neutral900, // card background (dark gray)
        subtle: palette.neutral800, // chips, sunken rows (dark neutral)
    },
    border: {
        default: palette.neutral800,
        strong: palette.neutral700,
    },

    // Brand + accent
    brand: {
        primary: brandDark.ink.brand,     // emerald-500: reads on the page, never under white words
        fill: brandDark.commit.fill,      // emerald-700: the same deep fill as light
        dark: palette.emerald400,         // the "deeper" green as words in dark is the paler one
        tint: palette.emerald950,
    },
    accent: {
        primary: brandDark.ink.accent, // indigo for dark mode
        fill: brandDark.accent.fill,
        tint: palette.indigo950,
        border: palette.indigo800,
    },

    // Marketplace listing type
    market: {
        offer: { fg: palette.emerald400, bg: palette.emerald950 },
        need: { fg: palette.orange300, bg: palette.orange900 }, // 5.56:1 (orange-800 was 4.33)
        author: palette.gray300,
    },

    // Trust tiers
    trust: {
        newcomer: { fg: palette.gray400, bg: palette.neutral800, border: palette.neutral700 },
        resident: { fg: palette.amber400, bg: palette.amber950, border: palette.amber900 },
        steward: { fg: palette.amber300, bg: palette.amber950, border: palette.amber800 },
        elder: { fg: palette.amber200, bg: palette.amber900, border: palette.amber600 },
        star: palette.amber400,
        founding: { fg: palette.green500, bg: 'rgba(34, 197, 94, 0.12)', border: 'rgba(34, 197, 94, 0.35)' },
    },

    // Status / feedback
    feedback: {
        danger: { fg: brandDark.ink.danger, bg: palette.red950, border: palette.red800, solid: brandDark.danger.fill, disabled: 'rgba(239, 68, 68, 0.3)' },
        warning: { fg: palette.amber400, bg: palette.amber950, border: palette.amber900, solid: brandDark.gold.fill },
        success: { fg: brandDark.ink.success, bg: palette.emerald950, border: palette.emerald800, solid: brandDark.commit.fill },
        info: { fg: palette.blue400, bg: palette.indigo950, border: palette.blue600, solid: palette.blue500 },
    },

    // Discrete actions
    action: {
        fab: brandDark.action.fill,
        cta: brandDark.cta.fill,
    },

    // Translucent overlays on imagery
    overlay: {
        scrim: 'rgba(10,10,10,0.85)',
        scrimEdge: 'rgba(255,255,255,0.1)',
        lightFill: 'rgba(255,255,255,0.1)',
        imageViewerBg: 'rgba(0,0,0,0.95)',
        imageViewerCloseBg: 'rgba(0,0,0,0.6)',
        hero: 'rgba(0, 0, 0, 0.5)',
    },

    // Chat specific tokens
    chat: {
        tickUnread: 'rgba(255,255,255,0.45)',
        messageTimeMe: 'rgba(255, 255, 255, 0.55)',
        daySeparatorBg: 'rgba(38, 38, 38, 0.85)',
        quoteMeBg: 'rgba(255, 255, 255, 0.06)',
        quoteOtherBg: 'rgba(255, 255, 255, 0.04)',
        quoteTextMe: '#e6f4ea',
        messageMeBg: '#1e2923',      // dark green-gray
        messageOtherBg: '#262626',    // dark gray
        messageTextMe: '#e6f4ea',
        messageTextOther: '#f3f4f6',
    },

    // Onboarding specific cards & buttons
    onboarding: {
        transferBg: 'rgba(59, 130, 246, 0.08)',
        transferBorder: 'rgba(59, 130, 246, 0.3)',
        recoverBg: 'rgba(245, 158, 11, 0.08)',
        recoverBorder: 'rgba(245, 158, 11, 0.3)',
        socialRecoverBg: 'rgba(16, 185, 129, 0.08)',
        socialRecoverBorder: 'rgba(16, 185, 129, 0.3)',
        trinityActiveBg: 'rgba(59, 130, 246, 0.08)',
        highlightBg: 'rgba(34, 197, 94, 0.08)',
        highlightBorder: 'rgba(34, 197, 94, 0.2)',
    },

    // Profile specific colors
    profile: {
        roleProviderBg: 'rgba(16, 185, 129, 0.08)',
        roleReceiverBg: 'rgba(99, 102, 241, 0.08)',
    },

    // Chat system messages colors
    chatSystem: {
        defaultBg: 'rgba(38, 38, 38, 0.8)',
        defaultBorder: 'rgba(64, 64, 64, 1)',
        fundedBg: 'rgba(2, 44, 34, 0.7)',
        releasedBg: 'rgba(6, 78, 59, 0.7)',
        cancelledBg: 'rgba(69, 10, 10, 0.7)',
    },
} as const;

export const colors = lightColors;
export type AppColors = typeof colors;
export default colors;
