import { describe, it, expect } from 'vitest';
import {
    buildNeedsYou, closesInWords, fitNeedsYou, moreLabel, needsYouRowOrder, NEEDS_YOU_PRIORITY,
    type NeedsYouInputs, type NeedsYouEntry,
} from '../needs-you';

const ME = 'me-pubkey';
// A fixed local afternoon, so the day-boundary wording is stable wherever the suite runs.
const NOW = new Date(2026, 8, 19, 14, 0, 0).getTime();
const H = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const quiet = (over: Partial<NeedsYouInputs> = {}): NeedsYouInputs => ({
    me: ME, now: NOW, transactions: [], decisions: { decisions: [], myPoolVoting: null, signed: true },
    conversations: [], groupChats: [], ...over,
});
const tx = (id: string, status: string, seller = ME, buyer = 'other') => ({ id, postId: `post-${id}`, status, sellerPublicKey: seller, buyerPublicKey: buyer });
const vote = (closesInMs: number, over: Record<string, unknown> = {}) => ({
    opensAt: iso(NOW - H), closesAt: iso(NOW + closesInMs), myVote: null, franchise: '1m1v' as const, ...over,
});
const dm = (id: string, unread: number, peer = 'Ana', type = 'dm') => ({ id, type, unread, peer });
const group = (id: string, unreadCount: number, over: Record<string, unknown> = {}) => ({
    kind: 'group' as const, conversationId: id, name: `Group ${id}`, unreadCount, mute: null, ...over,
});

/** Stubs standing in for real data: one of every kind. */
const allFour = () => buildNeedsYou(quiet({
    transactions: [tx('a', 'requested'), tx('b', 'pending', 'other', ME)],
    decisions: { decisions: [vote(20 * H) as any], myPoolVoting: null, signed: true },
    conversations: [dm('c1', 1)],
    groupChats: [group('g1', 2), group('g2', 1), group('g3', 4)],
}));

describe('What needs you: which kinds show', () => {
    it('a quiet day shows nothing', () => {
        expect(buildNeedsYou(quiet())).toEqual([]);
    });

    it('orders by priority, highest first: deal, vote, message, group', () => {
        expect(NEEDS_YOU_PRIORITY).toEqual(['deal', 'vote', 'message', 'group']);
        expect(allFour().map(e => e.kind)).toEqual(['deal', 'vote', 'message', 'group']);
    });

    it('a deal waits on you when a request is made to you, or a deal of yours is in progress; not when you asked and wait on them', () => {
        const only = (t: ReturnType<typeof tx>[]) => buildNeedsYou(quiet({ transactions: t }));
        expect(only([tx('a', 'requested')])[0]?.count).toBe(1);
        expect(only([tx('a', 'pending', 'other', ME)])[0]?.count).toBe(1);
        expect(only([tx('a', 'requested', 'other', ME)])).toEqual([]);
        expect(only([tx('a', 'completed'), tx('b', 'cancelled')])).toEqual([]);
    });

    it('votes: only open, not yet cast, and ones you can cast', () => {
        const only = (d: any[], myPoolVoting: any = null) => buildNeedsYou(quiet({ decisions: { decisions: d, myPoolVoting, signed: true } }));
        expect(only([vote(5 * 24 * H, { myVote: { choice: 'yes' } })])).toEqual([]);
        expect(only([vote(5 * 24 * H, { opensAt: iso(NOW + H) })])).toEqual([]);
        expect(only([vote(-H)])).toEqual([]);
        // A money vote before your first completed trade asks nothing of you yet.
        const noTrade = { voiceCredits: 0, hasCompletedTrade: false };
        expect(only([vote(5 * 24 * H, { franchise: 'quadratic_trade' })], noTrade)).toEqual([]);
        expect(only([vote(5 * 24 * H, { franchise: '1m1v' })], noTrade)).toHaveLength(1);
    });

    it('an unsigned Decisions list cannot say which votes are yours, so it shows no vote icon', () => {
        const d = { decisions: [vote(5 * 24 * H) as any], myPoolVoting: null, signed: false };
        expect(buildNeedsYou(quiet({ decisions: d }))).toEqual([]);
        expect(buildNeedsYou(quiet({ decisions: null }))).toEqual([]);
    });

    it('messages count direct chats only; group and event chats come from Your groups', () => {
        const e = buildNeedsYou(quiet({ conversations: [dm('c1', 2), dm('g', 5, 'G', 'group_thread'), dm('e', 1, 'E', 'event_thread'), dm('c2', 0)] }));
        expect(e.map(x => [x.kind, x.count])).toEqual([['message', 1]]);
    });

    it('a legacy non-thread group conversation is not counted as a message from a person', () => {
        expect(buildNeedsYou(quiet({ conversations: [dm('old', 3, 'Old group', 'group')] }))).toEqual([]);
        expect(buildNeedsYou(quiet({ conversations: [dm('old', 3, 'Old group', 'group'), dm('c1', 1)] }))[0])
            .toMatchObject({ kind: 'message', count: 1, target: { to: 'chat', conversationId: 'c1' } });
    });

    it('groups skip muted chats, read chats, and enterprise chats (no screen for them in the app yet)', () => {
        const e = buildNeedsYou(quiet({ groupChats: [
            group('g1', 3), group('g2', 0), group('g3', 5, { mute: { always: true } }), group('ent', 2, { kind: 'enterprise' }),
        ] }));
        expect(e).toHaveLength(1);
        expect(e[0]).toMatchObject({ kind: 'group', count: 1, target: { to: 'chat', conversationId: 'g1' } });
    });

    it('a source that failed to load is left out, the rest still show', () => {
        const e = buildNeedsYou(quiet({ transactions: null, conversations: [dm('c1', 1)], groupChats: null }));
        expect(e.map(x => x.kind)).toEqual(['message']);
    });
});

