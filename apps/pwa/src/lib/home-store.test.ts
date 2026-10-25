import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    forgetHomeForHeader,
    freshHomeForHeader,
    HOME_FRESH_FOR_HEADER_MS,
    HOME_HEADER_WAIT_MS,
    homeForHeader,
    isHomeInflight,
    markHomeInflight,
    onHomeRead,
    recordHomeAnswer,
    resetHomeStoreForTests,
} from './home-store';
import type { HomeAnswer } from './home-cards';

const makeAnswer = (items: any[] = []): HomeAnswer => ({
    generatedAt: new Date().toISOString(),
    profile: 'local',
    features: { beans: true, decisions: true, invites: true },
    me: {
        joinedAt: '2026-01-01T00:00:00.000Z',
        isKeeper: false,
        probation: null,
        interests: [],
        area: null,
        firstOffer: true,
        standing: 'member',
    },
    layout: { v: 2, cards: [{ id: 'c1', type: 'community' }], dismissed: {}, updatedAt: null },
    cards: {
        community: { name: 'Mullumbimby', members: 42 },
        needs: { items },
    },
});

describe('home-store', () => {
    beforeEach(() => {
        resetHomeStoreForTests();
    });

    afterEach(() => {
        resetHomeStoreForTests();
    });

    it('records and retrieves fresh Home answer for matching member', () => {
        const ans = makeAnswer([{ kind: 'deal', count: 1, accent: false, label: 'Deal', target: { to: 'deal' } }]);
        recordHomeAnswer(ans, 'pk_alice');

        expect(freshHomeForHeader('pk_alice')).toBe(ans);
    });

    it('visitor Home cache does NOT leak to authenticated member', () => {
        const visitorAns = makeAnswer([]);
        recordHomeAnswer(visitorAns, null);

        // Visitor cache has null publicKey; querying with member publicKey must return null
        expect(freshHomeForHeader('pk_alice')).toBeNull();
    });

    it('authenticated member Home cache does NOT leak to unauthenticated visitor', () => {
        const memberAns = makeAnswer([{ kind: 'message', count: 1, accent: false, label: 'Msg', target: { to: 'chat' } }]);
        recordHomeAnswer(memberAns, 'pk_alice');

        // Querying with null or undefined must not return Alice's private answer
        expect(freshHomeForHeader(null)).toBeNull();
        expect(freshHomeForHeader()).toBeNull();
        expect(freshHomeForHeader('pk_bob')).toBeNull();
    });

    it('expires after HOME_FRESH_FOR_HEADER_MS', () => {
        const ans = makeAnswer([]);
        recordHomeAnswer(ans, 'pk_alice');
        const recordedAt = Date.now();

        expect(freshHomeForHeader('pk_alice', recordedAt)).toBe(ans);
        expect(freshHomeForHeader('pk_alice', recordedAt + HOME_FRESH_FOR_HEADER_MS - 1)).toBe(ans);
        expect(freshHomeForHeader('pk_alice', recordedAt + HOME_FRESH_FOR_HEADER_MS)).toBeNull();
    });

    it('forgetHomeForHeader wipes the cache', () => {
        const ans = makeAnswer([]);
        recordHomeAnswer(ans, 'pk_alice');
        expect(freshHomeForHeader('pk_alice')).toBe(ans);

        forgetHomeForHeader();
        expect(freshHomeForHeader('pk_alice')).toBeNull();
    });

    it('onHomeRead listener receives answers and can unsubscribe', () => {
        const listener = vi.fn();
        const unsubscribe = onHomeRead(listener);

        const ans = makeAnswer([]);
        recordHomeAnswer(ans, 'pk_alice');
        expect(listener).toHaveBeenCalledWith(ans, 'pk_alice');

        unsubscribe();
        recordHomeAnswer(ans, 'pk_bob');
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('inflight tracking works via markHomeInflight', async () => {
        expect(isHomeInflight()).toBe(false);

        let finishPromise: () => void = () => {};
        const p = new Promise<void>(resolve => {
            finishPromise = resolve;
        });

        markHomeInflight(p);
        expect(isHomeInflight()).toBe(true);

        finishPromise();
        await p;
        // Inflight cleans up in finally on next microtask
        await Promise.resolve();
        expect(isHomeInflight()).toBe(false);
    });

    it('homeForHeader returns fresh answer immediately if present', async () => {
        const ans = makeAnswer();
        recordHomeAnswer(ans, 'pk_alice');

        const result = await homeForHeader('pk_alice', 100);
        expect(result).toBe(ans);
    });

    it('homeForHeader waits for matching inflight read to settle', async () => {
        let finishPromise: () => void = () => {};
        const p = new Promise<void>(resolve => { finishPromise = resolve; });
        markHomeInflight(p);

        const ans = makeAnswer();
        const promise = homeForHeader('pk_alice', 500);

        // Record Alice's answer while waiting
        recordHomeAnswer(ans, 'pk_alice');

        const result = await promise;
        expect(result).toBe(ans);
    });

    it('homeForHeader returns null if waitMs elapses without matching answer', async () => {
        const result = await homeForHeader('pk_alice', 10);
        expect(result).toBeNull();
    });
});
