/**
 * The web line checks the proof (several addresses S6, design §4, §7): the web app names the main address only once the
 * main has proved itself this community from this browser. Real signed lists and proofs, with core's shared test keys
 * (packages/beanpool-core/vectors/address-list.json); the network is a table of answers.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    addressProofBytes, ed25519Signer, signAddressList, signAddressProof, type AddressListFields, type SignedAddressList,
} from '@beanpool/core';
import { hereListUrl, provedMainAddress, type PublicRead } from './main-address-proof';
import { provedNotice } from './former-address';

const VECTORS = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packages/beanpool-core/vectors/address-list.json'), 'utf8'));
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const KEY = {
    community: { peerId: VECTORS.keys.community.peerId as string, sign: ed25519Signer(hex(VECTORS.keys.community.seedHex)) },
    other: { peerId: VECTORS.keys.other.peerId as string, sign: ed25519Signer(hex(VECTORS.keys.other.seedHex)) },
};

const MAIN = 'coop.example.org';
const HERE = 'riverside.beanpool.org';
const base: AddressListFields = { peerId: KEY.community.peerId, communityId: 'riverside', epoch: 1, seq: 10, main: MAIN, addresses: [MAIN, HERE], spares: [] };
const list = (over: Partial<AddressListFields> = {}, key: keyof typeof KEY = 'community') => signAddressList({ ...base, peerId: KEY[key].peerId, ...over }, KEY[key].sign);

interface Net {
    here?: SignedAddressList | unknown | null;
    hereStatus?: number;
    main?: SignedAddressList | unknown | null;
    /** How the main address answers a proof question: by default, the community's key for exactly that question. */
    proof?: (q: { for: string; nonce: string }) => Promise<[number, unknown]>;
    mainAt?: string;
}

/** The answers: this address's list at the page's path, the main's list and proof at https://<main>/…; anything else, nothing. */
function network(net: Net): { read: PublicRead; asked: string[] } {
    const asked: string[] = [];
    const mainAt = net.mainAt ?? MAIN;
    const read: PublicRead = async (url) => {
        asked.push(url);
        if (url === '/api/node/addresses') return net.here === null ? null : { status: net.hereStatus ?? 200, json: net.here };
        if (url === `https://${mainAt}/api/node/addresses`) return net.main === null ? null : { status: 200, json: net.main };
        if (url.startsWith(`https://${mainAt}/api/node/proof?`)) {
            const q = new URL(url).searchParams;
            const question = { for: q.get('for') ?? '', nonce: q.get('nonce') ?? '' };
            const [status, json] = net.proof ? await net.proof(question) : [200, await signAddressProof({ list: { v: 1, ...base, main: mainAt, addresses: [mainAt, HERE].sort() }, ...question }, KEY.community.sign)];
            return { status, json };
        }
        return null;
    };
    return { read, asked };
}

/** A proof the community's key signs for `q`, at the list `fields` names. */
const proofFor = (q: { for: string; nonce: string }, fields: AddressListFields = base) => signAddressProof({ list: { v: 1, ...fields }, ...q }, KEY.community.sign);

