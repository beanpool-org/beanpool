import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    isAutomationToken,
    passwordField,
    isAuthFailure,
    nodeReadLimits,
    PASSWORD_NEEDS_2FA_HINT,
    PASSWORD_RETIRED_HINT,
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
    updateEnterpriseLocation,
    clearEnterpriseLocation,
    seedTreasuryOffer,
    fetchTreasuryKeepers,
    assignTreasuryKeeper,
    revokeTreasuryKeeper,
    fetchNodeRoles,
    grantNodeRoleApi,
    revokeNodeRoleApi,
    fetchNodeSnapshots,
    createNodeSnapshot,
    updateNodeReplicationCadence,
    forceNodeResync,
    normalizeNodeData,
    normalizeKeepers,
    normalizeKeeperPubkey,
    pruneInviteBranch,
    deleteNodePost,
    fetchReports,
    dismissNodeReport,
    removeReportedPulseItem,
    getAppAddresses,
    confirmAppAddress,
    removeAppAddress,
    signOutEverywhere,
    formatResolverName,
    reportSubject,
    isManagerApi,
    COMMUNITY_ADMIN,
    emergencySuspendMember,
    haltDecision,
    takeDownDecisionReply,
    liftMemberSuspension,
    acknowledgeShutdownStatus,
    fetchDiskHealth,
    fetchStorageCleanPreview,
    cleanStorageAndCompressLogs,
    fetchAlertsSummary,
    getAlertsStatus,
    saveAlertsChannel,
    acknowledgeAlerts,
    sendTestAlert,
    getOffboxStatus,
    saveOffboxSettings,
    runOffboxBackupNow,
    listOffboxBackups,
    getTlsStatus,
    setOwnAddress,
    forgetStandby,
    passwordNeeds2faError,
    getReplicationTokenStatus,
    generateReplicationToken,
    setReplicationTokenMode,
    clearReplicationToken,
} from './node-client';

/** An Offer's photo as the Manager sends it: the node refuses a new Offer with none. */
const PHOTO = 'data:image/jpeg;base64,cmVzaXplZA==';

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

describe('replication token helpers', () => {
    it('getReplicationTokenStatus posts to /api/local/admin/replication-token/status with auth headers and body password', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ hasToken: true, tokenOnly: false, createdAt: '2026-10-31T00:00:00.000Z' }),
        });
        vi.stubGlobal('fetch', fetchMock);

        const status = await getReplicationTokenStatus('https://node.example.com', 'admin-pass', 'tfa-sess-123');
        expect(status).toEqual({ hasToken: true, tokenOnly: false, createdAt: '2026-10-31T00:00:00.000Z' });
        expect(fetchMock).toHaveBeenCalledWith(
            resolveNodeApiUrl('https://node.example.com', '/api/local/admin/replication-token/status'),
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'X-Admin-Password': 'admin-pass',
                    'X-Admin-2FA-Session': 'tfa-sess-123',
                }),
                body: JSON.stringify({ password: 'admin-pass' }),
            })
        );

        vi.unstubAllGlobals();
    });

    it('getReplicationTokenStatus throws when HTTP status is not ok', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(getReplicationTokenStatus('https://node.example.com')).rejects.toThrow('HTTP 500: Internal Server Error');
        vi.unstubAllGlobals();
    });

    it('generateReplicationToken posts to /api/local/admin/replication-token/generate and returns token', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ success: true, token: 'rep_tok_abc123' }),
        });
        vi.stubGlobal('fetch', fetchMock);

        const res = await generateReplicationToken('https://node.example.com', 'admin-pass', 'tfa-sess-123');
        expect(res).toEqual({ success: true, token: 'rep_tok_abc123' });
        expect(fetchMock).toHaveBeenCalledWith(
            resolveNodeApiUrl('https://node.example.com', '/api/local/admin/replication-token/generate'),
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'X-Admin-Password': 'admin-pass',
                    'X-Admin-2FA-Session': 'tfa-sess-123',
                }),
                body: JSON.stringify({ password: 'admin-pass' }),
            })
        );

        vi.unstubAllGlobals();
    });

    it('generateReplicationToken throws custom error body message on non-ok status', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            json: async () => ({ error: 'Only owners can generate replication tokens' }),
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(generateReplicationToken('https://node.example.com')).rejects.toThrow('Only owners can generate replication tokens');
        vi.unstubAllGlobals();
    });

    it('setReplicationTokenMode posts tokenOnly mode and returns updated status', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ success: true, tokenOnly: true }),
        });
        vi.stubGlobal('fetch', fetchMock);

        const res = await setReplicationTokenMode('https://node.example.com', true, 'admin-pass', 'tfa-sess-123');
        expect(res).toEqual({ success: true, tokenOnly: true });
        expect(fetchMock).toHaveBeenCalledWith(
            resolveNodeApiUrl('https://node.example.com', '/api/local/admin/replication-token/mode'),
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'X-Admin-Password': 'admin-pass',
                    'X-Admin-2FA-Session': 'tfa-sess-123',
                }),
                body: JSON.stringify({ tokenOnly: true, password: 'admin-pass' }),
            })
        );

        vi.unstubAllGlobals();
    });

    it('setReplicationTokenMode throws fallback HTTP status error when response body is empty', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 502,
            statusText: 'Bad Gateway',
            json: async () => {
                throw new Error('invalid json');
            },
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(setReplicationTokenMode('https://node.example.com', false)).rejects.toThrow('HTTP 502: Bad Gateway');
        vi.unstubAllGlobals();
    });

    it('clearReplicationToken posts to /api/local/admin/replication-token/clear and returns success', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ success: true }),
        });
        vi.stubGlobal('fetch', fetchMock);

        const res = await clearReplicationToken('https://node.example.com', 'admin-pass', 'tfa-sess-123');
        expect(res).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledWith(
            resolveNodeApiUrl('https://node.example.com', '/api/local/admin/replication-token/clear'),
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'X-Admin-Password': 'admin-pass',
                    'X-Admin-2FA-Session': 'tfa-sess-123',
                }),
                body: JSON.stringify({ password: 'admin-pass' }),
            })
        );

        vi.unstubAllGlobals();
    });

    it('clearReplicationToken throws custom error body message on non-ok status', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            json: async () => ({ error: 'No replication token set' }),
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(clearReplicationToken('https://node.example.com')).rejects.toThrow('No replication token set');
        vi.unstubAllGlobals();
    });
});

