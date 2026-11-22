/**
 * Let in once on the web (S5 part 3: scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3 "Let in once"): core's rule
 * (packages/beanpool-core/src/let-in.ts, its own table) over the facts the web reads of its one community.
 *
 *   1  one table, the core table's facts as the web reads them (its chat list and a chat's lines, friends, deals,
 *      payments, the contacts this browser keeps) x what else holds {nothing, blocked on this community's list, unblocked
 *      in this page, a block list that can't be read, their key a re-keyed person's former one, the chat list's read
 *      failed or refused} -> lib/let-in.ts letInOnWeb: let in, not, or not known this round
 *   2  what is read, and when: once a round; a chat's lines and the contacts only when nothing cheaper lets them in; this
 *      community's members only for a link made here, only the key asked
 *   3  a contact link made here counts only while this community lists its key (#3366 review F1: a re-key's old key)
 *   4  each read x {no answer, a 5xx, a 429, 408, 401, a 403, 404, 400}: a read that failed is "not known this round",
 *      a refusal "not" (#3366 review F2)
 *   5  through the real round (lib/outside-mail.ts syncOutsideMail, core gateOutsideItem): a first line across from
 *      someone let in opens a chat with the door closed and is receipted now; a stranger is dropped; a block beats it;
 *      while a read failed, the line the door would drop waits at the server, unconfirmed, and the round goes on
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { DM_FROM_ADMINS_KEY, DM_NONCE_PREFIX, ed25519Signer, relayConversationId, relayPayloadHash, sealOutsideLine, signRelayEnvelope, type RelayItem } from '@beanpool/core';
import { MemoryIDBKeyRange, memoryIndexedDB } from './memory-indexeddb';

const server = vi.hoisted(() => ({ held: [] as any[], receipts: [] as Array<{ to: string; ids: string[] }>, more: false, pages: 0 }));

vi.mock('./api', async (importOriginal) => {
    const core = await import('@beanpool/core');
    const { hexToBytes } = await import('@noble/hashes/utils.js');
    const real = await importOriginal<typeof import('./api')>();
    return {
        ...real,
        signAddressCardFor: (c: any, id: any) => core.signAddressCard(c, core.ed25519Signer(hexToBytes(id.privateKey))),
        signRelayEnvelopeFor: (f: any, id: any) => core.signRelayEnvelope(f, core.ed25519Signer(hexToBytes(id.privateKey))),
        signedMailFetch: vi.fn(async (method: string, _community: string, path: string, body: any) => {
            if (method === 'GET') {
                if (path.startsWith('/api/mail?')) server.pages++;
                return new Response(JSON.stringify({ items: server.held, more: server.more, outbox: [], outboxMore: false }), { status: 200 });
            }
            if (path === '/api/mail/confirm') {
                server.held = server.held.filter((h) => !body.ids.includes(h.envelope.itemId));
                return new Response(JSON.stringify({ confirmed: body.ids.length }), { status: 200 });
            }
            if (path === '/api/mail/send') {
                for (const i of body.items) if (i.envelope.kind === 'receipt') server.receipts.push({ to: i.envelope.recipient, ids: JSON.parse(i.payload).items });
                return new Response(JSON.stringify({ items: body.items.map((i: RelayItem) => ({ itemId: i.envelope.itemId, state: 'sent' })) }), { status: 200 });
            }
            return new Response('{}', { status: 404 });
        }),
    };
});
vi.mock('./visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(async () => ({ features: { outsideMessages: true } })) }));
vi.mock('./identity', () => ({ loadIdentity: vi.fn(async () => null) }));
vi.mock('./blocklist', () => ({ getBlocklistStatus: () => ({ loaded: true, error: null }), isUserBlocked: () => false, loadBlocklist: async () => [], unblockedInThisPage: () => false }));

import { clearOutsideChats, outsideChatStore } from './outside-chat-store';
import { setDoor, syncOutsideMail, type OutsideMailContext } from './outside-mail';
import { setNodeApiUrl } from './api';
import { resetAccountEpochForTest } from './account-epoch';
import { letInOnWeb, type WebLetInReads } from './let-in';

const seedKey = () => { const seed = ed25519.utils.randomSecretKey(); return { seed: bytesToHex(seed), key: bytesToHex(ed25519.getPublicKey(seed)) }; };
const BEN = seedKey(), SOL = seedKey(), NEW = seedKey(), CY = seedKey();
const ME = BEN.key, THEM = SOL.key, OTHER = CY.key;
const SEALED = `${DM_NONCE_PREFIX}abc`;
const B = 'https://b.example';

/** Another community, where a contact link can be made too. */
const A = 'https://a.example';

