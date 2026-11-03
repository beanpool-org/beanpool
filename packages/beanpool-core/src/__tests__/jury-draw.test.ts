import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
    JURY_DRAW_DOMAIN, checkJuryDraw, juryDraw, juryPasses, juryRosterHash, juryRuleFor, jurySnapshotAt, jurySnapshotDate,
} from '../jury-draw.js';

// The removal jury's draw (DESIGN-removal-jury-fable.md §3, §5; slice J1): same inputs, same jury; one key changed, another;
// and a fixed 120-key pool gives a known jury, worked out here a second way, with node's own SHA-256 from the written rule,
// so the draw is what anyone recomputing it from the rule gets, not only what this code says.
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const key = (n: number) => sha(`jury fixture key ${n}`);
const POOL = Array.from({ length: 120 }, (_, i) => key(i));
const SUBJECT = sha('jury fixture subject');
const DATE = '2026-10-29';

/** The rule as the design writes it, with nothing from the module under test. */
function byTheRule(pool: string[], subject: string, date: string, size: number, aside: Set<string> = new Set()) {
    const sorted = [...new Set(pool)].sort();
    const rosterHash = sha(sorted.join('\n'));
    const seed = sha(['beanpool-jury-v1', subject, rosterHash, date].join('\n'));
    const order = sorted.map(k => ({ k, r: sha(`${seed}\n${k}`) })).sort((a, b) => (a.r < b.r ? -1 : 1)).map(x => x.k);
    const jury: string[] = [];
    const stoodAside: string[] = [];
    for (const k of order) {
        if (jury.length >= size) break;
        (aside.has(k) ? stoodAside : jury).push(k);
    }
    return { rosterHash, seed, order, jury, stoodAside };
}

describe('juryDraw — the removal jury, drawn by nobody', () => {
    it('same inputs give the same jury, whatever order the pool comes in', () => {
        const a = juryDraw({ pool: POOL, subject: SUBJECT, snapshotDate: DATE, size: 12 });
        const b = juryDraw({ pool: [...POOL].reverse().concat(POOL.slice(0, 5)), subject: SUBJECT, snapshotDate: DATE, size: 12 });
        expect(a.jury).toHaveLength(12);
        expect(b).toEqual(a);
        expect(a.poolSize).toBe(120);
    });

    it('one key changed in the pool gives a different hash and a different jury', () => {
        const a = juryDraw({ pool: POOL, subject: SUBJECT, snapshotDate: DATE, size: 12 });
        const changed = [...POOL.slice(0, 119), key(999)];
        const b = juryDraw({ pool: changed, subject: SUBJECT, snapshotDate: DATE, size: 12 });
        expect(b.rosterHash).not.toBe(a.rosterHash);
        expect(b.jury).not.toEqual(a.jury);
    });

    it('another subject, or another day, draws another jury from the same pool', () => {
        const a = juryDraw({ pool: POOL, subject: SUBJECT, snapshotDate: DATE, size: 12 });
        expect(juryDraw({ pool: POOL, subject: key(500), snapshotDate: DATE, size: 12 }).jury).not.toEqual(a.jury);
        expect(juryDraw({ pool: POOL, subject: SUBJECT, snapshotDate: '2026-10-30', size: 12 }).jury).not.toEqual(a.jury);
    });

    it('a 120-key fixture gives a known jury: the rule worked out independently, and its first three pinned', () => {
        const drawn = juryDraw({ pool: POOL, subject: SUBJECT, snapshotDate: DATE, size: 12 });
        const rule = byTheRule(POOL, SUBJECT, DATE, 12);
        expect(JURY_DRAW_DOMAIN).toBe('beanpool-jury-v1');
        expect(drawn.rosterHash).toBe(rule.rosterHash);
        expect(drawn.seed).toBe(rule.seed);
        expect(drawn.order).toEqual(rule.order);
        expect(drawn.jury).toEqual(rule.jury);
        // Pinned, so a change to the rule (or to how a key is written) fails here even if both sides changed with it.
        expect(drawn.rosterHash).toBe(PINNED.rosterHash);
        expect(drawn.jury.slice(0, 3).map(k => POOL.indexOf(k))).toEqual(PINNED.firstThree);
    });

    it('a member who stands aside is passed over and the next one seated: the roll is the head of the order', () => {
        const plain = juryDraw({ pool: POOL, subject: SUBJECT, snapshotDate: DATE, size: 12 });
        const aside = new Set([plain.order[0], plain.order[4]]);
        const drawn = juryDraw({ pool: POOL, subject: SUBJECT, snapshotDate: DATE, size: 12, standsAside: k => aside.has(k) });
        expect(drawn.stoodAside).toEqual([plain.order[0], plain.order[4]]);
        expect(drawn.jury).toEqual(plain.order.slice(0, 14).filter(k => !aside.has(k)));
        expect(drawn).toMatchObject(byTheRule(POOL, SUBJECT, DATE, 12, aside));
    });

    it('a pool too small seats everyone it can', () => {
        const drawn = juryDraw({ pool: POOL.slice(0, 5), subject: SUBJECT, snapshotDate: DATE, size: 12, standsAside: k => k === POOL[0] });
        expect(drawn.jury).toHaveLength(4);
        expect(drawn.stoodAside).toEqual([POOL[0]]);
    });
});