describe('enterprise location helpers', () => {
    it('updateEnterpriseLocation posts location payload and handles success and refusal', async () => {
        const mockSuccess = { success: true, lat: -33.8688, lng: 151.2093 };
        const fetchMock = vi.fn().mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => mockSuccess,
        });
        vi.stubGlobal('fetch', fetchMock);

        const res = await updateEnterpriseLocation(
            'https://node.example.com',
            'treasury-pub-1',
            { lat: -33.8688, lng: 151.2093 },
            'secret123',
            'tfa-sess-1'
        );
        expect(res).toEqual(mockSuccess);

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain('/api/local/admin/treasury/treasury-pub-1/location');
        expect(init.method).toBe('POST');
        expect(init.headers['X-Admin-Password']).toBe('secret123');
        expect(init.headers['X-Admin-2FA-Session']).toBe('tfa-sess-1');
        expect(JSON.parse(init.body)).toEqual({ lat: -33.8688, lng: 151.2093, password: 'secret123' });

        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            json: async () => ({ error: 'Invalid coordinates' }),
        }));
        await expect(updateEnterpriseLocation('https://node.example.com', 'treasury-pub-1', { lat: 999, lng: 999 }, 'secret123'))
            .rejects.toThrow('Invalid coordinates');

        vi.unstubAllGlobals();
    });

    it('clearEnterpriseLocation sends DELETE request and handles success and error', async () => {
        const mockSuccess = { success: true, lat: null, lng: null };
        const fetchMock = vi.fn().mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => mockSuccess,
        });
        vi.stubGlobal('fetch', fetchMock);

        const res = await clearEnterpriseLocation('https://node.example.com', 'treasury-pub-1', 'secret123', 'tfa-sess-1');
        expect(res).toEqual(mockSuccess);

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain('/api/local/admin/treasury/treasury-pub-1/location');
        expect(init.method).toBe('DELETE');
        expect(init.headers['X-Admin-Password']).toBe('secret123');
        expect(init.headers['X-Admin-2FA-Session']).toBe('tfa-sess-1');
        expect(JSON.parse(init.body)).toEqual({ password: 'secret123' });

        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            json: async () => ({}),
        }));
        await expect(clearEnterpriseLocation('https://node.example.com', 'treasury-pub-1', 'secret123'))
            .rejects.toThrow('HTTP 500: Internal Server Error');

        vi.unstubAllGlobals();
    });
});

describe('automation token, auth failure, and read limits helpers', () => {
    it('isAutomationToken identifies valid automation tokens correctly', () => {
        const validToken = 'bp_1234567890ab_' + '0123456789abcdef'.repeat(4);
        expect(isAutomationToken(validToken)).toBe(true);

        expect(isAutomationToken('admin-password-123')).toBe(false);
        expect(isAutomationToken('bp_1234567890ab_short_token')).toBe(false);
        expect(isAutomationToken('')).toBe(false);
        expect(isAutomationToken(undefined)).toBe(false);
        expect(isAutomationToken(null)).toBe(false);
    });

    it('passwordField includes password field only when credential is not an automation token', () => {
        const token = 'bp_1234567890ab_' + '0123456789abcdef'.repeat(4);
        expect(passwordField(token)).toEqual({});
        expect(passwordField('my-secret-password')).toEqual({ password: 'my-secret-password' });
        expect(passwordField(undefined)).toEqual({ password: undefined });
    });

    it('isAuthFailure recognizes authentication failure indicators', () => {
        expect(isAuthFailure('HTTP 401: Unauthorized')).toBe(true);
        expect(isAuthFailure('Error: unauthorized access')).toBe(true);
        expect(isAuthFailure('Invalid admin password provided')).toBe(true);
        expect(isAuthFailure(`Error: ${PASSWORD_NEEDS_2FA_HINT}`)).toBe(true);
        expect(isAuthFailure(`Error: ${PASSWORD_RETIRED_HINT}`)).toBe(true);

        expect(isAuthFailure('HTTP 500: Internal Server Error')).toBe(false);
        expect(isAuthFailure('Failed to fetch node data')).toBe(false);
    });

    it('nodeReadLimits enforces answer timeout and abort signal', async () => {
        vi.useFakeTimers();
        const limits = nodeReadLimits(500, 1000, {
            answer: 'Answer timed out',
            all: 'Body timed out',
        });

        expect(limits.signal.aborted).toBe(false);

        const neverResolving = new Promise<string>(() => {});
        const answerPromise = limits.answer(neverResolving);

        vi.advanceTimersByTime(501);

        await expect(answerPromise).rejects.toThrow('Answer timed out');
        expect(limits.signal.aborted).toBe(true);

        vi.useRealTimers();
    });

    it('nodeReadLimits resolves successfully within time limits', async () => {
        const limits = nodeReadLimits(500, 1000, {
            answer: 'Answer timed out',
            all: 'Body timed out',
        });

        const answerResult = await limits.answer(Promise.resolve('ok'));
        expect(answerResult).toBe('ok');
        expect(limits.signal.aborted).toBe(false);

        const bodyResult = await limits.body(Promise.resolve({ data: 123 }));
        expect(bodyResult).toEqual({ data: 123 });
    });
});

