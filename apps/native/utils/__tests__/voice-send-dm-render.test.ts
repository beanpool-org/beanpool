// @vitest-environment jsdom
/**
 * A voice message from a direct chat (app/chat/[id].tsx sendVoice), rendered for real: the harness of
 * dm-requests-chat-render.test.ts (React Native's host components as plain tags, utils/db as the net-spy stand-in), with a
 * composer that hands over the screen's onVoice, so the test is the recorder calling it.
 *
 * PR #3112 review, round 2:
 *   - [id].tsx:886: a refusal the screen shows above the box (refusedSendNotice: not locked yet, the key changed, the pins or
 *     the key store unreadable just now) returned normally, so the recorder deleted the recording as if sent. It now throws
 *     VoiceNotSentError after setting the notice: the recorder keeps it (voice-composer-render.test.ts), adding no word.
 *   - db.ts:7448: each try made a new line id, so a Send after the 60 s timeout was the voice message twice. The recording's
 *     own line id goes to sendVoiceMessage as its messageId on every try, with a signal that gives the send up for real.
 *
 * Byron, 14 Nov: a voice message sent to a node from before voice V2 was stored as a text line carrying a sound, an empty
 * bubble on the other phone. The microphone shows only where the community says `features.voiceLines: true` (core
 * voiceLinesOn), read from this phone's copy of the community as every other switch is (utils/use-node-profile.ts); a
 * recording that would still go where it isn't said is kept, not sent, and the chat says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The shipped pictures' requires (utils/bundled-avatars.ts, through MemberAvatar and the picture sheet) load as a number.
vi.hoisted(() => {
    const Loader = (process as any).getBuiltinModule('node:module');
    Loader._extensions['.jpg'] = (m: { exports: unknown }) => { m.exports = 1; };
});
import Module from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as string[], opened: [] as string[] }));
/** The composer's box and Send, and the screen's DeviceEventEmitter listeners, as the stand-ins below hand them over. */
const composer = vi.hoisted(() => ({ type: null as null | ((t: string) => void), send: null as null | (() => void) }));
const events = vi.hoisted(() => ({ on: {} as Record<string, Set<() => void>> }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', alert: 'alert', progressbar: 'progressbar' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, numberOfLines, adjustsFontSizeToFit, minimumFontScale, onLayout, value, onChangeText, disabled } = props;
        if (onChangeText && placeholder) composer.type = onChangeText;
        if (accessibilityLabel === 'Send message') composer.send = () => onPress?.();
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (adjustsFontSizeToFit) attrs['data-shrinks'] = 'true';
        if (minimumFontScale !== undefined) attrs['data-min-scale'] = String(minimumFontScale);
        const s = flat(props.style);
        if (s.flexWrap) attrs['data-wrap'] = s.flexWrap;
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    const FlatList = ({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent, ListEmptyComponent }: Record<string, any>) => createElement('div', null,
        ListHeaderComponent,
        (data ?? []).length
            ? data.map((item: any, index: number) => createElement(Fragment, { key: keyExtractor ? keyExtractor(item, index) : index }, renderItem({ item, index })))
            : ListEmptyComponent,
        ListFooterComponent);
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        FlatList,
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), SafeAreaView: el('div'), RefreshControl: () => null, ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: { alert: (title: string, body?: string, buttons?: Array<{ text?: string }>) => { alerts.said.push(title); if (body) alerts.said.push(body); for (const b of buttons ?? []) if (b.text) alerts.said.push(b.text); } },
        Share: { share: async () => ({}) },
        Linking: { openURL: async (url: string) => { alerts.opened.push(url); }, openSettings: async () => {} },
        DeviceEventEmitter: {
            addListener: (name: string, fn: () => void) => { (events.on[name] ??= new Set()).add(fn); return { remove() { events.on[name]?.delete(fn); } }; },
            emit() {},
        },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        AccessibilityInfo: { announceForAccessibility: () => {}, isScreenReaderEnabled: async () => false, isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
        Keyboard: { addListener: listener, dismiss() {} },
        LayoutAnimation: { configureNext() {}, create: () => ({}), Presets: { easeInEaseOut: {} } },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const params = vi.hoisted(() => ({ now: {} as Record<string, string> }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push() {}, navigate() {}, replace() {}, back() {}, setParams() {}, canGoBack: () => true },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useLocalSearchParams: () => params.now,
        Stack: { Screen: () => null },
        ErrorBoundary: () => null,
    };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-image-picker', () => ({ requestCameraPermissionsAsync: async () => ({ granted: false }), launchCameraAsync: async () => ({ canceled: true }), launchImageLibraryAsync: async () => ({ canceled: true }) }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: async () => ({}), SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, notificationAsync: async () => {}, selectionAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {}, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, WHEN_UNLOCKED: 2, AFTER_FIRST_UNLOCK: 3 }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), randomUUID: () => 'a-uuid' };
});
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/', documentDirectory: '/tmp/doc/', getInfoAsync: async () => ({ exists: false }), deleteAsync: async () => {}, writeAsStringAsync: async () => {}, readAsStringAsync: async () => '', makeDirectoryAsync: async () => {} }));
vi.mock('expo-file-system', () => ({}));
vi.mock('expo-local-authentication', () => ({ SecurityLevel: { NONE: 0 }, hasHardwareAsync: async () => false, isEnrolledAsync: async () => false, authenticateAsync: async () => ({ success: false }) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => true }));
vi.mock('expo-linking', () => ({ createURL: (p: string) => `beanpool://${p}`, openURL: async () => {} }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: async () => ({}), maybeCompleteAuthSession: () => {} }));
vi.mock('expo-apple-authentication', () => ({}));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('expo-notifications', () => ({}));
vi.mock('expo-device', () => ({}));
vi.mock('expo-location', () => ({ getForegroundPermissionsAsync: async () => ({ status: 'denied' }) }));
vi.mock('react-native-worklets', () => ({ scheduleOnRN: (fn: (...a: unknown[]) => void, ...a: unknown[]) => fn(...a) }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('react-native-keyboard-controller', () => {
    const pass = ({ children }: { children?: unknown }) => createElement('div', null, children as any);
    return {
        KeyboardAvoidingView: pass, KeyboardAwareScrollView: pass, KeyboardController: { dismiss: async () => {}, setInputMode: () => {}, setDefaultMode: () => {} },
        AndroidSoftInputModes: {}, useKeyboardState: (pick?: (s: { isVisible: boolean; height: number }) => unknown) => (pick ? pick({ isVisible: false, height: 0 }) : { isVisible: false, height: 0 }),
        useKeyboardHandler: () => {},
    };
});
vi.mock('../../services/pillar-sync', () => ({ requestSync: async () => {}, isPillarSyncActive: () => false, syncLandedOnThisCopy: async () => false, PILLAR_SYNC_ENDED: 'pillar_sync_ended' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown; patternEnabled: boolean }) => unknown) => make({ theme: 'light', colors: lightColors, patternEnabled: false }),
    };
});
const ME = { publicKey: 'me-key', privateKey: 'me-priv', callsign: 'Ana' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../node-post', () => ({
    signedGet: () => new Promise(() => {}), signedPost: () => new Promise(() => {}),
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? null,
}));
const blocks = vi.hoisted(() => ({ made: [] as string[], reports: [] as unknown[][] }));
vi.mock('../blocklist', () => ({
    isUserBlocked: async () => false, getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated',
    blockUser: async (key: string, ...report: unknown[]) => { blocks.made.push(key); blocks.reports.push(report); return true; },
}));
// Which screen /chat/:id draws is utils/chat-route's call (tested there); here the test names it.
const route = vi.hoisted(() => ({ now: { view: 'dm', screenId: 'dm1' } as { view: string; screenId: string } }));
vi.mock('../chat-route', () => ({ routeChat: async () => route.now }));
// The group's key code (group-chat-keys.ts) is off the words layer; the screen's keyring answers "never held".
vi.mock('../group-chat-keys', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), groupKeysLookUnopenable: () => false }));
const net = vi.hoisted(() => ({ calls: [] as string[], answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => net.answer?.(name, args)));
// The composer hands over what the screen gives it: the test is the recorder calling onVoice.
const composerProps = vi.hoisted(() => ({ now: null as any }));
vi.mock('../../components/chat/ChatComposer', async () => {
    const R = await import('react');
    return {
        ChatComposer: R.forwardRef((p: any, _r: any) => {
            composerProps.now = p;
            return R.createElement('div', null, p.notice ? R.createElement('span', { 'data-notice': '1' }, p.notice) : null);
        }),
    };
});

import { setLanguage } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import ChatRoute from '../../app/chat/[id]';
import { DmNotLockedError } from '../dm-lock';
import { DmPinStoreError, DM_PIN_STORE_UNREAD_TEXT } from '../dm-peer-pins';
import { GroupChatKeyError, GROUP_KEY_STORE_UNREAD_TEXT } from '../group-chat-keys';
import { isVoiceNotSent } from '../voice-recorder';

const NODE = 'https://mullum.example';
const LINE = '5d3c1b2a-9e8f-4a7b-8c6d-1e2f3a4b5c6d';
const VOICE = { durationMs: 2300, bars: new Array(48).fill(10), sound: new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70]) };
const ACCEPTED = { name: 'Kofi', otherPubkey: 'kofi-key', type: 'dm', request: { state: 'accepted', from: 'kofi-key', at: new Date(Date.now() - 120_000).toISOString() } };