/** What this community answers the member, as the web reads it; each read counted. */
interface Facts {
    conversations?: any[];
    requests?: any[];
    lines?: Record<string, any[]>;
    friends?: any[];
    deals?: any[];
    payments?: any[];
    /** The contacts' links: a key alone is a link made in another community (A); one made here names B. */
    contacts?: Array<string | { key: string; community: string }>;
    /** The keys this community lists as members now (the directory's keys form). */
    members?: string[];
}
type ReadName = 'conversations' | 'lines' | 'friends' | 'deals' | 'payments' | 'members';
/** What a read throws instead of answering: no answer at all, or the node's refusal with its status. */
const noAnswer = () => new TypeError('Failed to fetch');
const status = (n: number) => Object.assign(new Error(`HTTP ${n}`), { status: n });
let reads: Record<string, number>;
let membersAsked: string[][];
function readsOf(f: Facts, broken: Partial<Record<ReadName, () => unknown>> = {}): WebLetInReads {
    const count = (k: ReadName | 'contacts') => {
        reads[k] = (reads[k] ?? 0) + 1;
        const thrown = k !== 'contacts' && broken[k];
        if (thrown) throw thrown();
    };
    return {
        conversations: async () => {
            count('conversations');
            return { conversations: f.conversations ?? [], totalUnread: 0, ...(f.requests ? { requests: { count: f.requests.length, conversations: f.requests } } : {}) } as any;
        },
        lines: async (id) => { count('lines'); return { messages: f.lines?.[id] ?? [] }; },
        friends: async () => { count('friends'); return (f.friends ?? []) as any; },
        deals: async () => { count('deals'); return f.deals ?? []; },
        payments: async () => { count('payments'); return f.payments ?? []; },
        contacts: async () => {
            count('contacts');
            return { contacts: (f.contacts ?? []).map((l) => ({ links: [typeof l === 'string' ? { key: l, community: A } : l] })) };
        },
        members: async (keys) => {
            membersAsked.push([...keys]);
            count('members');
            return keys.filter((k) => (f.members ?? []).includes(k)).map((publicKey) => ({ publicKey }));
        },
        community: () => B,
    };
}

const dm = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'dm', participants: [ME, THEM], name: null, createdBy: ME, createdAt: '', ...extra });
const line = (author: string, extra: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), authorPubkey: author, nonce: SEALED, type: 'text', ...extra });

