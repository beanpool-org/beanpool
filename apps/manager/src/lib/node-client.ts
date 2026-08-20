/**
 * Typed Node Client — Communicates with sovereign node REST and WebSocket APIs
 */

export interface DiagnosticsResponse {
    status: string;
    uptimeSeconds: number;
    cpuLoadPercent: number;
    memoryUsageMb: number;
    totalMemoryMb: number;
    dbSizeBytes: number;
    walSizeBytes: number;
    activeWsConnections: number;
    p2pActivePeers: number;
    userCount?: number;
    communityName: string;
    callsign: string;
}

export interface GatewayConfig {
    corsAllowedOrigins: string[];
    adminIpAllowlist: string[];
    features: {
        marketplace: boolean;
        messaging: boolean;
        federation: boolean;
        invites: boolean;
        servePwa: boolean;
    };
    rateLimiting: {
        enabled: boolean;
        maxRequestsPerMinute: number;
    };
}

export function normalizeNodeUrl(rawUrl: string): string {
    let trimmed = (rawUrl || '').trim();
    if (!trimmed) return 'https://localhost:8443';
    if (!/^https?:\/\//i.test(trimmed)) {
        trimmed = `https://${trimmed}`;
    }
    return trimmed.replace(/\/+$/, '');
}

/**
 * Resolves a target node endpoint URL.
 * When running in the browser against an external node origin, routes requests through
 * the local `/proxy/<scheme>/<host>/<path>` reverse proxy to prevent CORS and mixed-content
 * preflight failures.
 */
export function resolveNodeApiUrl(nodeUrl: string, apiPath: string, searchParams?: Record<string, string>): string {
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const pathWithLeadingSlash = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;

    let targetUrl: string;
    if (typeof window !== 'undefined' && window.location) {
        const currentOrigin = normalizeNodeUrl(window.location.origin);
        if (cleanUrl === currentOrigin) {
            targetUrl = `${cleanUrl}${pathWithLeadingSlash}`;
        } else {
            const match = cleanUrl.match(/^(https?):\/\/([^/]+)/i);
            if (match) {
                const scheme = match[1].toLowerCase();
                const host = match[2];
                const cleanPath = pathWithLeadingSlash.replace(/^\/+/, '');
                targetUrl = `/proxy/${scheme}/${host}/${cleanPath}`;
            } else {
                targetUrl = `${cleanUrl}${pathWithLeadingSlash}`;
            }
        }
    } else {
        targetUrl = `${cleanUrl}${pathWithLeadingSlash}`;
    }

    if (searchParams && Object.keys(searchParams).length > 0) {
        const base = typeof window !== 'undefined' && window.location ? window.location.origin : 'http://localhost';
        const urlObj = new URL(targetUrl, base);
        for (const [k, v] of Object.entries(searchParams)) {
            if (v !== undefined && v !== null) {
                urlObj.searchParams.set(k, v);
            }
        }
        if (targetUrl.startsWith('/')) {
            return urlObj.pathname + urlObj.search;
        }
        return urlObj.toString();
    }

    return targetUrl;
}

// Admin credentials travel in the X-Admin-Password header only, never as a query
// parameter. checkAdminAuth reads the header (https-server.ts) ahead of ?password= in its
// fallback chain, so the header alone is sufficient — and a credential in a URL ends up in
// reverse-proxy access logs, browser history and Referer headers. The node's own logger
// does redact `password=...`, but only at 12+ characters and only for logs it writes
// itself, neither of which helps once the URL has left the browser.
//
// The server still accepts all four transports, so this is a client-side hardening: no
// node needs redeploying for it, and nothing breaks if one is on an older build.

// ======================== 2FA / TOTP HELPERS ========================

/**
 * Authenticate to a node with password + TOTP code via /api/admin/login.
 * Returns the 2FA session token on success, which should be stored and sent
 * as X-Admin-2FA-Session on subsequent requests to skip TOTP re-entry.
 *
 * Also injected into responses from any endpoint that calls checkAdminAuth
 * with a valid TOTP code — so even direct API calls (e.g. fetchDiagnostics
 * with X-Admin-Password + X-Admin-TOTP headers) will return a tfaSessionToken
 * in the response body.
 */
