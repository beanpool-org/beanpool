// @vitest-environment jsdom
/**
 * Slice N2b on the event page (DESIGN-notify-and-backup-asks-fable-amend2.md §6, §12.3; amend1 §4.3): components/EventDetail.tsx
 * drawn for real, with EventExtras' reminder box, at the floor (320 dp wide, 569 tall, text at 1.3x, laid out with Yoga:
 * yoga-dom-layout.ts), in light and dark. Nothing about notifications is mocked but the phone itself: this phone's record is
 * read from its key (utils/notification-permission.ts, core's rule) and the phone's answer is expo-notifications'.
 *
 * - **The named line, one table:** (Going, Interested) x (never asked, Later today on the join's screen, Later today on the
 *   once card, Later yesterday, the phone's no on Android 13+, an iPhone's Don't Allow, allowed, Android 8 to 12) -> "Get a
 *   reminder the day before, and hear if it changes." (Interested: "Get a reminder the day before.") under the answer, or no
 *   line. Each shown row is red without the line (the page draws it). Offering asks nothing: the phone's pop-up never comes.
 * - **Tell me** turns them on (the line says so, and the reminder box says Remind me again); un-answering hides the line; a
 *   page covered by another screen loses it.
 * - **The true line:** while the phone can't notify, the reminder box says "⏰ Reminders need notifications on." [Turn on]
 *   in place of "⏰ Remind me: …", in every state of the record, after the phone's no too; Turn on brings the phone's pop-up
 *   where it can still ask, else the one line before the phone's settings. Allowed, or Android 8 to 12: Remind me as it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { layOut } from './yoga-dom-layout';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const themeIs = vi.hoisted(() => ({ now: 'light' as 'light' | 'dark' }));
/** The one line before the phone's settings (utils/notification-permission.ts settingsPrompt), and the settings opened. */
const rn = vi.hoisted(() => ({ alerts: [] as Array<{ title: string; body?: string; buttons?: Array<{ text: string; onPress?: () => void }> }>, openSettings: vi.fn(async () => {}) }));
vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', checkbox: 'checkbox' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(8).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID, disabled, style, numberOfLines } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (disabled || accessibilityState?.disabled) attrs['aria-disabled'] = 'true';
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
        StatusBar: { pushStackEntry: () => ({}), popStackEntry: () => {} },
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: absolute, absoluteFillObject: absolute, flatten: (s: unknown) => flat(s) },
        Alert: { alert: (title: string, body?: string, buttons?: Array<{ text: string; onPress?: () => void }>) => { rn.alerts.push({ title, body, buttons }); } },
        Share: { share: async () => ({}) },
        Linking: { openURL: async () => {}, openSettings: rn.openSettings },
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
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.4.8' } } }));
/** The phone's storage: this phone's notifications record under its own key, and the community's address. */
const mem = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => (k === 'beanpool_anchor_url' ? 'https://riverside.example' : mem.map.get(k) ?? null),
        setItem: async (k: string, v: string) => { mem.map.set(k, v); },
        removeItem: async (k: string) => { mem.map.delete(k); },
    },
}));
/** The phone's own answer (null: notifications can't load here), and what its pop-up answers when asked. */
const phone = vi.hoisted(() => ({ now: null as null | { status: string; canAskAgain: boolean }, popUp: 'granted' as string }));
const notif = vi.hoisted(() => ({
    getPermissionsAsync: vi.fn(async () => { if (!phone.now) throw new Error('no notifications on this build'); return phone.now; }),
    requestPermissionsAsync: vi.fn(async () => {
        phone.now = { status: phone.popUp, canAskAgain: phone.popUp !== 'denied' };
        return { status: phone.popUp };
    }),
}));
vi.mock('expo-notifications', () => ({ default: notif, ...notif }));
vi.mock('../../services/push-notifications', () => ({ registerForPushNotifications: vi.fn(async () => null) }));
vi.mock('../../app/ThemeContext', async () => {
    const m: any = await import('../../constants/colors');
    const themed = () => ({ theme: themeIs.now, colors: themeIs.now === 'dark' ? m.darkColors : m.lightColors });
    return { useTheme: themed, useStyles: (f: any) => f(themed()) };
});
const ME = '9'.repeat(64);
const HOST = '7'.repeat(64);
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: '9'.repeat(64), privateKey: '8'.repeat(64), callsign: 'Wren' } }) }));
const node = vi.hoisted(() => ({ view: null as any }));
vi.mock('../db', () => ({
    fetchEventDetail: async () => node.view,
    rsvpEvent: async (_id: string, status: string | null) => {
        node.view = { ...node.view, myRsvp: status, goingCount: status === 'going' ? 1 : 0, interestedCount: status === 'interested' ? 1 : 0 };
        return { success: true, post: node.view };
    },
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
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => ({ profile: 'local', checkedAt: '2026-11-21T00:00:00.000Z', features: { beans: true } }) }));
vi.mock('../haptics', () => ({ hapticTick: () => {} }));
vi.mock('../../components/MemberAvatar', async () => {
    const { createElement: h } = await import('react');
    return { MemberAvatar: () => h('img', { 'data-avatar': 'true', 'data-style': JSON.stringify({ width: 48, height: 48 }) }) };
});
vi.mock('../../components/PhotoCarousel', async () => {
    const { createElement: h } = await import('react');
    return { PhotoCarousel: (p: { height?: number }) => h('div', { 'data-testid': 'event-carousel', 'data-style': JSON.stringify({ height: p.height }) }) };
});
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: () => null }));

