/**
 * One community, several addresses, slice S0: every kept-versus-offered pair -> keep / replace / refuse.
 *
 * The rows are in vectors/address-list.json, the file the server's and the phone's suites read too. This test runs each
 * row through chooseAddressList, and holds the file itself to the rule written out below, so a row can neither go missing
 * nor drift from the rule unseen:
 *
 * - every key (the community's, another's) x community id (the same, another) x epoch (older, equal, newer than kept)
 *   x seq (older, equal, newer) x content (the same, other) has exactly one row;
 * - with nothing kept: the community's list, another key's, another community id with and without one known;
 * - every malformed or badly signed list in the file, both with a list kept and with none;
 * - every address spelling in the file, as the only address of an otherwise good newer list.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseAddressList, checkAddressList, readAddressList, type SignedAddressList } from '../address-list.js';

const VECTORS = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../vectors/address-list.json'), 'utf8'));

type Expect = { action: 'keep' | 'replace' | 'refuse'; why: string };
interface Row {
    name: string;
    kept: string | null;
    offered: string;
    peerId: 'community' | 'other';
    communityId?: string;
    expect: Expect;
    coords: Record<string, string>;
}
const ROWS = VECTORS.table as Row[];
const LISTS = VECTORS.lists as Record<string, { doc: unknown }>;

// The rule, as the design states it (§2.2 "Order is (epoch, seq)", §7 "takes nothing lower"), written out by hand.
const ORDER = ['older', 'equal', 'newer'] as const;
type Step = (typeof ORDER)[number];
const GRID: Record<Step, Record<Step, (content: 'same' | 'other') => Expect>> = {
    older: { older: () => keep('older'), equal: () => keep('older'), newer: () => keep('older') },
    equal: { older: () => keep('older'), equal: (c) => keep(c === 'same' ? 'same' : 'conflict'), newer: () => replace('newer') },
    newer: { older: () => replace('newer'), equal: () => replace('newer'), newer: () => replace('newer') },
};
function keep(why: string): Expect { return { action: 'keep', why }; }
function replace(why: string): Expect { return { action: 'replace', why }; }
function refuse(why: string): Expect { return { action: 'refuse', why }; }

function ruleFor(c: Record<string, string>): Expect {
    if (c.key === 'other') return refuse('other-key');
    if (c.community === 'other') return refuse('other-community');
    return GRID[c.epoch as Step][c.seq as Step](c.content as 'same' | 'other');
}

describe('the file is the whole table', () => {
    it('has exactly one row for every key x community x epoch x seq x content', () => {
        const grid = ROWS.filter((r) => r.coords.epoch !== undefined);
        const seen = new Set(grid.map((r) => JSON.stringify([r.coords.key, r.coords.community, r.coords.epoch, r.coords.seq, r.coords.content])));
        expect(seen.size).toBe(grid.length);
        for (const key of ['same', 'other']) for (const community of ['same', 'other']) for (const epoch of ORDER) for (const seq of ORDER) for (const content of ['same', 'other']) {
            expect(seen.has(JSON.stringify([key, community, epoch, seq, content])), `${key} ${community} ${epoch} ${seq} ${content}`).toBe(true);
        }
        expect(grid.length).toBe(2 * 2 * 3 * 3 * 2);
    });

    it('holds every grid row to the rule written out above', () => {
        for (const r of ROWS.filter((row) => row.coords.epoch !== undefined)) expect([r.name, r.expect]).toEqual([r.name, ruleFor(r.coords)]);
    });

    it('has a row for every malformed and badly signed list, kept and not', () => {
        const broken = Object.keys(LISTS).filter((k) => k.startsWith('malformed: ') || k.startsWith('bad signature: '));
        expect(broken.length).toBeGreaterThan(60);
        for (const name of broken) {
            const rows = ROWS.filter((r) => r.offered === name);
            expect(rows.map((r) => r.kept === null).sort(), name).toEqual([false, true]);
            for (const r of rows) expect(r.expect, name).toEqual(refuse(name.startsWith('malformed: ') ? 'malformed' : 'bad-signature'));
        }
    });

    it('has a row for every address spelling, and only the one spelling of a listable address is taken', () => {
        const spellings = VECTORS.spellings as { input: string; address: string | null; listed?: boolean }[];
        for (const s of spellings) {
            const rows = ROWS.filter((r) => r.coords.spelling === s.input);
            expect(rows.length, JSON.stringify(s.input)).toBe(1);
            const taken = s.address !== null && s.input === s.address && s.listed === true;
            expect(rows[0].expect, JSON.stringify(s.input)).toEqual(taken ? replace('newer') : refuse('malformed'));
        }
        // Not a token row: names, numbers and IPv6, in both outcomes.
        const taken = ROWS.filter((r) => r.coords.spelling !== undefined && r.expect.action === 'replace');
        expect(taken.length).toBeGreaterThan(20);
        expect(ROWS.filter((r) => r.coords.spelling !== undefined && r.expect.action === 'refuse').length).toBeGreaterThan(60);
    });

    it('covers nothing kept yet', () => {
        const none = ROWS.filter((r) => r.kept === null && r.coords.kept === 'none' && !r.coords.malformed && !r.coords.badSignature);
        expect(none.map((r) => `${r.coords.key}/${r.coords.community} -> ${r.expect.action} ${r.expect.why}`).sort()).toEqual([
            'other/same -> refuse other-key',
            'other/unknown -> refuse other-key',
            'same/other -> refuse other-community',
            'same/same -> replace first',
            'same/unknown -> replace first',
            'same/unknown -> replace first',
            'same/unknown -> replace first',
        ]);
    });
});

describe('kept versus offered', () => {
    it.each(ROWS.map((r) => [r.name, r] as const))('%s', (_name, r) => {
        const kept = r.kept === null ? null : readAddressList(LISTS[r.kept].doc);
        if (r.kept !== null) expect(kept, `kept list ${r.kept} reads`).not.toBeNull();
        const offered = LISTS[r.offered].doc;
        const choice = chooseAddressList(offered, { peerId: VECTORS.keys[r.peerId].peerId, kept, communityId: r.communityId });
        expect({ action: choice.action, why: choice.why }).toEqual(r.expect);
        if (choice.action === 'replace') {
            expect(choice.signed).toEqual(offered);
        }
        // The plain read agrees with the table on what is a list at all.
        const check = checkAddressList(offered);
        if (r.expect.why === 'malformed' || r.expect.why === 'bad-signature') {
            expect(check).toEqual({ ok: false, why: r.expect.why });
            expect(readAddressList(offered)).toBeNull();
        } else {
            expect(check.ok).toBe(true);
        }
    });

    it('throws when the list said to be kept is another key\'s: a caller\'s mistake, never a verdict', () => {
        const other = readAddressList(LISTS['first other key'].doc) as SignedAddressList;
        expect(other).not.toBeNull();
        expect(() => chooseAddressList(LISTS.kept.doc, { peerId: VECTORS.keys.community.peerId, kept: other })).toThrow();
        expect(() => chooseAddressList(LISTS.kept.doc, { peerId: 'nobody', kept: null })).toThrow();
    });
});
