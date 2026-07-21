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
    const trimmed = (rawUrl || '').trim();
    if (!trimmed) return 'https://localhost:8443';
    if (/^https?:\/\//i.test(trimmed)) {
        return trimmed.replace(/\/+$/, '');
    }
    return `https://${trimmed.replace(/\/+$/, '')}`;
}

export async function fetchDiagnostics(nodeUrl: string, adminPassword?: string): Promise<DiagnosticsResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) {
        headers['X-Admin-Password'] = adminPassword;
    }
    const cleanUrl = normalizeNodeUrl(nodeUrl);
    const url = new URL(`${cleanUrl}/api/local/admin/diagnostics`);
    if (adminPassword) {
        url.searchParams.set('password', adminPassword);
    }
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
    if (adminPassword) {
        url.searchParams.set('password', adminPassword);
    }
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
