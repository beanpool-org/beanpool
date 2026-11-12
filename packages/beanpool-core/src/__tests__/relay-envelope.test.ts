/**
 * The relay envelope, the home rule and the conversation id across communities (relay-envelope.ts; messages across
 * communities X1). The vectors were made once and are frozen: if a change stops one verifying, or moves the conversation
 * id, it has broken every item and chat already made that way. Fix the change, never the vector.
 *
 * How they were made: each key's seed is SHA-256("beanpool relay vector: <name>"), the time and the ids fixed. The digest
 * is re-derived here from the primitives, independently of the module.
 */
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
    RELAY_ITEM_KINDS, checkRelayItem, readRelayEnvelope, relayConversationId, relayEnvelopeFromItsHome, relayEnvelopeVerifies,
    relayPayloadHash, signRelayEnvelope, type RelayEnvelope, type RelayEnvelopeFields,
} from '../relay-envelope.js';

const seed = (name: string) => sha256(utf8ToBytes(`beanpool relay vector: ${name}`));
const pub = (s: Uint8Array) => bytesToHex(ed25519.getPublicKey(s));
const signer = (s: Uint8Array) => (b: Uint8Array) => ed25519.sign(b, s);

const ANA = seed('Ana');
const BEN = seed('Ben');
const ANA_KEY = '77b068c41033fdd9e185bd603293fdc1702361e9726edf0d0d3c4ea259719c85';
const BEN_KEY = '99499c720c339bfbb5ba6ba9064e39a289e5a4cd1d05c824b1a5c1b716bd1c8b';
/** The sealed bytes, as base64 (no server reads them). */
const PAYLOAD = 'c2VhbGVkIGJ5dGVzIG5vIHNlcnZlciBjYW4gcmVhZA==';

/** Ana, at a.example, writes Ben, at b.example, one line, frozen. */
const ENVELOPE: RelayEnvelope = {
    v: 1, kind: 'dm-line', itemId: '0c9a6b1e-2f3d-4e5a-8b7c-6d5e4f3a2b10', senderKey: ANA_KEY, senderHome: 'a.example',
    recipient: BEN_KEY, recipientHome: 'b.example', at: 1763020800000,
    payloadHash: '1fb360f835b12359f9237d07f9be7a4413145d8541341a16ba74da14361f64ef',
    sig: 'EDMl9sjMuX9vTP3gSgL+owZm6qPPeZ4vrfa4Fvk8Wr6o7Fm6tsjGdtC0OGl0VhPGY9f0K+YNPHTrjRiZNsEdCw==',
};
/** Ana, her community's server now published on port 8443, writes Ben another line, frozen: her home names its port. */
const PORT_ENVELOPE: RelayEnvelope = {
    v: 1, kind: 'dm-line', itemId: '3c9a6b1e-2f3d-4e5a-8b7c-6d5e4f3a2b10', senderKey: ANA_KEY, senderHome: 'a.example:8443',
    recipient: BEN_KEY, recipientHome: 'b.example', at: 1763020800000,
    payloadHash: '1fb360f835b12359f9237d07f9be7a4413145d8541341a16ba74da14361f64ef',
    sig: '5GShmqaHqRZ6WH37bXMb7elyStknLBLqdy7Wd5PQdkvJ6X8iCcqvKBRQB3/Nv5F33h1iLvGzC4kYyHEs161WCA==',
};
/** Ana and Ben's conversation, frozen. */
const CONVERSATION = 'ddd3ee08-0d30-4589-89c6-6769a723b882';

const fieldsOf = ({ kind, itemId, senderKey, senderHome, recipient, recipientHome, at, payloadHash }: RelayEnvelope): RelayEnvelopeFields =>
    ({ kind, itemId, senderKey, senderHome, recipient, recipientHome, at, payloadHash });
const atB = (host: string) => host === 'b.example';

