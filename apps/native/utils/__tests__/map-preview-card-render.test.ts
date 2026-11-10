// @vitest-environment jsdom
/**
 * The map's pin card is the Market's list card with a ✕ (components/MapPreviewCard.tsx; DESIGN-card-style-box-fable.md §2
 * "Map pop-up, phone", slice M1). Marty, 4 Nov 2026, on the event pop-up ("the event small tile looks bad"; no photo, "0 going",
 * a big View event button): "yes restyle - look at the similar market place offer and map card offer".
 *
 * Drawn alone, its hosts keeping their styles, and laid out with Yoga (yoga-dom-layout.ts) on a 320 dp screen at 1.3x text, in
 * light and in dark: the picture is the list card's 80 dp slot, flush inside the border and the card's full height; the card sits
 * 16 in from the screen's edges; the chips are the box's; an event carries the member's mark and no count of nobody; the ✕ is
 * the one control besides the card, clear of the chip row; a press anywhere on the card opens the item, the ✕ only closes.
 * (map-preview-opens-render and map-words-render draw it inside the real map.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { layOut } from './yoga-dom-layout';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, onLayout, disabled, style, numberOfLines } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        attrs['data-style'] = JSON.stringify(flat(typeof style === 'function' ? style({ pressed: false }) : style));
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        View: el('div'), Text: el('span'), Pressable: el('button'), TouchableOpacity: el('button'), ScrollView: el('div'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: { alert: () => {} },
        Linking: { openURL: async () => {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        AppState: { currentState: 'active', addEventListener: listener },
        AccessibilityInfo: { announceForAccessibility: () => {}, isScreenReaderEnabled: async () => false, addEventListener: listener },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }) },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const nav = vi.hoisted(() => ({ pushed: [] as unknown[] }));
vi.mock('expo-router', () => ({ router: { push: (to: unknown) => { nav.pushed.push(to); }, navigate() {}, setParams() {} } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-image', () => ({
    Image: ({ source, style }: { source?: { uri?: string }; style?: unknown }) => createElement('img', {
        'data-src': source?.uri, 'data-style': JSON.stringify(Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'))),
    }),
}));
const scheme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const pick = () => (scheme.dark ? { theme: 'dark', colors: darkColors } : { theme: 'light', colors: lightColors });
    return { useTheme: () => pick(), useStyles: (make: (t: unknown) => unknown) => make(pick()) };
});
const ME = { publicKey: 'me-key', callsign: 'Ana' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true', 'data-style': '{"width":24,"height":24}' }) }));
vi.mock('../photo-refresh', () => ({ refreshListingAfterPhotoError: () => true }));
vi.mock('../db', () => ({ getMemberRatings: async () => ({ average: 0, count: 0 }) }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => null }));

import { MARKET_CARD_SHELL, copyPriceLine, eventCopyOf } from '@beanpool/core';
import { darkColors, lightColors } from '../../constants/colors';
import { MapPreviewCard } from '../../components/MapPreviewCard';

const now = Date.now();
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Kofi's duck eggs: an Elder's Offer with no photo, a recurring one, as on the map's own test community. The author's tier credit
 * and the price are whole hundredths of a Bean, as the node sends them (an Elder's least credit, 1,400 Beans; 5 Beans).
 */
const EGGS = {
    id: 'p-eggs', type: 'offer', status: 'active', title: 'Fresh duck eggs', category: 'food', repeatable: 1,
    author_pubkey: 'kofi-key', author_callsign: 'Kofi', author_energy_cycled: 140000, price_c: 500, price_type: 'fixed', photos: [],
    lat: -28.65, lng: 153.6,
};
/** Byron's Saturday market: Marty's own Going on it, a long title and a long place, nobody else has answered. */
const TWILIGHT = {
    id: 'ev-twilight', type: 'event', status: 'active', title: 'Byron Bay Twilight Market - Every Saturday', category: 'events',
    author_pubkey: 'byron-key', author_callsign: 'Byron Markets', event_start_at: iso(now + 2 * DAY), event_end_at: iso(now + 2 * DAY + 5 * 3_600_000),
    event_state: 'scheduled', event_place_name: 'Railway Park, Jonson Street, Byron Bay', lat: -28.643, lng: 153.612, myRsvp: 'going',
    goingCount: 0, interestedCount: 0, photos: [],
};