describe('forgetStandby and passwordNeeds2faError', () => {
    it('forgetStandby sends POST with standby id, password, and tfaToken and parses banner response', async () => {
        const mockBanner = {
            success: true,
            incident: null,
            standbys: [{ id: 'sb-1', label: 'Standby 1', lastPullAt: 100, lastCopyAt: null, lastExactAt: null, healthy: true }],
        };
        const fetchMock = vi.fn().mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => mockBanner,
        });
        vi.stubGlobal('fetch', fetchMock);

        const res = await forgetStandby('https://node.example.com', 'sb-1', 'adminpw', 'tfa-sess-999');
        expect(res).toEqual(mockBanner);

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain('/api/local/admin/standby-health/forget');
        expect(init.method).toBe('POST');
        expect(init.headers['X-Admin-Password']).toBe('adminpw');
        expect(init.headers['X-Admin-2FA-Session']).toBe('tfa-sess-999');
        expect(JSON.parse(init.body)).toEqual({ id: 'sb-1', password: 'adminpw' });

        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
            ok: false,
            status: 500,
            statusText: 'Server Error',
        }));
        await expect(forgetStandby('https://node.example.com', 'sb-1')).rejects.toThrow('HTTP 500: Server Error');

        vi.unstubAllGlobals();
    });

    it('passwordNeeds2faError handles non-403 responses, password_retired, and password_needs_2fa status codes', async () => {
        // Non-403 response
        const res200 = new Response(JSON.stringify({ ok: true }), { status: 200 });
        expect(await passwordNeeds2faError(res200)).toBeNull();

        // password_retired response
        const resRetired = new Response(
            JSON.stringify({ code: 'password_retired', error: 'Password retired' }),
            { status: 403 }
        );
        const errRetired = await passwordNeeds2faError(resRetired);
        expect(errRetired).toBeInstanceOf(Error);
        expect(errRetired?.message).toContain(PASSWORD_RETIRED_HINT);

        // password_needs_2fa with custom error text
        const resNeeds2faCustom = new Response(
            JSON.stringify({ code: 'password_needs_2fa', error: 'Custom 2FA required message' }),
            { status: 403 }
        );
        const errCustom = await passwordNeeds2faError(resNeeds2faCustom);
        expect(errCustom).toBeInstanceOf(Error);
        expect(errCustom?.message).toContain('Custom 2FA required message');
        expect(errCustom?.message).toContain(PASSWORD_NEEDS_2FA_HINT);

        // password_needs_2fa with default fallback error text
        const resNeeds2faDefault = new Response(
            JSON.stringify({ code: 'password_needs_2fa', error: '' }),
            { status: 403 }
        );
        const errDefault = await passwordNeeds2faError(resNeeds2faDefault);
        expect(errDefault).toBeInstanceOf(Error);
        expect(errDefault?.message).toContain('This node needs two-factor sign-in for the admin password.');
        expect(errDefault?.message).toContain(PASSWORD_NEEDS_2FA_HINT);

        // 403 with irrelevant code
        const resOther403 = new Response(
            JSON.stringify({ code: 'permission_denied', error: 'Access denied' }),
            { status: 403 }
        );
        expect(await passwordNeeds2faError(resOther403)).toBeNull();
    });
});

describe('getTlsStatus and setOwnAddress', () => {
    it('getTlsStatus returns parsed status on success, null on 403/404, and throws on failure/network error', async () => {
        const tlsData = { ca: "Let's Encrypt", testCa: false, orders: true, identifiers: [] };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => tlsData }));
        const got = await getTlsStatus('https://node.example', 'pw', 'tfa-1');
        expect(got).toEqual(tlsData);

        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }));
        expect(await getTlsStatus('https://node.example', 'pw')).toBeNull();

        vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('Network error')));
        await expect(getTlsStatus('https://node.example', 'pw')).rejects.toThrow('Could not reach the server.');

        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) }));
        await expect(getTlsStatus('https://node.example', 'pw')).rejects.toThrow('Too many tries. Wait a minute.');
    });

    it('setOwnAddress posts address input and returns result, or throws fresh proof / status sentence on refusal', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ success: true, address: 'node.example.org', kind: 'own', communityAddress: true, primaryAddress: 'node.example.org' }),
        });
        vi.stubGlobal('fetch', fetchMock);

        const res = await setOwnAddress('https://node.example', { domain: 'node.example.org' }, 'pw', 'tfa-1', 'code-123');
        expect(res).toEqual({ address: 'node.example.org', kind: 'own', communityAddress: true, primaryAddress: 'node.example.org' });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain('/api/local/admin/public-address/own');
        expect(JSON.parse(init.body)).toEqual({ domain: 'node.example.org', password: 'pw', code: 'code-123' });

        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
            ok: false,
            status: 401,
            json: async () => ({ totpRequired: true, error: 'Code required' }),
        }));
        await expect(setOwnAddress('https://node.example', { domain: 'node.example.org' }, 'pw')).rejects.toThrow('Code required');

        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
            ok: false,
            status: 400,
            json: async () => ({ error: 'Invalid domain name' }),
        }));
        await expect(setOwnAddress('https://node.example', { domain: 'bad' }, 'pw')).rejects.toThrow('Invalid domain name');

        vi.unstubAllGlobals();
    });
});

describe('alerts and offbox backup helpers', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ success: true, ok: true, started: true }),
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    it('getAlertsStatus posts to /api/local/admin/alerts/status with credentials', async () => {
        await getAlertsStatus('https://node.example.com', 'adminpw', 'tfa-123');
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain('/api/local/admin/alerts/status');
        expect(init.method).toBe('POST');
        expect(init.headers['X-Admin-Password']).toBe('adminpw');
        expect(init.headers['X-Admin-2FA-Session']).toBe('tfa-123');
    });

    it('saveAlertsChannel posts channel config update', async () => {
        await saveAlertsChannel('https://node.example.com', { url: 'https://ntfy.sh/mychannel', format: 'ntfy' }, 'adminpw', 'tfa-123');
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain('/api/local/admin/alerts/settings');
        expect(JSON.parse(init.body)).toEqual({ url: 'https://ntfy.sh/mychannel', format: 'ntfy', password: 'adminpw' });
    });

    it('acknowledgeAlerts and sendTestAlert trigger alert management actions', async () => {
        await acknowledgeAlerts('https://node.example.com', 'adminpw', 'tfa-123');
        expect(fetchMock.mock.calls[0][0]).toContain('/api/local/admin/alerts/acknowledge');

        await sendTestAlert('https://node.example.com', 'adminpw', 'tfa-123');
        expect(fetchMock.mock.calls[1][0]).toContain('/api/local/admin/alerts/test');
    });

    it('getOffboxStatus, saveOffboxSettings, runOffboxBackupNow, and listOffboxBackups execute offbox API requests', async () => {
        await getOffboxStatus('https://node.example.com', 'adminpw', 'tfa-123');
        expect(fetchMock.mock.calls[0][0]).toContain('/api/local/admin/offbox-backups/status');

        await saveOffboxSettings('https://node.example.com', { intervalHours: 24, retentionDays: 7 }, 'adminpw', 'tfa-123', 'proof-code-123');
        const [saveUrl, saveInit] = fetchMock.mock.calls[1];
        expect(saveUrl).toContain('/api/local/admin/offbox-backups/settings');
        expect(JSON.parse(saveInit.body)).toEqual({ intervalHours: 24, retentionDays: 7, code: 'proof-code-123', password: 'adminpw' });

        await runOffboxBackupNow('https://node.example.com', 'adminpw', 'tfa-123');
        expect(fetchMock.mock.calls[2][0]).toContain('/api/local/admin/offbox-backups/run');

        await listOffboxBackups('https://node.example.com', 's3-bucket-1', 'adminpw', 'tfa-123');
        const [listUrl, listInit] = fetchMock.mock.calls[3];
        expect(listUrl).toContain('/api/local/admin/offbox-backups/list');
        expect(JSON.parse(listInit.body)).toEqual({ destination: 's3-bucket-1', password: 'adminpw' });
    });
});

