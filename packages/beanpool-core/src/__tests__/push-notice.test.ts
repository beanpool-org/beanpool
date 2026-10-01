import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
    PUSH_NOTICE_KINDS, PUSH_NOTICE_LIFETIME_SECONDS, PUSH_NOTICE_MARKER, PUSH_NOTICE_TITLE, isPushNoticeId, isPushNoticeKind,
    pushCommunityTag, pushNoticeBytes, pushNoticeWords, verifyPushNotice, type PushNoticeData, type PushNoticeKind,
} from '../push-notice.js';

const SEED = new Uint8Array(32).map((_, i) => i + 7);
const KEY = bytesToHex(ed25519.getPublicKey(SEED));
const OTHER_SEED = new Uint8Array(32).map((_, i) => 200 - i);
const OTHER_KEY = bytesToHex(ed25519.getPublicKey(OTHER_SEED));
const ME = 'a'.repeat(64);
const NOW = 1_790_000_000;

function notice(over: Partial<PushNoticeData> = {}, seed = SEED, key = KEY, recipient = ME): PushNoticeData {
    const fields = { c: pushCommunityTag(key), k: 'chat.message' as PushNoticeKind, i: '0123456789abcdef0123456789abcdef', t: NOW, ...over };
    const s = bytesToHex(ed25519.sign(pushNoticeBytes(fields, recipient), seed));
    return { bp: 1, ...fields, s, ...(over.s ? { s: over.s } : {}) };
}

describe('the kinds', () => {
    it('every kind has a sentence, and every push has the same title', () => {
        for (const kind of Object.keys(PUSH_NOTICE_KINDS) as PushNoticeKind[]) {
            const words = pushNoticeWords(kind);
            expect(words.title).toBe(PUSH_NOTICE_TITLE);
            expect(words.body.length).toBeGreaterThan(10);
            expect(isPushNoticeKind(kind)).toBe(true);
        }
        expect(isPushNoticeKind('chat.nope')).toBe(false);
        expect(isPushNoticeKind('toString')).toBe(false);
    });

    it('no sentence names a person, an amount or a listing', () => {
        for (const { body } of Object.values(PUSH_NOTICE_KINDS)) {
            expect(body).not.toMatch(/\d/);
            expect(body).not.toMatch(/["“”]/);
            expect(body).not.toMatch(/beans?\b/i);
        }
    });

    it('a notice id is 32 lower-case hex characters', () => {
        expect(isPushNoticeId('0123456789abcdef0123456789abcdef')).toBe(true);
        expect(isPushNoticeId('0123456789ABCDEF0123456789abcdef')).toBe(false);
        expect(isPushNoticeId('../post/x')).toBe(false);
        expect(isPushNoticeId(42)).toBe(false);
    });
});

describe('the signed bytes', () => {
    it('start with the 0xFF marker and the tag line, and end with the recipient', () => {
        const bytes = pushNoticeBytes({ c: 'c'.repeat(16), k: 'trade.update', i: 'd'.repeat(32), t: 5 }, ME);
        expect(bytes[0]).toBe(PUSH_NOTICE_MARKER);
        expect(new TextDecoder().decode(bytes.subarray(1))).toBe(`beanpool-push/v1\n${'c'.repeat(16)}\ntrade.update\n${'d'.repeat(32)}\n5\n${ME}`);
    });

    it('the community tag is the first 8 bytes of SHA-256 of the push key', () => {
        expect(pushCommunityTag(KEY)).toMatch(/^[0-9a-f]{16}$/);
        expect(pushCommunityTag(KEY)).not.toBe(pushCommunityTag(OTHER_KEY));
    });
});

describe('verifyPushNotice', () => {
    it('takes a notice signed by the pinned key for this member', () => {
        expect(verifyPushNotice(notice(), { recipient: ME, pushKey: KEY, now: NOW + 60 }))
            .toEqual({ ok: true, kind: 'chat.message', id: '0123456789abcdef0123456789abcdef', sentAt: NOW });
    });

    it('refuses it when any covered field changes', () => {
        const good = notice();
        const changed: Array<[string, PushNoticeData]> = [
            ['kind', { ...good, k: 'trade.update' }],
            ['id', { ...good, i: 'f'.repeat(32) }],
            ['time', { ...good, t: good.t + 1 }],
            ['signature', { ...good, s: good.s.slice(0, -2) + (good.s.endsWith('00') ? '01' : '00') }],
        ];
        for (const [what, data] of changed) {
            expect({ what, check: verifyPushNotice(data, { recipient: ME, pushKey: KEY, now: NOW }) })
                .toEqual({ what, check: { ok: false, reason: 'bad-signature' } });
        }
    });

    it('refuses one for another member, which carries the same data', () => {
        expect(verifyPushNotice(notice(), { recipient: 'b'.repeat(64), pushKey: KEY, now: NOW })).toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('refuses one from another community, or signed by another key under this community tag', () => {
        expect(verifyPushNotice(notice({}, OTHER_SEED, OTHER_KEY), { recipient: ME, pushKey: KEY, now: NOW })).toEqual({ ok: false, reason: 'other-community' });
        expect(verifyPushNotice(notice({ c: pushCommunityTag(KEY) }, OTHER_SEED, KEY), { recipient: ME, pushKey: KEY, now: NOW }))
            .toEqual({ ok: false, reason: 'bad-signature' });
        expect(verifyPushNotice(notice(), { recipient: ME, pushKey: KEY.toUpperCase(), now: NOW })).toEqual({ ok: false, reason: 'other-community' });
    });

    it('refuses a stale notice and one from the future', () => {
        expect(verifyPushNotice(notice(), { recipient: ME, pushKey: KEY, now: NOW + PUSH_NOTICE_LIFETIME_SECONDS + 1 })).toEqual({ ok: false, reason: 'too-old' });
        expect(verifyPushNotice(notice(), { recipient: ME, pushKey: KEY, now: NOW - 3600 })).toEqual({ ok: false, reason: 'from-the-future' });
    });

    it('refuses what is not a notice, or of a kind it does not know, and never throws', () => {
        const good = notice();
        for (const data of [null, undefined, 'x', 42, {}, { ...good, bp: 2 }, { ...good, i: '../post/1' }, { ...good, t: '1' }, { ...good, s: 'zz' },
            { screen: 'post', postId: 'p1' }, { ...good, c: 'nothex' }]) {
            expect(verifyPushNotice(data, { recipient: ME, pushKey: KEY, now: NOW })).toEqual({ ok: false, reason: 'not-a-notice' });
        }
        expect(verifyPushNotice({ ...good, k: 'chat.nope' }, { recipient: ME, pushKey: KEY, now: NOW })).toEqual({ ok: false, reason: 'unknown-kind' });
    });
});
