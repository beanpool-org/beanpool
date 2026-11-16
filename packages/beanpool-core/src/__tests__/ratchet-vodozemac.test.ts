/**
 * X8 part 1, check (2): src/ratchet.ts against vodozemac, an independent implementation of Olm (Apache-2.0).
 *
 * vodozemac is never imported here or anywhere: oracles/vodozemac-ratchet (Rust, run by hand, never by CI) ran one scripted
 * conversation through vodozemac for each MAC length and pinned every message, plaintext, refusal and random ratchet key it
 * chose in vectors/ratchet-vodozemac.json. replayVodozemac (ratchet-harness.ts) replays the script on both sides with our
 * code, handing it the same random keys, and requires the same bytes for every message sent and the same answer for every
 * message received. It covers the triple Diffie-Hellman start (our Bob opens vodozemac Alice's first pre-key message from
 * Bob's secrets alone, and reaches her R_0), pre-key and normal messages, a skipped key, out-of-order delivery, a late
 * message from an earlier chain, both sides sending at once, a new ratchet key on every change of direction, three replays
 * (refused), an empty message, a full padding block and a 1000-byte one.
 */
import { describe, expect, it } from 'vitest';
import * as ratchet from '../ratchet.js';
import { replayVodozemac, vodozemacTranscripts } from './ratchet-harness.js';

describe('src/ratchet.ts replays vodozemac byte for byte (vectors/ratchet-vodozemac.json)', () => {
    const transcripts = vodozemacTranscripts();

    it('the fixture holds both MAC lengths, with sends, receives and refusals', () => {
        expect(transcripts.map((t) => t.macBytes)).toEqual([8, 32]);
        for (const t of transcripts) {
            expect(t.events.filter((e) => e.op === 'send').length).toBe(10);
            expect(t.events.filter((e) => e.op === 'recv' && e.ok).length).toBe(10);
            expect(t.events.filter((e) => e.op === 'recv' && !e.ok).length).toBe(3);
        }
    });

    for (const t of transcripts) {
        it(`MAC ${t.macBytes} bytes: every message sent is the same bytes, every message received the same answer`, () => {
            // Bob's first reply, Alice's after it, Bob's while she sends, Alice's after that, and Bob's last.
            expect(replayVodozemac(ratchet, t)).toBe(5);
        });
    }
});
