/**
 * Fixed group-chat vectors, and the checks that run them: for core's vitest suite now, and for the native app's runner and
 * the PWA's when slices 3 and 4 wire them in, each handing in ITS OWN e2e-crypto module, so all three prove the same
 * bytes seal and open the same way.
 *
 * The record, the top-up and the lines below were made once and are frozen. If a change to group-crypto.ts stops any of
 * them matching or opening, that change has broken every group line already sent: fix the change, never regenerate.
 *
 * Kept out of the main index (import `@beanpool/core/group-line-vectors`) so no app bundle carries it. The checks throw a
 * plain Error and depend on no test framework.
 *
 * How they were made: each person's seed is SHA-256("beanpool group-line vector: <name>"). Randomness comes from a fixed
 * stream used only here: call i of stream <label> returns the first n bytes of
 * SHA-256("beanpool group-line vector: rng <label> <i>"). Cat joins and makes epoch 3 for Ana, Ben and herself (stream
 * 'epoch 3'); Ana tops up Dov (stream 'top-up'); each line uses stream 'line <label>'. Ed25519 signatures are
 * deterministic, so the same inputs give the same bytes. A line and a wrap are re-derived from the primitives,
 * independently of group-crypto.ts, in core's group-crypto.test.ts.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { toEd25519Pkcs8 } from './ed25519-key.js';
import type {
    GroupCryptoRandom, GroupEpochCheck, GroupEpochRecord, GroupLineBinding, GroupLinePart, GroupLinePayload, GroupTopUp,
    MakeGroupEpochInput, OpenedGroupLine, SealGroupLineInput,
} from './group-crypto.js';

const seedOf = (name: string) => sha256(utf8ToBytes(`beanpool group-line vector: ${name}`));

/** The fixed randomness stream `label`: call i gives the first n bytes of SHA-256("… rng <label> <i>"). Vectors only. */
export function groupVectorRandom(label: string): (n: number) => Uint8Array {
    let i = 0;
    return (n: number) => {
        if (n > 32) throw new Error('group-line vectors: a stream call gives at most 32 bytes');
        return sha256(utf8ToBytes(`beanpool group-line vector: rng ${label} ${i++}`)).slice(0, n);
    };
}

type Who = 'ana' | 'ben' | 'cat' | 'dov';
function personOf(name: string) {
    const seed = seedOf(name);
    return { seedHex: bytesToHex(seed), pkcs8Hex: bytesToHex(toEd25519Pkcs8(seed)), publicKey: bytesToHex(ed25519.getPublicKey(seed)) };
}
export const GROUP_VECTOR_PEOPLE: Record<Who, { seedHex: string; pkcs8Hex: string; publicKey: string }> = {
    ana: personOf('Ana'), ben: personOf('Ben'), cat: personOf('Cat'), dov: personOf('Dov'),
};
export const GROUP_VECTOR_GROUP = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
export const GROUP_VECTOR_CREATED_AT = '2026-10-10T09:30:00.000Z';

export interface GroupLineVector {
    label: string;
    from: Who;
    messageId: string;
    part: GroupLinePart;
    after: string | null;
    replyToId?: string;
    text: string;
    /** The randomness stream it was sealed with. */
    rng: string;
    /** Its message key (what a report would disclose), hex. */
    messageKeyHex: string;
    /** The frozen sealed line. */
    payload: GroupLinePayload;
}

export const GROUP_VECTOR_RECORD: GroupEpochRecord = {
    groupId: GROUP_VECTOR_GROUP,
    epoch: 3,
    reason: 'join',
    subject: '35b3cd6637a22624ba7e7ab2cfe2375b13fa59f1541b05fd36a5387412200060',
    createdBy: '35b3cd6637a22624ba7e7ab2cfe2375b13fa59f1541b05fd36a5387412200060',
    createdAt: '2026-10-10T09:30:00.000Z',
    wraps: [
        { recipient: '35b3cd6637a22624ba7e7ab2cfe2375b13fa59f1541b05fd36a5387412200060', ephPub: 'kr6eeGVxSvCf7W7h230BMEeeQLjzdkGv+vWXI4GPSV8=', nonce: 'YGga18NbayCBxCO6Ro3MqU+3YlgepouT', wrapped: 'rulIWnhxN+eE/y+7gF8RF62JlH4HZrcTqsiBl2x7dVgsU/qgz3nzhKBD4EzIGJqL' },
        { recipient: '4d3d8823dbd855a591a6f44cd2d5b5b14b37c2ed66347bd6392ca6746fe41c8a', ephPub: 'y5XG6SfQDS5PsfL5f73fPTZGfO04xV21Ql8XH8sVJ0g=', nonce: 'DiS5PrG++yhwhOA18wa9IeTBF1TQiFYK', wrapped: '0mKuerTizbuxEu73+a4HYLVTYBUiTBNlLD9dojUQcYObi2I+HHbOpBIKjkM4YzTT' },
        { recipient: '82a778ab7cfc4f3b95b0ebbc8759d72263437a8fbf752ce3b0d08843dc20be18', ephPub: 'Dta+Q+NyJvmMh4KT6z3byVecvcj5YZTJSv4BYEzo8R4=', nonce: '5AD1K1faSo1kCuFksOHuoAWFnSI8i3TL', wrapped: '7u46HZwCaD6bSHaX1CBkv09X3qCf+6RJzspIRHgutsHszFKWKA5hTSZZADAgrYXC' },
    ],
    sig: 'RHsUnAxdp/Y62dw49mCvCr59rtT4ezv+iHhAdgGtnOA+FwlznSeSYi/1XJeE4XFfppwJWMrMN62lC7P+MbmfCQ==',
};

