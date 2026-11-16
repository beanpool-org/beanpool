// @vitest-environment jsdom
/**
 * Guests from other communities in a group's chat, on the phone (slice G2), rendered for real at 320 dp with text at 1.3x:
 * one table over (viewer: convenor, member, guest, removed guest, blocked) x (screen: chat, sections, roster, report, invite)
 * -> shown / hidden / refused, read from what each screen draws, and held to core's guestAccess, which both apps draw from.
 *   - the guest's chat (app/guest-chat/[id].tsx): a guest reads, writes and sees the names in the chat, and nothing else; a
 *     removed guest's chat says why and has no box; an invitation from someone blocked never becomes a chat here;
 *   - the group's guests (components/GroupGuestsList.tsx): every member sees the guests in the chat; only a convenor gets
 *     Add someone from another community.
 * React Native's host components are plain tags in react-dom, as the other render tests here do.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { applyGuestMail, guestAccess, type GuestAccess, type GuestChat, type GuestScreen, type GuestViewer } from '@beanpool/core';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ME = 'c'.repeat(64);
const ANA = 'a'.repeat(64);
const DAX = 'd'.repeat(64);

vi.mock('react-native', async () => {
    const { createElement: h } = await import('react');
    const flat = (style: unknown): Record<string, unknown> => (Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : (style as Record<string, unknown>) ?? {});
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, disabled, testID, style, numberOfLines, value, onChangeText } = props;
        const attrs: Record<string, unknown> = { 'data-box': JSON.stringify(flat(style)) };
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (disabled) attrs['data-disabled'] = 'true';
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (tag === 'textarea') { attrs.value = value ?? ''; attrs.onChange = (e: any) => onChangeText?.(e.target.value); return h(tag, attrs); }
        return h(tag, attrs, children);
    };
    const FlatList = (props: any) => h('div', { 'data-testid': 'list' },
        props.ListHeaderComponent, ...(props.data ?? []).map((item: any, index: number) => h('div', { key: props.keyExtractor(item) }, props.renderItem({ item, index }))));
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), TextInput: el('textarea'), FlatList,
        StyleSheet: { create: (s: any) => s, hairlineWidth: 1 },
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
        DeviceEventEmitter: { addListener: () => ({ remove: () => {} }), emit: () => {} },
        Alert: { alert: vi.fn() },
    };
});
vi.mock('react-native-keyboard-controller', async () => {
    const { createElement: h } = await import('react');
    return { KeyboardAvoidingView: (p: any) => h('div', {}, p.children) };
});
vi.mock('react-native-safe-area-context', async () => {
    const { createElement: h } = await import('react');
    return { SafeAreaView: (p: any) => h('div', { 'data-testid': p.testID }, p.children) };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
const route = vi.hoisted(() => ({ id: '' }));
vi.mock('expo-router', () => ({ router: { back: vi.fn(), push: vi.fn() }, useLocalSearchParams: () => ({ id: route.id }), useFocusEffect: () => {} }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { theme: 'light', colors: lightColors };
    return { useTheme: () => ctx, useStyles: (make: (c: typeof ctx) => unknown) => make(ctx) };
});
vi.mock('../../components/MemberAvatar', async () => {
    const { createElement: h } = await import('react');
    return { MemberAvatar: () => h('span', { 'data-avatar': 'true' }) };
});
vi.mock('../keyboard-alert', () => ({ Alert: { alert: vi.fn() } }));
vi.mock('../identity', () => ({ loadIdentity: async () => ({ publicKey: ME, callsign: 'Me' }) }));
vi.mock('../outside-chat-live', () => ({ outsideErrorWords: () => 'That did not go through.' }));
const live = vi.hoisted(() => ({
    chats: {} as Record<string, GuestChat>,
    guests: [] as Array<{ key: string; home: string; name: string; state: string }>,
    on: true,
}));
vi.mock('../guest-chat-live', () => ({
    GUEST_CHATS_UPDATED: 'guest_chats_updated',
    loadGuestChats: async () => live.chats,
    syncGuestMailNow: async () => true,
    answerInvitation: vi.fn(async () => {}),
    sendGuestLineNow: vi.fn(async () => null),
    fetchGroupGuests: async () => ({ guests: live.guests, on: live.on }),
    inviteGroupGuest: vi.fn(async () => ({})),
}));

import GuestChatScreen from '../../app/guest-chat/[id]';
import { GroupGuestsList } from '../../components/GroupGuestsList';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    live.chats = {};
    live.guests = [];
    live.on = true;
});

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const box = (el: Element | null) => JSON.parse(el?.getAttribute('data-box') ?? '{}');

const ID = 'grp-tools@riverside.example';
function chat(state: GuestChat['state'], extra: Partial<GuestChat> = {}): GuestChat {
    return {
        id: ID, host: 'riverside.example', group: 'grp-tools', name: 'Tool Library', invitedBy: { key: ANA, name: 'Ana' }, state,
        roster: { name: 'Tool Library', members: [{ key: ANA, name: 'Ana' }], guests: [{ key: ME, home: 'hillside.example', name: 'Me' }, { key: DAX, home: 'eastside.example', name: 'Dax' }], epoch: null },
        keys: {}, epochSent: null, why: null, updatedAt: 1, held: [],
        lines: [
            { id: 'l1', author: ANA, text: 'Welcome to the tools chat', at: 1 },
            { id: 'l2', author: DAX, text: 'Hello from Eastside', at: 2 },
            { id: 'l3', author: ME, text: 'Glad to be here', at: 3, state: 'sent' },
        ],
        ...extra,
    };
}

async function openChat(c: GuestChat | null) {
    live.chats = c ? { [c.id]: c } : {};
    route.id = ID;
    // A fresh screen each time, as opening the chat again is.
    act(() => root.render(createElement('div') as unknown as Parameters<Root['render']>[0]));
    act(() => root.render(createElement(GuestChatScreen) as unknown as Parameters<Root['render']>[0]));
    await settle();
}
async function openGuests(isConvenor: boolean) {
    live.guests = [{ key: DAX, home: 'eastside.example', name: 'Dax', state: 'in' }, ...(isConvenor ? [{ key: ME, home: 'hillside.example', name: 'Me', state: 'invited' }] : [])];
    act(() => root.render(createElement(GroupGuestsList, { groupId: 'grp-tools', isConvenor }) as unknown as Parameters<Root['render']>[0]));
    await settle();
}

/** What a viewer's screens draw, read back into the table's words. */
async function seen(viewer: GuestViewer): Promise<Record<GuestScreen, GuestAccess>> {
    if (viewer === 'convenor' || viewer === 'member') {
        await openGuests(viewer === 'convenor');
        const rows = host.querySelectorAll('[data-testid="group-guest-row"]').length;
        return {
            // A member's own group chat and its sections are their own screens (unchanged here); the guests list is under the members.
            chat: 'shown', sections: 'shown', report: 'shown',
            roster: rows > 0 ? 'shown' : 'hidden',
            invite: q('group-guest-add') ? 'shown' : 'hidden',
        };
    }
    if (viewer === 'blocked') {
        // An invitation from someone this account blocked is dropped at the gate (core gateGuestNotice): no chat is kept.
        await openChat(null);
        const refusedHere = host.textContent?.includes('This chat is not on this phone.');
        return {
            chat: refusedHere ? 'refused' : 'shown', sections: 'hidden', roster: q('guest-chat-names') ? 'shown' : 'hidden', report: 'hidden',
            invite: q('guest-invitation') ? 'shown' : 'refused',
        };
    }
    await openChat(chat(viewer === 'guest' ? 'in' : 'removed'));
    const composer = !!q('guest-chat-input');
    const closed = !!q('guest-chat-closed');
    return {
        chat: composer && !closed ? 'shown' : closed && !composer ? 'refused' : 'hidden',
        sections: host.querySelector('[data-testid*="section"], [data-testid*="post"], [data-testid*="poll"]') ? 'shown' : 'hidden',
        roster: q('guest-chat-names') ? 'shown' : 'hidden',
        report: host.querySelector('[data-testid*="report"]') ? 'shown' : 'hidden',
        invite: q('group-guest-add') ? 'shown' : 'hidden',
    };
}

