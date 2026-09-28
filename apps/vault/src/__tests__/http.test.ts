import { afterEach, describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { buildBoundRequestHeaders, ed25519Signer } from '@beanpool/core';
import { GLOBAL_ORIGIN } from '../api/server.js';
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

    it('memory hygiene: refuses debugger flags anywhere and a possible core file on Linux', () => {
        const clean = { mlock: 'unavailable' as const, coreDumps: 'off' as const, swap: 'none' as const, kdump: 'off' as const, ptraceScope: 3, debugFlags: [] };
        expect(hygieneRefusal(clean, 'linux')).toBeNull();
        expect(hygieneRefusal({ ...clean, coreDumps: 'on' }, 'linux')).toMatch(/LimitCORE=0/);
        expect(hygieneRefusal({ ...clean, coreDumps: 'unknown' }, 'darwin')).toBeNull();
        expect(hygieneRefusal({ ...clean, debugFlags: ['--inspect'] }, 'darwin')).toMatch(/--inspect/);
        expect(checkMemoryHygiene().mlock).toBe('unavailable');
    });
});
