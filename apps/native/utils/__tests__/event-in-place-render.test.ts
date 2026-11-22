// @vitest-environment jsdom
/**
 * Slice S6, events, as drawn (DESIGN-no-switch-messaging-fable.md §3, §6), at 320 dp with 1.3× text, light and dark: Talk →
 * Groups' row for an event of another community this phone holds (components/YourGroupRow.tsx), and that event's chat open in
 * place (components/EventChatView.tsx `inPlace`): its community's name, every call by that community, its own gates said in
 * its words, what isn't done there offered as "Open {community} ›", nothing on the community in use. Where each call goes, and
 * what is refused, is event-in-place-table.test.ts's. Rendered for real: react-dom in jsdom, React Native's host components as
 * tags.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(3).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, style, disabled, numberOfLines } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(typeof style === 'function' ? style({}) : style)) };
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
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
const DANA = 'd'.repeat(64);
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: ME, callsign: 'Me' } }) }));
vi.mock('../../app/NodeStatusContext', () => ({ useNodeStatus: () => ({ recheck: async () => 'member' }) }));
const poll = vi.hoisted(() => ({ again: null as null | (() => unknown) }));
vi.mock('../../components/chat/useChatPoll', async () => {
    const { useEffect } = await import('react');
    return { useChatPoll: (load: () => unknown) => { useEffect(() => { poll.again = load; load(); }, [load]); } };
});
vi.mock('../../components/chat/useChatSoftInputMode', () => ({ useChatSoftInputMode: () => { } }));
const inUse = vi.hoisted(() => ({ getState: () => ({ items: [] as any[] }), markRead: vi.fn(), setMute: vi.fn(), noteSent: vi.fn(), refresh: vi.fn() }));
vi.mock('../../components/useYourGroups', () => ({ yourGroupsStore: inUse }));
vi.mock('../haptics', () => ({ hapticTick: vi.fn(), hapticSuccess: vi.fn(), hapticWarning: vi.fn() }));
const alerts = vi.hoisted(() => ({ alert: vi.fn() }));
vi.mock('../keyboard-alert', () => ({ Alert: alerts }));
vi.mock('../../components/chat/ChatMessageList', () => ({
    ChatMessageList: (p: any) => createElement('div', null, ...((p.items || []).length ? (p.items || []).map((it: any, i: number) => createElement('div', { key: i, 'data-item': it.id }, p.renderMessage(it))) : [p.ListEmptyComponent])),
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
vi.mock('../../components/CreateGroupModal', () => ({ CreateGroupModal: () => null }));
vi.mock('../../components/EventCard', () => ({ EVENT_ACCENT: '#7c3aed' }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: ({ avatarUrl }: { avatarUrl: string | null }) => createElement('i', { 'data-face': String(avatarUrl) }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'line-in-place' }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => { }), removeItem: vi.fn(async () => { }), getAllKeys: vi.fn(async () => []) } }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/' }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => null) }));
const moved = vi.hoisted(() => ({ run: vi.fn(async (..._a: unknown[]) => 'switched') }));
vi.mock('../open-in-community', () => ({ openInCommunity: moved.run }));
/** Every call the screen makes of utils/db, in order: its name and what it was handed. */
const calls = vi.hoisted(() => ({ list: [] as Array<[string, any[]]>, refuse: new Map<string, unknown>(), answer: new Map<string, unknown>() }));
vi.mock('../db', () => {
    const answers: Record<string, unknown> = { muteChatApi: { mute: { conversationId: 'e', mutedUntil: null, always: true } }, reportEvent: {} };
    const fn = (name: string) => (...args: any[]) => {
        calls.list.push([name, args]);
        if (name === 'whileChatInPlace') return args[1]();
        const refusal = calls.refuse.get(name);
        if (refusal !== undefined) return Promise.reject(typeof refusal === 'string' ? new Error(refusal) : refusal);
        return Promise.resolve(calls.answer.get(name) ?? answers[name] ?? { success: true });
    };
    const names = ['getEventChat', 'postEventChatMessage', 'removeEventChatMessage', 'reportEvent', 'markConversationRead', 'markThreadReadOnNode', 'muteChatApi', 'leaveChatInPlace', 'whileChatInPlace', 'fetchYourGroups'];
    return Object.fromEntries([...names, 'enterChatInPlace'].map((n) => [n, n === 'enterChatInPlace' ? (c: unknown) => { calls.list.push([n, [c]]); } : fn(n)]));
});
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: (u: string | null) => `community_${String(u).replace(/^https?:\/\//, '').toLowerCase()}.db`, isGuestCopy: async () => false }));

