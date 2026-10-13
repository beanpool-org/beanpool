/**
 * §4 amendment 2 (DESIGN-group-history-after-rekey-fable.md; confirmation 1 of #1844, finding 1): once this phone first saw
 * "Catp" on her honest key C1, Zed's key Z never counts as one "Catp" had, whatever order of rosters the node serves.
 *
 * The node holds the misled new phone's key C2 and a puppet's P, never C1 nor Z. A chain link is the newer key's signature
 * over the older, so it can serve any linear chain whose links C2 or P signed, and none that C1 or Z signed. The walk:
 * every sequence of 3 rosters over 28 shapes (Zed in or out), every pair over all 70, and 1,000 seeded random paths of 6.
 * The chains are verified for real, once per row (each row object is reused across the walk, so it is memoised by identity).
 */
import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}) } }));
vi.mock('../group-chat-crypto', async (importOriginal) => {
    const real = await importOriginal<typeof import('../group-chat-crypto')>();
    const verified = new WeakMap<object, string[]>();
    return {
        ...real,
        verifiedFormerKeys: (row: Parameters<typeof real.verifiedFormerKeys>[0]) => {
            if (!verified.has(row)) verified.set(row, real.verifiedFormerKeys(row));
            return [...verified.get(row)!];
        },
    };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { noteRosterNames, keysThisPhoneKnewFor, type NameKeyMemory, type MemoryRosterRow } from '../name-key-memory';
import { makeKeySuccession, type FormerKey } from '../group-chat-crypto';

const person = () => { const seed = randomBytes(32); return { seedHex: bytesToHex(seed), pub: bytesToHex(ed25519.getPublicKey(seed)) }; };
/** `by` signs that `old` was its key: a claim, which proves only that `by` makes it. */
const link = (by: { seedHex: string }, old: string): FormerKey => {
    const s = makeKeySuccession({ newEdPrivHex: by.seedHex, oldPubHex: old, at: '2026-10-13T04:00:00.000Z' });
    return { pubkey: s.pubkey, at: s.at, sig: s.sig };
};

describe('§4 amendment 2: every order of rosters the node can build with the keys it holds', () => {
    const c1 = person();
    const c2 = person();
    const z = person();
    const p = person();
    const o = person(); // another member, so a roster can carry C1 under another name
    const chainsFor = (k: typeof c2, other: typeof p): FormerKey[][] => [
        [], [link(k, c1.pub)], [link(k, z.pub)], [link(k, other.pub)],
        [link(k, other.pub), link(other, c1.pub)], [link(k, other.pub), link(other, z.pub)],
    ];
    const rowOptions: { key: string; chain: FormerKey[]; label: string }[] = [
        { key: c1.pub, chain: [], label: 'C1' },
        { key: z.pub, chain: [], label: 'Z' },
        ...chainsFor(c2, p).map((chain, i) => ({ key: c2.pub, chain, label: `C2/${i}` })),
        ...chainsFor(p, c2).map((chain, i) => ({ key: p.pub, chain, label: `P/${i}` })),
    ];
    const extras = [
        { label: '', rows: [] as MemoryRosterRow[] },
        { label: '+Zed', rows: [{ memberPubkey: z.pub, callsign: 'Zedp' }] },
        { label: '+C1other', rows: [{ memberPubkey: c1.pub, callsign: 'Other' }] },
        { label: '+Zed+C1other', rows: [{ memberPubkey: z.pub, callsign: 'Zedp' }, { memberPubkey: c1.pub, callsign: 'Other' }] },
        { label: '+dup', rows: [{ memberPubkey: o.pub, callsign: 'Catp' }] },
    ];
    const rosters = rowOptions.flatMap((r) => extras.map((e) => ({ label: `${r.label}${e.label}`, roster: [{ memberPubkey: r.key, callsign: 'Catp', formerKeys: r.chain }, ...e.rows] })));
    /** What keysThisPhoneKnewFor reads out of an entry, mirrored so the walk stays synchronous (checked against it below). */
    const zCounts = (m: NameKeyMemory): boolean => {
        const s = m.catp;
        if (!s) return false;
        return [...(s.changedFrom ? [] : [s.key]), ...(s.was ?? []), ...(s.changedFrom ? [s.changedFrom] : [])].includes(z.pub);
    };

    it('from a first honest sighting on C1, Zed\'s key never counts', async () => {
        const start = noteRosterNames({}, [{ memberPubkey: c1.pub, callsign: 'Catp' }]).memory;
        expect(start.catp).toEqual({ key: c1.pub });
        let visited = 0;
        const bad: string[] = [];
        const walk = (shapes: typeof rosters, memory: NameKeyMemory, path: string[], depth: number) => {
            for (const r of shapes) {
                const next = noteRosterNames(memory, r.roster).memory;
                visited++;
                if (zCounts(next)) bad.push([...path, r.label].join(' → '));
                if (depth > 1) walk(shapes, next, [...path, r.label], depth - 1);
            }
        };
        walk(rosters.filter((r) => !/\+C1other|\+dup/.test(r.label)), start, [], 3);
        walk(rosters, start, [], 2);
        let seed = 12345;
        const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        for (let i = 0; i < 1_000; i++) {
            let memory = start;
            const path: string[] = [];
            for (let d = 0; d < 6; d++) {
                const r = rosters[Math.floor(rnd() * rosters.length)];
                memory = noteRosterNames(memory, r.roster).memory;
                path.push(r.label);
                visited++;
                if (zCounts(memory)) { bad.push(path.join(' → ')); break; }
            }
        }
        // The real reader agrees with the mirror, on the break's end state and on a plain one.
        const breakEnd = [rosters.find((r) => r.label === 'P/1')!, rosters.find((r) => r.label === 'Z')!, rosters.find((r) => r.label === 'C2/5')!]
            .reduce((m, r) => noteRosterNames(m, r.roster).memory, start);
        for (const m of [breakEnd, noteRosterNames(start, rosters[7].roster).memory]) {
            vi.mocked(AsyncStorage.getItem).mockResolvedValueOnce(JSON.stringify(m));
            expect((await keysThisPhoneKnewFor('https://n.example', 'Catp', c2.pub)).includes(z.pub)).toBe(zCounts(m));
        }
        console.log(`MEASURED WALK: ${rosters.length} roster shapes, ${visited} states; Zed's key counted in ${bad.length}${bad.length ? `:\n  ${[...new Set(bad)].slice(0, 20).join('\n  ')}` : ''}`);
        expect(visited).toBeGreaterThan(33_000);
        expect(bad).toEqual([]);
    }, 120_000);
});
