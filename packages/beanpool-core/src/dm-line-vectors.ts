/**
 * Fixed direct-message vectors, and the checks that run them: shared by core's vitest suite, the native app's runner and
 * the PWA's, each handing in ITS OWN e2e-crypto module, so all three prove the same bytes seal and open the same way.
 *
 * The lines below were sealed once and are frozen. If a change to dm-crypto.ts stops any of them opening, that change
 * has broken every message already sent: fix the change, never regenerate the vectors. (The format-2 and format-3 vectors
 * were replaced by these when format 4 came in with the 1.4.0 clean-slate cutover, which wipes every older line: Marty,
 * 10 Nov 2026. One format-3 line stays, frozen as a 1.3.x app sent it, as a line every app must refuse.)
 *
 * Kept out of the main index (import `@beanpool/core/dm-line-vectors`) so no app bundle carries it. The checks throw a
 * plain Error and depend on no test framework.
 *
 * How they were made: Ana's and Ben's seeds are SHA-256("beanpool dm-line vector: <name>"), each nonce the first 24 bytes
 * of SHA-256("beanpool dm-line vector: nonce <n>"), each signing time fixed. The bytes are re-derived from the primitives,
 * independently of dm-crypto.ts, in core's dm-crypto.test.ts.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';
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
    messageId: string;
    part: 'body' | 'attachment' | 'about';
    after: string | null;
    /** A reply: the message it answers, as its metadata names it (bound into the associated data). */
    replyToId?: string;
    text: string;
    nonce: Uint8Array;
    /** When it was signed, by the sender's clock. */
    at: string;
    /** The frozen line. */
    payload: DmPayload;
}

export const DM_LINE_VECTORS: DmLineVector[] = [
    {
        label: 'Ana\'s words, written after a line of Ben\'s',
        from: 'ana', messageId: '0c9a6b1e-2f3d-4e5a-8b7c-6d5e4f3a2b10', part: 'body',
        after: '7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a0ff', text: 'Meet at the gate at 6 — bring the seedlings 🌱',
        nonce: nonceOf(1), at: '2026-11-10T09:00:00.000Z',
        payload: {
            ciphertext: 'BIRL+7DgHZs8f7WXezQdXJ0lTlExxGd18ecBvhzu6j5Gj6iyuKQE+1cAXlPL6klyljstZn5K+imcy9tg8prI+QwyMDI2LTExLTEwVDA5OjAwOjAwLjAwMFrrZFM+CAsy7tmjzWeZwjhdLQXBj4pJQcXUtj6XKZWcK/su7WprJ3qlGFXQYJLzDNSO3Ofgdby3eI28Y9V6F7EuVUXxXQlJRiAQfrQTrREuRIhOuwlSXoY9SXmqwS85RvZBLbl5L3IQhw==',
            nonce: 'x25519-xc20p-v2:kB8B6UJCoBx05QKCjwuN3PFUHGH4qKtb',
        },
    },
    {
        label: 'Ben\'s first line, written after nothing',
        from: 'ben', messageId: '5b4a3928-1706-4f5e-9d4c-3b2a19081726', part: 'body',
        after: null, text: 'ok', nonce: nonceOf(2), at: '2026-11-10T09:01:00.000Z',
        payload: {
            ciphertext: 'BLi29tQoNoXKdAF3sVjw47nd1T/r6jXS2EYZmk8C8pWdow66vtASYXjc2Ja+n9JPPmP8Dqv7BnFuOfdsTR6apA4yMDI2LTExLTEwVDA5OjAxOjAwLjAwMFqk9YkQha6WYMteW5QIP1ZYtAoTYg==',
            nonce: 'x25519-xc20p-v2:UrLitsjP/XyW5YTWddNaMLXkymB61NVy',
        },
    },
    {
        label: 'Ana\'s photo (the attachment part)',
        from: 'ana', messageId: '0c9a6b1e-2f3d-4e5a-8b7c-6d5e4f3a2b10', part: 'attachment',
        after: null, text: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==', nonce: nonceOf(3), at: '2026-11-10T09:00:00.000Z',
        payload: {
            ciphertext: 'BGuOuIKdEc8fXiAe+mEPNIO/p6tBmKEFcQZWfN7qTlULRYvnOhpIpuIuUz4FtwvHp/AW/wUglJzR6l/jqPiesQUyMDI2LTExLTEwVDA5OjAwOjAwLjAwMFq9gMN03Dki1OciMTZLpBicjGZABGT8UQ5TK/HWNXlCkwX92GjJ5GtLnuI06HIGqL/g2LZQs5Jx9vP/PLRx',
            nonce: 'x25519-xc20p-v2:SGShD93uZ/2wstjXn7/mIGGgO9nVG+8w',
        },
    },
    {
        label: 'Ben\'s reply to Ana\'s line',
        from: 'ben', messageId: '3d2c1b0a-9f8e-4d7c-b6a5-948372615f4e', part: 'body',
        after: '0c9a6b1e-2f3d-4e5a-8b7c-6d5e4f3a2b10', replyToId: '0c9a6b1e-2f3d-4e5a-8b7c-6d5e4f3a2b10', text: 'Yes',
        nonce: nonceOf(5), at: '2026-11-10T09:02:00.000Z',
        payload: {
            ciphertext: 'BEc8NqAXLod+WpKsJEgKKeGS2FQFuaQuhi8xpab4DcUnHRiN0kkK4blK1yJHsyugRFHNnoT4c/6JAzUkv2RriwMyMDI2LTExLTEwVDA5OjAyOjAwLjAwMForbA6TEuT2h8ag7geE1bPg+aYtGHMBaKqvIWHTLwwpps4YlwoO8kE0sG7ChVQ9yzh+J4qP5smREQ4=',
            nonce: 'x25519-xc20p-v2:DWwW3W+AojGmnThKDGlsY+3tuTvnE0/1',
        },
    },
];