let host: HTMLDivElement;
let root: Root;
const opened: string[] = [];
let closed = 0;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    nav.pushed.length = 0;
    opened.length = 0;
    closed = 0;
    scheme.dark = false;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
/** The card at the foot of a 320 dp screen, as map.tsx puts it (its SafeAreaView is the screen's foot). */
async function show(post: any, over: { copy?: any; showsBeans?: boolean } = {}) {
    const card = createElement(MapPreviewCard, {
        post, copy: over.copy ?? null, showsBeans: over.showsBeans ?? true,
        onOpen: () => { opened.push(post.id); }, onClose: () => { closed++; },
    });
    await act(async () => { root.render(createElement('div', { 'data-testid': 'screen', 'data-style': '{"flex":1,"justifyContent":"flex-end"}' }, card) as any); });
    await settle();
}
const q = (testID: string) => host.querySelector(`[data-testid="${testID}"]`) as HTMLElement;
const lay = () => layOut(q('screen'), { width: 320, height: 569 }, { fontScale: 1.3 });
/** An element's left edge and top on the screen: Yoga gives each box in its parent's, so add them up. */
function at(l: ReturnType<typeof lay>, el: Element) {
    let left = 0, top = 0;
    for (let e: Element | null = el; e && e !== q('screen'); e = e.parentElement) { const b = l.box(e); left += b.left; top += b.top; }
    return { left, top };
}
const styleOf = (el: Element) => JSON.parse(el.getAttribute('data-style') ?? '{}');
const press = async (el: Element | null, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle();
};

