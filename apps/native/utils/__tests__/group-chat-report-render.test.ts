// @vitest-environment jsdom
/**
 * "Report message" in a locked group chat, rendered for real (components/GroupChatView.tsx, ReportMessageSheet.tsx and the
 * DM report box, ReportReasonBox.tsx): react-dom in jsdom with React Native's host components as plain tags, as
 * group-chat-photo-render.test.ts draws the screen. Group chat photos S6.
 *
 * Someone else's opened line offers it, my own line doesn't; the sheet says what the moderators get (the one message, its
 * photo when it has one, who sent it, nothing else of the chat); Submit sends the line with the view that opened it here
 * (the key is that view's: utils/group-chat-lines.ts reportSealedGroupLine, proved in group-chat-e2e.test.ts) and shows the
 * DM report box's "Reported" dialog; a refusal says why and keeps the box open with the member's choice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', radio: 'radio', alert: 'alert' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, disabled, placeholder, onChangeText, value } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (tag === 'input') Object.assign(attrs, { placeholder, value: value ?? '', onChange: (e: any) => onChangeText?.(e.target.value) });
        return createElement(tag, attrs, tag === 'input' ? undefined : children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'), Image: el('img'),
        FlatList: () => null,
        ActivityIndicator: () => createElement('span', null, '…'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': '1' }, children as any) : null),
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
vi.mock('../../components/chat/useChatPoll', async () => {
    const { useEffect } = await import('react');
    return { useChatPoll: (load: () => unknown) => { useEffect(() => { load(); }, [load]); } };
});
vi.mock('../../components/chat/useChatSoftInputMode', () => ({ useChatSoftInputMode: () => { } }));
vi.mock('../../components/useYourGroups', () => ({
    yourGroupsStore: { getState: () => ({ items: [] }), markRead: vi.fn(), setMute: vi.fn() },
}));
vi.mock('../haptics', () => ({ hapticTick: vi.fn(), hapticSuccess: vi.fn(), hapticWarning: vi.fn() }));
vi.mock('../../components/chat/ChatMessageList', () => ({
    ChatMessageList: (p: any) => createElement('div', null, ...(p.items || []).map((it: any, i: number) => createElement('div', { key: i, 'data-item': it.id }, p.renderMessage(it)))),
    scrollChatToBottom: () => { },
}));
// The row, its bubble and its actions are the real ones (components/chat/ChatMessageRow.tsx): Report sits under the line.
vi.mock('../../components/chat/ChatComposer', async () => {
    const R = await import('react');
    return { ChatComposer: R.forwardRef((_p: any, _r: any) => R.createElement('div', null)) };
});
vi.mock('../../components/chat/ChatBanners', () => ({ ChatEditBanner: () => null, ChatMenuSheet: () => null, ChatReplyBanner: () => null }));
vi.mock('../../components/InvitePeopleSheet', () => ({ InvitePeopleSheet: () => null }));
vi.mock('../../components/GroupDetailModal', () => ({ GroupDetailModal: () => null }));

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
const BENS = '0b3f4c1e-2a55-4d9e-8f10-0e5c8d1a7b21';
const BENS_PHOTO = '1c4e5d2f-3b66-4eaf-9021-1f6d9e2b8c32';
const MINE = '2d5f6e3a-4c77-4fb0-a132-207eaf3c9d43';
const BEN = 'b'.repeat(64);
const view = (v: Record<string, unknown>) => ({
    hidden: false, text: '', name: null, nameHint: null, details: null, unverified: false, waitingKey: false, signer: null, after: null, epoch: null, ...v,
});
const thread = vi.hoisted(() => ({ views: new Map<string, any>() }));
vi.mock('../group-chat-lines', async (orig) => ({
    ...(await orig<any>()),
    openGroupThread: vi.fn(async () => ({ views: thread.views, waitingForNextKey: false })),
}));
vi.mock('../db', async (orig) => ({
    ...(await orig<any>()),
    getGroupChat: vi.fn(async () => ({
        messages: [
            { id: BENS, type: 'text', authorPubkey: BEN, ciphertext: 'c', nonce: 'group-xc20p-v1:n', metadata: { epoch: 1, sender: BEN }, createdAt: '2026-10-25T08:00:00Z' },
            { id: BENS_PHOTO, type: 'image', authorPubkey: BEN, ciphertext: 'c', nonce: 'group-xc20p-v1:n', metadata: { epoch: 1, sender: BEN }, createdAt: '2026-10-25T08:01:00Z' },
            { id: MINE, type: 'text', authorPubkey: ME, ciphertext: 'c', nonce: 'group-xc20p-v1:n', metadata: { epoch: 1, sender: ME }, createdAt: '2026-10-25T08:02:00Z' },
        ],
        encryption: { current: 1, stale: false, fromEpoch: 1 },
        canPost: true,
    })),
    fetchGroupDetails: vi.fn(async () => null),
    markThreadReadOnNode: vi.fn(async () => { }),
    groupScreenKeyringFor: vi.fn(async () => ({ seenLocked: async () => true, noteShownRoster: () => { }, serveMissing: async () => { }, sync: async () => null })),
    getDecryptedGroupPhoto: vi.fn(async () => null),
    reportGroupChatLine: vi.fn(),
}));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));

import { Alert } from 'react-native';
import { GroupChatView } from '../../components/GroupChatView';
import { reportGroupChatLine } from '../db';
import { GroupKeysRequestError } from '../group-chat-keys';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    thread.views.set(BENS, view({ text: 'rude words', name: 'Ben', signer: BEN, epoch: 1 }));
    thread.views.set(BENS_PHOTO, view({ text: '', name: 'Ben', signer: BEN, epoch: 1 }));
    thread.views.set(MINE, view({ text: 'my words', name: 'Me', signer: ME, epoch: 1 }));
    vi.mocked(Alert.alert).mockClear();
    vi.mocked(reportGroupChatLine).mockReset();
});
afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host?.remove();
});
const settle = async () => { for (let i = 0; i < 15; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const click = async (el: Element | null | undefined) => {
    expect(el).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle();
};
const byLabel = (label: string) => host.querySelector(`[aria-label="${label}"]`);
const button = (text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text);

async function open(): Promise<void> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root.render(createElement(GroupChatView, { kind: 'group', id: G, initialName: 'Bakers' }) as unknown as Parameters<Root['render']>[0]);
    });
    await settle();
}
// The bubble is the line's first button: the actions under and beside it appear only once it is tapped.
const tapBubble = (id: string) => click(host.querySelector(`[data-item="${id}"] button`));

describe('Report message in a locked group chat (S6)', () => {
    it("someone else's line offers it; the sheet says what is shared; Submit reports that line with its view and says Reported", async () => {
        await open();
        await tapBubble(BENS);
        await click(byLabel('Report message'));
        const sheet = host.querySelector('[data-modal]')!;
        expect(sheet.textContent).toContain('Report this message');
        expect(sheet.textContent).toContain("This community's moderators will see this one message and who sent it. Nothing else in this chat is shared with them.");
        expect(sheet.textContent).toContain('WHY ARE YOU REPORTING IT?');
        vi.mocked(reportGroupChatLine).mockResolvedValue({ success: true, report: { id: 'r1' } });
        await click(button('Spam or scam'));
        await click(byLabel('Submit report'));
        expect(vi.mocked(reportGroupChatLine).mock.calls).toEqual([[G, BENS, thread.views.get(BENS), 'Spam or scam']]);
        const [title, body, buttons] = vi.mocked(Alert.alert).mock.calls[0] as any[];
        expect([title, body]).toEqual(['Reported', "Thanks. This community's moderators will take a look."]);
        // The sheet stays under the dialog until OK.
        expect(host.querySelector('[data-modal]')).toBeTruthy();
        await act(async () => { buttons[0].onPress(); });
        await settle();
        expect(host.querySelector('[data-modal]')).toBeNull();
    });

    it("a photo line's sheet says its photo goes too", async () => {
        await open();
        await tapBubble(BENS_PHOTO);
        await click(byLabel('Report message'));
        expect(host.querySelector('[data-modal]')!.textContent).toContain("This community's moderators will see this one message, its photo and who sent it.");
    });

    it('my own line offers no report', async () => {
        await open();
        await tapBubble(MINE);
        expect(byLabel('Delete message')).toBeTruthy();
        expect(byLabel('Report message')).toBeNull();
    });

    it("a refusal says the node's words and keeps the box open with the member's choice", async () => {
        await open();
        await tapBubble(BENS);
        await click(byLabel('Report message'));
        vi.mocked(reportGroupChatLine).mockRejectedValue(new GroupKeysRequestError('Message not found', 404, { error: 'Message not found', code: 'not_found' }));
        await click(button('Offensive content'));
        await click(byLabel('Submit report'));
        expect(vi.mocked(Alert.alert).mock.calls[0].slice(0, 2)).toEqual(['Not sent', 'Message not found']);
        expect(host.querySelector('[data-modal]')).toBeTruthy();
        expect(button('✓ Offensive content')).toBeTruthy();
    });
});
