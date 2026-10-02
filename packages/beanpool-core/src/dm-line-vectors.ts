/**
 * Fixed direct-message vectors, and the checks that run them: shared by core's vitest suite, the native app's runner and
 * the PWA's, each handing in ITS OWN e2e-crypto module, so all three prove the same bytes seal and open the same way.
 *
 * The lines below were sealed once and are frozen. If a change to dm-crypto.ts stops any of them opening, that change
 * has broken every message already sent: fix the change, never regenerate the vectors.
 *
 * Kept out of the main index (import `@beanpool/core/dm-line-vectors`) so no app bundle carries it. The checks throw a
 * plain Error and depend on no test framework.
 *
 * How they were made: Ana's and Ben's seeds are SHA-256("beanpool dm-line vector: <name>"), each nonce the first 24 bytes
 * of SHA-256("beanpool dm-line vector: nonce <n>"). Format 3's bytes are re-derived from the primitives, independently of
 * dm-crypto.ts, in core's dm-crypto.test.ts.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { toEd25519Pkcs8 } from './ed25519-key.js';
import type { DmKeyContext, DmKeys, DmLineBinding, DmPayload, OpenedDmLine, DmLineRef } from './dm-crypto.js';

const seedOf = (name: string) => sha256(utf8ToBytes(`beanpool dm-line vector: ${name}`));
const nonceOf = (n: number) => sha256(utf8ToBytes(`beanpool dm-line vector: nonce ${n}`)).slice(0, 24);

const anaSeed = seedOf('Ana');
const benSeed = seedOf('Ben');
export const DM_VECTOR_PEOPLE = {
    ana: { seedHex: bytesToHex(anaSeed), pkcs8Hex: bytesToHex(toEd25519Pkcs8(anaSeed)), publicKey: bytesToHex(ed25519.getPublicKey(anaSeed)) },
    ben: { seedHex: bytesToHex(benSeed), pkcs8Hex: bytesToHex(toEd25519Pkcs8(benSeed)), publicKey: bytesToHex(ed25519.getPublicKey(benSeed)) },
};
export const DM_VECTOR_CONVERSATION = '6f1d3c2a-9b8e-4c7d-a6f5-e4d3c2b1a090';

export interface DmLineVector {
    label: string;
    from: 'ana' | 'ben';
    format: 2 | 3;
    messageId: string;
    part: 'body' | 'attachment';
    after: string | null;
    /** A reply: the message it answers, as its metadata names it (bound into the associated data). */
    replyToId?: string;
    text: string;
    nonce: Uint8Array;
    /** The frozen sealed line. */
    payload: DmPayload;
}

export const DM_LINE_VECTORS: DmLineVector[] = [
    {
        label: 'format 3: Ana\'s words, written after a line of Ben\'s',
        from: 'ana', format: 3, messageId: '0c9a6b1e-2f3d-4e5a-8b7c-6d5e4f3a2b10', part: 'body',
        after: '7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a0ff', text: 'Meet at the gate at 6 — bring the seedlings 🌱',
        nonce: nonceOf(1),
        payload: {
            ciphertext: '7GRTPggLMu7Zo81nmcI4XS0FwY+KSUHF1LY+lymVnCv7Lu1qayd6pRhV0GCS8wzUjtzn4HW8t3iNvGPVehexLlVF8V0JSUYgEH60E60RLkSITrsJUl6GPUK6EKRFdxGu2aIJAg+0Pq0=',
            nonce: 'x25519-xc20p-v2:kB8B6UJCoBx05QKCjwuN3PFUHGH4qKtb',
        },
    },
    {
        label: 'format 3: Ben\'s first line, written after nothing',
        from: 'ben', format: 3, messageId: '5b4a3928-1706-4f5e-9d4c-3b2a19081726', part: 'body',
        after: null, text: 'ok', nonce: nonceOf(2),
        payload: {
            ciphertext: 'o/WJELCnoxtVRr/ofuYZV4Lf0UQ=',
            nonce: 'x25519-xc20p-v2:UrLitsjP/XyW5YTWddNaMLXkymB61NVy',
        },
    },
    {
        label: 'format 3: Ana\'s photo (the attachment part)',
        from: 'ana', format: 3, messageId: '0c9a6b1e-2f3d-4e5a-8b7c-6d5e4f3a2b10', part: 'attachment',
        after: null, text: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==', nonce: nonceOf(3),
        payload: {
            ciphertext: 'uoDDdNw5ItTnIjE2S6QYnIxmQARk/FEOUyvx1jV5QpMF/dhoyeRrS57iNOhyH0yYBk9sxJdxbx6kv+6A2w==',
            nonce: 'x25519-xc20p-v2:SGShD93uZ/2wstjXn7/mIGGgO9nVG+8w',
        },
    },
    {
        label: 'format 3: Ben\'s reply to Ana\'s line',
        from: 'ben', format: 3, messageId: '3d2c1b0a-9f8e-4d7c-b6a5-948372615f4e', part: 'body',
        after: '0c9a6b1e-2f3d-4e5a-8b7c-6d5e4f3a2b10', replyToId: '0c9a6b1e-2f3d-4e5a-8b7c-6d5e4f3a2b10', text: 'Yes', nonce: nonceOf(5),
        payload: {
            ciphertext: 'LGwOkxLk9ofGoO4HhNWz4PmmLRhzAWiqryFh0y8MKabOGJcKDvJBNLC5OmIsnZzF0GovYX2Eyvwo',
            nonce: 'x25519-xc20p-v2:DWwW3W+AojGmnThKDGlsY+3tuTvnE0/1',
        },
    },
    {
        label: 'format 2: an old line of Ben\'s (the history every member already has)',
        from: 'ben', format: 2, messageId: 'old-line-1', part: 'body',
        after: null, text: 'see you then', nonce: nonceOf(4),
        payload: {
            ciphertext: 'CYTTA5AJhzHrHAuQUU4c1To40XOzX0XO60M1cw==',
            nonce: 'x25519-xc20p-v2:5MbsKzq1TN0Oz4PRQLF8imicZUQIizE4',
        },
    },
];