interface Source { name: string; facts: Facts; letsIn: boolean }
/** The core table's facts, as the web reads them. */
const SOURCES: Source[] = [
    { name: 'a direct chat the member wrote a line in', facts: { conversations: [dm('c1')], lines: { c1: [line(THEM), line(ME)] } }, letsIn: true },
    { name: 'a direct chat whose request the member accepted', facts: { conversations: [dm('c1', { request: { state: 'accepted', from: THEM, at: '', acceptedByYou: true } })] }, letsIn: true },
    { name: 'a friend the member added', facts: { friends: [{ publicKey: THEM, callsign: 'Sol', addedAt: '', isGuardian: false }] }, letsIn: true },
    { name: 'a deal the member bought in', facts: { deals: [{ buyerPublicKey: ME, sellerPublicKey: THEM, status: 'completed', postAuthorPublicKey: THEM }] }, letsIn: true },
    { name: 'a deal the member sold in on the buyer\'s own Need', facts: { deals: [{ buyerPublicKey: THEM, sellerPublicKey: ME, status: 'pending', postAuthorPublicKey: THEM }] }, letsIn: true },
    { name: 'someone the member paid', facts: { payments: [{ from: ME, to: THEM }] }, letsIn: true },
    { name: 'a private contact the member linked', facts: { contacts: [THEM] }, letsIn: true },
    { name: 'a private contact the member linked here, a member here now', facts: { contacts: [{ key: THEM, community: B }], members: [THEM] }, letsIn: true },
    { name: 'a private contact the member linked here, no longer a member here', facts: { contacts: [{ key: THEM, community: B }] }, letsIn: false },
    { name: 'nothing at all', facts: {}, letsIn: false },
    { name: 'a direct chat only they wrote in', facts: { conversations: [dm('c1')], lines: { c1: [line(THEM)] } }, letsIn: false },
    { name: 'a request accepted, not by the member\'s act', facts: { conversations: [dm('c1', { request: { state: 'accepted', from: ME, at: '' } })] }, letsIn: false },
    { name: 'a request waiting for the member', facts: { requests: [dm('c1', { request: { state: 'pending', from: THEM, at: '' } })] }, letsIn: false },
    { name: 'a node notice in the member\'s name', facts: { conversations: [dm('c1')], lines: { c1: [line(ME, { type: 'system' })] } }, letsIn: false },
    { name: 'the admin page\'s message in the member\'s name', facts: { conversations: [dm('c1')], lines: { c1: [line(ME, { nonce: 'plaintext-v1', metadata: JSON.stringify({ [DM_FROM_ADMINS_KEY]: true }) })] } }, letsIn: false },
    { name: 'a group chat the member wrote in', facts: { conversations: [dm('g1', { type: 'group_thread' })], lines: { g1: [line(ME)] } }, letsIn: false },
    { name: 'a chat the member wrote in with two others', facts: { conversations: [dm('c1', { participants: [ME, THEM, OTHER] })], lines: { c1: [line(ME)] } }, letsIn: false },
    { name: 'a deal the member only asked for', facts: { deals: [{ buyerPublicKey: ME, sellerPublicKey: THEM, status: 'requested', postAuthorPublicKey: THEM }] }, letsIn: false },
    { name: 'a deal on the member\'s own Offer', facts: { deals: [{ buyerPublicKey: THEM, sellerPublicKey: ME, status: 'completed', postAuthorPublicKey: ME }] }, letsIn: false },
    { name: 'a payment they sent the member', facts: { payments: [{ from: THEM, to: ME }] }, letsIn: false },
    { name: 'a contact linked to someone else', facts: { contacts: [OTHER] }, letsIn: false },
];

/** `want`: the answer for a source that does (or doesn't) let them in; null is "not known this round". */
interface Column { name: string; want: (letsIn: boolean) => boolean | null; blocked?: (k: string) => Promise<boolean>; facts?: (f: Facts) => Facts; broken?: Partial<Record<ReadName, () => unknown>> }
const COLUMNS: Column[] = [
    { name: 'nothing else', want: (letsIn) => letsIn },
    { name: 'blocked on this community\'s list', want: () => false, blocked: async (k) => k === THEM },
    { name: 'the block list can\'t be read', want: () => false, blocked: async () => { throw new Error('not read'); } },
    {
        name: 'their key is a re-keyed person\'s former one', want: () => false,
        facts: (f) => ({ ...f, conversations: [...(f.conversations ?? []), { ...dm('c9', { participants: [ME, NEW.key] }), formerKeys: { [NEW.key]: [{ pubkey: THEM, at: '', sig: '' }] } }] }),
    },
    // With the chat list unread its former keys are unknown, so nobody is let in: not known this round when the read failed,
    // not let in when it was refused (#3366 review F2).
    { name: 'the chat list read failed (no answer)', want: () => null, broken: { conversations: noAnswer } },
    { name: 'the chat list refused (a 403)', want: () => false, broken: { conversations: () => status(403) } },
];

