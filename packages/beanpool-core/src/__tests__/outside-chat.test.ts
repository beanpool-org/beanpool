/**
 * The address card and a line across communities (outside-chat.ts; messages across communities X3). The card vector was made
 * once and is frozen: if a change stops it verifying, it has broken every card already shown and printed. Fix the change,
 * never the vector. Ana's seed is SHA-256("beanpool relay vector: Ana"), as relay-envelope.test.ts's.
 */
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
    addressCardDigest, addressCardFromText, addressCardLink, addressCardVerifies, homeTail, openOutsideLine, outsideReceiptPayload, HOME_LINE_MAX,
    sealOutsideLine, signAddressCard, OutsideLineNotVerifiedError, type AddressCard,
} from '../outside-chat.js';
import { relayConversationId, relayPayloadHash, signRelayEnvelope, type RelayEnvelope } from '../relay-envelope.js';

const seed = (name: string) => sha256(utf8ToBytes(`beanpool relay vector: ${name}`));
const pub = (s: Uint8Array) => bytesToHex(ed25519.getPublicKey(s));
const signer = (s: Uint8Array) => (b: Uint8Array) => ed25519.sign(b, s);
const ANA = seed('Ana');
const BEN = seed('Ben');
const CY = seed('Cy');
const ANA_KEY = '77b068c41033fdd9e185bd603293fdc1702361e9726edf0d0d3c4ea259719c85';

/** Ana's card at a.example, frozen. */
const CARD: AddressCard = {
    v: 1, key: ANA_KEY, home: 'a.example', name: 'Ana Ríos',
    sig: '+lZkcNFCBgcxF0ShazyUj17zQtFTfVj0aZWPAXARqEfYqaBdgZqiivnCaWJiHKlCyGK/4o7rFShaQEXyiwfXBQ==',
};
const LINK = 'https://a.example/card#eyJ2IjoxLCJrZXkiOiI3N2IwNjhjNDEwMzNmZGQ5ZTE4NWJkNjAzMjkzZmRjMTcwMjM2MWU5NzI2ZWRmMGQwZDNjNGVhMjU5NzE5Yzg1IiwiaG9tZSI6ImEuZXhhbXBsZSIsIm5hbWUiOiJBbmEgUsOtb3MiLCJzaWciOiIrbFprY05GQ0JnY3hGMFNoYXp5VWoxN3pRdEZUZlZqMGFaV1BBWEFScUVmWXFhQmRnWnFpaXZuQ2FXSmlIS2xDeUdLLzRvN3JGU2hhUUVYeWl3ZlhCUT09In0';

describe('the address card, frozen', () => {
    it('is Ana\'s signature over SHA-256 of the JSON array [tag, key, home, name]', () => {
        expect(pub(ANA)).toBe(ANA_KEY);
        const digest = sha256(utf8ToBytes(JSON.stringify(['beanpool-address-card/1', ANA_KEY, 'a.example', 'Ana Ríos'])));
        expect(bytesToHex(addressCardDigest(CARD))).toBe(bytesToHex(digest));
        expect(addressCardVerifies(CARD)).toBe(true);
    });

    it('signs to the same bytes, and its link is the frozen one', async () => {
        expect(await signAddressCard({ key: ANA_KEY, home: 'a.example', name: '  Ana Ríos ' }, signer(ANA))).toEqual(CARD);
        expect(addressCardLink(CARD)).toBe(LINK);
    });

    it('is read back from its link, and from the part after # alone', () => {
        expect(addressCardFromText(LINK)).toEqual(CARD);
        expect(addressCardFromText(`  ${LINK}\n`)).toEqual(CARD);
        expect(addressCardFromText(LINK.slice(LINK.indexOf('#') + 1))).toEqual(CARD);
    });
});

