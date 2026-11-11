/**
 * Standing deals S2, the web's half of the parity proof: the authorisation the web signs (lib/api.ts signStandingStart,
 * core's signStandingAuthorisation) is byte for byte the text the phone signs for the same take-up
 * (apps/native utils/__tests__/standing-sign-parity.test.ts pins the same TEXT), signed as 0xFF ‖ the text with the member's
 * key, for the host this browser's requests go to. "Not verified" 1 of DESIGN-standing-deals-fable.md: the web's signing
 * can carry it, through core's builder only (lib/signing-source-rule.test.ts).
 */
import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const who = vi.hoisted(() => ({ identity: null as null | { publicKey: string; privateKey: string } }));
vi.mock('./identity', () => ({ loadIdentity: vi.fn(async () => who.identity) }));

import { signStandingStart } from './api';

/** The one take-up both apps' tests sign. */
const FIELDS = {
    standingId: '0b16212c-3742-4d58-a36d-788390a5b0bb',
    listingId: 'post-vehicle-storage',
    payee: 'b'.repeat(64),
    beansPerPeriod_c: 5000,
    unit: 'month' as const,
    maxPeriods: 6,
    startsAt: '2026-11-09T08:00:00.000Z',
    nonce: '0123456789abcdef0123456789abcdef',
};
/** The exact text, the same in the phone's test: version 2 carries the figure as whole hundredths (core STANDING_AUTH_VERSION). */
const TEXT = [
    'beanpool-standing-v2',
    'mullum.beanpool.org',
    '0b16212c-3742-4d58-a36d-788390a5b0bb',
    'post-vehicle-storage',
    'b'.repeat(64),
    '5000',
    'month',
    '6',
    '2026-11-09T08:00:00.000Z',
    '0123456789abcdef0123456789abcdef',
].join('\n');

function member() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).toString('hex');
    const seed = Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)).toString('hex');
    return { publicKey, pub, seed };
}

beforeEach(() => {
    localStorage.setItem('bp_node_url', 'https://mullum.beanpool.org');
});

describe('the web signs a standing deal\'s authorisation', () => {
    it('the pinned text, for the host its requests go to, signed as 0xFF ‖ the text', async () => {
        const k = member();
        who.identity = { publicKey: k.pub, privateKey: k.seed };
        const body = await signStandingStart(FIELDS);
        expect(body.authorisation.payload).toBe(TEXT);
        expect(body).toMatchObject({ periods: 6, startsAt: FIELDS.startsAt });
        const sig = Buffer.from(body.authorisation.signature, 'base64');
        expect(crypto.verify(null, Buffer.concat([Buffer.from([0xff]), Buffer.from(TEXT, 'utf-8')]), k.publicKey, sig)).toBe(true);
        expect(crypto.verify(null, Buffer.from(TEXT, 'utf-8'), k.publicKey, sig)).toBe(false);
    });

    it('signs nothing without a key', async () => {
        who.identity = null;
        await expect(signStandingStart(FIELDS)).rejects.toThrow();
    });
});
