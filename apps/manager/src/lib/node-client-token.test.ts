/**
 * Node sign-in step 7b-1: a fleet manager profile that holds an owner automation token sends it as a bearer, and never
 * a password: not in a header, not in a body. A profile with only a password works as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as client from './node-client';
import { nodeCredential, saveNodeProfiles, loadNodeProfiles } from './profiles';

const NODE = 'https://node.example';
const TOKEN = `bp_${'a1'.repeat(6)}_${'f0'.repeat(32)}`;
const PASSWORD = 'correct-horse-battery-staple';

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
 * whichever argument a function takes as its password, or its 2FA session, is the credential), and keep each request.
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
        const h = client.buildAdminHeaders(TOKEN, 'some-2fa-session');
        expect(h.Authorization).toBe(`Bearer ${TOKEN}`);
        expect(h['X-Admin-Password']).toBeUndefined();
        expect(h['X-Admin-2FA-Session']).toBeUndefined();
    });

    it('passwordField leaves the token out of a body, and keeps a password in it', () => {
        expect(client.passwordField(TOKEN)).toEqual({});
        expect(client.passwordField(PASSWORD)).toEqual({ password: PASSWORD });
        expect(JSON.stringify({ ...client.passwordField(undefined) })).toBe('{}');
    });

    it('nodeCredential: the token wins over a password; never both', () => {
        expect(nodeCredential({ automationToken: TOKEN, adminPassword: PASSWORD })).toBe(TOKEN);
        expect(nodeCredential({ adminPassword: PASSWORD })).toBe(PASSWORD);
        expect(nodeCredential(undefined)).toBeUndefined();
    });

    it('every node-client request: bearer only, no password in a header, a body or the URL', async () => {
        const sent = await sweep(TOKEN);
        // A representative set: dozens of callers, including the ones that used to put the password in the body.
        expect(sent.length).toBeGreaterThan(60);
        const withAuth = sent.filter(s => s.headers.authorization);
        expect(withAuth.length).toBeGreaterThan(60);
        // The manager's own /api/manager routes take no node URL (their first argument is the credential), so this
        // sweep hands them the URL as a password and the token as the 2FA session: no real caller does that.
        for (const s of sent.filter(x => !x.url.startsWith('/api/manager/'))) {
            // The token appears in exactly one place: the Authorization header.
            for (const [k, v] of Object.entries(s.headers)) if (k !== 'authorization') expect(v, `${s.url} ${k}`).not.toContain(TOKEN);
            expect(s.headers['x-admin-2fa-session'], s.url).toBeUndefined();
            if (s.headers.authorization) expect(s.headers.authorization).toBe(`Bearer ${TOKEN}`);
            if (s.body && typeof s.body === 'object') expect((s.body as { password?: unknown }).password, s.url).not.toBe(TOKEN);
            expect(s.url).not.toMatch(/password=/i);
        }
    });

    it('a password profile works as today: the password header and the body password, no bearer', async () => {
        const sent = await sweep(PASSWORD);
        expect(sent.length).toBeGreaterThan(60);
        expect(sent.some(s => s.headers.authorization)).toBe(false);
        expect(sent.filter(s => s.headers['x-admin-password'] === PASSWORD).length).toBeGreaterThan(60);
        // The callers that sent the password in the body still do (the node reads it there on older builds).
        const bodyPassword = sent.filter(s => s.body && typeof s.body === 'object' && (s.body as { password?: string }).password === PASSWORD);
        expect(bodyPassword.length).toBeGreaterThan(25);
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
    it('every body password in src goes through passwordField', () => {
        const root = path.resolve(__dirname, '..');
        const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
            .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
        const offenders = walk(root)
            .filter(f => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f))
            .filter(f => /password:\s*(activeNode|adminPassword|pwd|node\.|p\.|profile\.)/.test(fs.readFileSync(f, 'utf8')));
        expect(offenders).toEqual([]);
    });
});
