// @vitest-environment jsdom
/**
 * The event page on the style box (DESIGN-detail-pages-fable.md §2 and §3 slice DP1; Marty, 4 Nov 2026: "All Fable's picks"):
 * components/EventDetail.tsx drawn for real, with what it draws (EventExtras' Share, Add to calendar and Remind me, the Share
 * button, the host's box), and laid out with Yoga (yoga-dom-layout.ts) at the floor: 320 dp wide, 569 tall, text at 1.3×, in
 * light and in dark. The Mullum market is the fixture (§2.9's): a two-line title, a repeat caption, a one-line place, a photo,
 * and, as the node sends it by id, its next six dates (drawn by the real EventNextDates, compact).
 *
 * It proves the order (the answer is the first button after the loud lines, before Share, the description and the host), the
 * 4:3 photo frame (288 × 216 in a 288 dp column), where the answer row lands (§2.9's stop is measured, and still open with a
 * photo: see its block), the next dates compact (the first and "and 5 more", one button that opens the list), HOSTED BY as
 * the page box and no grey host line, the counts only above zero, the boxes and buttons on the style box's numbers and the
 * event's library colours, nothing wider than the screen, and none of the old raw violets anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../components/useKeepCaretVisible', () => ({ useKeepCaretVisible: () => ({ scrollRef: { current: null }, scrollProps: {} }) }));
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { layOut, type Layout } from './yoga-dom-layout';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const themeIs = vi.hoisted(() => ({ now: 'light' as 'light' | 'dark' }));
/** Each host's onLayout, by testID, so a case can hand the photo frame the height Yoga gave it. */
const layouts = vi.hoisted(() => new Map<string, (e: unknown) => void>());
vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', checkbox: 'checkbox' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(8).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID, onLayout, disabled, style, numberOfLines } = props;
        if (testID && onLayout) layouts.set(testID, onLayout);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState?.selected !== undefined) attrs['aria-selected'] = String(accessibilityState.selected);
        if (disabled || accessibilityState?.disabled) attrs['aria-disabled'] = 'true';
        // What yoga-dom-layout.ts lays out: the host's style as it was given, and a Text's line limit.
        attrs['data-style'] = JSON.stringify(flat(typeof style === 'function' ? style({ pressed: false }) : style));
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    const absolute = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'), TouchableOpacity: el('button'),
        Image: el('img'),
        ActivityIndicator: () => createElement('i', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: absolute, absoluteFillObject: absolute, flatten: (s: unknown) => flat(s) },
        Alert: { alert: () => {} },
        Share: { share: async () => ({}) },
        Linking: { openURL: async () => {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        AppState: { currentState: 'active', addEventListener: listener },
        Keyboard: { addListener: listener, dismiss() {} },
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
        PixelRatio: { getFontScale: () => 1.3, get: () => 1.5 },
    };
});
vi.mock('react-native-keyboard-controller', async () => {
    const { createElement: h } = await import('react');
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(8).filter((x) => x && typeof x === 'object'));
    // A vertical scroll view around its content container, as the phone builds it.
    return {
        KeyboardAwareScrollView: ({ children, contentContainerStyle }: { children?: unknown; contentContainerStyle?: unknown }) =>
            h('div', { 'data-style': JSON.stringify({ flexGrow: 1, flexShrink: 1, overflow: 'scroll' }) },
                h('div', { 'data-testid': 'event-column', 'data-style': JSON.stringify(flat(contentContainerStyle)) }, children as any)),
        KeyboardAvoidingView: ({ children }: { children?: unknown }) => h('div', null, children as any),
        KeyboardStickyView: ({ children }: { children?: unknown }) => h('div', null, children as any),
    };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('expo-router', () => ({ router: { canGoBack: () => true, back: () => {}, replace: () => {}, push: () => {} }, ErrorBoundary: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('expo-image', async () => {
    const { createElement: h } = await import('react');
    return { Image: () => h('img') };
});
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/', writeAsStringAsync: async () => {}, EncodingType: { UTF8: 'utf8' }, getContentUriAsync: async (p: string) => `content://${p}` }));
vi.mock('expo-intent-launcher', () => ({ startActivityAsync: async () => {} }));
vi.mock('expo-sharing', () => ({ shareAsync: async () => {} }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid-1' }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.2.98' } } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: async (k: string) => (k === 'beanpool_anchor_url' ? 'https://mullum.example' : null), setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock('../../app/ThemeContext', async () => {
    const m: any = await import('../../constants/colors');
    const themed = () => ({ theme: themeIs.now, colors: themeIs.now === 'dark' ? m.darkColors : m.lightColors });
    return { useTheme: themed, useStyles: (f: any) => f(themed()) };
});
const ME = '9'.repeat(64);
const HOST = '7'.repeat(64);
const who = vi.hoisted(() => ({ key: '9'.repeat(64) }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: who.key, privateKey: '8'.repeat(64), callsign: 'Wren' } }) }));
const node = vi.hoisted(() => ({ view: null as any }));
vi.mock('../db', () => ({
    fetchEventDetail: async () => node.view,
    rsvpEvent: async () => ({ success: true, post: node.view }),
    deletePost: async () => {},
    reportAbuse: async () => ({ ok: true }),
    letInToEvent: async () => ({ success: true, post: node.view }),
    unpinPostOnNode: async () => {},
    fetchMemberPreferences: async () => ({}),
    fetchMyEvents: async () => [],
    setEventReminder: async () => {},
    isRouteMissing: () => false,
    getMemberRatings: async () => ({ ratings: [], average: 0, count: 0 }),
    getBalance: async () => null,
    getTreasuries: async () => [],
    fetchGroups: async () => [],
    setEventDateCancelled: async () => ({}),
}));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => ({ profile: 'local', checkedAt: '2026-11-04T00:00:00.000Z', features: { beans: true } }) }));
vi.mock('../haptics', () => ({ hapticTick: () => {} }));
vi.mock('../../components/MemberAvatar', async () => {
    const { createElement: h } = await import('react');
    return { MemberAvatar: () => h('img', { 'data-avatar': 'true', 'data-style': JSON.stringify({ width: 48, height: 48 }) }) };
});
// The carousel as the frame hands it: the height it was given, the corners it was given.
vi.mock('../../components/PhotoCarousel', async () => {
    const { createElement: h } = await import('react');
    return { PhotoCarousel: (p: { height?: number; borderRadius?: number }) => h('div', { 'data-testid': 'event-carousel', 'data-height': String(p.height), 'data-radius': String(p.borderRadius), 'data-style': JSON.stringify({ height: p.height }) }) };
});
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: () => null }));