/** A line no app may open as its named sender's, as either person. */
export interface DmRefusedLine {
    label: string;
    /** Who the row names as its sender. */
    from: 'ana' | 'ben';
    messageId: string;
    part: 'body';
    /** The metadata the row carries, as the node would store it. */
    metadata: string | null;
    payload: DmPayload;
}

export const DM_REFUSED_LINES: DmRefusedLine[] = [
    {
        // Sealed by the format-3 code of 1.3.x (associated data 'beanpool-dm-line/3'), with the signature that version sent
        // beside it in the metadata, which verified then: 1.4.0 opens neither.
        label: 'a format-3 line of Ana\'s, as a 1.3.x app sent it, its signature beside it',
        from: 'ana', messageId: '0c9a6b1e-2f3d-4e5a-8b7c-6d5e4f3a2b10', part: 'body',
        metadata: JSON.stringify({ lineSig: { sig: 'dK//3Yyr/MCfBSOXR4ckS2PAudOa0JuIyL1lhG1ixBKzc6VvQeb35okHnF5QtExFO2RkW3syj02Jf+kvxSgXCQ==', at: '2026-11-01T09:00:00.000Z' } }),
        payload: {
            ciphertext: '7GRTPggLMu7Zo81nmcI4XS0FwY+KSUHF1LY+lymVnCv7Lu1qayd6pRhV0GCS8wzUjtzn4HW8t3iNvGPVehexLlVF8V0JSUYgEH60E60RLkSITrsJUl6GPUK6EKRFdxGu2aIJAg+0Pq0=',
            nonce: 'x25519-xc20p-v2:kB8B6UJCoBx05QKCjwuN3PFUHGH4qKtb',
        },
    },
    {
        // A forged sender: Ana sealed it naming Ben (she holds the conversation's key, so the seal opens for both of them) and
        // signed it with her own key, the only one she has. Shown as Ben's it would put words in his mouth.
        label: 'a line Ana sealed in Ben\'s name and signed herself',
        from: 'ben', messageId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', part: 'body', metadata: null,
        payload: {
            ciphertext: 'BCQ3Hj3IMbbKjysc+4d+SqzrubSyuiYmpjB0mSa6pv4qwvh4ubF8S47S72/7eT7zDjiR+4hqljfPdMSy94eNdAMyMDI2LTExLTEwVDA5OjAzOjAwLjAwMFrhXuVPYK/MhdDNwSYwGj9z49ECq806g4uLIN3kO3YiFqrOdz3Y',
            nonce: 'x25519-xc20p-v2:XNRjwOVng1FjvTUC9KRbGHsp8joCrhkU',
        },
    },
];

// ─── Old chat (conversion code, log row OLDCHAT, remove in 1.5.0) ───────────────────────────────────────────────────
/**
 * Lines as the 1.2.36 apps sealed them, frozen (sealed once by `git show v1.2.36:packages/beanpool-core/src/dm-crypto.ts`'s
 * sealDmLine and encryptDmFormat2, each nonce the first 24 bytes of SHA-256("beanpool old-chat vector: nonce <n>")), with
 * the time the node dates each: what core's checkDmThread shows read-only under DM_OLD_LINES_LABEL, in both apps' tests.
 * `DM_REFUSED_LINES[0]` (a 1.3.x line with its signature beside it) is old too.
 */
