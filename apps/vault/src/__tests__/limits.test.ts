import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../api/server.js';
import { addressBucket } from '../api/rate-limit.js';
import { deposit, doGenesis, newMember, signed, startRestore, startVault, ticketFor, type VaultUnderTest } from './harness.js';

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

    it('GitHub starts: 5 an hour per address, under a vault-wide ceiling', async () => {
        v = await startVault({ trustProxy: true });
        await doGenesis(v);
        const member = newMember();
        const from = (addr: string) => ({ 'X-Forwarded-For': addr });
        const startFrom = async (addr: string) => {
            const ticket = await ticketFor(v!, member.seed, 'deposit', 'github');
            return signed(v!, '/v1/github/start', { ticket }, member.seed, from(addr));
        };
        for (let i = 0; i < LIMITS.githubStartsPerAddressPerHour; i++) expect((await startFrom('198.51.100.7')).status).toBe(200);
        expect((await startFrom('198.51.100.7')).status).toBe(429);
        // Each further address may start its 5 until the vault-wide ceiling.
        let started = LIMITS.githubStartsPerAddressPerHour;
        let n = 0;
        while (started < LIMITS.githubStartsPerHourVaultWide) {
            if (n % 8 === 0) v.clock.advance(61_000); // tickets are limited per minute
            expect((await startFrom(`203.0.113.${++n}`)).status).toBe(200);
            started++;
        }
        v.clock.advance(61_000);
        const ceiling = await startFrom('192.0.2.200');
        expect(ceiling.status).toBe(429);
        expect(ceiling.body.error).toMatch(/GitHub sign-ins/);
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

    it('buckets IPv6 addresses by /64 and IPv4-mapped ones as IPv4', () => {
        expect(addressBucket('2001:db8:1:2:3:4:5:6')).toBe(addressBucket('2001:db8:1:2:ffff::1'));
        expect(addressBucket('2001:db8:1:2::1')).not.toBe(addressBucket('2001:db8:1:3::1'));
        expect(addressBucket('::ffff:192.0.2.1')).toBe('192.0.2.1');
        expect(addressBucket('10.0.0.1')).toBe('10.0.0.1');
    });
});