describe('formatResolverName, reportSubject, and isManagerApi utility functions', () => {
    it('formatResolverName formats resolver signatures cleanly', () => {
        expect(formatResolverName(null)).toBe(COMMUNITY_ADMIN);
        expect(formatResolverName(undefined)).toBe(COMMUNITY_ADMIN);
        expect(formatResolverName('')).toBe(COMMUNITY_ADMIN);
        expect(formatResolverName('   ')).toBe(COMMUNITY_ADMIN);
        expect(formatResolverName('owner:password')).toBe(COMMUNITY_ADMIN);
        expect(formatResolverName('admin')).toBe(COMMUNITY_ADMIN);
        const pubkey64 = 'a'.repeat(64);
        expect(formatResolverName(pubkey64)).toBe(COMMUNITY_ADMIN);
        expect(formatResolverName('Alice')).toBe('Alice');
        expect(formatResolverName('  Bob  ')).toBe('Bob');
    });

    it('reportSubject identifies the target member for posts and pulse item reports', () => {
        // Post report with author pubkey
        expect(reportSubject({ postId: 'post-1', postAuthorPubkey: 'author-pk-123', targetPubkey: 'reporter-target-pk' })).toBe('author-pk-123');
        // Post report without author pubkey
        expect(reportSubject({ postId: 'post-1' })).toBeNull();
        // Pulse item report target
        expect(reportSubject({ targetPulseItemId: 'pulse-1', targetPubkey: 'pulse-owner-pk' })).toBe('pulse-owner-pk');
        // Pulse item report with pulseItem object and snake_case fallback
        expect(reportSubject({ pulseItem: { id: 'pulse-2' }, target_pubkey: 'snake-owner-pk' })).toBe('snake-owner-pk');
        // Empty report
        expect(reportSubject({})).toBeNull();
    });

    it('isManagerApi checks whether an endpoint path targets manager API routes', () => {
        expect(isManagerApi('/api/manager/backups/status')).toBe(true);
        expect(isManagerApi('api/manager/backups/history')).toBe(true);
        expect(isManagerApi('/api/local/admin/diagnostics')).toBe(false);
        expect(isManagerApi('/api/admin/login')).toBe(false);
    });
});

describe('signOutEverywhere and session revocation', () => {
    it('returns ok: true when /api/local/admin/auth/revoke-all succeeds', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ success: true, breakGlassCodeRetired: true }),
        });
        vi.stubGlobal('fetch', fetchMock);

        const res = await signOutEverywhere();
        expect(res).toEqual({ ok: true, breakGlassCodeRetired: true });
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/local/admin/auth/revoke-all',
            expect.objectContaining({
                method: 'POST',
                credentials: 'same-origin',
                cache: 'no-store',
                body: '{}',
            })
        );
        vi.unstubAllGlobals();
    });

    it('returns network failure message when fetch rejects', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')));
        const res = await signOutEverywhere();
        expect(res).toEqual({
            ok: false,
            message: expect.stringContaining('Could not reach the node'),
        });
        vi.unstubAllGlobals();
    });

    it('handles HTTP 401 unauthorized response with custom or fallback message', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
            ok: false,
            status: 401,
            json: async () => ({ error: 'Session expired' }),
        }));
        const res1 = await signOutEverywhere();
        expect(res1).toEqual({
            ok: false,
            message: expect.stringContaining('Session expired. Sign in again, then try once more.'),
        });

        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
            ok: false,
            status: 401,
            json: async () => ({}),
        }));
        const res2 = await signOutEverywhere();
        expect(res2).toEqual({
            ok: false,
            message: expect.stringContaining('Your sign-in here has already ended.'),
        });
        vi.unstubAllGlobals();
    });
});

describe('node admin decisions and suspensions', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ success: true }),
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    it('emergencySuspendMember sends POST to suspend user with reason', async () => {
        await emergencySuspendMember('https://node.test', 'pubkey-123', 'Repeated policy violations', 'adminpw', 'tfa-1');
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain('/api/local/admin/users/pubkey-123/suspend');
        expect(init.method).toBe('POST');
        expect(init.headers['X-Admin-Password']).toBe('adminpw');
        expect(init.headers['X-Admin-2FA-Session']).toBe('tfa-1');
        expect(JSON.parse(init.body)).toEqual({ reason: 'Repeated policy violations', password: 'adminpw' });
    });

    it('haltDecision sends POST to halt decision with reason', async () => {
        await haltDecision('https://node.test', 'dec-456', 'Quorum error identified', 'adminpw');
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain('/api/local/admin/decisions/dec-456/halt');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ reason: 'Quorum error identified', password: 'adminpw' });
    });

    it("takeDownDecisionReply sends POST to take down a removal vote's reply with reason", async () => {
        await takeDownDecisionReply('https://node.test', 'dec-789', "It gave a member's address", 'adminpw', 'tfa-1');
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain('/api/local/admin/decisions/dec-789/hide-reply');
        expect(init.method).toBe('POST');
        expect(init.headers['X-Admin-2FA-Session']).toBe('tfa-1');
        expect(JSON.parse(init.body)).toEqual({ reason: "It gave a member's address", password: 'adminpw' });
    });

    it('liftMemberSuspension sends POST to reactivate member', async () => {
        await liftMemberSuspension('https://node.test', 'pubkey-123', 'adminpw');
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain('/api/local/admin/users/pubkey-123/status');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ status: 'active', password: 'adminpw' });
    });
});