/** The node: its stored voice lines by id (engine/messaging.ts's duplicate guard), every try, and a refusal to throw. */
const node = { lines: new Map<string, { id: string }>(), tries: [] as Array<{ messageId?: string; signal?: AbortSignal }>, refuse: null as null | (() => Error) };

function standIn(): void {
    const answers: Record<string, unknown> = {
        getConversation: ACCEPTED, getMessages: [], getDealsBetween: [], getDmKeyChange: null, getKnownChatMute: null,
        markConversationRead: undefined, syncSingleConversation: true,
        getDb: { getAllAsync: async () => [], getFirstAsync: async () => null, runAsync: async () => ({}) },
        sendVoiceMessage: async (_conv: string, _voice: unknown, _meta: unknown, opts: { messageId?: string; signal?: AbortSignal } = {}) => {
            node.tries.push(opts);
            if (node.refuse) throw node.refuse();
            const id = opts.messageId ?? `new-${node.tries.length}`;
            if (!node.lines.has(id)) node.lines.set(id, { id });
        },
    };
    net.answer = (name, args) => {
        if (!(name in answers)) return undefined;
        const a = answers[name];
        if (typeof a === 'function') return (a as (...x: unknown[]) => Promise<unknown> | undefined)(...args);
        return a === undefined && name === 'syncSingleConversation' ? undefined : Promise.resolve(a);
    };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    alerts.said.length = 0;
    composerProps.now = null;
    node.lines.clear();
    node.tries.length = 0;
    node.refuse = null;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    // A community that takes voice messages (features.voiceLines), kept on this phone a moment ago.
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'global', features: { voiceLines: true }, checkedAt: new Date().toISOString() } }));
    route.now = { view: 'dm', screenId: 'dm1' };
    params.now = { id: 'dm1' };
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
    standIn();
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function open(): Promise<void> {
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(ChatRoute)) as any); });
    await settle();
    expect(composerProps.now?.onVoice, 'an accepted chat\'s composer has the microphone').toBeTypeOf('function');
}
/** The recorder sending the recording `lineId`: what came back ('sent', or the error it threw). */
async function recorderSends(lineId = LINE): Promise<'sent' | unknown> {
    let outcome: 'sent' | unknown = 'sent';
    await act(async () => { try { await composerProps.now.onVoice(VOICE, lineId); } catch (e) { outcome = e; } });
    await settle();
    return outcome;
}
const notice = () => host.querySelector('[data-notice]')?.textContent ?? null;