beforeEach(() => { reads = {}; membersAsked = []; });

describe('let in once on the web: the core table\'s facts as the web reads them x what else holds', () => {
    for (const source of SOURCES) {
        for (const column of COLUMNS) {
            const want = column.want(source.letsIn);
            it(`${source.name} | ${column.name} -> ${want === null ? 'not known this round' : want ? 'let in' : 'not'}`, async () => {
                const facts = column.facts ? column.facts(source.facts) : source.facts;
                const letIn = letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, column.blocked ?? (async () => false), readsOf(facts, column.broken));
                expect(await letIn(THEM)).toBe(want);
            });
        }
    }
});

describe('what is read, and when', () => {
    it('once a round, however many ask; the lines and the contacts only when nothing cheaper lets them in', async () => {
        const letIn = letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, async () => false, readsOf({ friends: [{ publicKey: THEM }], conversations: [dm('c1')] }));
        expect(await letIn(THEM)).toBe(true);
        expect(await letIn(THEM)).toBe(true);
        expect(reads).toEqual({ conversations: 1, friends: 1, deals: 1, payments: 1 });
        // Someone no fact names: their chat's lines (none with them), then the contacts, each once.
        expect(await letIn(OTHER)).toBe(false);
        expect(await letIn(OTHER)).toBe(false);
        expect(reads).toEqual({ conversations: 1, friends: 1, deals: 1, payments: 1, contacts: 1 });
    });

    it('a chat\'s lines are read once a round, only for a chat with the person asked about', async () => {
        const letIn = letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, async () => false, readsOf({ conversations: [dm('c1'), dm('c2', { participants: [ME, OTHER] })], lines: { c1: [line(ME)] } }));
        expect(await letIn(THEM)).toBe(true);
        expect(await letIn(THEM)).toBe(true);
        expect(reads.lines).toBe(1);
        expect(reads.contacts).toBeUndefined();
    });

    it('a blocked sender is not read about at all; nor the member themselves', async () => {
        const letIn = letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, async (k) => k === THEM, readsOf({ friends: [{ publicKey: THEM }] }));
        expect(await letIn(THEM)).toBe(false);
        expect(await letIn(ME)).toBe(false);
        expect(reads).toEqual({});
    });

    it('this community\'s members: only the key asked, once a round, and only for a link made here that nothing cheaper lets in', async () => {
        const letIn = letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, async () => false, readsOf({
            contacts: [{ key: THEM, community: B }, { key: OTHER, community: B }, NEW.key], friends: [{ publicKey: OTHER }], members: [THEM, OTHER],
        }));
        expect(await letIn(THEM)).toBe(true);
        expect(await letIn(THEM)).toBe(true);
        // A friend (a fact), and a link made in another community: neither asks this community's members.
        expect(await letIn(OTHER)).toBe(true);
        expect(await letIn(NEW.key)).toBe(true);
        expect(membersAsked).toEqual([[THEM]]);
        expect(reads.contacts).toBe(1);
    });
});

/**
 * #3366 review F1, its rows: Sam's phone was lost and an admin here re-keyed him from K1 (THEM) to K2 (NEW). The node moved
 * every fact the web reads to K2 (key-move.ts: the chat, the friend row); only the member's own contact link, made here,
 * still names K1. Attested, the chat list's `formerKeys` names K1; an admin's re-key is not attested until Sam confirms it.
 */