describe('provedMainAddress: the main is named only once it proves itself this community', () => {
    it('this address listed, the main\'s own list by the same key and number, and a fresh proof for this question: the main', async () => {
        const net = network({ here: await list(), main: await list() });
        expect(await provedMainAddress(HERE, '/api/node/addresses', net.read)).toEqual({ ok: true, main: MAIN, here: HERE, onList: true });
        // The question carries this browser's own nonce, and only public reads go: this address's list, the main's, its proof.
        expect(net.asked).toHaveLength(3);
        expect(net.asked[2]).toMatch(new RegExp(`^https://${MAIN.replace(/\./g, '\\.')}/api/node/proof\\?for=${MAIN.replace(/\./g, '\\.')}&nonce=[0-9a-f]{32}$`));
    });

    it('at the main itself: nothing to say, and the main is not asked', async () => {
        const net = network({ here: await list(), main: await list() });
        expect(await provedMainAddress(MAIN, '/api/node/addresses', net.read)).toEqual({ ok: false, why: 'at-main' });
        expect(net.asked).toHaveLength(1);
    });

    it('a main after a take-over (a higher epoch) is followed: its list beats every list from before it', async () => {
        const newer = { ...base, epoch: 2, seq: 3 };
        const net = network({ here: await list(), main: await list({ epoch: 2, seq: 3 }), proof: async (q) => [200, await proofFor(q, newer)] });
        expect(await provedMainAddress(HERE, '/api/node/addresses', net.read)).toMatchObject({ ok: true, main: MAIN });
    });

    it('a main on a port of its own: asked there, and named with it', async () => {
        const ported = 'coop.example.org:8443';
        const fields = { ...base, main: ported, addresses: [ported, HERE].sort() };
        const net = network({ mainAt: ported, here: await list({ main: ported, addresses: fields.addresses }), main: await list({ main: ported, addresses: fields.addresses }), proof: async (q) => [200, await proofFor(q, fields)] });
        expect(await provedMainAddress(HERE, '/api/node/addresses', net.read)).toMatchObject({ ok: true, main: ported });
    });

    // The cases, each by name (design §7): anything that is not the community's own key, proving now, is no line.
    const forgedHere = async () => ({ ...(await list()), sig: (await list({}, 'other')).sig });
    const tampered = async () => { const l = await list(); return { ...l, list: { ...l.list, main: HERE } }; };
    it.each([
        ['this address serves no list (a replaced server signs none: 503)', async (): Promise<Net> => ({ here: { error: 'replaced' }, hereStatus: 503, main: await list() }), 'no-list-here'],
        ['this address could not be asked', async (): Promise<Net> => ({ here: null, main: await list() }), 'no-list-here'],
        ['this address\'s list is forged (another key\'s signature under the community\'s key)', async (): Promise<Net> => ({ here: await forgedHere(), main: await list() }), 'forged-here'],
        ['this address\'s list was changed after it was signed', async (): Promise<Net> => ({ here: await tampered(), main: await list() }), 'forged-here'],
        ['the main serves no list', async (): Promise<Net> => ({ here: await list(), main: null }), 'no-list-at-main'],
        ['the main\'s list is forged', async (): Promise<Net> => ({ here: await list(), main: await forgedHere() }), 'forged-at-main'],
        ['the main answers with another key (the address is in other hands, or the server was replaced)', async (): Promise<Net> => ({ here: await list(), main: await list({}, 'other') }), 'other-key'],
        ['the main answers as the same key for another community', async (): Promise<Net> => ({ here: await list(), main: await list({ communityId: 'elsewhere' }) }), 'other-community'],
        ['the main serves an older take-over count (an older server of the community)', async (): Promise<Net> => ({ here: await list(), main: await list({ epoch: 0, seq: 99 }) }), 'older'],
        ['the main serves an older list at the same count', async (): Promise<Net> => ({ here: await list(), main: await list({ seq: 9 }) }), 'older'],
        ['the main\'s own list names another main', async (): Promise<Net> => ({ here: await list(), main: await list({ seq: 11, main: HERE }) }), 'main-moved'],
        ['the main refuses the proof (421)', async (): Promise<Net> => ({ here: await list(), main: await list(), proof: async () => [421, { error: 'not listed' }] }), 'no-proof'],
        ['the proof is another key\'s signature', async (): Promise<Net> => ({
            here: await list(), main: await list(),
            proof: async (q) => {
                const fields = { for: q.for, nonce: q.nonce, epoch: 1, seq: 10, ts: 1794787200 };
                const sig = await KEY.other.sign(addressProofBytes(fields));
                return [200, { peerId: KEY.community.peerId, ...fields, sig: Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('') }];
            },
        }), 'proof-refused'],
        ['the proof answers an older question (replayed: another nonce)', async (): Promise<Net> => ({
            here: await list(), main: await list(), proof: async (q) => [200, await proofFor({ for: q.for, nonce: 'ab'.repeat(16) === q.nonce ? 'cd'.repeat(16) : 'ab'.repeat(16) })],
        }), 'proof-refused'],
        ['the proof is for another address', async (): Promise<Net> => ({ here: await list(), main: await list(), proof: async (q) => [200, await proofFor({ for: HERE, nonce: q.nonce })] }), 'proof-refused'],
        ['the proof names a newer list than the main served', async (): Promise<Net> => ({ here: await list(), main: await list(), proof: async (q) => [200, await proofFor(q, { ...base, seq: 11 })] }), 'proof-number'],
    ])('%s: no line', async (_name, setup, why) => {
        const net = network(await setup());
        expect(await provedMainAddress(HERE, '/api/node/addresses', net.read)).toEqual({ ok: false, why });
    });

    it('never throws: a read that throws is no line', async () => {
        const read: PublicRead = async () => { throw new Error('offline'); };
        expect(await provedMainAddress(HERE, '/api/node/addresses', read)).toMatchObject({ ok: false });
    });

    it('this server\'s list is read where the page reaches it: the detached node\'s, else this page\'s own', () => {
        expect(hereListUrl('')).toBe('/api/node/addresses');
        expect(hereListUrl('https://riverside.example:8443/')).toBe('https://riverside.example:8443/api/node/addresses');
    });
});

describe('provedNotice: what the line says, from the proof alone', () => {
    it('names the main the proof names, with a plain link that carries nothing of this address', () => {
        expect(provedNotice('main', { ok: true, main: MAIN, here: HERE, onList: true })).toEqual({ primaryAddress: MAIN, href: `https://${MAIN}/` });
        expect(provedNotice('former', { ok: true, main: 'coop.example.org:8443', here: 'old.example.org', onList: false })).toEqual({ primaryAddress: 'coop.example.org:8443', href: 'https://coop.example.org:8443/' });
    });

    it('nothing when the main has not proved, at a non-main address the list does not name, or for a home-network main', () => {
        expect(provedNotice('main', { ok: false, why: 'other-key' })).toBeNull();
        expect(provedNotice('former', { ok: false, why: 'older' })).toBeNull();
        expect(provedNotice('main', { ok: true, main: MAIN, here: 'elsewhere.example.org', onList: false })).toBeNull();
        expect(provedNotice('main', { ok: true, main: '192.168.1.20', here: HERE, onList: true })).toBeNull();
    });
});
