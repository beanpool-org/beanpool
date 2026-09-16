import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    fetchHarvesterStatus,
    triggerHarvesterSync,
    fetchNodeHistory,
    normalizeNodeUrl,
    resolveNodeApiUrl,
    buildAdminHeaders,
    isTotpRequired,
    getTfaSessionToken,
    setTfaSessionToken,
    clearAllTfaSessionTokens,
    loginToNode,
    fetchNodeTreasuries,
    createNodeTreasury,
    fetchNodeSnapshots,
    createNodeSnapshot,
    deleteNodeSnapshot,
    updateNodeReplicationCadence,
    forceNodeResync,
    normalizeNodeData,
    normalizeKeepers,
    normalizeKeeperPubkey,
} from './node-client';

describe('normalizeNodeUrl', () => {
    it('returns default URL when rawUrl is empty or whitespace', () => {
        expect(normalizeNodeUrl('')).toBe('https://localhost:8443');
        expect(normalizeNodeUrl('   ')).toBe('https://localhost:8443');
    });

    it('prepends https:// if scheme is missing', () => {
        expect(normalizeNodeUrl('example.com')).toBe('https://example.com');
        expect(normalizeNodeUrl('192.168.1.50:8443')).toBe('https://192.168.1.50:8443');
    });

    it('preserves existing http or https scheme', () => {
        expect(normalizeNodeUrl('http://localhost:8080')).toBe('http://localhost:8080');
        expect(normalizeNodeUrl('https://node.beanpool.org')).toBe('https://node.beanpool.org');
    });

    it('trims whitespace and removes trailing slashes', () => {
        expect(normalizeNodeUrl('  https://node.beanpool.org/// ')).toBe('https://node.beanpool.org');
    });
});

describe('buildAdminHeaders', () => {
    it('returns Content-Type application/json by default', () => {
        expect(buildAdminHeaders()).toEqual({ 'Content-Type': 'application/json' });
    });

    it('includes X-Admin-Password when password is provided', () => {
        expect(buildAdminHeaders('secret123')).toEqual({
            'Content-Type': 'application/json',
            'X-Admin-Password': 'secret123',
        });
    });

    it('includes X-Admin-2FA-Session when token is provided', () => {
        expect(buildAdminHeaders(undefined, 'tfa-token-abc')).toEqual({
            'Content-Type': 'application/json',
            'X-Admin-2FA-Session': 'tfa-token-abc',
        });
    });

    it('includes both password and 2FA session token when provided', () => {
        expect(buildAdminHeaders('secret123', 'tfa-token-abc')).toEqual({
            'Content-Type': 'application/json',
            'X-Admin-Password': 'secret123',
            'X-Admin-2FA-Session': 'tfa-token-abc',
        });
    });
});

describe('isTotpRequired', () => {
    it('returns true when response body totpRequired is true', () => {
        expect(isTotpRequired({ totpRequired: true })).toBe(true);
    });

    it('returns false when response body totpRequired is false or missing', () => {
        expect(isTotpRequired({ totpRequired: false })).toBe(false);
        expect(isTotpRequired({})).toBe(false);
        expect(isTotpRequired(null)).toBe(false);
        expect(isTotpRequired(undefined)).toBe(false);
    });
});

describe('TFA Session Token Helpers', () => {
    beforeEach(() => {
        sessionStorage.clear();
    });

    it('sets and gets TFA session token', () => {
        expect(getTfaSessionToken('profile1')).toBeUndefined();

        setTfaSessionToken('profile1', 'token-123');
        expect(getTfaSessionToken('profile1')).toBe('token-123');
    });

    it('removes token when setting token to undefined', () => {
        setTfaSessionToken('profile1', 'token-123');
        expect(getTfaSessionToken('profile1')).toBe('token-123');

        setTfaSessionToken('profile1', undefined);
        expect(getTfaSessionToken('profile1')).toBeUndefined();
    });

    it('clears all TFA session tokens without affecting other sessionStorage keys', () => {
        setTfaSessionToken('profile1', 'token-1');
        setTfaSessionToken('profile2', 'token-2');
        sessionStorage.setItem('unrelated_key', 'value');

        clearAllTfaSessionTokens();

        expect(getTfaSessionToken('profile1')).toBeUndefined();
        expect(getTfaSessionToken('profile2')).toBeUndefined();
        expect(sessionStorage.getItem('unrelated_key')).toBe('value');
    });
});

