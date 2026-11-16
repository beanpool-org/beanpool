/**
 * X8 part 1, check (2): src/ratchet.ts against vodozemac, an independent implementation of Olm (Apache-2.0).
 *
 * vodozemac is never imported here or anywhere: oracles/vodozemac-ratchet (Rust, run by hand, never by CI) ran one scripted
 * conversation through vodozemac for each MAC length and pinned every message, plaintext, refusal and random ratchet key it
 * chose in vectors/ratchet-vodozemac.json. This test replays the script on both sides with our code, handing it the same random
 * keys, and requires the same bytes for every message sent and the same answer for every message received. It covers the
 * triple Diffie-Hellman start (our Bob opens vodozemac Alice's first pre-key message from Bob's secrets alone), pre-key and
 * normal messages, a skipped key, out-of-order delivery, a late message from an earlier chain, both sides sending at once,
 * a new ratchet key on every change of direction, three replays (refused), an empty message, a full padding block and a
 * 1000-byte one.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { x25519 } from '@noble/curves/ed25519.js';
import {
    importRatchetState,
    ratchetDecrypt,
    ratchetEncrypt,
    RatchetRefusedError,
    startInboundRatchet,
    type RatchetMacBytes,
    type RatchetState,
} from '../ratchet.js';

const FIXTURE = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../vectors/ratchet-vodozemac.json'), 'utf8'));
const unb64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

interface Transcript {
    macBytes: RatchetMacBytes;
    bob: { identitySecret: string; identityKey: string; oneTimeSecret: string; oneTimeKey: string };
    alice: { rootKey: string; ratchetSecret: string; chainKey: string; chainIndex: number; identityKey: string; baseKey: string; oneTimeKey: string };
    events: Array<
        | { op: 'send'; who: 'alice' | 'bob'; id: string; plaintext: string; type: 'prekey' | 'normal'; body: string; ratchetSecret: string }
        | { op: 'recv'; who: 'alice' | 'bob'; id: string; ok: true; plaintext: string }
        | { op: 'recv'; who: 'alice' | 'bob'; id: string; ok: false; error: string }
    >;
}

/** vodozemac's error names, in our words. */
const REFUSAL: Record<string, string> = { MissingMessageKey: 'no-key', InvalidMAC: 'mac', TooBigMessageGap: 'too-far-ahead' };

/** Alice's state exactly as vodozemac made it after the triple Diffie-Hellman, read through our own import. */
function aliceFrom(t: Transcript): RatchetState {
    return importRatchetState({
        v: 1,
        macBytes: t.macBytes,
        initiator: true,
        sessionKeys: { identityKey: t.alice.identityKey, baseKey: t.alice.baseKey, oneTimeKey: t.alice.oneTimeKey },
        rootKey: t.alice.rootKey,
        sending: {
            ratchetSecret: t.alice.ratchetSecret,
            ratchetKey: b64(x25519.getPublicKey(unb64(t.alice.ratchetSecret))),
            chainKey: t.alice.chainKey,
            index: t.alice.chainIndex,
        },
        receiving: [],
        skipped: [],
    });
}

describe('src/ratchet.ts replays vodozemac byte for byte (vectors/ratchet-vodozemac.json)', () => {
    const transcripts: Transcript[] = FIXTURE.transcripts;

    it('the fixture holds both MAC lengths, sends, receives and refusals', () => {
        expect(transcripts.map((t) => t.macBytes)).toEqual([8, 32]);
        for (const t of transcripts) {
            expect(t.events.filter((e) => e.op === 'send').length).toBeGreaterThanOrEqual(10);
            expect(t.events.filter((e) => e.op === 'recv' && !e.ok).length).toBe(3);
        }
    });

    for (const t of transcripts) {
        it(`MAC ${t.macBytes} bytes: every message sent is the same bytes, every message received the same answer`, () => {
            let alice: RatchetState = aliceFrom(t);
            let bob: RatchetState | null = null;
            const lastSecret: Record<string, string> = { alice: t.alice.ratchetSecret, bob: '' };
            const sent = new Map<string, { type: 'prekey' | 'normal'; body: Uint8Array }>();
            let newKeys = 0;

            for (const e of t.events) {
                const label = `${e.op} ${e.who} ${e.id}`;
                if (e.op === 'send') {
                    const state = e.who === 'alice' ? alice : bob!;
                    let asked = false;
                    const rng = (n: number) => {
                        asked = true;
                        expect(n).toBe(32);
                        return unb64(e.ratchetSecret);
                    };
                    const out = ratchetEncrypt(state, unb64(e.plaintext), rng);
                    // A new ratchet key exactly when vodozemac made one: on the first message after a change of direction.
                    expect(asked, label).toBe(e.ratchetSecret !== lastSecret[e.who]);
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
                const attempt = (): Uint8Array => {
                    if (e.who === 'bob' && bob === null) {
                        // The start: Bob's identity secret and one-time secret, and Alice's first pre-key message. Nothing else.
                        const started = startInboundRatchet({
                            myIdentitySecret: unb64(t.bob.identitySecret),
                            myOneTimeSecret: unb64(t.bob.oneTimeSecret),
                            message: message.body,
                            macBytes: t.macBytes,
                        });
                        // The triple Diffie-Hellman agrees with vodozemac Alice's R_0.
                        expect(b64(started.state.rootKey), 'R_0').toBe(t.alice.rootKey);
                        bob = started.state;
                        return started.plaintext;
                    }
                    const state = e.who === 'alice' ? alice : bob!;
                    const out = ratchetDecrypt(state, message);
                    if (e.who === 'alice') alice = out.state;
                    else bob = out.state;
                    return out.plaintext;
                };
                if (e.ok) {
                    expect(b64(attempt()), label).toBe(e.plaintext);
                } else {
                    const before = e.who === 'alice' ? alice : bob;
                    let reason = '';
                    try {
                        attempt();
                    } catch (err) {
                        expect(err, label).toBeInstanceOf(RatchetRefusedError);
                        reason = (err as RatchetRefusedError).reason;
                    }
                    expect(reason, label).toBe(REFUSAL[e.error.replace(/\(.*$/, '')]);
                    expect(e.who === 'alice' ? alice : bob, `${label}: state unchanged`).toBe(before);
                }
            }
            // Bob's first reply, Alice's after it, Bob's after hers, both-at-once, and the last: five changes of direction.
            expect(newKeys).toBeGreaterThanOrEqual(5);
        });
    }
});