/** The parts of an app's e2e-crypto module the vectors exercise. */
export interface DmLineApi {
    sealDmLine(text: string, ctx: DmKeyContext, line: DmLineBinding & { after?: string | null; replyToId?: string | null }, nonceForVectors?: Uint8Array): DmPayload;
    encryptDmFormat2(text: string, ctx: DmKeyContext, nonceForVectors?: Uint8Array): DmPayload;
    openDmLine(payload: DmPayload, keys: DmKeys, line: DmLineRef, formats?: ReadonlyArray<2 | 3>): OpenedDmLine;
}

function fail(msg: string): never {
    throw new Error(`dm-line vectors: ${msg}`);
}

function keysOf(me: 'ana' | 'ben', pkcs8 = false): DmKeys {
    const p = DM_VECTOR_PEOPLE[me];
    const other = DM_VECTOR_PEOPLE[me === 'ana' ? 'ben' : 'ana'];
    return { myEdPrivHex: pkcs8 ? p.pkcs8Hex : p.seedHex, peerEdPubHex: other.publicKey };
}

function refOf(v: DmLineVector, over: Partial<DmLineRef> = {}): DmLineRef {
    return {
        conversationId: DM_VECTOR_CONVERSATION, senderPubHex: DM_VECTOR_PEOPLE[v.from].publicKey, messageId: v.messageId, part: v.part,
        ...(v.replyToId ? { metadata: JSON.stringify({ replyToId: v.replyToId }) } : {}),
        ...over,
    };
}

function refused(api: DmLineApi, v: DmLineVector, keys: DmKeys, over: Partial<DmLineRef>, what: string): void {
    let opened: OpenedDmLine;
    try { opened = api.openDmLine(v.payload, keys, refOf(v, over)); } catch { return; }
    fail(`${v.label}: ${what} opened (as format ${opened.format}, "${opened.text}")`);
}

/** Seal each vector with its fixed nonce, both key spellings, and compare; open it as both people; refuse the attacks. */
export function checkDmLineVectors(api: DmLineApi): void {
    for (const v of DM_LINE_VECTORS) {
        for (const pkcs8 of [false, true]) {
            const ctx: DmKeyContext = { ...keysOf(v.from, pkcs8), conversationId: DM_VECTOR_CONVERSATION };
            const sealed = v.format === 3
                ? api.sealDmLine(v.text, ctx, { senderPubHex: DM_VECTOR_PEOPLE[v.from].publicKey, messageId: v.messageId, part: v.part, after: v.after, replyToId: v.replyToId }, v.nonce)
                : api.encryptDmFormat2(v.text, ctx, v.nonce);
            if (sealed.ciphertext !== v.payload.ciphertext || sealed.nonce !== v.payload.nonce) {
                fail(`${v.label}: sealed with ${pkcs8 ? 'a PKCS8' : 'a bare-seed'} key, the bytes differ from the frozen line`);
            }
        }
        for (const reader of ['ana', 'ben'] as const) {
            const opened = api.openDmLine(v.payload, keysOf(reader), refOf(v));
            if (opened.text !== v.text || opened.format !== v.format || opened.after !== v.after || opened.moved) {
                fail(`${v.label}: ${reader} opened ${JSON.stringify(opened)}`);
            }
        }
        if (v.format !== 3) continue;
        const ben = keysOf('ben');
        const other = v.from === 'ana' ? 'ben' : 'ana';
        refused(api, v, ben, { senderPubHex: DM_VECTOR_PEOPLE[other].publicKey }, 'named as the other person\'s line');
        refused(api, v, ben, { messageId: '11111111-2222-4333-8444-555555555555' }, 'under another message id');
        refused(api, v, ben, { conversationId: '00000000-0000-4000-8000-000000000000' }, 'in another conversation');
        refused(api, v, ben, { part: v.part === 'body' ? 'attachment' : 'body' }, 'as the other part of its message');
        // What a reply answers is the node's to read, not to change: pointed elsewhere, dropped, or added to a line that
        // answered nothing, it doesn't open.
        refused(api, v, ben, { metadata: JSON.stringify({ replyToId: '22222222-3333-4444-8555-666666666666' }) }, 'as an answer to another message');
        if (v.replyToId) refused(api, v, ben, { metadata: null }, 'as a line that answers nothing');
        let asFormat2: OpenedDmLine | null = null;
        try { asFormat2 = api.openDmLine(v.payload, ben, refOf(v), [2]); } catch { /* as it should */ }
        if (asFormat2) fail(`${v.label}: opened as a format-2 line`);
    }
}
