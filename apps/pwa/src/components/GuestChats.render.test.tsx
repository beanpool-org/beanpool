/**
 * Guests from other communities in a group's chat, on the web (slice G2; the phone's guest-chat-render.test.ts): one table over
 * (viewer: convenor, member, guest, removed guest, blocked) x (screen: chat, sections, roster, report, invite) -> shown /
 * hidden / refused, read from what each screen draws and held to core's guestAccess, which both apps draw from; and each screen
 * at a 320 px window: every control a 44 px target, the community and the names wrapping, never cut.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { applyGuestMail, guestAccess, type GuestAccess, type GuestChat, type GuestScreen, type GuestViewer } from '@beanpool/core';

const ME = 'c'.repeat(64);
const ANA = 'a'.repeat(64);
const DAX = 'd'.repeat(64);

const live = vi.hoisted(() => ({
    chats: {} as Record<string, GuestChat>,
    guests: [] as Array<{ key: string; home: string; name: string; state: string }>,
    on: true,
}));
vi.mock('../lib/guest-chat-live', () => ({
    GUEST_CHATS_EVENT: 'beanpool-guest-chats',
    loadGuestChats: async () => live.chats,
    syncGuestMailNow: async () => true,
    answerInvitation: vi.fn(async () => {}),
    sendGuestLineNow: vi.fn(async () => null),
    fetchGroupGuests: async () => ({ guests: live.guests, on: live.on }),
    inviteGroupGuest: vi.fn(async () => ({})),
    leaveGuestChatNow: vi.fn(async () => true),
    removeGroupGuest: vi.fn(async () => ({})),
}));
vi.mock('../lib/identity', () => ({ loadIdentity: async () => ({ publicKey: ME, callsign: 'Me' }) }));
vi.mock('../lib/outside-mail', () => ({ outsideErrorWords: () => 'That did not go through.' }));

import { GroupGuestsPanel, GuestChatThread, GuestInvitationCard } from './GuestChats';
import { outOfView, recordScrolls, stopRecordingScrolls } from '../chat-end-in-view.test-support';

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

beforeEach(() => {
    window.innerWidth = 320;
    window.dispatchEvent(new Event('resize'));
});
afterEach(() => {
    cleanup();
    live.chats = {};
    live.guests = [];
    live.on = true;
});

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function openChat(c: GuestChat | null) {
    cleanup();
    live.chats = c ? { [c.id]: c } : {};
    render(<GuestChatThread chatId={ID} onBack={() => {}} />);
    await waitFor(() => expect(q('guest-chat')?.childElementCount ?? 0).toBeGreaterThan(0));
}
async function openGuests(isConvenor: boolean) {
    cleanup();
    live.guests = [{ key: DAX, home: 'eastside.example', name: 'Dax', state: 'in' }, ...(isConvenor ? [{ key: ME, home: 'hillside.example', name: 'Me', state: 'invited' }] : [])];
    render(<GroupGuestsPanel groupId="grp-tools" isConvenor={isConvenor} />);
    await waitFor(() => expect(q('group-guests')).not.toBeNull());
}

async function seen(viewer: GuestViewer): Promise<Record<GuestScreen, GuestAccess>> {
    if (viewer === 'convenor' || viewer === 'member') {
        await openGuests(viewer === 'convenor');
        return {
            // A member's own group chat and its sections are their own screens (unchanged here); the guests are under the members.
            chat: 'shown', sections: 'shown', report: 'shown',
            roster: document.querySelectorAll('[data-testid="group-guest-row"]').length > 0 ? 'shown' : 'hidden',
            invite: q('group-guest-add') ? 'shown' : 'hidden',
        };
    }
    if (viewer === 'blocked') {
        // An invitation from someone this account blocked is dropped at the gate (core gateGuestNotice): no chat is kept.
        await openChat(null);
        return {
            chat: document.body.textContent?.includes('This chat is not in this browser.') ? 'refused' : 'shown',
            sections: 'hidden', roster: q('guest-chat-names') ? 'shown' : 'hidden', report: 'hidden',
            invite: q('guest-invitation') ? 'shown' : 'refused',
        };
    }
    await openChat(chat(viewer === 'guest' ? 'in' : 'removed'));
    const composer = !!q('guest-chat-input');
    const closed = !!q('guest-chat-closed');
    return {
        chat: composer && !closed ? 'shown' : closed && !composer ? 'refused' : 'hidden',
        sections: document.querySelector('[data-testid*="section"], [data-testid*="post"], [data-testid*="poll"]') ? 'shown' : 'hidden',
        roster: q('guest-chat-names') ? 'shown' : 'hidden',
        report: document.querySelector('[data-testid*="report"]') ? 'shown' : 'hidden',
        invite: q('group-guest-add') ? 'shown' : 'hidden',
    };
}

describe('who sees what on the web (viewer x screen), as core says', () => {
    for (const viewer of ['convenor', 'member', 'guest', 'removed', 'blocked'] as GuestViewer[]) {
        it(viewer, async () => {
            const drawn = await seen(viewer);
            const want = Object.fromEntries((['chat', 'sections', 'roster', 'report', 'invite'] as GuestScreen[]).map((s) => [s, guestAccess(viewer, s)]));
            expect(drawn).toEqual(want);
        });
    }
});

describe("the guest's chat in a 320 px window", () => {
    it('lines name their writers (a member by name, a guest by the guest line), mine carries its tick; 44 px targets; nothing cut', async () => {
        await openChat(chat('in'));
        await waitFor(() => expect(q('guest-line-state')?.textContent).toBe('Sent'));
        expect(Array.from(document.querySelectorAll('[data-testid="guest-line-author"]')).map((e) => e.textContent)).toEqual(['Ana', 'Dax · eastside.example · guest']);
        expect(q('guest-chat-names')?.textContent).toBe('Ana, Me · hillside.example · guest, Dax · eastside.example · guest');
        expect(document.body.textContent).toContain('Kept in this browser only. Your community keeps no copy.');
        for (const id of ['guest-chat-input', 'guest-chat-send']) expect(q(id)!.style.minHeight).toBe('44px');
        // The box shrinks with the window; the community and the names wrap anywhere rather than run off a 320 px screen. The
        // names show on one line until tapped (emulator walk 17 Nov, below).
        expect(q('guest-chat-input')!.style.minWidth).toBe('0px');
        for (const id of ['guest-chat-from', 'guest-chat-names']) expect(q(id)!.style.overflowWrap).toBe('anywhere');
    });

    it('an invitation names who invited, the group and its community, with Accept and Decline, and nothing of the chat', async () => {
        await openChat(chat('invited', { lines: [] }));
        expect(q('guest-invitation')?.textContent).toContain('Ana invites you to the chat of the group Tool Library, in riverside.example.');
        for (const id of ['guest-invitation-accept', 'guest-invitation-decline']) expect(q(id)!.style.minHeight).toBe('44px');
        expect(q('guest-chat-input')).toBeNull();
        expect(document.querySelector('[role="log"]')).toBeNull();
        expect(q('guest-chat-names')).toBeNull();
    });

    it('the card behind Message requests: the group and its community, who invited, the way in', () => {
        const open = vi.fn();
        render(<ul><GuestInvitationCard chat={chat('invited')} onOpen={open} /></ul>);
        expect(q('guest-invitation-card')?.textContent).toContain('Tool Library · riverside.example');
        fireEvent.click(screen.getByTestId('guest-invitation-open'));
        expect(open).toHaveBeenCalled();
        expect(q('guest-invitation-open')!.style.minHeight).toBe('44px');
    });

    // Emulator walk 17 Nov (the phone's twin is guest-chat-render.test.ts): the names line, a writer who left, why it closed.
    it('the names line: one line until tapped, then every name, wrapping; tapped again, one line; its words are the whole list; a 44 px target', async () => {
        await openChat(chat('in'));
        await waitFor(() => expect(q('guest-chat-names')).not.toBeNull());
        const names = q('guest-chat-names') as HTMLButtonElement;
        const NAMES = 'Ana, Me · hillside.example · guest, Dax · eastside.example · guest';
        expect(names.tagName).toBe('BUTTON');
        expect(names.textContent).toBe(NAMES);
        expect([names.style.whiteSpace, names.style.overflow, names.style.textOverflow, names.getAttribute('aria-expanded')]).toEqual(['nowrap', 'hidden', 'ellipsis', 'false']);
        expect(names.style.minHeight).toBe('44px');
        fireEvent.click(names);
        expect([names.style.whiteSpace, names.style.overflow, names.getAttribute('aria-expanded')]).toEqual(['', '', 'true']);
        fireEvent.click(names);
        expect(names.style.whiteSpace).toBe('nowrap');
    });

    it.each([
        ['a fellow guest removed, named by the roster\'s former', { former: { members: [], guests: [{ key: 'e'.repeat(64), home: 'eastside.example', name: 'Cy', state: 'removed' }] } }, {}, 'Cy · eastside.example · guest'],
        ['a member who left, named by the roster\'s former', { former: { members: [{ key: 'e'.repeat(64), name: 'Cy' }], guests: [] } }, {}, 'Cy'],
        ['a guest a roster named before, kept in this browser', {}, { names: { ['e'.repeat(64)]: { name: 'Cy', home: 'eastside.example', state: 'out', at: 1 } } }, 'Cy · eastside.example · guest'],
        ['a key nobody named', {}, {}, 'eeeeeeee'],
    ] as Array<[string, Record<string, unknown>, Partial<GuestChat>, string]>)('%s: the line reads "%s"', async (_what, roster, extra, name) => {
        const c = chat('in', extra);
        c.roster = { ...c.roster!, ...roster };
        c.lines = [{ id: 'l9', author: 'e'.repeat(64), text: 'I can bring a wheelbarrow.', at: 1 }];
        await openChat(c);
        await waitFor(() => expect(q('guest-line-author')?.textContent).toBe(name));
    });

    it.each([['left', 'You left this chat.'], ['removed', 'You were removed from this chat. Nothing more reaches you from it.']] as Array<[GuestChat['state'], string]>)(
        'closed (%s): why is under the newest line, where the box was', async (state, words) => {
            await openChat(chat(state, { why: state === 'removed' ? 'removed' : null }));
            await waitFor(() => expect(q('guest-chat-closed')?.textContent).toBe(words));
            const log = document.querySelector('[role="log"]')!;
            expect(log.compareDocumentPosition(q('guest-chat-closed')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
            expect(q('guest-chat-banner')?.contains(q('guest-chat-closed'))).toBe(false);
            expect(q('guest-chat-input')).toBeNull();
        });

    // Deciding review of #3285: the web page never scrolled, so in a long chat why it closed sat under every line, out of view.
    // Each state -> what must be in view when the chat opens (or changes while open), as the phone's inverted list shows it.
    describe('opens at its newest line, with what comes after it in view (30 lines)', () => {
        const many = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, author: i % 2 ? ANA : DAX, text: `Line ${i + 1}`, at: i + 1 }));
        const newest = () => document.querySelector('[role="log"]')?.lastElementChild ?? null;
        beforeEach(() => recordScrolls());
        afterEach(() => stopRecordingScrolls());
        const ROWS: Array<[string, GuestChat['state'], GuestChat['why'], Array<[string, () => Element | null]>]> = [
            ['in: the newest line and the box', 'in', null, [['the newest line', newest], ['the box', () => q('guest-chat-input')]]],
            ['removed by a convenor: why', 'removed', 'removed', [['the newest line', newest], ['why it closed', () => q('guest-chat-closed')]]],
            ['the group closed: why', 'removed', 'group-closed', [['why it closed', () => q('guest-chat-closed')]]],
            ['guests turned off: why', 'removed', 'guests-off', [['why it closed', () => q('guest-chat-closed')]]],
            ['removed, no reason heard: why', 'removed', null, [['why it closed', () => q('guest-chat-closed')]]],
            ['left: why', 'left', null, [['why it closed', () => q('guest-chat-closed')]]],
        ];
        it.each(ROWS)('%s', async (_what, state, why, must) => {
            await openChat(chat(state, { why, lines: many }));
            await waitFor(() => expect(newest()?.textContent).toContain('Line 30'));
            await waitFor(() => expect(must.map(([name, el]) => outOfView(el(), name)).filter(Boolean)).toEqual([]));
        });
        it('declined, no lines: why', async () => {
            await openChat(chat('declined', { lines: [] }));
            await waitFor(() => expect(outOfView(q('guest-chat-closed'), 'why it closed')).toBeNull());
        });
        it('removed while it is open: why comes into view, though no line came', async () => {
            await openChat(chat('in', { lines: many }));
            await waitFor(() => expect(outOfView(q('guest-chat-input'), 'the box')).toBeNull());
            live.chats = { [ID]: chat('removed', { why: 'removed', lines: many }) };
            window.dispatchEvent(new Event('beanpool-guest-chats'));
            await waitFor(() => expect(q('guest-chat-closed')).not.toBeNull());
            await waitFor(() => expect(outOfView(q('guest-chat-closed'), 'why it closed')).toBeNull());
        });
    });

    it('joining says so with no box yet; a closed group and a decline each say why', async () => {
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
    it("guests named by the guest line; a convenor's Add opens the card box, 44 px targets", async () => {
        await openGuests(true);
        expect(Array.from(document.querySelectorAll('[data-testid="group-guest-row"]')).map((r) => r.textContent)).toEqual([
            // Part 2: a convenor's Remove on each row.
            'Dax · eastside.example · guestIn the chatRemove', 'Me · hillside.example · guestAsked, not answered yetRemove',
        ]);
        expect(q('group-guest-add')!.style.minHeight).toBe('44px');
        fireEvent.click(screen.getByTestId('group-guest-add'));
        expect(q('group-guest-add-form')).not.toBeNull();
        expect(q('group-guest-read')!.style.minHeight).toBe('44px');
        // A pasted text that is no card says so, and asks nobody.
        fireEvent.change(screen.getByTestId('group-guest-card'), { target: { value: 'not a card' } });
        fireEvent.click(screen.getByTestId('group-guest-read'));
        await waitFor(() => expect(q('group-guest-note')?.textContent).toBe("That isn't an address card, or it was changed after it was made."));
    });

    it('where guests are off and none are in, nothing is drawn', async () => {
        live.on = false;
        render(<GroupGuestsPanel groupId="grp-tools" isConvenor />);
        await new Promise((r) => setTimeout(r, 20));
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
        expect((document.body.textContent ?? '')).not.toContain('Hello from Eastside');
        expect((document.body.textContent ?? '')).toContain('Welcome to the tools chat');
    });
});

describe("part 2: the guest's Leave and a convenor's Remove, each asked first", () => {
    const calls = async () => vi.mocked((await import('../lib/guest-chat-live')));
    afterEach(async () => { vi.mocked((await calls()).leaveGuestChatNow).mockClear(); vi.mocked((await calls()).removeGroupGuest).mockClear(); vi.restoreAllMocks(); });

    // The chat's state -> whether Leave is drawn: while joining or in; once out (or still an invitation) there is nothing to leave.
    it.each([['in', true], ['joining', true], ['invited', false], ['left', false], ['removed', false], ['declined', false]] as Array<[GuestChat['state'], boolean]>)(
        'Leave when %s: %s', async (state, drawn) => {
            await openChat(chat(state));
            expect(!!q('guest-chat-leave')).toBe(drawn);
        });

    it('Leave asks first: Cancel leaves nothing; Leave leaves this chat (a 44 px target, nothing cut at 320 px)', async () => {
        const live = await calls();
        await openChat(chat('in'));
        expect(q('guest-chat-leave')!.style.minHeight).toBe('44px');
        expect(q('guest-chat-leave')!.textContent).toBe('Leave this chat');
        fireEvent.click(screen.getByTestId('guest-chat-leave'));
        expect(screen.getByRole('dialog').textContent).toContain('Leave this chat?');
        expect(screen.getByRole('dialog').textContent).toContain('Nothing more reaches you from it. The messages already here stay on this device.');
        fireEvent.click(screen.getByText('Cancel'));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(live.leaveGuestChatNow).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('guest-chat-leave'));
        fireEvent.click(screen.getByText('Leave'));
        await waitFor(() => expect(live.leaveGuestChatNow).toHaveBeenCalledWith(ID));
    });

    it("Remove: a convenor's only, on each guest asked or in; a member sees none", async () => {
        await openGuests(false);
        expect(document.querySelectorAll('[data-testid="group-guest-remove"]')).toHaveLength(0);
        await openGuests(true);
        const buttons = Array.from(document.querySelectorAll('[data-testid="group-guest-remove"]')) as HTMLElement[];
        expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
            'Remove Dax · eastside.example · guest from this chat', 'Remove Me · hillside.example · guest from this chat',
        ]);
        for (const b of buttons) expect(b.style.minHeight).toBe('44px');
    });

    it('Remove asks first, under the row (inside the group page): one in -> what they lose; one asked -> their invitation withdrawn; Cancel -> nothing; Remove -> removed, their community told', async () => {
        const live = await calls();
        await openGuests(true);
        fireEvent.click(document.querySelectorAll('[data-testid="group-guest-remove"]')[0]);
        expect(q('group-guest-remove-ask')?.textContent).toContain('Remove Dax · eastside.example · guest?');
        expect(q('group-guest-remove-ask')?.textContent).toContain('Nothing more of this chat reaches them. What they already have stays with them.');
        for (const id of ['group-guest-remove-cancel', 'group-guest-remove-yes']) expect(q(id)!.style.minHeight).toBe('44px');
        fireEvent.click(screen.getByTestId('group-guest-remove-cancel'));
        expect(q('group-guest-remove-ask')).toBeNull();
        expect(live.removeGroupGuest).not.toHaveBeenCalled();
        fireEvent.click(document.querySelectorAll('[data-testid="group-guest-remove"]')[1]);
        expect(q('group-guest-remove-ask')?.textContent).toContain('Remove Me · hillside.example · guest?');
        expect(q('group-guest-remove-ask')?.textContent).toContain('Their invitation is withdrawn.');
        fireEvent.click(screen.getByTestId('group-guest-remove-yes'));
        await waitFor(() => expect(live.removeGroupGuest).toHaveBeenCalledWith('grp-tools', ME));
        expect(live.removeGroupGuest).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(q('group-guest-note')?.textContent).toBe('Removed. Their community is told.'));
    });
});