import { EventChatView } from '../../components/EventChatView';
import { YourGroupsRows } from '../../components/YourGroupsPane';
import { groupsListed, heldGroups, HELD_GROUP, type HeldGroup } from '../held-groups';
import { groupsUnreadTotal, type YourChat } from '../your-groups';
import { lightColors, darkColors } from '../../constants/colors';

const A = 'https://riverside.example';
const EV = 'b78da72e-773f-4425-914a-8bfbd4e4130a';
const LONG = 'Riverside and the Upper Valley Neighbourhood Community';
const OWN: YourChat = { kind: 'event', badge: null, id: 'own-1', conversationId: 'own-1', name: 'Seed swap', avatarUrl: null, role: 'going', readOnly: false, lastMessage: null, unreadCount: 1, mute: null, lastActivityAt: '2026-11-22T02:00:00.000Z' } as YourChat;
const HELD: HeldGroup = { ...OWN, id: EV, conversationId: EV, name: 'Working bee', unreadCount: 3, lastActivityAt: '2026-11-22T03:00:00.000Z', [HELD_GROUP]: true, movedAt: Date.parse('2026-11-22T03:00:00.000Z'), key: `held-group:a:${EV}`, community: A, communityName: LONG } as HeldGroup;
const line = (id: string, author: string, text: string) => ({ id, authorPubkey: author, authorCallsign: author === ME ? 'Me' : 'Dana', type: 'text', nonce: 'plaintext-v1', ciphertext: btoa(text), metadata: null, timestamp: '2026-11-22T00:00:00.000Z' });
const CHAT = {
    messages: [line('m1', DANA, 'bring gloves'), line('m2', ME, 'will do')], title: 'Working bee', canPost: true, readOnly: false, readOnlyReason: null, isHost: false,
    privateNote: 'Gate code 4412', notice: "Visible to the host, everyone going, and this node's operator.",
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    calls.list.length = 0;
    calls.refuse.clear();
    calls.answer.clear();
    calls.answer.set('getEventChat', CHAT);
    bits.rows.length = 0;
    bits.composer = bits.menu = bits.report = null;
    theme.dark = false;
    for (const f of [nav.push, nav.back, alerts.alert, moved.run, inUse.markRead, inUse.setMute, inUse.noteSent]) f.mockClear();
});
afterEach(async () => { await act(async () => { root.unmount(); }); vi.restoreAllMocks(); });
const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const render = async (el: unknown) => { await act(async () => { root.render(el as any); }); await settle(); };
const styleOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}');
const of = (name: string) => calls.list.filter(([n]) => n === name).map(([, a]) => a);
const item = (label: string) => bits.menu.items.find((i: any) => i.label === label && !i.hidden);
const shownItems = () => bits.menu.items.filter((i: any) => !i.hidden).map((i: any) => i.label);
const open = (inPlace: { community: string; name: string } | null = { community: A, name: 'Riverside' }) => render(createElement(EventChatView, { eventId: EV, inPlace: inPlace ?? undefined }));
const inUseUntouched = () => expect([inUse.markRead.mock.calls, inUse.setMute.mock.calls, inUse.noteSent.mock.calls]).toEqual([[], [], []]);
/** What that community's own list keeps of the row, for the calls the screen makes of it. */
const itsRow = () => {
    const row = { markRead: vi.fn(), readThere: vi.fn(), noteSent: vi.fn(), setMute: vi.fn() };
    return { row, at: vi.spyOn(heldGroups, 'at').mockReturnValue(row) };
};

