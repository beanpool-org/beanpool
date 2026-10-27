// @vitest-environment jsdom
/**
 * A group chat's header draws the group's picture, else its category's emblem (Pictures S4, design §3.1 and §4.3), as Group
 * info, the Talk and Commons rows and the web draw it: rendered for real (components/GroupChatView.tsx), react-dom in jsdom
 * with React Native's host components as plain tags, the same harness as group-chat-photo-render.test.ts. #2511 review
 * (4382901390): the header fell back to the category's emoji, so a group from before S4 had a picture in web and none here.
 * Until the node has said which group this is, no picture: never a guessed emblem that turns into the group's own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('../../components/chat/ChatComposer', async () => {
    const R = await import('react');
    return { ChatComposer: R.forwardRef((_p: any, _r: any) => R.createElement('div', null)) };
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
// Each face as the picture it was handed, so the header's is read exactly.
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: ({ avatarUrl }: { avatarUrl: string | null }) => createElement('span', { 'data-face': String(avatarUrl) }) }));

const G = 'b78da72e-773f-4425-914a-8bfbd4e4130a';
// The node's answer to the chat read (engine/group-thread.ts getGroupThread): the group, with its picture's URL or null.
const node = vi.hoisted(() => ({ group: null as Record<string, unknown> | null, gate: null as Promise<void> | null }));
vi.mock('../group-chat-lines', async (orig) => ({
    ...(await orig<any>()),
    openGroupThread: vi.fn(async () => ({ views: new Map(), waitingForNextKey: false })),
}));
vi.mock('../db', async (orig) => ({
    ...(await orig<any>()),
    getGroupChat: vi.fn(async () => {
        if (node.gate) await node.gate;
        return { messages: [], group: node.group, encryption: { current: 1, stale: false, fromEpoch: 1 }, canPost: true };
    }),
    fetchGroupDetails: vi.fn(async () => null),
    markThreadReadOnNode: vi.fn(async () => { }),
    groupScreenKeyringFor: vi.fn(async () => ({ seenLocked: async () => true, noteShownRoster: () => { }, serveMissing: async () => { }, sync: async () => null })),
}));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));

import { GroupChatView } from '../../components/GroupChatView';

let host: HTMLDivElement;
let root: Root;
afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host?.remove();
    node.group = null;
    node.gate = null;
});
const settle = async () => { for (let i = 0; i < 15; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
async function open(): Promise<void> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root.render(createElement(GroupChatView, { kind: 'group', id: G, initialName: 'Street choir' }) as unknown as Parameters<Root['render']>[0]);
    });
    await settle();
}
const headerFaces = () => Array.from(host.querySelectorAll('[aria-label="Street choir, group. Opens the group page."] [data-face]')).map(n => n.getAttribute('data-face'));
const group = (over: Record<string, unknown>) => ({ id: G, name: 'Street choir', slug: 'street-choir', category: 'guild', joinPolicy: 'open', avatarUrl: null, ...over });

describe("a group chat's header draws the group's picture, else its category's emblem (Pictures S4; #2511 review)", () => {
    it('a group with no picture of its own (one made before S4) shows its category\'s emblem, as Group info and the web do', async () => {
        node.group = group({ avatarUrl: null, category: 'guild' });
        await open();
        expect(headerFaces()).toEqual(['bundled://crystal']);
    });

    it("a group with its own picture shows that picture", async () => {
        node.group = group({ avatarUrl: `/api/groups/${G}/picture?v=1a2b`, category: 'social' });
        await open();
        expect(headerFaces()).toEqual([`/api/groups/${G}/picture?v=1a2b`]);
    });

    it('before the node has said which group this is, no picture: never a guessed emblem', async () => {
        let answer!: () => void;
        node.gate = new Promise<void>(r => { answer = r; });
        node.group = group({ avatarUrl: `/api/groups/${G}/picture?v=1a2b`, category: 'social' });
        await open();
        expect(host.querySelector('[aria-label="Street choir, group. Opens the group page."]')).not.toBeNull();
        expect(headerFaces()).toEqual([]);
        await act(async () => { answer(); });
        await settle();
        expect(headerFaces()).toEqual([`/api/groups/${G}/picture?v=1a2b`]);
    });
});
