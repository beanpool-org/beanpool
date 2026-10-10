import { describe, it, expect } from 'vitest';
import {
    nearbyReconcile, nearbyIdReads, nearbyPrune, nearbySetOf, nearbyKm, NEARBY_IDS_PER_READ, NEARBY_ID_READS_PER_CYCLE,
    type NearbyHeld,
} from '../posts-nearby';

// utils/posts-nearby.ts: what a phone keeps of a community that syncs by area (DESIGN-global-sync-by-area §2.4). Two
// thousand seeded random worlds: what the phone holds, the node's set, ids the node won't hand out, the member's area.

function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

interface World {
    held: NearbyHeld[];
    set: string[];
    /** Ids of the set the node won't answer by `ids=` (gone since, or not this reader's). */
    unfetchable: Set<string>;
    area: { lat: number; lng: number } | null;
    max: number;
}

function world(seed: number): World {
    const r = rng(seed);
    const n = Math.floor(r() * 400);
    const area = r() < 0.85 ? { lat: -60 + r() * 120, lng: -180 + r() * 360 } : null;
    const at = () => new Date(Date.UTC(2026, 0, 1) + Math.floor(r() * 3e10)).toISOString();
    const place = () => (r() < 0.1 ? { lat: null, lng: null } : area && r() < 0.7
        ? { lat: area.lat + (r() - 0.5) * 6, lng: area.lng + (r() - 0.5) * 6 }
        : { lat: -80 + r() * 160, lng: -180 + r() * 360 });
    const held: NearbyHeld[] = [];
    for (let i = 0; i < n; i++) held.push({ id: `h${i}`, ...place(), at: r() < 0.05 ? null : at(), kept: r() < 0.08 });
    // The set: some of what the phone holds (kept or not), some it doesn't, in no order of the phone's.
    const set: string[] = [];
    for (const h of held) if (r() < 0.5) set.push(h.id);
    const newOnes = Math.floor(r() * 350);
    for (let i = 0; i < newOnes; i++) set.push(`n${i}`);
    for (let i = set.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [set[i], set[j]] = [set[j], set[i]];
    }
    const unfetchable = new Set(set.filter(id => id.startsWith('n') && r() < 0.1));
    return { held, set, unfetchable, area, max: 1 + Math.floor(r() * 600) };
}

/** One cycle as services/pillar-sync.ts runs it: drop, then the `ids=` reads, each answering what the node will give. */
function reconcileCycle(held: NearbyHeld[], set: string[], unfetchable: Set<string>): { after: NearbyHeld[]; asked: string[] } {
    const { drop, missing } = nearbyReconcile(held, set);
    const dropped = new Set(drop);
    const after = held.filter(h => !dropped.has(h.id));
    const asked: string[] = [];
    for (const read of nearbyIdReads(missing)) {
        expect(read.length).toBeLessThanOrEqual(NEARBY_IDS_PER_READ);
        for (const id of read) {
            asked.push(id);
            if (!unfetchable.has(id)) after.push({ id, lat: null, lng: null, at: null, kept: false });
        }
    }
    return { after, asked };
}

const ids = (rows: { id: string }[]) => new Set(rows.map(r => r.id));
const sorted = (s: Iterable<string>) => [...s].sort();