export interface LoginResponse {
    success: boolean;
    tfaSessionToken?: string;
}

export async function loginToNode(
    nodeUrl: string,
    adminPassword: string,
    totpCode: string,
): Promise<LoginResponse> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/admin/login');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: adminPassword, totpCode }),
    });
    const body = await res.json();
    if (!res.ok) {
        throw new Error(body?.error || `HTTP ${res.status}`);
    }
    return body;
}

/**
 * Build headers with admin password and optional 2FA session token for node API calls.
 * Every fetch helper below uses this so TOTP-enabled nodes work transparently.
 */
export function buildAdminHeaders(adminPassword?: string, tfaSessionToken?: string): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) headers['X-Admin-Password'] = adminPassword;
    if (tfaSessionToken) headers['X-Admin-2FA-Session'] = tfaSessionToken;
    return headers;
}

/** Check if a response body indicates TOTP is required. */
export function isTotpRequired(responseBody: any): boolean {
    return responseBody?.totpRequired === true;
}

/**
 * 2FA session token storage — sessionStorage so it lives for the browser
 * session (survives page reloads within the same tab) but is cleared when
 * the tab closes, unlike localStorage which persists to disk indefinitely.
 *
 * This is a security tradeoff: the token is a TOTP bypass, so keeping it
 * off disk limits the XSS exposure window to the current session only.
 */
const TFA_SESSION_KEY_PREFIX = 'bp_tfa_session_';

export function getTfaSessionToken(profileId: string): string | undefined {
    try {
        return sessionStorage.getItem(TFA_SESSION_KEY_PREFIX + profileId) || undefined;
    } catch { return undefined; }
}

export function setTfaSessionToken(profileId: string, token: string | undefined): void {
    try {
        if (token) {
            sessionStorage.setItem(TFA_SESSION_KEY_PREFIX + profileId, token);
        } else {
            sessionStorage.removeItem(TFA_SESSION_KEY_PREFIX + profileId);
        }
    } catch { /* sessionStorage unavailable */ }
}

export function clearAllTfaSessionTokens(): void {
    try {
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
            const key = sessionStorage.key(i);
            if (key?.startsWith(TFA_SESSION_KEY_PREFIX)) {
                sessionStorage.removeItem(key);
            }
        }
    } catch { /* sessionStorage unavailable */ }
}

// ======================== END 2FA HELPERS ========================

/**
 * Download an admin-gated file without putting the credential in a URL.
 *
 * The backup endpoints used to be plain `<a href>` links with `?password=` on them, which
 * is the worst version of this problem: a link's URL persists in the DOM as well as in
 * browser history, and one of these two serves the node's identity keys. A link cannot
 * carry a header, so it has to become a fetch — the response is buffered and handed to the
 * browser through a transient object URL instead.
 *
 * Buffering is acceptable here and not elsewhere: the fleet manager is a local desktop
 * dashboard downloading a community node's SQLite file, and there is no browser-side way
 * to stream to disk that also lets us set a header. The caller is expected to show a
 * pending state, since a file of real size otherwise looks like a dead button.
 */
/** How long the blob stays alive after the click. Long enough for a slow disk write. */
const REVOKE_DELAY_MS = 60_000;

/** Above this, ask before buffering. Set far above any real node database. */
const HUGE_DOWNLOAD_BYTES = 500 * 1024 * 1024;

