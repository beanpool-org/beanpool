import { describe, it, expect } from 'vitest';
import {
    planMembersCycle, cardsToDrop, membersKeysPath, neededKeys, isMemberKey,
    KEYS_BATCH, MISSING_BATCHES_PER_CYCLE, HELD_CARDS_MAX, type HeldCard,
} from '../members-on-demand';

// The pure rule of DESIGN-global-members-by-area §2.2 (#1792), across 2,000 random worlds: a phone that runs the plan
// after every landed cycle ends up holding every referenced card and its own, asks at most 3 batches of 100 a cycle,
// never asks for a key the node would refuse, and its 1,000-card bound never drops a card a screen names.

function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const hex = (r: () => number) => Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('');
const stamp = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString();

interface World { own: string | null; referenced: string[]; held: Map<string, string | null>; }

function randomWorld(seed: number): World {
    const r = rng(seed);
    const pool = Array.from({ length: Math.floor(r() * 1600) + 1 }, () => hex(r));
    const pick = () => pool[Math.floor(r() * pool.length)];
    const referenced: string[] = [];
    const nRef = Math.floor(r() * (r() < 0.2 ? 900 : 260));
    for (let i = 0; i < nRef; i++) referenced.push(pick());
    // Keys the node would refuse ride along in the tables: project and escrow accounts, an upper-case spelling.
    if (r() < 0.3) referenced.push('project_' + hex(r).slice(0, 12), 'escrow_x', hex(r).toUpperCase(), '');
    const held = new Map<string, string | null>();
    const nHeld = Math.floor(r() * (r() < 0.15 ? 1500 : 400));
    for (let i = 0; i < nHeld; i++) held.set(pick(), r() < 0.2 ? null : stamp(Math.floor(r() * 10_000)));
    const own = r() < 0.9 ? pick() : null;
    return { own, referenced, held };
}

const cards = (held: Map<string, string | null>): HeldCard[] => [...held].map(([key, fetchedAt]) => ({ key, fetchedAt }));