describe('a card that is not its owner\'s reads as no card', () => {
    const relink = (c: Record<string, unknown>) => `https://${String(c.home)}/card#${Buffer.from(JSON.stringify(c)).toString('base64url')}`;

    it('another home, another name, another key, another signature', () => {
        expect(addressCardFromText(relink({ ...CARD, home: 'evil.example' }))).toBeNull();
        expect(addressCardFromText(relink({ ...CARD, name: 'Ana R' }))).toBeNull();
        expect(addressCardFromText(relink({ ...CARD, key: pub(BEN) }))).toBeNull();
        expect(addressCardFromText(relink({ ...CARD, sig: CARD.sig.replace('+', '/') }))).toBeNull();
        expect(addressCardVerifies({ ...CARD, home: 'a.example:443' })).toBe(false);
    });

    it('a link on one home carrying a card of another', () => {
        expect(addressCardFromText(LINK.replace('https://a.example/', 'https://b.example/'))).toBeNull();
        expect(addressCardFromText(LINK.replace('https://', 'http://'))).toBeNull();
        expect(addressCardFromText(LINK.replace('/card#', '/other#'))).toBeNull();
    });

    it('anything else a camera sees', () => {
        for (const text of ['', 'https://a.example/', 'INV-ABCD-EFGH', 'https://a.example/card#', 'https://a.example/card#!!!', null, 42, '{"v":1}']) {
            expect(addressCardFromText(text)).toBeNull();
        }
    });

    it('refuses to sign a name it can\'t carry, a home in another spelling, or a key that is not one', async () => {
        await expect(signAddressCard({ key: ANA_KEY, home: 'a.example', name: '' }, signer(ANA))).rejects.toThrow();
        await expect(signAddressCard({ key: ANA_KEY, home: 'a.example', name: 'x'.repeat(61) }, signer(ANA))).rejects.toThrow();
        await expect(signAddressCard({ key: ANA_KEY, home: 'a.example', name: 'Ana\nRíos' }, signer(ANA))).rejects.toThrow();
        await expect(signAddressCard({ key: ANA_KEY, home: 'https://a.example', name: 'Ana' }, signer(ANA))).rejects.toThrow();
        await expect(signAddressCard({ key: 'ANA', home: 'a.example', name: 'Ana' }, signer(ANA))).rejects.toThrow();
    });
});

describe('a line across communities', () => {
    const anaKey = pub(ANA), benKey = pub(BEN), cyKey = pub(CY);
    const messageId = '0c9a6b1e-2f3d-4e5a-8b7c-6d5e4f3a2b10';
    const payload = sealOutsideLine({ text: 'Hello from Riverside', name: 'Ana Ríos', myEdPrivHex: bytesToHex(ANA), myKey: anaKey, peerKey: benKey, messageId });
    const envelopeFor = (over: Partial<RelayEnvelope> = {}, body = payload) => signRelayEnvelope({
        kind: 'dm-line', itemId: messageId, senderKey: anaKey, senderHome: 'a.example', recipient: benKey, recipientHome: 'b.example',
        at: 1763020800000, payloadHash: relayPayloadHash(body), ...over,
    }, signer(ANA));
    const ben = { key: benKey, edPrivHex: bytesToHex(BEN) };

    it('opens for its recipient with the words and the name inside the seal, under the conversation of the two keys', async () => {
        const opened = openOutsideLine(payload, await envelopeFor(), ben);
        expect(opened).toEqual({ messageId, conversationId: relayConversationId(anaKey, benKey), text: 'Hello from Riverside', name: 'Ana Ríos', replyToId: null });
        expect(payload).not.toContain('Ana');
        expect(payload).not.toContain('Riverside');
    });

    it('a reply is bound to the line it answers', async () => {
        const reply = sealOutsideLine({ text: 'Yes', name: 'Ana', myEdPrivHex: bytesToHex(ANA), myKey: anaKey, peerKey: benKey, messageId, replyToId: 'earlier-1' });
        expect(openOutsideLine(reply, await envelopeFor({}, reply), ben).replyToId).toBe('earlier-1');
        const moved = JSON.stringify({ ...JSON.parse(reply), r: 'other-line' });
        const movedEnv = await envelopeFor({}, moved);
        expect(() => openOutsideLine(moved, movedEnv, ben)).toThrow(OutsideLineNotVerifiedError);
    });

    it('opens as nobody else\'s: another recipient, another id, another sender, changed bytes', async () => {
        const env = await envelopeFor();
        expect(() => openOutsideLine(payload, env, { key: cyKey, edPrivHex: bytesToHex(CY) })).toThrow(OutsideLineNotVerifiedError);
        expect(() => openOutsideLine(payload, { ...env, recipient: cyKey }, ben)).toThrow(OutsideLineNotVerifiedError);
        expect(() => openOutsideLine(payload, { ...env, itemId: '1c9a6b1e-2f3d-4e5a-8b7c-6d5e4f3a2b10' }, ben)).toThrow(OutsideLineNotVerifiedError);
        expect(() => openOutsideLine(payload, { ...env, senderKey: cyKey }, ben)).toThrow(OutsideLineNotVerifiedError);
        expect(() => openOutsideLine(payload, { ...env, kind: 'dm-delete' }, ben)).toThrow(OutsideLineNotVerifiedError);
        const p = JSON.parse(payload);
        const changed = JSON.stringify({ ...p, c: p.c.slice(0, -4) + (p.c.endsWith('AAA=') ? 'BBB=' : 'AAA=') });
        expect(() => openOutsideLine(changed, env, ben)).toThrow(OutsideLineNotVerifiedError);
        expect(() => openOutsideLine('not json', env, ben)).toThrow(OutsideLineNotVerifiedError);
    });

    it('a line Cy sealed for Ben naming Ana as sender does not open as Ana\'s', async () => {
        // Cy can't sign as Ana, so Cy seals as Cy, and the envelope (Ana's) names Ana: the line's signature is not Ana's.
        const cyLine = sealOutsideLine({ text: 'Not Ana', name: 'Ana', myEdPrivHex: bytesToHex(CY), myKey: cyKey, peerKey: benKey, messageId });
        const cyEnv = await envelopeFor({}, cyLine);
        expect(() => openOutsideLine(cyLine, cyEnv, ben)).toThrow(OutsideLineNotVerifiedError);
    });

    it('refuses empty words, too many, or an id that is not a lower-case UUID v4', () => {
        const base = { name: 'Ana', myEdPrivHex: bytesToHex(ANA), myKey: anaKey, peerKey: benKey, messageId };
        expect(() => sealOutsideLine({ ...base, text: '  ' })).toThrow();
        expect(() => sealOutsideLine({ ...base, text: 'x'.repeat(8001) })).toThrow();
        expect(() => sealOutsideLine({ ...base, text: 'hi', messageId: 'not-a-uuid-at-all' })).toThrow();
    });

    it('a receipt is the mailbox\'s {"v":1,"items":[ids]}, each id once', () => {
        expect(outsideReceiptPayload(['a1b2c3d4e5', 'a1b2c3d4e5', 'f6e5d4c3b2'])).toBe('{"v":1,"items":["a1b2c3d4e5","f6e5d4c3b2"]}');
    });
});