describe('Talk → Groups: an event of another community this phone holds', () => {
    for (const dark of [false, true]) {
        const colors = dark ? darkColors : lightColors;
        it(`${dark ? 'dark' : 'light'}, 320 dp × 1.3: its community's name in grey, whole (it wraps), its kind, its own count, and no switch said`, async () => {
            theme.dark = dark;
            await render(createElement(YourGroupsRows, { items: groupsListed([OWN], [HELD]), myPubkey: ME, showUnread: true }));
            const rows = Array.from(host.querySelectorAll('button'));
            expect(rows.map((r) => r.textContent?.includes('Working bee'))).toEqual([true, false]);
            const where = host.querySelector('[data-testid="held-group-community"]')!;
            expect(where.textContent).toBe(LONG);
            expect(styleOf(where).color).toBe(colors.text.secondary);
            expect([where.getAttribute('data-lines'), styleOf(where).flexShrink], 'never cut: it wraps').toEqual([null, 1]);
            expect(rows[0].textContent).toContain('📅');
            expect(rows[0].textContent).toContain('3');
            expect(rows[0].textContent).not.toContain('Switch');
            expect(rows[0].getAttribute('aria-label')).toBe(`Working bee, event, ${LONG}, 3 unread. No messages yet`);
            // This community's own event says no community.
            expect(host.querySelectorAll('[data-testid="held-group-community"]').length).toBe(1);
        });
    }

    it('a tap opens it in place, in its own community, and reads its own row alone; this community\'s own opens as before; one total', async () => {
        const { row, at } = itsRow();
        const listed = groupsListed([OWN], [HELD]);
        await render(createElement(YourGroupsRows, { items: listed, myPubkey: ME, showUnread: true }));
        const [held, own] = Array.from(host.querySelectorAll('button'));
        await act(async () => { held.click(); });
        expect(nav.push.mock.calls).toEqual([[{ pathname: '/chat/[id]', params: { id: EV, community: A, communityName: LONG, event: '1', name: 'Working bee' } }]]);
        expect([at.mock.calls, row.markRead.mock.calls, inUse.markRead.mock.calls]).toEqual([[[A]], [[EV]], []]);
        await act(async () => { own.click(); });
        expect(nav.push.mock.calls[1]).toEqual([{ pathname: '/chat/own-1', params: { event: '1', name: 'Seed swap' } }]);
        expect(inUse.markRead.mock.calls).toEqual([['own-1']]);
        expect(groupsUnreadTotal(listed)).toBe(4);
    });
});

