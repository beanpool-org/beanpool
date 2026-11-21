/**
 * Message anyone on the web (slice S5 part 2, lib/message-anyone.ts): the path table core's rule gives a browser that holds
 * one community (an across chat already here wins; this community; else across from the contact's link), and what makes or
 * refuses the chat across. Each row is red without its rule: core's own table (message-path.test.ts) names the mutants;
 * here a row also goes red with the across chats left out of the rule, or the refusals not checked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeHomeOf } from '@beanpool/core';

const web = vi.hoisted(() => ({
    here: 'https://riverside.example',
    across: [] as Array<{ id: string; peerKey: string }>,
    noContext: false,
    outsideOn: true as boolean | null,
    blocked: false,
    cards: [] as Array<{ key: string; home: string; name: string | null }>,
}));
vi.mock('./api', () => ({ nodeAddress: () => web.here }));
vi.mock('./outside-mail', () => ({
    outsideContext: async () => (web.noContext ? null : { identity: { publicKey: 'me' }, store: { chats: async () => web.across } }),
    outsideMessagesHere: async () => web.outsideOn,
    openChatFromCard: async (_ctx: unknown, card: { key: string; home: string; name: string | null }) => {
        if (web.blocked) return null;
        web.cards.push(card);
        return `across-${card.key.slice(0, 4)}`;
    },
}));

import { messagePathOnWeb, openAcrossOnWeb } from './message-anyone';

const K = 'a1'.repeat(32);
const FAR = 'https://faraway.example';
const HELD_ON_PHONE = 'https://hillside.example';

beforeEach(() => {
    web.across = []; web.noContext = false; web.outsideOn = true; web.blocked = false; web.cards = [];
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
        expect(await openAcrossOnWeb({ ...target, open: 'across' } as typeof target)).toEqual({ chatId: `across-${K.slice(0, 4)}` });
        expect(web.cards).toEqual([target]);
    });
    it.each([
        { name: 'no account here', set: () => { web.noContext = true; }, want: 'no-community' },
        { name: 'this community takes no messages from other communities', set: () => { web.outsideOn = false; }, want: 'off' },
        { name: 'its info not read yet (the strict side)', set: () => { web.outsideOn = null; }, want: 'off' },
        { name: 'someone the account blocked', set: () => { web.blocked = true; }, want: 'blocked' },
    ])('refused: $name', async ({ set, want }) => {
        set();
        expect(await openAcrossOnWeb(target)).toEqual({ refused: want });
        expect(web.cards).toEqual([]);
    });
});
