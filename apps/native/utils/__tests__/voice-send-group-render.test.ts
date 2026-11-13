// @vitest-environment jsdom
/**
 * A voice message from a locked group's chat (components/GroupChatView.tsx sendVoice), rendered for real: react-dom in jsdom
 * with React Native's host components as plain tags, as group-chat-photo-render.test.ts draws a locked group. The composer is a
 * stand-in that hands over the screen's onVoice, so the test is the recorder calling it.
 *
 * PR #3112 review, round 2:
 *   - GroupChatView.tsx:576: a refusal the screen shows above the box (every GroupChatKeyError, "… Nothing was sent; try again
 *     in a moment.") returned normally, so the recorder deleted the recording as if sent. It now throws VoiceNotSentError
 *     after setting the notice: the recorder keeps it (voice-composer-render.test.ts) and adds no word of its own.
 *   - db.ts:7490: each try made a new clientId, so a Send after the 60 s timeout was a second line. The recording's own line
 *     id is the clientId on every try, and the node's duplicate guard (engine/group-thread.ts) answers the line it stored.
 *
 * A live community, 14 Nov: a voice message sent to a node from before voice V2 was stored as a text line carrying a sound. The
 * microphone shows only where the community says `features.voiceLines: true` (core voiceLinesOn, through useNodeProfile,
 * stood in for here so the test can change what the community says); a recording that would still go where it isn't said
 * is kept, not sent, and the chat says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The shipped pictures' requires (utils/bundled-avatars.ts, through MemberAvatar and the picture sheet) load as a number.
vi.hoisted(() => {
    const Loader = (process as any).getBuiltinModule('node:module');
    Loader._extensions['.jpg'] = (m: { exports: unknown }) => { m.exports = 1; };
});
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', radio: 'radio', alert: 'alert' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'), Image: el('img'),
        FlatList: () => null,
        ActivityIndicator: () => createElement('span', null, '…'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', null, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {} },
        Alert: { alert: vi.fn() },
        Linking: { openURL: vi.fn() },
        AppState: { currentState: 'active', addEventListener: () => ({ remove: () => { } }) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardState: (pick: (s: { height: number; isVisible: boolean }) => unknown) => pick({ height: 0, isVisible: false }),
    KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    KeyboardController: { dismiss: async () => { }, setInputMode: () => { } },
    AndroidSoftInputModes: {},
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-router', () => ({ router: { canGoBack: () => true, back: vi.fn(), replace: vi.fn(), push: vi.fn() }, useFocusEffect: () => { } }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { theme: 'light', colors: lightColors };
    return { useTheme: () => ctx, useStyles: (make: (c: typeof ctx) => unknown) => make(ctx) };
});
const ME = 'c'.repeat(64);
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: ME, callsign: 'Me' } }) }));
// The poll's first tick is immediate (utils/chat-poll): one read on the way in, nothing on a timer.
vi.mock('../../components/chat/useChatPoll', async () => {
    const { useEffect } = await import('react');
    return { useChatPoll: (load: () => unknown) => { useEffect(() => { load(); }, [load]); } };
});
vi.mock('../../components/chat/useChatSoftInputMode', () => ({ useChatSoftInputMode: () => { } }));
vi.mock('../../components/useYourGroups', () => ({
    yourGroupsStore: { getState: () => ({ items: [] }), markRead: vi.fn(), setMute: vi.fn() },
}));
vi.mock('../haptics', () => ({ hapticTick: vi.fn(), hapticSuccess: vi.fn(), hapticWarning: vi.fn() }));
// The chat's pieces as plain tags: the list draws each item under its id; a bubble's row is its attachment slot and its words.
vi.mock('../../components/chat/ChatMessageList', () => ({
    ChatMessageList: (p: any) => createElement('div', null, ...(p.items || []).map((it: any, i: number) => createElement('div', { key: i, 'data-item': it.id }, p.renderMessage(it)))),
    scrollChatToBottom: () => { },
}));
vi.mock('../../components/chat/ChatMessageRow', () => ({
    ChatMessageRow: (p: any) => createElement('div', { 'data-row': '1' }, p.attachment ?? null, createElement('span', null, p.item?.text ?? '')),
}));
// The composer hands over what the screen gives it: the test is the recorder calling onVoice.
const composer = vi.hoisted(() => ({ props: null as any }));
vi.mock('../../components/chat/ChatComposer', async () => {
    const R = await import('react');
    return { ChatComposer: R.forwardRef((p: any, _r: any) => { composer.props = p; return R.createElement('div', null); }) };
});
vi.mock('../../components/chat/ChatBanners', () => ({ ChatEditBanner: () => null, ChatMenuSheet: () => null, ChatReplyBanner: () => null }));
vi.mock('../../components/InvitePeopleSheet', () => ({ InvitePeopleSheet: () => null }));
vi.mock('../../components/GroupDetailModal', () => ({ GroupDetailModal: () => null }));

// utils/db's device modules, stubbed at the boundary (the same set as group-chat-send-refused-render.test.ts).
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://test.beanpool.org' : null)),
        setItem: vi.fn(async () => { }),
        removeItem: vi.fn(async () => { }),
        getAllKeys: vi.fn(async () => []),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid' }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/' }));
vi.mock('expo-image-picker', () => ({ requestCameraPermissionsAsync: vi.fn(), launchCameraAsync: vi.fn(), launchImageLibraryAsync: vi.fn() }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: vi.fn(), SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => null) }));

const G = 'b78da72e-773f-4425-914a-8bfbd4e4130a';
/** The node: its stored lines by clientId (its duplicate guard), every voice send it was asked for, and a refusal to throw. */
const node = vi.hoisted(() => ({ lines: new Map<string, { id: string }>(), asked: [] as any[], refuse: null as null | (() => Error) }));
vi.mock('../group-chat-lines', async (orig) => ({
    ...(await orig<any>()),
    openGroupThread: vi.fn(async () => ({ views: new Map(), waitingForNextKey: false })),
}));
vi.mock('../db', async (orig) => ({
    ...(await orig<any>()),
    // A locked group's chat (its answer names the epoch), no lines yet.
    getGroupChat: vi.fn(async () => ({ messages: [], encryption: { current: 2, stale: false, fromEpoch: 1 }, canPost: true })),
    fetchGroupDetails: vi.fn(async () => null),
    markThreadReadOnNode: vi.fn(async () => { }),
    groupScreenKeyringFor: vi.fn(async () => ({ seenLocked: async () => true, noteShownRoster: () => { }, serveMissing: async () => { }, sync: async () => null })),
    // engine/group-thread.ts: a line already stored under this clientId is answered again, nothing new stored.
    postGroupChatVoice: vi.fn(async (_groupId: string, input: any) => {
        node.asked.push(input);
        if (node.refuse) throw node.refuse();
        if (!node.lines.has(input.clientId)) node.lines.set(input.clientId, { id: input.clientId });
        return { success: true, message: node.lines.get(input.clientId) };
    }),
}));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(), addSavedNode: vi.fn() }));
// This phone's copy of the community (utils/use-node-profile.ts): what the community says now, and a way to change it.
const community = vi.hoisted(() => ({ now: null as null | { profile: string; features: Record<string, unknown> }, set: null as null | ((p: unknown) => void) }));
vi.mock('../use-node-profile', async () => {
    const R = await import('react');
    return { useNodeProfile: () => { const [p, set] = R.useState(community.now); community.set = set as (p: unknown) => void; return p; } };
});
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));

