// @vitest-environment jsdom
/**
 * A locked group chat's photo lines, rendered for real (components/GroupChatView.tsx): react-dom in jsdom with React Native's
 * host components as plain tags, as group-chat-send-refused-render.test.ts draws the screen.
 *
 * DESIGN-group-chat-photos-fable.md §2.3: only a line whose view has a signer and an epoch gets a photo in its bubble. A line
 * waiting for its key or unverified shows no photo and asks for none. Review of #2456 read the photo slot as drawn for every
 * photo line the thread opened, so a line waiting for its key would read "🔒 Image unavailable" above its waiting words.
 * It isn't: such a line is a sealed notice, drawn before any bubble (renderMessage, item.unattributed). This pins that.
 * The photo's own open (getDecryptedGroupAttachment) is the real one, over a cache that holds every photo.
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

const KEPT = 'file:///tmp/cache/chat-images/groups/kept.jpg';
const G = 'b78da72e-773f-4425-914a-8bfbd4e4130a';
const OPENED = '0b3f4c1e-2a55-4d9e-8f10-0e5c8d1a7b21';
const WAITING = '1c4e5d2f-3b66-4eaf-9021-1f6d9e2b8c32';
const UNVERIFIED = '2d5f6e3a-4c77-4fb0-a132-207eaf3c9d43';
const BEN = 'b'.repeat(64);
const view = (v: Record<string, unknown>) => ({
    hidden: false, text: '', name: null, nameHint: null, details: null, unverified: false, waitingKey: false, signer: null, after: null, epoch: null, ...v,
});
// The thread as openGroupThread opened it: Ben's line by his key, one waiting for epoch 2's key, one nothing signed.
const thread = vi.hoisted(() => ({ views: new Map<string, any>() }));
vi.mock('../group-chat-lines', async (orig) => ({
    ...(await orig<any>()),
    openGroupThread: vi.fn(async () => ({ views: thread.views, waitingForNextKey: false })),
}));
vi.mock('../db', async (orig) => {
    const lines = await import('../group-chat-lines');
    const { memoryGroupKeyStore } = await import('../group-chat-keys');
    return {
        ...(await orig<any>()),
        getGroupChat: vi.fn(async () => ({
            messages: [OPENED, WAITING, UNVERIFIED].map((id, i) => ({
                id, type: 'image', authorPubkey: BEN, ciphertext: 'c', nonce: 'group-xc20p-v1:n', metadata: { epoch: i === 1 ? 2 : 1, sender: BEN },
                createdAt: `2026-10-24T18:0${i}:00Z`,
            })),
            encryption: { current: 2, stale: false, fromEpoch: 1 },
            canPost: true,
        })),
        fetchGroupDetails: vi.fn(async () => null),
        markThreadReadOnNode: vi.fn(async () => { }),
        groupScreenKeyringFor: vi.fn(async () => ({ seenLocked: async () => true, noteShownRoster: () => { }, serveMissing: async () => { }, sync: async () => null })),
        // The real open, bound to the line's view, over a cache that holds every photo: what it answers is what the bubble draws.
        getDecryptedGroupPhoto: vi.fn((groupId: string, line: any, v: any) => lines.getDecryptedGroupAttachment(
            'https://test.beanpool.org', { publicKey: ME, privateKey: 'aa' } as any, memoryGroupKeyStore(), { groupId, line, view: v },
            { get: async () => KEPT, put: async (_g, _m, uri) => uri },
        )),
    };
});
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));

import { GroupChatView } from '../../components/GroupChatView';
import { getDecryptedGroupPhoto } from '../db';
import { GROUP_LINE_UNVERIFIED_TEXT, GROUP_LINE_WAITING_KEY_TEXT } from '../group-line-display';

let host: HTMLDivElement;
let root: Root;
afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host?.remove();
});
const settle = async () => { for (let i = 0; i < 15; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

describe('a locked group chat draws a photo only under a line opened by its signer (design §2.3; review of #2456)', () => {
    it('Ben\'s opened line shows its photo; the line waiting for its key and the unverified one show none, read "Image unavailable" nowhere, and ask for nothing', async () => {
        thread.views.set(OPENED, view({ text: 'a caption', name: 'Ben', signer: BEN, epoch: 1 }));
        thread.views.set(WAITING, view({ text: GROUP_LINE_WAITING_KEY_TEXT, waitingKey: true, epoch: 2 }));
        thread.views.set(UNVERIFIED, view({ text: GROUP_LINE_UNVERIFIED_TEXT, name: 'Unverified', unverified: true, epoch: 1 }));
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => {
            root.render(createElement(GroupChatView, { kind: 'group', id: G, initialName: 'Bakers' }) as unknown as Parameters<Root['render']>[0]);
        });
        await settle();
        const item = (id: string) => host.querySelector(`[data-item="${id}"]`) as HTMLElement;
        const photos = (id: string) => Array.from(item(id).querySelectorAll('img')).map(n => n.getAttribute('aria-label'));
        const bubble = (id: string) => !!item(id).querySelector('[data-row]');

        expect([bubble(OPENED), photos(OPENED)]).toEqual([true, ['Photo message']]);
        expect(item(OPENED).textContent).toContain('a caption');
        expect([bubble(WAITING), photos(WAITING)]).toEqual([false, []]);
        expect(item(WAITING).textContent).toContain(GROUP_LINE_WAITING_KEY_TEXT);
        expect([bubble(UNVERIFIED), photos(UNVERIFIED)]).toEqual([false, []]);
        expect(item(UNVERIFIED).textContent).toContain(GROUP_LINE_UNVERIFIED_TEXT);
        expect(host.textContent).not.toContain('Image unavailable');
        expect(vi.mocked(getDecryptedGroupPhoto).mock.calls.map(c => String(c[1].id))).toEqual([OPENED]);
    });
});