import { localDay } from '@beanpool/core';
import { EventDetail } from '../../components/EventDetail';
import { NOTIFICATION_PERMISSION_STORE_KEY } from '../storage-keys';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A working bee next week at a hall: no photo, so its tile stands in. */
const EVENT = {
    id: '11111111-2222-4333-8444-555555555555', type: 'event', title: 'Working bee at the hall',
    description: 'Bring gloves.', author_pubkey: HOST, authorPublicKey: HOST, authorCallsign: 'Asha',
    eventStartAt: new Date(Date.now() + 7 * DAY).toISOString(), eventEndAt: new Date(Date.now() + 7 * DAY + 3 * HOUR).toISOString(),
    eventPlaceName: 'Riverside hall', lat: -28.5, lng: 153.5, photos: [], goingCount: 0, interestedCount: 0,
};

const ASK = { status: 'undetermined', canAskAgain: true };
const ANDROID_NO = { status: 'denied', canAskAgain: true };
const IPHONE_NO = { status: 'denied', canAskAgain: false };
const ON = { status: 'granted', canAskAgain: true };

/** [state, the phone's answer, this phone's record (as stored), a named line?, the true reminder line?] */
function states(): Array<[string, typeof ASK | null, Record<string, unknown> | null, boolean, boolean]> {
    const now = Date.now();
    const today = localDay(new Date(now));
    const yesterday = localDay(new Date(now - DAY));
    return [
        ['never asked', ASK, null, true, true],
        ["Later today on the join's screen (its day still allows one line)", ASK, { state: 'unanswered', updatedAt: 0, askDay: today, askKind: 'join', joinAt: now - 2 * HOUR, laterAt: now - HOUR }, true, true],
        ["Later today on Home's once card (the day is taken)", ASK, { state: 'unanswered', updatedAt: 0, askDay: today, askKind: 'once', onceAt: now - 2 * HOUR, onceClosedAt: now - HOUR, laterAt: now - HOUR }, false, true],
        ['Later yesterday', ASK, { state: 'unanswered', updatedAt: 0, askDay: yesterday, askKind: 'join', joinAt: now - DAY, laterAt: now - DAY }, true, true],
        ["the phone said no (Android 13+'s first, recorded)", ANDROID_NO, { state: 'unanswered', updatedAt: 0, phoneNoAt: now - DAY }, false, true],
        ["the phone said no (an iPhone's Don't Allow)", IPHONE_NO, { state: 'unanswered', updatedAt: 0, phoneNoAt: now - 3 * DAY }, false, true],
        ['allowed through one of our asks', ON, { state: 'granted', updatedAt: now - DAY }, false, false],
        ['Android 8 to 12 (allowed without asking)', ON, null, false, false],
    ];
}