describe('resolveNodeApiUrl', () => {
    it('resolves direct endpoint when target origin matches current location origin', () => {
        vi.stubGlobal('location', { origin: 'https://node.beanpool.org' });

        const url = resolveNodeApiUrl('https://node.beanpool.org', '/api/local/admin/diagnostics');
        expect(url).toBe('https://node.beanpool.org/api/local/admin/diagnostics');

        vi.unstubAllGlobals();
    });

    it('routes through proxy when target node is on a different origin', () => {
        vi.stubGlobal('location', { origin: 'https://manager.beanpool.org' });

        const url = resolveNodeApiUrl('https://node.beanpool.org:8443', 'api/local/admin/diagnostics');
        expect(url).toBe('/proxy/https/node.beanpool.org:8443/api/local/admin/diagnostics');

        vi.unstubAllGlobals();
    });

    it('appends search parameters correctly', () => {
        vi.stubGlobal('location', { origin: 'https://node.beanpool.org' });

        const url = resolveNodeApiUrl('https://node.beanpool.org', '/api/local/admin/onboarding-funnel', { days: '30' });
        expect(url).toBe('https://node.beanpool.org/api/local/admin/onboarding-funnel?days=30');

        vi.unstubAllGlobals();
    });

    it('appends search parameters to proxied endpoint correctly', () => {
        vi.stubGlobal('location', { origin: 'https://manager.beanpool.org' });

        const url = resolveNodeApiUrl('https://node.beanpool.org', '/api/local/admin/onboarding-funnel', { days: '30' });
        expect(url).toBe('/proxy/https/node.beanpool.org/api/local/admin/onboarding-funnel?days=30');

        vi.unstubAllGlobals();
    });
});

describe('harvester helpers send the manager credential', () => {
    // These three call /api/manager/* on the same origin, and every one of those routes is
    // behind checkAdminAuth. They previously sent no credential at all, so each answered 401
    // and the Harvested Fleet Backups tab sat permanently empty.
    let fetchMock: ReturnType<typeof vi.fn>;

    const lastCall = () => fetchMock.mock.calls[0];
    const headersOf = (init?: RequestInit) => (init?.headers ?? {}) as Record<string, string>;

    beforeEach(() => {
        fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ nodes: [], harvestState: {}, history: [] }),
            text: async () => '',
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    it('fetchHarvesterStatus sends X-Admin-Password', async () => {
        await fetchHarvesterStatus('manager-secret');
        const [url, init] = lastCall();
        expect(url).toBe('/api/manager/backups/status');
        expect(headersOf(init)['X-Admin-Password']).toBe('manager-secret');
    });

    it('fetchNodeHistory sends X-Admin-Password', async () => {
        await fetchNodeHistory('mullum', 'manager-secret');
        const [url, init] = lastCall();
        expect(url).toContain('/api/manager/backups/history');
        expect(headersOf(init)['X-Admin-Password']).toBe('manager-secret');
    });

    it('omits the header entirely when no password is held', async () => {
        await fetchHarvesterStatus(undefined);
        expect(headersOf(lastCall()[1])).not.toHaveProperty('X-Admin-Password');
    });

    it('never puts the credential in the URL', async () => {
        await fetchNodeHistory('mullum', 'manager-secret');
        expect(String(lastCall()[0])).not.toContain('manager-secret');
    });

    it('triggerHarvesterSync authenticates with the MANAGER password, not the target node\'s', async () => {
        // Two different secrets. The header authenticates us to the local manager API; the body
        // carries the target node's own credential for the server to forward. The server resolves
        // the target as `body.adminPassword || body.password || found.adminPassword`, so leaking
        // the manager password into `password` would override the configured per-node credential.
        await triggerHarvesterSync('mullum', 'https://mullum.example', 'node-secret', 'manager-secret');
        const [, init] = lastCall();
        expect(headersOf(init)['X-Admin-Password']).toBe('manager-secret');

        const body = JSON.parse((init as any).body);
        expect(body.adminPassword).toBe('node-secret');
        expect(body.password).toBe('node-secret');
        expect(JSON.stringify(body)).not.toContain('manager-secret');
    });

    it('falls back to the node password when no manager password is held', async () => {
        await triggerHarvesterSync('mullum', 'https://mullum.example', 'node-secret');
        expect(headersOf(lastCall()[1])['X-Admin-Password']).toBe('node-secret');
    });
});

