/**
 * Name suggestions for a taken name (utils/callsign-suggest.ts): never longer than the caller will send, so a
 * suggestion is joined with exactly as it was checked and shown. The global community's join keeps 20
 * characters (global-join.ts MAX_JOIN_NAME); a longer suggestion was cut after it was checked, and for a long
 * enough name the cut gave back the very name that was taken.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null) },
}));

const signedGet = vi.fn(async (url: string, path: string, identity: { publicKey: string }) => {
    signedAsked.push({ url: `${url}${path}`, by: identity.publicKey });
    return { ok: true, json: async () => ({ available: true }) } as unknown as Response;
});
const signedAsked: Array<{ url: string; by: string }> = [];
vi.mock('../node-post', () => ({ signedGet: (...a: [string, string, { publicKey: string }]) => signedGet(...a) }));

import { suggestionFor, suggestCallsigns, checkCallsignAvailable } from '../callsign-suggest';

const NODE = 'https://global.beanpool.org';
const originalFetch = globalThis.fetch;

/** A node on which every name is free; records the names it was asked about. */
function everyNameFree(): string[] {
    const asked: string[] = [];
    globalThis.fetch = vi.fn(async (input: any) => {
        const url = String(input);
        const name = decodeURIComponent(url.split('/api/members/callsign-available/')[1].split('?')[0]);
        asked.push(name);
        return { ok: true, json: async () => ({ available: true }) } as unknown as Response;
    }) as any;
    return asked;
}

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe('suggestionFor', () => {
    it('a name with room keeps all of it', () => {
        expect(suggestionFor('Sam', 'Fox', 20)).toBe('Sam Fox');
    });

    it('a name without room gives way, and the word stays whole', () => {
        expect(suggestionFor('Sarah Jane Smithson', 'Juniper', 20)).toBe('Sarah Jane Juniper');
        expect(suggestionFor('Sarah Jane Smithson', 'Fox', 20)).toBe('Sarah Jane Fox');
        expect(suggestionFor('Christopher Lee', 'Juniper', 20)).toBe('Christopher Juniper');
        expect(suggestionFor('Maximilianus Augusto', 'Sparrow', 20)).toBe('Maximilianus Sparrow');
        // One long word has nowhere to cut but inside it.
        expect(suggestionFor('Bartholomewsson', 'Juniper', 20)).toBe('Bartholomews Juniper');
        for (const base of ['Sarah Jane Smithson', 'Christopher Lee', 'Maximilianus Augusto', 'Bartholomewsson']) {
            for (const word of ['Fox', 'Juniper', 'Sparrow']) {
                const s = suggestionFor(base, word, 20);
                expect(s.length).toBeLessThanOrEqual(20);
                expect(s.endsWith(` ${word}`)).toBe(true);
            }
        }
    });

    it('without a limit it is 32, the invite join\'s name field', () => {
        expect(suggestionFor('Christopher Lee', 'Juniper')).toBe('Christopher Lee Juniper');
        expect(suggestionFor('A'.repeat(30), 'Fox').length).toBeLessThanOrEqual(32);
    });
});

describe('suggestCallsigns with a limit', () => {
    it('every suggestion fits, and is the very name the node was asked about', async () => {
        const asked = everyNameFree();
        const suggestions = await suggestCallsigns('Sarah Jane Smithson', 3, NODE, 20);
        expect(suggestions).toHaveLength(3);
        for (const s of suggestions) {
            expect(s.length).toBeLessThanOrEqual(20);
            expect(asked).toContain(s);
            // Never the taken name back: the cut used to trim a long suggestion down to the name itself.
            expect(s).not.toBe('Sarah Jane Smithson');
        }
        expect(asked.every(name => name.length <= 20)).toBe(true);
    });
});

describe('the name check names no key in its address (public-routes audit NEW-2)', () => {
    const me = { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32) } as any;

    it("a member's check is signed by their own key, which the node reads as whose name it is; no ?exclude= is sent", async () => {
        signedAsked.length = 0;
        const plain = everyNameFree();
        expect(await checkCallsignAvailable('Sarah', NODE, { signer: me })).toBe('available');
        expect(signedAsked).toEqual([{ url: `${NODE}/api/members/callsign-available/Sarah`, by: me.publicKey }]);
        expect(plain).toEqual([]);
        expect(await suggestCallsigns('Sarah', 3, NODE, 32, { signer: me })).toHaveLength(3);
        expect(signedAsked.every((a) => a.by === me.publicKey && !a.url.includes('?'))).toBe(true);
    });

    it('without a signer it is a plain request, with nothing after the name', async () => {
        const urls: string[] = [];
        globalThis.fetch = vi.fn(async (input: any) => {
            urls.push(String(input));
            return { ok: true, json: async () => ({ available: false }) } as unknown as Response;
        }) as any;
        expect(await checkCallsignAvailable('Sarah', NODE)).toBe('taken');
        expect(urls).toEqual([`${NODE}/api/members/callsign-available/Sarah`]);
    });
});
