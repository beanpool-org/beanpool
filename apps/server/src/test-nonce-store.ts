/**
 * NonceStore: forgetting spent nonces costs O(1)-ish a request, and a replay is still refused at every edge.
 *
 * Load model 2026-10-05 (scratch/global-node/LOAD-MODEL-2026-10-05.md, "Performance fixes" 1): once the store held more
 * than 10,000 nonces, every consume walked the whole map, and since every nonce in it was still fresh it freed nothing
 * and did the same on the next request: 7.9% of all CPU at 1000 members. The work is counted here, not timed: the
 * store's map is swapped for one that counts every entry iterated, and the store's own heap visits are added.
 *
 * Run: node scripts/run-server-suites.mjs with SERVER_SUITES_ONLY=test-nonce-store
 */
import { NonceStore, SIGNATURE_FRESHNESS_MS } from './engine/member-signature.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`  ✓ ${msg}`); } else console.log(`  ✗ ${msg}`);
}

/** A Map that counts every entry anyone iterates over. */
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

function counted(windowMs: number): { store: NonceStore; work: () => number } {
    const store = new NonceStore(windowMs);
    const map = new CountingMap();
    (store as unknown as { seen: Map<string, number> }).seen = map;
    const visits = () => (store as unknown as { sweepVisits?: number }).sweepVisits ?? 0;
    return { store, work: () => map.iterated + visits() };
}

/** How many nonces the store holds, read from its map so the count is the same on a store with no `size`. */
const held = (s: NonceStore): number => (s as unknown as { seen: Map<string, number> }).seen.size;

const W = SIGNATURE_FRESHNESS_MS;
const T0 = 1_800_000_000_000;

function main(): void {
    console.log('\n1. 20,000 fresh nonces held: N more consumes do O(N) work, not O(N × 20,000)');
    {
        const { store, work } = counted(W);
        for (let i = 0; i < 20_000; i++) store.consume(`live-${i}`, T0 + i);
        const before = work();
        const N = 2_000;
        for (let i = 0; i < N; i++) store.consume(`more-${i}`, T0 + 20_000 + i);
        const spent = work() - before;
        console.log(`     work for ${N} consumes at 20,000 held: ${spent} entries visited`);
        assert(spent <= 3 * N, `at most ${3 * N} entries visited (was ${spent})`);
        let stillSpent = 0;
        for (let i = 0; i < 20_000; i++) if (store.isSpent(`live-${i}`, T0 + 22_000)) stillSpent++;
        assert(stillSpent === 20_000, 'every one of the 20,000 is still spent: nothing fresh was forgotten');
        assert(!store.consume('live-0', T0 + 22_000), 'a replay of the first one is refused');
    }

    console.log('\n2. a replay is refused at every edge, with the store big enough to sweep on every consume');
    {
        const store = new NonceStore(W);
        // Background that never expires here, so every consume below sweeps first.
        for (let i = 0; i < 10_001; i++) store.consume(`bg-${i}`, T0, T0 + 1e12);
        const t = T0 + 1000;
        assert(store.consume('X', t, t), 'X spent at t');
        assert(!store.consume('X', t + W - 1, t + W - 1), 'X replayed at t + window - 1: refused');
        assert(!store.consume('X', t + W, t + W), 'X replayed at t + window (the last fresh ms): refused');
        assert(store.consume('X', t + W + 1, t + W + 1), 'X at t + window + 1 (past its stored expiry): accepted');

        // A phone whose clock runs a whole window ahead: Y expires after nonces spent later than it.
        const u = T0 + 10 * W;
        assert(store.consume('Y', u, u + W), 'Y spent at u, signed a window ahead');
        for (let i = 0; i < 50; i++) store.consume(`later-${i}`, u + 1 + i);
        // Every later-* has expired and been swept by now; Y has not.
        assert(store.consume('sweeper', u + W + 100), 'a consume past the later nonces\' expiry sweeps them');
        assert(held(store) === 10_001 + 1 + 1, `the later ones are freed, Y and the sweeper are held (size ${held(store)})`);
        assert(!store.consume('Y', u + W + 100, u + W + 100), 'Y replayed after the sweep that freed nonces spent after it: refused');
        assert(!store.consume('Y', u + 2 * W, u + 2 * W), 'Y replayed at u + 2 windows (its last fresh ms): refused');
        assert(store.isSpent('Y', u + 2 * W), 'isSpent agrees at that edge');
        assert(!store.isSpent('Y', u + 2 * W + 1), 'and is false past it');
        assert(store.consume('Y', u + 2 * W + 1, u + 2 * W + 1), 'Y past its stored expiry: accepted');

        // Spent again after expiring: the old heap entry must not free the new spend.
        assert(!store.consume('Y', u + 2 * W + 2, u + 2 * W + 2), 'Y re-spent is refused again');
    }

    console.log('\n3. expired nonces are freed: on the next consume above the threshold, and by prune below it');
    {
        const store = new NonceStore(W);
        for (let i = 0; i < 20_000; i++) store.consume(`n-${i}`, T0 + i);
        assert(held(store) === 20_000, '20,000 held');
        store.consume('after', T0 + 20_000 + W + 1);
        assert(held(store) === 1, `all 20,000 expired ones freed by the next consume (size ${held(store)})`);

        const small = new NonceStore(W);
        for (let i = 0; i < 100; i++) small.consume(`s-${i}`, T0 + i);
        small.prune(T0 + 49 + W + 1);
        assert(held(small) === 50, `prune frees the 50 expired and keeps the 50 fresh (size ${held(small)})`);
        assert(!small.consume('s-50', T0 + 49 + W + 1), 'a fresh one is still refused after prune');
    }

    console.log('\n4. against a model: 30,000 random spends of 2,000 nonces, clocks ahead and behind, store sweeping on every consume');
    {
        const store = new NonceStore(W);
        for (let i = 0; i < 10_001; i++) store.consume(`bg-${i}`, T0, T0 + 1e12);
        const model = new Map<string, number>();
        let seed = 12345;
        const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        let now = T0;
        let mismatches = 0, sizeWrong = 0, refused = 0;
        for (let i = 0; i < 30_000; i++) {
            now += Math.floor(rand() * 200);
            const nonce = `p-${Math.floor(rand() * 2000)}`;
            const signedAt = now + Math.floor((rand() * 2 - 1) * W);
            const exp = model.get(nonce);
            const expect = !(exp !== undefined && exp > now);
            if (expect) model.set(nonce, Math.max(now, signedAt) + W + 1);
            else refused++;
            if (store.consume(nonce, now, signedAt) !== expect) mismatches++;
            let live = 0;
            for (const e of model.values()) if (e > now) live++;
            if (held(store) !== 10_001 + live) sizeWrong++;
        }
        assert(refused > 1000, `the run had replays to refuse (${refused})`);
        assert(mismatches === 0, `every answer matches the model (${mismatches} mismatches)`);
        assert(sizeWrong === 0, `after every consume the store holds exactly the fresh nonces (${sizeWrong} wrong)`);
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main();
