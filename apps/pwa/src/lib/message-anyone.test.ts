/**
 * Message anyone on the web (slice S5 part 2, lib/message-anyone.ts): the path table core's rule gives a browser that holds
 * one community (an across chat already here wins; this community; else across from the contact's link), what makes or
 * refuses the chat across, and one block rule asked first on every path (#3354 review). Each row is red without its rule:
 * core's own table (message-path.test.ts) names the mutants; here a row also goes red with the across chats left out of the
 * rule, or the refusals not checked. The chats weighed and the chat made are the real lib/outside-mail.ts chatsShown and
 * openChatFromCard over a store in memory.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeHomeOf, relayConversationId } from '@beanpool/core';

const ME = 'e5'.repeat(32);
const web = vi.hoisted(() => ({
    here: 'https://riverside.example',
    across: [] as Array<{ id: string; peerKey: string }>,
    noContext: false,
    outsideOn: true as boolean | null,
    // This community's list for the account (lib/blocklist.ts), whether it was read, whether a read fails, and the keys
    // unblocked in this page.
    blocked: [] as string[],
    loaded: true,
    readFails: false,
    unblocked: [] as string[],
    opened: [] as Array<{ chatId: string; peer: { key: string; home: string; name: string | null } }>,
}));
vi.mock('./api', () => ({ nodeAddress: () => web.here }));
vi.mock('./blocklist', () => ({
    getBlocklistStatus: () => ({ loaded: web.loaded, error: null }),
    loadBlocklist: async () => {
        if (web.readFails) throw new Error('Couldn’t load your blocked members from your community.');
        web.loaded = true;
        return web.blocked;
    },
    isUserBlocked: (k: string) => web.blocked.includes(k),
    unblockedInThisPage: (k: string) => web.unblocked.includes(k),
}));
vi.mock('./outside-mail', async (importOriginal) => {
    const real = await importOriginal<typeof import('./outside-mail')>();
    return {
        // The real list and the real chat from a card (#3354 review: Message reads only what the chat list shows).
        chatsShown: real.chatsShown,
        openChatFromCard: real.openChatFromCard,
        outsideContext: async () => (web.noContext ? null : {
            identity: { publicKey: ME },
            isBlocked: async (k: string) => web.blocked.includes(k),
            store: {
                chats: async () => web.across,
                openChat: async (_me: string, chatId: string, peer: { key: string; home: string; name: string | null }) => { web.opened.push({ chatId, peer }); },
            },
        }),
        outsideMessagesHere: async () => web.outsideOn,
    };
});

import { messageOnWeb, messagePathOnWeb, openAcrossOnWeb } from './message-anyone';

const K = 'a1'.repeat(32);
const FAR = 'https://faraway.example';
const HELD_ON_PHONE = 'https://hillside.example';
const BLOCKED_WORDS = 'You have blocked this user. Messaging is disabled.';

beforeEach(() => {
    web.across = []; web.noContext = false; web.outsideOn = true; web.opened = [];
    web.blocked = []; web.loaded = true; web.readFails = false; web.unblocked = [];
});

describe('which chat Message opens on the web', () => {
    it.each([
        { name: 'an across chat already here wins', links: [{ community: FAR, key: K, name: 'Dee' }], across: [{ id: 'x-1', peerKey: K }],
            want: { open: 'existing', chat: { kind: 'across', community: null, id: 'x-1', key: K } } },
        { name: 'an across chat with someone else is not theirs', links: [{ community: FAR, key: K, name: 'Dee' }], across: [{ id: 'x-2', peerKey: 'b2'.repeat(32) }],
            want: { open: 'across', key: K, home: nodeHomeOf(FAR), name: 'Dee' } },
        { name: 'this community, however spelled', links: [{ community: 'https://riverside.example/', key: K }], across: [],
            want: { open: 'shared', community: 'https://riverside.example', key: K } },
        { name: 'another community (one the phone may hold): across', links: [{ community: HELD_ON_PHONE, key: K, name: 'Dee' }], across: [],
            want: { open: 'across', key: K, home: nodeHomeOf(HELD_ON_PHONE), name: 'Dee' } },
        { name: 'no account here: no across chats read, across from the link', links: [{ community: FAR, key: K }], across: [{ id: 'x-1', peerKey: K }], noContext: true,
            want: { open: 'across', key: K, home: nodeHomeOf(FAR), name: null } },
    ])('$name', async ({ links, across, noContext, want }) => {
        web.across = across;
        web.noContext = !!noContext;
        expect(await messagePathOnWeb(links)).toEqual(want);
    });
});

describe('the chat across, made or refused', () => {
    const target = { key: K, home: 'faraway.example', name: 'Dee' };
    it('made from the link: key, home and name only', async () => {
        expect(await openAcrossOnWeb({ ...target, open: 'across' } as typeof target)).toEqual({ chatId: relayConversationId(ME, K) });
        expect(web.opened).toEqual([{ chatId: relayConversationId(ME, K), peer: target }]);
    });
    it.each([
        { name: 'no account here', set: () => { web.noContext = true; }, want: 'no-community' },
        { name: 'this community takes no messages from other communities', set: () => { web.outsideOn = false; }, want: 'off' },
        { name: 'its info not read yet (the strict side)', set: () => { web.outsideOn = null; }, want: 'off' },
        { name: 'someone the account blocked', set: () => { web.blocked = [K]; }, want: 'blocked' },
    ])('refused: $name', async ({ set, want }) => {
        set();
        expect(await openAcrossOnWeb(target)).toEqual({ refused: want });
        expect(web.opened).toEqual([]);
    });
});

/**
 * One block rule on every path Message takes on the web (#3354 review: Message on a blocked contact in another community
 * opened their hidden chat across, composer and all): (path) x (blocked here / unblocked since / none). The web holds one
 * community, so "blocked in another held community" has no web column: a block made there is on that community's list,
 * which this page never reads (the phone's table has it). Blocked is refused on every path in the same words, and nothing
 * opens or is made; unblocked since and none open what the path opens. Mutations (PR body): no block asked -> the blocked
 * rows open; the raw store, not chatsShown, with the block left out too -> the hidden chat reopens; the page's unblock
 * asked (unblockedInThisPage) -> the "unblocked since" rows are refused.
 */