import { MARKET_CARD_SHELL, seriesDateLabel } from '@beanpool/core';
import { EventDetail } from '../../components/EventDetail';
import { darkColors, lightColors } from '../../constants/colors';

const DAY = 86_400_000;
/** The Mullum market (Marty's shot, 4 Nov; §2.9's fixture): a two-line title, the third Saturday, a one-line place, one photo. */
const MULLUM = {
    id: '11111111-2222-4333-8444-555555555555', type: 'event', title: 'Mullumbimby Community Market',
    description: 'The farmers and community market at Summers Park: local food, plants, makers and music. Next date: Saturday.',
    author_pubkey: HOST, authorPublicKey: HOST, authorCallsign: 'Damo',
    eventStartAt: new Date(Date.now() + 9 * DAY).toISOString(), eventEndAt: new Date(Date.now() + 9 * DAY + 6 * 3_600_000).toISOString(),
    eventRepeat: { freq: 'monthly', interval: 1, byDay: 'SA', pos: 3 },
    eventPlaceName: 'Summers Park', lat: -28.5537, lng: 153.4994,
    photos: ['https://mullum.example/uploads/market.webp'], goingCount: 0, interestedCount: 0,
    tags: ['food'],
};
/**
 * What the node adds to a repeating event on a by-id read (packages/beanpool-engine/src/posts.ts, EVENT_NEXT_DATES = 6): its
 * next six dates, the event's own date first (the date its when line shows), then, as the market runs, the third Saturday of
 * each month after it ("Sat 19 Dec").
 */
