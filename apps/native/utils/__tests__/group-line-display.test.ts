/**
 * The line-display rule (DESIGN-group-chat-line-display-fable.md §4, §6, §7) with real sealed lines and real succession
 * statements, against §5's served roster shape (`formerKeys` on roster rows; a node from before §5 serves none). The
 * cases that need a node moving columns run in group-chat-e2e.test.ts; the re-key cases run here, since the §5 node PR
 * (which serves `formerKeys`) lands separately.
 */
import { describe, it, expect, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((n: number) => new Uint8Array(randomBytes(n))), randomUUID: vi.fn(() => randomUUID()) }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { checkGroupCryptoVectors } from '@beanpool/core/group-line-vectors';
import { groupCryptoForVectors, sealLine, openLine, makeKeySuccession, walkKeySuccession, type FormerKey } from '../group-chat-crypto';
import {
    groupLineView, searchShownLines, earlierKeyDetails, GROUP_LINE_FORMER_MEMBER, GROUP_LINE_NOT_IN_GROUP, GROUP_LINE_UNVERIFIED_NAME,
    GROUP_LINE_UNVERIFIED_TEXT, GROUP_LINE_UNVERIFIED_DETAILS, GROUP_LINE_WAITING_KEY_TEXT, type DisplayRosterRow, type GroupLineDisplayContext,
    type ServedGroupLine,
} from '../group-line-display';
import { chatIsLocked } from '../group-chat-lines';

function person(name: string) {
    const seed = randomBytes(32);
    return { name, seedHex: bytesToHex(seed), pub: bytesToHex(ed25519.getPublicKey(seed)) };
}
const ana1 = person('Ana');
const ana2 = person('Ana');
const ana3 = person('Ana');
const mal = person('Mal');
const dov = person('Dov');
const ben = person('Ben');
const nodeOwner = person('owner');
const G = 'b1b2b3b4-c5c6-4d7d-8e8e-f9f9f9f9f9f9';
const KEY = new Uint8Array(randomBytes(32));
const AT = '2026-10-03T04:00:00.000Z';
const AT2 = '2026-10-08T04:00:00.000Z';

function line(by: { seedHex: string; pub: string }, text: string, opts: { authorPubkey?: string; authorCallsign?: string; sender?: string | null; id?: string; edit?: { by: { seedHex: string; pub: string }; text: string } } = {}): ServedGroupLine {
    const id = opts.id ?? randomUUID();
    let payload = sealLine(text, { myEdPrivHex: by.seedHex, groupKey: KEY, groupId: G, epoch: 2, messageId: id });
    let sender = opts.sender === undefined ? by.pub : opts.sender;
    let editedAt: string | null = null;
    if (opts.edit) {
        payload = sealLine(opts.edit.text, { myEdPrivHex: opts.edit.by.seedHex, groupKey: KEY, groupId: G, epoch: 2, messageId: id, part: 'edit', after: id });
        sender = opts.edit.by.pub;
        editedAt = new Date().toISOString();
    }
    return {
        id, authorPubkey: opts.authorPubkey ?? by.pub, authorCallsign: opts.authorCallsign ?? null, ciphertext: payload.ciphertext, nonce: payload.nonce,
        metadata: { epoch: 2, ...(sender ? { sender } : {}) }, editedAt, type: 'text',
    };
}

const statement = (newer: { seedHex: string }, older: { pub: string }, at = AT): FormerKey => {
    const s = makeKeySuccession({ newEdPrivHex: newer.seedHex, oldPubHex: older.pub, at });
    return { pubkey: s.pubkey, at: s.at, sig: s.sig };
};
/** A statement naming `older` as `newerPub`'s former key, signed by whoever `signer` is (what a dishonest node could serve). */
const signedBy = (signer: { seedHex: string }, older: string, newerPub: string, at = AT): FormerKey => ({
    pubkey: older, at,
    sig: Buffer.from(ed25519.sign(sha256(utf8ToBytes(JSON.stringify(['beanpool-key-succession/1', older, newerPub, at]))), Buffer.from(signer.seedHex, 'hex'))).toString('base64'),
});

function ctx(roster: DisplayRosterRow[], over: Partial<GroupLineDisplayContext> = {}): GroupLineDisplayContext {
    return { groupId: G, fromEpoch: 1, keyFor: (e) => (e === 2 ? KEY : undefined), open: openLine, roster, nodeNameOf: () => null, ...over };
}