describe('a contact link made here counts only while this community lists its key (#3366 review F1)', () => {
    const K1 = THEM, K2 = NEW.key;
    const chatWithK2 = (attested: boolean) => ({
        ...dm('c1', { participants: [ME, K2], request: { state: 'accepted', from: K2, at: '', acceptedByYou: true } }),
        ...(attested ? { formerKeys: { [K2]: [{ pubkey: K1, at: '', sig: '' }] } } : {}),
    });
    const ROWS: Array<{ name: string; facts: Facts; k1: boolean | null; k2: boolean; asked: string[][] }> = [
        { name: 'unattested re-key, a link made here under the old key', facts: { conversations: [chatWithK2(false)], contacts: [{ key: K1, community: B }], members: [K2] }, k1: false, k2: true, asked: [[K1]] },
        { name: 'attested re-key, the same link: barred by formerKeys, never asked', facts: { conversations: [chatWithK2(true)], contacts: [{ key: K1, community: B }], members: [K2] }, k1: false, k2: true, asked: [] },
        { name: 'unattested re-key, no contact link: as before', facts: { conversations: [chatWithK2(false)], members: [K2] }, k1: false, k2: true, asked: [] },
        { name: 'no chat with them here (a friend row, now K2), a link made here under the old key', facts: { friends: [{ publicKey: K2 }], contacts: [{ key: K1, community: B }], members: [K2] }, k1: false, k2: true, asked: [[K1]] },
        { name: 'a link made here, its address spelled with a capital and a slash: still here', facts: { friends: [{ publicKey: K2 }], contacts: [{ key: K1, community: 'https://B.example/' }], members: [K2] }, k1: false, k2: true, asked: [[K1]] },
        { name: 'a link made here whose key is still a member here', facts: { contacts: [{ key: K1, community: B }], members: [K1] }, k1: true, k2: false, asked: [[K1]] },
        { name: 'a link made in another community: the web reads no other community, as on the phone', facts: { friends: [{ publicKey: K2 }], contacts: [K1], members: [K2] }, k1: true, k2: true, asked: [] },
    ];
    for (const row of ROWS) {
        it(`${row.name} -> K1 ${row.k1 ? 'let in' : 'not'}, K2 ${row.k2 ? 'let in' : 'not'}`, async () => {
            const letIn = letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, async () => false, readsOf(row.facts));
            expect([await letIn(K1), await letIn(K2)]).toEqual([row.k1, row.k2]);
            expect(membersAsked).toEqual(row.asked);
        });
    }

    it('a link made here, the members read failed: not known this round; refused: not let in', async () => {
        const facts: Facts = { contacts: [{ key: K1, community: B }], members: [K1] };
        expect(await letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, async () => false, readsOf(facts, { members: noAnswer }))(K1)).toBeNull();
        expect(await letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, async () => false, readsOf(facts, { members: () => status(503) }))(K1)).toBeNull();
        expect(await letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, async () => false, readsOf(facts, { members: () => status(403) }))(K1)).toBe(false);
    });
});

/**
 * #3366 review F2: a read that failed (no answer, a 5xx, a 401, 408, 425 or 429) is not "not let in": where the facts read
 * don't let them in, the answer is null, not known this round. A refusal (any other 4xx) lets nobody in by that fact.
 */