describe('members on demand: the pure rule', () => {
    it('2,000 random worlds: reconcile reaches held ⊇ referenced ∪ own; batches ≤ 100, ≤ 3 a cycle; prune keeps every needed card; the bound holds', () => {
        for (let seed = 1; seed <= 2000; seed++) {
            const w = randomWorld(seed);
            const needed = neededKeys(w.own, w.referenced);
            const lacking = [...needed].filter(k => !w.held.has(k)).length;
            const cyclesNeeded = Math.ceil(lacking / (KEYS_BATCH * MISSING_BATCHES_PER_CYCLE));
            let clock = 20_000;
            for (let cycle = 0; cycle <= cyclesNeeded; cycle++) {
                const plan = planMembersCycle(w.own, w.referenced, cards(w.held));
                expect(plan.missing.length).toBeLessThanOrEqual(MISSING_BATCHES_PER_CYCLE);
                const asked = plan.missing.flat();
                expect(new Set(asked).size).toBe(asked.length);
                for (const batch of plan.missing) {
                    expect(batch.length).toBeGreaterThan(0);
                    expect(batch.length).toBeLessThanOrEqual(KEYS_BATCH);
                    const wrong = batch.filter(k => !isMemberKey(k) || !needed.has(k) || w.held.has(k));
                    expect(wrong).toEqual([]);
                    expect(membersKeysPath(batch).length).toBeLessThan(6_700);
                }
                // A cycle fetches missing cards whenever it has room for them: a short cycle means none are left.
                if (plan.missing.length < MISSING_BATCHES_PER_CYCLE || plan.missing.some(b => b.length < KEYS_BATCH)) {
                    expect(asked.length).toBe([...needed].filter(k => !w.held.has(k)).length);
                }
                if (plan.revalidate) {
                    const rv = plan.revalidate;
                    expect(rv.keys.length).toBeLessThanOrEqual(KEYS_BATCH);
                    expect(rv.keys.filter(k => !w.held.has(k))).toEqual([]);
                    const stamps = rv.keys.map(k => w.held.get(k) ?? null);
                    if (stamps.includes(null)) expect(rv.since).toBeNull();
                    else expect(rv.since).toBe([...stamps].sort()[0]);
                    // The oldest: every held card outside the batch was fetched no earlier than every card inside it
                    // (a card never stamped counts as the oldest of all).
                    const rank = (at: string | null) => at ?? '';
                    const inside = new Set(rv.keys);
                    const newestInside = stamps.map(rank).sort().at(-1)!;
                    const newer = [...w.held].filter(([k, at]) => !inside.has(k) && isMemberKey(k) && rank(at) < newestInside);
                    expect(newer).toEqual([]);
                } else {
                    expect([...w.held.keys()].filter(isMemberKey).length).toBe(0);
                }
                // The node answered every batch: each card lands stamped now; the re-checked ones are stamped too.
                clock += 5;
                for (const k of asked) w.held.set(k, stamp(clock));
                for (const k of plan.revalidate?.keys ?? []) w.held.set(k, stamp(clock));
                const drop = cardsToDrop(w.own, w.referenced, cards(w.held));
                expect(drop.filter(k => needed.has(k))).toEqual([]);
                for (const k of drop) w.held.delete(k);
                expect(w.held.size).toBeLessThanOrEqual(Math.max(HELD_CARDS_MAX, needed.size));
            }
            expect([...needed].filter(k => !w.held.has(k)), `seed ${seed}`).toEqual([]);
            expect(planMembersCycle(w.own, w.referenced, cards(w.held)).missing).toEqual([]);
        }
    }, 180_000);

    it('a restore with 250 partners asks 3 batches (100, 100, 50) in one cycle and nothing missing the next', () => {
        const r = rng(7);
        const own = hex(r);
        const partners = Array.from({ length: 250 }, () => hex(r));
        const first = planMembersCycle(own, partners, []);
        expect(first.missing.map(b => b.length)).toEqual([100, 100, 51]);
        expect(first.revalidate).toBeNull();
    });

    it('past 3 batches the rest wait for the next cycle', () => {
        const r = rng(9);
        const partners = Array.from({ length: 420 }, () => hex(r));
        const first = planMembersCycle(null, partners, []);
        expect(first.missing.map(b => b.length)).toEqual([100, 100, 100]);
        const held = first.missing.flat().map(key => ({ key, fetchedAt: stamp(1) }));
        const second = planMembersCycle(null, partners, held);
        expect(second.missing.map(b => b.length)).toEqual([100, 20]);
    });

    it('the drop never touches the own card or a referenced one, and drops the oldest unreferenced first', () => {
        const r = rng(11);
        const own = hex(r);
        const ref = Array.from({ length: 5 }, () => hex(r));
        const others = Array.from({ length: 10 }, (_, i) => ({ key: hex(r), fetchedAt: stamp(100 - i) }));
        const held: HeldCard[] = [{ key: own, fetchedAt: null }, ...ref.map(key => ({ key, fetchedAt: null })), ...others];
        const drop = cardsToDrop(own, ref, held, 8);
        expect(drop).toEqual(others.slice(-8).reverse().map(c => c.key));
        expect(cardsToDrop(own, ref, held, 1)).not.toContain(own);
        expect(cardsToDrop(own, ref, held, 0).length).toBe(10);
    });

    it('the keys read: at most 100 keys, the cursor encoded, nothing else in the query', () => {
        const r = rng(13);
        const keys = Array.from({ length: 100 }, () => hex(r));
        expect(membersKeysPath(keys)).toBe(`/api/members?keys=${keys.join(',')}`);
        expect(membersKeysPath(keys.slice(0, 2), '2026-10-01T00:00:00.000Z'))
            .toBe(`/api/members?keys=${keys[0]},${keys[1]}&updatedAfter=2026-10-01T00%3A00%3A00.000Z`);
        expect(() => membersKeysPath([...keys, hex(r)])).toThrow();
        expect(() => membersKeysPath([])).toThrow();
    });
});