import { GroupChatView } from '../../components/GroupChatView';
import { Alert } from 'react-native';
import { GroupChatKeyError, GROUP_KEY_ROSTER_UNREAD_TEXT, GROUP_KEY_STORE_UNREAD_TEXT } from '../group-chat-keys';
import { DmPinStoreError, DM_PIN_STORE_UNREAD_TEXT } from '../dm-peer-pins';
import { isVoiceNotSent } from '../voice-recorder';

const LINE = '5d3c1b2a-9e8f-4a7b-8c6d-1e2f3a4b5c6d';
const VOICE = { durationMs: 2300, bars: new Array(48).fill(10), sound: new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70]) };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    node.lines.clear();
    node.asked.length = 0;
    node.refuse = null;
    composer.props = null;
    // A community that takes voice messages (features.voiceLines).
    community.now = { profile: 'local', features: { voiceLines: true } };
    vi.mocked(Alert.alert).mockClear();
});
afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host?.remove();
});
const settle = async () => { for (let i = 0; i < 15; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

async function openGroup(): Promise<void> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root.render(createElement(GroupChatView, { kind: 'group', id: G, initialName: 'Bakers' }) as unknown as Parameters<Root['render']>[0]);
    });
    await settle();
    expect(composer.props?.onVoice, 'a locked group\'s composer has the microphone').toBeTypeOf('function');
}
/** The recorder sending the recording `lineId`: what came back ('sent', or the error it threw). */
async function recorderSends(lineId = LINE): Promise<'sent' | unknown> {
    let outcome: 'sent' | unknown = 'sent';
    await act(async () => { try { await composer.props.onVoice(VOICE, lineId); } catch (e) { outcome = e; } });
    await settle();
    return outcome;
}
const said = () => Array.from(host.querySelectorAll('[role="alert"]')).map(n => n.textContent);

