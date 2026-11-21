/**
 * The across gate, every case (slice S5 "Message anyone": scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3 "A
 * fellow member writing across", §6 row S5): a first line from another community, by who sent it, the member's door, the
 * receiving community's own rule, the blocks, and the two traps (a re-keyed sender, a "member here" mark forged by the
 * sending server). One table; each rule is shown to matter by a gate with that rule taken out, which gets rows wrong.
 */
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { gateOutsideItem, heldFromMemberHere, requestsHereOf, type OutsideGateVerdict } from '../outside-chat.js';
import { readRelayEnvelope, relayPayloadHash, signRelayEnvelope } from '../relay-envelope.js';

const seed = (name: string) => sha256(utf8ToBytes(`beanpool s5 gate vector: ${name}`));
const pub = (s: Uint8Array) => bytesToHex(ed25519.getPublicKey(s));
const ME = pub(seed('me'));
const SENDER = seed('sender');

const SENDERS = ['member here', 'let in elsewhere', 'wrote to before', 'stranger'] as const;
const DOORS = ['open', 'closed'] as const;
const COMMUNITIES = ['local', 'requests on', 'requests off'] as const;
const BLOCKS = ['blocked here', 'blocked in another held community', 'none'] as const;
const TRAPS = ['none', 're-keyed sender', 'forged member-here flag'] as const;
type Sender = typeof SENDERS[number];
type Row = { sender: Sender; door: typeof DOORS[number]; community: typeof COMMUNITIES[number]; block: typeof BLOCKS[number]; trap: typeof TRAPS[number] };

const rows: Row[] = SENDERS.flatMap((sender) => DOORS.flatMap((door) => COMMUNITIES.flatMap((community) =>
    BLOCKS.flatMap((block) => TRAPS.map((trap) => ({ sender, door, community, block, trap }))))));

/** What each community's info says (its `features`): a local one says nothing of requests. */
const FEATURES: Record<Row['community'], Record<string, unknown>> = {
    local: { outsideMessages: true },
    'requests on': { outsideMessages: true, dmRequests: true },
    'requests off': { outsideMessages: true, dmRequests: false },
};

/** The design, in its own words, as the expected answer of each row. */
function expected(r: Row): OutsideGateVerdict {
    // A block wins everywhere: here, or in any other community this device holds (S7b: a block beats every let in).
    if (r.block !== 'none') return 'drop';
    // A re-keyed sender writes under a key the device has never let in nor chatted with: who they were under the old one
    // doesn't carry. Whether they are a member here is the server's list now, which follows the key a member holds now.
    // A forged mark is no mark: who sent it is who they are.
    const who: Sender = r.trap === 're-keyed sender' && (r.sender === 'let in elsewhere' || r.sender === 'wrote to before') ? 'stranger' : r.sender;
    if (who === 'wrote to before') return 'line';                 // an open chat takes their lines
    if (who === 'let in elsewhere') return 'line';                // let in once: their first line opens a chat, door or not
    if (who === 'member here') return r.community === 'requests on' ? 'request' : 'line';   // that community's own rule
    return r.door === 'open' ? 'request' : 'drop';                // a total stranger: exactly as before
}

/**
 * The item as the member's own server hands it over (GET /api/mail): its own mark beside the envelope, from its own member
 * list. The sending server's forged mark rides inside the envelope and beside the item it posted; what reaches the device is
 * the envelope as read (core readRelayEnvelope keeps only an envelope's own fields) and the server's own wrapper.
 */
const PAYLOAD = JSON.stringify({ v: 1, c: 'sealed', n: 'nonce' });
const ENV = await signRelayEnvelope({
    kind: 'dm-line', itemId: 'itm-0001-abcdef', senderKey: pub(SENDER), senderHome: 'riverside.example', recipient: ME,
    recipientHome: 'hillside.example', at: 1_763_020_800_000, payloadHash: relayPayloadHash(PAYLOAD),
}, (b) => ed25519.sign(b, SENDER));

function heldItemOf(r: Row): { raw: Record<string, unknown>; held: Record<string, unknown> } {
    const payload = PAYLOAD;
    const env = ENV;
    const forged = r.trap === 'forged member-here flag';
    const raw = { envelope: forged ? { ...env, memberHere: true } : env, payload, ...(forged ? { memberHere: true } : {}) };
    // The server's own mark: true only for a sender on its own member list now (engine/relay-mail.ts fromMemberHere).
    const held = { kind: 'dm-line', envelope: readRelayEnvelope(raw.envelope), payload, bytes: payload.length, receivedAt: 1, memberHere: r.sender === 'member here' };
    return { raw, held };
}

type GateInput = Parameters<typeof gateOutsideItem>[0];

/**
 * The gate's inputs as a device works them out for a row (the phone's utils/outside-mail.ts, the web's lib/outside-mail.ts):
 * blocked by the account's list (every held community's own list counts on the phone: let-in.ts unbarredFor, blocklist.ts
 * neverLetInQuietly), let in and the chat by the key the line came from, and "a member here" from the server's wrapper only.
 */
