/**
 * Fixed group-chat vectors, and the checks that run them: for core's vitest suite now, and for the native app's runner and
 * the PWA's when slices 3 and 4 wire them in, each handing in ITS OWN e2e-crypto module, so all three prove the same
 * bytes seal and open the same way.
 *
 * Frozen from the first release that sends a group line (none yet). Until then, a design change regenerates these in the
 * PR that makes it, and says so here. Once a release sends group lines, a change to group-crypto.ts that stops any of
 * them matching or opening has broken every group line already sent: fix the change.
 *
 * Regenerated once, in group chats step 2 (DESIGN-group-chat-wrap-provenance-fable.md §5.4, Option C): the record gained
 * keyCommit, membersDigest and wrapsDigest, and its canonical form and signature changed. The wraps, the top-up and the
 * four lines are byte-identical to #1749's (core's group-crypto.test.ts pins that).
 *
 * Added in group photos S1 (DESIGN-group-chat-photos-fable.md §2.2, §5): GROUP_PHOTO_VECTOR, one message sealed as a
 * caption and a photo under its one message key, from streams 'line l5' and 'line l6'. Nothing above changed for it; core's
 * group-crypto.test.ts pins its bytes too.
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
import { mintGroupVectorRng } from './group-vector-rng.js';
import type {
    FormerKey, GroupCryptoRandom, GroupEpochCheck, GroupEpochRecord, GroupKeyOpenCheck, GroupLineBinding, GroupLinePart, GroupLinePayload, GroupServedWrap, GroupTopUp,
    GroupTopUpCheck, MakeGroupEpochInput, OpenedGroupLine, SealGroupLineInput,
} from './group-crypto.js';

const seedOf = (name: string) => sha256(utf8ToBytes(`beanpool group-line vector: ${name}`));

/** The fixed randomness stream `label`: call i gives the first n bytes of SHA-256("… rng <label> <i>"). Vectors only. */
export function groupVectorRandom(label: string): (n: number) => Uint8Array {
    let i = 0;
    return mintGroupVectorRng((n: number) => {
        if (n > 32) throw new Error('group-line vectors: a stream call gives at most 32 bytes');
        return sha256(utf8ToBytes(`beanpool group-line vector: rng ${label} ${i++}`)).slice(0, n);
    });
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
    keyCommit: '92d0+VuS1iJBlE7JDfyZg/u13eC8R9sv6ScgCb5yKP0=',
    membersDigest: 'q8A+79vFQ0cxPll/w0wu8lfXOM3OO3Xh892KZZTCUa0=',
    wrapsDigest: 'X4loZUuyn3YhyWNnOvhcntdSYNyytjif2ExNM05ivh8=',
    wraps: [
        { recipient: '35b3cd6637a22624ba7e7ab2cfe2375b13fa59f1541b05fd36a5387412200060', ephPub: 'kr6eeGVxSvCf7W7h230BMEeeQLjzdkGv+vWXI4GPSV8=', nonce: 'YGga18NbayCBxCO6Ro3MqU+3YlgepouT', wrapped: 'rulIWnhxN+eE/y+7gF8RF62JlH4HZrcTqsiBl2x7dVgsU/qgz3nzhKBD4EzIGJqL' },
        { recipient: '4d3d8823dbd855a591a6f44cd2d5b5b14b37c2ed66347bd6392ca6746fe41c8a', ephPub: 'y5XG6SfQDS5PsfL5f73fPTZGfO04xV21Ql8XH8sVJ0g=', nonce: 'DiS5PrG++yhwhOA18wa9IeTBF1TQiFYK', wrapped: '0mKuerTizbuxEu73+a4HYLVTYBUiTBNlLD9dojUQcYObi2I+HHbOpBIKjkM4YzTT' },
        { recipient: '82a778ab7cfc4f3b95b0ebbc8759d72263437a8fbf752ce3b0d08843dc20be18', ephPub: 'Dta+Q+NyJvmMh4KT6z3byVecvcj5YZTJSv4BYEzo8R4=', nonce: '5AD1K1faSo1kCuFksOHuoAWFnSI8i3TL', wrapped: '7u46HZwCaD6bSHaX1CBkv09X3qCf+6RJzspIRHgutsHszFKWKA5hTSZZADAgrYXC' },
    ],
    sig: 'c5Q8ghoheUDTE2wzB967jfTSWt0WlfC3B+1DhUy/sdA8PIBmsJLPOdzFWv2pkrz4nY14/U45CDf9rRtAGv4LBw==',
};