describe('a direct chat\'s voice send refused above the box is "not sent" to the recorder (PR #3112 review, round 2: [id].tsx:886)', () => {
    for (const [what, make, words] of [
        ['the chat isn\'t locked yet', () => new DmNotLockedError(), 'Kofi'],
        ['the pins couldn\'t be read just now', () => new DmPinStoreError(), DM_PIN_STORE_UNREAD_TEXT],
        ['the key store couldn\'t be read just now', () => new GroupChatKeyError(GROUP_KEY_STORE_UNREAD_TEXT, 'store'), GROUP_KEY_STORE_UNREAD_TEXT],
    ] as const) {
        it(`${what}: the line above the box, and onVoice throws VoiceNotSentError (the recorder keeps the recording)`, async () => {
            await open();
            node.refuse = make;
            const outcome = await recorderSends();
            expect(outcome).not.toBe('sent');
            expect(isVoiceNotSent(outcome)).toBe(true);
            expect(notice()).toContain(words);
            // The screen says it once; the recorder adds nothing (it skips its alert for VoiceNotSentError).
            expect(alerts.said).toEqual([]);
            expect(node.lines.size).toBe(0);
        });
    }

    it('a send that just failed (no connection) is not a shown refusal: a plain error the recorder says, nothing above the box', async () => {
        await open();
        node.refuse = () => new TypeError('Network request failed');
        const outcome = await recorderSends();
        expect(outcome).toBeInstanceOf(Error);
        expect(isVoiceNotSent(outcome)).toBe(false);
        expect(notice()).toBeNull();
    });
});