export async function downloadAdminFile(
    endpointPath: string,
    params: Record<string, string>,
    adminPassword: string | undefined,
    filename: string,
): Promise<void> {
    const headers: Record<string, string> = {};
    if (adminPassword) {
        headers['X-Admin-Password'] = adminPassword;
    }
    const url = new URL(endpointPath, window.location.origin);
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString(), { headers, cache: 'no-store' });
    if (!res.ok) {
        // The endpoints answer 404 with a JSON reason worth surfacing — "no backup yet for
        // this node" is a different problem from "wrong password", and a bare HTTP code
        // would leave the operator guessing which.
        let detail = `HTTP ${res.status}`;
        try {
            const body = await res.json();
            if (body?.error) detail = body.error;
        } catch { /* not JSON — the status is all we have */ }
        throw new Error(detail);
    }

    // Asked before buffering, because afterwards is too late to warn about.
    //
    // The response is read into the tab's heap, which the <a href> this replaced did not
    // do — the browser streamed that straight to disk. There is no way to stream to disk
    // AND set a header, so the buffering stays; what it must not do is silently take the
    // tab out. The largest node database in the fleet today is around 29 MB, so this line
    // is nowhere near normal operation: it exists so that a pathological file asks first
    // rather than crashing on arrival. Deliberately a question and not a refusal — a hard
    // cap would break the only way to get a backup out, and "use direct streaming
    // instead" is not an option that exists here.
    const declaredSize = Number(res.headers.get('content-length') || 0);
    if (declaredSize > HUGE_DOWNLOAD_BYTES) {
        const gb = (declaredSize / 1024 / 1024 / 1024).toFixed(1);
        const proceed = window.confirm(
            `${filename} is about ${gb} GB. It has to be held in memory before it can be saved, `
            + `which may make this tab run out of memory. Download anyway?`
        );
        if (!proceed) return;
    }

    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
    } finally {
        // Revoked in a finally, but NOT on the next tick.
        //
        // Both ends of this are real. Never revoking pins the whole database in memory for
        // the life of the page. Revoking immediately races the download: the click only
        // *starts* the transfer, and pulling the object URL out from under a download
        // manager that is still reading produces a silent failure or a truncated file —
        // Firefox especially, and more likely the larger the file, which is exactly the
        // case that matters here. A delay resolves both: the memory comes back, just not
        // instantly.
        setTimeout(() => URL.revokeObjectURL(objectUrl), REVOKE_DELAY_MS);
    }
}