describe.each([['light', false], ['dark', true]] as const)("the map's pin card at 320 dp and 1.3x text, %s", (_name, dark) => {
    const colors = dark ? (darkColors as unknown as typeof lightColors) : lightColors;
    beforeEach(() => { scheme.dark = dark; });

    for (const post of [EGGS, TWILIGHT]) {
        it(`${post.type === 'event' ? 'an event' : 'a listing'}: the list card's slot, 16 in from the screen, the floating shadow; nothing past its edge`, async () => {
            await show(post);
            const card = q('map-preview-open');
            const l = lay();
            const slot = card.firstElementChild as HTMLElement;
            const text = card.lastElementChild as HTMLElement;
            expect(slot.querySelector('[data-testid="category-tile"]'), 'the category tile holds the slot').not.toBeNull();
            // The card: 16 in from either edge, the Market's corners, border and ground, the floating shadow (core's numbers).
            expect(at(l, card).left).toBe(MARKET_CARD_SHELL.popUp.margin);
            expect(l.width(card)).toBe(320 - 2 * MARKET_CARD_SHELL.popUp.margin);
            expect(styleOf(card)).toMatchObject({
                borderRadius: MARKET_CARD_SHELL.radius, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card,
                flexDirection: 'row', overflow: 'hidden', elevation: MARKET_CARD_SHELL.floatingShadow.elevation,
                shadowOpacity: MARKET_CARD_SHELL.floatingShadow.opacity, shadowRadius: MARKET_CARD_SHELL.floatingShadow.blur,
            });
            // The picture slot: 80 wide, flush inside the border (1 dp; an Elder's gold one is 3 on the left), the card's full
            // height; the text column beside it.
            const edge = styleOf(card).borderLeftWidth ?? 1;
            expect(edge).toBe(post === EGGS ? 3 : 1);
            expect(l.box(slot)).toMatchObject({ left: edge, top: 1, width: 80 });
            expect(l.height(slot)).toBeCloseTo(l.height(card) - 2, 1);
            expect(l.box(text).left).toBe(edge + 80);
            // Its own height, from its lines: no taller than the text needs (or the slot's 80).
            const first = text.firstElementChild!, last = text.lastElementChild!;
            const needs = l.box(last).top + l.height(last) - l.box(first).top + 2 * MARKET_CARD_SHELL.textPadding;
            expect(l.height(card)).toBeCloseTo(Math.max(80, needs) + 2, 1);
            console.log(`${post.id} pin card ${l.height(card)} dp at 320 x 1.3 (${_name})`);
            const right = at(l, card).left + l.width(card);
            for (const el of Array.from(card.querySelectorAll('*'))) {
                expect(at(l, el).left + l.width(el), el.textContent || el.tagName).toBeLessThanOrEqual(right + 0.5);
            }
        });

        it(`${post.type === 'event' ? 'an event' : 'a listing'}: no button but the card and the ✕; the ✕ sits clear of the chip row, on the subtle ground`, async () => {
            await show(post);
            const card = q('map-preview-open');
            const close = q('map-preview-close');
            expect(card.querySelectorAll('button'), 'no button inside the card').toHaveLength(0);
            expect(Array.from(q('map-preview-card').querySelectorAll('button'))).toEqual([card, close]);
            expect(host.textContent).not.toMatch(/View (event|Details|listing)/);
            expect(close.getAttribute('aria-label')).toBe('Close');
            expect(styleOf(close)).toMatchObject({ width: 28, height: 28, position: 'absolute' });
            // The dot is the box's one child, filling it: 28 round on the subtle ground (shell.closeDot).
            const dot = q('map-preview-close-dot');
            expect(close.firstElementChild).toBe(dot);
            expect(styleOf(dot)).toMatchObject({ borderRadius: 14, backgroundColor: colors.surface.subtle });
            const l = lay();
            expect([l.width(dot), l.height(dot)]).toEqual([28, 28]);
            const x = at(l, close);
            const cardBox = at(l, card);
            // 8 in from the card's top-right corner.
            expect(x.top - cardBox.top).toBe(MARKET_CARD_SHELL.popUp.close.inset);
            expect(cardBox.left + l.width(card) - (x.left + 28)).toBe(MARKET_CARD_SHELL.popUp.close.inset);
            // The first row (chips, and a listing's price) ends before the ✕ begins.
            const head = (card.lastElementChild as HTMLElement).firstElementChild as HTMLElement;
            expect(at(l, head).left + l.width(head)).toBeLessThanOrEqual(x.left);
        });

        it(`${post.type === 'event' ? 'an event' : 'a listing'}: the ✕ sits above the card on Android too (elevation and zIndex), with no shadow of its own`, async () => {
            // Plain Android draws siblings in order of elevation, so a later sibling below the card's elevation can be drawn
            // under it (#2879 review; React Native's own Z barriers kept tree order on the API 36 emulator, but the order must
            // not rest on them). Yoga and Chromium both draw in tree order and cannot see this; the styles can.
            await show(post);
            const card = q('map-preview-open');
            const close = q('map-preview-close');
            expect(card.parentElement, 'the card and the ✕ are siblings').toBe(q('map-preview-card'));
            expect(close.parentElement).toBe(q('map-preview-card'));
            const c = styleOf(card), x = styleOf(close);
            expect(c.elevation).toBe(MARKET_CARD_SHELL.floatingShadow.elevation);
            expect(x.elevation, "the ✕'s elevation").toBeGreaterThan(c.elevation);
            expect(x.zIndex ?? 0, "the ✕'s zIndex").toBeGreaterThan(c.zIndex ?? 0);
            // A lifted box with no ground, no corners and no border has no outline on Android, so it casts no shadow.
            for (const prop of ['backgroundColor', 'borderRadius', 'borderWidth']) expect(x, `the lifted box's ${prop}`).not.toHaveProperty(prop);
            // Nothing inside it lifts itself again.
            for (const el of Array.from(close.querySelectorAll('*'))) expect(styleOf(el).elevation ?? 0, el.tagName).toBe(0);
        });

        it(`${post.type === 'event' ? 'an event' : 'a listing'}: a press anywhere on the card opens it once; the ✕ only closes`, async () => {
            await show(post);
            for (const el of [q('map-preview-open'), ...Array.from(q('map-preview-open').querySelectorAll('span'))]) {
                opened.length = 0;
                await press(el, el.textContent || 'the card');
                expect(opened, el.textContent || 'the card').toEqual([post.id]);
            }
            expect(nav.pushed, 'no profile, no second route').toEqual([]);
            opened.length = 0;
            await press(q('map-preview-close'), 'the ✕');
            expect(closed).toBe(1);
            expect(opened).toEqual([]);
        });
    }

    it("a listing: the Market card's chips (OFFER, the category, ↻ RECURRING), its price, the Elder's who-line", async () => {
        await show(EGGS);
        const card = q('map-preview-open');
        expect(card.getAttribute('aria-label')).toBe('Open listing: Fresh duck eggs');
        expect(q('map-preview-type-chip').textContent).toBe('OFFER');
        expect(styleOf(q('map-preview-type-chip'))).toMatchObject({ backgroundColor: colors.market.offer.bg, borderRadius: 6 });
        expect(q('map-preview-category-chip').textContent).toContain('Food');
        expect(styleOf(q('map-preview-category-chip'))).toMatchObject({ backgroundColor: colors.chip.quiet.bg });
        expect(card.textContent).toContain('↻ RECURRING');
        expect(card.textContent).toContain('5');
        expect(q('map-preview-author').textContent).toContain('Kofi');
        expect(q('author-tier').textContent).toContain('Elder');
        // An Elder's card: the gold left border, as in the Market.
        expect(styleOf(card)).toMatchObject({ borderLeftWidth: 3, borderLeftColor: colors.trust.star });
    });

    it('a listing of my own: 👤 YOU; a copy from another community: its line where the author would be, no price, no name', async () => {
        await show({ ...EGGS, author_pubkey: ME.publicKey, author_energy_cycled: 0 });
        expect(q('map-preview-open').textContent).toContain('👤 YOU');
        const COPY = {
            ...EGGS, id: 'p-copy', title: 'Quince paste', author_pubkey: 'hidden', author_callsign: undefined, author_energy_cycled: 0, price_c: 0,
            // Its home price as the node keeps it on a copy (shown_price: whole hundredths and the unit), in the phone's column.
            shown_from: JSON.stringify({ host: 'byron.beanpool.org', name: 'Mullumbimby', url: 'https://byron.beanpool.org', door: 'ask', price: '2000 fixed' }),
        };
        await show(COPY, { copy: eventCopyOf(COPY) });
        expect(q('map-preview-copy-line').textContent).toBe(copyPriceLine(eventCopyOf(COPY)!));
        expect(q('map-preview-author')).toBeNull();
        // The copy's own price is in its line; the card draws no amount of its own.
        const text = q('map-preview-open').lastElementChild!.textContent ?? '';
        expect(text.replace(copyPriceLine(eventCopyOf(COPY)!), '')).not.toMatch(/\d/);
    });

    it("an event: the EVENT chip, the when in the event's ink, the place, Going ✓; no count when nobody else has answered", async () => {
        await show(TWILIGHT);
        const card = q('map-preview-open');
        expect(card.getAttribute('aria-label')).toBe('Open event: Byron Bay Twilight Market - Every Saturday, Going ✓');
        expect(q('event-type-chip').textContent).toBe('EVENT');
        expect(styleOf(q('event-type-chip'))).toMatchObject({ backgroundColor: colors.tile.event.tint });
        expect(styleOf(q('event-when'))).toMatchObject({ color: colors.tile.event.ink });
        expect(card.textContent).toContain('📍 Railway Park, Jonson Street, Byron Bay');
        expect(q('event-mark').textContent).toBe('Going ✓');
        expect(q('event-counts')).toBeNull();
        expect(card.textContent).not.toMatch(/\b0 going|0 interested/);
    });

    it("an event nobody has answered: no mark and no count (Marty's shot: \"0 going\"); once someone has, the counts", async () => {
        await show({ ...TWILIGHT, myRsvp: null });
        expect(q('event-mark')).toBeNull();
        expect(q('event-counts')).toBeNull();
        expect(q('map-preview-open').textContent).not.toMatch(/going|interested/i);
        await show({ ...TWILIGHT, myRsvp: null, goingCount: 3, interestedCount: 1 });
        expect(q('event-counts').textContent).toBe('👥 3 going · 1 interested');
    });

    it('an event with no title is named "Open event: Event", as the map\'s card always named it (eventPinCard)', async () => {
        await show({ ...TWILIGHT, title: '', myRsvp: null });
        expect(q('map-preview-open').getAttribute('aria-label')).toBe('Open event: Event');
    });

    it("an event I host: You're hosting this event", async () => {
        await show({ ...TWILIGHT, author_pubkey: ME.publicKey, myRsvp: null });
        expect(q('event-mark').textContent).toBe("You're hosting this event");
    });
});