describe('posts-nearby, 2,000 seeded worlds', { timeout: 60_000 }, () => {
    const WORLDS = 2000;

    it('held after reconcile = the set ∪ own ∪ tied (every id the node hands out fetched, cycle after cycle)', () => {
        let multiCycle = 0;
        for (let seed = 1; seed <= WORLDS; seed++) {
            const w = world(seed);
            let held = w.held;
            let cycles = 0;
            // The `ids=` reads stop at three a cycle; the next cycle carries on with the same set.
            for (;;) {
                const { after, asked } = reconcileCycle(held, w.set, w.unfetchable);
                held = after;
                cycles++;
                if (asked.every(id => w.unfetchable.has(id))) break;
                expect(cycles).toBeLessThan(10);
            }
            if (cycles > 2) multiCycle++;
            const want = new Set([...w.set.filter(id => !w.unfetchable.has(id)), ...w.held.filter(h => h.kept).map(h => h.id)]);
            expect(sorted(ids(held)), `seed ${seed}`).toEqual(sorted(want));
        }
        // Some worlds needed more than one cycle's three reads, so the carry-on was exercised.
        expect(multiCycle).toBeGreaterThan(0);
    });

    it('never drops own or tied, whatever the set says', () => {
        for (let seed = 1; seed <= WORLDS; seed++) {
            const w = world(seed);
            const { drop } = nearbyReconcile(w.held, w.set);
            const kept = new Set(w.held.filter(h => h.kept).map(h => h.id));
            expect(drop.filter(id => kept.has(id)), `seed ${seed}`).toEqual([]);
            // An empty set (the node lists nothing near) still keeps them.
            expect(nearbyReconcile(w.held, []).drop.filter(id => kept.has(id))).toEqual([]);
            expect(nearbyPrune(w.held, w.area, w.max).filter(id => kept.has(id)), `seed ${seed}`).toEqual([]);
            expect(nearbyPrune(w.held, w.area, 0).filter(id => kept.has(id))).toEqual([]);
        }
    });

    it('a set with an id the phone can\'t fetch leaves the rest intact', () => {
        let sawOne = 0;
        for (let seed = 1; seed <= WORLDS; seed++) {
            const w = world(seed);
            if (w.unfetchable.size === 0) continue;
            sawOne++;
            const { after, asked } = reconcileCycle(w.held, w.set, w.unfetchable);
            const holding = ids(after);
            // Every row of the set the phone held stays; every one it could fetch in this cycle's reads came.
            const inSet = new Set(w.set);
            for (const h of w.held) if (inSet.has(h.id)) expect(holding.has(h.id)).toBe(true);
            for (const id of asked) expect(holding.has(id)).toBe(!w.unfetchable.has(id));
            for (const id of w.unfetchable) expect(holding.has(id)).toBe(false);
        }
        expect(sawOne).toBeGreaterThan(100);
    });

    it('prune keeps the nearest max (no place counts as farthest), or the newest max without an area', () => {
        for (let seed = 1; seed <= WORLDS; seed++) {
            const w = world(seed);
            const gone = new Set(nearbyPrune(w.held, w.area, w.max));
            const others = w.held.filter(h => !h.kept);
            const stay = others.filter(h => !gone.has(h.id));
            expect(stay.length, `seed ${seed}`).toBe(Math.min(w.max, others.length));
            // Brute force: rank every other listing, keep the first max.
            const key = (h: NearbyHeld) => (w.area
                ? (h.lat === null || h.lng === null ? Infinity : nearbyKm(w.area.lat, w.area.lng, h.lat, h.lng))
                : -(h.at ? Date.parse(h.at) : -Infinity));
            // Ties (two with no place, two at one time) newest first, then by id: no subtraction, Infinity − Infinity is NaN.
            const cmp = (x: number, y: number) => (x === y ? 0 : x < y ? -1 : 1);
            const time = (h: NearbyHeld) => h.at ?? '';
            const ranked = [...others].sort((a, b) => cmp(key(a), key(b)) || (time(b) < time(a) ? -1 : time(b) > time(a) ? 1 : 0) || (a.id < b.id ? -1 : 1));
            const worstKept = Math.max(-Infinity, ...stay.map(key));
            const bestGone = Math.min(Infinity, ...others.filter(h => gone.has(h.id)).map(key));
            expect(worstKept <= bestGone, `seed ${seed}`).toBe(true);
            expect(sorted(ids(stay))).toEqual(sorted(ids(ranked.slice(0, w.max))));
        }
    });

    it('prune never cuts a reconciled set: at most max near listings beside own and tied', () => {
        for (let seed = 1; seed <= WORLDS; seed++) {
            const w = world(seed);
            // The node's set holds at most max listings that aren't the member's own or tied.
            const keptIds = new Set(w.held.filter(h => h.kept).map(h => h.id));
            const near = w.set.filter(id => !keptIds.has(id)).slice(0, w.max);
            const { after } = reconcileCycle(w.held, [...near, ...keptIds], new Set());
            expect(nearbyPrune(after, w.area, w.max), `seed ${seed}`).toEqual([]);
        }
    });
});

describe('posts-nearby, the edges', () => {
    const h = (id: string, kept = false, lat: number | null = 0.5, lng: number | null = 0.5, at: string | null = '2026-10-01T00:00:00.000Z'): NearbyHeld =>
        ({ id, lat, lng, at, kept });

    it('a listing written after the set (a push replayed over the cycle) is not dropped by it', () => {
        expect(nearbyReconcile([h('a'), h('pushed')], ['a'], new Set(['pushed'])).drop).toEqual([]);
        expect(nearbyReconcile([h('a'), h('pushed')], ['a']).drop).toEqual(['pushed']);
    });

    it('missing keeps the set\'s order and names each id once', () => {
        expect(nearbyReconcile([h('b')], ['c', 'b', 'a', 'c']).missing).toEqual(['c', 'a']);
    });

    it('the id reads: 100 a read, three a cycle', () => {
        const many = Array.from({ length: 450 }, (_, i) => `x${i}`);
        const reads = nearbyIdReads(many);
        expect(reads.map(r => r.length)).toEqual([100, 100, 100]);
        expect(reads.length).toBe(NEARBY_ID_READS_PER_CYCLE);
        expect(nearbyIdReads([])).toEqual([]);
    });

    it('an answer\'s set: only the by-area shape, with string ids', () => {
        expect(nearbySetOf({ posts: [{ id: 'a' }], set: ['a'], setHash: 'x' })).toEqual({ posts: [{ id: 'a' }], set: ['a'] });
        expect(nearbySetOf([{ id: 'a' }])).toBeNull();
        expect(nearbySetOf({ posts: [] })).toBeNull();
        expect(nearbySetOf({ posts: [], set: [1] })).toBeNull();
        expect(nearbySetOf(null)).toBeNull();
    });

    it('prune: across the antimeridian a listing 20 km away beats one 300 km away', () => {
        const area = { lat: -17.8, lng: 179.9 };
        const gone = nearbyPrune([h('near', false, -17.8, -179.9), h('far', false, -17.8, 177.0)], area, 1);
        expect(gone).toEqual(['far']);
    });

    it('prune: nothing goes at or under max, and a listing with no place goes first', () => {
        expect(nearbyPrune([h('a'), h('b')], { lat: 0, lng: 0 }, 2)).toEqual([]);
        expect(nearbyPrune([h('placed'), h('nowhere', false, null, null)], { lat: 0, lng: 0 }, 1)).toEqual(['nowhere']);
    });
});