export async function fetchDiagnostics(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<DiagnosticsResponse> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/diagnostics');
    const res = await fetch(endpoint, {
        headers: buildAdminHeaders(adminPassword, tfaToken),
        cache: 'no-store',
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export interface FunnelRow {
    day: string;
    event: string;
    variant: string;
    count: number;
}

export interface OnboardingFunnelResponse {
    days: number;
    rows: FunnelRow[];
}

/**
 * Onboarding funnel for one node. Its own endpoint rather than part of diagnostics,
 * which is polled on a timer — two of these numbers group over the whole of `posts` and
 * `members`, so they should run when somebody opens the panel, not every few seconds.
 */
export async function fetchOnboardingFunnel(
    nodeUrl: string,
    adminPassword?: string,
    days = 30,
): Promise<OnboardingFunnelResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) {
        headers['X-Admin-Password'] = adminPassword;
    }
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/onboarding-funnel', { days: String(days) });
    const res = await fetch(endpoint, {
        headers,
        cache: 'no-store',
    });
    if (!res.ok) {
        // 401 and 404 need telling apart, because the fix is in a different place for
        // each and the status code alone sent someone hunting the wrong one: 401 is this
        // node's stored admin password, 404 is a node that predates the endpoint.
        if (res.status === 401) {
            throw new Error("Wrong or missing admin password for this node — check it under the node's settings.");
        }
        if (res.status === 404) {
            throw new Error('This node is running a build without the funnel endpoint. Redeploy it.');
        }
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function fetchGatewayConfig(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<GatewayConfig> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/gateway');
    const res = await fetch(endpoint, {
        headers: buildAdminHeaders(adminPassword, tfaToken),
        cache: 'no-store',
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function updateGatewayConfig(
    nodeUrl: string,
    updates: Partial<GatewayConfig>,
    adminPassword?: string,
    tfaToken?: string
): Promise<GatewayConfig> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/gateway');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ ...updates, password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const data = await res.json();
    return data.gateway || data;
}

export async function fetchNodeData(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<any> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/data');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function fetchNodeLogs(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<any[]> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/logs');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ password: adminPassword, limit: 50 }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const data = await res.json();
    return data.logs || [];
}

export async function freezeNodeUser(
    nodeUrl: string,
    pubkey: string,
    freeze: boolean,
    adminPassword?: string
): Promise<{ success: boolean; frozen: boolean }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) {
        headers['X-Admin-Password'] = adminPassword;
    }
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/users/${encodeURIComponent(pubkey)}/freeze`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ freeze, password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function pruneNodeUser(
    nodeUrl: string,
    pubkey: string,
    adminPassword?: string
): Promise<{ success: boolean }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) {
        headers['X-Admin-Password'] = adminPassword;
    }
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/users/${encodeURIComponent(pubkey)}/prune`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function generateNodeInvite(
    nodeUrl: string,
    adminPassword?: string,
    type: 'standard' | 'trusted' | 'ambassador' | 'elder' = 'standard'
): Promise<{ success: boolean; code: string; type: string }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) {
        headers['X-Admin-Password'] = adminPassword;
    }
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/admin/seed-invite');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ password: adminPassword, type }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function updateNodeUserTier(
    nodeUrl: string,
    pubkey: string,
    tier: 'Newcomer' | 'Resident' | 'Steward' | 'Elder',
    adminPassword?: string
): Promise<{ success: boolean; tier: string }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) {
        headers['X-Admin-Password'] = adminPassword;
    }
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/users/${encodeURIComponent(pubkey)}/tier`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tier, password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function updateNodeUserVoucher(
    nodeUrl: string,
    pubkey: string,
    canVouch: boolean,
    adminPassword?: string
): Promise<{ success: boolean; granted: boolean }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) {
        headers['X-Admin-Password'] = adminPassword;
    }
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/users/${encodeURIComponent(pubkey)}/voucher`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ grant: canVouch, password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function updateNodeUserOperator(
    nodeUrl: string,
    pubkey: string,
    granted: boolean,
    adminPassword?: string
): Promise<{ success: boolean }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) {
        headers['X-Admin-Password'] = adminPassword;
    }
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/users/${encodeURIComponent(pubkey)}/operator`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ granted, password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export interface NodeTreasury {
    publicKey: string;
    name: string;
    avatar?: string;
    balance: number;
    creditLine: number;
    liveOffers: number;
}

export async function fetchNodeTreasuries(nodeUrl: string): Promise<NodeTreasury[]> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/treasuries');
    const res = await fetch(endpoint);
    if (!res.ok) return [];
    const data = await res.json();
    return data.treasuries || [];
}

export async function createNodeTreasury(
    nodeUrl: string,
    data: { name: string; avatar: string; creditLine?: number },
    adminPassword?: string
): Promise<{ success: boolean; publicKey: string }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) {
        headers['X-Admin-Password'] = adminPassword;
    }
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/treasury');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...data, password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function seedTreasuryOffer(
    nodeUrl: string,
    treasuryPubkey: string,
    offer: { title: string; category: string; credits: number; description?: string; priceType?: string; repeatable?: boolean },
    adminPassword?: string
): Promise<{ success: boolean; post: any }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) {
        headers['X-Admin-Password'] = adminPassword;
    }
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/treasury/${encodeURIComponent(treasuryPubkey)}/offer`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...offer, password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

// ======================== BACKUP & REPLICATION HELPERS ========================

export interface HarvesterNodeState {
    nodeId: string;
    nodeName: string;
    nodeUrl: string;
    lastHarvestAt: string | null;
    lastSuccessAt: string | null;
    status: 'idle' | 'harvesting' | 'ok' | 'error';
    error: string | null;
    dbSizeBytes: number;
    memberCount: number;
    postCount: number;
    identityStatus: 'secured' | 'partial' | 'missing';
    identityFiles: string[];
    historyCount: number;
}

export interface HarvesterStatusResponse {
    nodes: Array<{ id: string; name: string; url: string }>;
    harvestState: Record<string, HarvesterNodeState>;
}

export async function fetchHarvesterStatus(): Promise<HarvesterStatusResponse> {
    const res = await fetch('/api/manager/backups/status');
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function triggerHarvesterSync(nodeId: string, url?: string, adminPassword?: string): Promise<any> {
    const res = await fetch('/api/manager/backups/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId, url, adminPassword, password: adminPassword }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${res.statusText} ${text ? `— ${text}` : ''}`);
    }
    return res.json();
}

export interface HistoryFileItem {
    filename: string;
    date: string;
    sizeBytes: number;
    modifiedAt: string;
}

export async function fetchNodeHistory(nodeId: string): Promise<HistoryFileItem[]> {
    const res = await fetch(`/api/manager/backups/history?nodeId=${encodeURIComponent(nodeId)}`);
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const data = await res.json();
    return data.history || [];
}

export interface SnapshotItem {
    name: string;
    sizeBytes: number;
    createdAt: string;
}

export async function fetchNodeSnapshots(nodeUrl: string, adminPassword?: string): Promise<SnapshotItem[]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) headers['X-Admin-Password'] = adminPassword;
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/snapshots/list');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ password: adminPassword }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.snapshots || [];
}