describe('What needs you: accent (amber, never red)', () => {
    it('a waiting deal always gets the accent', () => {
        expect(buildNeedsYou(quiet({ transactions: [tx('a', 'requested')] }))[0].accent).toBe(true);
    });

    it('a vote gets it only when the soonest uncast one closes within 48h', () => {
        const v = (ms: number[]) => buildNeedsYou(quiet({ decisions: { decisions: ms.map(m => vote(m)) as any, myPoolVoting: null, signed: true } }))[0];
        expect(v([47 * H]).accent).toBe(true);
        expect(v([48 * H]).accent).toBe(true);
        expect(v([49 * H]).accent).toBe(false);
        expect(v([10 * 24 * H, 30 * H]).accent).toBe(true);
    });

    it('messages and groups never get it', () => {
        const e = allFour();
        expect(e.find(x => x.kind === 'message')!.accent).toBe(false);
        expect(e.find(x => x.kind === 'group')!.accent).toBe(false);
    });
});

describe('What needs you: words for screen readers and the sheet', () => {
    it('deals', () => {
        expect(buildNeedsYou(quiet({ transactions: [tx('a', 'requested')] }))[0].label).toBe('A deal is waiting for you');
        expect(buildNeedsYou(quiet({ transactions: [tx('a', 'requested'), tx('b', 'pending')] }))[0].label).toBe('2 deals waiting for you');
    });

    it('votes say when the first one closes', () => {
        const v = (ms: number[]) => buildNeedsYou(quiet({ decisions: { decisions: ms.map(m => vote(m)) as any, myPoolVoting: null, signed: true } }))[0].label;
        expect(v([20 * H])).toBe('Vote closes tomorrow');
        expect(v([5 * H, 3 * 24 * H, 4 * 24 * H])).toBe('3 votes to cast, the first closes in 5 hours');
    });

    it('closing times in words', () => {
        expect(closesInWords(iso(NOW + 30 * 60_000), NOW)).toBe('closes within the hour');
        expect(closesInWords(iso(NOW + H), NOW)).toBe('closes in 1 hour');
        expect(closesInWords(iso(NOW + 3 * H), NOW)).toBe('closes in 3 hours');
        expect(closesInWords(iso(NOW + 26 * H), NOW)).toBe('closes tomorrow');
        expect(closesInWords(iso(NOW + 4 * 24 * H), NOW)).toBe('closes in 4 days');
        const earlyMorning = new Date(2026, 8, 19, 1, 0, 0).getTime();
        expect(closesInWords(iso(earlyMorning + 13 * H), earlyMorning)).toBe('closes later today');
        expect(closesInWords(iso(earlyMorning + 20 * H), earlyMorning)).toBe('closes tonight');
    });

    it('messages', () => {
        expect(buildNeedsYou(quiet({ conversations: [dm('c1', 1)] }))[0].label).toBe('Unread message from Ana');
        expect(buildNeedsYou(quiet({ conversations: [dm('c1', 4)] }))[0].label).toBe('4 unread messages from Ana');
        expect(buildNeedsYou(quiet({ conversations: [dm('c1', 1), dm('c2', 2, 'Bo'), dm('c3', 1, 'Cy')] }))[0].label).toBe('Unread messages from 3 people');
    });

    it('groups', () => {
        expect(buildNeedsYou(quiet({ groupChats: [group('g1', 5, { name: 'Castlemaine Growers' })] }))[0].label).toBe('5 new lines in Castlemaine Growers');
        expect(buildNeedsYou(quiet({ groupChats: [group('g1', 1, { name: 'Growers' })] }))[0].label).toBe('1 new line in Growers');
        expect(buildNeedsYou(quiet({ groupChats: [group('g1', 1), group('g2', 2), group('g3', 3)] }))[0].label).toBe('New lines in 3 of your groups');
    });

    it('the overflow', () => {
        expect(moreLabel(1)).toBe('1 more thing needs you');
        expect(moreLabel(3)).toBe('3 more things need you');
    });
});

