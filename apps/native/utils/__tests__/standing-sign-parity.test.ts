/**
 * Standing deals S2, the phone's half of the parity proof: the authorisation the phone signs (utils/member-statements.ts
 * signStandingStatement, core's signStandingAuthorisation) is byte for byte the text the web signs for the same take-up
 * (apps/pwa src/lib/standing-sign-parity.test.ts pins the same TEXT), signed as 0xFF ‖ the text with the member's key, for
 * the host its requests go to; on the hall laptop (lights-out) the community's own name, as its requests are.
 */
import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (n: number) => new Uint8Array(randomBytes(n)) };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined) }));
const hall = vi.hoisted(() => ({ audience: null as string | null }));
vi.mock('../hall-state', () => ({ hallAudienceFor: vi.fn(async () => hall.audience) }));

import { signStandingStatement } from '../member-statements';

/** The one take-up both apps' tests sign. */
const FIELDS = {
    standingId: '0b16212c-3742-4d58-a36d-788390a5b0bb',
    listingId: 'post-vehicle-storage',
    payee: 'b'.repeat(64),
    beansPerPeriod: 50,
    unit: 'month' as const,
    maxPeriods: 6,
    startsAt: '2026-11-09T08:00:00.000Z',
    nonce: '0123456789abcdef0123456789abcdef',
};
/** The exact text, the same in the web's test. */
const TEXT = [
    'beanpool-standing-v1',
    'mullum.beanpool.org',
    '0b16212c-3742-4d58-a36d-788390a5b0bb',
    'post-vehicle-storage',
    'b'.repeat(64),
    '50.00',
    'month',
    '6',
    '2026-11-09T08:00:00.000Z',
    '0123456789abcdef0123456789abcdef',
].join('\n');

function member() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const seed = Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)).toString('hex');
    return { publicKey, seed };
}

describe('the phone signs a standing deal\'s authorisation', () => {
    it('the pinned text, for the host its requests go to, signed as 0xFF ‖ the text', async () => {
        const k = member();
        hall.audience = null;
        const body = await signStandingStatement('https://mullum.beanpool.org', FIELDS, k.seed);
        expect(body.authorisation.payload).toBe(TEXT);
        expect(body).toMatchObject({ periods: 6, startsAt: FIELDS.startsAt });
        const sig = Buffer.from(body.authorisation.signature, 'base64');
        expect(crypto.verify(null, Buffer.concat([Buffer.from([0xff]), Buffer.from(TEXT, 'utf-8')]), k.publicKey, sig)).toBe(true);
        expect(crypto.verify(null, Buffer.from(TEXT, 'utf-8'), k.publicKey, sig)).toBe(false);
    });

    it('on the hall laptop, the community\'s own name, as its requests are signed for', async () => {
        const k = member();
        hall.audience = 'mullum.beanpool.org';
        const body = await signStandingStatement('http://192.168.1.20', FIELDS, k.seed);
        expect(body.authorisation.payload).toBe(TEXT);
    });

    it('signs nothing for an address that is not plain', async () => {
        const k = member();
        hall.audience = null;
        await expect(signStandingStatement('https://user@mullum.beanpool.org', FIELDS, k.seed)).rejects.toThrow();
    });
});