describe('who sees what on the phone (viewer x screen), as core says', () => {
    for (const viewer of ['convenor', 'member', 'guest', 'removed', 'blocked'] as GuestViewer[]) {
        it(viewer, async () => {
            const drawn = await seen(viewer);
            const want = Object.fromEntries((['chat', 'sections', 'roster', 'report', 'invite'] as GuestScreen[]).map((s) => [s, guestAccess(viewer, s)]));
            expect(drawn).toEqual(want);
        });
    }
});

describe("the guest's chat at 320 dp with text at 1.3x", () => {
    it('lines name their writers (a member by name, a guest by the guest line), mine carries its tick; the box is a 44 dp target', async () => {
        await openChat(chat('in'));
        const authors = Array.from(host.querySelectorAll('[data-testid="guest-line-author"]')).map((e) => e.textContent);
        expect(authors).toEqual(['Ana', 'Dax · eastside.example · guest']);
        expect(q('guest-line-state')?.textContent).toBe('Sent');
        expect(q('guest-chat-names')?.textContent).toBe('Ana, Me · hillside.example · guest, Dax · eastside.example · guest');
        expect(host.textContent).toContain("You're a guest in this group's chat.");
        expect(host.textContent).toContain('Kept on this phone only. Your community keeps no copy.');
        expect(box(q('guest-chat-input')).minHeight).toBeGreaterThanOrEqual(44);
        expect(box(q('guest-chat-send')).height).toBeGreaterThanOrEqual(44);
        // The community and the names are never cut: no line limit for a platform to cut at; they wrap.
        expect(q('guest-chat-from')?.getAttribute('data-lines')).toBeNull();
        expect(q('guest-chat-names')?.getAttribute('data-lines')).toBeNull();
    });

    it('an invitation names who invited, the group and its community, with Accept and Decline (44 dp), and nothing of the chat', async () => {
        await openChat(chat('invited', { lines: [] }));
        expect(q('guest-invitation')?.textContent).toContain('Ana invites you to the chat of the group Tool Library, in riverside.example.');
        for (const id of ['guest-invitation-accept', 'guest-invitation-decline']) expect(box(q(id)).minHeight).toBeGreaterThanOrEqual(44);
        expect(q('guest-chat-input')).toBeNull();
        expect(q('list')).toBeNull();
        expect(q('guest-chat-names')).toBeNull();
    });

    it('joining says so, with no box yet; a closed group, a decline each say why', async () => {
        await openChat(chat('joining'));
        expect(q('guest-chat-joining')).not.toBeNull();
        expect(q('guest-chat-input')).toBeNull();
        await openChat(chat('removed', { why: 'group-closed' }));
        expect(q('guest-chat-closed')?.textContent).toBe('This group was closed. Nothing more reaches you from it.');
        await openChat(chat('declined'));
        expect(q('guest-chat-closed')?.textContent).toBe('You declined this invitation.');
    });
});