describe('an event\'s chat in place (EventChatView inPlace)', () => {
    for (const dark of [false, true]) {
        const colors = dark ? darkColors : lightColors;
        it(`${dark ? 'dark' : 'light'}, 320 dp × 1.3: the event's name, its community's under it, the note, the lines and a box to answer in`, async () => {
            theme.dark = dark;
            await open();
            expect(host.textContent).toContain('📅 Working bee');
            expect(host.textContent).toContain('event · Riverside');
            for (const words of ['Gate code 4412', 'bring gloves', 'will do']) expect(host.textContent).toContain(words);
            expect([bits.composer.notice, bits.composer.onAttach, bits.composer.onVoice]).toEqual([CHAT.notice, undefined, undefined]);
        });

        it(`${dark ? 'dark' : 'light'}: refused there (only Interested, or neither): its own words, Try again, and the way to the event's page; both tap targets 48 dp`, async () => {
            theme.dark = dark;
            calls.refuse.set('getEventChat', 'Only the host and people going can open this event chat');
            await open();
            const words = host.querySelector('[data-role="alert"]')!;
            expect(words.textContent).toBe('Only the host and people going can open this event chat');
            expect(styleOf(words).color).toBe(colors.text.body);
            expect(words.getAttribute('data-lines'), 'whole').toBeNull();
            const go = host.querySelector('[data-testid="event-open-there"]')!;
            expect(go.textContent).toBe('Open Riverside ›');
            expect(styleOf(go).minHeight).toBe(48);
            expect(styleOf(go.querySelector('span')).color).toBe(colors.brand.primary);
            expect(Array.from(host.querySelectorAll('button')).map((b) => b.textContent)).toContain('Try again');
            expect([bits.composer, host.textContent!.includes('Gate code')]).toEqual([null, false]);
            await act(async () => { (go as HTMLElement).click(); });
            await settle();
            expect(moved.run.mock.calls[0].slice(0, 3)).toEqual([A, `/post/${EV}`, ME]);
        });
    }

    it('Going, and not let in yet: said as that, never as not going; Try again asks that community again, and it opens once let in', async () => {
        calls.refuse.set('getEventChat', Object.assign(new Error("The host hasn't let you in yet: the chat opens when they do."), { code: 'waiting_for_host' }));
        await open();
        expect(host.querySelector('[data-role="alert"]')!.textContent).toBe('Chat opens when the host lets you in.');
        calls.refuse.clear();
        await act(async () => { (Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Try again') as HTMLElement).click(); });
        await settle();
        expect(of('getEventChat').every((a) => a[3] === A)).toBe(true);
        expect(host.textContent).toContain('bring gloves');
    });

    it.each([
        ['ended', 'This event has ended. The chat is read-only.'], ['cancelled', 'This event was cancelled. The chat is read-only.'],
    ])('the event %s: read-only in that community\'s words; no box to answer in, and the rest of the menu stays', async (_n, why) => {
        calls.answer.set('getEventChat', { ...CHAT, readOnly: true, readOnlyReason: why, canPost: false });
        await open();
        expect(host.textContent).toContain(why);
        expect(host.textContent).toContain('event · Riverside');
        expect(bits.composer).toBeNull();
        expect(shownItems()).toEqual(['Mute notifications', 'Report event', 'Open Riverside ›']);
    });

    it('held before its first read, every read by its own community, read there once for each newest line, let go as it is left', async () => {
        const { row } = itsRow();
        await open();
        expect(calls.list[0]).toEqual(['enterChatInPlace', [A]]);
        expect(of('getEventChat')).toEqual([[EV, undefined, undefined, A]]);
        expect(of('markThreadReadOnNode')).toEqual([[EV, ME, A]]);
        expect(of('markConversationRead'), 'the phone\'s own read marks are the community in use\'s').toEqual([]);
        expect(row.markRead.mock.calls[0]).toEqual([EV]);
        // The same newest line at the next poll: nothing more; a new one: marked again. Refused: the next poll tries again.
        await act(async () => { await poll.again!(); });
        expect(of('markThreadReadOnNode').length).toBe(1);
        // Its lines leave that community's number on the mark's answer alone (review of #3364): never on a refusal.
        expect(row.readThere.mock.calls).toEqual([[EV]]);
        calls.answer.set('getEventChat', { ...CHAT, messages: [...CHAT.messages, line('m3', DANA, 'nine sharp')] });
        calls.refuse.set('markThreadReadOnNode', 'no signal');
        await act(async () => { await poll.again!(); });
        await settle();
        expect(row.readThere.mock.calls).toEqual([[EV]]);
        calls.refuse.clear();
        await act(async () => { await poll.again!(); });
        await settle();
        expect(of('markThreadReadOnNode').length).toBe(3);
        expect(row.readThere.mock.calls).toEqual([[EV], [EV]]);
        inUseUntouched();
        expect(of('leaveChatInPlace')).toEqual([]);
        await act(async () => { root.render(null); });
        expect(of('leaveChatInPlace')).toEqual([[A]]);
    });

    it('an answer, a removal by the host, a mute and a report each name its own community; the line and the report are held until they settle', async () => {
        const { row } = itsRow();
        await open();
        await act(async () => { await bits.composer.onSend(' see you at nine '); });
        await settle();
        expect(of('postEventChatMessage')).toEqual([[EV, 'see you at nine', undefined, A]]);
        expect(row.noteSent.mock.calls).toEqual([[EV]]);
        await act(async () => { await bits.menu.onPickMute('always'); });
        expect(of('muteChatApi')).toEqual([[EV, 'always', A]]);
        expect(row.setMute.mock.calls).toEqual([[EV, { conversationId: 'e', mutedUntil: null, always: true }]]);
        expect(shownItems()).toContain('Unmute');
        await act(async () => { item('Unmute').onPress(); });
        await settle();
        expect(of('muteChatApi')[1]).toEqual([EV, 'off', A]);
        await act(async () => { item('Report event').onPress(); });
        expect([bits.report.isOpen, bits.report.title]).toEqual([true, 'Report event']);
        expect(bits.report.note).toBe('The community’s moderators see this post and your reason.');
        await act(async () => { await bits.report.onSubmit('Spam or scam'); });
        await settle();
        expect(of('reportEvent')).toEqual([[EV, 'Spam or scam', A]]);
        expect(alerts.alert.mock.calls.pop()![0]).toBe('Reported');
        expect(of('whileChatInPlace').map((a) => a[0])).toEqual([A, A]);
        // The host's own chat: Remove, as at home; no report of their own event.
        calls.answer.set('getEventChat', { ...CHAT, isHost: true });
        await act(async () => { await poll.again!(); });
        await settle();
        expect(shownItems()).toEqual(['Mute notifications', 'Open Riverside ›']);
        const hers = bits.rows.filter((r) => r.item.id === 'm1').pop();
        expect(hers.actions).toMatchObject({ remove: true, reply: false, react: false, edit: false, delete: false });
        await act(async () => { await hers.onRemove(); });
        await act(async () => { await alerts.alert.mock.calls.pop()![2][1].onPress(); });
        await settle();
        expect(of('removeEventChatMessage')).toEqual([[EV, 'm1', A]]);
        inUseUntouched();
    });

    it('what is refused is said in words, and nothing is lost quietly: a line, a mute, a report (the box keeps its words)', async () => {
        const switched = 'This phone has switched community since this chat was opened.';
        await open();
        for (const [name, run, title] of [
            ['postEventChatMessage', () => bits.composer.onSend('a line'), 'Not sent'], ['muteChatApi', () => bits.menu.onPickMute('8h'), 'Not changed'],
        ] as const) {
            calls.refuse.set(name, switched);
            alerts.alert.mockClear();
            await act(async () => { await run(); });
            await settle();
            expect(alerts.alert.mock.calls, name).toEqual([[title, switched]]);
        }
        calls.refuse.set('reportEvent', Object.assign(new Error('That post is not here any more.'), { status: 404, nodeAnswered: true }));
        alerts.alert.mockClear();
        let threw = false;
        await act(async () => { await bits.report.onSubmit('Other: words').catch(() => { threw = true; }); });
        await settle();
        expect([threw, alerts.alert.mock.calls]).toEqual([true, [['Not sent', 'That post is not here any more.']]]);
    });

    it('the header opens no page (the community in use\'s, of the same id, least of all) and says it opens none', async () => {
        await open();
        expect(Array.from(host.querySelectorAll('[aria-label]')).filter((b) => b.getAttribute('aria-label')!.includes('Opens the event page'))).toEqual([]);
        expect(host.textContent).not.toContain('tap for info');
        const title = Array.from(host.querySelectorAll('span')).find((x) => x.textContent?.endsWith('Working bee'))!;
        await act(async () => { (title.closest('button') as HTMLElement).click(); });
        expect(nav.push.mock.calls).toEqual([]);
    });

    it('Open Riverside ›: the phone moves there and opens the event\'s page; a tap that moved nothing says so; a second while it moves does nothing', async () => {
        await open();
        await act(async () => { item('Open Riverside ›').onPress(); });
        await settle();
        expect(moved.run.mock.calls[0].slice(0, 3)).toEqual([A, `/post/${EV}`, ME]);
        expect(alerts.alert).not.toHaveBeenCalled();
        for (const answer of ['held', 'failed']) {
            alerts.alert.mockClear();
            moved.run.mockResolvedValueOnce(answer);
            await act(async () => { item('Open Riverside ›').onPress(); });
            await settle();
            expect(alerts.alert.mock.calls, answer).toEqual([['Riverside', 'Something went wrong. Try again in a moment.']]);
        }
        moved.run.mockClear();
        alerts.alert.mockClear();
        let end!: (how: string) => void;
        moved.run.mockImplementationOnce(() => new Promise((r) => { end = r; }));
        await act(async () => { item('Open Riverside ›').onPress(); });
        await act(async () => { item('Open Riverside ›').onPress(); });
        await settle();
        expect([moved.run.mock.calls.length, alerts.alert.mock.calls]).toEqual([1, []]);
        await act(async () => { end('switched'); });
    });
});

describe('contrast: an event\'s chat in the community in use is as it was, with a mute in its menu', () => {
    it('no community named in any call, the header opens the event\'s page, its own row is read, and nothing offers a move', async () => {
        const { at } = itsRow();
        await open(null);
        expect(of('getEventChat')).toEqual([[EV, undefined, undefined, undefined]]);
        expect(of('markConversationRead')).toEqual([[EV, ME, undefined]]);
        expect([of('markThreadReadOnNode'), of('enterChatInPlace'), of('leaveChatInPlace')]).toEqual([[], [], []]);
        expect(inUse.markRead.mock.calls).toEqual([[EV]]);
        await act(async () => { await bits.composer.onSend('here'); });
        await settle();
        expect(of('postEventChatMessage')).toEqual([[EV, 'here', undefined, undefined]]);
        expect(inUse.noteSent.mock.calls).toEqual([[EV]]);
        expect([shownItems(), bits.report, at.mock.calls]).toEqual([['Mute notifications'], null, []]);
        // A mute set in place there is taken off here.
        await act(async () => { await bits.menu.onPickMute('1w'); });
        expect([of('muteChatApi'), inUse.setMute.mock.calls.length]).toEqual([[[EV, '1w', undefined]], 1]);
        expect(host.textContent).not.toContain('Riverside');
        const header = Array.from(host.querySelectorAll('button')).find((b) => b.getAttribute('aria-label')?.includes('Opens the event page'))!;
        await act(async () => { header.click(); });
        expect(nav.push.mock.calls).toEqual([[`/post/${EV}`]]);
        await act(async () => { root.render(null); });
        calls.refuse.set('getEventChat', 'Event not found');
        await open(null);
        expect(host.querySelector('[data-testid="event-open-there"]')).toBeNull();
    });
});