/** The epoch key Cat made for epoch 3 (the first 32 bytes of the record's fixed RNG). */
export const GROUP_VECTOR_KEY_HEX = 'af908826c36a0f432a7ef84fa65a87ec5fbcca41274397bac52f58ff52c59d7c';

/**
 * Ana was re-keyed (line-display design §5): her new key, seed SHA-256("beanpool group-line vector: Ana re-keyed"), signs
 * that her vector key was hers before it. Served on her roster row as formerKeys[0].
 */
export const GROUP_VECTOR_SUCCESSION = {
    newPubkey: '457477c10e94973111b8adb36e427abcc8001e9b967c729f8a2ffd945ba94c63',
    newSeedHex: 'e3a90d50bde145685eea0b07b19a9173ad5424afc94ff851f75cada9983e7235',
    former: {
        pubkey: '4d3d8823dbd855a591a6f44cd2d5b5b14b37c2ed66347bd6392ca6746fe41c8a',
        at: '2026-10-03T04:00:00.000Z',
        sig: 'CDayh0b7cFcbii/DJpDvLqn8x8KqwoSkJKZ5wKEpDpSqDQb4ZCvH2QRSItXjIbEdshhO6B1ficY1J4zuW1BNDw==',
    } as FormerKey,
};

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

/**
 * A group photo (photos design §2.2): ONE message sealed as two lines under its one message key. The caption is part
 * 'body' and names the newest line its sender had; the JPEG data URI (a real 2×2 one) is part 'attachment' and names
 * none. Same id, epoch, sender, group and reply; a nonce each; each signed by the sender. Ben answers Cat's line with a
 * photo; the newest line he had was Ana's.
 */
export const GROUP_PHOTO_VECTOR: { caption: GroupLineVector; photo: GroupLineVector } = {
    caption: {
        label: "Ben's photo answering Cat: its caption (part 'body')",
        from: 'ben', messageId: '4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f80', part: 'body', after: '3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f', replyToId: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',
        text: 'Gloves are on the top shelf in the shed 📷',
        rng: 'line l5',
        messageKeyHex: '35f9478af545a809f9e334452d4ad2364389295926c204e3795befc71cf49cf7',
        payload: {
            ciphertext: 'ItFAy/kAriEewYCjjTsubnt/c/nSggckuB2ahUoosDhg9M575o+ZagFuIODOmJyWeGHKMgz2zK5fr339qkMEjnq0foq8MDUFHPUEQOHysYyyM0WYiYUhVEZtS90tG38srgFOJ1ULUTBUGYC7ZhK/8SV/68t7IiJ+YxUZE2D7NICpgH+SKpqWiArrbrh7ENr3plluX96t5rdypOxhZ6kKs11v',
            nonce: 'group-xc20p-v1:YlJLjpgEv4EaeYNEQ0l3Ha58AP6+0NFb',
        },
    },
    photo: {
        label: "Ben's photo answering Cat: the photo (part 'attachment', the same message)",
        from: 'ben', messageId: '4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f80', part: 'attachment', after: null, replyToId: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',
        text: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJwAo9//2Q==',
        rng: 'line l6',
        messageKeyHex: '35f9478af545a809f9e334452d4ad2364389295926c204e3795befc71cf49cf7',
        payload: {
            ciphertext: 'KOmCeVtKSQ23n18HA1G+A4U8T4WkaB0fBY/LDw7/05REWaA03ngRs04MBbZAOW/8NX6XMR3NBxNpAa+uYbi1/7fXos4e93TK/uaayCyGQbxdEgPkpDqNwTvAX3AGmKBU8TidaXIsAhmwSVQsLaWrDiiDC93lWBgegc51uYxA0gaQLa3WIaz75e5LK+ioACZEXm6Irg65cX/S6bDK1e22ePyO9j85VAO2Uo0wL1N/H8zigEUNsIwOAfeWGyxZsscWBICXepZOn/bnuOnz40MBCXHVc744/sDRxiCeV+uRhkRJZ5uFGn7vWF3Mtq3FVMJptD25yxrelpIKSRl/k3j2OKD8QIuzHfmbAZzhgFpJD3HnUb6Ofxsl2q/Ns0FYPaGuc2eqScqD9gzBmUYIozHInXhPnCdiz+FC3ZD4v0VbBgPH3/iPHsZPrVZQuqNxonLS2w+1XeEmk7TaZSJ1LUaKnnnNMyz2E9plVkzsSzc3JfsqkooycfhlpPT2iVkTQrXaSY6C6HqV72xJ3b68Zqwyvlfr7mJscT/dCFJSUmfzPMcAoyW57MSj+hHmiw/Yy8p+RIn6xJ66Eed5WtwXWA7f9mcW2g9RdI7xyEdTVz6e1UuG63wW7dn8yST+NEHv9CMUbYeeLsMA14BL',
            nonce: 'group-xc20p-v1:WluVTGrys2n5CbniT8GvvPAYAOGP4y2O',
        },
    },
};