describe('registrar claim helpers send admin password header', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    const lastCall = () => fetchMock.mock.calls[0];
    const headersOf = (init: any) => (init?.headers ?? {}) as Record<string, string>;

    beforeEach(() => {
        fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ status: 'approved', name: 'mycommunity' }),
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    it('approveRegistrarClaim sends X-Admin-Password and body password when nodeUrl, name, and adminPassword are provided', async () => {
        const { approveRegistrarClaim } = await import('./node-client');
        await approveRegistrarClaim('https://node.example.com', 'mycommunity', 'secret123');
        const [url, init] = lastCall();
        expect(url).toContain('/api/local/admin/registrar/mycommunity/approve');
        expect(headersOf(init)['X-Admin-Password']).toBe('secret123');
        expect(JSON.parse((init as any).body)).toEqual({ password: 'secret123' });
    });

    it('revokeRegistrarClaim sends X-Admin-Password and body password when nodeUrl, name, and adminPassword are provided', async () => {
        const { revokeRegistrarClaim } = await import('./node-client');
        await revokeRegistrarClaim('https://node.example.com', 'mycommunity', 'secret123');
        const [url, init] = lastCall();
        expect(url).toContain('/api/local/admin/registrar/mycommunity/revoke');
        expect(headersOf(init)['X-Admin-Password']).toBe('secret123');
        expect(JSON.parse((init as any).body)).toEqual({ password: 'secret123' });
    });
});