describe('What needs you: where a tap lands', () => {
    it('one item goes to the item, several to the list', () => {
        expect(buildNeedsYou(quiet({ transactions: [tx('a', 'requested')] }))[0].target).toEqual({ to: 'deal', postId: 'post-a', txId: 'a' });
        expect(buildNeedsYou(quiet({ transactions: [tx('a', 'requested'), tx('b', 'pending')] }))[0].target).toEqual({ to: 'my-deals' });
        expect(buildNeedsYou(quiet({ conversations: [dm('c1', 1)] }))[0].target).toEqual({ to: 'chat', conversationId: 'c1' });
        expect(buildNeedsYou(quiet({ conversations: [dm('c1', 1), dm('c2', 1)] }))[0].target).toEqual({ to: 'unread-messages' });
        expect(buildNeedsYou(quiet({ groupChats: [group('g1', 1), group('g2', 1)] }))[0].target).toEqual({ to: 'unread-messages' });
    });

    it('an event chat opens as an event chat', () => {
        expect(buildNeedsYou(quiet({ groupChats: [group('ev', 1, { kind: 'event' })] }))[0].target).toEqual({ to: 'chat', conversationId: 'ev', event: true });
    });

    it('every vote lands on Commons → Decide (there is no route for one Decision)', () => {
        const d = { decisions: [vote(20 * H) as any], myPoolVoting: null, signed: true };
        expect(buildNeedsYou(quiet({ decisions: d }))[0].target).toEqual({ to: 'decide' });
    });
});

describe('What needs you: fitting the slot (48dp each) and the row order', () => {
    const kinds = (es: NeedsYouEntry[]) => es.map(e => e.kind);

    it('nothing shows until the slot is measured', () => {
        expect(fitNeedsYou(allFour(), 0)).toEqual({ shown: [], hidden: 0 });
    });

    it('411dp phone: a 208dp slot holds all four', () => {
        const fit = fitNeedsYou(allFour(), 208);
        expect(kinds(fit.shown)).toEqual(['deal', 'vote', 'message', 'group']);
        expect(fit.hidden).toBe(0);
    });

    it('320dp + 1.3x: a 116dp slot holds 2, so four kinds show the highest plus "•••" for 3 more', () => {
        const fit = fitNeedsYou(allFour(), 116);
        expect(kinds(fit.shown)).toEqual(['deal']);
        expect(fit.hidden).toBe(3);
    });

    it('two kinds fit two slots exactly, with no "•••"', () => {
        const two = allFour().slice(0, 2);
        expect(fitNeedsYou(two, 116)).toEqual({ shown: two, hidden: 0 });
    });

    it('a 1-slot row is all "•••"', () => {
        expect(fitNeedsYou(allFour(), 50)).toEqual({ shown: [], hidden: 4 });
    });

    it('drawn right-aligned: the highest priority is rightmost, next to the invite/Settings/avatar group; "•••" is leftmost', () => {
        expect(needsYouRowOrder(fitNeedsYou(allFour(), 208))).toEqual(['group', 'message', 'vote', 'deal']);
        expect(needsYouRowOrder(fitNeedsYou(allFour(), 150))).toEqual(['more', 'vote', 'deal']);
        expect(needsYouRowOrder(fitNeedsYou(allFour(), 116))).toEqual(['more', 'deal']);
    });

    it('the highest-priority icon keeps its spot as others come and go', () => {
        const all = allFour();
        for (const n of [1, 2, 3, 4]) {
            const order = needsYouRowOrder(fitNeedsYou(all.slice(0, n), 208));
            expect(order[order.length - 1]).toBe('deal');
        }
    });
});
