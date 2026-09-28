import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { openSeedFromSso, openVaultRelease } from '@beanpool/core';
import type { SsoProvider } from '@beanpool/signin';
import { HOLD_MS } from '../api/server.js';
import { deposit, doGenesis, newMember, signed, startRestore, startVault, type Genesis, type Member, type VaultUnderTest } from './harness.js';

/**
 * Restores (key vault design §1.5 with Marty's D2; V2's "Restore" tests): every sign-in restore is held 24 hours,
 * whichever provider, unless a device holding the account approves; a cancelled one is never released; a release is
 * sealed to the restoring device's key and nothing else; the pushes say what happened and carry nothing of the copy.
 */

let v: VaultUnderTest;
let g: Genesis;
beforeEach(async () => {
    v = await startVault();
    g = await doGenesis(v);
});
afterEach(async () => {
    await v.close();
});

const SUBS: Record<SsoProvider, string> = { google: '111122223333444455556', apple: '000111.fedcba9876543210.0999', facebook: '10150000000000009', github: '31337' };
const PHONE = 'ExponentPushToken[member-phone]';

async function collect(e: Uint8Array, holdId: string) {
    return signed(v, '/v1/restore/collect', { holdId }, e);
}

/** Nothing of a copy, a key or a sign-in may appear in any push. */
function expectPushesCarryNothing(member: Member, e: Uint8Array, provider: SsoProvider, extra: string[] = []): void {
    const everything = v.stub.pushes.map(p => p.body).join('\n');
    const eKey = Buffer.from(ed25519.getPublicKey(e)).toString('hex');
    for (const secret of [SUBS[provider], member.key, eKey, 'encryptedShare', 'shareIv', 'kdfParams', 'clientCopy', 'envelope', ...extra]) {
        expect(everything).not.toContain(secret);
    }
    for (const p of v.stub.pushes) for (const m of p.messages) expect(Object.keys(m.data)).toEqual(['type']);
}

describe('every sign-in restore waits 24 hours (D2)', () => {
    for (const provider of Object.keys(SUBS) as SsoProvider[]) {
        it(`${provider}: held, then released only sealed to the restoring key; opening it with that key and the sub gives the seed`, async () => {
            const member = newMember();
            expect((await deposit(v, g, member, provider, SUBS[provider], { pushToken: PHONE })).status).toBe(200);
            const t0 = v.clock.now();
            const { e, reply } = await startRestore(v, provider, SUBS[provider]);
            expect(reply.status).toBe(200);
            expect(reply.body).toMatchObject({ status: 'held' });
            expect(reply.body.until).toBe(v.clock.now() + HOLD_MS);
            const holdId = reply.body.holdId as string;

            // The member's devices are told at once, and see the hold when the app opens.
            await v.api.idle();
            expect(v.stub.pushes.flatMap(p => p.messages).map(m => [m.to, m.data.type])).toEqual([[PHONE, 'vault-hold']]);
            const status = await signed(v, '/v1/copies/status', {}, member.seed);
            expect(status.body.holds).toEqual([{ holdId, provider, openedAt: expect.any(Number), releaseAt: reply.body.until }]);

            expect((await collect(e, holdId)).body).toEqual({ status: 'held', until: reply.body.until });
            v.clock.advance(reply.body.until - v.clock.now() - 1);
            expect((await collect(e, holdId)).body.status).toBe('held');
            v.clock.advance(1);
            expect(v.clock.now() - t0).toBeGreaterThanOrEqual(HOLD_MS);
            const released = await collect(e, holdId);
            expect(released.body.status).toBe('released');

            const opened = openVaultRelease(released.body.release, e);
            expect(opened).toMatchObject({ provider, pubkey: member.key });
            const { seed } = await openSeedFromSso(opened.clientCopy, provider, SUBS[provider]);
            expect(Buffer.from(seed).equals(Buffer.from(member.seed))).toBe(true);
            expect(() => openVaultRelease(released.body.release, crypto.randomBytes(32))).toThrow();
            expect(() => openVaultRelease(released.body.release, member.seed)).toThrow();

            await v.api.idle();
            expect(v.stub.pushes.flatMap(p => p.messages).map(m => m.data.type)).toEqual(['vault-hold', 'vault-released']);
            expectPushesCarryNothing(member, e, provider, [holdId]);

            // Once.
            const twice = await collect(e, holdId);
            expect(twice.body).toMatchObject({ code: "collected" });
            expect(twice.status).toBe(410);
            const after = await signed(v, '/v1/copies/status', {}, member.seed);
            expect(after.body.holds).toEqual([]);
            expect(after.body.copies[0].lastReleasedAt).toBe(v.clock.now());
        });
    }
});

describe('the member\'s answer to a hold', () => {
    it('"Yes, it\'s me" from a device holding the account releases it at once', async () => {
        const member = newMember();
        await deposit(v, g, member, 'google', SUBS.google, { pushToken: PHONE });
        const { e, reply } = await startRestore(v, 'google', SUBS.google);
        const holdId = reply.body.holdId as string;

        const stranger = newMember();
        expect((await signed(v, '/v1/holds/approve', { holdId }, stranger.seed)).status).toBe(404);
        expect((await collect(e, holdId)).body.status).toBe('held');

        const approved = await signed(v, '/v1/holds/approve', { holdId }, member.seed);
        expect(approved.body).toEqual({ status: 'approved', releaseAt: v.clock.now() });
        const released = await collect(e, holdId);
        expect(released.body.status).toBe('released');
        expect(openVaultRelease(released.body.release, e).pubkey).toBe(member.key);
    });

    it('Stop means never released, however long the device waits', async () => {
        const member = newMember();
        await deposit(v, g, member, 'apple', SUBS.apple, { pushToken: PHONE });
        const { e, reply } = await startRestore(v, 'apple', SUBS.apple);
        const holdId = reply.body.holdId as string;
        expect((await signed(v, '/v1/holds/cancel', { holdId }, newMember().seed)).status).toBe(404);
        expect((await signed(v, '/v1/holds/cancel', { holdId }, member.seed)).body).toEqual({ status: 'stopped' });
        for (const wait of [0, HOLD_MS, 6 * 24 * 60 * 60 * 1000]) {
            v.clock.advance(wait);
            const r = await collect(e, holdId);
            expect(r.body).toEqual({ status: 'stopped' });
            expect(JSON.stringify(r.body)).not.toContain('release"');
        }
        expect((await signed(v, '/v1/holds/approve', { holdId }, member.seed)).status).toBe(409);
        await v.api.idle();
        expect(v.stub.pushes.flatMap(p => p.messages).map(m => m.data.type)).toEqual(['vault-hold']);
    });

    it('a second restore while one waits: the same device gets its hold, another device is told one is waiting', async () => {
        const member = newMember();
        await deposit(v, g, member, 'facebook', SUBS.facebook, { pushToken: PHONE });
        const first = await startRestore(v, 'facebook', SUBS.facebook);
        const other = await startRestore(v, 'facebook', SUBS.facebook);
        expect(other.reply.status).toBe(409);
        expect(other.reply.body).toMatchObject({ code: 'hold_open', until: first.reply.body.until });
        expect((await collect(other.e, first.reply.body.holdId)).status).toBe(404);
        await v.api.idle();
        expect(v.stub.pushes.flatMap(p => p.messages)).toHaveLength(1);
    });

    it('no copy for this sign-in account is said only after the sign-in checks out', async () => {
        const { reply } = await startRestore(v, 'google', 'never-deposited');
        expect(reply.status).toBe(404);
        expect(reply.body.code).toBe('no_copy');
        expect(reply.body.error).toContain('12 words');
    });
});