/** The epoch key Cat made for epoch 3 (the first 32 bytes of the record's fixed RNG). */
export const GROUP_VECTOR_KEY_HEX = 'af908826c36a0f432a7ef84fa65a87ec5fbcca41274397bac52f58ff52c59d7c';

/** Ana hands Dov the epoch-3 key (Dov was re-keyed and lacks a wrap). */
export const GROUP_VECTOR_TOP_UP: GroupTopUp = {
    recipient: '0f8c46b75542d34d0222de3f7be9aad7242f5c9e6249debc58b94c7627ea0aa3',
    ephPub: 'u7xYEiGnmEEE/VxwA2oOoNP4cTAt5NGFXVTGcz1srxY=',
    nonce: 'EXceMXLJRiFlfTV0nUrsFK4bbnoiTh9b',
    wrapped: '550F/wnerYrRc2r0CUZuTpKTm90ol+b9iF2w+mK2GxZQN9roNMGEOQf2KKA08ApR',
    epoch: 3,
    wrapper: '4d3d8823dbd855a591a6f44cd2d5b5b14b37c2ed66347bd6392ca6746fe41c8a',
    sig: 'YywNuXPIu0vXoFrf765VCuhoe+5F4SwgwY1rOgaYNmKZq6/870aDERHGfdP421QDrwshNbnaA2s+ZZHyjb5NCQ==',
};

export const GROUP_LINE_VECTORS: GroupLineVector[] = [
    {
        label: "Ben's words, written after nothing",
        from: 'ben', messageId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', part: 'body', after: null,
        text: 'Working bee Saturday 9am — bring gloves 🧤',
        rng: 'line l1',
        messageKeyHex: '4105744078d3efe1e891a122886e4536198a72062e7b87e30d5a0bd593f4e7a3',
        payload: {
            ciphertext: 'n6UINMXmmY3hNm4E378+iC+c/t/9LRfu5tHATtzm/RWF8HkOl09Br7PETYxDK3vCeIOOLxWGHBFS1vAJNvJhSJ/CgEiq7GXspHgxicC/HmfHIUJI3PieIGavmz8U6Iju6QDja3KM/MkEa1EbGhrbXWQUp5LjynJugNDRr9shulM=',
            nonce: 'group-xc20p-v1:A5fJKF+VlivO16FHxk3tVQHuKHifjrNG',
        },
    },
    {
        label: "Cat's reply to Ben's line, mentioning him",
        from: 'cat', messageId: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', part: 'body', after: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', replyToId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
        text: "I'll be there, @Ben",
        rng: 'line l2',
        messageKeyHex: '0d649ea1575e4211679a332b256f227d4ed16d36c04f801a061f3483a75638e0',
        payload: {
            ciphertext: 'wT6HKDrYSHJKxOFv3XXnoSG+RkU/12Yyp5RnFqWaEoEAK9KvnF681/AgKJJ+tvV5xuukI8LkXmcm6zMkv/vZYBPZRIyrVId8zBFZI/6QEuirn5zZ34Q2EPu+D7wGvs+7uXgtqF2ztYlVQ3BD0LGmSx2NSyAya78z+vzwkT0MxepnKXcxncIhvFY=',
            nonce: 'group-xc20p-v1:giyvZ/eMGl3VP3SYy+Dia+LYJFffiGXt',
        },
    },
    {
        label: "Ana's photo (the attachment part)",
        from: 'ana', messageId: '3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f', part: 'attachment', after: null,
        text: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==',
        rng: 'line l3',
        messageKeyHex: '3995bdc9917fa849e81a91094b0ec7cc37f5508adc2195d24cdfebfb3e43c090',
        payload: {
            ciphertext: 'PSYIDS59ePpme7RbGtwM67tXpMyakmG3RBBXK22+lxYNwEK2UQCsqCXmUI8gB4CMvVlclDeb/mc/remqSZXZwXTCGvoMXzAI/NEyk5IiaRA6y/06okZZcHklz+m/9yZEFoC7FpqZs5SWZel5zI9RgJGsU+A/ismc94Rr7Ps=',
            nonce: 'group-xc20p-v1:sERCGQ8NG2UsXQK+TWjlo+E/8uPbHDnP',
        },
    },
    {
        label: "Ben's edit of his line (same id, part 'edit')",
        from: 'ben', messageId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', part: 'edit', after: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
        text: 'Working bee Saturday 10am — bring gloves 🧤',
        rng: 'line l4',
        messageKeyHex: '4105744078d3efe1e891a122886e4536198a72062e7b87e30d5a0bd593f4e7a3',
        payload: {
            ciphertext: 'Ut+L5q9c1bL+ZfyNe0hMtA1xyLPUUqqiPpvazxikSgtVppmP76/tbD9CoBWzGEoVNPI6Al4IyvwBnZCu8n8M+W5xBzNrf0HAeNysD9ravO+Et+52Evr4ROYitpX3T+8so6RMtL2EsGXOwcMn1ZTxAjwBJvC7hZofUzMb1Ym1wwx1WUf86kwAuoxAvIi19VRa5yG85Qye1i8Gr7mz0axF7AdknbHp',
            nonce: 'group-xc20p-v1:2oigPlEboiZMe0MdFBtBFpcDiFgxvE81',
        },
    },
];