describe('2FA session token transmission in node client admin actions', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    const lastCall = () => fetchMock.mock.calls[0];
    const headersOf = (init: any) => (init?.headers ?? {}) as Record<string, string>;

    beforeEach(() => {
        fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ success: true, rows: [], snapshots: [] }),
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    it('freezeNodeUser, updateNodeUserTier, updateNodeUserVoucher, updateNodeUserOperator, and generateNodeInvite send X-Admin-2FA-Session header when tfaToken is provided', async () => {
        const { freezeNodeUser, updateNodeUserTier, updateNodeUserVoucher, updateNodeUserOperator, generateNodeInvite } = await import('./node-client');

        await freezeNodeUser('https://node.example.com', 'pub123', true, 'secret123', 'tfa-sess-123');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa-sess-123');

        fetchMock.mockClear();

        await updateNodeUserTier('https://node.example.com', 'pub123', 'Resident', 'secret123', 'tfa-sess-123');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa-sess-123');

        fetchMock.mockClear();

        await updateNodeUserVoucher('https://node.example.com', 'pub123', true, 'secret123', 'tfa-sess-123');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa-sess-123');

        fetchMock.mockClear();

        await updateNodeUserOperator('https://node.example.com', 'pub123', true, 'secret123', 'tfa-sess-123');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa-sess-123');

        fetchMock.mockClear();

        await generateNodeInvite('https://node.example.com', 'secret123', 'standard', 'tfa-sess-123');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa-sess-123');
    });

    it('downloadAdminFile sends X-Admin-2FA-Session header when tfaToken is provided', async () => {
        const { downloadAdminFile } = await import('./node-client');
        const origCreate = URL.createObjectURL;
        const origRevoke = URL.revokeObjectURL;
        URL.createObjectURL = vi.fn().mockReturnValue('blob:test');
        URL.revokeObjectURL = vi.fn();

        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Map(),
            blob: async () => new Blob(['test']),
        });

        await downloadAdminFile('/api/manager/backups/download-db', { nodeId: 'test' }, 'secret123', 'test.db', 'tfa-sess-123');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa-sess-123');

        URL.createObjectURL = origCreate;
        URL.revokeObjectURL = origRevoke;
    });

    it('harvester and registrar helpers send X-Admin-2FA-Session header when tfaToken is provided', async () => {
        const {
            fetchHarvesterStatus,
            triggerHarvesterSync,
            fetchNodeHistory,
            getRegistrarPending,
            approveRegistrarClaim,
            revokeRegistrarClaim,
        } = await import('./node-client');

        await fetchHarvesterStatus('secret123', 'tfa-sess-123');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa-sess-123');

        fetchMock.mockClear();

        await triggerHarvesterSync('mullum', 'https://mullum.example', 'node-secret', 'manager-secret', 'tfa-sess-123');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa-sess-123');

        fetchMock.mockClear();

        await fetchNodeHistory('mullum', 'secret123', 'tfa-sess-123');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa-sess-123');

        fetchMock.mockClear();

        await getRegistrarPending('https://node.example.com', 'secret123', 'tfa-sess-123');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa-sess-123');

        fetchMock.mockClear();

        await approveRegistrarClaim('https://node.example.com', 'mycommunity', 'secret123', 'tfa-sess-123');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa-sess-123');

        fetchMock.mockClear();

        await revokeRegistrarClaim('https://node.example.com', 'mycommunity', 'secret123', 'tfa-sess-123');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa-sess-123');
    });
});

describe('node client login, treasury, snapshot, and replication helpers', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    const lastCall = () => fetchMock.mock.calls[0];
    const headersOf = (init: any) => (init?.headers ?? {}) as Record<string, string>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    it('loginToNode posts password and totpCode and returns body on success', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ success: true, tfaSessionToken: 'sess-123' }),
        });

        const res = await loginToNode('https://node.example.com', 'pwd123', '654321');

        expect(res).toEqual({ success: true, tfaSessionToken: 'sess-123' });
        const [url, init] = lastCall();
        expect(url).toContain('/api/admin/login');
        expect(JSON.parse((init as any).body)).toEqual({ password: 'pwd123', totpCode: '654321' });
    });

    it('loginToNode throws custom error message on login failure', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 401,
            json: async () => ({ error: 'Invalid TOTP code' }),
        });

        await expect(loginToNode('https://node.example.com', 'pwd123', '000000')).rejects.toThrow('Invalid TOTP code');
    });

    it('fetchNodeTreasuries returns treasuries array on success and empty array on failure', async () => {
        const mockTreasuries = [{ publicKey: 'treasury1', name: 'Community Chest', balance: 100, creditLine: 50, liveOffers: 2 }];
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ treasuries: mockTreasuries }),
        });

        const treasuries = await fetchNodeTreasuries('https://node.example.com');
        expect(treasuries).toEqual(mockTreasuries);

        fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
        const empty = await fetchNodeTreasuries('https://node.example.com');
        expect(empty).toEqual([]);
    });

    it('createNodeTreasury sends POST to create a treasury', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, publicKey: 'new-treasury-pub' }),
        });

        const res = await createNodeTreasury(
            'https://node.example.com',
            { name: 'Reserve', avatar: 'sprout', creditLine: 1000 },
            'adminpass',
            'tfa123'
        );

        expect(res).toEqual({ success: true, publicKey: 'new-treasury-pub' });
        const [url, init] = lastCall();
        expect(url).toContain('/api/local/admin/treasury');
        expect(headersOf(init)['X-Admin-Password']).toBe('adminpass');
        expect(headersOf(init)['X-Admin-2FA-Session']).toBe('tfa123');
        expect(JSON.parse((init as any).body)).toEqual({
            name: 'Reserve',
            avatar: 'sprout',
            creditLine: 1000,
            password: 'adminpass',
        });
    });

    it('fetchNodeSnapshots, createNodeSnapshot, and deleteNodeSnapshot handle snapshot management', async () => {
        const mockSnapshot = { name: 'snap-1.db', sizeBytes: 1024, createdAt: '2026-01-01' };

        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ snapshots: [mockSnapshot] }),
        });
        const list = await fetchNodeSnapshots('https://node.example.com', 'pwd');
        expect(list).toEqual([mockSnapshot]);

        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ snapshot: mockSnapshot }),
        });
        const created = await createNodeSnapshot('https://node.example.com', 'pwd');
        expect(created).toEqual(mockSnapshot);

        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true }),
        });
        await expect(deleteNodeSnapshot('https://node.example.com', 'snap-1.db', 'pwd')).resolves.toBeUndefined();
    });

    it('updateNodeReplicationCadence and forceNodeResync trigger replication updates', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({ success: true }),
        });

        await updateNodeReplicationCadence('https://node.example.com', 30, 5, 'pwd');
        expect(lastCall()[0]).toContain('/api/local/admin/backup-config');
        expect(JSON.parse((lastCall()[1] as any).body)).toEqual({ pullSeconds: 30, reconcileMinutes: 5, password: 'pwd' });

        fetchMock.mockClear();

        await forceNodeResync('https://node.example.com', 'pwd');
        expect(lastCall()[0]).toContain('/api/local/admin/replication-resync');
        expect(JSON.parse((lastCall()[1] as any).body)).toEqual({ password: 'pwd' });
    });
});