function inputOf(r: Row, readMark: (held: Record<string, unknown>, raw: Record<string, unknown>) => boolean = (held) => heldFromMemberHere(held)): GateInput {
    const rekeyed = r.trap === 're-keyed sender';
    const blocked = r.block !== 'none';
    const chat = r.sender === 'wrote to before' && !rekeyed ? { state: 'open' as const, theirLines: 2 } : null;
    const { raw, held } = heldItemOf(r);
    return {
        kind: 'dm-line',
        chat,
        doorOpen: r.door === 'open',
        blocked,
        letIn: !chat && !blocked && r.sender === 'let in elsewhere' && !rekeyed,
        memberHere: !chat && !blocked && readMark(held, raw),
        requestsHere: requestsHereOf(FEATURES[r.community]),
    };
}

const label = (r: Row) => `${r.sender} | door ${r.door} | ${r.community} | ${r.block} | trap: ${r.trap}`;

describe('the across gate, every row (sender x door x community x block x trap)', () => {
    it(`has ${SENDERS.length * DOORS.length * COMMUNITIES.length * BLOCKS.length * TRAPS.length} rows`, () => {
        expect(rows.length).toBe(216);
    });
    for (const r of rows) {
        it(label(r), () => {
            expect(gateOutsideItem(inputOf(r))).toBe(expected(r));
        });
    }
});

describe('each rule matters: a gate without it gets rows wrong', () => {
    const wrongRows = (gate: (r: Row) => OutsideGateVerdict) => rows.filter((r) => gate(r) !== expected(r)).map(label);
    const mutants: Array<[string, (r: Row) => OutsideGateVerdict]> = [
        ['no block first (the block not counted)', (r) => gateOutsideItem({ ...inputOf(r), blocked: false })],
        ['a block in another held community not counted', (r) => gateOutsideItem(r.block === 'blocked in another held community'
            ? { ...inputOf({ ...r, block: 'none' }), blocked: false } : inputOf(r))],
        ['no let in', (r) => gateOutsideItem({ ...inputOf(r), letIn: false })],
        ['no member here', (r) => gateOutsideItem({ ...inputOf(r), memberHere: false })],
        ["the community's rule ignored (requests never held)", (r) => gateOutsideItem({ ...inputOf(r), requestsHere: false })],
        ["the community's rule ignored (requests always held)", (r) => gateOutsideItem({ ...inputOf(r), requestsHere: true })],
        ['the door ignored (always open)', (r) => gateOutsideItem({ ...inputOf(r), doorOpen: true })],
        ['the door ignored (always closed)', (r) => gateOutsideItem({ ...inputOf(r), doorOpen: false })],
        ['the sending server believed (a mark anywhere counts)', (r) => gateOutsideItem(inputOf(r, (held, raw) =>
            heldFromMemberHere(held) || (raw as { memberHere?: unknown }).memberHere === true
            || (raw.envelope as { memberHere?: unknown }).memberHere === true))],
        ['a re-keyed sender let in by their old key', (r) => gateOutsideItem(r.trap === 're-keyed sender' ? inputOf({ ...r, trap: 'none' }) : inputOf(r))],
    ];
    for (const [name, gate] of mutants) {
        it(name, () => {
            expect(wrongRows(gate).length).toBeGreaterThan(0);
        });
    }
});

describe('the mark comes from the member\'s own server alone', () => {
    it('an envelope read keeps none of a sending server\'s extra fields', () => {
        const { raw } = heldItemOf({ sender: 'stranger', door: 'closed', community: 'local', block: 'none', trap: 'forged member-here flag' });
        expect((raw.envelope as Record<string, unknown>).memberHere).toBe(true);
        expect(readRelayEnvelope(raw.envelope)).not.toHaveProperty('memberHere');
    });
    it('only a true beside the item counts', () => {
        for (const held of [null, undefined, 'memberHere', {}, { memberHere: 'true' }, { memberHere: 1 }, { memberHere: false }, { envelope: { memberHere: true } }]) {
            expect(heldFromMemberHere(held)).toBe(false);
        }
        expect(heldFromMemberHere({ memberHere: true })).toBe(true);
    });
    it("a community's rule is its dmRequests switch, true only when it says so", () => {
        expect(requestsHereOf({ dmRequests: true })).toBe(true);
        for (const f of [null, undefined, {}, { dmRequests: false }, { dmRequests: 'true' }, { dmRequests: 1 }]) expect(requestsHereOf(f)).toBe(false);
    });
    it('a member here never changes an answer the member gave, nor what a request may take', () => {
        const base = { kind: 'dm-line', doorOpen: false, blocked: false, memberHere: true, requestsHere: false };
        expect(gateOutsideItem({ ...base, chat: { state: 'declined', theirLines: 1 } })).toBe('drop');
        expect(gateOutsideItem({ ...base, chat: { state: 'request', theirLines: 1 } })).toBe('drop');
        expect(gateOutsideItem({ ...base, chat: { state: 'request', theirLines: 0 } })).toBe('request');
        // A change to a line, a photo's part: never through the door, member here or not.
        for (const kind of ['dm-edit', 'dm-reaction', 'dm-delete', 'dm-blob']) expect(gateOutsideItem({ ...base, kind, chat: null })).toBe('drop');
    });
});
