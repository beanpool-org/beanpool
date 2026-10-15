import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { buildBoundRequestHeaders, ed25519Signer } from '@beanpool/core';
import { NonceStore } from '../api/auth.js';
import { GLOBAL_ORIGIN, LIMITS } from '../api/server.js';
import { listBackups } from '../custodian/lib.js';
import { checkMemoryHygiene, hygieneRefusal } from '../keyholder/hygiene.js';
import { deposit, doGenesis, get, newMember, signed, startRestore, startVault, type VaultUnderTest } from './harness.js';

/** The HTTP surface around the routes: CORS, health, the report, signed-request refusals, a missing keyholder. */

let v: VaultUnderTest;
afterEach(async () => {
    await v.close();
});

async function preflight(origin: string): Promise<Response> {
    return fetch(`${v.baseUrl}/v1/restore`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-public-key,x-signature' },
    });
}

describe('the HTTP surface', () => {
    it('lets global\'s web app call it from the browser, and no other origin', async () => {
        v = await startVault();
        const ok = await preflight(GLOBAL_ORIGIN);
        expect(ok.status).toBe(204);
        expect(ok.headers.get('access-control-allow-origin')).toBe(GLOBAL_ORIGIN);
        expect(ok.headers.get('access-control-allow-headers')).toMatch(/X-Signed-For/);
        const evil = await preflight('https://evil.test');
        expect(evil.headers.get('access-control-allow-origin')).toBeNull();
        const health = await fetch(`${v.baseUrl}/v1/health`, { headers: { Origin: 'https://evil.test' } });
        expect(health.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('health says locked or open, the release and since when; nothing else', async () => {
        v = await startVault();
        const locked = await get(v, '/v1/health');
        expect(Object.keys(locked.body).sort()).toEqual(['release', 'since', 'state']);
        expect(locked.body.state).toBe('locked');
        await doGenesis(v);
        const open = await get(v, '/v1/health');
        expect(open.body.state).toBe('open');
        expect(new Date(open.body.since).getTime()).toBe(v.clock.now());
    });

    it('publishes signed daily totals, with nothing per member', async () => {
        v = await startVault();
        const g = await doGenesis(v);
        const member = newMember();
        await deposit(v, g, member, 'google', 'report-sub', { pushToken: 'ExponentPushToken[r]' });
        await startRestore(v, 'google', 'report-sub');
        const r = await get(v, '/v1/report');
        expect(r.status).toBe(200);
        const { text, signature } = r.body.report as { text: string; signature: string };
        expect(ed25519.verify(Buffer.from(signature, 'base64url'), Buffer.from(`beanpool-vault-report/1\n${text}`), Buffer.from(r.body.ticketKey, 'hex'))).toBe(true);
        const report = JSON.parse(text);
        expect(report).toMatchObject({ copies: 1, counts: { deposits: 1, holds: 1, restores: { google: 1 } } });
        for (const secret of [member.key, 'report-sub', 'ExponentPushToken']) expect(text).not.toContain(secret);

        // The next day, yesterday's report is kept, signed, beside today's.
        v.clock.advance(24 * 60 * 60 * 1000);
        const next = await get(v, '/v1/report');
        expect(JSON.parse(next.body.previous.text)).toMatchObject({ counts: { deposits: 1 } });
        expect(JSON.parse(next.body.report.text)).toMatchObject({ counts: { deposits: 0 } });
    });

    it('refuses an unsigned, stale, replayed or oversized request, and a body that is not JSON', async () => {
        v = await startVault();
        await doGenesis(v);
        const member = newMember();
        const url = `${v.baseUrl}/v1/ticket`;
        const body = JSON.stringify({ purpose: 'deposit', provider: 'google' });
        const headersAt = (timestamp: number, text = body) => buildBoundRequestHeaders({
            method: 'POST', url, body: text, publicKeyHex: member.key, sign: ed25519Signer(member.seed), timestamp,
        });
        const post = async (headers: Record<string, string>, text = body) =>
            fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: text });

        expect((await fetch(url, { method: 'POST', body })).status).toBe(401);
        expect((await post(await headersAt(v.clock.now() - 6 * 60 * 1000))).status).toBe(401);
        const once = await headersAt(v.clock.now());
        expect((await post(once)).status).toBe(200);
        const replayed = await post(once);
        expect(replayed.status).toBe(401);
        expect((await replayed.json() as { code: string }).code).toBe('replayed');
        const notJson = '{"purpose":';
        expect((await post(await headersAt(v.clock.now(), notJson), notJson)).status).toBe(400);
        const huge = JSON.stringify({ pad: 'x'.repeat(70 * 1024) });
        expect((await post(await headersAt(v.clock.now(), huge), huge)).status).toBe(413);
        expect((await get(v, '/v1/nowhere')).status).toBe(404);
    });

    it('one address: the 61st signed call in a minute and the 601st report are refused, unsigned; a minute later both answer (case 16 NOTE)', async () => {
        v = await startVault();
        await doGenesis(v);
        const member = newMember();
        for (let i = 0; i < LIMITS.signedCallsPerAddressPerMinute; i++) {
            expect((await signed(v, '/v1/copies/status', {}, member.seed)).status).toBe(200);
        }
        const over = await signed(v, '/v1/copies/status', { challenge: 'x'.repeat(43) }, member.seed);
        expect(over).toMatchObject({ status: 429, body: { code: 'rate_limited' } });
        // Counted before the signature: no keyholder signature, no nonce spent.
        expect(over.body.signed).toBeUndefined();
        for (let i = 0; i < LIMITS.reportsPerAddressPerMinute; i++) expect((await get(v, '/v1/report')).status).toBe(200);
        expect((await get(v, '/v1/report')).body.code).toBe('rate_limited');
        v.clock.advance(60_000);
        expect((await signed(v, '/v1/copies/status', {}, member.seed)).status).toBe(200);
        expect((await get(v, '/v1/report')).status).toBe(200);
    });

    it('custodian routes from one address: the 21st call in a minute is refused 429 before its signature and stores no nonce; a member and a custodian elsewhere still get 200 (B3, review #1981)', async () => {
        v = await startVault({ trustProxy: true });
        await doGenesis(v);
        const member = newMember();
        const from = (address: string) => ({ 'X-Forwarded-For': address });
        const consumed = vi.spyOn(NonceStore.prototype, 'consume');
        try {
            // Keys that are no custodian: each would store a nonce, and the store's cap is shared by everyone.
            for (let i = 0; i < LIMITS.ceremonyCallsPerAddressPerMinute; i++) {
                expect((await signed(v, '/v1/unlock/genesis', { sig: 'x' }, crypto.randomBytes(32), from('203.0.113.7'))).status).toBe(403);
            }
            const stored = consumed.mock.calls.length;
            const over = await signed(v, '/v1/unlock/genesis', { sig: 'x' }, crypto.randomBytes(32), from('203.0.113.7'));
            expect(over).toMatchObject({ status: 429, body: { code: 'rate_limited' } });
            expect(consumed.mock.calls.length).toBe(stored);
            expect((await signed(v, '/v1/copies/status', {}, member.seed, from('198.51.100.20'))).status).toBe(200);
            expect((await listBackups(v.baseUrl, v.custodians[0], v.call())).status).toBe(200);
        } finally {
            consumed.mockRestore();
        }
    });

    it('with the keyholder gone, the vault is locked to the outside', async () => {
        v = await startVault();
        await doGenesis(v);
        await v.restartKeyholder();
        // Close the socket entirely: nothing answers it.
        const kh = v.keyholder();
        kh.lock();
        const { rmSync } = await import('node:fs');
        rmSync(v.socketPath, { force: true });
        expect((await get(v, '/v1/health')).body.state).toBe('locked');
        expect((await signed(v, '/v1/ticket', { purpose: 'deposit', provider: 'google' }, newMember().seed)).status).toBe(503);
    });

    it('memory hygiene: what a misbuilt image got wrong is in the keyholder\'s status and the signed report', async () => {
        const misbuilt = {
            mlock: 'unavailable' as const, coreDumps: 'off' as const, swap: 'present' as const, kdump: 'on' as const, ptraceScope: 1, debugFlags: [],
            sigusr1: 'disabled' as const,
        };
        v = await startVault({ hygiene: misbuilt });
        expect(v.keyholder().status().memory).toEqual(misbuilt);
        await doGenesis(v);
        const r = await get(v, '/v1/report');
        const { text, signature } = r.body.report as { text: string; signature: string };
        expect(ed25519.verify(Buffer.from(signature, 'base64url'), Buffer.from(`beanpool-vault-report/1\n${text}`), Buffer.from(r.body.ticketKey, 'hex'))).toBe(true);
        expect(JSON.parse(text).memory).toEqual(misbuilt);
    });

    it('memory hygiene: refuses debugger flags anywhere and a possible core file on Linux', () => {
        const clean = {
            mlock: 'unavailable' as const, coreDumps: 'off' as const, swap: 'none' as const, kdump: 'off' as const, ptraceScope: 3, debugFlags: [],
            sigusr1: 'disabled' as const,
        };
        expect(hygieneRefusal(clean, 'linux')).toBeNull();
        expect(hygieneRefusal({ ...clean, sigusr1: 'enabled' }, 'darwin')).toMatch(/--disable-sigusr1/);
        expect(hygieneRefusal({ ...clean, coreDumps: 'on' }, 'linux')).toMatch(/LimitCORE=0/);
        expect(hygieneRefusal({ ...clean, coreDumps: 'unknown' }, 'darwin')).toBeNull();
        expect(hygieneRefusal({ ...clean, debugFlags: ['--inspect'] }, 'darwin')).toMatch(/--inspect/);
        expect(checkMemoryHygiene().mlock).toBe('unavailable');
    });
});