describe('normalizeKeeperPubkey and normalizeKeepers', () => {
    it('normalizes string pubkeys directly', () => {
        expect(normalizeKeeperPubkey('pubkey123')).toBe('pubkey123');
        expect(normalizeKeepers(['pk1', 'pk2'])).toEqual(['pk1', 'pk2']);
    });

    it('extracts publicKey from keeper objects', () => {
        const obj1 = { publicKey: 'pubkey_alpha', callsign: 'alpha', avatarUrl: null, grantedAt: null };
        const obj2 = { pubkey: 'pubkey_beta', callsign: 'beta' };
        expect(normalizeKeeperPubkey(obj1)).toBe('pubkey_alpha');
        expect(normalizeKeeperPubkey(obj2)).toBe('pubkey_beta');
        expect(normalizeKeepers([obj1, obj2])).toEqual(['pubkey_alpha', 'pubkey_beta']);
    });

    it('filters out empty or malformed keeper entries', () => {
        expect(normalizeKeeperPubkey(null)).toBe('');
        expect(normalizeKeeperPubkey(undefined)).toBe('');
        expect(normalizeKeeperPubkey(12345)).toBe('');
        expect(normalizeKeeperPubkey({})).toBe('');
        expect(normalizeKeepers([null, undefined, 42, {}, 'valid_pk'])).toEqual(['valid_pk']);
        expect(normalizeKeepers(null)).toEqual([]);
        expect(normalizeKeepers(undefined)).toEqual([]);
        expect(normalizeKeepers('not-an-array' as any)).toEqual([]);
    });
});