export const DM_OLD_LINE_TIMES = {
    /** Before the cutover (2026-11-11T19:16:00.000Z). */
    before: '2026-11-05T09:00:00.000Z',
    /** After it: a line in an old format dated here is hidden as today. */
    after: '2026-11-11T19:16:00.000Z',
} as const;

export interface DmOldLineFixture {
    from: 'ana' | 'ben';
    messageId: string;
    part: 'body' | 'attachment';
    text: string;
    format: 2 | 3;
    after: string | null;
    /** The row's metadata as the node stores it (a reply's replyToId). */
    metadata: string | null;
    payload: DmPayload;
}

export const DM_OLD_LINES: Record<'anaFormat3' | 'benFormat3Reply' | 'benFormat2' | 'benFormat3AfterNew' | 'anaPhotoFormat3', DmOldLineFixture> = {
    anaFormat3: {
        from: 'ana', messageId: 'a1000000-0000-4000-8000-0000000000a1', part: 'body', format: 3, after: null, metadata: null,
        text: 'See you at the market on Saturday',
        payload: { ciphertext: 'wzwS9jv+4ZzOkmOw2RwQZkwl1yT1Ien0cUDXfqMgAW3KcqK7D6RIJZ5R3tRdHMaQCT7+', nonce: 'x25519-xc20p-v2:6VEJ6xWeV80teKZlbSURivn51V4v1RPG' },
    },
    benFormat3Reply: {
        from: 'ben', messageId: 'b1000000-0000-4000-8000-0000000000b1', part: 'body', format: 3, after: 'a1000000-0000-4000-8000-0000000000a1',
        metadata: JSON.stringify({ replyToId: 'a1000000-0000-4000-8000-0000000000a1' }),
        text: 'Saturday works, 9 am',
        payload: { ciphertext: 'vrEiYuzTSwUAnMEGKE2egQ2a1pN/ohi9I2SicPv0Z0KZwDEd+t0qNpSvDKismLwjZtfMSyUNu7LkGLF4ZxsMpAfxsa3ARfYELko=', nonce: 'x25519-xc20p-v2:c4gH45GZrExuChkLMyCU9BRaBduVWhIR' },
    },
    benFormat2: {
        from: 'ben', messageId: 'b3000000-0000-4000-8000-0000000000b3', part: 'body', format: 2, after: null, metadata: null,
        text: 'From an older app: hello Ana',
        payload: { ciphertext: '1sEwoELA5nPBDjUC4L3ud8ZS2mQyPcH3sKKiHb22nGOLeCIaxj5vrM5YJ94=', nonce: 'x25519-xc20p-v2:BR08WHIzdgVdcxUofMjTSNa5DAVxvDoD' },
    },
    /** Sealed "after" c4000000-…-c4, which the tests place after the cutover: written after it, so hidden however it is dated. */
    benFormat3AfterNew: {
        from: 'ben', messageId: 'b2000000-0000-4000-8000-0000000000b2', part: 'body', format: 3, after: 'c4000000-0000-4000-8000-0000000000c4', metadata: null,
        text: 'Written after the cutover, dated before it',
        payload: { ciphertext: 'yrTuRmSlP7OFUSA6rnvVJC3TWByrpzOYJ+uQsPfunXGxx2V9Dg1+3eE5lEFwpB8/1peJjgJlm3HOWNIA6AyLsorUS14mB77BB+o3DEaLdOC25F28IZ85s5+iU6EAAHfV', nonce: 'x25519-xc20p-v2:sGBfHdYM3M5+wsGKQyOHdqeyP8lpNNt7' },
    },
    /** The photo of anaFormat3's message (its attachment part). */
    anaPhotoFormat3: {
        from: 'ana', messageId: 'a1000000-0000-4000-8000-0000000000a1', part: 'attachment', format: 3, after: null, metadata: null,
        text: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==',
        payload: { ciphertext: 'Nusq7/5x37w4bDDL1B4AABX39k5fbsKnL9hmOkM2R6lUeyBylWwtMQBJ6noEw3wlpnYgJvx9Mn5a6EHfmg==', nonce: 'x25519-xc20p-v2:xGu+UXZMTvUc9au4+KV0zmZ5cZS5yJAm' },
    },
};
// ─── end of old chat (OLDCHAT) ───────────────────────────────────────────────────────────────────────────────────────

