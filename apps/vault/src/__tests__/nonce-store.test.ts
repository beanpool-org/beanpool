import { describe, expect, it } from 'vitest';
import { NonceStore, SIGNATURE_FRESHNESS_MS } from '../api/auth.js';

/**
 * The vault's nonce store: forgetting spent nonces costs O(log n) a request, not a walk of every nonce held (load model
 * 2026-10-05, "Performance fixes" 1), and a replay is still refused at every edge. Work is counted, not timed: the
 * store's map is swapped for one that counts every entry iterated, and the store's own heap visits are added.
 */

class CountingMap extends Map<string, number> {
    iterated = 0;
    override [Symbol.iterator](): MapIterator<[string, number]> { return this.counted(super[Symbol.iterator]()); }
    override entries(): MapIterator<[string, number]> { return this.counted(super.entries()); }
    override keys(): MapIterator<string> { return this.counted(super.keys()); }
    override values(): MapIterator<number> { return this.counted(super.values()); }
    override forEach(cb: (v: number, k: string, m: Map<string, number>) => void): void {
        super.forEach((v, k, m) => { this.iterated++; cb(v, k, m); });
    }
    private counted<T>(it: MapIterator<T>): MapIterator<T> {
        const self = this;
        const wrapped = {
            next(): IteratorResult<T> { const r = it.next(); if (!r.done) self.iterated++; return r; },
            [Symbol.iterator]() { return wrapped; },
        };
        return wrapped as unknown as MapIterator<T>;
    }
}

const W = SIGNATURE_FRESHNESS_MS;
const T0 = 1_800_000_000_000;
/** How many nonces the store holds, read from its map so the count is the same on a store with no `size`. */
const held = (s: NonceStore): number => (s as unknown as { seen: Map<string, number> }).seen.size;
const spent = (s: NonceStore, nonce: string, now: number): boolean => {
    const exp = (s as unknown as { seen: Map<string, number> }).seen.get(nonce);
    return exp !== undefined && exp > now;
};

describe('the vault\'s nonce store', () => {
    it('does O(N) work for N spends while holding 60,000 fresh nonces, and forgets none of them', () => {
        const store = new NonceStore();
        const map = new CountingMap();
        (store as unknown as { seen: Map<string, number> }).seen = map;
        const work = () => map.iterated + ((store as unknown as { sweepVisits?: number }).sweepVisits ?? 0);
        for (let i = 0; i < 60_000; i++) store.consume(`live-${i}`, T0 + i, T0 + i);
        const before = work();
        const N = 1_000;
        for (let i = 0; i < N; i++) store.consume(`more-${i}`, T0 + 60_000 + i, T0 + 60_000 + i);
        expect(work() - before).toBeLessThanOrEqual(3 * N);
        let stillSpent = 0;
        for (let i = 0; i < 60_000; i++) if (spent(store, `live-${i}`, T0 + 61_000)) stillSpent++;
        expect(stillSpent).toBe(60_000);
        expect(store.consume('live-0', T0 + 61_000, T0 + 61_000)).toBe(false);
    });

    it('refuses a replay at every edge, a phone clock ahead included, while sweeping on every spend', () => {
        const store = new NonceStore();
        for (let i = 0; i < 50_001; i++) store.consume(`bg-${i}`, T0, T0 + 1e12);
        const t = T0 + 1000;
        expect(store.consume('X', t, t)).toBe(true);
        expect(store.consume('X', t + W, t + W)).toBe(false);
        expect(store.consume('X', t + W + 1, t + W + 1)).toBe(true);

        const u = T0 + 10 * W;
        expect(store.consume('Y', u, u + W)).toBe(true);
        for (let i = 0; i < 50; i++) store.consume(`later-${i}`, u + 1 + i, u + 1 + i);
        expect(store.consume('sweeper', u + W + 100, u + W + 100)).toBe(true);
        expect(held(store)).toBe(50_001 + 2);
        expect(store.consume('Y', u + W + 100, u + W + 100)).toBe(false);
        expect(store.consume('Y', u + 2 * W, u + 2 * W)).toBe(false);
        expect(store.consume('Y', u + 2 * W + 1, u + 2 * W + 1)).toBe(true);
        expect(store.consume('Y', u + 2 * W + 2, u + 2 * W + 2)).toBe(false);
    });

    it('frees every expired nonce on the next spend above the threshold, and by prune below it', () => {
        const store = new NonceStore();
        for (let i = 0; i < 60_000; i++) store.consume(`n-${i}`, T0 + i, T0 + i);
        store.consume('after', T0 + 60_000 + W + 1, T0 + 60_000 + W + 1);
        expect(held(store)).toBe(1);

        const small = new NonceStore();
        for (let i = 0; i < 100; i++) small.consume(`s-${i}`, T0 + i, T0 + i);
        small.prune(T0 + 49 + W + 1);
        expect(held(small)).toBe(50);
        expect(small.consume('s-50', T0 + 49 + W + 1, T0 + 49 + W + 1)).toBe(false);
    });

    it('answers as a model does over 20,000 random spends, holding exactly the fresh nonces after each', () => {
        const store = new NonceStore();
        for (let i = 0; i < 50_001; i++) store.consume(`bg-${i}`, T0, T0 + 1e12);
        const model = new Map<string, number>();
        let seed = 777;
        const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        let now = T0, mismatches = 0, sizeWrong = 0;
        for (let i = 0; i < 20_000; i++) {
            now += Math.floor(rand() * 200);
            const nonce = `p-${Math.floor(rand() * 2000)}`;
            const signedAt = now + Math.floor((rand() * 2 - 1) * W);
            const exp = model.get(nonce);
            const expected = !(exp !== undefined && exp > now);
            if (expected) model.set(nonce, Math.max(now, signedAt) + W + 1);
            if (store.consume(nonce, now, signedAt) !== expected) mismatches++;
            let live = 0;
            for (const e of model.values()) if (e > now) live++;
            if (held(store) !== 50_001 + live) sizeWrong++;
        }
        expect(mismatches).toBe(0);
        expect(sizeWrong).toBe(0);
    });
});
