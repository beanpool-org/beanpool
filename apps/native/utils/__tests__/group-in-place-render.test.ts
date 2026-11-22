// @vitest-environment jsdom
/**
 * Slice S6, part 1, as drawn (DESIGN-no-switch-messaging-fable.md §3, §6), at 320 dp with 1.3× text, light and dark: Talk →
 * Groups' row for a group of another community this phone holds (components/YourGroupsPane.tsx, YourGroupRow.tsx), and that
 * group's chat open in place (components/GroupChatView.tsx `inPlace`): its community's name, every call by that community,
 * what isn't done there offered as "Open {community} ›", nothing on the community in use. Where each call goes, and what is
 * refused, is group-in-place-table.test.ts's. Rendered for real: react-dom in jsdom, React Native's host components as tags.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
    const Loader = (process as any).getBuiltinModule('node:module');
    Loader._extensions['.jpg'] = (m: { exports: unknown }) => { m.exports = 1; };
});
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(3).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID, style, disabled, numberOfLines } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(typeof style === 'function' ? style({}) : style)) };
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'), Image: el('img'),
        FlatList: () => null, ActivityIndicator: () => null, Modal: () => null,
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {} },
        Alert: { alert: vi.fn() }, Linking: { openURL: vi.fn() },
        AppState: { currentState: 'active', addEventListener: () => ({ remove: () => { } }) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardState: (pick: (s: { height: number; isVisible: boolean }) => unknown) => pick({ height: 0, isVisible: false }),
    KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    KeyboardController: { dismiss: async () => { }, setInputMode: () => { } }, AndroidSoftInputModes: {},
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
const nav = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));
// The real useFocusEffect runs as an effect while the screen is focused: so here, in the order the screen declares them.
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return { router: { canGoBack: () => true, back: nav.back, replace: vi.fn(), push: nav.push }, useFocusEffect: (effect: () => unknown) => { useEffect(() => effect() as any, [effect]); } };
});
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const ctx = () => ({ theme: theme.dark ? 'dark' : 'light', colors: theme.dark ? darkColors : lightColors });
    return { useTheme: ctx, useStyles: (make: (c: unknown) => unknown) => make(ctx()) };
});
const ME = 'c'.repeat(64);
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: ME, callsign: 'Me' } }) }));
vi.mock('../../app/NodeStatusContext', () => ({ useNodeStatus: () => ({ recheck: async () => 'member' }) }));
vi.mock('../../components/chat/useChatPoll', async () => {
    const { useEffect } = await import('react');
    return { useChatPoll: (load: () => unknown) => { useEffect(() => { load(); }, [load]); } };
});
vi.mock('../../components/chat/useChatSoftInputMode', () => ({ useChatSoftInputMode: () => { } }));
const inUse = vi.hoisted(() => ({ getState: () => ({ items: [] }), markRead: vi.fn(), setMute: vi.fn(), noteSent: vi.fn(), refresh: vi.fn() }));
vi.mock('../../components/useYourGroups', () => ({ yourGroupsStore: inUse }));
vi.mock('../haptics', () => ({ hapticTick: vi.fn(), hapticSuccess: vi.fn(), hapticWarning: vi.fn() }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => ({ features: { voiceLines: true } }) }));
const alerts = vi.hoisted(() => ({ alert: vi.fn() }));
vi.mock('../keyboard-alert', () => ({ Alert: alerts }));
vi.mock('../../components/chat/ChatMessageList', () => ({
    ChatMessageList: (p: any) => createElement('div', null, ...(p.items || []).map((it: any, i: number) => createElement('div', { key: i, 'data-item': it.id }, p.renderMessage(it)))),
    scrollChatToBottom: () => { },
}));
const bits = vi.hoisted(() => ({ composer: null as any, menu: null as any, rows: [] as any[], report: null as any }));
vi.mock('../../components/chat/ChatMessageRow', () => ({ ChatMessageRow: (p: any) => { bits.rows.push(p); return createElement('span', null, p.item?.text ?? ''); } }));
vi.mock('../../components/chat/ChatComposer', async () => {
    const R = await import('react');
    return { ChatComposer: R.forwardRef((p: any, _r: any) => { bits.composer = p; return R.createElement('div', null); }) };
});
vi.mock('../../components/chat/ChatBanners', () => ({ ChatEditBanner: () => null, ChatMenuSheet: (p: any) => { bits.menu = p; return null; }, ChatReplyBanner: () => null }));
vi.mock('../../components/ReportMessageSheet', () => ({ ReportMessageSheet: (p: any) => { bits.report = p; return null; } }));
vi.mock('../../components/LockedHistory', () => ({
    LockedHistoryRow: (p: any) => createElement('button', { 'data-testid': 'locked-history', onClick: p.onPress }, p.text),
    LockedHistorySheet: (p: any) => createElement('i', { 'data-history': String(p.open) }), SealedNoticeLine: () => null,
}));
vi.mock('../../components/InvitePeopleSheet', () => ({ InvitePeopleSheet: () => createElement('i', { 'data-invite': '1' }) }));
vi.mock('../../components/GroupDetailModal', () => ({ GroupDetailModal: () => createElement('i', { 'data-info': '1' }) }));
vi.mock('../../components/CreateGroupModal', () => ({ CreateGroupModal: () => null }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: ({ avatarUrl }: { avatarUrl: string | null }) => createElement('i', { 'data-face': String(avatarUrl) }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'line-in-place' }));
vi.mock('expo-image-picker', () => ({ requestCameraPermissionsAsync: vi.fn(), launchCameraAsync: vi.fn(), launchImageLibraryAsync: vi.fn() }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: vi.fn(), SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => { }), removeItem: vi.fn(async () => { }), getAllKeys: vi.fn(async () => []) } }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/' }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => null) }));
const guests = vi.hoisted(() => ({ rows: vi.fn(async () => ({ shown: [], named: [] })) }));
vi.mock('../guest-chat-live', () => ({ guestRosterRows: guests.rows }));
const moved = vi.hoisted(() => ({ run: vi.fn(async (..._a: unknown[]) => 'switched') }));
vi.mock('../open-in-community', () => ({ openInCommunity: moved.run }));
const VIEW = { signer: ME, epoch: 1, text: 'my line', name: 'Me', nameHint: null, details: null, hidden: false, waitingKey: false, unverified: false };
const BY_DANA = { ...VIEW, signer: 'd'.repeat(64), text: 'her line', name: 'Dana' };
const changedPhone = vi.hoisted(() => ({ locked: false }));
vi.mock('../group-chat-lines', async (orig) => ({ ...(await orig<any>()), openGroupThread: vi.fn(async () => ({ views: new Map<string, any>([['m1', VIEW], ['m2', BY_DANA]]), waitingForNextKey: false })) }));
vi.mock('../group-history-unlock', async (orig) => {
    const real = await orig<any>();
    return { ...real, collapseLockedHistory: (lines: any[], o: any) => (changedPhone.locked ? [o.row(3), ...lines] : real.collapseLockedHistory(lines, o)) };
});
/** Every call the screen makes of utils/db, in order: its name and what it was handed. */
const calls = vi.hoisted(() => ({ list: [] as Array<[string, any[]]>, refuse: new Map<string, string>() }));
vi.mock('../db', () => {
    const answers: Record<string, unknown> = {
        getGroupChat: {
            messages: [
                { id: 'm1', authorPubkey: 'c'.repeat(64), type: 'text', nonce: 'group-xc20p-v1:x', ciphertext: 'x', metadata: { epoch: 1 }, timestamp: '2026-11-22T00:00:00.000Z' },
                { id: 'm2', authorPubkey: 'd'.repeat(64), type: 'text', nonce: 'group-xc20p-v1:x', ciphertext: 'x', metadata: { epoch: 1 }, timestamp: '2026-11-22T00:01:00.000Z' },
            ],
            group: { name: 'Garden Crew', avatarUrl: '/uploads/garden.jpg' }, encryption: { current: 1, stale: false, fromEpoch: 1 }, canPost: true, isConvenor: true,
        },
        fetchGroupDetails: { group: { id: 'g', name: 'Garden Crew', memberCount: 2, avatarUrl: '/uploads/garden.jpg' }, members: [] },
        groupScreenKeyringFor: { seenLocked: async () => true, noteShownRoster: () => { }, serveMissing: async () => { }, sync: async () => null },
        muteChatApi: { mute: { conversationId: 'g', mutedUntil: null, always: true } }, leaveGroupApi: true, reportGroupChatLine: {},
    };
    const fn = (name: string) => (...args: any[]) => {
        calls.list.push([name, args]);
        if (name === 'whileChatInPlace') return args[1]();
        if (calls.refuse.has(name)) return Promise.reject(new Error(calls.refuse.get(name)));
        return Promise.resolve(answers[name] ?? { success: true });
    };
    const names = ['getGroupChat', 'postGroupChatMessage', 'postGroupChatPhoto', 'getDecryptedGroupPhoto', 'postGroupChatVoice', 'getDecryptedGroupVoice', 'getEnterpriseChat', 'postEnterpriseChatMessage', 'muteChatApi',
        'fetchGroupDetails', 'markThreadReadOnNode', 'toggleMessageReactionApi', 'editThreadMessage', 'deleteMessageApi', 'removeGroupChatMessage', 'groupScreenKeyringFor', 'noteLockedHistoryRow', 'reportGroupChatLine',
        'leaveGroupApi', 'enterChatInPlace', 'leaveChatInPlace', 'whileChatInPlace', 'fetchYourGroups'];
    return Object.fromEntries(names.map((n) => [n, n === 'enterChatInPlace' ? (c: unknown) => { calls.list.push([n, [c]]); } : fn(n)]));
});
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: (u: string | null) => `community_${String(u).replace(/^https?:\/\//, '').toLowerCase()}.db`, isGuestCopy: async () => false }));