/** The parts of an app's e2e-crypto module the vectors exercise. */
export interface GroupCryptoApi {
    makeGroupEpochRecord(input: MakeGroupEpochInput, opts?: GroupCryptoRandom): { record: GroupEpochRecord; groupKey: Uint8Array };
    openGroupEpochRecord(record: GroupEpochRecord, myEdPrivHex: string, check: GroupEpochCheck): Uint8Array;
    makeGroupTopUp(groupKey: Uint8Array, input: { myEdPrivHex: string; groupId: string; epoch: number; recipientPubHex: string }, opts?: GroupCryptoRandom): GroupTopUp;
    openGroupTopUp(groupId: string, t: GroupTopUp, myEdPrivHex: string): Uint8Array;
    groupMessageKey(groupKey: Uint8Array, messageId: string): Uint8Array;
    sealGroupLine(text: string, input: SealGroupLineInput, opts?: GroupCryptoRandom): GroupLinePayload;
    openGroupLine(payload: GroupLinePayload, ref: GroupLineBinding, groupKey: Uint8Array): OpenedGroupLine;
    openGroupLineWithMessageKey(payload: GroupLinePayload, ref: GroupLineBinding, messageKey: Uint8Array): OpenedGroupLine;
}

function fail(msg: string): never {
    throw new Error(`group-line vectors: ${msg}`);
}

const keyOf = (who: Who, pkcs8: boolean) => (pkcs8 ? GROUP_VECTOR_PEOPLE[who].pkcs8Hex : GROUP_VECTOR_PEOPLE[who].seedHex);
const MEMBERS: Who[] = ['ana', 'ben', 'cat'];

function refOf(v: GroupLineVector, over: Partial<GroupLineBinding> = {}): GroupLineBinding {
    return {
        groupId: GROUP_VECTOR_GROUP, epoch: GROUP_VECTOR_RECORD.epoch, senderPubHex: GROUP_VECTOR_PEOPLE[v.from].publicKey,
        messageId: v.messageId, part: v.part, replyToId: v.replyToId ?? null, ...over,
    };
}

function refused(api: GroupCryptoApi, v: GroupLineVector, key: Uint8Array, over: Partial<GroupLineBinding>, what: string): void {
    let opened: OpenedGroupLine;
    try { opened = api.openGroupLine(v.payload, refOf(v, over), key); } catch { return; }
    fail(`${v.label}: ${what} opened ("${opened.text}")`);
}

/**
 * Re-make the record, the top-up and every line from the fixed streams with both key spellings and compare the bytes;
 * open each as every member; refuse the moved and changed ones.
 */