describe('the envelope, frozen', () => {
    it('the keys are the seeds\', the payload hash the payload\'s', () => {
        expect(pub(ANA)).toBe(ANA_KEY);
        expect(pub(BEN)).toBe(BEN_KEY);
        expect(relayPayloadHash(PAYLOAD)).toBe(ENVELOPE.payloadHash);
        expect(bytesToHex(sha256(utf8ToBytes(PAYLOAD)))).toBe(ENVELOPE.payloadHash);
    });

    it('is Ana\'s signature over SHA-256 of the JSON array [tag, kind, sender, home, recipient, home, id, time, payload hash]', () => {
        const digest = sha256(utf8ToBytes(JSON.stringify([
            'beanpool-relay-envelope/1', 'dm-line', ANA_KEY, 'a.example', BEN_KEY, 'b.example', '0c9a6b1e-2f3d-4e5a-8b7c-6d5e4f3a2b10',
            '1763020800000', ENVELOPE.payloadHash,
        ])));
        const sig = new Uint8Array(Buffer.from(ENVELOPE.sig, 'base64'));
        expect(ed25519.verify(sig, digest, hexToBytes(ANA_KEY), { zip215: false })).toBe(true);
    });

    it('signing makes the frozen envelope; it reads back and verifies', async () => {
        expect(await signRelayEnvelope(fieldsOf(ENVELOPE), signer(ANA))).toEqual(ENVELOPE);
        expect(readRelayEnvelope(JSON.parse(JSON.stringify(ENVELOPE)))).toEqual(ENVELOPE);
        expect(relayEnvelopeVerifies(ENVELOPE)).toBe(true);
    });

    it('from a home on port 8443: Ana\'s signature over the same array, the home with its port', async () => {
        const digest = sha256(utf8ToBytes(JSON.stringify([
            'beanpool-relay-envelope/1', 'dm-line', ANA_KEY, 'a.example:8443', BEN_KEY, 'b.example', '3c9a6b1e-2f3d-4e5a-8b7c-6d5e4f3a2b10',
            '1763020800000', PORT_ENVELOPE.payloadHash,
        ])));
        const sig = new Uint8Array(Buffer.from(PORT_ENVELOPE.sig, 'base64'));
        expect(ed25519.verify(sig, digest, hexToBytes(ANA_KEY), { zip215: false })).toBe(true);
        expect(await signRelayEnvelope(fieldsOf(PORT_ENVELOPE), signer(ANA))).toEqual(PORT_ENVELOPE);
        expect(readRelayEnvelope(JSON.parse(JSON.stringify(PORT_ENVELOPE)))).toEqual(PORT_ENVELOPE);
        expect(relayEnvelopeVerifies(PORT_ENVELOPE)).toBe(true);
    });

    it('a change to any one value breaks the signature', () => {
        const changes: Partial<RelayEnvelope>[] = [
            { kind: 'dm-blob' }, { itemId: '0c9a6b1e-2f3d-4e5a-8b7c-6d5e4f3a2b11' }, { senderKey: BEN_KEY }, { senderHome: 'c.example' },
            { senderHome: 'a.example:8443' }, { recipient: ANA_KEY }, { recipientHome: 'c.example' }, { recipientHome: 'b.example:8443' },
            { at: 1763020800001 },
            { payloadHash: relayPayloadHash(`${PAYLOAD}x`) },
        ];
        for (const change of changes) expect(relayEnvelopeVerifies({ ...ENVELOPE, ...change })).toBe(false);
        expect(relayEnvelopeVerifies({ ...ENVELOPE, sig: ENVELOPE.sig.replace(/^E/, 'F') })).toBe(false);
    });

    it('every kind of item signs and verifies; no other kind does', async () => {
        expect([...RELAY_ITEM_KINDS]).toEqual([
            'dm-line', 'dm-blob', 'dm-delete', 'receipt', 'group-invite', 'group-roster', 'group-epoch', 'group-line', 'group-blob',
            'group-leave', 'call-signal', 'complaint',
        ]);
        for (const kind of RELAY_ITEM_KINDS) {
            const env = await signRelayEnvelope({ ...fieldsOf(ENVELOPE), kind }, signer(ANA));
            expect(relayEnvelopeVerifies(env)).toBe(true);
        }
        await expect(signRelayEnvelope({ ...fieldsOf(ENVELOPE), kind: 'dm-video' as never }, signer(ANA))).rejects.toThrow();
        expect(readRelayEnvelope({ ...ENVELOPE, kind: 'dm-video' })).toBeNull();
    });

    it('a group at its host is a recipient; anything else that is not a member key is not', async () => {
        const toGroup = await signRelayEnvelope({ ...fieldsOf(ENVELOPE), kind: 'group-line', recipient: 'group:garden-club_2' }, signer(ANA));
        expect(relayEnvelopeVerifies(toGroup)).toBe(true);
        for (const recipient of ['group:', 'group:a/b', BEN_KEY.toUpperCase(), 'ben@b.example', '']) {
            expect(readRelayEnvelope({ ...ENVELOPE, recipient })).toBeNull();
        }
    });

    it('each value has one spelling', () => {
        for (const change of [
            { senderHome: 'A.example' }, { senderHome: 'a.example:443' }, { recipientHome: 'https://b.example' },
            { senderHome: 'a.example:08443' }, { recipientHome: 'b.example:0' }, { recipientHome: 'b.example:443' },
            { senderKey: ANA_KEY.toUpperCase() }, { itemId: 'short' }, { at: -1 }, { at: 1.5 }, { at: '1763020800000' },
            { payloadHash: ENVELOPE.payloadHash.toUpperCase() }, { v: 2 }, { sig: ENVELOPE.sig.replace(/==$/, '') },
        ]) {
            expect(readRelayEnvelope({ ...ENVELOPE, ...change })).toBeNull();
        }
    });
});