import { GroupChatView } from '../../components/GroupChatView';
import { YourGroupsRows } from '../../components/YourGroupsPane';
import { groupsListed, heldGroups, HELD_GROUP, type HeldGroup } from '../held-groups';
import { groupsUnreadTotal, type YourChat } from '../your-groups';
import { lightColors, darkColors } from '../../constants/colors';

const A = 'https://riverside.example';
const G = 'b78da72e-773f-4425-914a-8bfbd4e4130a';
const OWN: YourChat = { kind: 'group', badge: null, id: 'own-1', conversationId: 'own-1', name: 'Book club', avatarUrl: null, role: 'member', readOnly: false, lastMessage: null, unreadCount: 1, mute: null, lastActivityAt: '2026-11-22T02:00:00.000Z' };
const LONG = 'Riverside and the Upper Valley Neighbourhood Community';
const HELD: HeldGroup = { ...OWN, id: G, conversationId: G, name: 'Garden Crew', unreadCount: 3, avatarUrl: `${A}/uploads/garden.jpg`, lastActivityAt: '2026-11-22T03:00:00.000Z', [HELD_GROUP]: true, movedAt: Date.parse('2026-11-22T03:00:00.000Z'), key: `held-group:x:${G}`, community: A, communityName: LONG };

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    calls.list.length = 0;
    calls.refuse.clear();
    bits.rows.length = 0;
    bits.composer = bits.menu = bits.report = null;
    changedPhone.locked = false;
    for (const f of [nav.push, nav.back, alerts.alert, moved.run, inUse.markRead, inUse.setMute, inUse.noteSent, guests.rows]) f.mockClear();
});
afterEach(async () => { await act(async () => { root.unmount(); }); });
const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const render = async (el: unknown) => { await act(async () => { root.render(el as any); }); await settle(); };
const styleOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}');
const of = (name: string) => calls.list.filter(([n]) => n === name).map(([, a]) => a);
const item = (label: string) => bits.menu.items.find((i: any) => i.label === label);
const shownItems = () => bits.menu.items.filter((i: any) => !i.hidden).map((i: any) => i.label);

