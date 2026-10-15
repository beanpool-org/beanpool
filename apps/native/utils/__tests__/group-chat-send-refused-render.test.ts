// @vitest-environment jsdom
/**
 * The group screen's send, refused (components/GroupChatView.tsx, deliver's catch), rendered for real: react-dom in jsdom
 * with React Native's host components as plain tags, as group-chat-refused-render.test.ts draws the refused-chat screen.
 *
 * #1938 confirmation 7, finding 3: while this community's pins or DM list can't be read, every readable send (an old node's
 * unlocked group, every enterprise thread) and a locked group this phone never held is refused with one true line, and
 * the line names the way out (Settings → Chat memory). The group screen showed only "! not delivered", and a tap
 * gave "This message could not be sent." with a Resend that fails the same. It now says the refusal's sentence above the
 * box, as it already said a key's (GroupChatKeyError); an error with no sentence of its own adds nothing there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
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
// The chat's pieces as plain tags: the list draws each row; a row shows its words and its status, and a tap on it is the
// bubble's tap; the composer is one Send button that sends "The code is 4821". The info sheet stays shut.
vi.mock('../../components/chat/ChatMessageList', () => ({
    ChatMessageList: (p: any) => createElement('div', null, ...(p.items || []).map((it: any, i: number) => createElement('div', { key: i }, p.renderMessage(it)))),
    scrollChatToBottom: () => { },
}));
vi.mock('../../components/chat/ChatMessageRow', () => ({
    ChatMessageRow: (p: any) => createElement('div', { 'data-row': '1', onClick: () => p.onPressBubble?.({}) }, p.item?.text ?? '', p.status ?? null),
}));
vi.mock('../../components/chat/ChatComposer', async () => {
    const R = await import('react');
    return { ChatComposer: R.forwardRef((p: any, _r: any) => R.createElement('button', { 'aria-label': 'Send', onClick: () => p.onSend('The code is 4821') }, 'Send')) };
});
vi.mock('../../components/chat/ChatBanners', () => ({ ChatEditBanner: () => null, ChatMenuSheet: () => null, ChatReplyBanner: () => null }));
vi.mock('../../components/InvitePeopleSheet', () => ({ InvitePeopleSheet: () => null }));
vi.mock('../../components/GroupDetailModal', () => ({ GroupDetailModal: () => null }));

// utils/db's device modules, stubbed at the boundary (the same set as check-invite-ticket.test.ts).
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
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => null) }));
// The screen's two readable sends refuse as utils/db refuses them (GX1, GX4 and GD2 measure the refusals themselves).
const refusal = vi.hoisted(() => ({ make: (): Error => new Error('unset') }));
vi.mock('../db', async (orig) => ({
    ...(await orig<any>()),
    postGroupChatMessage: vi.fn(async () => { throw refusal.make(); }),
    postEnterpriseChatMessage: vi.fn(async () => { throw refusal.make(); }),
}));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));


import { GroupChatView } from '../../components/GroupChatView';
import { Alert } from 'react-native';
import { DmPinStoreError, DM_PIN_STORE_UNREAD_TEXT } from '../dm-peer-pins';
import { DmGuardUnreadError, DM_GUARD_UNREAD_TEXT } from '../dm-guard-list';
import { GroupChatKeyError, GROUP_KEY_WAITING_TEXT } from '../group-chat-keys';

const G = 'b78da72e-773f-4425-914a-8bfbd4e4130a';
function reply(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
    vi.mocked(Alert.alert).mockClear();
    // An old node's unlocked group (no `encryption` in its chat answer) and an enterprise's thread, both empty.
    (globalThis as any).fetch = vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === `/api/groups/${G}/chat`) return reply(200, { messages: [], canPost: true });
        if (path === `/api/enterprise/${G}/thread`) return reply(200, { messages: [], readOnly: false });
        return reply(404, { error: 'Not found' });
    });
});

let host: HTMLDivElement;
let root: Root;
afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host?.remove();
});
const settle = async () => { for (let i = 0; i < 15; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

/** The screen opened on `kind`, one send that `make` refuses: what the member reads, and what a tap on the bubble says. */
async function sendRefused(kind: 'group' | 'enterprise', make: () => Error) {
    refusal.make = make;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root.render(createElement(GroupChatView, { kind, id: G, initialName: 'Bakers' }) as unknown as Parameters<Root['render']>[0]);
    });
    await settle();
    const send = Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Send')!;
    await act(async () => { send.click(); });
    await settle();
    const said = Array.from(host.querySelectorAll('[role="alert"]')).map(n => n.textContent);
    const notDelivered = (host.textContent || '').includes('! not delivered');
    const row = host.querySelector('[data-row]') as HTMLElement | null;
    if (row) await act(async () => { row.click(); });
    await settle();
    return { said, notDelivered, onTap: vi.mocked(Alert.alert).mock.calls.map(c => c[0]) };
}

describe('the group screen says why a send was refused (#1938 confirmation 7, finding 3)', () => {
    for (const kind of ['group', 'enterprise'] as const) {
        it(`GCV (${kind}) the pins can't be read: the pins sentence above the box, naming Chat memory; the bubble stays "not delivered"`, async () => {
            const r = await sendRefused(kind, () => new DmPinStoreError());
            expect(r).toEqual({ said: [DM_PIN_STORE_UNREAD_TEXT], notDelivered: true, onTap: ['Message not delivered'] });
            expect(DM_PIN_STORE_UNREAD_TEXT).toContain('Settings → Chat memory');
        });
    }

    it('GCV (group) the DM list can\'t be read: its own sentence above the box (§3.4 amendment 7 §3 iii\'s "one true line")', async () => {
        expect(await sendRefused('group', () => new DmGuardUnreadError())).toEqual({ said: [DM_GUARD_UNREAD_TEXT], notDelivered: true, onTap: ['Message not delivered'] });
    });

    it('GCV (group) a key reason still says its own sentence, as before', async () => {
        expect(await sendRefused('group', () => new GroupChatKeyError(GROUP_KEY_WAITING_TEXT, 'no_key'))).toEqual({ said: [GROUP_KEY_WAITING_TEXT], notDelivered: true, onTap: ['Message not delivered'] });
    });

    it('GCV (group) a send that just failed (no connection) adds no line above the box: only "not delivered", and Resend on a tap', async () => {
        expect(await sendRefused('group', () => new TypeError('Network request failed'))).toEqual({ said: [], notDelivered: true, onTap: ['Message not delivered'] });
    });
});