describe('a direct chat\'s voice message sent twice is one line (PR #3112 review, round 2: db.ts:7448)', () => {
    it('the recording\'s line id is the messageId on every try, with a give-up signal, so the node answers the first: one line', async () => {
        await open();
        node.refuse = () => new DmNotLockedError();
        expect(isVoiceNotSent(await recorderSends())).toBe(true);
        node.refuse = null;
        expect(await recorderSends()).toBe('sent');
        expect(await recorderSends()).toBe('sent');
        expect(node.tries.map(t => t.messageId)).toEqual([LINE, LINE, LINE]);
        expect(node.tries.every(t => t.signal instanceof AbortSignal)).toBe(true);
        expect(node.lines.size).toBe(1);
        // Sent: the notice is cleared.
        expect(notice()).toBeNull();
    });
});

describe('the microphone only where the chat\'s community takes voice messages (features.voiceLines; Byron, 14 Nov)', () => {
    const NOT_TAKEN = "This community doesn't take voice messages yet. Nothing was sent.";
    const kept = (features: Record<string, unknown>, checkedAt = new Date().toISOString()) =>
        store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: { profile: 'local', features, checkedAt } }));
    async function draw(): Promise<void> {
        await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(ChatRoute)) as any); });
        await settle();
        expect(composerProps.now, 'the accepted chat\'s composer is drawn').not.toBeNull();
    }

    for (const [what, features] of [
        ['says nothing of it (a node from before voice V2, as Byron was)', {}],
        ['says voiceLines: false', { voiceLines: false }],
    ] as const) {
        it(`a community that ${what}: no microphone, the composer as before voice`, async () => {
            kept(features);
            await draw();
            expect(composerProps.now.onVoice).toBeUndefined();
        });
    }

    it('a community this phone has no copy of, whose node can\'t be asked: no microphone', async () => {
        store.map.delete('beanpool_node_profiles');
        await draw();
        expect(composerProps.now.onVoice).toBeUndefined();
    });

    it('a community that says voiceLines: true: the microphone', async () => {
        kept({ voiceLines: true });
        await draw();
        expect(composerProps.now.onVoice).toBeTypeOf('function');
    });

    it('a kept "true" is asked again as every switch is; a node that no longer says it takes the microphone away, and a recording already waiting is kept, not sent, and the chat says why', async () => {
        kept({ voiceLines: true }, new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
        let answer: ((r: Response) => void) | null = null;
        globalThis.fetch = vi.fn((input: unknown) => String(input).endsWith('/api/community/info')
            ? new Promise<Response>((r) => { answer = r; })
            : Promise.resolve(new Response('{}', { status: 404 }))) as typeof fetch;
        await open();
        // The recorder holds the onVoice it was given while a recording waits (ChatComposer lastOnVoice).
        const waiting = composerProps.now.onVoice;
        expect(answer, 'the stale copy is asked again').not.toBeNull();
        await act(async () => { answer!(new Response(JSON.stringify({ profile: 'local', features: {} }), { status: 200 })); });
        await settle();
        expect(composerProps.now.onVoice, 'the node said nothing of voice lines: no microphone').toBeUndefined();

        let outcome: unknown = 'sent';
        await act(async () => { try { await waiting(VOICE, LINE); } catch (e) { outcome = e; } });
        await settle();
        expect(isVoiceNotSent(outcome), 'the recorder keeps the recording').toBe(true);
        expect(notice()).toBe(NOT_TAKEN);
        expect(node.tries, 'nothing went to the node').toEqual([]);
        expect(alerts.said).toEqual([]);
    });
});
