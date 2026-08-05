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

// Admin credentials travel in the X-Admin-Password header only, never as a query
// parameter. checkAdminAuth reads the header (https-server.ts) ahead of ?password= in its
// fallback chain, so the header alone is sufficient — and a credential in a URL ends up in
// reverse-proxy access logs, browser history and Referer headers. The node's own logger
// does redact `password=...`, but only at 12+ characters and only for logs it writes
// itself, neither of which helps once the URL has left the browser.
//
// The server still accepts all four transports, so this is a client-side hardening: no
// node needs redeploying for it, and nothing breaks if one is on an older build.
//
// STILL OUTSTANDING, and worse than these were: the two backup download links in
// TopologyModule.tsx put the password in an <a href>, where it persists in the DOM as well
// as in history. A plain link cannot carry a header, so fixing those needs either a
// fetch-to-blob download (awkward for a database file of real size) or a short-lived
// one-time download token issued by the node. That is server work, not a find-and-replace.

export async function fetchDiagnostics(nodeUrl: string, adminPassword?: string): Promise<DiagnosticsResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) {
        headers['X-Admin-Password'] = adminPassword;
    }
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const url = new URL(`${cleanUrl}/api/local/admin/diagnostics`);
    const res = await fetch(url.toString(), {
        headers,
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
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const url = new URL(`${cleanUrl}/api/local/admin/onboarding-funnel`);
    url.searchParams.set('days', String(days));
    const res = await fetch(url.toString(), {
        headers,
        cache: 'no-store',
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function fetchGatewayConfig(nodeUrl: string, adminPassword?: string): Promise<GatewayConfig> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) {
        headers['X-Admin-Password'] = adminPassword;
    }
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const url = new URL(`${cleanUrl}/api/local/admin/gateway`);
    const res = await fetch(url.toString(), {
        headers,
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
    adminPassword?: string
): Promise<GatewayConfig> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) {
        headers['X-Admin-Password'] = adminPassword;
    }
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const res = await fetch(`${cleanUrl}/api/local/admin/gateway`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...updates, password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const data = await res.json();
    return data.gateway || data;
}

export async function fetchNodeData(nodeUrl: string, adminPassword?: string): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) {
        headers['X-Admin-Password'] = adminPassword;
    }
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const res = await fetch(`${cleanUrl}/api/local/admin/data`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function fetchNodeLogs(nodeUrl: string, adminPassword?: string): Promise<any[]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) {
        headers['X-Admin-Password'] = adminPassword;
    }
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const res = await fetch(`${cleanUrl}/api/local/admin/logs`, {
        method: 'POST',
        headers,
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
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const res = await fetch(`${cleanUrl}/api/local/admin/users/${encodeURIComponent(pubkey)}/freeze`, {
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
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const res = await fetch(`${cleanUrl}/api/local/admin/users/${encodeURIComponent(pubkey)}/prune`, {
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
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const res = await fetch(`${cleanUrl}/api/admin/seed-invite`, {
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
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const res = await fetch(`${cleanUrl}/api/local/admin/users/${encodeURIComponent(pubkey)}/tier`, {
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
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const res = await fetch(`${cleanUrl}/api/local/admin/users/${encodeURIComponent(pubkey)}/voucher`, {
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
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const res = await fetch(`${cleanUrl}/api/local/admin/users/${encodeURIComponent(pubkey)}/operator`, {
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
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const res = await fetch(`${cleanUrl}/api/treasuries`);
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
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const res = await fetch(`${cleanUrl}/api/local/admin/treasury`, {
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
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const res = await fetch(`${cleanUrl}/api/local/admin/treasury/${encodeURIComponent(treasuryPubkey)}/offer`, {
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
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const res = await fetch(`${cleanUrl}/api/local/admin/snapshots/list`, {
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
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const res = await fetch(`${cleanUrl}/api/local/admin/snapshots/create`, {
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
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const res = await fetch(`${cleanUrl}/api/local/admin/snapshots/delete`, {
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
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const res = await fetch(`${cleanUrl}/api/local/admin/backup-config`, {
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
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const res = await fetch(`${cleanUrl}/api/local/admin/replication-resync`, {
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
    const cleanUrl = nodeUrl ? normalizeNodeUrl(nodeUrl) : '';
    const endpoint = cleanUrl ? `${cleanUrl}/api/local/admin/registrar/pending` : '/api/local/admin/registrar/pending';
    const url = new URL(endpoint, typeof window !== 'undefined' && window.location ? window.location.origin : 'http://localhost');
    const res = await fetch(url.toString(), {
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
    const cleanUrl = nodeUrl ? normalizeNodeUrl(nodeUrl) : '';
    const endpoint = cleanUrl
        ? `${cleanUrl}/api/local/admin/registrar/${encodeURIComponent(name)}/approve`
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
    const cleanUrl = nodeUrl ? normalizeNodeUrl(nodeUrl) : '';
    const endpoint = cleanUrl
        ? `${cleanUrl}/api/local/admin/registrar/${encodeURIComponent(name)}/revoke`
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