/** The parts of an app's e2e-crypto module the vectors exercise. */
export interface DmLineApi {
    sealDmLine(text: string, ctx: DmKeyContext, line: DmLineBinding & { after?: string | null; replyToId?: string | null; at?: string }, nonceForVectors?: Uint8Array): DmPayload;
    openDmLine(payload: DmPayload, keys: DmKeys, line: DmLineRef): OpenedDmLine;
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

function refused(api: DmLineApi, label: string, payload: DmPayload, keys: DmKeys, ref: DmLineRef, what: string): void {
    let opened: OpenedDmLine;
    try { opened = api.openDmLine(payload, keys, ref); } catch { return; }
    fail(`${label}: ${what} opened ("${opened.text}")`);
}

/** The line with one byte of its ciphertext column changed, at `at` (the signature is bytes 1 to 64, its time 65 to 88). */
function withByteChanged(payload: DmPayload, at: number): DmPayload {
    const b = Buffer.from(payload.ciphertext, 'base64');
    b[at] ^= 0x01;
    return { ciphertext: b.toString('base64'), nonce: payload.nonce };
}

/**
 * Seal each vector with its fixed nonce and time, both key spellings, and compare; open it as both people; refuse the
 * attacks; refuse every line in DM_REFUSED_LINES as either person.
 */
export function checkDmLineVectors(api: DmLineApi): void {
    for (const v of DM_LINE_VECTORS) {
        for (const pkcs8 of [false, true]) {
            const ctx: DmKeyContext = { ...keysOf(v.from, pkcs8), conversationId: DM_VECTOR_CONVERSATION };
            const sealed = api.sealDmLine(v.text, ctx, {
                senderPubHex: DM_VECTOR_PEOPLE[v.from].publicKey, messageId: v.messageId, part: v.part, after: v.after, replyToId: v.replyToId, at: v.at,
            }, v.nonce);
            if (sealed.ciphertext !== v.payload.ciphertext || sealed.nonce !== v.payload.nonce) {
                fail(`${v.label}: sealed with ${pkcs8 ? 'a PKCS8' : 'a bare-seed'} key, the bytes differ from the frozen line`);
            }
        }
        for (const reader of ['ana', 'ben'] as const) {
            const opened = api.openDmLine(v.payload, keysOf(reader), refOf(v));
            if (opened.text !== v.text || opened.format !== 4 || opened.after !== v.after || opened.moved) {
                fail(`${v.label}: ${reader} opened ${JSON.stringify(opened)}`);
            }
        }
        const ben = keysOf('ben');
        const other = v.from === 'ana' ? 'ben' : 'ana';
        refused(api, v.label, v.payload, ben, refOf(v, { senderPubHex: DM_VECTOR_PEOPLE[other].publicKey }), 'named as the other person\'s line');
        refused(api, v.label, v.payload, ben, refOf(v, { messageId: '11111111-2222-4333-8444-555555555555' }), 'under another message id');
        refused(api, v.label, v.payload, ben, refOf(v, { conversationId: '00000000-0000-4000-8000-000000000000' }), 'in another conversation');
        refused(api, v.label, v.payload, ben, refOf(v, { part: v.part === 'body' ? 'attachment' : 'body' }), 'as another part of its message');
        // What a reply answers is the node's to read, not to change: pointed elsewhere, dropped, or added to a line that
        // answered nothing, it doesn't open.
        refused(api, v.label, v.payload, ben, refOf(v, { metadata: JSON.stringify({ replyToId: '22222222-3333-4444-8555-666666666666' }) }), 'as an answer to another message');
        if (v.replyToId) refused(api, v.label, v.payload, ben, refOf(v, { metadata: null }), 'as a line that answers nothing');
        // The signature is its sender's, over these bytes, then: a bit of it, or of the time it names, changed, and it doesn't.
        refused(api, v.label, withByteChanged(v.payload, 1), ben, refOf(v), 'with its signature changed');
        // The time's last digit (byte 22 of its 24): still a time, so only the signature can refuse it.
        refused(api, v.label, withByteChanged(v.payload, 1 + 64 + 22), ben, refOf(v), 'with its signing time changed');
    }
    for (const r of DM_REFUSED_LINES) {
        for (const reader of ['ana', 'ben'] as const) {
            refused(api, r.label, r.payload, keysOf(reader), {
                conversationId: DM_VECTOR_CONVERSATION, senderPubHex: DM_VECTOR_PEOPLE[r.from].publicKey, messageId: r.messageId, part: r.part, metadata: r.metadata,
            }, `opened by ${reader}`);
        }
    }
}
