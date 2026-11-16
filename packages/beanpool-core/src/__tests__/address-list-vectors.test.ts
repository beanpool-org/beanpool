/**
 * One community, several addresses, slice S0: the frozen vectors in vectors/address-list.json against the code. The
 * server's and the phone's suites read the same file when their slices land (S2, S4), so the three runtimes agree on the
 * one spelling of an address, the bytes of the signed list and of the proof, and the proof's verdicts.
 *
 * The kept-versus-offered table is address-list-table.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
    ADDRESS_LIST_MAX,
    ADDRESS_LIST_PATH,
    ADDRESS_PROOF_PATH,
    ADDRESS_SPARES_MAX,
    addressListBytes,
    addressListText,
    addressListUrl,
    addressOf,
    addressProofBytes,
    addressProofRefusal,
    addressProofText,
    addressProofUrl,
    checkAddressList,
    compareAddressNumbers,
    isAddress,
    isListableAddress,
    newAddressProofNonce,
    readAddressList,
    sameAddressListContent,
    signAddressList,
    signAddressProof,
    verifyAddressProof,
    type AddressList,
    type AddressListFields,
} from '../address-list.js';
import { nodeHomeOf } from '../node-request-signing.js';
import { ed25519KeyOfPeerId } from '../owner-unlock.js';
import { ed25519Signer } from '../request-signing.js';

const VECTORS = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../vectors/address-list.json'), 'utf8'));

type KeyName = 'community' | 'other';
const seedOf = (k: KeyName) => hexToBytes(VECTORS.keys[k].seedHex);
const peerOf = (k: KeyName): string => VECTORS.keys[k].peerId;
const signerOf = (k: KeyName) => ed25519Signer(seedOf(k));
const KEPT = VECTORS.lists.kept.doc as { list: AddressList; sig: string };

function fieldsOf(list: AddressList): AddressListFields {
    const { peerId, communityId, epoch, seq, main, addresses, spares } = list;
    return { peerId, communityId, epoch, seq, main, addresses: [...addresses], spares: [...spares] };
}

describe('the test keys', () => {
    it.each(['community', 'other'] as const)('%s: the PeerId names the seed\'s Ed25519 key', (k) => {
        expect(bytesToHex(ed25519KeyOfPeerId(peerOf(k))!)).toBe(bytesToHex(ed25519.getPublicKey(seedOf(k))));
    });
});

describe('the one spelling of an address', () => {
    const spellings = VECTORS.spellings as { input: string; address: string | null; kind: string; listed?: boolean }[];

    it('covers names, IPv4 and IPv6, kept and refused', () => {
        for (const kind of ['name', 'ipv4', 'ipv6']) {
            expect(spellings.filter((s) => s.kind === kind && s.address !== null).length).toBeGreaterThan(5);
            expect(spellings.filter((s) => s.kind === kind && s.address === null).length).toBeGreaterThan(5);
        }
    });

    it.each(spellings.map((s) => [JSON.stringify(s.input), s] as const))('%s', (_label, s) => {
        expect(addressOf(s.input)).toBe(s.address);
        if (s.address === null) {
            expect(isAddress(s.input)).toBe(false);
            expect(isListableAddress(s.input)).toBe(false);
            return;
        }
        // The one spelling is a fixed point, a server's home in its own spelling, and the only spelling that counts.
        expect(isAddress(s.address)).toBe(true);
        expect(addressOf(s.address)).toBe(s.address);
        expect(nodeHomeOf(s.address)).toBe(s.address);
        expect(isAddress(s.input)).toBe(s.input === s.address);
        expect(isListableAddress(s.address)).toBe(s.listed);
    });

    // The IP forms follow the URL standard, so the address a phone or browser dials is the address the list names.
    it('reads every IP form as the URL standard does (Node\'s WHATWG URL)', () => {
        const bare = spellings.filter((s) => s.kind !== 'name' && !s.input.includes('/'));
        expect(bare.length).toBeGreaterThan(40);
        for (const s of bare) {
            let host: string | null;
            try {
                host = new URL(`https://${s.input.trim()}/`).host;
            } catch {
                host = null;
            }
            // WHATWG takes port 0; a home never does (nodeHomeOf), so that row is ours alone.
            if (s.address === null && /:0$/.test(s.input)) continue;
            expect([s.input, host]).toEqual([s.input, s.address]);
        }
    });

    it('is a string, or nothing', () => {
        for (const x of [undefined, null, 7, {}, ['coop.example.org']]) {
            expect(addressOf(x as unknown as string)).toBeNull();
            expect(isAddress(x)).toBe(false);
        }
    });
});

describe('the signed list: bytes and signature', () => {
    const pinned = Object.entries(VECTORS.lists as Record<string, { doc: { list: AddressList; sig: string }; text?: string }>)
        .filter(([, v]) => v.text !== undefined);

    it('pins at least four lists', () => {
        expect(pinned.map(([k]) => k)).toEqual(expect.arrayContaining(['kept', 'good-b', 'good-spare', 'good-zero']));
    });

    it.each(pinned)('%s: the signed text, the signature, and the read', async (_name, v) => {
        expect(addressListText(v.doc.list)).toBe(v.text);
        expect(await signAddressList(fieldsOf(v.doc.list), signerOf('community'))).toEqual(v.doc);
        expect(readAddressList(v.doc)).toEqual(v.doc);
        expect(checkAddressList(v.doc)).toEqual({ ok: true, signed: v.doc });
    });

    it('signs 0xFF, then the text in UTF-8', () => {
        expect(bytesToHex(addressListBytes(KEPT.list))).toBe(VECTORS.bytesHex.kept);
        expect(VECTORS.bytesHex.kept.startsWith('ff')).toBe(true);
    });

    it('puts the addresses and spares in their one order whatever order they are given in', async () => {
        const fields = fieldsOf(KEPT.list);
        const shuffled = { ...fields, addresses: [...fields.addresses].reverse() };
        expect(await signAddressList(shuffled, signerOf('community'))).toEqual(KEPT);
        const spare = VECTORS.lists['good-spare'].doc;
        expect(await signAddressList({ ...fieldsOf(spare.list), spares: ['standby.example'] }, signerOf('community'))).toEqual(spare);
    });

    it('returns copies: changing what it gave back changes nothing it holds', async () => {
        const fields = fieldsOf(KEPT.list);
        const signed = await signAddressList(fields, signerOf('community'));
        fields.addresses.push('thief.example');
        expect(signed.list.addresses).toEqual(KEPT.list.addresses);
        const read = readAddressList(KEPT)!;
        read.list.addresses.push('thief.example');
        expect(KEPT.list.addresses).not.toContain('thief.example');
    });

    const base = fieldsOf(KEPT.list);
    const refused: [string, AddressListFields][] = [
        ['an address in another spelling', { ...base, addresses: ['Coop.example.org', 'riverside.example'], main: 'riverside.example' }],
        ['an address with :443 written', { ...base, addresses: ['coop.example.org:443'], main: 'coop.example.org:443' }],
        ['main not on the list', { ...base, main: 'elsewhere.example' }],
        ['no addresses', { ...base, addresses: [], main: 'coop.example.org' }],
        [`${ADDRESS_LIST_MAX + 1} addresses`, { ...base, addresses: Array.from({ length: ADDRESS_LIST_MAX + 1 }, (_, i) => `a${i}.example`), main: 'a0.example' }],
        ['an address twice', { ...base, addresses: ['coop.example.org', 'coop.example.org'] }],
        ['localhost', { ...base, addresses: ['coop.example.org', 'localhost'] }],
        ['127.0.0.1', { ...base, addresses: ['127.0.0.1', 'coop.example.org'] }],
        ['[::1]', { ...base, addresses: ['[::1]', 'coop.example.org'] }],
        ['a spare also listed', { ...base, spares: ['coop.example.org'] }],
        [`${ADDRESS_SPARES_MAX + 1} spares`, { ...base, spares: Array.from({ length: ADDRESS_SPARES_MAX + 1 }, (_, i) => `s${i}.example`) }],
        ['a spare twice', { ...base, spares: ['s.example', 's.example'] }],
        ['epoch -1', { ...base, epoch: -1 }],
        ['seq 1.5', { ...base, seq: 1.5 }],
        ['seq past the largest safe integer', { ...base, seq: 2 ** 53 }],
        ['a peerId that is not an Ed25519 key', { ...base, peerId: 'QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N' }],
        ['a communityId with a quote', { ...base, communityId: 'a"b' }],
    ];
    it.each(refused)('signs nothing for %s', async (_name, fields) => {
        let called = false;
        const sign = (bytes: Uint8Array) => { called = true; return ed25519.sign(bytes, seedOf('community')); };
        await expect(signAddressList(fields, sign)).rejects.toThrow(/Cannot sign an address list/);
        expect(called).toBe(false);
    });

    it('refuses to hand back a list its own peerId would not verify', async () => {
        await expect(signAddressList(base, signerOf('other'))).rejects.toThrow(/peerId/);
    });
});

describe('the (epoch, seq) order', () => {
    const n = (epoch: number, seq: number) => ({ epoch, seq });
    it('reads the take-over count first, then the counter', () => {
        expect(compareAddressNumbers(n(2, 14), n(2, 14))).toBe(0);
        expect(compareAddressNumbers(n(2, 15), n(2, 14))).toBe(1);
        expect(compareAddressNumbers(n(2, 13), n(2, 14))).toBe(-1);
        expect(compareAddressNumbers(n(3, 0), n(2, 14))).toBe(1);
        expect(compareAddressNumbers(n(1, 999), n(2, 0))).toBe(-1);
        expect(compareAddressNumbers(n(0, Number.MAX_SAFE_INTEGER), n(1, 0))).toBe(-1);
    });

    it('compares content whatever the order of its addresses', () => {
        const a = fieldsOf(KEPT.list);
        expect(sameAddressListContent(a, { ...a, addresses: [...a.addresses].reverse() })).toBe(true);
        expect(sameAddressListContent(a, { ...a, main: 'riverside.example' })).toBe(false);
        expect(sameAddressListContent(a, { ...a, addresses: [...a.addresses, 'more.example'] })).toBe(false);
        expect(sameAddressListContent(a, { ...a, spares: ['standby.example'] })).toBe(false);
        expect(sameAddressListContent(a, { ...a, communityId: 'other' })).toBe(false);
        expect(sameAddressListContent(a, { ...a, epoch: 9, seq: 99 })).toBe(true);
    });
});

describe('the proof', () => {
    const GOOD = VECTORS.proofs.find((p: { name: string }) => p.name === 'good');

    it('signs 0xFF, then the tag, for, nonce, epoch, seq and ts one per line', () => {
        expect(addressProofText(VECTORS.proofText.fields)).toBe(VECTORS.proofText.text);
        expect(bytesToHex(addressProofBytes(VECTORS.proofText.fields))).toBe(VECTORS.bytesHex.goodProof);
    });

    it('is what a server holding the list signs for the question', async () => {
        const answer = await signAddressProof({ list: KEPT.list, for: 'riverside.example', nonce: VECTORS.nonce, ts: VECTORS.ts }, signerOf('community'));
        expect(answer).toEqual(GOOD.answer);
    });

    it.each((VECTORS.proofs as { name: string; question: { peerId: KeyName; for: string; nonce: string }; answer: unknown; expect: unknown }[])
        .map((p) => [p.name, p] as const))('%s', (_name, p) => {
        const verdict = verifyAddressProof(p.answer, { peerId: peerOf(p.question.peerId), for: p.question.for, nonce: p.question.nonce });
        expect(verdict).toEqual(p.expect);
    });

    it('throws, rather than judging, when the question itself is not one', () => {
        const q = { peerId: peerOf('community'), for: 'riverside.example', nonce: VECTORS.nonce };
        expect(() => verifyAddressProof(GOOD.answer, { ...q, for: 'https://riverside.example' })).toThrow();
        expect(() => verifyAddressProof(GOOD.answer, { ...q, nonce: 'abc' })).toThrow();
        expect(() => verifyAddressProof(GOOD.answer, { ...q, peerId: 'nobody' })).toThrow();
    });

    it.each((VECTORS.questions as { for: unknown; nonce: unknown; refusal: 400 | 421 | null }[])
        .map((q) => [`${JSON.stringify(q.for)} ${JSON.stringify(q.nonce)} -> ${q.refusal}`, q] as const))('a server asked %s', async (_label, q) => {
        expect(addressProofRefusal(KEPT.list, { for: q.for, nonce: q.nonce })).toBe(q.refusal);
        let called = false;
        const sign = (bytes: Uint8Array) => { called = true; return ed25519.sign(bytes, seedOf('community')); };
        const signing = signAddressProof({ list: KEPT.list, for: q.for as string, nonce: q.nonce as string, ts: VECTORS.ts }, sign);
        if (q.refusal === null) {
            const answer = await signing;
            expect(verifyAddressProof(answer, { peerId: peerOf('community'), for: q.for as string, nonce: q.nonce as string }))
                .toEqual({ ok: true, epoch: 2, seq: 14, ts: VECTORS.ts });
        } else {
            await expect(signing).rejects.toThrow(/Cannot sign an address proof/);
            expect(called).toBe(false);
        }
    });

    it('never signs for an address with a line break, even when a list built by hand names one', async () => {
        const broken = { ...KEPT.list, addresses: [...KEPT.list.addresses, 'riverside.example\n9\n9'] };
        expect(addressProofRefusal(broken, { for: 'riverside.example\n9\n9', nonce: VECTORS.nonce })).toBe(421);
        await expect(signAddressProof({ list: broken, for: 'riverside.example\n9\n9', nonce: VECTORS.nonce }, signerOf('community')))
            .rejects.toThrow(/not on the list/);
    });

    it('never signs a proof for a spare', async () => {
        const spare = VECTORS.lists['good-spare'].doc.list as AddressList;
        expect(addressProofRefusal(spare, { for: 'standby.example', nonce: VECTORS.nonce })).toBe(421);
    });

    it('makes a fresh nonce in its one spelling', () => {
        const a = newAddressProofNonce();
        expect(a).toMatch(/^[0-9a-f]{32}$/);
        expect(newAddressProofNonce()).not.toBe(a);
    });
});

describe('where the two reads are', () => {
    it('at every address, on its own port', () => {
        expect(ADDRESS_LIST_PATH).toBe('/api/node/addresses');
        expect(ADDRESS_PROOF_PATH).toBe('/api/node/proof');
        expect(addressListUrl('coop.example.org')).toBe('https://coop.example.org/api/node/addresses');
        expect(addressListUrl('[2001:db8::1]:8443')).toBe('https://[2001:db8::1]:8443/api/node/addresses');
        expect(addressProofUrl('coop.example.org:8443', VECTORS.nonce))
            .toBe(`https://coop.example.org:8443/api/node/proof?for=coop.example.org%3A8443&nonce=${VECTORS.nonce}`);
        const url = new URL(addressProofUrl('[2001:db8::1]', VECTORS.nonce));
        expect(url.searchParams.get('for')).toBe('[2001:db8::1]');
        expect(url.host).toBe('[2001:db8::1]');
    });

    it('only for an address in its one spelling', () => {
        expect(() => addressListUrl('https://coop.example.org')).toThrow();
        expect(() => addressProofUrl('Coop.example.org', VECTORS.nonce)).toThrow();
        expect(() => addressProofUrl('coop.example.org', 'nonce')).toThrow();
    });
});