/** The parts of an app's e2e-crypto module the vectors exercise. */
export interface GroupCryptoApi {
    makeGroupEpochRecord(input: MakeGroupEpochInput, opts?: GroupCryptoRandom): { record: GroupEpochRecord; groupKey: Uint8Array };
    verifyGroupEpochRecord(record: GroupEpochRecord, check: GroupEpochCheck): void;
    openGroupEpochRecord(record: GroupEpochRecord, myEdPrivHex: string, check: GroupKeyOpenCheck): Uint8Array;
    openMyGroupKey(record: GroupEpochRecord, myWrap: GroupServedWrap, myEdPrivHex: string, check: GroupKeyOpenCheck): Uint8Array;
    makeGroupTopUp(groupKey: Uint8Array, input: { myEdPrivHex: string; groupId: string; epoch: number; recipientPubHex: string }, opts?: GroupCryptoRandom): GroupTopUp;
    verifyGroupTopUp(groupId: string, t: GroupTopUp, check?: GroupTopUpCheck): void;
    openGroupTopUp(groupId: string, t: GroupTopUp, myEdPrivHex: string, keyCommit: string): Uint8Array;
    groupMessageKey(groupKey: Uint8Array, messageId: string): Uint8Array;
    sealGroupLine(text: string, input: SealGroupLineInput, opts?: GroupCryptoRandom): GroupLinePayload;
    openGroupLine(payload: GroupLinePayload, ref: GroupLineBinding, groupKey: Uint8Array): OpenedGroupLine;
    openGroupLineWithMessageKey(payload: GroupLinePayload, ref: GroupLineBinding, messageKey: Uint8Array): OpenedGroupLine;
    makeKeySuccession(input: { newEdPrivHex: string; oldPubHex: string; at: string }): FormerKey & { newPubkey: string };
    verifyKeySuccession(former: FormerKey, newPubHex: string): boolean;
    walkKeySuccession(row: { memberPubkey: string; formerKeys?: readonly FormerKey[] | null }, signer: string): boolean;
}

function fail(msg: string): never {
    throw new Error(`group-line vectors: ${msg}`);
}