describe("the group's guests, under its members", () => {
    it("guests named by the guest line; a convenor's Add opens the card box with 48 dp targets", async () => {
        await openGuests(true);
        expect(Array.from(host.querySelectorAll('[data-testid="group-guest-row"]')).map((r) => r.textContent)).toEqual([
            'Dax · eastside.example · guestIn the chat', 'Me · hillside.example · guestAsked, not answered yet',
        ]);
        expect(box(q('group-guest-add')).minHeight).toBeGreaterThanOrEqual(48);
        act(() => (q('group-guest-add') as HTMLButtonElement).click());
        expect(q('group-guest-add-form')).not.toBeNull();
        for (const id of ['group-guest-read', 'group-guest-scan']) expect(box(q(id)).minHeight).toBeGreaterThanOrEqual(48);
    });

    it('where guests are off and none are in, nothing is drawn', async () => {
        live.on = false;
        act(() => root.render(createElement(GroupGuestsList, { groupId: 'grp-tools', isConvenor: true }) as unknown as Parameters<Root['render']>[0]));
        await settle();
        expect(q('group-guests')).toBeNull();
    });
});

describe("round 4 (#3246): each reason the host's code gives for a removal -> its own words; a line taken down is gone", () => {
    // Read from the host's code: a reason it adds has no row in WORDS, and fails here.
    const hostCode = readFileSync(resolve(__dirname, '../../../server/src/engine/group-guests.ts'), 'utf8');
    const whys = [...new Set([...hostCode.matchAll(/queueToHome\([^;]*?'removed',\s*\{\s*why:\s*'([^']+)'/g)].map((m) => m[1]))];
    const WORDS: Record<string, string> = {
        removed: 'You were removed from this chat. Nothing more reaches you from it.',
        'group-closed': 'This group was closed. Nothing more reaches you from it.',
        closed: "This group's community turned off guests from other communities. Nothing more reaches you from it.",
    };
    const ctx = { me: ME, myEdPrivHex: '11'.repeat(32), blocked: () => false, now: 5 };
    const page = (kind: string, data: unknown) => ({ items: [{ id: `n-${kind}`, host: 'riverside.example', group: 'grp-tools', kind, data, receivedAt: 5 }] });
    it("the host's code is read where the test looks", () => expect(whys.length).toBeGreaterThanOrEqual(3));
    it.each(whys)('the host says why %s: the closed chat says its own words', async (w) => {
        const { chats, confirm } = applyGuestMail({ [ID]: chat('in') }, page('removed', { why: w }), ctx);
        expect(confirm).toEqual(['n-removed']);
        await openChat(chats[ID]);
        expect(q('guest-chat-closed')?.textContent).toBe(WORDS[w]);
    });
    it('removed with no reason heard here: it says only that the chat is closed', async () => {
        await openChat(chat('removed', { why: null }));
        expect(q('guest-chat-closed')?.textContent).toBe('This chat is closed. Nothing more reaches you from it.');
    });
    it("a line taken down by a convenor: gone from the chat, the others stay, and the notice is confirmed", async () => {
        const { chats, confirm } = applyGuestMail({ [ID]: chat('in') }, page('edit', { id: 'l2', action: 'removed', by: 'convenor' }), ctx);
        expect(confirm).toEqual(['n-edit']);
        await openChat(chats[ID]);
        expect((host.textContent ?? '')).not.toContain('Hello from Eastside');
        expect((host.textContent ?? '')).toContain('Welcome to the tools chat');
    });
});