function nextSixDates(start: Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    const dates = [`${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`];
    for (let m = 1; dates.length < 6; m++) {
        const first = new Date(Date.UTC(start.getFullYear(), start.getMonth() + m, 1));
        dates.push(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 15 + ((6 - first.getUTCDay() + 7) % 7))).toISOString().slice(0, 10));
    }
    return dates.map((date) => ({ date, startLocal: `${date}T08:00`, startAt: `${date}T08:00:00+10:00`, endAt: `${date}T14:00:00+10:00`, cancelled: false }));
}
const NEXT_DATES = nextSixDates(new Date(MULLUM.eventStartAt));
/** The Mullum market as the node sends it by id: the cached row and its six next dates. */
const BY_ID = { ...MULLUM, eventNextDates: NEXT_DATES };
const RSVPS = [{ memberPubkey: '1'.repeat(64), memberCallsign: 'Sam', status: 'going', updatedAt: '2026-11-01T00:00:00.000Z' }];

const THEMES = [['light', lightColors], ['dark', darkColors as unknown as typeof lightColors]] as const;
const RAW_VIOLETS = ['#7c3aed', '#f5f3ff', '#ddd6fe'];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    themeIs.now = 'light';
    who.key = ME;
    node.view = null;
    layouts.clear();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function draw(post: Record<string, unknown>, view: Record<string, unknown> | null = null) {
    node.view = view;
    await act(async () => { root.render(createElement(EventDetail, { post }) as any); });
    await settle();
}
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const styleOf = (el: Element | null | undefined): Record<string, any> => JSON.parse(el?.getAttribute('data-style') || '{}');
const spanWith = (text: string) => Array.from(host.querySelectorAll('span')).find((s) => s.textContent === text) as HTMLElement | undefined;
const buttonNamed = (name: string) => Array.from(host.querySelectorAll('[role="button"]'))
    .find((b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name) as HTMLElement | undefined;
const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

/** Yoga's layout of the whole screen, and an element's box in screen coordinates. */
function screen(): { layout: Layout; abs: (el: Element) => { left: number; top: number; width: number; height: number } } {
    const top = host.firstElementChild!;
    const layout = layOut(top, { width: 320, height: 569 }, { fontScale: 1.3 });
    const abs = (el: Element) => {
        const b = layout.box(el);
        let left = b.left; let y = b.top;
        for (let p = el.parentElement; p && p !== host; p = p.parentElement) {
            const pb = layout.box(p);
            left += pb.left; y += pb.top;
        }
        return { left, top: y, width: b.width, height: b.height };
    };
    return { layout, abs };
}

describe.each(THEMES)('the event page at 320 dp and 1.3× text, %s', (theme, colors) => {
    beforeEach(() => { themeIs.now = theme; });

    it('a member who has not answered: the chips, the loud lines, the 4:3 photo, then Going / Interested right under it', async () => {
        await draw(MULLUM, { ...BY_ID, myRsvp: null });
        // The card's chips, not the old badge: EVENT on the event's tile pair.
        const chip = byId('event-type-chip')!;
        expect(chip, 'the EVENT chip').toBeTruthy();
        expect(styleOf(chip).backgroundColor).toBe(colors.tile.event.tint);
        expect(styleOf(chip.querySelector('span')).color).toBe(colors.tile.event.ink);
        expect(styleOf(chip).borderRadius).toBe(6);
        // The when in the event's ink, 18/800; the title 20/800 in the heading.
        expect(styleOf(byId('event-when'))).toMatchObject({ fontSize: 18, fontWeight: '800', color: colors.event.ink });
        expect(styleOf(byId('event-title'))).toMatchObject({ fontSize: 20, fontWeight: '800', color: colors.text.heading });
        expect(host.textContent).toContain('↻ ');

        // Going is the first button after the loud lines. Their one button is the next dates' opener (the place's "Show on map"
        // is a link): the dates are part of the loud lines, above the photo.
        const title = byId('event-title')!;
        const going = buttonNamed('Going')!;
        const afterTitle = Array.from(host.querySelectorAll('[role="button"]')).filter((b) => before(title, b));
        expect(afterTitle[0], 'the first button after the title: the next dates, compact').toBe(byId('event-next-dates-open'));
        expect(before(afterTitle[0], byId('event-photo-frame')!), 'the dates above the photo').toBe(true);
        expect(afterTitle[1], 'the first button after the loud lines').toBe(going);
        expect(buttonNamed('Interested')).toBeTruthy();
        // Then Share, the description, the host's box, Report: the answer before the reading.
        const share = buttonNamed('Share this event')!;
        const description = spanWith(MULLUM.description)!;
        const hosted = spanWith('HOSTED BY')!;
        const report = buttonNamed('Report event')!;
        for (const [a, b, what] of [[going, share, 'Going, then Share'], [share, description, 'Share, then the description'],
            [description, hosted, 'the description, then HOSTED BY'], [hosted, report, 'HOSTED BY, then Report']] as const) {
            expect(before(a, b), what).toBe(true);
        }
        // No counts while nobody has answered (the card's rule).
        expect(byId('event-counts')).toBeNull();
        expect(host.textContent).not.toContain('0 going');

        const { abs } = screen();
        // The photo frame: 4:3 of the 288 dp column, under the column's corners.
        const frame = byId('event-photo-frame')!;
        expect(abs(frame).width).toBeCloseTo(288, 0);
        expect(abs(frame).height).toBeCloseTo(216, 0);
        expect(styleOf(frame)).toMatchObject({ borderRadius: MARKET_CARD_SHELL.radius, overflow: 'hidden' });
        // The answer row sits right under the photo (12 dp): nothing but the loud lines and the photo above it.
        expect(abs(going.parentElement!).top - (abs(frame).top + abs(frame).height)).toBeCloseTo(12, 0);
        // Both answers are 48 tall at least, side by side in the column.
        expect(abs(going).height).toBeGreaterThanOrEqual(48);
        expect(abs(going).top).toBeCloseTo(abs(buttonNamed('Interested')!).top, 0);
    });

    it('nothing is wider than the screen, and no raw violet is drawn anywhere', async () => {
        await draw(MULLUM, { ...BY_ID, myRsvp: 'going', goingCount: 3, interestedCount: 1, eventPrivateNote: 'Stall holders park behind the hall.' });
        const { abs } = screen();
        for (const el of Array.from(host.querySelectorAll('[data-style]'))) {
            // A Text inside a Text is part of its line, and laid out with it; a closed sheet is not on the page.
            if (el.closest('[data-modal]') || el.parentElement?.closest('span')) continue;
            const b = abs(el);
            if (b.width === 0 && b.height === 0) continue;
            expect(b.left + b.width, `${el.tagName} "${(el.textContent ?? '').slice(0, 40)}" ends at ${Math.round(b.left + b.width)}`).toBeLessThanOrEqual(320.5);
        }
        const styles = Array.from(host.querySelectorAll('[data-style]')).map((el) => el.getAttribute('data-style')!.toLowerCase()).join('\n');
        for (const hex of RAW_VIOLETS) expect(styles, hex).not.toContain(hex);
        // The spinner and the chosen words: white words on the one violet fill, from the library.
        expect(styles).not.toContain('"#fff"');
    });

    it('a member who is Going: the chosen answer on the event fill, the counts once someone has answered, the quiet row and the note as boxes', async () => {
        await draw(MULLUM, { ...BY_ID, myRsvp: 'going', goingCount: 3, interestedCount: 1, eventPrivateNote: 'Stall holders park behind the hall.' });
        const chosen = buttonNamed('Going, selected. Tap to clear')!;
        expect(chosen, 'the chosen answer').toBeTruthy();
        expect(styleOf(chosen)).toMatchObject({ backgroundColor: colors.event.fill, borderColor: colors.event.fill, minHeight: 48, borderRadius: 12 });
        expect(styleOf(chosen.querySelector('span'))).toMatchObject({ color: colors.event.on, fontSize: 15, fontWeight: '700' });
        expect(chosen.textContent).toBe('Going ✓');
        const other = buttonNamed('Interested')!;
        expect(styleOf(other)).toMatchObject({ borderColor: colors.event.ink, backgroundColor: colors.surface.card });
        expect(styleOf(other.querySelector('span')).color).toBe(colors.event.ink);
        // The counts, under the answers, once someone has answered.
        expect(byId('event-counts')!.textContent).toBe('👥 3 going · 1 interested');
        expect(before(chosen, byId('event-counts')!)).toBe(true);

        // The quiet row: the chat, Share, Add to calendar, in the neutral outline with the body's words.
        const row = byId('event-quiet-row')!;
        const quiet = [buttonNamed('Open event chat')!, buttonNamed('Share this event')!, buttonNamed('Add this event to your calendar')!];
        const { abs } = screen();
        for (const b of quiet) {
            expect(b, 'a quiet button').toBeTruthy();
            expect(row.contains(b)).toBe(true);
            expect(styleOf(b)).toMatchObject({ borderColor: colors.border.strong, backgroundColor: colors.surface.card, minHeight: 48, borderRadius: 12 });
            expect(styleOf(b.querySelector('span')).color).toBe(colors.text.body);
            expect(abs(b).height).toBeGreaterThanOrEqual(48);
            expect(abs(b).left + abs(b).width).toBeLessThanOrEqual(304.5);
        }
        // The chat's words are a sentence: its own line, whole. Share and Add to calendar size to their labels and wrap by whole
        // buttons, never cut: each label gets its natural width (yoga-dom-layout.ts's rule: 0.56 of the font size a character).
        expect(abs(quiet[0]).width).toBeCloseTo(288, 0);
        for (const b of quiet) {
            const label = b.querySelector('span')!;
            const natural = (label.textContent ?? '').length * styleOf(label).fontSize * 1.3 * 0.56;
            expect(abs(label).width, `"${label.textContent}" shown whole`).toBeGreaterThanOrEqual(natural - 0.5);
        }
        expect(abs(quiet[1]).top + abs(quiet[1]).height <= abs(quiet[2]).top || abs(quiet[1]).left + abs(quiet[1]).width <= abs(quiet[2]).left, 'no overlap').toBe(true);

        // The note for people who are going and the reminder: the style box's page box, the note's label in small capitals.
        for (const id of ['event-note-box', 'event-reminder-box']) {
            const box = byId(id)!;
            expect(box, id).toBeTruthy();
            expect(styleOf(box), id).toMatchObject({
                borderRadius: MARKET_CARD_SHELL.radius, borderWidth: MARKET_CARD_SHELL.borderWidth, padding: MARKET_CARD_SHELL.textPadding,
                borderColor: colors.border.default, backgroundColor: colors.surface.card,
            });
        }
        expect(styleOf(spanWith('NOTE FOR PEOPLE WHO ARE GOING'))).toMatchObject({ fontSize: 10, fontWeight: '800', letterSpacing: 1.5, color: colors.event.ink });
    });

    it('HOSTED BY is the page box, after the description; the grey "Hosted by" line is gone', async () => {
        await draw(MULLUM, { ...BY_ID, myRsvp: null });
        const label = spanWith('HOSTED BY')!;
        expect(label, 'the HOSTED BY label').toBeTruthy();
        expect(styleOf(label)).toMatchObject({ fontSize: 10, fontWeight: '800', letterSpacing: 1.5, color: colors.text.muted, marginBottom: 8 });
        const box = byId('event-host-open')!;
        expect(styleOf(box)).toMatchObject({ borderRadius: 14, padding: 12, marginHorizontal: 0, marginBottom: 16, backgroundColor: colors.surface.card });
        expect(host.textContent).not.toMatch(/Hosted by/);
        const { abs } = screen();
        expect(abs(box).width).toBeCloseTo(288, 0);
    });

    it('the host: their line in the event ink where the answer goes, and the guest list on the page box', async () => {
        who.key = HOST;
        await draw(MULLUM, { ...BY_ID, eventRsvps: RSVPS, goingCount: 1 });
        expect(buttonNamed('Going')).toBeUndefined();
        const hosting = spanWith("You're hosting this event")!;
        expect(styleOf(hosting).color).toBe(colors.event.ink);
        expect(byId('event-counts')!.textContent).toBe('👥 1 going · 0 interested');
        const box = byId('event-host-box')!;
        expect(styleOf(box)).toMatchObject({ borderRadius: MARKET_CARD_SHELL.radius, padding: MARKET_CARD_SHELL.textPadding, borderColor: colors.border.default });
        const edit = buttonNamed('Edit event')!;
        expect(styleOf(edit).backgroundColor).toBe(colors.event.fill);
        expect(styleOf(edit.querySelector('span')).color).toBe(colors.event.on);
        expect(buttonNamed('Report event')).toBeUndefined();
    });

    it('a repeating event: its next dates compact, the first and "and 5 more", one 48 dp button that opens all six', async () => {
        await draw(MULLUM, { ...BY_ID, myRsvp: null });
        const open = byId('event-next-dates-open')!;
        expect(open.getAttribute('role')).toBe('button');
        expect(open.textContent).toBe(`Next dates${seriesDateLabel(NEXT_DATES[0].date)}and 5 more`);
        expect(host.querySelectorAll('[data-testid="event-next-date"]')).toHaveLength(0);
        expect(styleOf(spanWith('and 5 more'))).toMatchObject({ color: colors.text.link, textDecorationLine: 'underline' });
        const { abs } = screen();
        expect(abs(open).height).toBeGreaterThanOrEqual(48);
        expect(abs(open).width).toBeCloseTo(288, 0);
        await act(async () => { open.click(); });
        await settle(2);
        expect(byId('event-next-dates-open')).toBeNull();
        expect(Array.from(host.querySelectorAll('[data-testid="event-next-date"]')).map((d) => d.textContent))
            .toEqual(NEXT_DATES.map((d) => seriesDateLabel(d.date)));
    });

    it("the host: the same compact line; opened, each date with the host's controls", async () => {
        who.key = HOST;
        await draw(MULLUM, { ...BY_ID, eventRsvps: RSVPS, goingCount: 1 });
        expect(host.querySelectorAll('[data-testid="event-date-cancel"]')).toHaveLength(0);
        await act(async () => { byId('event-next-dates-open')!.click(); });
        await settle(2);
        expect(host.querySelectorAll('[data-testid="event-date-cancel"]')).toHaveLength(6);
        expect(host.querySelectorAll('[data-testid="event-date-move"]')).toHaveLength(6);
    });

    it('no photo: the event tile, 3:1, inside the column; a cancelled event says so in a danger chip', async () => {
        await draw({ ...MULLUM, photos: [] }, { ...BY_ID, photos: [], eventState: 'cancelled', myRsvp: null });
        expect(byId('event-photo-frame')).toBeNull();
        const banner = byId('event-tile-banner')!;
        const { abs } = screen();
        expect(abs(banner).width).toBeCloseTo(288, 0);
        expect(abs(banner).height).toBeCloseTo(96, 0);
        expect(abs(banner).left).toBeCloseTo(16, 0);
        const state = byId('event-state-chip')!;
        expect(state.textContent).toBe('CANCELLED');
        expect(styleOf(state).backgroundColor).toBe(colors.feedback.danger.bg);
        expect(styleOf(byId('event-when')).textDecorationLine).toBe('line-through');
    });
});

/**
 * §2.9's stop condition for the frame (DP1: "Stop if the answer row's top passes 500 dp on the Mullum fixture at 1.3×; then the
 * frame goes to 3:2 before anything else"), measured on the Mullum market as the node sends it by id, with its six next dates
 * (the review of #2880, finding 1). The answer row's top, from the screen's top (the status bar's 24 included), on a 569 dp
 * screen:
 *
 *                                        a photo (4:3)   no photo (the tile, 3:1)
 *   no next dates (a one-off event)          586             466
 *   the six dates in full (opened)           700.3           580.3   (no photo: Going's bottom at 628, past the screen)
 *   the six dates compact (as drawn)         639.5           519.5   (no photo: Going's bottom at 567.5, on the screen)
 *
 * Compact, the dates take 53.5 dp, not 114.3: without a photo the whole answer row stays on the first screen. With a photo it
 * is not on the first screen, with the dates or without them, at 4:3 or at 3:2 (the status bar, the header as it is, the
 * column's padding, a two-line when and the 48 dp place row come to about 100 dp more than §2.9 counted). That is the frame
 * decision the PR asks for. `it.fails` keeps the stop in view: once a layout brings the row above 500 this case fails, and
 * becomes a plain `it`.
 */
const answerRowTop = (abs: ReturnType<typeof screen>['abs']) => abs(byId('event-action')!).top;
const openTheDates = async () => {
    const open = byId('event-next-dates-open');
    expect(open, 'the compact next dates').toBeTruthy();
    await act(async () => { open!.click(); });
    await settle(2);
};
describe('§2.9 stop condition, measured (OPEN with a photo: the PR asks)', () => {
    it.fails("the answer row's top is at or above 500 dp on the Mullum fixture at 320 × 569 and 1.3× text", async () => {
        await draw(MULLUM, { ...BY_ID, myRsvp: null });
        const rowTop = answerRowTop(screen().abs);
        expect(rowTop, `the answer row's top at ${Math.round(rowTop)} dp`).toBeLessThanOrEqual(500);
    });

    it('with no next dates (a one-off event): the row at 586 dp with a photo, 466 without', async () => {
        await draw(MULLUM, { ...MULLUM, myRsvp: null });
        expect(answerRowTop(screen().abs)).toBeCloseTo(586, 1);
        act(() => root.unmount());
        root = createRoot(host);
        const bare = { ...MULLUM, photos: [] };
        await draw(bare, { ...bare, myRsvp: null });
        expect(answerRowTop(screen().abs)).toBeCloseTo(466, 1);
    });

    it('with a photo: the row at 639.5 dp with the dates compact, 700.3 with all six open', async () => {
        await draw(MULLUM, { ...BY_ID, myRsvp: null });
        expect(answerRowTop(screen().abs)).toBeCloseTo(639.5, 1);
        await openTheDates();
        expect(answerRowTop(screen().abs)).toBeCloseTo(700.3, 1);
    });

    it('no photo: with the dates compact the whole answer row is on the first screen; all six open push it past the edge', async () => {
        const bare = { ...MULLUM, photos: [] };
        await draw(bare, { ...BY_ID, photos: [], myRsvp: null });
        let { abs } = screen();
        expect(answerRowTop(abs)).toBeCloseTo(519.5, 1);
        const going = () => abs(buttonNamed('Going')!);
        expect(going().top + going().height, "Going's bottom, on the 569 dp screen").toBeLessThanOrEqual(569);
        await openTheDates();
        ({ abs } = screen());
        expect(answerRowTop(abs)).toBeCloseTo(580.3, 1);
        expect(going().top + going().height, "opened, Going's bottom is past the screen").toBeGreaterThan(569);
    });
});

describe('the photo frame hands the carousel its own height', () => {
    it('once laid out, the carousel draws at the frame\'s height with the shell\'s corners', async () => {
        await draw(MULLUM, { ...BY_ID, myRsvp: null });
        expect(byId('event-carousel')).toBeNull();
        await act(async () => { layouts.get('event-photo-frame')!({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 216 } } }); });
        const carousel = byId('event-carousel')!;
        expect(carousel.getAttribute('data-height')).toBe('216');
        expect(carousel.getAttribute('data-radius')).toBe(String(MARKET_CARD_SHELL.radius));
    });
});