describe('a read that failed is told apart from not let in (#3366 review F2)', () => {
    /** For each read, facts that let them in only through it. */
    const ONLY_THROUGH: Record<ReadName, Facts> = {
        conversations: { conversations: [dm('c1', { request: { state: 'accepted', from: THEM, at: '', acceptedByYou: true } })] },
        lines: { conversations: [dm('c1')], lines: { c1: [line(ME)] } },
        friends: { friends: [{ publicKey: THEM }] },
        deals: { deals: [{ buyerPublicKey: ME, sellerPublicKey: THEM, status: 'completed', postAuthorPublicKey: THEM }] },
        payments: { payments: [{ from: ME, to: THEM }] },
        members: { contacts: [{ key: THEM, community: B }], members: [THEM] },
    };
    const ERRORS: Array<{ name: string; thrown: () => unknown; mayPass: boolean }> = [
        { name: 'no answer', thrown: noAnswer, mayPass: true },
        { name: 'a 500', thrown: () => status(500), mayPass: true },
        { name: 'a 503', thrown: () => status(503), mayPass: true },
        { name: 'a 429', thrown: () => status(429), mayPass: true },
        { name: 'a 408', thrown: () => status(408), mayPass: true },
        { name: 'a 401 (a clock that is off)', thrown: () => status(401), mayPass: true },
        { name: 'a 403 (a visitor\'s)', thrown: () => status(403), mayPass: false },
        { name: 'a 404', thrown: () => status(404), mayPass: false },
        { name: 'a 400', thrown: () => status(400), mayPass: false },
    ];
    for (const [read, facts] of Object.entries(ONLY_THROUGH) as Array<[ReadName, Facts]>) {
        for (const e of ERRORS) {
            const want = e.mayPass ? null : false;
            const broken: Partial<Record<ReadName, () => unknown>> = {};
            broken[read] = e.thrown;
            it(`only ${read} lets them in, that read ${e.name} -> ${want === null ? 'not known this round' : 'not'}`, async () => {
                const letIn = letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, async () => false, readsOf(facts, broken));
                expect(await letIn(THEM)).toBe(want);
            });
            // Another fact lets them in: let in, whatever this read did. Only the chat list is needed for everyone (its former keys).
            const other: Facts = read === 'payments' ? { ...facts, friends: [{ publicKey: THEM }] } : { ...facts, payments: [{ from: ME, to: THEM }] };
            const wantOther = read === 'conversations' ? want : true;
            it(`${read} ${e.name}, another fact lets them in -> ${wantOther === null ? 'not known this round' : wantOther ? 'let in' : 'not'}`, async () => {
                const letIn = letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, async () => false, readsOf(other, broken));
                expect(await letIn(THEM)).toBe(wantOther);
            });
        }
    }

    it('a failed read beside a known bar: a former key, a block, the member: not let in, known', async () => {
        const broken = { friends: noAnswer };
        const former = { conversations: [{ ...dm('c9', { participants: [ME, NEW.key] }), formerKeys: { [NEW.key]: [{ pubkey: THEM, at: '', sig: '' }] } }] };
        expect(await letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, async () => false, readsOf(former, broken))(THEM)).toBe(false);
        expect(await letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, async (k) => k === THEM, readsOf({}, broken))(THEM)).toBe(false);
        expect(await letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, async () => false, readsOf({}, broken))(ME)).toBe(false);
    });

    it('a stranger while a read failed: not known this round (that read might have let them in); with every read good: not', async () => {
        expect(await letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, async () => false, readsOf({}, { deals: () => status(502) }))(THEM)).toBeNull();
        expect(await letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, async () => false, readsOf({}))(THEM)).toBe(false);
    });

    it('a failed read is asked once a round, not again for each line', async () => {
        const letIn = letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, async () => false, readsOf({}, { friends: noAnswer }));
        expect(await letIn(THEM)).toBeNull();
        expect(await letIn(THEM)).toBeNull();
        expect(await letIn(OTHER)).toBeNull();
        expect(reads.friends).toBe(1);
    });
});