describe('the home rule: an envelope naming a home other than the server that signed the request is dropped', () => {
    const item = { envelope: ENVELOPE, payload: PAYLOAD };

    it('carried by Ana\'s own home, a.example, to b.example: taken', () => {
        expect(relayEnvelopeFromItsHome(ENVELOPE, 'a.example')).toBe(true);
        expect(checkRelayItem(item, { signedBy: 'a.example', isHere: atB })).toEqual({ ok: true, item });
    });

    it('carried by a third server, c.example: dropped as wrong-home, though Ana\'s signature is good', () => {
        expect(relayEnvelopeVerifies(ENVELOPE)).toBe(true);
        expect(relayEnvelopeFromItsHome(ENVELOPE, 'c.example')).toBe(false);
        expect(checkRelayItem(item, { signedBy: 'c.example', isHere: atB })).toEqual({ ok: false, reason: 'wrong-home' });
    });

    it('a third server that rewrites the home to its own breaks Ana\'s signature: dropped', () => {
        const rewritten = { envelope: { ...ENVELOPE, senderHome: 'c.example' }, payload: PAYLOAD };
        expect(checkRelayItem(rewritten, { signedBy: 'c.example', isHere: atB })).toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('a home spelled another way is another home', () => {
        expect(relayEnvelopeFromItsHome(ENVELOPE, 'A.example')).toBe(false);
        expect(relayEnvelopeFromItsHome(ENVELOPE, 'a.example.')).toBe(false);
        expect(relayEnvelopeFromItsHome(ENVELOPE, 'a.example:443')).toBe(false);
    });

    it('a home on another port is another home, both ways', () => {
        const fromPort = { envelope: PORT_ENVELOPE, payload: PAYLOAD };
        expect(checkRelayItem(fromPort, { signedBy: 'a.example:8443', isHere: atB })).toEqual({ ok: true, item: fromPort });
        // Naming a.example:8443, carried by the server at a.example (port 443): dropped.
        expect(checkRelayItem(fromPort, { signedBy: 'a.example', isHere: atB })).toEqual({ ok: false, reason: 'wrong-home' });
        // Naming a.example (port 443), carried by the server at a.example:8443: dropped.
        expect(checkRelayItem(item, { signedBy: 'a.example:8443', isHere: atB })).toEqual({ ok: false, reason: 'wrong-home' });
        // For b.example:8443, at the server at b.example (port 443): not for here.
        expect(checkRelayItem(fromPort, { signedBy: 'a.example:8443', isHere: (h) => h === 'b.example:8443' }))
            .toEqual({ ok: false, reason: 'not-for-here' });
    });

    it('an item for another server, a changed payload, or no item at all is dropped too', () => {
        expect(checkRelayItem(item, { signedBy: 'a.example', isHere: (h) => h === 'c.example' })).toEqual({ ok: false, reason: 'not-for-here' });
        expect(checkRelayItem({ envelope: ENVELOPE, payload: `${PAYLOAD}x` }, { signedBy: 'a.example', isHere: atB }))
            .toEqual({ ok: false, reason: 'payload-changed' });
        for (const bad of [null, [], {}, { envelope: ENVELOPE }, { envelope: ENVELOPE, payload: 7 }, { envelope: {}, payload: PAYLOAD }]) {
            expect(checkRelayItem(bad, { signedBy: 'a.example', isHere: atB })).toEqual({ ok: false, reason: 'malformed' });
        }
        expect(checkRelayItem(item, { signedBy: 'a.example', isHere: () => { throw new Error('no'); } })).toEqual({ ok: false, reason: 'not-for-here' });
    });
});

describe('the conversation across communities is named from the two keys alone', () => {
    it('frozen, the same whoever computes it', () => {
        expect(relayConversationId(ANA_KEY, BEN_KEY)).toBe(CONVERSATION);
        expect(relayConversationId(BEN_KEY, ANA_KEY)).toBe(CONVERSATION);
        const lo = ANA_KEY < BEN_KEY ? ANA_KEY : BEN_KEY;
        const hi = lo === ANA_KEY ? BEN_KEY : ANA_KEY;
        const hash = sha256(utf8ToBytes(`beanpool-relay-conversation/1\n${lo}\n${hi}`)).slice(0, 16);
        hash[6] = (hash[6] & 0x0f) | 0x40;
        hash[8] = (hash[8] & 0x3f) | 0x80;
        expect(CONVERSATION.replace(/-/g, '')).toBe(bytesToHex(hash));
    });

    it('is shaped as every conversation id is checked for (a UUID, version 4)', () => {
        expect(CONVERSATION).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('stays the same when a home changes its address: the envelopes route, the keys name the chat', async () => {
        const before = await signRelayEnvelope(fieldsOf(ENVELOPE), signer(ANA));
        const moved = await signRelayEnvelope({ ...fieldsOf(ENVELOPE), senderHome: 'ana-garden.org', itemId: '1c9a6b1e-2f3d-4e5a-8b7c-6d5e4f3a2b10' }, signer(ANA));
        const reply = await signRelayEnvelope({
            ...fieldsOf(ENVELOPE), senderKey: BEN_KEY, senderHome: 'b.example', recipient: ANA_KEY, recipientHome: 'ana-garden.org',
            itemId: '2c9a6b1e-2f3d-4e5a-8b7c-6d5e4f3a2b10',
        }, signer(BEN));
        for (const env of [before, moved, reply, PORT_ENVELOPE]) {
            expect(relayEnvelopeVerifies(env)).toBe(true);
            expect(relayConversationId(env.senderKey, env.recipient)).toBe(CONVERSATION);
        }
    });

    it('another pair is another conversation; a key with itself or a misspelled key is none', () => {
        const cara = pub(seed('Cara'));
        expect(relayConversationId(ANA_KEY, cara)).not.toBe(CONVERSATION);
        expect(() => relayConversationId(ANA_KEY, ANA_KEY)).toThrow();
        expect(() => relayConversationId(ANA_KEY.toUpperCase(), BEN_KEY)).toThrow();
        expect(() => relayConversationId('group:garden', BEN_KEY)).toThrow();
    });
});