const keyOf = (who: Who, pkcs8: boolean) => (pkcs8 ? GROUP_VECTOR_PEOPLE[who].pkcs8Hex : GROUP_VECTOR_PEOPLE[who].seedHex);
const MEMBERS: Who[] = ['ana', 'ben', 'cat'];
const PARTS: GroupLinePart[] = ['body', 'attachment', 'edit'];
const ANOTHER_MESSAGE = '11111111-2222-4333-8444-555555555555';

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
        }, { randomBytesForVectors: groupVectorRandom('epoch 3') });
        if (JSON.stringify(made.record) !== JSON.stringify(GROUP_VECTOR_RECORD)) fail(`epoch record made with ${pkcs8 ? 'a PKCS8' : 'a bare-seed'} key differs from the frozen one`);
        if (bytesToHex(made.groupKey) !== GROUP_VECTOR_KEY_HEX) fail('the epoch key differs');
        const topUp = api.makeGroupTopUp(key, { myEdPrivHex: keyOf('ana', pkcs8), groupId: GROUP_VECTOR_GROUP, epoch: 3, recipientPubHex: people.dov.publicKey },
            { randomBytesForVectors: groupVectorRandom('top-up') });
        if (JSON.stringify(topUp) !== JSON.stringify(GROUP_VECTOR_TOP_UP)) fail(`top-up made with ${pkcs8 ? 'a PKCS8' : 'a bare-seed'} key differs from the frozen one`);
        for (const who of MEMBERS) {
            const opened = api.openGroupEpochRecord(GROUP_VECTOR_RECORD, keyOf(who, pkcs8), { groupId: GROUP_VECTOR_GROUP, epoch: 3 });
            if (bytesToHex(opened) !== GROUP_VECTOR_KEY_HEX) fail(`${who} opened another key from the record`);
        }
        const commit = GROUP_VECTOR_RECORD.keyCommit;
        if (bytesToHex(api.openGroupTopUp(GROUP_VECTOR_GROUP, GROUP_VECTOR_TOP_UP, keyOf('dov', pkcs8), commit)) !== GROUP_VECTOR_KEY_HEX) fail('Dov opened another key from the top-up');
        // The roster is checked when a top-up is stored and before sealing, never when reading (epochs-over-time design §2).
        const roster = [people.ana.publicKey, people.ben.publicKey, people.cat.publicKey, people.dov.publicKey];
        api.verifyGroupTopUp(GROUP_VECTOR_GROUP, GROUP_VECTOR_TOP_UP, { activeMembers: roster });
        api.verifyGroupEpochRecord(GROUP_VECTOR_RECORD, { groupId: GROUP_VECTOR_GROUP, epoch: 3, activeMembers: roster });
        // The served shape (GET …/keys): the record without its wraps, and my own wrap beside it.
        const { wraps, ...served } = GROUP_VECTOR_RECORD;
        for (const who of MEMBERS) {
            const w = wraps!.find((x) => x.recipient === people[who].publicKey)!;
            const mine: GroupServedWrap = { epoch: 3, wrapper: GROUP_VECTOR_RECORD.createdBy, ephPub: w.ephPub, nonce: w.nonce, wrapped: w.wrapped, sig: null };
            if (bytesToHex(api.openMyGroupKey(served, mine, keyOf(who, pkcs8), { groupId: GROUP_VECTOR_GROUP, epoch: 3 })) !== GROUP_VECTOR_KEY_HEX) fail(`${who} opened another key from the served record`);
        }
        const t = GROUP_VECTOR_TOP_UP;
        const dovServed: GroupServedWrap = { epoch: t.epoch, wrapper: t.wrapper, ephPub: t.ephPub, nonce: t.nonce, wrapped: t.wrapped, sig: t.sig };
        if (bytesToHex(api.openMyGroupKey(served, dovServed, keyOf('dov', pkcs8), { groupId: GROUP_VECTOR_GROUP })) !== GROUP_VECTOR_KEY_HEX) fail('Dov opened another key from his served top-up');
    }
    let otherCommit = false;
    try { api.openGroupTopUp(GROUP_VECTOR_GROUP, GROUP_VECTOR_TOP_UP, people.dov.seedHex, GROUP_VECTOR_RECORD.membersDigest); otherCommit = true; } catch { /* as it should */ }
    if (otherCommit) fail('the top-up opened against another key commitment');
    let dovInRecord = false;
    try { api.openGroupEpochRecord(GROUP_VECTOR_RECORD, people.dov.seedHex, { groupId: GROUP_VECTOR_GROUP }); dovInRecord = true; } catch { /* as it should */ }
    if (dovInRecord) fail('Dov, who has no wrap in the record, opened it');
    let otherGroup = false;
    try { api.openGroupEpochRecord(GROUP_VECTOR_RECORD, people.ana.seedHex, { groupId: '00000000-0000-4000-8000-000000000000' }); otherGroup = true; } catch { /* as it should */ }
    if (otherGroup) fail('the record opened as another group\'s');
    let outsideRoster = false;
    try { api.verifyGroupTopUp(GROUP_VECTOR_GROUP, GROUP_VECTOR_TOP_UP, { activeMembers: [people.ben.publicKey, people.cat.publicKey, people.dov.publicKey] }); outsideRoster = true; } catch { /* as it should */ }
    if (outsideRoster) fail('the top-up verified for storing though its wrapper is in no roster given');

    // Ana's succession statement: made by her new key in either spelling, byte-identical; verified; walked from her row.
    const succ = GROUP_VECTOR_SUCCESSION;
    for (const pkcs8 of [false, true]) {
        const newKey = pkcs8 ? bytesToHex(toEd25519Pkcs8(hexToBytes(succ.newSeedHex))) : succ.newSeedHex;
        const made = api.makeKeySuccession({ newEdPrivHex: newKey, oldPubHex: succ.former.pubkey, at: succ.former.at });
        if (made.sig !== succ.former.sig || made.newPubkey !== succ.newPubkey) fail(`the succession statement made with ${pkcs8 ? 'a PKCS8' : 'a bare-seed'} key differs`);
    }
    if (!api.verifyKeySuccession(succ.former, succ.newPubkey)) fail('the succession statement does not verify');
    if (api.verifyKeySuccession(succ.former, people.ben.publicKey)) fail('the succession statement verified as signed by another key');
    if (api.verifyKeySuccession({ ...succ.former, at: '2026-10-04T04:00:00.000Z' }, succ.newPubkey)) fail('the statement verified with another date');
    if (!api.walkKeySuccession({ memberPubkey: succ.newPubkey, formerKeys: [succ.former] }, people.ana.publicKey)) fail("Ana's old key did not walk to her new one");
    if (api.walkKeySuccession({ memberPubkey: people.ben.publicKey, formerKeys: [succ.former] }, people.ana.publicKey)) fail("Ana's old key walked to Ben");

    for (const v of GROUP_LINE_VECTORS) checkLine(api, key, v);
    checkGroupPhotoVector(api);
}

