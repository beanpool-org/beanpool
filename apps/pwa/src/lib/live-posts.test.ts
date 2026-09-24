import { describe, it, expect, beforeEach, vi } from 'vitest';
import { livePostChange } from '@beanpool/core';
import {
    applyLivePostChange,
    postFitsList,
    onLivePostChange,
    registerLivePostTie,
    routeLivePostChange,
    liveChangeMark,
    replayLiveChanges,
    heldPostTie,
    resetLivePostsForTest,
} from './live-posts';
import type { MarketplacePost } from './api';

const ANN = 'a'.repeat(64);
const ME = 'e'.repeat(64);

function offer(extra: Record<string, unknown> = {}): MarketplacePost {
    return {
        id: 'post-1', type: 'offer', category: 'food', title: 'Spare lemons', description: 'A bag', credits: 5,
        authorPublicKey: ANN, authorCallsign: 'Ann', createdAt: '2026-09-24T01:00:00.000Z',
        updatedAt: '2026-09-24T01:00:00.000Z', active: true, status: 'active', audienceScope: 'public', ...extra,
    } as MarketplacePost;
}
const created = (p: MarketplacePost) => livePostChange({ type: 'new_post', post: p })!;
const updated = (p: MarketplacePost) => livePostChange({ type: 'post_updated', post: p })!;
const removed = (id = 'post-1') => livePostChange({ type: 'post_removed', id, audienceScope: 'public' })!;
const all = () => true;

beforeEach(() => resetLivePostsForTest());

describe('applyLivePostChange: a pushed change applied to a list a page holds', () => {
    it('a new listing that fits goes to the front, where the node\'s newest-first order puts it', () => {
        const older = offer({ id: 'old', title: 'Older' });
        const next = applyLivePostChange([older], created(offer()), all);
        expect(next.map(p => p.id)).toEqual(['post-1', 'old']);
    });

    it('a new listing that does not fit the page\'s filter is left out', () => {
        expect(applyLivePostChange([], created(offer()), () => false)).toEqual([]);
    });

    it('an edit replaces the listing, and moves it to the front', () => {
        const list = [offer({ id: 'x' }), offer()];
        const next = applyLivePostChange(list, updated(offer({ title: 'Lemons and limes', updatedAt: '2026-09-24T02:00:00.000Z' })), all);
        expect(next.map(p => [p.id, p.title])).toEqual([['post-1', 'Lemons and limes'], ['x', 'Spare lemons']]);
    });

    it('an edit that takes the listing out of the filter drops it', () => {
        const next = applyLivePostChange([offer()], updated(offer({ category: 'tools', updatedAt: '2026-09-24T02:00:00.000Z' })), p => p.category === 'food');
        expect(next).toEqual([]);
    });

    // The page did not hold it, so the node's list for this page did not include it — for reasons the push cannot
    // show (an author on holiday, a paused enterprise). The next refresh decides.
    it('an edit to a listing the page does not hold is not added', () => {
        expect(applyLivePostChange([], updated(offer()), all)).toEqual([]);
    });

    it('a late push never moves a listing backwards', () => {
        const list = [offer({ title: 'v3', updatedAt: '2026-09-24T03:00:00.000Z' })];
        expect(applyLivePostChange(list, updated(offer({ title: 'v2', updatedAt: '2026-09-24T02:00:00.000Z' })), all)).toBe(list);
    });

    it('a removal drops the listing', () => {
        const next = applyLivePostChange([offer({ id: 'x' }), offer()], removed(), all);
        expect(next.map(p => p.id)).toEqual(['x']);
    });

    it('another community\'s listing with the same id is not this node\'s, and is never touched', () => {
        const remote = { ...offer(), _remoteNode: 'https://peer.beanpool.org' } as MarketplacePost;
        expect(applyLivePostChange([remote], removed(), all)).toEqual([remote]);
        const next = applyLivePostChange([remote], created(offer({ title: 'Ours' })), all);
        expect(next.map(p => p.title)).toEqual(['Ours', 'Spare lemons']);
    });

    it('a change with nothing to do returns the same list, so React skips the render', () => {
        const list = [offer({ id: 'x' })];
        expect(applyLivePostChange(list, removed(), all)).toBe(list);
        expect(applyLivePostChange(list, updated(offer()), all)).toBe(list);
        expect(applyLivePostChange(list, created(offer()), () => false)).toBe(list);
    });
});

describe('postFitsList: the node\'s list filter, for the fields a pushed listing can differ on', () => {
    it('only active listings that are open or pending are on a list', () => {
        expect(postFitsList(offer(), {})).toBe(true);
        expect(postFitsList(offer({ status: 'pending' }), {})).toBe(true);
        expect(postFitsList(offer({ status: 'completed' }), {})).toBe(false);
        expect(postFitsList(offer({ status: 'paused' }), {})).toBe(false);
        expect(postFitsList(offer({ active: false }), {})).toBe(false);
    });

    it('type and types', () => {
        expect(postFitsList(offer(), { type: 'offer' })).toBe(true);
        expect(postFitsList(offer(), { type: 'need' })).toBe(false);
        expect(postFitsList(offer(), { type: 'all' })).toBe(true);
        expect(postFitsList(offer(), { types: 'offer,need,poll,event' })).toBe(true);
        expect(postFitsList(offer(), { types: 'need,poll' })).toBe(false);
    });

    it('category, beans only, and a group feed', () => {
        expect(postFitsList(offer(), { category: 'food' })).toBe(true);
        expect(postFitsList(offer(), { category: 'tools' })).toBe(false);
        expect(postFitsList(offer({ cashAlsoNeeded: true }), { beansOnly: true })).toBe(false);
        expect(postFitsList(offer({ cashAlsoNeeded: false }), { beansOnly: true })).toBe(true);
        // A group's feed holds that group's listings; a public one is never on it.
        expect(postFitsList(offer(), { targetGroupId: 'g1' })).toBe(false);
    });
});