describe('through the real round: the web\'s across gate takes let in', () => {
    let ctx: OutsideMailContext;
    let blocked: Set<string>;

    beforeEach(async () => {
        server.held = []; server.receipts = []; server.more = false; server.pages = 0;
        vi.stubGlobal('indexedDB', memoryIndexedDB());
        vi.stubGlobal('IDBKeyRange', MemoryIDBKeyRange);
        await clearOutsideChats();
        localStorage.clear();
        setNodeApiUrl(B);
        resetAccountEpochForTest();
        blocked = new Set();
    });

    function contextLettingIn(facts: Facts, broken: Partial<Record<ReadName, () => unknown>> = {}): OutsideMailContext {
        const isBlocked = async (k: string) => blocked.has(k);
        return {
            nodeUrl: B, identity: { publicKey: ME, privateKey: BEN.seed, callsign: 'Ben' }, store: outsideChatStore(B), isBlocked,
            letIn: letInOnWeb({ publicKey: ME, privateKey: BEN.seed }, isBlocked, readsOf(facts, broken)),
        };
    }

    async function heldLine(from: { seed: string; key: string }, memberHere = false) {
        const itemId = crypto.randomUUID();
        const payload = sealOutsideLine({ text: 'Hello from the hills', name: 'Sol', myEdPrivHex: from.seed, myKey: from.key, peerKey: ME, messageId: itemId });
        const envelope = await signRelayEnvelope({
            kind: 'dm-line', itemId, senderKey: from.key, senderHome: 'a.example', recipient: ME, recipientHome: 'b.example', at: Date.now(), payloadHash: relayPayloadHash(payload),
        }, ed25519Signer(hexToBytes(from.seed)));
        server.held.push({ kind: 'dm-line', envelope, payload, bytes: payload.length, receivedAt: Date.now(), ...(memberHere ? { memberHere: true } : {}) });
        return itemId;
    }

    const ROWS: Array<{ name: string; facts: Facts; door: boolean; block?: boolean; memberHere?: boolean; state: 'open' | 'request' | null; receipted: boolean }> = [
        { name: 'let in (a friend), door closed', facts: { friends: [{ publicKey: THEM }] }, door: false, state: 'open', receipted: true },
        { name: 'let in (a chat they wrote in here), door open', facts: { conversations: [dm('c1')], lines: { c1: [line(ME)] } }, door: true, state: 'open', receipted: true },
        { name: 'let in, and the member-here mark too: let in decides, receipted now', facts: { payments: [{ from: ME, to: THEM }] }, door: false, memberHere: true, state: 'open', receipted: true },
        { name: 'let in but blocked here', facts: { friends: [{ publicKey: THEM }] }, door: true, block: true, state: null, receipted: false },
        { name: 'a stranger, door closed', facts: {}, door: false, state: null, receipted: false },
        { name: 'a stranger, door open: a request', facts: {}, door: true, state: 'request', receipted: true },
        { name: 'only they paid the member, door closed', facts: { payments: [{ from: THEM, to: ME }] }, door: false, state: null, receipted: false },
    ];
    for (const row of ROWS) {
        it(`${row.name} -> ${row.state ?? 'dropped'}${row.receipted ? ', receipted' : ''}`, async () => {
            const ctx = contextLettingIn(row.facts);
            await ctx.store.setMeta(ME, 'home', `b.example ${Date.now()} ${B}`);
            await setDoor(ctx, row.door);
            if (row.block) blocked.add(THEM);
            const id = await heldLine(SOL, row.memberHere);
            await syncOutsideMail(ctx);
            const chat = await ctx.store.chat(ME, relayConversationId(ME, THEM));
            expect(chat?.state ?? null).toBe(row.state);
            expect(server.receipts.filter((r) => r.to === THEM).flatMap((r) => r.ids).includes(id)).toBe(row.receipted);
        });
    }

    it('a line in a chat already here never asks let in', async () => {
        ctx = contextLettingIn({ friends: [{ publicKey: THEM }] });
        await ctx.store.setMeta(ME, 'home', `b.example ${Date.now()} ${B}`);
        await setDoor(ctx, true);
        await heldLine(SOL);
        await syncOutsideMail(ctx);
        expect(reads.conversations).toBe(1);
        // A new round (its own reader): the chat is here now, so nothing is read for let in.
        reads = {};
        const next = contextLettingIn({ friends: [{ publicKey: THEM }] });
        await heldLine(SOL);
        await syncOutsideMail(next);
        expect(reads).toEqual({});
        expect((await next.store.chat(ME, relayConversationId(ME, THEM)))?.state).toBe('open');
    });

    // #3366 review F2, through the round: a first line the door would drop, while a read let in needs failed, waits at my
    // server, unconfirmed, for a later round; a refusal drops it, as before; the round goes on past it.
    const heldIds = () => server.held.map((h) => h.envelope.itemId);
    const receiptedTo = (key: string) => server.receipts.filter((r) => r.to === key).flatMap((r) => r.ids);
    const stateOf = async (c: OutsideMailContext, key: string) => (await c.store.chat(ME, relayConversationId(ME, key)))?.state ?? null;
    async function roundWith(facts: Facts, broken: Partial<Record<ReadName, () => unknown>>, door = false) {
        const c = contextLettingIn(facts, broken);
        await c.store.setMeta(ME, 'home', `b.example ${Date.now()} ${B}`);
        await setDoor(c, door);
        return { c, out: await syncOutsideMail(c) };
    }

    const WAITS: Array<{ name: string; facts: Facts; broken: Partial<Record<ReadName, () => unknown>> }> = [
        { name: 'the friends read is busy (a 429)', facts: { friends: [{ publicKey: THEM }] }, broken: { friends: () => status(429) } },
        { name: 'the chat list read has no answer', facts: { friends: [{ publicKey: THEM }] }, broken: { conversations: noAnswer } },
        { name: 'the lines read fails (a 503)', facts: { conversations: [dm('c1')], lines: { c1: [line(ME)] } }, broken: { lines: () => status(503) } },
        { name: 'this community\'s members read fails, for a link made here', facts: { contacts: [{ key: THEM, community: B }], members: [THEM] }, broken: { members: noAnswer } },
    ];
    for (const row of WAITS) {
        it(`${row.name}, door closed, a first line from someone let in: left at the server, unconfirmed; the next good round opens it`, async () => {
            const id = await heldLine(SOL);
            const { c, out } = await roundWith(row.facts, row.broken);
            expect(out).toMatchObject({ waiting: 1, dropped: 0, written: 0, confirmed: 0 });
            expect(heldIds()).toEqual([id]);
            expect(await stateOf(c, THEM)).toBeNull();
            expect(receiptedTo(THEM)).toEqual([]);
            // The next round reads every fact: let in, so the line opens its chat, is confirmed and receipted now.
            const next = await roundWith(row.facts, {});
            expect(next.out).toMatchObject({ waiting: 0, written: 1, confirmed: 1 });
            expect(heldIds()).toEqual([]);
            expect(await stateOf(next.c, THEM)).toBe('open');
            expect(receiptedTo(THEM)).toEqual([id]);
        });
    }

    it('the friends read refused (a 403, as a visitor\'s), door closed: dropped and confirmed, as before', async () => {
        await heldLine(SOL);
        const { c, out } = await roundWith({ friends: [{ publicKey: THEM }] }, { friends: () => status(403) });
        expect(out).toMatchObject({ waiting: 0, dropped: 1, confirmed: 1 });
        expect(heldIds()).toEqual([]);
        expect(await stateOf(c, THEM)).toBeNull();
    });

    it('the round goes on past a line left waiting: someone the member paid is let in, in the same round', async () => {
        const waits = await heldLine(SOL);
        const paid = await heldLine(CY);
        const { c, out } = await roundWith({ friends: [{ publicKey: THEM }], payments: [{ from: ME, to: OTHER }] }, { friends: noAnswer });
        expect(out).toMatchObject({ waiting: 1, written: 1, confirmed: 1 });
        expect(heldIds()).toEqual([waits]);
        expect(await stateOf(c, OTHER)).toBe('open');
        expect(receiptedTo(OTHER)).toEqual([paid]);
        expect(await stateOf(c, THEM)).toBeNull();
    });

    it('door open, a read failed: a request, as before, never left waiting', async () => {
        await heldLine(SOL);
        const { c, out } = await roundWith({ friends: [{ publicKey: THEM }] }, { friends: noAnswer }, true);
        expect(out).toMatchObject({ waiting: 0, requests: 1, confirmed: 1 });
        expect(await stateOf(c, THEM)).toBe('request');
    });

    it('a page whose every line waits is asked for once, not again as it is', async () => {
        server.more = true;
        await heldLine(SOL);
        await heldLine(SOL);
        const { out } = await roundWith({ friends: [{ publicKey: THEM }] }, { friends: noAnswer });
        expect(out).toMatchObject({ waiting: 2, confirmed: 0 });
        expect(server.pages).toBe(1);
        expect(reads.friends).toBe(1);
    });
});