describe('shutdown, storage, and health helpers', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    it('acknowledgeShutdownStatus posts acknowledgement and returns status', async () => {
        const mockStatus = { uncleanShutdown: false, acknowledged: true };
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ success: true, shutdownStatus: mockStatus }),
        });

        const res = await acknowledgeShutdownStatus('https://node.test', 'pw123', 'tfa-sess');
        expect(res).toEqual({ success: true, shutdownStatus: mockStatus });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain('/api/local/admin/shutdown-status/acknowledge');
        expect(init.headers['X-Admin-2FA-Session']).toBe('tfa-sess');
    });

    it('fetchDiskHealth, fetchStorageCleanPreview, and cleanStorageAndCompressLogs handle disk/storage ops', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ success: true, diskHealth: { usedPercent: 45 } }),
        });
        const diskRes = await fetchDiskHealth('https://node.test', 'pw123');
        expect(diskRes.diskHealth.usedPercent).toBe(45);

        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ success: true, preview: { totalReclaimableBytes: 1024 } }),
        });
        const prevRes = await fetchStorageCleanPreview('https://node.test', 'pw123');
        expect(prevRes.preview.totalReclaimableBytes).toBe(1024);

        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ success: true, totalReclaimedBytes: 2048 }),
        });
        const cleanRes = await cleanStorageAndCompressLogs('https://node.test', 'pw123');
        expect(cleanRes.totalReclaimedBytes).toBe(2048);
    });

    it('fetchAlertsSummary posts and returns flags and report counts', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ flags: [{ id: 'flag1', severity: 'warning' }], reportCount: 3, reportIds: ['r1', 'r2', 'r3'] }),
        });

        const alerts = await fetchAlertsSummary('https://node.test', 'pw123');
        expect(alerts).toEqual({
            flags: [{ id: 'flag1', severity: 'warning' }],
            reportCount: 3,
            reportIds: ['r1', 'r2', 'r3'],
        });
    });
});

