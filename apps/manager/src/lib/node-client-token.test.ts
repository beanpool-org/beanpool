/**
 * Node sign-in step 7b-1: a fleet manager profile that holds an owner automation token sends it as a bearer, and never
 * a password: not in a header, not in a body. The node has no admin password, so a credential that is not a token is
 * not sent at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as client from './node-client';
import { nodeCredential, saveNodeProfiles, loadNodeProfiles } from './profiles';

const NODE = 'https://node.example';
const TOKEN = `bp_${'a1'.repeat(6)}_${'f0'.repeat(32)}`;
const NOT_A_TOKEN = 'correct-horse-battery-staple';

type Sent = { url: string; headers: Record<string, string>; body: unknown };

function headersOf(init?: RequestInit): Record<string, string> {
    const h = init?.headers;
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries([...h.entries()]);
    if (Array.isArray(h)) return Object.fromEntries(h);
    return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

/**
 * Call every exported function of node-client with the node's URL first and the credential in every other place (so
 * whichever argument a function takes as its credential is the credential), and keep each request.
 */
async function sweep(credential: string): Promise<Sent[]> {
    const sent: Sent[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        let body: unknown = undefined;
        if (typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
        sent.push({ url: String(input), headers: headersOf(init), body });
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    for (const [name, fn] of Object.entries(client)) {
        if (typeof fn !== 'function' || /^(set|clear|get|normalize|resolve|is|build|password|format|parse|describe|download)/.test(name)) continue;
        const args = [NODE, ...Array.from({ length: Math.max(0, (fn as (...a: unknown[]) => unknown).length - 1) }, () => credential), credential, credential];
        try { await Promise.race([(fn as (...a: unknown[]) => unknown)(...args), new Promise(r => setTimeout(r, 50))]); } catch { /* a wrong-typed argument: the requests made before it still count */ }
    }
    return sent;
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('a token profile sends the token as a bearer only', () => {
    it('buildAdminHeaders: Authorization: Bearer, no password header, no 2FA session', () => {
        const h = client.buildAdminHeaders(TOKEN);
        expect(h.Authorization).toBe(`Bearer ${TOKEN}`);
        expect(h['X-Admin-Password']).toBeUndefined();
        expect(h['X-Admin-2FA-Session']).toBeUndefined();
    });

    it('buildAdminHeaders: a credential that is not token-shaped, or none, sends no credential at all', () => {
        for (const credential of [NOT_A_TOKEN, 'x', '', undefined]) {
            const h = client.buildAdminHeaders(credential);
            expect(h.Authorization, String(credential)).toBeUndefined();
            expect(h['X-Admin-Password'], String(credential)).toBeUndefined();
            expect(h['X-Admin-2FA-Session'], String(credential)).toBeUndefined();
            expect(JSON.stringify(h), String(credential)).not.toContain(NOT_A_TOKEN);
        }
    });

    it('nodeCredential: a profile\'s token is its one credential', () => {
        expect(nodeCredential({ automationToken: TOKEN })).toBe(TOKEN);
        expect(nodeCredential({})).toBeUndefined();
        expect(nodeCredential(undefined)).toBeUndefined();
    });

    it('every node-client request: bearer only, no password in a header, a body or the URL', async () => {
        const sent = await sweep(TOKEN);
        // A representative set: dozens of callers, including the ones that used to put the password in the body.
        expect(sent.length).toBeGreaterThan(60);
        const withAuth = sent.filter(s => s.headers.authorization);
        expect(withAuth.length).toBeGreaterThan(60);
        for (const s of sent) {
            // The token appears in exactly one place: the Authorization header.
            for (const [k, v] of Object.entries(s.headers)) if (k !== 'authorization') expect(v, `${s.url} ${k}`).not.toContain(TOKEN);
            expect(s.headers['x-admin-2fa-session'], s.url).toBeUndefined();
            expect(s.headers['x-admin-password'], s.url).toBeUndefined();
            if (s.headers.authorization) expect(s.headers.authorization).toBe(`Bearer ${TOKEN}`);
            // No body carries a password or credential field. (The sweep puts the credential in every argument slot, so a
            // body may hold it as an id or a name; only a field that is a credential by name is a fault.)
            if (s.body && typeof s.body === 'object') expect(Object.keys(s.body as object), s.url).not.toEqual(expect.arrayContaining(['password']));
            if (s.body && typeof s.body === 'object') for (const k of Object.keys(s.body as object)) expect(k, s.url).not.toMatch(/^(password|adminPassword|credential|authorization|x-admin-secret)$/i);
            expect(s.url).not.toMatch(/password=/i);
            // ...and only to its own node: the node's URL, or the manager's proxy to that node. Never the dashboard's
            // own origin (/api/manager/*), which is not the node.
            if (s.headers.authorization) expect(s.url, s.url).toMatch(/^(https:\/\/node\.example\/|\/proxy\/https\/node\.example\/)/);
            if (s.url.startsWith('/api/manager/')) expect(JSON.stringify(s.body ?? null), s.url).not.toContain(TOKEN);
        }
        expect(sent.some(s => s.url.startsWith('/api/manager/'))).toBe(true);
    });

    it('a profile credential that is not a token sends nothing: no bearer, no password header, no body password', async () => {
        const sent = await sweep(NOT_A_TOKEN);
        expect(sent.length).toBeGreaterThan(60);
        expect(sent.some(s => s.headers.authorization)).toBe(false);
        expect(sent.some(s => s.headers['x-admin-password'])).toBe(false);
        expect(sent.some(s => s.headers['x-admin-2fa-session'])).toBe(false);
        for (const s of sent) {
            // The credential is in no header and no URL credential parameter, and no body carries a password or credential field.
            // (The sweep puts it in every argument slot, so a URL may hold it as a plain value such as days=; only a
            // parameter that is a credential by name is a fault.)
            for (const k of ['authorization', 'x-admin-password', 'x-admin-2fa-session']) expect(s.headers[k], `${s.url} ${k}`).toBeUndefined();
            expect(s.url).not.toMatch(/(password|credential|token|secret|auth)[a-z]*=/i);
            if (s.body && typeof s.body === 'object') for (const k of Object.keys(s.body as object)) expect(k, s.url).not.toMatch(/^(password|adminPassword|credential|authorization|x-admin-secret)$/i);
        }
    });
});

describe('the dashboard\'s own /api/manager routes get no credential', () => {
    it('a backup download from /api/manager sends no token and no password', async () => {
        for (const credential of [TOKEN, NOT_A_TOKEN]) {
            const sent: Sent[] = [];
            vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                sent.push({ url: String(input), headers: headersOf(init), body: undefined });
                return new Response(JSON.stringify({ error: 'no' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
            }));
            await client.downloadAdminFile('/api/manager/backups/download-db', { nodeId: 'n1' }, credential, 'x.tar.gz').catch(() => undefined);
            for (const s of sent) {
                expect(s.headers.authorization, s.url).toBeUndefined();
                expect(s.headers['x-admin-password'], s.url).toBeUndefined();
                expect(s.headers['x-admin-2fa-session'], s.url).toBeUndefined();
            }
        }
    });

    it('a harvest sync has no credential to send, so it says so and sends nothing', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const sync = client.triggerHarvesterSync as (...a: unknown[]) => Promise<unknown>;
        await expect(sync('n1', NODE, TOKEN)).rejects.toThrow(/harvest/i);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('the snapshot schedule', () => {
    it('is the node\'s real one, and a schedule that can\'t be read is never made up', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ config: { enabled: false, intervalHours: 6, keep: 3 } }), { status: 200 })));
        await expect(client.fetchNodeSnapshotSchedule(NODE, TOKEN)).resolves.toEqual({ enabled: false, intervalHours: 6, keep: 3 });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no' }), { status: 403 })));
        await expect(client.fetchNodeSnapshotSchedule(NODE, TOKEN)).rejects.toThrow();
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })));
        await expect(client.fetchNodeSnapshotSchedule(NODE, TOKEN)).rejects.toThrow();
    });
});

describe('the token is kept in memory only', () => {
    it('saveNodeProfiles never writes the token to localStorage, and the page still holds it', () => {
        saveNodeProfiles([{ id: 'n1', name: 'N', url: NODE, automationToken: TOKEN }]);
        expect(localStorage.getItem('bp_fleet_profiles')).not.toContain(TOKEN);
        expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
        expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
        expect(loadNodeProfiles().find(p => p.id === 'n1')?.automationToken).toBe(TOKEN);
    });
});

describe('no component puts a credential in a body by hand', () => {
    it('no source file puts a password field in a request body', () => {
        const root = path.resolve(__dirname, '..');
        const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
            .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
        const offenders = walk(root)
            .filter(f => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f))
            .filter(f => /password:\s*(activeNode|credential|pwd|node\.|p\.|profile\.)/.test(fs.readFileSync(f, 'utf8')));
        expect(offenders).toEqual([]);
    });
});