/** One frozen line: its message key; re-sealed byte-identically with both key spellings; opened; refused when moved. */
function checkLine(api: GroupCryptoApi, key: Uint8Array, v: GroupLineVector): void {
    if (bytesToHex(api.groupMessageKey(key, v.messageId)) !== v.messageKeyHex) fail(`${v.label}: the message key differs`);
    for (const pkcs8 of [false, true]) {
        const sealed = api.sealGroupLine(v.text, {
            myEdPrivHex: keyOf(v.from, pkcs8), groupKey: key, groupId: GROUP_VECTOR_GROUP, epoch: 3, messageId: v.messageId,
            part: v.part, after: v.after, replyToId: v.replyToId,
        }, { randomBytesForVectors: groupVectorRandom(v.rng) });
        if (sealed.ciphertext !== v.payload.ciphertext || sealed.nonce !== v.payload.nonce) {
            fail(`${v.label}: sealed with ${pkcs8 ? 'a PKCS8' : 'a bare-seed'} key, the bytes differ from the frozen line`);
        }
    }
    const opened = api.openGroupLine(v.payload, refOf(v), key);
    if (opened.text !== v.text || opened.after !== v.after) fail(`${v.label}: opened ${JSON.stringify(opened)}`);
    const disclosed = api.openGroupLineWithMessageKey(v.payload, refOf(v), hexToBytes(v.messageKeyHex));
    if (disclosed.text !== v.text) fail(`${v.label}: its disclosed message key opened ${JSON.stringify(disclosed)}`);
    const other = MEMBERS.find((w) => w !== v.from)!;
    refused(api, v, key, { senderPubHex: GROUP_VECTOR_PEOPLE[other].publicKey }, 'named as another member\'s line');
    refused(api, v, key, { groupId: '00000000-0000-4000-8000-000000000000' }, 'in another group');
    refused(api, v, key, { epoch: 4 }, 'under another epoch');
    refused(api, v, key, { messageId: ANOTHER_MESSAGE }, 'under another message id');
    refused(api, v, key, { part: v.part === 'body' ? 'attachment' : 'body' }, 'as another part of its message');
    refused(api, v, key, { replyToId: '22222222-3333-4444-8555-666666666666' }, 'as an answer to another message');
    if (v.replyToId) refused(api, v, key, { replyToId: null }, 'as a line that answers nothing');
}