describe('harvester helpers send no credential', () => {
    // These call /api/manager/* on the same origin: the server behind this dashboard, not a node. A profile's
    // credential belongs to its own node only (node sign-in step 7b-1), so none goes there, token or password.
    let fetchMock: ReturnType<typeof vi.fn>;

    const lastCall = () => fetchMock.mock.calls[0];

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

    it('fetchHarvesterStatus sends no credential', async () => {
        await fetchHarvesterStatus();
        const [url, init] = lastCall();
        expect(url).toBe('/api/manager/backups/status');
        expect(init).toBeUndefined();
    });

    it('fetchNodeHistory sends no credential', async () => {
        await fetchNodeHistory('mullum');
        const [url, init] = lastCall();
        expect(url).toContain('/api/manager/backups/history');
        expect(init).toBeUndefined();
    });

    it('says plainly when the server behind the dashboard holds no harvested backups', async () => {
        fetchMock.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({}) });
        await expect(fetchHarvesterStatus()).rejects.toThrow(/No harvested backups here/);
    });

    it('triggerHarvesterSync has nothing to send, says so, and sends nothing', async () => {
        await expect(triggerHarvesterSync('mullum')).rejects.toThrow(/No harvested backups here/);
        expect(fetchMock).not.toHaveBeenCalled();
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
        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', json: async () => ({ success: true, code: 'INV-2FA-TEST', type: 'standard' }) });

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

        await downloadAdminFile('/proxy/https/node.example.com/api/local/admin/snapshots/download', { name: 'test' }, 'secret123', 'test.db', 'tfa-sess-123');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa-sess-123');

        URL.createObjectURL = origCreate;
        URL.revokeObjectURL = origRevoke;
    });

    it('registrar helpers send X-Admin-2FA-Session header when tfaToken is provided', async () => {
        const {
            getRegistrarPending,
            approveRegistrarClaim,
            revokeRegistrarClaim,
        } = await import('./node-client');

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

        const treasuries = await fetchNodeTreasuries('https://node.example.com', 'pwd123', 'tfa-session');
        expect(treasuries).toEqual(mockTreasuries);
        // The public list is members' on every node: Settings asks the admin route, with the admin password.
        const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
        expect(url).toBe(resolveNodeApiUrl('https://node.example.com', '/api/local/admin/treasury'));
        expect(init?.headers?.['X-Admin-Password']).toBe('pwd123');
        expect(init?.headers?.['X-Admin-2FA-Session']).toBe('tfa-session');

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

    it("createNodeTreasury and seedTreasuryOffer pass the node's refusal through", async () => {
        fetchMock.mockResolvedValueOnce({ ok: false, status: 400, statusText: 'Bad Request', json: async () => ({ error: 'name and avatar are required' }) });
        await expect(createNodeTreasury('https://node.example.com', { name: '', avatar: '' }, 'pw')).rejects.toThrow('name and avatar are required');

        fetchMock.mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({ error: 'Not a treasury' }) });
        await expect(seedTreasuryOffer('https://node.example.com', 'x', { title: 't', category: 'food', credits: 1, photos: [PHOTO] }, 'pw')).rejects.toThrow('Not a treasury');

        fetchMock.mockResolvedValueOnce({ ok: false, status: 502, statusText: 'Bad Gateway', json: async () => { throw new Error('not json'); } });
        await expect(seedTreasuryOffer('https://node.example.com', 'x', { title: 't', category: 'food', credits: 1, photos: [PHOTO] }, 'pw')).rejects.toThrow('HTTP 502: Bad Gateway');
    });

    it('seedTreasuryOffer sends POST to seed an offer with 2FA session token', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, post: { id: 'offer-1', title: 'Farm Eggs' } }),
        });

        const res = await seedTreasuryOffer(
            'https://node.example.com',
            'treasury-pubkey-123',
            { title: 'Farm Eggs', category: 'food', credits: 10, photos: [PHOTO], description: 'Fresh eggs', repeatable: true },
            'adminpass',
            'tfa123'
        );

        expect(res).toEqual({ success: true, post: { id: 'offer-1', title: 'Farm Eggs' } });
        const [url, init] = lastCall();
        expect(url).toContain('/api/local/admin/treasury/treasury-pubkey-123/offer');
        expect(headersOf(init)['X-Admin-Password']).toBe('adminpass');
        expect(headersOf(init)['X-Admin-2FA-Session']).toBe('tfa123');
        expect(JSON.parse((init as any).body)).toEqual({
            title: 'Farm Eggs',
            category: 'food',
            credits: 10,
            photos: [PHOTO],
            description: 'Fresh eggs',
            repeatable: true,
            password: 'adminpass',
        });
    });

    it('fetchTreasuryKeepers, assignTreasuryKeeper, and revokeTreasuryKeeper send X-Admin-2FA-Session header when tfaToken is provided', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ keepers: ['keeper-1'] }),
        });
        await fetchTreasuryKeepers('https://node.example.com', 'treasury-1', 'adminpass', 'tfa123');
        expect(headersOf(lastCall()[1])['X-Admin-Password']).toBe('adminpass');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa123');

        fetchMock.mockClear();
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ keepers: ['keeper-1', 'keeper-2'] }),
        });
        await assignTreasuryKeeper('https://node.example.com', 'treasury-1', 'keeper-2', 'adminpass', 'tfa123');
        expect(headersOf(lastCall()[1])['X-Admin-Password']).toBe('adminpass');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa123');

        fetchMock.mockClear();
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ keepers: ['keeper-1'] }),
        });
        await revokeTreasuryKeeper('https://node.example.com', 'treasury-1', 'keeper-2', 'adminpass', 'tfa123');
        expect(headersOf(lastCall()[1])['X-Admin-Password']).toBe('adminpass');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa123');
    });

    it("re-key helpers pass the node's own sentence through when it asks for a fresh proof (#1984 confirmation R1)", async () => {
        const { issueRekeyCodeApi, completeRekeyApi, bindRekeyByMatchApi, RekeyBindError } = await import('./node-client');
        const askCode = 'Enter a current code from your authenticator app (or a backup code) to re-key an owner or admin';
        const askPhone = 'Do this from your phone: open BeanPool, press Manage, then make this change there.';
        fetchMock.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: askCode, totpRequired: true }) });
        await expect(issueRekeyCodeApi('https://node.example.com', 'pub1', 'adminpass', 'tfa123')).rejects.toThrow(askCode);
        fetchMock.mockResolvedValueOnce({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({ error: askPhone, code: 'phone_required', phoneRequired: true }) });
        await expect(completeRekeyApi('https://node.example.com', 'pub1', 'RK-AB12-CD34', 'pub2')).rejects.toThrow(askPhone);
        fetchMock.mockResolvedValueOnce({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({ error: askPhone, code: 'phone_required', phoneRequired: true }) });
        const bind = bindRekeyByMatchApi('https://node.example.com', 'pub1', 'RK-AB12-CD34', '47');
        await expect(bind).rejects.toBeInstanceOf(RekeyBindError);
        await expect(bind).rejects.toMatchObject({ message: askPhone, code: 'phone_required', triesLeft: undefined });
    });

    it("removing or suspending an owner, and a shorter span of snapshots, pass the node's own sentence through (#1984 confirmation N-1, N-2)", async () => {
        const { pruneNodeUser, updateNodeSnapshotSchedule, executeOffboardApi } = await import('./node-client');
        const askCode = 'Enter a current code from your authenticator app (or a backup code) to remove or suspend an owner';
        const askPhone = 'Do this from your phone: open BeanPool, press Manage, then make this change there.';
        const stale = 'Press Manage on your phone again, then make this change within 90 seconds.';
        fetchMock.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: askCode, totpRequired: true }) });
        await expect(pruneNodeUser('https://node.example.com', 'pub1', 'adminpass', 'tfa123')).rejects.toThrow(askCode);
        fetchMock.mockResolvedValueOnce({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({ error: askPhone, code: 'phone_required', phoneRequired: true }) });
        await expect(pruneInviteBranch('https://node.example.com', 'pub1')).rejects.toThrow(askPhone);
        fetchMock.mockResolvedValueOnce({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({ error: stale, code: 'step_up_required' }) });
        await expect(emergencySuspendMember('https://node.example.com', 'pub1', 'A reason members can read')).rejects.toThrow(stale);
        fetchMock.mockResolvedValueOnce({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({ error: askPhone, code: 'phone_required', phoneRequired: true }) });
        await expect(executeOffboardApi('https://node.example.com', 'pub1', { resolution: 'prune_zero_balance' })).rejects.toMatchObject({ message: askPhone, code: 'phone_required', status: 403 });
        const fewer = 'Enter a current code from your authenticator app (or a backup code) to keep fewer snapshots, or make them cover less time';
        fetchMock.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: fewer, totpRequired: true }) });
        await expect(updateNodeSnapshotSchedule('https://node.example.com', { keep: 3 }, 'adminpass', 'tfa123')).rejects.toThrow(fewer);
        // A node that answers no sentence still says something.
        fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error', json: async () => { throw new Error('not json'); } });
        await expect(pruneNodeUser('https://node.example.com', 'pub1')).rejects.toThrow('HTTP 500: Server Error');
    });

    it('member rekey and offboard helpers send X-Admin-2FA-Session header when tfaToken is provided', async () => {
        const {
            fetchRekeyStatusApi,
            issueRekeyCodeApi,
            completeRekeyApi,
            fetchOffboardPreviewApi,
            executeOffboardApi,
        } = await import('./node-client');

        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ isInvalidated: false, invalidatedInfo: null, pendingRequest: null, history: [] }),
        });
        await fetchRekeyStatusApi('https://node.example.com', 'pub1', 'adminpass', 'tfa123');
        expect(headersOf(lastCall()[1])['X-Admin-Password']).toBe('adminpass');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa123');

        fetchMock.mockClear();
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, code: '123456', oldPubkey: 'pub1', callsign: 'alice', expiresAt: '', operator: 'op' }),
        });
        await issueRekeyCodeApi('https://node.example.com', 'pub1', 'adminpass', 'tfa123');
        expect(headersOf(lastCall()[1])['X-Admin-Password']).toBe('adminpass');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa123');

        fetchMock.mockClear();
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, oldPubkey: 'pub1', newPubkey: 'pub2', callsign: 'alice' }),
        });
        await completeRekeyApi('https://node.example.com', 'pub1', '123456', 'pub2', 'adminpass', 'tfa123');
        expect(headersOf(lastCall()[1])['X-Admin-Password']).toBe('adminpass');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa123');

        fetchMock.mockClear();
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                member: { publicKey: 'pub1', callsign: 'alice', status: 'active', joinedAt: '' },
                balance: 0,
                commonsBalance: 100,
                costToCommunity: 0,
                projectedCommonsBalance: 100,
                pendingEscrowsCount: 0,
                isSoleOwner: false,
                activeMembers: [],
            }),
        });
        await fetchOffboardPreviewApi('https://node.example.com', 'pub1', 'adminpass', 'tfa123');
        expect(headersOf(lastCall()[1])['X-Admin-Password']).toBe('adminpass');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa123');

        fetchMock.mockClear();
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, memberPubkey: 'pub1', callsign: 'alice', resolution: 'donate_to_commons', balanceSettled: 0 }),
        });
        await executeOffboardApi('https://node.example.com', 'pub1', { resolution: 'donate_to_commons' }, 'adminpass', 'tfa123');
        expect(headersOf(lastCall()[1])['X-Admin-Password']).toBe('adminpass');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa123');
    });

    it('fetchNodeRoles, grantNodeRoleApi, and revokeNodeRoleApi send X-Admin-2FA-Session header when tfaToken is provided', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ roles: [] }),
        });
        await fetchNodeRoles('https://node.example.com', 'adminpass', 'tfa123');
        expect(headersOf(lastCall()[1])['X-Admin-Password']).toBe('adminpass');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa123');

        fetchMock.mockClear();
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true }),
        });
        await grantNodeRoleApi('https://node.example.com', 'pub1', 'admin', 'adminpass', 'tfa123');
        expect(headersOf(lastCall()[1])['X-Admin-Password']).toBe('adminpass');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa123');

        fetchMock.mockClear();
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true }),
        });
        await revokeNodeRoleApi('https://node.example.com', 'pub1', 'admin', 'adminpass', 'tfa123');
        expect(headersOf(lastCall()[1])['X-Admin-Password']).toBe('adminpass');
        expect(headersOf(lastCall()[1])['X-Admin-2FA-Session']).toBe('tfa123');
    });

    it("fetchNodeRoles passes the node's own refusal through", async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 403,
            json: async () => ({ error: 'Break-glass mode active: password authentication restricted to key enrolment only' }),
        });
        await expect(fetchNodeRoles('https://node.example.com', 'adminpass')).rejects.toThrow('Break-glass mode active');

        fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => { throw new Error('not json'); } });
        await expect(fetchNodeRoles('https://node.example.com', 'adminpass')).rejects.toThrow('Failed to fetch node roles (HTTP 502)');
    });

    it("generateNodeInvite passes the node's refusal through and never returns without a code", async () => {
        const { generateNodeInvite } = await import('./node-client');
        fetchMock.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: 'Invalid password' }) });
        await expect(generateNodeInvite('https://node.example.com', 'wrong')).rejects.toThrow('Invalid password');

        fetchMock.mockResolvedValueOnce({ ok: false, status: 502, statusText: 'Bad Gateway', json: async () => { throw new Error('not json'); } });
        await expect(generateNodeInvite('https://node.example.com', 'pw')).rejects.toThrow('HTTP 502: Bad Gateway');

        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', json: async () => ({ success: true }) });
        await expect(generateNodeInvite('https://node.example.com', 'pw')).rejects.toThrow('sent no invite code');

        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', json: async () => ({ success: true, code: 'INV-REAL-1', type: 'standard' }) });
        await expect(generateNodeInvite('https://node.example.com', 'pw')).resolves.toMatchObject({ code: 'INV-REAL-1' });
    });

    it('fetchNodeSnapshots and createNodeSnapshot handle snapshot management (no client deletes one: the route is gone)', async () => {
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

    it('extracts publicKey from keeper objects with various pubkey aliases', () => {
        const obj1 = { publicKey: 'pubkey_alpha', callsign: 'alpha', avatarUrl: null, grantedAt: null };
        const obj2 = { pubkey: 'pubkey_beta', callsign: 'beta' };
        const obj3 = { member_pubkey: 'pubkey_gamma', callsign: 'gamma' };
        const obj4 = { memberPubkey: 'pubkey_delta', callsign: 'delta' };
        const obj5 = { public_key: 'pubkey_epsilon', callsign: 'epsilon' };
        expect(normalizeKeeperPubkey(obj1)).toBe('pubkey_alpha');
        expect(normalizeKeeperPubkey(obj2)).toBe('pubkey_beta');
        expect(normalizeKeeperPubkey(obj3)).toBe('pubkey_gamma');
        expect(normalizeKeeperPubkey(obj4)).toBe('pubkey_delta');
        expect(normalizeKeeperPubkey(obj5)).toBe('pubkey_epsilon');
        expect(normalizeKeepers([obj1, obj2, obj3, obj4, obj5])).toEqual([
            'pubkey_alpha',
            'pubkey_beta',
            'pubkey_gamma',
            'pubkey_delta',
            'pubkey_epsilon',
        ]);
    });

    it('skips empty or whitespace-only candidate keys to find populated alias', () => {
        const obj = { publicKey: '', pubkey: '   ', member_pubkey: 'actual_pubkey' };
        expect(normalizeKeeperPubkey(obj)).toBe('actual_pubkey');
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

describe('pruneInviteBranch', () => {
    it('throws error when pubkey is missing or empty', async () => {
        await expect(pruneInviteBranch('https://node.example.com', '')).rejects.toThrow(
            'Valid public key is required to prune an invite branch'
        );
        await expect(pruneInviteBranch('https://node.example.com', '   ')).rejects.toThrow(
            'Valid public key is required to prune an invite branch'
        );
        await expect(pruneInviteBranch('https://node.example.com', null as any)).rejects.toThrow(
            'Valid public key is required to prune an invite branch'
        );
    });

    it('sends POST to prune branch with trimmed pubkey', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true }),
        });
        vi.stubGlobal('fetch', fetchMock);

        const res = await pruneInviteBranch('https://node.example.com', '  pubkey123  ', 'pwd1', 'sess1');
        expect(res).toEqual({ success: true });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain('/api/local/admin/branches/pubkey123/prune');
        expect(init.method).toBe('POST');
        expect(init.headers['X-Admin-Password']).toBe('pwd1');
        expect(init.headers['X-Admin-2FA-Session']).toBe('sess1');
    });
});

