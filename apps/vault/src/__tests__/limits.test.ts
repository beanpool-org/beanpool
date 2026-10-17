import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../api/server.js';
import { addressBucket, RateLimiter } from '../api/rate-limit.js';
import { deposit, doGenesis, newMember, signed, startRestore, startVault, type VaultUnderTest } from './harness.js';

/** Rate limits (key vault design §1.6), in memory, keyed by address, by key or by sign-in account. */

let v: VaultUnderTest | null = null;
afterEach(async () => {
    await v?.close();
    v = null;
});

const DAY = 24 * 60 * 60 * 1000;

describe('rate limits', () => {
    it('tickets: 10 a minute per address', async () => {
        v = await startVault();
        await doGenesis(v);
        const member = newMember();
        for (let i = 0; i < LIMITS.ticketsPerAddressPerMinute; i++) {
            expect((await signed(v, '/v1/ticket', { purpose: 'deposit', provider: 'google' }, member.seed)).status).toBe(200);
        }
        const refused = await signed(v, '/v1/ticket', { purpose: 'deposit', provider: 'google' }, newMember().seed);
        expect(refused.status).toBe(429);
        expect(refused.body.retryAfterSeconds).toBeGreaterThan(0);
        v.clock.advance(60_000);
        expect((await signed(v, '/v1/ticket', { purpose: 'deposit', provider: 'google' }, member.seed)).status).toBe(200);
    });

    it('restores: 5 a day per sign-in account, counted after the sign-in is checked', async () => {
        v = await startVault();
        const g = await doGenesis(v);
        await deposit(v, g, newMember(), 'google', 'limited-account');
        await deposit(v, g, newMember(), 'google', 'other-account');
        for (let i = 0; i < LIMITS.restoresPerAccountPerDay; i++) {
            expect([200, 409]).toContain((await startRestore(v, 'google', 'limited-account')).reply.status);
        }
        v.clock.advance(61_000);
        expect((await startRestore(v, 'google', 'limited-account')).reply.status).toBe(429);
        expect((await startRestore(v, 'google', 'other-account')).reply.status).toBe(200);
        v.clock.advance(DAY);
        expect((await startRestore(v, 'google', 'limited-account')).reply.status).not.toBe(429);
    });

    it('deposits: 10 a day per member key', async () => {
        v = await startVault();
        const g = await doGenesis(v);
        const member = newMember();
        for (let i = 0; i < LIMITS.depositsPerKeyPerDay; i++) {
            if (i === 5) v.clock.advance(61_000);
            expect((await deposit(v, g, member, 'google', `sub-${i}`)).status).toBe(200);
        }
        v.clock.advance(61_000);
        const refused = await deposit(v, g, member, 'google', 'one-too-many');
        expect(refused.status).toBe(429);
        expect((await deposit(v, g, newMember(), 'google', 'someone-else')).status).toBe(200);
        v.clock.advance(DAY);
        expect((await deposit(v, g, member, 'google', 'next-day')).status).toBe(200);
    });

    it('restores: a sign-in with no copy is answered 404 without spending its 5 a day, which start once a copy exists (VLT-03)', async () => {
        v = await startVault();
        const g = await doGenesis(v);
        for (let i = 0; i < LIMITS.restoresPerAccountPerDay; i++) {
            expect((await startRestore(v, 'google', 'no-copy-yet')).reply).toMatchObject({ status: 404, body: { code: 'no_copy' } });
        }
        v.clock.advance(61_000);
        expect((await startRestore(v, 'google', 'no-copy-yet')).reply).toMatchObject({ status: 404, body: { code: 'no_copy' } });
        v.clock.advance(61_000);
        // The member deposits the same day: the restore they then start opens a hold.
        expect((await deposit(v, g, newMember(), 'google', 'no-copy-yet')).status).toBe(200);
        v.clock.advance(61_000);
        expect((await startRestore(v, 'google', 'no-copy-yet')).reply).toMatchObject({ status: 200, body: { status: 'held' } });
        for (let i = 1; i < LIMITS.restoresPerAccountPerDay; i++) {
            if (i === 3) v.clock.advance(61_000);
            expect([200, 409]).toContain((await startRestore(v, 'google', 'no-copy-yet')).reply.status);
        }
        v.clock.advance(61_000);
        expect((await startRestore(v, 'google', 'no-copy-yet')).reply.status).toBe(429);
    });

    it('a clock stepped backwards starts a new window rather than holding the old one shut (VLT-04)', () => {
        const T = 1_800_000_000_000;
        const rl = new RateLimiter(1, 60_000);
        expect(rl.take('a', T).ok).toBe(true);
        expect(rl.take('a', T + 1).ok).toBe(false);
        expect(rl.take('a', T - 3_600_000).ok).toBe(true);
        expect(rl.take('a', T - 3_600_000 + 1).ok).toBe(false);
    });

    it('buckets IPv6 addresses by /64 and IPv4-mapped ones as IPv4', () => {
        expect(addressBucket('2001:db8:1:2:3:4:5:6')).toBe(addressBucket('2001:db8:1:2:ffff::1'));
        expect(addressBucket('2001:db8:1:2::1')).not.toBe(addressBucket('2001:db8:1:3::1'));
        expect(addressBucket('::ffff:192.0.2.1')).toBe('192.0.2.1');
        expect(addressBucket('10.0.0.1')).toBe('10.0.0.1');
    });
});
