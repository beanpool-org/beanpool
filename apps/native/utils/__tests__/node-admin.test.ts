import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    getEnrolledLevelAsync: vi.fn(),
    authenticateAsync: vi.fn(),
}));

vi.mock('../crypto', () => ({
    buildSignedHeaders: vi.fn(async (method: string, path: string) => ({
        'Content-Type': 'application/json',
        'X-Public-Key': 'pk',
        'X-Signature': `sig:${method}:${path}`,
        'X-Timestamp': '1',
        'X-Nonce': 'n',
    })),
    signData: vi.fn(async () => new Uint8Array([1, 2, 3])),
    encodeUtf8: (s: string) => new TextEncoder().encode(s),
    hexToBytes: () => new Uint8Array(32),
    encodeBase64: () => 'AQID',
}));

import * as LocalAuthentication from 'expo-local-authentication';
import {
    canManageNode, fetchMyNodeRole, fetchAdminQueue, requireDeviceUnlock, requestSettingsLink,
    buildSettingsHandoffUrl, manageNode,
} from '../node-admin';

const identity = { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), callsign: 'me', createdAt: '' };
const NODE = 'https://mullum.beanpool.org/';

type Reply = { status: number; body: unknown };
function mockFetch(routes: Record<string, Reply | Reply[]>) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const queues = Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const path = new URL(url).pathname;
        const q = queues[path];
        if (!q || q.length === 0) throw new Error(`unexpected fetch ${url}`);
        const r = q.length > 1 ? q.shift()! : q[0];
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response;
    });
    (globalThis as any).fetch = fn;
    return calls;
}

const challengeOk: Reply = { status: 200, body: { challengeId: 'c1', challenge: 'beanpool-admin-auth:c1:1' } };

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(LocalAuthentication.getEnrolledLevelAsync).mockResolvedValue(3 as any);
    vi.mocked(LocalAuthentication.authenticateAsync).mockResolvedValue({ success: true } as any);
});

describe('role gating — only owners and admins see Manage', () => {
    it('canManageNode accepts exactly owner and admin', () => {
        expect(canManageNode('owner')).toBe(true);
        expect(canManageNode('admin')).toBe(true);
        for (const r of [null, undefined, '', 'moderator', 'member', 'OWNER', 1, {}]) expect(canManageNode(r)).toBe(false);
    });

    it('asks the node, signed, and passes an owner through', async () => {
        const calls = mockFetch({ '/api/node-admin/me': { status: 200, body: { role: 'owner', communityName: 'Mullum' } } });
        expect(await fetchMyNodeRole(NODE, identity)).toEqual({ role: 'owner', communityName: 'Mullum' });
        expect(calls[0].url).toBe('https://mullum.beanpool.org/api/node-admin/me');
        expect((calls[0].init?.headers as any)['X-Signature']).toBe('sig:GET:/api/node-admin/me');
    });

    it('a plain member, a moderator or an unknown role gets no button', async () => {
        for (const role of [null, 'moderator', 'superuser']) {
            mockFetch({ '/api/node-admin/me': { status: 200, body: { role } } });
            expect((await fetchMyNodeRole(NODE, identity)).role).toBeNull();
        }
    });

    it('fails closed: an older node (404), a refusal, or no network means no button', async () => {
        mockFetch({ '/api/node-admin/me': { status: 404, body: { error: 'Not Found' } } });
        expect((await fetchMyNodeRole(NODE, identity)).role).toBeNull();
        mockFetch({ '/api/node-admin/me': { status: 401, body: { error: 'sign' } } });
        expect((await fetchMyNodeRole(NODE, identity)).role).toBeNull();
        (globalThis as any).fetch = vi.fn(async () => { throw new Error('offline'); });
        expect((await fetchMyNodeRole(NODE, identity)).role).toBeNull();
    });

    it('the admin queue keeps only sections /settings knows', async () => {
        mockFetch({ '/api/node-admin/queue': { status: 200, body: { total: 3, items: [
            { kind: 'reports', count: 2, label: 'r', section: 'moderation', settingsPath: '/settings#section=moderation' },
            { kind: 'x', count: 1, label: 'x', section: 'javascript:alert(1)', settingsPath: '' },
        ] } } });
        const q = await fetchAdminQueue(NODE, identity);
        expect(q?.items.map(i => i.kind)).toEqual(['reports']);
        mockFetch({ '/api/node-admin/queue': { status: 403, body: { error: 'no' } } });
        expect(await fetchAdminQueue(NODE, identity)).toBeNull();
    });
});