export function checkGroupCryptoVectors(api: GroupCryptoApi): void {
    const key = hexToBytes(GROUP_VECTOR_KEY_HEX);
    const people = GROUP_VECTOR_PEOPLE;
    for (const pkcs8 of [false, true]) {
        const made = api.makeGroupEpochRecord({
            myEdPrivHex: keyOf('cat', pkcs8), groupId: GROUP_VECTOR_GROUP, epoch: 3, reason: 'join', subject: people.cat.publicKey,
            createdAt: GROUP_VECTOR_CREATED_AT, recipients: [people.ana.publicKey, people.ben.publicKey, people.cat.publicKey],
        }, { randomBytes: groupVectorRandom('epoch 3') });
        if (JSON.stringify(made.record) !== JSON.stringify(GROUP_VECTOR_RECORD)) fail(`epoch record made with ${pkcs8 ? 'a PKCS8' : 'a bare-seed'} key differs from the frozen one`);
        if (bytesToHex(made.groupKey) !== GROUP_VECTOR_KEY_HEX) fail('the epoch key differs');
        const topUp = api.makeGroupTopUp(key, { myEdPrivHex: keyOf('ana', pkcs8), groupId: GROUP_VECTOR_GROUP, epoch: 3, recipientPubHex: people.dov.publicKey },
            { randomBytes: groupVectorRandom('top-up') });
        if (JSON.stringify(topUp) !== JSON.stringify(GROUP_VECTOR_TOP_UP)) fail(`top-up made with ${pkcs8 ? 'a PKCS8' : 'a bare-seed'} key differs from the frozen one`);
        for (const who of MEMBERS) {
            const opened = api.openGroupEpochRecord(GROUP_VECTOR_RECORD, keyOf(who, pkcs8), { groupId: GROUP_VECTOR_GROUP, epoch: 3 });
            if (bytesToHex(opened) !== GROUP_VECTOR_KEY_HEX) fail(`${who} opened another key from the record`);
        }
        if (bytesToHex(api.openGroupTopUp(GROUP_VECTOR_GROUP, GROUP_VECTOR_TOP_UP, keyOf('dov', pkcs8))) !== GROUP_VECTOR_KEY_HEX) fail('Dov opened another key from the top-up');
    }
    let dovInRecord = false;
    try { api.openGroupEpochRecord(GROUP_VECTOR_RECORD, people.dov.seedHex, { groupId: GROUP_VECTOR_GROUP }); dovInRecord = true; } catch { /* as it should */ }
    if (dovInRecord) fail('Dov, who has no wrap in the record, opened it');
    let otherGroup = false;
    try { api.openGroupEpochRecord(GROUP_VECTOR_RECORD, people.ana.seedHex, { groupId: '00000000-0000-4000-8000-000000000000' }); otherGroup = true; } catch { /* as it should */ }
    if (otherGroup) fail('the record opened as another group\'s');

    for (const v of GROUP_LINE_VECTORS) {
        if (bytesToHex(api.groupMessageKey(key, v.messageId)) !== v.messageKeyHex) fail(`${v.label}: the message key differs`);
        for (const pkcs8 of [false, true]) {
            const sealed = api.sealGroupLine(v.text, {
                myEdPrivHex: keyOf(v.from, pkcs8), groupKey: key, groupId: GROUP_VECTOR_GROUP, epoch: 3, messageId: v.messageId,
                part: v.part, after: v.after, replyToId: v.replyToId,
            }, { randomBytes: groupVectorRandom(v.rng) });
            if (sealed.ciphertext !== v.payload.ciphertext || sealed.nonce !== v.payload.nonce) {
                fail(`${v.label}: sealed with ${pkcs8 ? 'a PKCS8' : 'a bare-seed'} key, the bytes differ from the frozen line`);
            }
        }
        const opened = api.openGroupLine(v.payload, refOf(v), key);
        if (opened.text !== v.text || opened.after !== v.after) fail(`${v.label}: opened ${JSON.stringify(opened)}`);
        const disclosed = api.openGroupLineWithMessageKey(v.payload, refOf(v), hexToBytes(v.messageKeyHex));
        if (disclosed.text !== v.text) fail(`${v.label}: its disclosed message key opened ${JSON.stringify(disclosed)}`);
        const other = MEMBERS.find((w) => w !== v.from)!;
        refused(api, v, key, { senderPubHex: people[other].publicKey }, 'named as another member\'s line');
        refused(api, v, key, { groupId: '00000000-0000-4000-8000-000000000000' }, 'in another group');
        refused(api, v, key, { epoch: 4 }, 'under another epoch');
        refused(api, v, key, { messageId: '11111111-2222-4333-8444-555555555555' }, 'under another message id');
        refused(api, v, key, { part: v.part === 'body' ? 'attachment' : 'body' }, 'as another part of its message');
        refused(api, v, key, { replyToId: '22222222-3333-4444-8555-666666666666' }, 'as an answer to another message');
        if (v.replyToId) refused(api, v, key, { replyToId: null }, 'as a line that answers nothing');
    }
}
