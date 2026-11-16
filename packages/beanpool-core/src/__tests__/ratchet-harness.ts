/**
 * X8 part 1: the checks of src/ratchet.ts, written against a module passed in, so the same checks run on the real module
 * (ratchet-table.test.ts, ratchet-vodozemac.test.ts, ratchet-keys.test.ts) and on deliberately broken copies of it
 * (ratchet-mutants.test.ts), where at least one of them must fail. Not a test file itself.
 */
import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { x25519 } from '@noble/curves/ed25519.js';
import { cbc } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import type * as Ratchet from '../ratchet.js';

export type RatchetApi = typeof Ratchet;
type Who = 'A' | 'B';
type State = Ratchet.RatchetState;
type Message = Ratchet.RatchetMessage;

const unb64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

/** The same bytes every run: SHA-256 of the seed and a counter. */
export function seededRng(seed: string): Ratchet.RatchetRng {
    let n = 0;
    return (len: number) => {
        const out = new Uint8Array(len);
        for (let at = 0; at < len; at += 32) out.set(sha256(utf8ToBytes(`${seed}/${n++}`)).slice(0, Math.min(32, len - at)), at);
        return out;
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// Two people and the messages between them.

export class Pair {
    readonly rng: Ratchet.RatchetRng;
    state: Record<Who, State | null>;
    readonly sent = new Map<string, { message: Message; text: string; from: Who }>();
    private readonly lastKey: Record<Who, string | null> = { A: null, B: null };
    private readonly bobIdentity: { secret: Uint8Array; public: Uint8Array };
    private readonly bobOneTime: { secret: Uint8Array; public: Uint8Array };

    constructor(
        readonly api: RatchetApi,
        seed: string,
        readonly macBytes: Ratchet.RatchetMacBytes = 8,
    ) {
        this.rng = seededRng(seed);
        this.bobIdentity = api.ratchetKeyPair(this.rng);
        this.bobOneTime = api.ratchetKeyPair(this.rng);
        const alice = api.ratchetKeyPair(this.rng);
        this.state = {
            A: api.startOutboundRatchet({
                myIdentitySecret: alice.secret,
                theirIdentityKey: this.bobIdentity.public,
                theirOneTimeKey: this.bobOneTime.public,
                macBytes,
                rng: this.rng,
            }),
            B: null,
        };
        this.lastKey.A = b64(this.state.A!.sending!.ratchetKey);
    }

    /** Another person starting a session with the same Bob (the same one-time key): their first message. */
    foreignFirstMessage(): Message {
        const someone = this.api.ratchetKeyPair(this.rng);
        const s = this.api.startOutboundRatchet({
            myIdentitySecret: someone.secret,
            theirIdentityKey: this.bobIdentity.public,
            theirOneTimeKey: this.bobOneTime.public,
            macBytes: this.macBytes,
            rng: this.rng,
        });
        return this.api.ratchetEncrypt(s, utf8ToBytes('not from alice'), this.rng).message;
    }

    ratchetKeyOf(m: Message): Uint8Array {
        const body = m.type === 'prekey' ? this.api.decodePreKeyMessage(m.body).message : m.body;
        return this.api.decodeNormalMessage(body, this.macBytes).ratchetKey;
    }

    send(who: Who, id: string, text: string): { newKey: boolean } {
        const out = this.api.ratchetEncrypt(this.state[who]!, utf8ToBytes(text), this.rng);
        this.state[who] = out.state;
        this.sent.set(id, { message: out.message, text, from: who });
        const key = b64(this.ratchetKeyOf(out.message));
        const newKey = key !== this.lastKey[who];
        this.lastKey[who] = key;
        return { newKey };
    }

    /** Opens a message; on a refusal, checks the state is exactly as it was, and returns the reason. */
    recv(who: Who, message: Message): { plaintext?: string; refused?: string } {
        const before = this.state[who];
        const snapshot = before ? JSON.stringify(this.api.exportRatchetState(before)) : null;
        try {
            if (who === 'B' && before === null) {
                const started = this.api.startInboundRatchet({
                    myIdentitySecret: this.bobIdentity.secret,
                    myOneTimeSecret: this.bobOneTime.secret,
                    message: message.body,
                    macBytes: this.macBytes,
                });
                this.state.B = started.state;
                return { plaintext: utf8(started.plaintext) };
            }
            const out = this.api.ratchetDecrypt(before!, message);
            this.state[who] = out.state;
            return { plaintext: utf8(out.plaintext) };
        } catch (err) {
            if (!(err instanceof this.api.RatchetRefusedError)) throw err;
            expect(this.state[who], 'a refusal keeps the state').toBe(before);
            if (before) expect(JSON.stringify(this.api.exportRatchetState(before)), 'a refusal changes nothing in the state').toBe(snapshot);
            return { refused: err.reason };
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// (3) The table of message orders. Every row runs on a fresh pair. A step without `expect` must open with its own words.

type Forge = 'flip-ciphertext' | 'flip-mac' | 'truncate' | 'version' | 'foreign' | 'foreign-as-normal';
export type Step =
    | { send: Who; id: string; text?: string; newKey?: boolean }
    | { sendMany: Who; prefix: string; from: number; to: number }
    | { recv: Who; id: string; expect?: Ratchet.RatchetRefusal }
    | { forge: Forge; id: string; of?: string };

export interface Row {
    name: string;
    steps: Step[];
}

export function ratchetTable(api: RatchetApi): Row[] {
    const SKIP = api.RATCHET_MAX_SKIP;
    const KEPT = api.RATCHET_MAX_SKIPPED_KEYS;
    const CHAINS = api.RATCHET_MAX_RECEIVING_CHAINS;
    const start: Step[] = [
        { send: 'A', id: 'a0', newKey: false },
        { recv: 'B', id: 'a0' },
    ];
    // Ping-pong: each A message after a B message is a new chain at Bob.
    const pingPong = (n: number): Step[] =>
        Array.from({ length: n }, (_, i): Step[] => [
            { send: 'B', id: `pb${i}`, newKey: true },
            { recv: 'A', id: `pb${i}` },
            { send: 'A', id: `pa${i}`, newKey: true },
            { recv: 'B', id: `pa${i}` },
        ]).flat();
    return [
        { name: 'in order', steps: [...start, { send: 'A', id: 'a1' }, { send: 'A', id: 'a2' }, { recv: 'B', id: 'a1' }, { recv: 'B', id: 'a2' }] },
        {
            name: 'out of order within the skip limit',
            steps: [
                { sendMany: 'A', prefix: 'a', from: 0, to: 5 },
                ...['a5', 'a0', 'a3', 'a1', 'a4', 'a2'].map((id): Step => ({ recv: 'B', id })),
            ],
        },
        {
            name: `a skip of exactly the limit (${SKIP}) opens`,
            steps: [...start, { sendMany: 'A', prefix: 'a', from: 1, to: SKIP + 1 }, { recv: 'B', id: `a${SKIP + 1}` }, { recv: 'B', id: `a${SKIP}` }],
        },
        {
            name: 'a skip beyond the limit is refused, and changes nothing',
            steps: [
                ...start,
                { sendMany: 'A', prefix: 'a', from: 1, to: SKIP + 2 },
                { recv: 'B', id: `a${SKIP + 2}`, expect: 'too-far-ahead' },
                { recv: 'B', id: 'a1' },
                { recv: 'B', id: `a${SKIP + 2}` },
            ],
        },
        { name: 'a replay is refused', steps: [...start, { recv: 'B', id: 'a0', expect: 'no-key' }] },
        {
            name: 'a replay of a skipped message is refused',
            steps: [...start, { sendMany: 'A', prefix: 'a', from: 1, to: 3 }, { recv: 'B', id: 'a3' }, { recv: 'B', id: 'a2' }, { recv: 'B', id: 'a2', expect: 'no-key' }, { recv: 'B', id: 'a1' }],
        },
        {
            name: 'a replay of the first pre-key message on a running session is refused',
            steps: [...start, { send: 'B', id: 'b0', newKey: true }, { recv: 'A', id: 'b0' }, { send: 'A', id: 'a1', newKey: true }, { recv: 'B', id: 'a1' }, { recv: 'B', id: 'a0', expect: 'no-key' }],
        },
        {
            name: 'lost messages never stop the chat',
            steps: [
                ...start,
                { sendMany: 'A', prefix: 'a', from: 1, to: 3 },
                { recv: 'B', id: 'a1' },
                { recv: 'B', id: 'a3' },
                { send: 'B', id: 'b0', newKey: true },
                { recv: 'A', id: 'b0' },
                { send: 'A', id: 'a4', newKey: true },
                { recv: 'B', id: 'a4' },
                { send: 'B', id: 'b1', newKey: true },
                { recv: 'A', id: 'b1' },
            ],
        },
        {
            name: 'a late message from an earlier chain opens',
            steps: [...start, { send: 'A', id: 'a1' }, { send: 'B', id: 'b0', newKey: true }, { recv: 'A', id: 'b0' }, { send: 'A', id: 'a2', newKey: true }, { recv: 'B', id: 'a2' }, { recv: 'B', id: 'a1' }],
        },
        {
            name: 'both sides sending at once',
            steps: [
                ...start,
                { send: 'B', id: 'b0', newKey: true },
                { recv: 'A', id: 'b0' },
                { send: 'A', id: 'a1', newKey: true },
                { send: 'B', id: 'b1', newKey: false },
                { recv: 'A', id: 'b1' },
                { recv: 'B', id: 'a1' },
                { send: 'A', id: 'a2', newKey: false },
                { send: 'B', id: 'b2', newKey: true },
                { recv: 'B', id: 'a2' },
                { recv: 'A', id: 'b2' },
                { send: 'A', id: 'a3', newKey: true },
                { recv: 'B', id: 'a3' },
            ],
        },
        {
            name: 'a new ratchet key on every change of direction, and only then',
            steps: [
                { send: 'A', id: 'a0', newKey: false },
                { send: 'A', id: 'a1', newKey: false },
                { recv: 'B', id: 'a0' },
                { recv: 'B', id: 'a1' },
                { send: 'B', id: 'b0', newKey: true },
                { send: 'B', id: 'b1', newKey: false },
                { recv: 'A', id: 'b0' },
                { recv: 'A', id: 'b1' },
                { send: 'A', id: 'a2', newKey: true },
                { send: 'A', id: 'a3', newKey: false },
                { recv: 'B', id: 'a2' },
                { recv: 'B', id: 'a3' },
                { send: 'B', id: 'b2', newKey: true },
                { recv: 'A', id: 'b2' },
            ],
        },
        {
            name: 'a changed message is refused; the real one then opens',
            steps: [
                { sendMany: 'A', prefix: 'a', from: 0, to: 2 },
                { forge: 'flip-ciphertext', id: 'x0', of: 'a0' },
                { recv: 'B', id: 'x0', expect: 'mac' },
                { recv: 'B', id: 'a0' },
                { forge: 'flip-mac', id: 'x2', of: 'a2' },
                { recv: 'B', id: 'x2', expect: 'mac' },
                { forge: 'flip-ciphertext', id: 'y2', of: 'a2' },
                { recv: 'B', id: 'y2', expect: 'mac' },
                { recv: 'B', id: 'a1' },
                { recv: 'B', id: 'a2' },
            ],
        },
        {
            name: 'a message not in the format is refused',
            steps: [
                ...start,
                { send: 'A', id: 'a1' },
                { forge: 'truncate', id: 'x1', of: 'a1' },
                { recv: 'B', id: 'x1', expect: 'malformed' },
                { forge: 'version', id: 'y1', of: 'a1' },
                { recv: 'B', id: 'y1', expect: 'malformed' },
                { recv: 'B', id: 'a1' },
            ],
        },
        { name: 'a pre-key message for another session is refused', steps: [...start, { forge: 'foreign', id: 'f' }, { recv: 'B', id: 'f', expect: 'session-mismatch' }] },
        { name: 'a new ratchet key while ours is not out is refused', steps: [...start, { forge: 'foreign-as-normal', id: 'f' }, { recv: 'B', id: 'f', expect: 'unexpected-ratchet-key' }] },
        {
            name: `a chain more than ${CHAINS} chains old is gone`,
            steps: [...start, { send: 'A', id: 'late' }, ...pingPong(CHAINS), { recv: 'B', id: 'late', expect: 'unexpected-ratchet-key' }],
        },
        {
            name: `a chain ${CHAINS - 1} chains old still opens`,
            steps: [...start, { send: 'A', id: 'late' }, ...pingPong(CHAINS - 1), { recv: 'B', id: 'late' }],
        },
        {
            name: `more than ${KEPT} skipped keys: the oldest go`,
            steps: [...start, { sendMany: 'A', prefix: 'a', from: 1, to: KEPT + 2 }, { recv: 'B', id: `a${KEPT + 2}` }, { recv: 'B', id: 'a1', expect: 'no-key' }, { recv: 'B', id: 'a2' }],
        },
    ];
}

export function runRow(api: RatchetApi, row: Row, macBytes: Ratchet.RatchetMacBytes = 8): void {
    const pair = new Pair(api, `row:${row.name}`, macBytes);
    const flip = (m: Message, at: number): Message => {
        const body = Uint8Array.from(m.body);
        body[at] ^= 0x01;
        return { type: m.type, body };
    };
    for (const [i, step] of row.steps.entries()) {
        const label = `${row.name}, step ${i + 1}: ${JSON.stringify(step)}`;
        if ('send' in step) {
            const { newKey } = pair.send(step.send, step.id, step.text ?? `words of ${step.id}`);
            if (step.newKey !== undefined) expect(newKey, label).toBe(step.newKey);
        } else if ('sendMany' in step) {
            for (let n = step.from; n <= step.to; n += 1) pair.send(step.sendMany, `${step.prefix}${n}`, `words of ${step.prefix}${n}`);
        } else if ('forge' in step) {
            const of = step.of ? pair.sent.get(step.of)!.message : null;
            let message: Message;
            if (step.forge === 'flip-ciphertext') message = flip(of!, of!.body.length - macBytes - 1);
            else if (step.forge === 'flip-mac') message = flip(of!, of!.body.length - 1);
            else if (step.forge === 'truncate') message = { type: of!.type, body: of!.body.slice(0, -1) };
            else if (step.forge === 'version') message = flip(of!, 0);
            else if (step.forge === 'foreign') message = pair.foreignFirstMessage();
            else message = { type: 'normal', body: api.decodePreKeyMessage(pair.foreignFirstMessage().body).message };
            pair.sent.set(step.id, { message, text: '', from: 'A' });
        } else {
            const sent = pair.sent.get(step.id)!;
            const got = pair.recv(step.recv, sent.message);
            if (step.expect) expect(got, label).toEqual({ refused: step.expect });
            else expect(got, label).toEqual({ plaintext: sent.text });
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// (2) The vodozemac transcripts (see ratchet-vodozemac.test.ts and oracles/vodozemac-ratchet).

export interface Transcript {
    macBytes: Ratchet.RatchetMacBytes;
    bob: { identitySecret: string; identityKey: string; oneTimeSecret: string; oneTimeKey: string };
    alice: { rootKey: string; ratchetSecret: string; chainKey: string; chainIndex: number; identityKey: string; baseKey: string; oneTimeKey: string };
    events: Array<
        | { op: 'send'; who: 'alice' | 'bob'; id: string; plaintext: string; type: 'prekey' | 'normal'; body: string; ratchetSecret: string }
        | { op: 'recv'; who: 'alice' | 'bob'; id: string; ok: true; plaintext: string }
        | { op: 'recv'; who: 'alice' | 'bob'; id: string; ok: false; error: string }
    >;
}

export function vodozemacTranscripts(): Transcript[] {
    const path = resolve(dirname(fileURLToPath(import.meta.url)), '../../vectors/ratchet-vodozemac.json');
    return JSON.parse(readFileSync(path, 'utf8')).transcripts;
}

/** vodozemac's error names, in our words. */
const REFUSAL: Record<string, string> = { MissingMessageKey: 'no-key', InvalidMAC: 'mac', TooBigMessageGap: 'too-far-ahead' };

/** Replays one transcript on both sides; returns how many new ratchet keys were made. */
export function replayVodozemac(api: RatchetApi, t: Transcript): number {
    // Alice's state exactly as vodozemac made it after the triple Diffie-Hellman, read through our own import.
    let alice: State = api.importRatchetState({
        v: 1,
        macBytes: t.macBytes,
        initiator: true,
        sessionKeys: { identityKey: t.alice.identityKey, baseKey: t.alice.baseKey, oneTimeKey: t.alice.oneTimeKey },
        rootKey: t.alice.rootKey,
        sending: { ratchetSecret: t.alice.ratchetSecret, ratchetKey: b64(x25519.getPublicKey(unb64(t.alice.ratchetSecret))), chainKey: t.alice.chainKey, index: t.alice.chainIndex },
        receiving: [],
        skipped: [],
    });
    let bob: State | null = null;
    const lastSecret: Record<string, string> = { alice: t.alice.ratchetSecret, bob: '' };
    const sent = new Map<string, Message>();
    let newKeys = 0;
    for (const e of t.events) {
        const label = `MAC ${t.macBytes}: ${e.op} ${e.who} ${e.id}`;
        if (e.op === 'send') {
            let asked = false;
            const rng = (n: number) => {
                asked = true;
                expect(n, label).toBe(32);
                return unb64(e.ratchetSecret);
            };
            const out = api.ratchetEncrypt(e.who === 'alice' ? alice : bob!, unb64(e.plaintext), rng);
            // A new ratchet key exactly when vodozemac made one: on the first message after a change of direction.
            expect(asked, `${label}: a new ratchet key`).toBe(e.ratchetSecret !== lastSecret[e.who]);
            if (asked) newKeys += 1;
            lastSecret[e.who] = e.ratchetSecret;
            expect(out.message.type, label).toBe(e.type);
            expect(b64(out.message.body), label).toBe(e.body);
            sent.set(e.id, out.message);
            if (e.who === 'alice') alice = out.state;
            else bob = out.state;
            continue;
        }
        const message = sent.get(e.id)!;
        const before = e.who === 'alice' ? alice : bob;
        let plaintext: Uint8Array | null = null;
        let reason = '';
        try {
            if (e.who === 'bob' && bob === null) {
                // The start, from Bob's identity secret, his one-time secret and Alice's first pre-key message alone.
                const started = api.startInboundRatchet({ myIdentitySecret: unb64(t.bob.identitySecret), myOneTimeSecret: unb64(t.bob.oneTimeSecret), message: message.body, macBytes: t.macBytes });
                // Our triple Diffie-Hellman agrees with vodozemac Alice's R_0.
                expect(b64(started.state.rootKey), `${label}: R_0`).toBe(t.alice.rootKey);
                bob = started.state;
                plaintext = started.plaintext;
            } else {
                const out = api.ratchetDecrypt(before!, message);
                if (e.who === 'alice') alice = out.state;
                else bob = out.state;
                plaintext = out.plaintext;
            }
        } catch (err) {
            if (!(err instanceof api.RatchetRefusedError)) throw err;
            reason = err.reason;
        }
        if (e.ok) {
            expect(reason, label).toBe('');
            expect(b64(plaintext!), label).toBe(e.plaintext);
        } else {
            expect(reason, label).toBe(REFUSAL[e.error.replace(/\(.*$/, '')]);
            expect(e.who === 'alice' ? alice : bob, `${label}: state unchanged`).toBe(before);
        }
    }
    return newKeys;
}

// ---------------------------------------------------------------------------------------------------------------------
// (4) Key erasure. An attacker's own open, written here from [OLM] so it shares nothing with the module under test.

export function attackerOpens(messageKey: Uint8Array, wire: Ratchet.RatchetWireMessage): boolean {
    const keys = hkdf(sha256, messageKey, undefined, utf8ToBytes('OLM_KEYS'), 80);
    const mac = hmac(sha256, keys.slice(32, 64), wire.authenticated).slice(0, wire.mac.length);
    if (b64(mac) !== b64(wire.mac)) return false;
    cbc(keys.slice(0, 32), keys.slice(64, 80)).decrypt(wire.ciphertext);
    return true;
}

/** Every 32-byte value a stored state holds. */
export function keysIn(api: RatchetApi, s: State): Uint8Array[] {
    const j = api.exportRatchetState(s);
    const out = [j.rootKey, ...j.receiving.map((c) => c.chainKey), ...j.skipped.map((k) => k.messageKey)];
    if (j.sending) out.push(j.sending.chainKey, j.sending.ratchetSecret);
    return out.map(unb64);
}

/** Can anything in this state, used as a message key or as a chain key run forward up to `steps`, open the message? */
export function stateOpens(api: RatchetApi, s: State, m: Message, macBytes: Ratchet.RatchetMacBytes, steps = 64): boolean {
    const body = m.type === 'prekey' ? api.decodePreKeyMessage(m.body).message : m.body;
    const wire = api.decodeNormalMessage(body, macBytes);
    for (const key of keysIn(api, s)) {
        if (attackerOpens(key, wire)) return true;
        let chain = key;
        for (let i = 0; i < steps; i += 1) {
            if (attackerOpens(hmac(sha256, chain, Uint8Array.of(0x01)), wire)) return true;
            chain = hmac(sha256, chain, Uint8Array.of(0x02));
        }
    }
    return false;
}

/**
 * (4a) Forward secrecy: Bob's whole state, taken after a conversation, opens none of the messages he has already read (by its
 * own decrypt, or by any key in it run forward), while the attacker's open does read the one message that never arrived
 * (a kept skipped key: the stated limit). (4b) An old chain key, or the whole state taken before a change of direction,
 * opens nothing sent after the next ratchet steps.
 */
export function checkKeyErasure(api: RatchetApi, macBytes: Ratchet.RatchetMacBytes = 8): void {
    const p = new Pair(api, `erasure:${macBytes}`, macBytes);
    const read: string[] = [];
    const deliver = (who: Who, id: string) => {
        expect(p.recv(who, p.sent.get(id)!.message), `${who} reads ${id}`).toEqual({ plaintext: p.sent.get(id)!.text });
        read.push(id);
    };
    for (let i = 0; i < 4; i += 1) p.send('A', `a${i}`, `a${i}`);
    deliver('B', 'a0');
    deliver('B', 'a2'); // a1 skipped
    deliver('B', 'a3');
    // A stolen chain key and a stolen whole state, before the next changes of direction.
    const stolenChainKey = p.state.B!.receiving[0].chainKey;
    const stolenState = p.state.B!;
    p.send('B', 'b0', 'b0');
    deliver('A', 'b0');
    p.send('A', 'a4', 'a4');
    deliver('B', 'a4');
    p.send('B', 'b1', 'b1');
    deliver('A', 'b1');
    p.send('A', 'a5', 'a5');
    deliver('B', 'a5');
    p.send('A', 'a6', 'a6'); // not yet delivered: the attacker's best chance

    // (4a) What Bob holds now opens nothing he has read: not by decrypt, not by any key in it.
    const now = p.state.B!;
    for (const id of read.filter((id) => p.sent.get(id)!.from === 'A')) {
        expect(() => api.ratchetDecrypt(now, p.sent.get(id)!.message), `${id} again`).toThrow(api.RatchetRefusedError);
        expect(stateOpens(api, now, p.sent.get(id)!.message, macBytes), `Bob's state now opens ${id}`).toBe(false);
    }
    // The stated limit: a skipped message that never arrived stays readable from the state until it comes or its key goes.
    expect(stateOpens(api, now, p.sent.get('a1')!.message, macBytes), 'the kept skipped key reads a1').toBe(true);
    // Nor do Alice's keys open what she has read.
    for (const id of ['b0', 'b1']) expect(stateOpens(api, p.state.A!, p.sent.get(id)!.message, macBytes), `Alice's state opens ${id}`).toBe(false);

    // (4b) The old chain key opens nothing after the steps; neither does the whole state taken before them.
    const later = ['a4', 'a5', 'a6'].map((id) => p.sent.get(id)!.message);
    for (const m of later) {
        const wire = api.decodeNormalMessage(m.body, macBytes);
        let chain = stolenChainKey;
        for (let i = 0; i < 64; i += 1) {
            expect(attackerOpens(hmac(sha256, chain, Uint8Array.of(0x01)), wire), 'an old chain key opens a later message').toBe(false);
            chain = hmac(sha256, chain, Uint8Array.of(0x02));
        }
        expect(stateOpens(api, stolenState, m, macBytes), 'an old state opens a later message by its keys').toBe(false);
        expect(() => api.ratchetDecrypt(stolenState, m), 'an old state decrypts a later message').toThrow(api.RatchetRefusedError);
    }
}