describe('Talk → Groups: a group of another community this phone holds', () => {
    for (const dark of [false, true]) {
        const colors = dark ? darkColors : lightColors;
        it(`${dark ? 'dark' : 'light'}, 320 dp × 1.3: its community's name in grey, whole (it wraps), its own count, and no switch said`, async () => {
            theme.dark = dark;
            await render(createElement(YourGroupsRows, { items: groupsListed([OWN], [HELD]), myPubkey: ME, showUnread: true }));
            const rows = Array.from(host.querySelectorAll('button'));
            // Newest line first: the held one, then this community's own.
            expect(rows.map((r) => r.textContent?.includes('Garden Crew'))).toEqual([true, false]);
            const where = host.querySelector('[data-testid="held-group-community"]')!;
            expect(where.textContent).toBe(LONG);
            expect(styleOf(where).color).toBe(colors.text.secondary);
            expect(where.getAttribute('data-lines'), 'never cut: it wraps').toBeNull();
            expect(styleOf(where).flexShrink).toBe(1);
            expect(rows[0].textContent).toContain('3');
            expect(rows[0].textContent).not.toContain('Switch');
            expect(rows[0].getAttribute('aria-label')).toBe(`Garden Crew, group, ${LONG}, 3 unread. No messages yet`);
            expect(host.querySelector(`[data-face="${A}/uploads/garden.jpg"]`), 'its own community\'s picture').not.toBeNull();
            // This community's own row says no community.
            expect(host.querySelectorAll('[data-testid="held-group-community"]').length).toBe(1);
        });
    }

    it('a tap opens it in place, in its own community, and reads its own row alone; this community\'s own opens as before', async () => {
        const read = vi.fn();
        const at = vi.spyOn(heldGroups, 'at').mockReturnValue({ markRead: read, noteSent: () => { }, setMute: () => { } });
        await render(createElement(YourGroupsRows, { items: groupsListed([OWN], [HELD]), myPubkey: ME, showUnread: true }));
        const [held, own] = Array.from(host.querySelectorAll('button'));
        await act(async () => { held.click(); });
        expect(nav.push.mock.calls).toEqual([[{ pathname: '/chat/[id]', params: { id: G, community: A, communityName: LONG, group: '1', name: 'Garden Crew' } }]]);
        expect(at.mock.calls).toEqual([[A]]);
        expect(read.mock.calls).toEqual([[G]]);
        expect(inUse.markRead).not.toHaveBeenCalled();
        await act(async () => { own.click(); });
        expect(nav.push.mock.calls[1]).toEqual([{ pathname: '/chat/own-1', params: { group: '1', name: 'Book club' } }]);
        expect(inUse.markRead.mock.calls).toEqual([['own-1']]);
        at.mockRestore();
    });

    it('one list, newest first over every row (each by its place, a line just sent the newest), and one total (a muted one adds nothing)', () => {
        const at = (iso: string) => ({ lastActivityAt: iso, movedAt: Date.parse(iso) });
        const own2 = { ...OWN, id: 'own-2', conversationId: 'own-2', lastActivityAt: '2026-11-22T01:00:00.000Z' };
        const older = { ...HELD, conversationId: 'h2', key: 'held-group:x:h2', ...at('2026-11-22T01:30:00.000Z'), mute: { conversationId: 'h2', mutedUntil: null, always: true } };
        const oldest = { ...HELD, conversationId: 'h3', key: 'held-group:x:h3', ...at('2026-11-20T00:00:00.000Z'), unreadCount: 0 };
        const listed = groupsListed([OWN, own2], [oldest, older, HELD]);
        expect(listed.map((i) => i.conversationId)).toEqual([G, 'own-1', 'h2', 'own-2', 'h3']);
        // Sent in here, a moment ago: each above every line before it, whichever list it is in.
        const sentAt = Date.parse('2026-11-22T05:00:00.000Z');
        expect(groupsListed([OWN, own2], [oldest, older, HELD], (i) => (i.id === 'own-2' ? sentAt : Date.parse(i.lastActivityAt))).map((i) => i.conversationId)).toEqual(['own-2', G, 'own-1', 'h2', 'h3']);
        expect(groupsListed([OWN, own2], [{ ...oldest, movedAt: sentAt }, older, HELD]).map((i) => i.conversationId)).toEqual(['h3', G, 'own-1', 'h2', 'own-2']);
        expect(groupsUnreadTotal(listed)).toBe(3 + 1 + 1);
        // Nothing of this community's own (no groups yet): the held ones alone.
        expect(groupsListed([], [HELD])).toEqual([HELD]);
    });

    it('a row of the community in use is drawn as its own, whatever fields its server writes on it (review of #3358, F3)', async () => {
        const at = vi.spyOn(heldGroups, 'at');
        const painted = JSON.parse(JSON.stringify({ ...HELD, id: 'own-1', conversationId: 'own-1', name: 'Book club' }));
        await render(createElement(YourGroupsRows, { items: groupsListed([painted], []), myPubkey: ME, showUnread: true }));
        expect(host.querySelector('[data-testid="held-group-community"]')).toBeNull();
        expect(host.textContent).not.toContain(LONG);
        await act(async () => { host.querySelector('button')!.click(); });
        expect(nav.push.mock.calls).toEqual([[{ pathname: '/chat/own-1', params: { group: '1', name: 'Book club' } }]]);
        expect(at).not.toHaveBeenCalled();
        at.mockRestore();
    });

    it('the Chat screen lists and totals that one list, and asks as it opens, at each change of the counts and at the pull', () => {
        const chats = fs.readFileSync(path.join(__dirname, '..', '..', 'app', '(tabs)', 'chats.tsx'), 'utf8');
        expect(chats).toContain('const groupsUnread = React.useMemo(() => groupsUnreadTotal(groupsShown), [groupsShown]);');
        expect(chats).toContain('<YourGroupsRows items={groupsShown}');
        expect(chats).toContain('useHeldGroups(identity?.publicKey)');
        expect(chats).toMatch(/const loadGroups = \(\) => \{ if \(identity\?\.publicKey\) void heldGroups\.refresh\(identity\.publicKey\)/);
        expect(chats).toContain('onNoticeCounts(() => { void freshen(); loadGroups(); })');
        // Each of its rows by its store's own place, and the pull (and Try again) asks both lists (review of #3358, F2 and F5).
        expect(chats).toContain('groupsListed(yourGroups ?? [], groupsHeld, yourGroupsLive.movedAt)');
        expect(chats).toMatch(/const refreshGroups = \(\) => \{\s+void yourGroupsLive\.refresh\(\);\s+if \(identity\?\.publicKey\) void heldGroups\.refresh\(identity\.publicKey\)\.catch\(\(\) => \{\}\);\s+\};/);
        expect(chats).toContain('<RefreshControl refreshing={false} onRefresh={refreshGroups}');
        expect(chats).toContain('onRetry={refreshGroups}');
    });
});

describe('a group\'s chat in place (GroupChatView inPlace)', () => {
    const open = (inPlace: { community: string; name: string } | null = { community: A, name: 'Riverside' }) =>
        render(createElement(GroupChatView, { kind: 'group', id: G, initialName: 'Garden Crew', inPlace: inPlace ?? undefined }));

    for (const dark of [false, true]) {
        it(`${dark ? 'dark' : 'light'}, 320 dp × 1.3: the group's name, its community's under it, its picture from there; no photo or voice button`, async () => {
            theme.dark = dark;
            await open();
            expect(host.textContent).toContain('Garden Crew');
            expect(host.textContent).toContain('group · Riverside');
            expect(host.querySelector(`[data-face="${A}/uploads/garden.jpg"]`)).not.toBeNull();
            expect(bits.composer, 'it can be answered').not.toBeNull();
            expect([bits.composer.onAttach, bits.composer.onVoice]).toEqual([undefined, undefined]);
            expect(host.querySelector('[data-invite], [data-info]')).toBeNull();
        });
    }

    it('held before its first read, every read by its own community, let go as it is left', async () => {
        await open();
        const order = calls.list.map(([n]) => n);
        expect(order[0]).toBe('enterChatInPlace');
        expect(of('enterChatInPlace')).toEqual([[A]]);
        expect(of('getGroupChat')).toEqual([[G, undefined, undefined, A]]);
        expect(of('fetchGroupDetails')).toEqual([[G, A]]);
        expect(of('groupScreenKeyringFor').every((a) => a[1] === A)).toBe(true);
        expect(of('markThreadReadOnNode')).toEqual([[G, ME, A]]);
        expect(guests.rows.mock.calls.map((c: any[]) => [c[0], c[2]])).toEqual([[G, A]]);
        expect(of('noteLockedHistoryRow')).toEqual([]);
        // The community in use's own row of the same id is never touched.
        expect([inUse.markRead.mock.calls, inUse.setMute.mock.calls, inUse.noteSent.mock.calls]).toEqual([[], [], []]);
        expect(of('leaveChatInPlace')).toEqual([]);
        await act(async () => { root.render(null); });
        expect(of('leaveChatInPlace')).toEqual([[A]]);
    });

    it('a reply, a reaction, an edit, a delete, a removal, a report and a mute each name its own community', async () => {
        await open();
        await act(async () => { await bits.composer.onSend('a reply in place'); });
        await settle();
        const sent = of('postGroupChatMessage')[0];
        expect([sent[0], sent[1], sent[5]]).toEqual([G, 'a reply in place', A]);
        const mine = bits.rows.filter((r) => r.item.id === 'm1').pop();
        const hers = bits.rows.filter((r) => r.item.id === 'm2').pop();
        await act(async () => { await mine.onPickEmoji('👍'); });
        expect(of('toggleMessageReactionApi')).toEqual([['m1', ME, '👍', A, G]]);
        await act(async () => { await mine.onDelete(); });
        await settle();
        await act(async () => { await alerts.alert.mock.calls.pop()![2][1].onPress(); });
        expect(of('deleteMessageApi')).toEqual([['m1', A, G]]);
        await act(async () => { await hers.onRemove(); });
        await settle();
        await act(async () => { await alerts.alert.mock.calls.pop()![2][1].onPress(); });
        expect(of('removeGroupChatMessage')).toEqual([[G, 'm2', A]]);
        await act(async () => { hers.onReport(); });
        await act(async () => { await bits.report.onSubmit('Spam or scam'); });
        expect(of('reportGroupChatLine')[0]).toEqual([G, 'm2', BY_DANA, 'Spam or scam', A]);
        await act(async () => { await bits.menu.onPickMute('always'); });
        expect(of('muteChatApi')).toEqual([[G, 'always', A]]);
        await act(async () => { mine.onEdit(); });
        await act(async () => { await bits.composer.onSend('edited in place'); });
        await settle();
        const edit = of('editThreadMessage')[0];
        expect([edit[0], edit[1], edit[2].groupId, edit[3]]).toEqual(['m1', 'edited in place', G, A]);
        // Each of its sends, edits and reports is held until it settles.
        expect(of('whileChatInPlace').every((a) => a[0] === A)).toBe(true);
        expect(of('whileChatInPlace').length).toBe(3);
        expect([inUse.markRead.mock.calls, inUse.setMute.mock.calls, inUse.noteSent.mock.calls]).toEqual([[], [], []]);
    });

    it('the menu: what is done here, Leave Group, and the rest as "Open Riverside ›"', async () => {
        await open();
        expect(shownItems()).toEqual(['Mute notifications', 'Search this chat', 'Leave Group', 'Open Riverside ›']);
        // Contrast: in use, the menu as it always was.
        await act(async () => { root.render(null); });
        await open(null);
        expect(shownItems()).not.toContain('Open Riverside ›');
        expect(shownItems()).not.toContain('Leave Group');
        expect(shownItems()).toEqual(expect.arrayContaining(['Invite people', 'Group info']));
    });

    it('the group\'s header opens no page (the community in use\'s, of the same id, least of all) and says it opens none', async () => {
        await open();
        const said = Array.from(host.querySelectorAll('[aria-label]')).map((b) => b.getAttribute('aria-label')!);
        expect(said.filter((l) => l.includes('Opens the group page'))).toEqual([]);
        expect(host.textContent).not.toContain('tap for info');
        const title = Array.from(host.querySelectorAll('span')).find((x) => x.textContent?.endsWith('Garden Crew'))!;
        await act(async () => { (title.closest('button') as HTMLElement).click(); });
        expect([nav.push.mock.calls, host.querySelector('[data-info]')]).toEqual([[], null]);
        // Contrast: in use, the header is the way to the group's page, and says so.
        await act(async () => { root.render(null); });
        await open(null);
        expect(Array.from(host.querySelectorAll('[aria-label]')).some((b) => b.getAttribute('aria-label')!.includes('Opens the group page'))).toBe(true);
        expect(host.textContent).toContain('tap for info');
    });

    it('Open Riverside ›: the phone moves there and opens this group; a tap that moved nothing says so', async () => {
        await open();
        await act(async () => { item('Open Riverside ›').onPress(); });
        await settle();
        expect(moved.run.mock.calls[0].slice(0, 3)).toEqual([A, `/chat/${G}?group=1`, ME]);
        expect(alerts.alert).not.toHaveBeenCalled();
        for (const answer of ['held', 'failed']) {
            alerts.alert.mockClear();
            moved.run.mockResolvedValueOnce(answer);
            await act(async () => { item('Open Riverside ›').onPress(); });
            await settle();
            expect(alerts.alert.mock.calls, answer).toEqual([['Riverside', 'Something went wrong. Try again in a moment.']]);
        }
    });

    it('a second Open Riverside › while the phone is moving asks nothing more and says nothing; once that move ends, it can be asked again (review of #3358, F4)', async () => {
        await open();
        let end!: (how: string) => void;
        moved.run.mockImplementationOnce(() => new Promise((r) => { end = r; }));
        await act(async () => { item('Open Riverside ›').onPress(); });
        await act(async () => { item('Open Riverside ›').onPress(); });
        await settle();
        expect([moved.run.mock.calls.length, alerts.alert.mock.calls]).toEqual([1, []]);
        await act(async () => { end('failed'); });
        await settle();
        expect(alerts.alert.mock.calls, 'the move itself failed').toEqual([['Riverside', 'Something went wrong. Try again in a moment.']]);
        await act(async () => { item('Open Riverside ›').onPress(); });
        await settle();
        expect(moved.run.mock.calls.length).toBe(2);
    });

    it('the lines from before a change of phone say where they open, and offer the move; no sheet of the community in use\'s', async () => {
        changedPhone.locked = true;
        await open();
        await act(async () => { (host.querySelector('[data-testid="locked-history"]') as HTMLElement).click(); });
        const [title, body, buttons] = alerts.alert.mock.calls[0] as any[];
        expect([title, body]).toEqual(['Riverside', 'Chat with Garden Crew in Riverside. Opens that community.']);
        expect(buttons.map((b: any) => b.text)).toEqual(['Cancel', 'Open Riverside ›']);
        expect(host.querySelector('[data-history="true"]')).toBeNull();
        await act(async () => { buttons[1].onPress(); });
        await settle();
        expect(moved.run.mock.calls[0].slice(0, 2)).toEqual([A, `/chat/${G}?group=1`]);
    });

    it('Leave Group: asked first, then left in its own community, its row gone and the chat closed; a refusal says why and stays', async () => {
        const forget = vi.spyOn(heldGroups, 'forget').mockImplementation(() => { });
        await open();
        await act(async () => { item('Leave Group').onPress(); });
        await settle();
        const [title, body, buttons] = alerts.alert.mock.calls.pop() as any[];
        expect([title, body, buttons.map((b: any) => b.text)]).toEqual(['Leave Group', 'Are you sure you want to leave Garden Crew?', ['Cancel', 'Leave']]);
        expect(of('leaveGroupApi')).toEqual([]);
        await act(async () => { await buttons[1].onPress(); });
        expect(of('leaveGroupApi')).toEqual([[G, ME, undefined, A]]);
        expect(forget.mock.calls).toEqual([[A, G]]);
        expect(nav.back).toHaveBeenCalledTimes(1);
        // Refused there (a lead convenor hands over first): the server's own words, the row and the chat stay.
        for (const [said, shown] of [['Hand the lead to someone else first', 'Hand the lead to someone else first'], ['', 'Failed to leave group']]) {
            forget.mockClear();
            nav.back.mockClear();
            calls.refuse.set('leaveGroupApi', said);
            await act(async () => { item('Leave Group').onPress(); });
            await settle();
            await act(async () => { await (alerts.alert.mock.calls.pop() as any[])[2][1].onPress(); });
            expect(alerts.alert.mock.calls.pop()).toEqual(['Leave Failed', shown]);
            expect([forget.mock.calls, nav.back.mock.calls]).toEqual([[], []]);
        }
        forget.mockRestore();
    });
});
