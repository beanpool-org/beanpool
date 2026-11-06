// @vitest-environment jsdom
/**
 * The host on an event's own screen is the box a listing's "POSTED BY" is (Marty, 4 Nov 2026, on the phone's event page: "hosted by is
 * so small and in plain text - consider looking at the offer card and styling it like that one"): a rounded card, "HOSTED BY" in small
 * capitals, the host's face, their name with the handshake and their ratings line, after the description where the listing puts its
 * box, and a tap on it opens the host's profile. Drawn for real, as event-tag-chips-render.test.ts draws the screen, light and dark,
 * at the floor's window (320 dp, text at 1.3×).
 *
 * A member's copy of an event has no host to show, and a visitors' view that hides who posted shows the box but opens nothing.
 * An enterprise that hosts is drawn as the listing page draws an enterprise poster: the same box, its name, and a tap that hands its
 * key to the profile screen, which is where an enterprise is told apart (enterprise-profile-redirect-render.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { push, rating, themeIs } = vi.hoisted(() => ({
    push: vi.fn(),
    rating: { answer: { average: 0, count: 0 } as { average: number; count: number } | 'unreadable', asked: [] as string[] },
    themeIs: { now: 'light' as 'light' | 'dark' },
}));
vi.mock('react-native', () => {
    const flat = (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, disabled, testID, style } = props;
        const attrs: Record<string, unknown> = {};
        if (style) attrs['data-style'] = JSON.stringify(flat(style));
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (disabled) attrs['aria-disabled'] = 'true';
        if (props.numberOfLines) attrs['data-lines'] = String(props.numberOfLines);
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'button') attrs.role = 'button';
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: any) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => null,
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
        Alert: { alert: vi.fn() },
        Linking: { openURL: vi.fn() },
        DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit: vi.fn() },
        AppState: { addEventListener: () => ({ remove() {} }) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
        PixelRatio: { getFontScale: () => 1.3, get: () => 1.5 },
    };
});
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any), KeyboardAwareScrollView: ({ children }: { children?: unknown }) => createElement('div', null, children as any), KeyboardStickyView: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-router', () => ({ router: { canGoBack: () => false, back: vi.fn(), replace: vi.fn(), push, dismissTo: vi.fn() } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('../../app/ThemeContext', async () => {
    const m: any = await import('../../constants/colors');
    const themed = () => ({ theme: themeIs.now, colors: themeIs.now === 'dark' ? m.darkColors : m.lightColors });
    return { useTheme: themed, useStyles: (f: any) => f(themed()) };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: 'me'.repeat(32) } }) }));
vi.mock('../db', () => ({
    fetchEventDetail: async () => null, rsvpEvent: vi.fn(), deletePost: vi.fn(), reportAbuse: vi.fn(), letInToEvent: vi.fn(),
    getMemberRatings: async (key: string) => {
        rating.asked.push(key);
        if (rating.answer === 'unreadable') throw new Error('offline');
        return { ratings: [], ...rating.answer };
    },
}));
vi.mock('../haptics', () => ({ hapticTick: () => {} }));
vi.mock('../../components/PhotoCarousel', () => ({ PhotoCarousel: () => null }));
// The page draws the photo viewer (a Modal with a close icon) only while a photo is open; the icon library cannot load outside a device.
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('../../components/EventCard', () => ({ EVENT_ACCENT: '#0a7' }));
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: () => null }));
vi.mock('../../components/EventExtras', () => ({ EventReminder: () => null, EventShareAndCalendar: () => null }));
// The face as a tag carrying what it was given, so the test can see whose picture is drawn.
vi.mock('../../components/MemberAvatar', () => ({
    MemberAvatar: (p: { avatarUrl?: string | null; pubkey?: string; callsign?: string; size?: number }) =>
        createElement('i', { 'data-avatar': 'true', 'data-avatar-url': p.avatarUrl ?? '', 'data-avatar-key': p.pubkey ?? '', 'data-avatar-size': String(p.size ?? '') }),
}));

import { EventDetail } from '../../components/EventDetail';
import { HIDDEN_AUTHOR } from '../posts-view';
import { darkColors, lightColors } from '../../constants/colors';
import { MARKET_CARD_SHELL } from '@beanpool/core';

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    push.mockClear(); rating.asked.length = 0; rating.answer = { average: 0, count: 0 }; themeIs.now = 'light';
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const HOST_KEY = 'host'.repeat(16);
const event = { id: 'ev-1', type: 'event', title: 'Working bee', description: 'Bring gloves', author_pubkey: HOST_KEY, author_callsign: 'Hana', author_avatar: '/img/hana.webp',
    eventStartAt: new Date(Date.now() + 86_400_000).toISOString(), photos: [] };
const draw = async (more: Record<string, unknown> = {}) => { await act(async () => { root.render(createElement(EventDetail, { post: { ...event, ...more } }) as any); }); };
const box = (id = 'event-host-open') => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const styleOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') || '{}');
const spanWith = (within: Element, text: string) => Array.from(within.querySelectorAll('span')).find(s => s.textContent === text) as HTMLElement | undefined;

describe("an event's own screen: the host is a box like a listing's \"POSTED BY\"", () => {
    it('"HOSTED BY", the face, the name with the handshake and the ratings line, in one button', async () => {
        await draw();
        const b = box();
        expect(b, 'the host box').toBeTruthy();
        expect(b!.tagName).toBe('BUTTON');
        expect(b!.getAttribute('role')).toBe('button');
        expect(spanWith(b!, 'HOSTED BY'), 'the label').toBeTruthy();
        const face = b!.querySelector('[data-avatar="true"]') as HTMLElement;
        expect(face, 'the face').toBeTruthy();
        expect(face.getAttribute('data-avatar-url')).toBe('/img/hana.webp');
        expect(face.getAttribute('data-avatar-key')).toBe(HOST_KEY);
        expect(face.getAttribute('data-avatar-size')).toBe('48');
        expect(spanWith(b!, '🤝 Hana'), 'the name').toBeTruthy();
        expect(b!.textContent).toContain('☆☆☆☆☆ No ratings yet');
        // The old plain line is gone: nothing says "Hosted by Hana" any more.
        expect(host.textContent).not.toContain('Hosted by');
    });

    it('is a rounded card with a small-caps label, as the listing draws it (the same tokens, light and dark)', async () => {
        for (const [theme, colors] of [['light', lightColors], ['dark', darkColors]] as const) {
            themeIs.now = theme;
            await draw();
            const b = box()!;
            const card = styleOf(b);
            expect(card.backgroundColor, theme).toBe(colors.surface.card);
            expect(card.borderColor, theme).toBe(colors.border.default);
            // The style box's page box (DESIGN-detail-pages-fable.md §2.2, DP1): the card's corners and its one text padding.
            expect(card.borderRadius).toBe(MARKET_CARD_SHELL.radius);
            expect(card.padding).toBe(MARKET_CARD_SHELL.textPadding);
            expect([card.borderRadius, card.padding]).toEqual([14, 12]);
            const label = styleOf(spanWith(b, 'HOSTED BY')!);
            expect(label.color, theme).toBe(colors.text.muted);
            expect(label.fontSize).toBe(10);
            expect(label.fontWeight).toBe('800');
            expect(label.letterSpacing).toBe(1.5);
            expect(styleOf(spanWith(b, '🤝 Hana')!).color, theme).toBe(colors.text.body);
            // The ratings line is the outer of two spans that read alike; the first match is the one carrying the colour.
            expect(styleOf(spanWith(b, '☆☆☆☆☆ No ratings yet')!).color, theme).toBe(colors.text.secondary);
            act(() => root.unmount());
            root = createRoot(host);
        }
    });

    it("the page's own 16 dp padding sits around it: no 20 dp margin of the listing's page on top", async () => {
        await draw();
        const card = styleOf(box());
        expect(card.marginHorizontal).toBe(0);
    });

    it('sits after the description, where the listing puts its box', async () => {
        await draw();
        const text = host.textContent!;
        expect(text.indexOf('Bring gloves')).toBeGreaterThan(-1);
        expect(text.indexOf('HOSTED BY')).toBeGreaterThan(text.indexOf('Bring gloves'));
        expect(text.indexOf('Report event')).toBeGreaterThan(text.indexOf('HOSTED BY'));
    });

    it("a tap opens the host's profile", async () => {
        await draw();
        await act(async () => { box()!.click(); });
        expect(push).toHaveBeenCalledTimes(1);
        expect(push).toHaveBeenCalledWith({ pathname: '/public-profile', params: { publicKey: HOST_KEY, callsign: 'Hana' } });
    });

    it('is a target well past 44 dp: the face (48) and the card\'s padding (2 × 12) alone make 72', async () => {
        await draw();
        const b = box()!;
        const card = styleOf(b);
        const faceBox = styleOf(b.querySelector('[data-avatar="true"]')!.parentElement);
        expect(faceBox.height).toBe(48);
        expect(faceBox.height + 2 * card.padding).toBeGreaterThanOrEqual(44);
    });

    it("shows the host's ratings as the listing shows a poster's, read from the node", async () => {
        rating.answer = { average: 4.8, count: 6 };
        await draw();
        expect(rating.asked).toEqual([HOST_KEY]);
        const b = box()!;
        expect(b.textContent).toContain('★★★★★');
        expect(b.textContent).toContain('(4.8) • 6 Reviews');
        expect(b.textContent).not.toContain('No ratings yet');
        const stars = Array.from(b.querySelectorAll('span')).find(s => s.textContent === '★★★★★')!;
        expect(styleOf(stars).color).toBe(lightColors.trust.star);
    });

    // Found re-reading the diff: the hook kept the last host's stars when the screen was handed another event, so a host whose
    // ratings could not be read showed somebody else's.
    it("a screen handed another event never shows the last host's ratings on the new one", async () => {
        rating.answer = { average: 4.8, count: 6 };
        await draw();
        expect(box()!.textContent).toContain('(4.8) • 6 Reviews');
        rating.answer = 'unreadable';
        await draw({ id: 'ev-2', author_pubkey: 'ivy0'.repeat(16), author_callsign: 'Ivy', author_avatar: null });
        expect(rating.asked).toEqual([HOST_KEY, 'ivy0'.repeat(16)]);
        expect(box()!.textContent).toContain('🤝 Ivy');
        expect(box()!.textContent).toContain('☆☆☆☆☆ No ratings yet');
        expect(box()!.textContent).not.toContain('4.8');
        expect(box()!.textContent).not.toContain('Reviews');
    });

    it('a rating the node cannot give leaves "No ratings yet", never a broken page', async () => {
        rating.answer = 'unreadable';
        await draw();
        expect(box()!.textContent).toContain('☆☆☆☆☆ No ratings yet');
    });

    it('a long name wraps beside the face at 320 dp × 1.3 instead of running past the card', async () => {
        const long = 'The Mullumbimby Community Gardens and Seed Library Collective';
        await draw({ author_callsign: long });
        const b = box()!;
        const nameEl = spanWith(b, `🤝 ${long}`)!;
        expect(nameEl, 'the whole name is there').toBeTruthy();
        expect(nameEl.getAttribute('data-lines')).toBeNull();
        expect(styleOf(nameEl.parentElement).flexShrink).toBe(1);
    });

    it('an enterprise that hosts is the same box with its name, and a tap hands its key to the profile screen', async () => {
        const SHOP_KEY = 'shop'.repeat(16);
        await draw({ author_pubkey: SHOP_KEY, author_callsign: 'Brunswick Seed Co-op', author_avatar: null });
        const b = box()!;
        expect(spanWith(b, 'HOSTED BY')).toBeTruthy();
        expect(spanWith(b, '🤝 Brunswick Seed Co-op')).toBeTruthy();
        expect((b.querySelector('[data-avatar="true"]') as HTMLElement).getAttribute('data-avatar-key')).toBe(SHOP_KEY);
        await act(async () => { b.click(); });
        expect(push).toHaveBeenCalledWith({ pathname: '/public-profile', params: { publicKey: SHOP_KEY, callsign: 'Brunswick Seed Co-op' } });
    });

    it('a group-only event says who can see it, under the box', async () => {
        await draw({ audience_scope: 'group', target_group_name: 'Seed Savers' });
        const line = host.querySelector('[data-testid="event-host-audience"]') as HTMLElement;
        expect(line.textContent).toBe('🔒 Only Seed Savers can see this.');
        const all = host.textContent!;
        expect(all.indexOf('🔒 Only Seed Savers')).toBeGreaterThan(all.indexOf('HOSTED BY'));
        await draw();
        expect(host.querySelector('[data-testid="event-host-audience"]')).toBeNull();
    });

    it("a member's copy of an event has no host to show: no box, the line says where it comes from", async () => {
        await draw({ shown_from: JSON.stringify({ host: 'byron.example', name: 'Byron', url: 'https://byron.example', door: 'ask', price: { amount: 0, unit: 'fixed' } }) });
        expect(box()).toBeNull();
        expect(box('event-host-card')).toBeNull();
        expect(host.textContent).not.toContain('HOSTED BY');
        expect(rating.asked).toEqual([]);
    });

    it("a visitors' view that hides who posted shows the box and opens nothing", async () => {
        await draw({ author_pubkey: HIDDEN_AUTHOR });
        expect(box(), 'no profile to open, so not the opening button').toBeNull();
        const b = box('event-host-card')!;
        expect(b).toBeTruthy();
        expect(b.getAttribute('aria-disabled')).toBe('true');
        await act(async () => { b.click(); });
        expect(push).not.toHaveBeenCalled();
        expect(rating.asked).toEqual([]);
    });
});

describe('one box for a listing and an event', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
    it("the listing's \"POSTED BY\" and the event's \"HOSTED BY\" both draw components/AuthorCard.tsx", () => {
        const listing = read('../../app/post/[id].tsx');
        const event = read('../../components/EventDetail.tsx');
        expect(listing).toMatch(/import \{ AuthorCard \} from '\.\.\/\.\.\/components\/AuthorCard'/);
        expect(listing).toMatch(/<AuthorCard\s+label=\{t\('POSTED BY'\)\}/);
        expect(event).toMatch(/import \{ AuthorCard, useMemberRating \} from '\.\/AuthorCard'/);
        expect(event).toMatch(/<AuthorCard\s+label=\{t\('HOSTED BY'\)\}/);
        // Neither screen keeps a box of its own: the card's styles live in the one component.
        expect(listing).not.toMatch(/authorCard|authorCardLabel/);
        expect(event).not.toMatch(/authorCard|authorCardLabel/);
    });
});