describe('normalizeNodeData boundary normalization', () => {
    it('handles null, undefined, and non-object inputs gracefully', () => {
        expect(normalizeNodeData(null)).toEqual({});
        expect(normalizeNodeData(undefined)).toEqual({});
        expect(normalizeNodeData('string' as any)).toEqual({});
    });

    it('normalizes snake_case report fields and keeper shapes', () => {
        const raw = {
            reports: [
                {
                    id: 42,
                    reporter_pubkey: 'reporter_pk_1',
                    target_pubkey: 'target_pk_2',
                    reason: 'Spam activity',
                    status: 'pending',
                },
            ],
            members: [
                {
                    pubkey: 'member_pk_1',
                    displayName: 'Alice',
                    standing: 'Steward',
                },
            ],
        };

        const normalized = normalizeNodeData(raw);
        expect(normalized.reports?.[0].targetPubkey).toBe('target_pk_2');
        expect(normalized.reports?.[0].target_pubkey).toBe('target_pk_2');
        expect(normalized.reports?.[0].reporterPubkey).toBe('reporter_pk_1');
        expect(normalized.reports?.[0].reporter_pubkey).toBe('reporter_pk_1');
        expect(normalized.reports?.[0].id).toBe('42');
        expect(normalized.reportCount).toBe(1);

        expect(normalized.members?.[0].publicKey).toBe('member_pk_1');
        expect(normalized.members?.[0].pubkey).toBe('member_pk_1');
        expect(normalized.members?.[0].name).toBe('Alice');
        expect(normalized.members?.[0].tier).toBe('Steward');
    });

    it('guards against malformed report targetPubkeys (objects, numbers, nulls)', () => {
        const raw = {
            reports: [
                {
                    id: 'rep-obj',
                    targetPubkey: { publicKey: 'nested_target_pk' },
                    reporterPubkey: { publicKey: 'nested_reporter_pk' },
                },
                {
                    id: 'rep-num',
                    targetPubkey: 12345,
                    reporterPubkey: null,
                },
            ],
        };

        const normalized = normalizeNodeData(raw);
        expect(normalized.reports?.[0].targetPubkey).toBe('nested_target_pk');
        expect(normalized.reports?.[0].reporterPubkey).toBe('nested_reporter_pk');
        expect(normalized.reports?.[1].targetPubkey).toBe('');
        expect(normalized.reports?.[1].reporterPubkey).toBe('');
    });

    it('normalizes member aliases (isVoucher, isOperator, can_operate, callsign)', () => {
        const raw = {
            members: [
                {
                    pubkey: 'pk_alias_1',
                    callsign: 'Maverick',
                    isVoucher: true,
                    can_operate: true,
                    standing: 'Steward',
                },
                {
                    pubkey: 'pk_alias_2',
                    displayName: 'Goose',
                    callsign: 'Bradley',
                    isOperator: true,
                    canVouch: true,
                },
            ],
        };

        const normalized = normalizeNodeData(raw);
        expect(normalized.members?.[0].name).toBe('Maverick');
        expect(normalized.members?.[0].callsign).toBe('Maverick');
        expect(normalized.members?.[0].canVouch).toBe(true);
        expect(normalized.members?.[0].canOperate).toBe(true);
        expect(normalized.members?.[0].tier).toBe('Steward');

        expect(normalized.members?.[1].name).toBe('Goose');
        expect(normalized.members?.[1].callsign).toBe('Bradley');
        expect(normalized.members?.[1].canVouch).toBe(true);
        expect(normalized.members?.[1].canOperate).toBe(true);
    });

    it('extracts report targetPubkey and reporterPubkey from objects with pubkey or nested keys', () => {
        const raw = {
            reports: [
                {
                    id: 'rep-pubkey',
                    target_pubkey: { pubkey: 'target_pubkey_val' },
                    reporter_pubkey: { pubkey: 'reporter_pubkey_val' },
                },
            ],
        };

        const normalized = normalizeNodeData(raw);
        expect(normalized.reports?.[0].targetPubkey).toBe('target_pubkey_val');
        expect(normalized.reports?.[0].target_pubkey).toBe('target_pubkey_val');
        expect(normalized.reports?.[0].reporterPubkey).toBe('reporter_pubkey_val');
        expect(normalized.reports?.[0].reporter_pubkey).toBe('reporter_pubkey_val');
    });
});