describe('one block rule on every path (MessagesPage messageAcross: lib/message-anyone.ts messageOnWeb)', () => {
    const BLOCKS = [
        { name: 'blocked here', set: () => { web.blocked = [K]; }, refused: true },
        { name: 'unblocked since', set: () => { web.unblocked = [K]; }, refused: false },
        { name: 'none', set: () => {}, refused: false },
    ];
    const PATHS = [
        { name: 'existing chat across', link: { key: K, community: FAR }, set: () => { web.across = [{ id: 'x-1', peerKey: K }]; }, want: { across: 'x-1' }, made: false },
        { name: 'a new chat across', link: { key: K, community: FAR }, set: () => {}, want: { across: relayConversationId(ME, K) }, made: true },
        { name: 'this community (a chat here)', link: { key: K, community: 'https://riverside.example' }, set: () => {}, want: { dm: K }, made: false },
    ];
    const ROWS = PATHS.flatMap((path) => BLOCKS.map((block) => ({ ...path, block, row: `${path.name} x ${block.name}` })));
    it.each(ROWS)('$row', async ({ link, set, want, made, block }) => {
        set();
        block.set();
        const done = await messageOnWeb(link, 'Dee');
        if (block.refused) {
            expect(done).toEqual({ refused: BLOCKED_WORDS });
            expect(web.opened).toEqual([]);
        } else {
            expect(done).toEqual(want);
            expect(web.opened.map((o) => o.peer.key)).toEqual(made ? [K] : []);
        }
    });

    it('a list not read yet is read first: a block on it refuses', async () => {
        web.loaded = false;
        web.blocked = [K];
        web.across = [{ id: 'x-1', peerKey: K }];
        expect(await messageOnWeb({ key: K, community: FAR }, 'Dee')).toEqual({ refused: BLOCKED_WORDS });
    });

    it('a list that cannot be read: nothing opens or is made, and it says so', async () => {
        web.loaded = false;
        web.readFails = true;
        web.across = [{ id: 'x-1', peerKey: K }];
        expect(await messageOnWeb({ key: K, community: FAR }, 'Dee')).toEqual({ refused: "Couldn't reach your community. Check your connection and try again." });
        expect(web.opened).toEqual([]);
    });

    it('a link to an address that is not a community\'s: says so, never a tap that does nothing', async () => {
        expect(await messageOnWeb({ key: K, community: 'not an address' }, 'Dee')).toEqual({ refused: 'Please try again.' });
        expect(web.opened).toEqual([]);
    });
});
