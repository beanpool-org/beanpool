import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkVaultAnswer, newVaultChallenge } from '@beanpool/core';
import type { SsoProvider } from '@beanpool/signin';
import { deposit, doGenesis, newMember, signed, startRestore, startVault, T0, type Genesis, type Member, type VaultUnderTest } from './harness.js';

/**
 * The member's status (`/v1/copies/status`), as "Where your account can be brought back from" reads it (vault rethink
 * VR1, DESIGN-vault-rethink-fable.md §3.2 and §5.1): each copy of the asking key, with `since`, the day (UTC) the copy
 * kept now was deposited. A deposit for the same sign-in account and key makes a fresh copy and moves it; a push token, a
 * release and another sign-in's deposit don't. An API-only change: the fields an older phone reads are as they were.
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

const DAY = 24 * 60 * 60 * 1000;
const SUBS: Record<SsoProvider, string> = { google: '211122223333444455556', apple: '000222.fedcba9876543210.0999', facebook: '20150000000000009' };
/** T0 is 1 Oct 2026, 12:00 UTC (harness.ts). */
const day = (n: number) => new Date(T0 + n * DAY).toISOString().slice(0, 10);

async function statusOf(member: Member) {
    const r = await signed(v, '/v1/copies/status', {}, member.seed);
    expect(r.status).toBe(200);
    return r.body as { copies: Record<string, unknown>[]; holds: unknown[] };
}

describe('each copy says since when it is kept', () => {
    it('the day it was deposited, UTC, signed with the rest of the answer', async () => {
        const member = newMember();
        expect((await deposit(v, g, member, 'google', SUBS.google)).status).toBe(200);
        expect(day(0)).toBe('2026-10-01');

        // As the phone asks: with a challenge, so the answer is signed, and `since` is read from the signed payload.
        const challenge = newVaultChallenge();
        const r = await signed(v, '/v1/copies/status', { challenge }, member.seed);
        const check = checkVaultAnswer(r.body.signed, { ticketKeys: [g.ticketKey], kinds: ['status'], key: member.key, challenge });
        if (!check.ok) throw new Error(`the status was not signed as the phone checks it: ${check.reason}`);
        expect(check.answer.copies).toEqual([{ provider: 'google', lastReleasedAt: null, updatedDay: day(0), since: day(0) }]);
        expect(r.body.copies).toEqual(check.answer.copies);
    });

    it('an older phone reads what it read before: every field it knew is there, as it was', async () => {
        const member = newMember();
        await deposit(v, g, member, 'apple', SUBS.apple);
        const [copy] = (await statusOf(member)).copies;
        // apps/native utils/vault.ts readVaultStatus before VR1 read `provider` only; `lastReleasedAt` and `updatedDay`
        // were in the answer since V2. Only `since` is new.
        expect(Object.keys(copy).sort()).toEqual(['lastReleasedAt', 'provider', 'since', 'updatedDay']);
        expect(copy).toMatchObject({ provider: 'apple', lastReleasedAt: null, updatedDay: day(0) });
    });

    it('a deposit again for the same sign-in account moves it; a push token, a release and another sign-in leave it', async () => {
        const member = newMember();
        await deposit(v, g, member, 'google', SUBS.google, { pushToken: 'ExponentPushToken[phone-a]' });

        // Two days on: this device's push token goes into the copy. The copy is the same one, kept since day 0.
        v.clock.advance(2 * DAY);
        expect((await signed(v, '/v1/push-token', { token: 'ExponentPushToken[phone-b]' }, member.seed)).body).toEqual({ updated: 1 });
        expect((await statusOf(member)).copies).toEqual([{ provider: 'google', lastReleasedAt: null, updatedDay: day(0), since: day(0) }]);

        // A restore, let through, and collected: the copy is handed out, not replaced.
        const { e, reply } = await startRestore(v, 'google', SUBS.google);
        expect((await signed(v, '/v1/holds/approve', { holdId: reply.body.holdId }, member.seed)).body.status).toBe('approved');
        expect((await signed(v, '/v1/restore/collect', { holdId: reply.body.holdId }, e)).body.status).toBe('released');
        const releasedAt = v.clock.now();
        expect((await statusOf(member)).copies).toEqual([{ provider: 'google', lastReleasedAt: releasedAt, updatedDay: day(0), since: day(0) }]);

        // Another sign-in, a day later: its own copy, its own day; Google's is untouched.
        v.clock.advance(DAY);
        await deposit(v, g, member, 'facebook', SUBS.facebook);
        const third = (await statusOf(member)).copies;
        expect(third).toHaveLength(2);
        expect(third).toEqual(expect.arrayContaining([
            { provider: 'google', lastReleasedAt: releasedAt, updatedDay: day(0), since: day(0) },
            { provider: 'facebook', lastReleasedAt: null, updatedDay: day(3), since: day(3) },
        ]));

        // "Connect again" with Google two days later: a fresh copy replaces the old one, so it is kept since that day.
        v.clock.advance(2 * DAY);
        expect((await deposit(v, g, member, 'google', SUBS.google)).body).toMatchObject({ ok: true, replaced: false });
        const google = (await statusOf(member)).copies.find(c => c.provider === 'google');
        expect(google).toMatchObject({ since: day(5), updatedDay: day(5) });
    });

    it('a sign-in account another key deposited for is a new copy for that key, since that day; the first key has none', async () => {
        const first = newMember();
        await deposit(v, g, first, 'google', SUBS.google);
        v.clock.advance(4 * DAY);
        const second = newMember();
        expect((await deposit(v, g, second, 'google', SUBS.google)).body).toMatchObject({ ok: true, replaced: true });
        expect((await statusOf(second)).copies).toEqual([{ provider: 'google', lastReleasedAt: null, updatedDay: day(4), since: day(4) }]);
        expect((await statusOf(first)).copies).toEqual([]);
    });

    it('only the asking key\'s copies, and none once removed', async () => {
        const member = newMember();
        await deposit(v, g, member, 'google', SUBS.google);
        await deposit(v, g, member, 'apple', SUBS.apple);
        expect((await statusOf(newMember())).copies).toEqual([]);

        expect((await signed(v, '/v1/copies/delete', { provider: 'apple' }, member.seed)).body).toEqual({ deleted: 1 });
        expect((await statusOf(member)).copies.map(c => c.provider)).toEqual(['google']);
        expect((await signed(v, '/v1/copies/delete', { all: true }, member.seed)).body).toEqual({ deleted: 1 });
        expect(await statusOf(member)).toEqual({ copies: [], holds: [] });
        // Removing everything again: nothing left to remove, and no error.
        expect((await signed(v, '/v1/copies/delete', { all: true }, member.seed)).body).toEqual({ deleted: 0 });
    });
});