describe('routeLivePostChange: applied by the views, or left to the doorbell', () => {
    it('hands the change to every view and says it was applied', () => {
        const a = vi.fn(), b = vi.fn();
        onLivePostChange(a);
        onLivePostChange(b);
        const change = created(offer());
        expect(routeLivePostChange(change, ME)).toBe(true);
        expect(a).toHaveBeenCalledWith(change);
        expect(b).toHaveBeenCalledWith(change);
    });

    it('with no view mounted it is still applied: nothing on screen needs the change', () => {
        expect(routeLivePostChange(created(offer()), ME)).toBe(true);
    });

    it.each([
        ['my own listing', offer({ authorPublicKey: ME })],
        ['a listing I accepted', offer({ acceptedBy: ME, status: 'pending' })],
    ])('%s is left to the doorbell, and no view sees it', (_name, post) => {
        const view = vi.fn();
        onLivePostChange(view);
        expect(routeLivePostChange(updated(post), ME)).toBe(false);
        expect(view).not.toHaveBeenCalled();
    });

    it('a registered tie (an open deal, a chat about it) sends it to the doorbell', () => {
        const view = vi.fn();
        onLivePostChange(view);
        const off = registerLivePostTie(c => (c.kind === 'remove' ? c.id : c.post.id) === 'post-1');
        expect(routeLivePostChange(removed(), ME)).toBe(false);
        expect(routeLivePostChange(removed('other'), ME)).toBe(true);
        off();
        expect(routeLivePostChange(removed(), ME)).toBe(true);
        expect(view).toHaveBeenCalledTimes(2);
    });

    it('a tie that throws counts as a tie: the doorbell is always the safe answer', () => {
        registerLivePostTie(() => { throw new Error('boom'); });
        expect(routeLivePostChange(removed(), ME)).toBe(false);
    });

    it('unsubscribing a view stops it hearing changes', () => {
        const view = vi.fn();
        const off = onLivePostChange(view);
        off();
        routeLivePostChange(created(offer()), ME);
        expect(view).not.toHaveBeenCalled();
    });

    it('a view that throws does not stop the others', () => {
        const good = vi.fn();
        onLivePostChange(() => { throw new Error('boom'); });
        onLivePostChange(good);
        expect(routeLivePostChange(created(offer()), ME)).toBe(true);
        expect(good).toHaveBeenCalled();
    });
});

describe('heldPostTie: a removal of what a page holds as an event, a poll or my own', () => {
    it('ties a removal of a held event, poll or own listing; not an offer of someone else\'s, nor a remote one', () => {
        const list = [
            offer({ id: 'ev', type: 'event' }), offer({ id: 'poll', type: 'poll' }), offer({ id: 'mine', authorPublicKey: ME }),
            offer({ id: 'theirs' }), { ...offer({ id: 'remote-ev', type: 'event' }), _remoteNode: 'https://peer' } as MarketplacePost,
        ];
        const tie = heldPostTie(() => list, ME);
        expect(tie(removed('ev'))).toBe(true);
        expect(tie(removed('poll'))).toBe(true);
        expect(tie(removed('mine'))).toBe(true);
        expect(tie(removed('theirs'))).toBe(false);
        expect(tie(removed('remote-ev'))).toBe(false);
        expect(tie(removed('absent'))).toBe(false);
        expect(tie(updated(offer({ id: 'ev' })))).toBe(false);
    });
});

describe('replayLiveChanges: a refresh in flight does not undo a push', () => {
    it('replays the changes applied since the refresh began, over what it fetched', () => {
        const mark = liveChangeMark();
        routeLivePostChange(created(offer({ id: 'new', title: 'Arrived mid-refresh' })), ME);
        routeLivePostChange(updated(offer({ title: 'v2', updatedAt: '2026-09-24T02:00:00.000Z' })), ME);
        routeLivePostChange(removed('gone'), ME);
        // What the refresh fetched was read before any of those.
        const fetched = [offer({ title: 'v1' }), offer({ id: 'gone' })];
        const next = replayLiveChanges(mark, fetched, all);
        expect(next.map(p => [p.id, p.title])).toEqual([['post-1', 'v2'], ['new', 'Arrived mid-refresh']]);
    });

    it('does not replay changes from before the refresh began', () => {
        routeLivePostChange(created(offer({ id: 'before' })), ME);
        const mark = liveChangeMark();
        expect(replayLiveChanges(mark, [], all)).toEqual([]);
    });

    it('does not replay a change that went to the doorbell', () => {
        const mark = liveChangeMark();
        routeLivePostChange(created(offer({ authorPublicKey: ME })), ME);
        expect(replayLiveChanges(mark, [], all)).toEqual([]);
    });

    it('a refresh that already has the newer copy keeps it, and nothing is duplicated', () => {
        const mark = liveChangeMark();
        routeLivePostChange(created(offer()), ME);
        const fetched = [offer({ title: 'v2', updatedAt: '2026-09-24T02:00:00.000Z' })];
        const next = replayLiveChanges(mark, fetched, all);
        expect(next.map(p => p.title)).toEqual(['v2']);
    });
});