const WORDS = {
    going: { line: 'Get a reminder the day before, and hear if it changes.', done: "You'll get a reminder the day before, and hear if it changes.", button: 'Going' },
    interested: { line: 'Get a reminder the day before.', done: "You'll get a reminder the day before.", button: 'Interested' },
} as const;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    themeIs.now = 'light';
    mem.map.clear();
    phone.now = ASK;
    phone.popUp = 'granted';
    rn.alerts.length = 0;
    rn.openSettings.mockClear();
    notif.requestPermissionsAsync.mockClear();
    node.view = null;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function draw(myRsvp: string | null = null, showing = true) {
    node.view = { ...EVENT, myRsvp };
    await act(async () => { root.render(createElement(EventDetail, { post: EVENT, showing }) as any); });
    await settle();
}
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const buttonNamed = (name: string) => Array.from(host.querySelectorAll('[role="button"]'))
    .find((b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name) as HTMLElement | undefined;
async function tap(el: HTMLElement | null | undefined, what: string) {
    expect(el, what).toBeTruthy();
    await act(async () => { el!.click(); });
    await settle();
}
const stored = () => JSON.parse(mem.map.get(NOTIFICATION_PERMISSION_STORE_KEY) ?? 'null');

/** Every drawn box inside the 320 dp screen (Yoga at 1.3x text). */
function insideTheScreen() {
    const layout = layOut(host.firstElementChild!, { width: 320, height: 569 }, { fontScale: 1.3 });
    for (const el of Array.from(host.querySelectorAll('[data-style]'))) {
        if (el.closest('[data-modal]') || el.parentElement?.closest('span')) continue;
        let left = layout.box(el).left;
        for (let p = el.parentElement; p && p !== host; p = p.parentElement) left += layout.box(p).left;
        const b = layout.box(el);
        if (b.width === 0 && b.height === 0) continue;
        expect(left + b.width, `${el.tagName} "${(el.textContent ?? '').slice(0, 40)}" ends at ${Math.round(left + b.width)}`).toBeLessThanOrEqual(320.5);
    }
}

describe('the named line under the answer: (Going, Interested) x the phone and its record (slice N2b)', () => {
    for (const kind of ['going', 'interested'] as const) {
        for (const [state, said, record, shown] of states()) {
            it(`${WORDS[kind].button} × ${state}: ${shown ? 'the line' : 'no line'}; the phone's pop-up never comes`, async () => {
                phone.now = said;
                if (record) mem.map.set(NOTIFICATION_PERMISSION_STORE_KEY, JSON.stringify(record));
                await draw();
                expect(byId('notify-line'), 'nothing before the tap').toBeNull();
                await tap(buttonNamed(WORDS[kind].button), WORDS[kind].button);

                const line = byId('notify-line');
                // Offering asks nothing: only a tap on Tell me brings the phone's pop-up.
                expect(notif.requestPermissionsAsync).not.toHaveBeenCalled();
                expect(rn.alerts).toEqual([]);
                if (!shown) {
                    expect(line).toBeNull();
                    return;
                }
                expect(line?.textContent).toContain(WORDS[kind].line);
                // Under the answer: inside its block, after both buttons.
                expect(byId('event-action')!.contains(line)).toBe(true);
                const interested = buttonNamed('Interested') ?? buttonNamed('Interested ✓') ?? Array.from(host.querySelectorAll('[role="button"]')).find((b) => b.textContent?.startsWith('Interested'));
                expect(!!(interested!.compareDocumentPosition(line!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
                // It takes the day and its kind.
                expect(stored()).toMatchObject({ askKind: 'line', lines: expect.arrayContaining([kind]) });
            });
        }
    }

    for (const theme of ['light', 'dark'] as const) {
        it(`${theme}: at 320 dp and 1.3x the line and its Tell me stay inside the screen, and Tell me turns them on`, async () => {
            themeIs.now = theme;
            await draw();
            await tap(buttonNamed('Going'), 'Going');
            expect(byId('notify-line')?.textContent).toContain(WORDS.going.line);
            insideTheScreen();
            // The true line stands too (the phone can't notify yet): a state, not a second ask.
            expect(byId('event-reminders-off')?.textContent).toContain('⏰ Reminders need notifications on.');

            await tap(byId('notify-line-tell-me'), 'Tell me');
            expect(notif.requestPermissionsAsync).toHaveBeenCalledTimes(1);
            expect(byId('notify-line-done')?.textContent).toContain(WORDS.going.done);
            // Allowed: the reminder box is the reminder again.
            expect(byId('event-reminders-off')).toBeNull();
            expect(byId('event-reminder-box')?.textContent).toContain('⏰ Remind me:');
            insideTheScreen();
        });
    }

    it('un-answering takes the line away; answering again in the same visit brings back the one already shown', async () => {
        await draw();
        await tap(buttonNamed('Interested'), 'Interested');
        expect(byId('notify-line')?.textContent).toContain(WORDS.interested.line);
        const chosen = Array.from(host.querySelectorAll('[role="button"]')).find((b) => b.textContent?.startsWith('Interested')) as HTMLElement;
        await tap(chosen, 'Interested, chosen');
        expect(byId('notify-line')).toBeNull();
    });

    it('a page covered by another screen loses its line for good (leaving is the no)', async () => {
        await draw();
        await tap(buttonNamed('Going'), 'Going');
        expect(byId('notify-line')).toBeTruthy();
        await act(async () => { root.render(createElement(EventDetail, { post: EVENT, showing: false }) as any); });
        await settle();
        expect(byId('notify-line')).toBeNull();
        await act(async () => { root.render(createElement(EventDetail, { post: EVENT, showing: true }) as any); });
        await settle();
        expect(byId('notify-line')).toBeNull();
    });

    it('a refused save brings no line', async () => {
        await draw();
        const db = await import('../db');
        const spy = vi.spyOn(db, 'rsvpEvent').mockRejectedValueOnce(new Error('Could not reach the node.'));
        await tap(buttonNamed('Going'), 'Going');
        expect(byId('notify-line')).toBeNull();
        spy.mockRestore();
    });
});

describe("the reminder's true line, in every state (slice N2b)", () => {
    for (const [state, said, record, , off] of states()) {
        it(`Going × ${state}: ${off ? '"⏰ Reminders need notifications on." [Turn on]' : '"⏰ Remind me: …"'}`, async () => {
            phone.now = said;
            if (record) mem.map.set(NOTIFICATION_PERMISSION_STORE_KEY, JSON.stringify(record));
            await draw('going');
            const box = byId('event-reminder-box');
            expect(box, 'the reminder box').toBeTruthy();
            if (off) {
                expect(byId('event-reminders-off')?.textContent).toBe('⏰ Reminders need notifications on.Turn on');
                expect(box!.textContent).not.toContain('Remind me');
                expect(buttonNamed('Change the reminder for this event')).toBeUndefined();
            } else {
                expect(byId('event-reminders-off')).toBeNull();
                expect(box!.textContent).toContain('⏰ Remind me: 1 day before (your default)');
            }
        });
    }

    it('nothing to turn on here (no notifications on this build): Remind me as it was', async () => {
        phone.now = null;
        await draw('interested');
        expect(byId('event-reminders-off')).toBeNull();
        expect(byId('event-reminder-box')?.textContent).toContain('⏰ Remind me:');
    });

    for (const theme of ['light', 'dark'] as const) {
        it(`${theme}: Turn on where the phone can still ask brings its pop-up; allowed, Remind me comes back; inside 320 dp at 1.3x`, async () => {
            themeIs.now = theme;
            await draw('going');
            insideTheScreen();
            await tap(byId('event-reminders-turn-on'), 'Turn on');
            expect(notif.requestPermissionsAsync).toHaveBeenCalledTimes(1);
            expect(stored()).toMatchObject({ state: 'granted' });
            expect(byId('event-reminders-off')).toBeNull();
            expect(byId('event-reminder-box')?.textContent).toContain('⏰ Remind me:');
        });
    }

    it("Turn on after an iPhone's Don't Allow: the one line before the phone's settings, and Open Settings goes there; the true line stays", async () => {
        phone.now = IPHONE_NO;
        mem.map.set(NOTIFICATION_PERMISSION_STORE_KEY, JSON.stringify({ state: 'unanswered', updatedAt: 0, phoneNoAt: Date.now() - DAY }));
        await draw('going');
        await tap(byId('event-reminders-turn-on'), 'Turn on');
        expect(notif.requestPermissionsAsync).not.toHaveBeenCalled();
        expect(rn.alerts).toHaveLength(1);
        expect(rn.alerts[0].body).toBe("Notifications are off for BeanPool in your phone's settings. Open Settings to turn them on.");
        await act(async () => { rn.alerts[0].buttons!.find((b) => b.text === 'Open Settings')!.onPress!(); });
        await settle();
        expect(rn.openSettings).toHaveBeenCalledTimes(1);
        expect(byId('event-reminders-off')).toBeTruthy();
    });

    it("Turn on and the phone says no: the true line stays, and the phone's no is recorded", async () => {
        phone.popUp = 'denied';
        await draw('going');
        await tap(byId('event-reminders-turn-on'), 'Turn on');
        expect(notif.requestPermissionsAsync).toHaveBeenCalledTimes(1);
        expect(stored()).toMatchObject({ phoneNoAt: expect.any(Number) });
        expect(byId('event-reminders-off')?.textContent).toContain('⏰ Reminders need notifications on.');
    });

    it('the host has no reminder box, so no true line either', async () => {
        node.view = { ...EVENT, authorPublicKey: ME, author_pubkey: ME, eventRsvps: [] };
        await act(async () => { root.render(createElement(EventDetail, { post: { ...EVENT, authorPublicKey: ME, author_pubkey: ME } }) as any); });
        await settle();
        expect(byId('event-reminder-box')).toBeNull();
        expect(byId('event-reminders-off')).toBeNull();
    });
});