describe('a locked group\'s voice send refused above the box is "not sent" to the recorder (PR #3112 review, round 2: GroupChatView.tsx:576)', () => {
    for (const [what, make, words] of [
        ['the roster couldn\'t be read', () => new GroupChatKeyError(GROUP_KEY_ROSTER_UNREAD_TEXT, 'roster'), GROUP_KEY_ROSTER_UNREAD_TEXT],
        ['the key store couldn\'t be read', () => new GroupChatKeyError(GROUP_KEY_STORE_UNREAD_TEXT, 'store'), GROUP_KEY_STORE_UNREAD_TEXT],
        ['the pins couldn\'t be read', () => new DmPinStoreError(), DM_PIN_STORE_UNREAD_TEXT],
    ] as const) {
        it(`${what}: the sentence above the box, and onVoice throws VoiceNotSentError (the recorder keeps the recording)`, async () => {
            await openGroup();
            node.refuse = make;
            const outcome = await recorderSends();
            expect(outcome).not.toBe('sent');
            expect(isVoiceNotSent(outcome)).toBe(true);
            expect((outcome as Error).message).toBe(words);
            expect(said()).toEqual([words]);
            // The screen says it once; the recorder adds nothing (it skips its alert for VoiceNotSentError).
            expect(Alert.alert).not.toHaveBeenCalled();
            expect(node.lines.size).toBe(0);
        });
    }

    it('a send that just failed (no connection) is not a shown refusal: a plain error the recorder says, nothing above the box', async () => {
        await openGroup();
        node.refuse = () => new TypeError('Network request failed');
        const outcome = await recorderSends();
        expect(outcome).toBeInstanceOf(Error);
        expect(isVoiceNotSent(outcome)).toBe(false);
        expect(said()).toEqual([]);
    });
});

describe('a locked group\'s voice message sent twice is one line (PR #3112 review, round 2: db.ts:7490)', () => {
    it('the recording\'s line id is the clientId on every try, so the node\'s duplicate guard answers the first: one line', async () => {
        await openGroup();
        node.refuse = () => new GroupChatKeyError(GROUP_KEY_ROSTER_UNREAD_TEXT, 'roster');
        expect(isVoiceNotSent(await recorderSends())).toBe(true);
        node.refuse = null;
        expect(await recorderSends()).toBe('sent');
        expect(await recorderSends()).toBe('sent');
        expect(node.asked.map(a => a.clientId)).toEqual([LINE, LINE, LINE]);
        expect(node.lines.size).toBe(1);
        // Each try can be given up for real (its POST aborted at 60 s).
        expect(node.asked.every(a => a.signal instanceof AbortSignal)).toBe(true);
        // Sent: the notice is cleared.
        expect(said()).toEqual([]);
    });
});

describe('the microphone only where the group\'s community takes voice messages (features.voiceLines; a live community, 14 Nov)', () => {
    const NOT_TAKEN = "This community doesn't take voice messages yet. Nothing was sent.";
    async function draw(): Promise<void> {
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => {
            root.render(createElement(GroupChatView, { kind: 'group', id: G, initialName: 'Bakers' }) as unknown as Parameters<Root['render']>[0]);
        });
        await settle();
        expect(composer.props, 'the locked group\'s composer is drawn').not.toBeNull();
    }

    for (const [what, profile] of [
        ['says nothing of it (a node from before voice V2, as one live community was)', { profile: 'local', features: {} }],
        ['says voiceLines: false', { profile: 'local', features: { voiceLines: false } }],
        ['isn\'t known on this phone yet', null],
    ] as const) {
        it(`a community that ${what}: no microphone, the composer as before voice`, async () => {
            community.now = profile as typeof community.now;
            await draw();
            expect(composer.props.onVoice).toBeUndefined();
            // The photo button is the locked group's as before.
            expect(composer.props.onAttach).toBeTypeOf('function');
        });
    }

    it('a community that says voiceLines: true: the microphone', async () => {
        await draw();
        expect(composer.props.onVoice).toBeTypeOf('function');
    });

    it('a community that stops saying it: the microphone goes, and a recording already waiting is kept, not sent, and the chat says why', async () => {
        await openGroup();
        // The recorder holds the onVoice it was given while a recording waits (ChatComposer lastOnVoice).
        const waiting = composer.props.onVoice;
        await act(async () => { community.set!({ profile: 'local', features: {} }); });
        await settle();
        expect(composer.props.onVoice).toBeUndefined();

        let outcome: unknown = 'sent';
        await act(async () => { try { await waiting(VOICE, LINE); } catch (e) { outcome = e; } });
        await settle();
        expect(isVoiceNotSent(outcome), 'the recorder keeps the recording').toBe(true);
        expect((outcome as Error).message).toBe(NOT_TAKEN);
        expect(said()).toEqual([NOT_TAKEN]);
        expect(node.asked, 'nothing went to the node').toEqual([]);
        expect(Alert.alert).not.toHaveBeenCalled();
    });
});