export async function createNodeSnapshot(nodeUrl: string, adminPassword?: string): Promise<SnapshotItem> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) headers['X-Admin-Password'] = adminPassword;
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/snapshots/create');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const data = await res.json();
    return data.snapshot;
}

export async function deleteNodeSnapshot(nodeUrl: string, name: string, adminPassword?: string): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) headers['X-Admin-Password'] = adminPassword;
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/snapshots/delete');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name, password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
}

export async function updateNodeReplicationCadence(
    nodeUrl: string,
    pullSeconds: number,
    reconcileMinutes: number,
    adminPassword?: string
): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) headers['X-Admin-Password'] = adminPassword;
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/backup-config');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ pullSeconds, reconcileMinutes, password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
}

export async function forceNodeResync(nodeUrl: string, adminPassword?: string): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) headers['X-Admin-Password'] = adminPassword;
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/replication-resync');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
}

// ======================== REGISTRAR HELPERS ========================

export interface RegistrarAllocation {
    name: string;
    node_pubkey: string;
    hostname: string;
    mode: 'tunnel' | 'direct' | string;
    status: 'pending' | 'live' | 'revoked' | string;
    community_name?: string | null;
    tunnel_id?: string | null;
    dns_record_id?: string | null;
    origin?: string | null;
    public_ip?: string | null;
    contact?: string | null;
    attest_fails?: number;
    last_attest_at?: number | null;
    requested_at: number;
    decided_at?: number | null;
    decided_by?: string | null;
    tier?: 'auto' | 'gated' | 'blocked' | string;
}

export interface RegistrarPendingResponse {
    allocations: RegistrarAllocation[];
}

export async function getRegistrarPending(
    nodeUrl?: string,
    adminPassword?: string
): Promise<RegistrarAllocation[]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) {
        headers['X-Admin-Password'] = adminPassword;
        headers['x-admin-secret'] = adminPassword;
    }
    const endpoint = nodeUrl
        ? resolveNodeApiUrl(nodeUrl, '/api/local/admin/registrar/pending')
        : '/api/local/admin/registrar/pending';
    const res = await fetch(endpoint, {
        headers,
        cache: 'no-store',
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const data = await res.json();
    return data.allocations || [];
}

export const getRegistralPending = getRegistrarPending;

export async function approveRegistrarClaim(
    nodeUrlOrName: string,
    nameOrPassword?: string,
    adminPassword?: string
): Promise<{ status: string; name: string }> {
    let nodeUrl = nodeUrlOrName;
    let name = nameOrPassword;
    let pwd = adminPassword;

    if (!name) {
        name = nodeUrlOrName;
        nodeUrl = '';
        pwd = undefined;
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (pwd) {
        headers['X-Admin-Password'] = pwd;
        headers['x-admin-secret'] = pwd;
    }
    const endpoint = nodeUrl
        ? resolveNodeApiUrl(nodeUrl, `/api/local/admin/registrar/${encodeURIComponent(name)}/approve`)
        : `/api/local/admin/registrar/${encodeURIComponent(name)}/approve`;

    const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ password: pwd }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function revokeRegistrarClaim(
    nodeUrlOrName: string,
    nameOrPassword?: string,
    adminPassword?: string
): Promise<{ status: string; name: string }> {
    let nodeUrl = nodeUrlOrName;
    let name = nameOrPassword;
    let pwd = adminPassword;

    if (!name) {
        name = nodeUrlOrName;
        nodeUrl = '';
        pwd = undefined;
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (pwd) {
        headers['X-Admin-Password'] = pwd;
        headers['x-admin-secret'] = pwd;
    }
    const endpoint = nodeUrl
        ? resolveNodeApiUrl(nodeUrl, `/api/local/admin/registrar/${encodeURIComponent(name)}/revoke`)
        : `/api/local/admin/registrar/${encodeURIComponent(name)}/revoke`;

    const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ password: pwd }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