describe('deleteNodePost', () => {
    it('throws error when postId is missing or empty', async () => {
        await expect(deleteNodePost('https://node.example.com', '')).rejects.toThrow(
            'Valid post ID is required to delete a post'
        );
        await expect(deleteNodePost('https://node.example.com', '   ')).rejects.toThrow(
            'Valid post ID is required to delete a post'
        );
        await expect(deleteNodePost('https://node.example.com', undefined as any)).rejects.toThrow(
            'Valid post ID is required to delete a post'
        );
    });

    it('sends POST to delete post with trimmed postId', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true }),
        });
        vi.stubGlobal('fetch', fetchMock);

        const res = await deleteNodePost('https://node.example.com', '  post-456  ', 'pwd1', 'sess1');
        expect(res).toEqual({ success: true });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain('/api/local/admin/posts/post-456/delete');
        expect(init.method).toBe('POST');
        expect(init.headers['X-Admin-Password']).toBe('pwd1');
        expect(init.headers['X-Admin-2FA-Session']).toBe('sess1');
        expect(init.credentials).toBe('same-origin');
    });
});


describe('report normalisation keeps enterprise reports off the post line', () => {
    // The phone app files an enterprise report with the enterprise's key in targetPostId; the server
    // sends postId: null for it on purpose. Falling back to targetPostId made it render as "Post: Untitled Post".
    const enterpriseKey = 'ab'.repeat(32);
    const enterpriseReport = { id: 'r_ent', targetPubkey: 'cd'.repeat(32), targetPostId: enterpriseKey, postId: null, reason: 'Fake shop' };
    const postReport = { id: 'r_post', targetPubkey: 'cd'.repeat(32), targetPostId: 'post_1', postId: 'post_1', reason: 'Spam' };

    it('normalizeNodeData', () => {
        const data = normalizeNodeData({ reports: [enterpriseReport, postReport] } as any);
        expect(data.reports?.[0].postId).toBeNull();
        expect(data.reports?.[1].postId).toBe('post_1');
    });

    it('fetchReports', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ reports: [enterpriseReport, postReport], total: 2, pendingCount: 2 }),
        }));
        const res = await fetchReports('https://node.example', 'open', 50, 0, 'pw');
        expect(res.reports[0].postId).toBeNull();
        expect(res.reports[1].postId).toBe('post_1');
        vi.unstubAllGlobals();
    });

    it('fetchReports serves a moderator: filter and paging in the query, the session cookie sent, the server count kept', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ reports: [{ id: 7, reason: 'x', status: 'actioned' }], total: 1, pendingCount: 4 }),
        });
        vi.stubGlobal('fetch', fetchMock);
        const res = await fetchReports('https://node.example', 'actioned', 200);
        const [url, init] = fetchMock.mock.calls[0];
        const q = new URL(String(url), 'http://x').searchParams;
        expect([q.get('status'), q.get('limit'), q.get('offset')]).toEqual(['actioned', '200', '0']);
        expect(init.credentials).toBe('same-origin');
        expect(res.reports[0]).toMatchObject({ id: '7', outcome: 'actioned' });
        // The Open count is the server's, not the length of the filtered page.
        expect(res.pendingCount).toBe(4);
        vi.unstubAllGlobals();
    });

    it("fetchReports shows the node's own refusal", async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false, status: 403, statusText: 'Forbidden',
            json: async () => ({ error: 'Moderators can review reports and remove reported posts only' }),
        }));
        await expect(fetchReports('https://node.example', 'open')).rejects.toThrow('Moderators can review reports');
        vi.unstubAllGlobals();
    });

    it('dismissNodeReport and removeReportedPulseItem include credentials same-origin for moderator sessions', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ success: true }),
        });
        vi.stubGlobal('fetch', fetchMock);

        await dismissNodeReport('https://node.example', 'rep_123');
        expect(fetchMock.mock.calls[0][1].credentials).toBe('same-origin');

        await removeReportedPulseItem('https://node.example', 'rep_456');
        expect(fetchMock.mock.calls[1][1].credentials).toBe('same-origin');

        vi.unstubAllGlobals();
    });
});

describe('app addresses (Settings → Network)', () => {
    it("sends the host the node is reached at, so the node can say when the directory lists it (4114569450)", async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ addresses: [], unconfirmed: [], oldApps: { today: 0, busiestDay: 0 } }) });
        vi.stubGlobal('fetch', fetchMock);
        await getAppAddresses('https://Community.Example.org:8443', 'pw');
        await confirmAppAddress('https://Community.Example.org:8443', 'bp.example.net', 'pw');
        await removeAppAddress('https://Community.Example.org:8443', 'bp.example.net', 'pw');
        const sent = fetchMock.mock.calls.map(([url]) => {
            const u = new URL(String(url), 'http://x');
            return [u.pathname.replace(/^.*\/api\//, '/api/'), u.searchParams.get('host')];
        });
        expect(sent).toEqual([
            ['/api/local/admin/app-addresses', 'community.example.org'],
            ['/api/local/admin/app-addresses/confirm', 'community.example.org'],
            ['/api/local/admin/app-addresses/remove', 'community.example.org'],
        ]);
        expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ address: 'bp.example.net' });
        vi.unstubAllGlobals();
    });
});