describe('a home, short enough for a list\'s line (homeTail; PR #3168 round-3 note)', () => {
    // One table: the home, what the line shows. A cut drops whole labels from the front only, so the end (the real domain)
    // shows in full and nothing after the "…" is half a label.
    const CASES: Array<[string, string]> = [
        ['riverside.example', 'riverside.example'],
        ['coop.example.org:8443', 'coop.example.org:8443'],
        ['203.0.113.200:65535', '203.0.113.200:65535'],
        // 48 characters: whole.
        [`${'a'.repeat(36)}.example.org`, `${'a'.repeat(36)}.example.org`],
        // Too long: the front label goes, the last three stay.
        ['hilltop-market-and-tool-library-cooperative-of-the-north-coast.riverside.example', 'hilltop-market-and-tool-library-cooperative-of-the-north-coast.riverside.example'],
        ['hilltop-market-and-tool-library-cooperative.north-coast.riverside.example.org', '…north-coast.riverside.example.org'],
        // A front label that only half fits is dropped whole, never cut: never `…mybank.example` for `evil-mybank.example`.
        ['a-very-long-prefix-made-to-look-like-evil-mybank.example', 'a-very-long-prefix-made-to-look-like-evil-mybank.example'],
        ['x.y.a-very-long-prefix-made-to-look-like-evil-mybank.example.org', '…a-very-long-prefix-made-to-look-like-evil-mybank.example.org'],
        // The last three labels stay however long (a two-label suffix): longer than the line's 48, never cut.
        [`${'r'.repeat(60)}.co.uk`, `${'r'.repeat(60)}.co.uk`],
        [`shop.${'r'.repeat(60)}.co.uk`, `…${'r'.repeat(60)}.co.uk`],
        // With a port: the port rides on the last label.
        ['the-long-name-of-a-community-garden-and-its-shed.hills.example:8443', 'the-long-name-of-a-community-garden-and-its-shed.hills.example:8443'],
        ['the-long-name-of-a-community-garden-and-its-shed.green.hills.example:8443', '…green.hills.example:8443'],
        // IPv6 has no dots: never cut.
        ['[2001:db8:1234:5678:9abc:def0:1234:5678]:8443', '[2001:db8:1234:5678:9abc:def0:1234:5678]:8443'],
    ];
    it.each(CASES)('%s shows as %s', (home, shown) => {
        const out = homeTail(home);
        expect(out).toBe(shown);
        // Whatever shows ends with the home's own end and is a run of its whole labels after the "…".
        expect(home.endsWith(out.replace(/^…/, ''))).toBe(true);
        if (out.startsWith('…')) {
            expect(home.endsWith(`.${out.slice(1)}`), 'cut at a dot, between whole labels').toBe(true);
            expect(out.slice(1).split('.').length, 'the last three labels at least').toBeGreaterThanOrEqual(3);
            if (out.slice(1).split('.').length > 3) expect(out.length, 'a cut past three labels fits the line').toBeLessThanOrEqual(HOME_LINE_MAX);
        } else {
            expect(out).toBe(home);
        }
    });

    it('takes as many whole labels as fit, from the end', () => {
        expect(homeTail('aaaa.bbbb.cccc.dddd.eeee.example.org', 22)).toBe('…dddd.eeee.example.org');
        expect(homeTail('aaaa.bbbb.cccc.dddd.eeee.example.org', 21)).toBe('…eeee.example.org');
    });
});