describe('the phone\'s crypto door runs core\'s frozen vectors', () => {
    it('checkGroupCryptoVectors passes against utils/group-chat-crypto.ts', () => {
        checkGroupCryptoVectors(groupCryptoForVectors);
    });
});

describe('line display: whose name goes on a sealed line (§4, §6, §7)', () => {
    it('case 1: author column Ana, sender Mal, bytes by Mal → "Mal" (a display of the author callsign is caught)', () => {
        const v = groupLineView(line(mal, 'send the hall money to me', { authorPubkey: ana2.pub, authorCallsign: 'Ana' }),
            ctx([{ memberPubkey: ana2.pub, callsign: 'Ana' }, { memberPubkey: mal.pub, callsign: 'Mal' }]));
        expect([v.name, v.text, v.signer]).toEqual(['Mal', 'send the hall money to me', mal.pub]);
    });

    it('case 3: both tags wrong → "Unverified", no words, the §6 details', () => {
        const v = groupLineView(line(ana2, 'hi', { authorPubkey: ben.pub, sender: mal.pub }), ctx([{ memberPubkey: ana2.pub, callsign: 'Ana' }]));
        expect([v.name, v.text, v.details, v.unverified]).toEqual([GROUP_LINE_UNVERIFIED_NAME, GROUP_LINE_UNVERIFIED_TEXT, GROUP_LINE_UNVERIFIED_DETAILS, true]);
    });

    it('case 4: a legit re-key → "Ana" with "Sent from an earlier key of Ana\'s, replaced 3 Oct 2026."; one chain verify per load', () => {
        const roster = [{ memberPubkey: ana2.pub, callsign: 'Ana', formerKeys: [statement(ana2, ana1)] }];
        let walks = 0;
        const successions = new Map<string, boolean>();
        const c = ctx(roster, { successions, walk: (r, s) => { walks++; return walkKeySuccession(r, s); } });
        const views = [line(ana1, 'one', { authorPubkey: ana2.pub }), line(ana1, 'two', { authorPubkey: ana2.pub }), line(ana1, 'three', { authorPubkey: ana2.pub })].map((l) => groupLineView(l, c));
        expect(views.map((v) => [v.name, v.text, v.details])).toEqual([
            ['Ana', 'one', "Sent from an earlier key of Ana's, replaced 3 Oct 2026."],
            ['Ana', 'two', earlierKeyDetails('Ana', AT)],
            ['Ana', 'three', earlierKeyDetails('Ana', AT)],
        ]);
        expect(walks).toBe(1);
    });

    it('case 5: the pin attack — Mal\'s old key on Ana\'s row signed by Mal\'s key, by the node owner, or by Ana over another key → refused', () => {
        const malLine = line(mal, 'my old words', { authorPubkey: ana2.pub });
        const attempts: FormerKey[] = [
            signedBy(mal, mal.pub, ana2.pub),
            signedBy(nodeOwner, mal.pub, ana2.pub),
            { ...statement(ana2, ana1), pubkey: mal.pub },
        ];
        for (const f of attempts) {
            const roster = [{ memberPubkey: ana2.pub, callsign: 'Ana', formerKeys: [f] }];
            const known = groupLineView(malLine, ctx(roster, { nodeNameOf: (pk) => (pk === mal.pub ? 'Mal' : null) }));
            expect([known.name, known.nameHint]).toEqual(['Mal', GROUP_LINE_NOT_IN_GROUP]);
            const pruned = groupLineView(malLine, ctx(roster));
            expect([pruned.name, pruned.nameHint]).toEqual([GROUP_LINE_FORMER_MEMBER, null]);
        }
    });

    it('case 6: two re-keys Ana₁ → Ana₂ → Ana₃ → "Ana"; the middle statement dropped → "A former member"; a cycle refused', () => {
        const chain = [statement(ana3, ana2, AT2), statement(ana2, ana1)];
        const old = line(ana1, 'from my first phone', { authorPubkey: ana3.pub });
        expect(groupLineView(old, ctx([{ memberPubkey: ana3.pub, callsign: 'Ana', formerKeys: chain }])).name).toBe('Ana');
        expect(groupLineView(old, ctx([{ memberPubkey: ana3.pub, callsign: 'Ana', formerKeys: [chain[1]] }])).name).toBe(GROUP_LINE_FORMER_MEMBER);
        const cycle = [statement(ana3, ana2, AT2), statement(ana2, ana3)];
        expect(groupLineView(line(mal, 'x'), ctx([{ memberPubkey: ana3.pub, callsign: 'Ana', formerKeys: cycle }])).name).toBe(GROUP_LINE_FORMER_MEMBER);
    });

    it('case 7: an admin-path re-key reads "A former member" until the new phone attests, then "Ana"; "Not me" leaves it', () => {
        const old = line(ana1, 'before the re-key', { authorPubkey: ana2.pub });
        expect(groupLineView(old, ctx([{ memberPubkey: ana2.pub, callsign: 'Ana' }])).name).toBe(GROUP_LINE_FORMER_MEMBER);
        expect(groupLineView(old, ctx([{ memberPubkey: ana2.pub, callsign: 'Ana', formerKeys: [statement(ana2, ana1)] }])).name).toBe('Ana');
        expect(groupLineView(old, ctx([{ memberPubkey: ana2.pub, callsign: 'Ana', formerKeys: [] }])).name).toBe(GROUP_LINE_FORMER_MEMBER);
    });

    it('case 8: an ex-member → "Dov · no longer in this group"', () => {
        const v = groupLineView(line(dov, 'bye'), ctx([{ memberPubkey: ben.pub, callsign: 'Ben' }], { nodeNameOf: (pk) => (pk === dov.pub ? 'Dov' : null) }));
        expect([v.name, v.nameHint]).toEqual(['Dov', GROUP_LINE_NOT_IN_GROUP]);
    });

    it('case 9 (review T2): an edit after Ana\'s re-key reads "Ana"; an edit sealed by Mal on Ana\'s line reads "Unverified"', () => {
        const id = randomUUID();
        const roster = [{ memberPubkey: ana2.pub, callsign: 'Ana', formerKeys: [statement(ana2, ana1)] }, { memberPubkey: mal.pub, callsign: 'Mal' }];
        const seen = (mid: string) => (mid === id ? ana1.pub : undefined);
        const honest = groupLineView(line(ana1, 'meet at 9', { id, authorPubkey: ana2.pub, edit: { by: ana2, text: 'meet at 10' } }), ctx(roster, { signerSeen: seen }));
        expect([honest.name, honest.text]).toEqual(['Ana', 'meet at 10']);
        const forged = groupLineView(line(ana1, 'meet at 9', { id, authorPubkey: ana2.pub, edit: { by: mal, text: 'meet at the pub' } }), ctx(roster, { signerSeen: seen }));
        expect([forged.name, forged.text]).toEqual([GROUP_LINE_UNVERIFIED_NAME, GROUP_LINE_UNVERIFIED_TEXT]);
    });

    it('a line from before my membership is hidden unopened; one whose key isn\'t here yet says so and names nobody', () => {
        const l = line(ben, 'old news');
        expect(groupLineView(l, ctx([{ memberPubkey: ben.pub, callsign: 'Ben' }], { fromEpoch: 3 })).hidden).toBe(true);
        expect(groupLineView(l, ctx([{ memberPubkey: ben.pub, callsign: 'Ben' }], { fromEpoch: null })).hidden).toBe(true);
        const w = groupLineView(l, ctx([{ memberPubkey: ben.pub, callsign: 'Ben' }], { keyFor: () => undefined }));
        expect([w.waitingKey, w.text, w.name]).toEqual([true, GROUP_LINE_WAITING_KEY_TEXT, null]);
    });

    it('in-thread search filters the shown words on the phone, any case; an old node\'s chat is never called locked', () => {
        expect(searchShownLines([{ text: 'Working bee Saturday' }, { text: 'gloves' }], 'SATURDAY')).toEqual([{ text: 'Working bee Saturday' }]);
        expect(searchShownLines([{ text: 'a' }], '  ')).toEqual([{ text: 'a' }]);
        expect(chatIsLocked({ messages: [], notice: 'Visible to this group\'s members and this node\'s operator' })).toBe(false);
        expect(chatIsLocked({ messages: [], encryption: { current: null, stale: true, fromEpoch: 1 } })).toBe(true);
    });
});
