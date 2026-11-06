// @vitest-environment jsdom
/**
 * The event page on the style box (DESIGN-detail-pages-fable.md §2 and §3 slice DP1; Marty, 4 Nov 2026: "All Fable's picks"):
 * components/EventDetail.tsx drawn for real, with what it draws (EventExtras' Share, Add to calendar and Remind me, the Share
 * button, the host's box), and laid out with Yoga (yoga-dom-layout.ts) at the floor: 320 dp wide, 569 tall, text at 1.3×, in
 * light and in dark. The Mullum market is the fixture (§2.9's): a two-line title, a repeat rule, a one-line place, a photo,
 * and, as the node sends it by id, its next six dates (drawn by the real EventNextDates, compact: the rule is their door,
 * DESIGN-web-dates-stop-fable.md §4).
 *
 * It proves the order (the when, the rule that opens the next dates, the title, the place, then the answer, before the photo,
 * Share, the description and the host: DESIGN-detail-pages-frame-fable.md §1.4), the 4:3 photo frame (288 × 216 in a 288 dp
 * column, 16 dp under the answer), where the answer row lands (the frame decision's stop, §2: its top ≤ 500 dp, its bottom
 * ≤ 569; see its block), the next dates behind the rule ("↻ Monthly, third Saturday · Next dates", one button that opens the
 * list, the rule then its heading), HOSTED BY as
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
/** What the page handed the carousel last (the photo opens whole, slice DP4: its onOpen). */
const carouselSaw = vi.hoisted(() => ({ props: null as null | { photos?: string[]; onOpen?: (index: number, uri: string) => void } }));
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
        if (props.source?.uri) attrs['data-src'] = props.source.uri; // an <Image>'s photo, so a case can say WHICH photo is drawn
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
    return { PhotoCarousel: (p: { height?: number; borderRadius?: number; photos?: string[]; onOpen?: (index: number, uri: string) => void }) => (carouselSaw.props = p, h('div', { 'data-testid': 'event-carousel', 'data-height': String(p.height), 'data-radius': String(p.borderRadius), 'data-style': JSON.stringify({ height: p.height }) })) };
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
    carouselSaw.props = null;
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

    it('a member who has not answered: the chips, the loud lines, Going / Interested, then the 4:3 photo under them', async () => {
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

        // The loud lines in the card's cluster: the when, then how it repeats as the door to the next dates (their one button),
        // then the title and the place (its "Show on map" is a link), then the answer: Going is the first button after the title.
        // The photo comes under the answer (DESIGN-detail-pages-frame-fable.md §1.4; DESIGN-web-dates-stop-fable.md §4):
        // when → the opener → title → place → Going → the photo → Share → description → HOSTED BY → Report.
        const when = byId('event-when')!;
        const opener = byId('event-next-dates-open')!;
        const title = byId('event-title')!;
        const place = spanWith('📍 Summers Park')!;
        const going = buttonNamed('Going')!;
        const frame = byId('event-photo-frame')!;
        expect(opener, "the rule, the next dates' door").toBeTruthy();
        expect(place, 'the place').toBeTruthy();
        const buttons = Array.from(host.querySelectorAll('[role="button"]'));
        expect(buttons.filter((b) => before(when, b) && before(b, title)), 'between the when and the title: the opener alone').toEqual([opener]);
        expect(buttons.filter((b) => before(title, b))[0], 'the first button after the title: the answer').toBe(going);
        // The rule is drawn once, in the opener: the caption's own line is gone.
        expect(host.querySelectorAll('[data-testid="event-repeat-caption"]')).toHaveLength(1);
        expect(opener.contains(byId('event-repeat-caption'))).toBe(true);
        expect(buttonNamed('Interested')).toBeTruthy();
        // Then the photo, Share, the description, the host's box, Report: the answer before the picture and the reading.
        const share = buttonNamed('Share this event')!;
        const description = spanWith(MULLUM.description)!;
        const hosted = spanWith('HOSTED BY')!;
        const report = buttonNamed('Report event')!;
        for (const [a, b, what] of [[when, opener, 'the when, then the opener'], [opener, title, 'the opener, then the title'],
            [title, place, 'the title, then the place'], [place, going, 'the place, then Going'],
            [going, frame, 'Going, then the photo'], [frame, share, 'the photo, then Share'], [share, description, 'Share, then the description'],
            [description, hosted, 'the description, then HOSTED BY'], [hosted, report, 'HOSTED BY, then Report']] as const) {
            expect(before(a, b), what).toBe(true);
        }
        // No counts while nobody has answered (the card's rule).
        expect(byId('event-counts')).toBeNull();
        expect(host.textContent).not.toContain('0 going');

        const { abs } = screen();
        // The photo frame: 4:3 of the 288 dp column, under the column's corners.
        expect(abs(frame).width).toBeCloseTo(288, 0);
        expect(abs(frame).height).toBeCloseTo(216, 0);
        expect(styleOf(frame)).toMatchObject({ borderRadius: MARKET_CARD_SHELL.radius, overflow: 'hidden' });
        // The photo sits 16 dp under the answer row (the action's own margin; the frame has none above it).
        const action = abs(byId('event-action')!);
        expect(abs(frame).top - (action.top + action.height), "the frame's top: the answer row's bottom + 16").toBeCloseTo(16, 0);
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

    it('a repeating event: the rule is the door, "↻ Monthly, third Saturday · Next dates", one 48 dp button that opens all six', async () => {
        await draw(MULLUM, { ...BY_ID, myRsvp: null });
        const open = byId('event-next-dates-open')!;
        expect(open.getAttribute('role')).toBe('button');
        // The rule, a dot, the link's words; no date and no "and 5 more" (they left the compact form). No label of its own: its
        // name is the words it shows (WCAG 2.5.3), the rule naming itself without the ↻.
        expect(open.textContent).toBe('↻ Monthly, third Saturday·Next dates');
        expect(open.getAttribute('aria-label')).toBeNull();
        expect(byId('event-repeat-caption')!.getAttribute('aria-label')).toBe('Monthly, third Saturday');
        expect(open.textContent).not.toContain(seriesDateLabel(NEXT_DATES[0].date));
        expect(host.textContent).not.toContain('and 5 more');
        expect(host.querySelectorAll('[data-testid="event-next-date"]')).toHaveLength(0);
        // The rule in the caption's own type, the link's words in the link's, the dot in the secondary ink.
        expect(styleOf(byId('event-repeat-caption'))).toMatchObject({ fontSize: 14, fontWeight: '700', color: colors.accent.primary });
        expect(styleOf(spanWith('Next dates'))).toMatchObject({ color: colors.text.link, textDecorationLine: 'underline' });
        expect(styleOf(spanWith('·')).color).toBe(colors.text.secondary);
        const { abs } = screen();
        expect(abs(open).width).toBeCloseTo(288, 0);
        // At 320 dp and 1.3× the rule and the link's words take two lines inside the 48: "Next dates" whole on the second.
        expect(abs(open).height).toBeCloseTo(48, 1);
        expect(abs(spanWith('Next dates')!).top).toBeGreaterThan(abs(byId('event-repeat-caption')!).top);
        await act(async () => { open.click(); });
        await settle(2);
        expect(byId('event-next-dates-open')).toBeNull();
        expect(Array.from(host.querySelectorAll('[data-testid="event-next-date"]')).map((d) => d.textContent))
            .toEqual(NEXT_DATES.map((d) => seriesDateLabel(d.date)));
        // Opened: the rule is the list's heading, "Next dates" the box's name; the rule still drawn once, "NEXT DATES" not at all.
        const box = byId('event-next-dates')!;
        expect(box.getAttribute('aria-label')).toBe('Next dates');
        const caption = byId('event-repeat-caption')!;
        expect(box.contains(caption)).toBe(true);
        expect(caption.getAttribute('role')).toBe('heading');
        expect(caption.textContent).toBe('↻ Monthly, third Saturday');
        expect(caption.getAttribute('aria-label')).toBe('Monthly, third Saturday');
        expect(host.querySelectorAll('[data-testid="event-repeat-caption"]')).toHaveLength(1);
        expect(spanWith('Next dates')).toBeUndefined();
        expect(before(byId('event-when')!, box) && before(box, byId('event-title')!), 'the list where the opener was').toBe(true);
    });

    it('one next date: no opener, the rule heads the one date; no dates from the node: the rule alone, once, in the same place', async () => {
        await draw(MULLUM, { ...MULLUM, eventNextDates: NEXT_DATES.slice(0, 1), myRsvp: null });
        expect(byId('event-next-dates-open')).toBeNull();
        const box = byId('event-next-dates')!;
        expect(box.getAttribute('aria-label')).toBe('Next dates');
        expect(byId('event-repeat-caption')!.getAttribute('role')).toBe('heading');
        expect(Array.from(host.querySelectorAll('[data-testid="event-next-date"]')).map((d) => d.textContent)).toEqual([seriesDateLabel(NEXT_DATES[0].date)]);
        act(() => root.unmount());
        root = createRoot(host);
        // An older node, or the cached row before the node answers: the rule where the door goes, between the when and the title.
        await draw(MULLUM, { ...MULLUM, myRsvp: null });
        expect(byId('event-next-dates-open')).toBeNull();
        expect(byId('event-next-dates')).toBeNull();
        const alone = host.querySelectorAll('[data-testid="event-repeat-caption"]');
        expect(alone).toHaveLength(1);
        expect(alone[0].textContent).toBe('↻ Monthly, third Saturday');
        expect(styleOf(alone[0])).toMatchObject({ fontSize: 14, fontWeight: '700', color: colors.accent.primary });
        expect(before(byId('event-when')!, alone[0]) && before(alone[0], byId('event-title')!)).toBe(true);
    });

    it("the host: the same door; opened, each date with the host's controls", async () => {
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
 * The stop (DESIGN-detail-pages-frame-fable.md §2, which replaces §2.9's): on the Mullum fixture as the node sends it by id, at
 * 320 × 569 with the text at 1.3× (the status bar's 24 included), with a photo, without, and with the six dates opened, the
 * answer's top is at or under 500 dp and its bottom (Going's) on the 569 dp screen. The photo is under the answer (§1.4), so
 * the answer no longer moves with the picture. The answer row's top, and Going's bottom, from the screen's top:
 *
 *                                        a photo (4:3)              no photo (the tile, 3:1)
 *   the six dates behind the rule        387.25  · Going 435.25     387.25  · Going 435.25
 *   the six dates opened                 451.125 · Going 499.125    451.125 · Going 499.125
 *   no next dates (the rule alone)       362     · Going 410        362     · Going 410
 *
 * The rule became the dates' door (DESIGN-web-dates-stop-fable.md §4; #2880 drew 415.5 / 476.25 / 362): compact, the caption's
 * own line (22.75 + 4) left and the opener is 48 where the "NEXT DATES / Sat 14 Nov · and 5 more" button was 49.5 (−28.25);
 * opened, the caption's line left and the rule (22.75) heads the list where "NEXT DATES" (21.125) did (−25.125); with no dates
 * the rule is drawn alone, as the caption was, in the same place. Before the photo moved under the answer (#2880) the row was
 * at 639.5 / 700.3 / 586 with a photo and 519.5 / 580.3 / 466 without.
 */
const answerRowTop = (abs: ReturnType<typeof screen>['abs']) => abs(byId('event-action')!).top;
const goingBottom = (abs: ReturnType<typeof screen>['abs']) => { const b = abs(buttonNamed('Going')!); return b.top + b.height; };
const openTheDates = async () => {
    const open = byId('event-next-dates-open');
    expect(open, 'the compact next dates').toBeTruthy();
    await act(async () => { open!.click(); });
    await settle(2);
};
describe("the stop, measured: the answer's top ≤ 500 dp and its bottom ≤ 569 at 320 × 569 and 1.3× text", () => {
    it("the answer row's top is at or above 500 dp on the Mullum fixture with a photo, and Going is whole on the first screen", async () => {
        await draw(MULLUM, { ...BY_ID, myRsvp: null });
        const { abs } = screen();
        const rowTop = answerRowTop(abs);
        expect(rowTop, `the answer row's top at ${Math.round(rowTop)} dp`).toBeLessThanOrEqual(500);
        expect(goingBottom(abs), "Going's bottom, on the 569 dp screen").toBeLessThanOrEqual(569);
    });

    it('with a photo: the row at 387.25 dp with the dates behind the rule, 451.125 with all six open; Going on the screen in both', async () => {
        await draw(MULLUM, { ...BY_ID, myRsvp: null });
        let { abs } = screen();
        expect(answerRowTop(abs)).toBeCloseTo(387.25, 1);
        expect(goingBottom(abs)).toBeCloseTo(435.25, 1);
        await openTheDates();
        ({ abs } = screen());
        expect(answerRowTop(abs)).toBeCloseTo(451.125, 1);
        expect(goingBottom(abs), "opened, Going's bottom is still on the 569 dp screen").toBeLessThanOrEqual(569);
        expect(goingBottom(abs)).toBeCloseTo(499.125, 1);
    });

    it('no photo: the same 387.25 behind the rule and 451.125 opened; the answer does not move with the picture', async () => {
        const bare = { ...MULLUM, photos: [] };
        await draw(bare, { ...BY_ID, photos: [], myRsvp: null });
        let { abs } = screen();
        expect(answerRowTop(abs)).toBeCloseTo(387.25, 1);
        expect(goingBottom(abs)).toBeCloseTo(435.25, 1);
        await openTheDates();
        ({ abs } = screen());
        expect(answerRowTop(abs)).toBeCloseTo(451.125, 1);
        expect(goingBottom(abs), "opened, Going's bottom is on the 569 dp screen").toBeLessThanOrEqual(569);
        expect(goingBottom(abs)).toBeCloseTo(499.125, 1);
    });

    it('with no next dates (the rule alone, as an older node sends it): the row at 362 dp with a photo and without; Going on the screen', async () => {
        await draw(MULLUM, { ...MULLUM, myRsvp: null });
        let { abs } = screen();
        expect(answerRowTop(abs)).toBeCloseTo(362, 1);
        expect(goingBottom(abs)).toBeCloseTo(410, 1);
        act(() => root.unmount());
        root = createRoot(host);
        const bare = { ...MULLUM, photos: [] };
        await draw(bare, { ...bare, myRsvp: null });
        ({ abs } = screen());
        expect(answerRowTop(abs)).toBeCloseTo(362, 1);
        expect(goingBottom(abs)).toBeCloseTo(410, 1);
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

// The photo opens whole (DESIGN-detail-pages-fable.md §2.6, slice DP4; Marty, 7 Nov): the page hands the carousel onOpen, and a
// photo it names opens in the chat's full-screen viewer, the photo's own URL (no second size exists: memory photos-stay-800px).
// The carousel's half (the button, the index, the URL) is proved in photo-carousel-open-render.test.ts.
describe('the photo opens whole', () => {
    const viewer = () => host.querySelector('[data-modal]');
    const viewed = () => viewer()?.querySelector('img[aria-label="Full-size photo"]')?.getAttribute('data-src') ?? null;
    const openFrame = async () => {
        await draw(MULLUM, { ...BY_ID, myRsvp: null });
        await act(async () => { layouts.get('event-photo-frame')!({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 216 } } }); });
    };

    it("the page gives the carousel onOpen; a photo it names opens whole with its own URL, and Close photo closes it", async () => {
        await openFrame();
        expect(typeof carouselSaw.props?.onOpen).toBe('function');
        expect(viewer()).toBeNull();
        await act(async () => { carouselSaw.props!.onOpen!(0, MULLUM.photos[0]); });
        expect(viewed()).toBe('https://mullum.example/uploads/market.webp');
        await act(async () => { buttonNamed('Close photo')!.click(); });
        expect(viewer()).toBeNull();
    });

    it('a tap anywhere on the open photo closes it too', async () => {
        await openFrame();
        await act(async () => { carouselSaw.props!.onOpen!(0, MULLUM.photos[0]); });
        expect(viewer()).not.toBeNull();
        await act(async () => { buttonNamed('Dismiss full-size photo')!.click(); });
        expect(viewer()).toBeNull();
    });
});