describe("the phone's own unlock comes first", () => {
    it('no screen lock set → explains, never asks the node', async () => {
        vi.mocked(LocalAuthentication.getEnrolledLevelAsync).mockResolvedValue(0 as any);
        const calls = mockFetch({});
        const openUrl = vi.fn();
        const out = await manageNode({ nodeUrl: NODE, identity, communityName: 'Mullum', openUrl });
        expect(out.kind).toBe('no-device-lock');
        expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();
        expect(calls).toHaveLength(0);
        expect(openUrl).not.toHaveBeenCalled();
    });

    it('unlock cancelled or failed → no link requested, nothing opened', async () => {
        vi.mocked(LocalAuthentication.authenticateAsync).mockResolvedValue({ success: false, error: 'user_cancel' } as any);
        const calls = mockFetch({});
        const openUrl = vi.fn();
        expect((await manageNode({ nodeUrl: NODE, identity, communityName: 'Mullum', openUrl })).kind).toBe('unlock-failed');
        expect(calls).toHaveLength(0);
        expect(openUrl).not.toHaveBeenCalled();
    });

    it('the unlock module throwing counts as failure, not as a pass', async () => {
        vi.mocked(LocalAuthentication.getEnrolledLevelAsync).mockRejectedValue(new Error('no module'));
        expect(await requireDeviceUnlock('Mullum')).toBe('failed');
        vi.mocked(LocalAuthentication.getEnrolledLevelAsync).mockResolvedValue(1 as any);
        vi.mocked(LocalAuthentication.authenticateAsync).mockRejectedValue(new Error('boom'));
        expect(await requireDeviceUnlock('Mullum')).toBe('failed');
    });

    it('a device PIN alone is enough (SECRET level), and the device fallback is allowed', async () => {
        vi.mocked(LocalAuthentication.getEnrolledLevelAsync).mockResolvedValue(1 as any);
        expect(await requireDeviceUnlock('Mullum')).toBe('ok');
        expect(vi.mocked(LocalAuthentication.authenticateAsync).mock.calls[0][0]).toMatchObject({ disableDeviceFallback: false });
    });

    it('after a successful unlock: challenge signed, token requested, /settings opened with the token in the fragment', async () => {
        const calls = mockFetch({
            '/api/local/admin/auth/challenge': challengeOk,
            '/api/local/admin/auth/verify-challenge': { status: 200, body: { handshakeToken: 'tok123', role: 'owner' } },
        });
        const openUrl = vi.fn(async () => ({ type: 'opened' }));
        const out = await manageNode({ nodeUrl: NODE, identity, communityName: 'Mullum', section: 'moderation', openUrl });
        expect(out.kind).toBe('opened');
        expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledBefore(globalThis.fetch as any);
        const verifyBody = JSON.parse(calls[1].init!.body as string);
        expect(verifyBody).toEqual({ challengeId: 'c1', memberPubkey: identity.publicKey, signature: 'AQID' });
        expect(openUrl).toHaveBeenCalledWith('https://mullum.beanpool.org/settings#handoff=tok123&section=moderation');
    });
});

describe('the node’s own 2FA still applies', () => {
    it('asks for the code, retries without a second unlock, reports a wrong code', async () => {
        const calls = mockFetch({
            '/api/local/admin/auth/challenge': challengeOk,
            '/api/local/admin/auth/verify-challenge': [
                { status: 401, body: { error: '2FA code required', totpRequired: true } },
                { status: 401, body: { error: 'Invalid 2FA code', totpRequired: true } },
                { status: 200, body: { handshakeToken: 'tok9' } },
            ],
        });
        const openUrl = vi.fn(async () => ({}));
        const first = await manageNode({ nodeUrl: NODE, identity, communityName: 'Mullum', openUrl });
        expect(first.kind).toBe('totp-required');
        if (first.kind !== 'totp-required') return;
        expect(first.wrongCode).toBe(false);
        const second = await first.continueWith('000000');
        expect(second.kind === 'totp-required' && second.wrongCode).toBe(true);
        if (second.kind !== 'totp-required') return;
        expect((await second.continueWith(' 123456 ')).kind).toBe('opened');
        expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
        const lastVerify = calls.filter(c => c.url.endsWith('/verify-challenge')).pop()!;
        expect(JSON.parse(lastVerify.init!.body as string).totpCode).toBe('123456');
        expect(openUrl).toHaveBeenCalledWith('https://mullum.beanpool.org/settings#handoff=tok9');
    });
});

describe('refusals are surfaced, never opened', () => {
    it('a member the node says holds no role', async () => {
        mockFetch({
            '/api/local/admin/auth/challenge': challengeOk,
            '/api/local/admin/auth/verify-challenge': { status: 403, body: { error: 'Signer does not hold a node role' } },
        });
        const openUrl = vi.fn();
        const out = await manageNode({ nodeUrl: NODE, identity, communityName: 'Mullum', openUrl });
        expect(out).toEqual({ kind: 'refused', message: 'Signer does not hold a node role' });
        expect(openUrl).not.toHaveBeenCalled();
    });

    it("the node's admin IP allowlist refusing the phone", async () => {
        mockFetch({ '/api/local/admin/auth/challenge': { status: 403, body: { error: 'Access denied by Gateway Admin IP allowlist' } } });
        expect(await requestSettingsLink(NODE, identity)).toEqual({ kind: 'refused', message: 'Access denied by Gateway Admin IP allowlist' });
    });
});

describe('buildSettingsHandoffUrl', () => {
    it('never puts the token in the query string', () => {
        const u = new URL(buildSettingsHandoffUrl('https://test.beanpool.org', 'a/b+c'));
        expect(u.search).toBe('');
        expect(u.pathname).toBe('/settings');
        expect(u.hash).toBe('#handoff=a%2Fb%2Bc');
    });
    it('drops sections /settings does not know', () => {
        expect(buildSettingsHandoffUrl('https://test.beanpool.org/', 't', 'evil')).toBe('https://test.beanpool.org/settings#handoff=t');
        expect(buildSettingsHandoffUrl('https://test.beanpool.org/', 't', 'disputes')).toBe('https://test.beanpool.org/settings#handoff=t&section=disputes');
    });
});