describe('checkJuryDraw — what a member recomputes', () => {
    const drawn = juryDraw({ pool: POOL, subject: SUBJECT, snapshotDate: DATE, size: 12, standsAside: k => k === POOL[7] || k === POOL[8] });
    const roll = [...drawn.jury, ...drawn.stoodAside];

    it('the pool and roll the node recorded check out', () => {
        expect(checkJuryDraw({ pool: POOL, subject: SUBJECT, snapshotDate: DATE, rosterHash: drawn.rosterHash, roll })).toEqual({ ok: true });
    });
    it('a pool with a name missing or added fails on the hash', () => {
        expect(checkJuryDraw({ pool: POOL.slice(1), subject: SUBJECT, snapshotDate: DATE, rosterHash: drawn.rosterHash })).toEqual({ ok: false, problem: 'hash' });
        expect(checkJuryDraw({ pool: [...POOL, key(777)], subject: SUBJECT, snapshotDate: DATE, rosterHash: drawn.rosterHash })).toEqual({ ok: false, problem: 'hash' });
    });
    it('a juror swapped for someone further down the order fails on the order', () => {
        const later = drawn.order.find(k => !roll.includes(k))!;
        const swapped = [...roll.slice(1), later];
        expect(checkJuryDraw({ pool: POOL, subject: SUBJECT, snapshotDate: DATE, rosterHash: drawn.rosterHash, roll: swapped })).toEqual({ ok: false, problem: 'order' });
    });
});

describe('the jury rule and the snapshot', () => {
    it('12 jurors below 1,000 in the pool, 18 from 1,000', () => {
        expect(juryRuleFor(100)).toEqual({ size: 12, mustVote: 9, minYes: 6 });
        expect(juryRuleFor(999)).toEqual({ size: 12, mustVote: 9, minYes: 6 });
        expect(juryRuleFor(1000)).toEqual({ size: 18, mustVote: 13, minYes: 9 });
    });
    it('6 of 9 removes, 5 of 9 does not, 8 votes is too few, and a tie fails', () => {
        const twelve = juryRuleFor(150);
        expect(juryPasses(6, 3, twelve)).toBe(true);
        expect(juryPasses(5, 4, twelve)).toBe(false);
        expect(juryPasses(8, 0, twelve)).toBe(false);
        expect(juryPasses(6, 6, twelve)).toBe(false);
        expect(juryPasses(8, 4, twelve)).toBe(true);
        expect(juryPasses(7, 4, twelve)).toBe(false);
        const eighteen = juryRuleFor(2000);
        expect(juryPasses(9, 4, eighteen)).toBe(true);
        expect(juryPasses(8, 4, eighteen)).toBe(false);
    });
    it('the snapshot is 00:00 UTC of the day the pause is made', () => {
        const at = Date.parse('2026-10-29T23:59:59.000Z');
        expect(jurySnapshotDate(at)).toBe('2026-10-29');
        expect(jurySnapshotAt('2026-10-29')).toBe(Date.parse('2026-10-29T00:00:00.000Z'));
        expect(jurySnapshotAt('29 Oct')).toBeNaN();
        expect(juryRosterHash([])).toBe(sha(''));
    });
});

const PINNED = { rosterHash: 'bd1801b340bc484bd0ef923e07a7572ce22d917777c813d57a041f797bd52233', firstThree: [97, 47, 31] };