/**
 * The group photo (GROUP_PHOTO_VECTOR): both lines checked as any line is, and refused as each other part; the message's
 * one key opens both; that key opens nothing sealed under another message id (every other frozen line, and this photo
 * re-sealed with only its id changed), under that line's own id or under this one; and no other message's key opens either.
 */
export function checkGroupPhotoVector(api: GroupCryptoApi): void {
    const key = hexToBytes(GROUP_VECTOR_KEY_HEX);
    const { caption, photo } = GROUP_PHOTO_VECTOR;
    if (caption.part !== 'body' || photo.part !== 'attachment') fail('the photo pair is a caption (part body) and a photo (part attachment)');
    if (caption.messageId !== photo.messageId || caption.from !== photo.from || caption.replyToId !== photo.replyToId || caption.messageKeyHex !== photo.messageKeyHex) {
        fail('the caption and the photo are not one message: the same id, sender, reply and key');
    }
    if (caption.payload.nonce === photo.payload.nonce) fail('the caption and the photo share a nonce under one key');
    for (const v of [caption, photo]) {
        checkLine(api, key, v);
        for (const part of PARTS) if (part !== v.part) refused(api, v, key, { part }, 'as another part of its message');
    }
    const mk = hexToBytes(photo.messageKeyHex);
    for (const v of [caption, photo]) {
        const opened = api.openGroupLineWithMessageKey(v.payload, refOf(v), mk);
        if (opened.text !== v.text || opened.after !== v.after) fail(`${v.label}: the message's one key opened ${JSON.stringify(opened)}`);
    }
    const resealed: GroupLineVector = {
        ...photo, label: "Ben's photo re-sealed under another message id", messageId: ANOTHER_MESSAGE,
        messageKeyHex: bytesToHex(api.groupMessageKey(key, ANOTHER_MESSAGE)),
        payload: api.sealGroupLine(photo.text, {
            myEdPrivHex: keyOf(photo.from, false), groupKey: key, groupId: GROUP_VECTOR_GROUP, epoch: 3, messageId: ANOTHER_MESSAGE,
            part: photo.part, after: photo.after, replyToId: photo.replyToId,
        }, { randomBytesForVectors: groupVectorRandom(photo.rng) }),
    };
    if (api.openGroupLine(resealed.payload, refOf(resealed), key).text !== photo.text) fail(`${resealed.label}: it did not open under its own id`);
    for (const other of [...GROUP_LINE_VECTORS, resealed]) {
        for (const ref of [refOf(other), refOf(other, { messageId: photo.messageId })]) {
            let opened: OpenedGroupLine | undefined;
            try { opened = api.openGroupLineWithMessageKey(other.payload, ref, mk); } catch { /* as it should */ }
            if (opened) fail(`${other.label}: opened with the photo message's key, named as message ${ref.messageId}`);
        }
        for (const v of [caption, photo]) {
            let opened: OpenedGroupLine | undefined;
            try { opened = api.openGroupLineWithMessageKey(v.payload, refOf(v), hexToBytes(other.messageKeyHex)); } catch { /* as it should */ }
            if (opened) fail(`${v.label}: opened with the message key of ${other.label}`);
        }
    }
}
