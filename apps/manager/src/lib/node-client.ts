/**
 * Typed Node Client — Communicates with sovereign node REST and WebSocket APIs
 */

import { downloadNotice, type DownloadNotice } from './backup-shortfall';

export interface ShutdownStatus {
    uncleanShutdown: boolean;
    recovered?: boolean;
    ok?: boolean;
    powerLossAt?: string;
    powerLossTimestamp?: string;
    message?: string;
    error?: string;
    checkedAt?: string;
    acknowledged?: boolean;
}

export interface DiskBreakdownItem {
    dbSizeBytes: number;
    walSizeBytes: number;
    shmSizeBytes?: number;
    snapshotsSizeBytes?: number;
    totalBytes: number;
}

export interface MediaBreakdownItem {
    postPhotosBytes: number;
    postPhotosCount: number;
    pulseThumbnailsBytes: number;
    pulseThumbnailsCount: number;
    totalBytes: number;
}

export interface LogsBreakdownItem {
    systemLogsBytes: number;
    systemLogsCount: number;
    logFilesBytes?: number;
    totalBytes: number;
}

export interface DiskHealth {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number;
    warning: boolean; // true if usedPercent >= 80
    databaseBytes: number;
    mediaBytes: number;
    logsBytes: number;
    breakdown: {
        database: DiskBreakdownItem;
        media: MediaBreakdownItem;
        logs: LogsBreakdownItem;
    };
}

export interface StorageCleanPreview {
    orphanedPostPhotos: {
        count: number;
        totalBytes: number;
    };
    /** Objects in the node's image store (its disk, or its bucket) that no row points at. Absent from older nodes. */
    orphanedImageObjects?: {
        count: number;
        totalBytes: number;
    };
    orphanedThumbnails: {
        count: number;
        totalBytes: number;
    };
    compressibleLogs: {
        count: number;
        totalBytes: number;
        oldestTimestamp?: string;
        newestTimestamp?: string;
    };
    totalReclaimableBytes: number;
}

export interface StorageCleanResult {
    success: boolean;
    removedPhotosCount: number;
    removedPhotosBytes: number;
    /** Absent from older nodes. */
    removedImageObjectsCount?: number;
    removedImageObjectsBytes?: number;
    /**
     * Orphaned image-store objects the Clean found and did not get to: it answers within a few seconds rather
     * than wait on thousands of them, and the node keeps removing the rest in the background. Absent from older
     * nodes; above zero means "more remain", not "done".
     */
    remainingImageObjectsCount?: number;
    remainingImageObjectsBytes?: number;
    removedThumbnailsCount: number;
    removedThumbnailsBytes: number;
    compressedLogsCount: number;
    compressedLogsBytes: number;
    totalReclaimedBytes: number;
}

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
    shutdownStatus?: ShutdownStatus;
    diskHealth?: DiskHealth;
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

export interface NodeHealthFlag {
    id?: string;
    type?: string;
    description?: string;
    severity?: 'critical' | 'alert' | 'warning' | 'info' | string;
    [key: string]: unknown;
}

export interface NodeReport {
    id?: string;
    targetPubkey?: string;
    target_pubkey?: string;
    reporterPubkey?: string;
    reporter_pubkey?: string;
    reason?: string;
    severity?: string;
    status?: string;
    outcome?: 'open' | 'dismissed' | 'actioned' | string;
    reporterCallsign?: string;
    targetCallsign?: string;
    postId?: string | null;
    postTitle?: string | null;
    title?: string | null;
    postAuthorCallsign?: string | null;
    postRemoved?: boolean | null;
    targetPulseItemId?: string;
    /** Set when the report targets a Pulse item; `removed` once it is off the feed. */
    pulseItem?: { title: string | null; platform: string; url: string | null; removed: boolean } | null;
    [key: string]: unknown;
}

export type MemberNodeRole = 'owner' | 'admin' | 'moderator';

export interface MemberItem {
    publicKey?: string;
    pubkey?: string;
    name?: string;
    callsign?: string;
    tier?: string;
    standing?: string;
    canVouch?: boolean;
    canOperate?: boolean;
    creditFrozen?: boolean;
    isFrozen?: boolean;
    nodeRole?: MemberNodeRole | null;
    isTreasury?: boolean;
    [key: string]: unknown;
}

export interface NodeDataPayload {
    health?: {
        healthScore?: number;
        flags?: NodeHealthFlag[];
        [key: string]: unknown;
    };
    reports?: NodeReport[];
    members?: MemberItem[];
    profiles?: Record<string, unknown>[];
    posts?: unknown[];
    reportCount?: number;
    escrowDisputesCount?: number;
    memberStats?: Record<string, unknown>;
    tradeVolume?: number;
    circulation?: number;
    commonsBalance?: number;
    enterprises?: unknown[];
    [key: string]: unknown;
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
 * CSRF token for a key sign-in (lib/key-session.ts). The key session rides in an httpOnly cookie that the
 * browser attaches by itself, so the node refuses cookie-authenticated changes without this header. Held in
 * memory only; a reload fetches a new one. Null under password sign-in, which sends no header at all.
 */
let keySessionCsrfToken: string | null = null;

export function setKeySessionCsrfToken(token: string | null): void {
    keySessionCsrfToken = token;
}

/**
 * Build headers with admin password and optional 2FA session token for node API calls.
 * Every fetch helper below uses this so TOTP-enabled nodes work transparently.
 */
export function buildAdminHeaders(adminPassword?: string, tfaSessionToken?: string): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminPassword) headers['X-Admin-Password'] = adminPassword;
    if (tfaSessionToken) headers['X-Admin-2FA-Session'] = tfaSessionToken;
    if (keySessionCsrfToken) headers['X-CSRF-Token'] = keySessionCsrfToken;
    return headers;
}

/** Check if a response body indicates TOTP is required. */
export function isTotpRequired(responseBody: unknown): boolean {
    return typeof responseBody === 'object' && responseBody !== null && (responseBody as Record<string, unknown>).totpRequired === true;
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

/**
 * The filename from `Content-Disposition`, when the response carries a usable one. Never a path: the value
 * comes from the node, and a `../` in it would be a download written outside the browser's download folder.
 */
function serverFilename(res: Response): string | null {
    const header = res.headers.get('content-disposition');
    if (!header) return null;
    const match = /filename="?([^";]+)"?/i.exec(header);
    const name = match?.[1]?.trim();
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
    return name;
}

/**
 * Fetch an admin file and save it, and return what the response said about it ({@link downloadNotice}).
 *
 * A short backup is a 200 now (confirmation round 4): the node ships every object it holds and says in the
 * headers how many it could not. That sentence is the only place the operator can learn of it, so this hands
 * it back rather than dropping it — with `short` saying whether anything is actually missing, because an s3
 * node's whole backup has a sentence too (its photos are in the bucket). Empty text when there is nothing to
 * say, or when the download was declined.
 */
export async function downloadAdminFile(
    endpointPath: string,
    params: Record<string, string>,
    adminPassword: string | undefined,
    filename: string,
    tfaToken?: string,
): Promise<DownloadNotice> {
    const headers = buildAdminHeaders(adminPassword, tfaToken);
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
        if (!proceed) return { text: '', short: false };
    }

    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
        const a = document.createElement('a');
        a.href = objectUrl;
        // The server's name wins where it gives one: a snapshot download asks for `snapshot-….db` and comes
        // back as a `.tar.gz` (the database AND its images) or a `.bpsealed`, and saving that under the `.db`
        // name hands the operator a file whose extension lies about what is inside it.
        a.download = serverFilename(res) || filename;
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
    return downloadNotice(res);
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

export async function acknowledgeShutdownStatus(
    nodeUrl: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean; shutdownStatus: ShutdownStatus }> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/shutdown-status/acknowledge');
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

export async function fetchDiskHealth(
    nodeUrl: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean; diskHealth: DiskHealth }> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/storage/disk-health');
    const res = await fetch(endpoint, {
        headers: buildAdminHeaders(adminPassword, tfaToken),
        cache: 'no-store',
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function fetchStorageCleanPreview(
    nodeUrl: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean; preview: StorageCleanPreview }> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/storage/clean-preview');
    const res = await fetch(endpoint, {
        headers: buildAdminHeaders(adminPassword, tfaToken),
        cache: 'no-store',
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function cleanStorageAndCompressLogs(
    nodeUrl: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<StorageCleanResult> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/storage/clean');
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
    tfaToken?: string,
): Promise<OnboardingFunnelResponse> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/onboarding-funnel', { days: String(days) });
    const res = await fetch(endpoint, {
        headers: buildAdminHeaders(adminPassword, tfaToken),
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

export function normalizeKeeperPubkey(keeper: unknown): string {
    if (typeof keeper === 'string') return keeper.trim();
    if (typeof keeper === 'object' && keeper !== null) {
        const obj = keeper as Record<string, unknown>;
        const candidate = [
            obj.publicKey,
            obj.pubkey,
            obj.public_key,
            obj.member_pubkey,
            obj.memberPubkey,
        ].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
        if (candidate) return candidate.trim();
    }
    return '';
}

export function normalizeKeepers(rawKeepers: unknown): string[] {
    if (!Array.isArray(rawKeepers)) return [];
    return rawKeepers.map(normalizeKeeperPubkey).filter(Boolean);
}

export function normalizeNodeData(raw: unknown): NodeDataPayload {
    if (!raw || typeof raw !== 'object') {
        return {};
    }
    const data = raw as Record<string, unknown>;
    const result: NodeDataPayload = { ...data };

    if (data.members !== undefined) {
        result.members = Array.isArray(data.members)
            ? data.members.map((m: any) => {
                if (!m || typeof m !== 'object') return { publicKey: '', standing: 'Newcomer' };
                const pubkey = normalizeKeeperPubkey(m);
                const rawName = typeof m.name === 'string'
                    ? m.name
                    : (typeof m.displayName === 'string'
                        ? m.displayName
                        : (typeof m.callsign === 'string' ? m.callsign : undefined));
                const rawCallsign = typeof m.callsign === 'string'
                    ? m.callsign
                    : (typeof m.displayName === 'string'
                        ? m.displayName
                        : (typeof m.name === 'string' ? m.name : undefined));
                return {
                    ...m,
                    publicKey: pubkey,
                    pubkey: pubkey,
                    name: rawName,
                    callsign: rawCallsign,
                    tier: typeof m.tier === 'string' ? m.tier : (typeof m.standing === 'string' ? m.standing : 'Newcomer'),
                    standing: typeof m.standing === 'string' ? m.standing : (typeof m.tier === 'string' ? m.tier : 'Newcomer'),
                    canVouch: Boolean(m.canVouch ?? m.isVoucher),
                    canOperate: Boolean(m.canOperate ?? m.isOperator ?? m.can_operate),
                    nodeRole: (m.nodeRole === 'owner' || m.nodeRole === 'admin' || m.nodeRole === 'moderator') ? m.nodeRole : null,
                };
            })
            : [];
    }

    if (data.reports !== undefined) {
        const rawReports = Array.isArray(data.reports) ? data.reports : [];
        result.reports = rawReports.map((r: any) => {
            if (!r || typeof r !== 'object') return { id: '', targetPubkey: '', target_pubkey: '' };
            const targetPubkey = normalizeKeeperPubkey(r.targetPubkey) || normalizeKeeperPubkey(r.target_pubkey);
            const reporterPubkey = normalizeKeeperPubkey(r.reporterPubkey) || normalizeKeeperPubkey(r.reporter_pubkey);
            return {
                ...r,
                id: r.id !== undefined && r.id !== null ? String(r.id) : undefined,
                targetPubkey,
                target_pubkey: targetPubkey,
                reporterPubkey,
                reporter_pubkey: reporterPubkey,
                reason: typeof r.reason === 'string' ? r.reason : (typeof r.description === 'string' ? r.description : ''),
                severity: typeof r.severity === 'string' ? r.severity : 'Report',
                status: typeof r.status === 'string' ? r.status : 'pending',
                outcome: typeof r.outcome === 'string' ? r.outcome : (r.status === 'reviewed' ? 'dismissed' : r.status === 'actioned' ? 'actioned' : 'open'),
                title: r.title ?? r.postTitle ?? null,
                postTitle: r.postTitle ?? r.title ?? null,
                postId: typeof r.postId === 'string' ? r.postId : null,
                postAuthorCallsign: r.postAuthorCallsign ?? null,
                postRemoved: typeof r.postRemoved === 'boolean' ? r.postRemoved : null,
            };
        });
        if (typeof data.reportCount !== 'number') {
            result.reportCount = result.reports.filter((r) => r.outcome === 'open').length;
        } else {
            result.reportCount = data.reportCount;
        }
    }

    if (data.profiles !== undefined) {
        result.profiles = Array.isArray(data.profiles)
            ? data.profiles.map((p: any) => {
                if (!p || typeof p !== 'object') return { publicKey: '' };
                const pub = typeof p.publicKey === 'string' ? p.publicKey : (typeof p.pubkey === 'string' ? p.pubkey : '');
                return {
                    ...p,
                    publicKey: pub,
                    pubkey: pub,
                };
            })
            : [];
    }

    if (data.posts !== undefined) {
        result.posts = Array.isArray(data.posts) ? data.posts : [];
    }

    if (data.health !== undefined) {
        const rawHealth = (data.health && typeof data.health === 'object') ? (data.health as Record<string, unknown>) : {};
        const flags: NodeHealthFlag[] = Array.isArray(rawHealth.flags)
            ? rawHealth.flags.map((f: any) => (f && typeof f === 'object' ? f : { description: String(f || '') }))
            : [];
        const healthScore = typeof rawHealth.healthScore === 'number' ? rawHealth.healthScore : 100;
        result.health = {
            ...rawHealth,
            flags,
            healthScore,
        };
    }

    if (typeof data.escrowDisputesCount === 'number') {
        result.escrowDisputesCount = data.escrowDisputesCount;
    }

    return result;
}

export async function fetchNodeData(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<NodeDataPayload> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/data');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const json = await res.json();
    return normalizeNodeData(json);
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
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean; frozen: boolean }> {
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/users/${encodeURIComponent(pubkey)}/freeze`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
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
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean }> {
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/users/${encodeURIComponent(pubkey)}/prune`);
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

export async function pruneInviteBranch(
    nodeUrl: string,
    pubkey: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean; error?: string }> {
    if (!pubkey || typeof pubkey !== 'string' || !pubkey.trim()) {
        throw new Error('Valid public key is required to prune an invite branch');
    }
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/branches/${encodeURIComponent(pubkey.trim())}/prune`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ password: adminPassword }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function deleteNodePost(
    nodeUrl: string,
    postId: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean; error?: string }> {
    if (!postId || typeof postId !== 'string' || !postId.trim()) {
        throw new Error('Valid post ID is required to delete a post');
    }
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/posts/${encodeURIComponent(postId.trim())}/delete`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ password: adminPassword }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}


/**
 * Actions a Pulse-item report by taking the item off the Pulse. The owner is not suspended.
 */
export async function removeReportedPulseItem(
    nodeUrl: string,
    reportId: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean; error?: string }> {
    if (!reportId || typeof reportId !== 'string' || !reportId.trim()) {
        throw new Error('Valid report ID is required to remove a Pulse item');
    }
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/reports/${encodeURIComponent(reportId.trim())}/action`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        credentials: 'same-origin',
        body: JSON.stringify({ removePulseItem: true, password: adminPassword }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

/**
 * Marks an abuse report reviewed on the node, so it leaves the pending queue for every operator
 * and replica rather than only this browser's view.
 */
export async function dismissNodeReport(
    nodeUrl: string,
    reportId: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean; error?: string }> {
    if (!reportId || typeof reportId !== 'string' || !reportId.trim()) {
        throw new Error('Valid report ID is required to dismiss a report');
    }
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/reports/${encodeURIComponent(reportId.trim())}/dismiss`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        credentials: 'same-origin',
        body: JSON.stringify({ password: adminPassword }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

/** The reasons a post can be removed for, as the author reads them (server: engine/moderation-notices.ts). */
export const REMOVAL_REASONS: { id: string; label: string }[] = [
    { id: 'spam', label: 'Spam or a scam' },
    { id: 'offensive', label: 'Offensive content' },
    { id: 'misleading', label: 'Misleading' },
    { id: 'unsafe', label: 'Unsafe or illegal' },
    { id: 'rules', label: "Against this community's rules" },
];

export type ReportStatusFilter = 'open' | 'actioned' | 'dismissed' | 'all';

/** One report as fetchReports returns it: a NodeReport with the fields a triage list needs made definite. */
export interface ListedReport extends NodeReport {
    id: string;
    reason: string;
    outcome: 'open' | 'dismissed' | 'actioned';
    createdAt?: string;
    postDescription?: string | null;
}

export interface ReportsResponse {
    success?: boolean;
    reports: ListedReport[];
    total: number;
    /** Reports still open, whatever the filter (the server counts them; the owners' and moderators' tabs both show it). */
    pendingCount: number;
    limit: number;
    offset: number;
}

const REPORT_OUTCOMES = new Set(['open', 'dismissed', 'actioned']);

/**
 * The reports list, filtered and paged, for both the owners' People & Safety tab and a moderator's Reports screen.
 * A moderator's session is a cookie, so the request carries it (credentials: same-origin).
 */
export async function fetchReports(
    nodeUrl: string,
    status: ReportStatusFilter = 'open',
    limit = 50,
    offset = 0,
    adminPassword?: string,
    tfaToken?: string
): Promise<ReportsResponse> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/reports', {
        status,
        limit: String(limit),
        offset: String(offset),
    });
    const res = await fetch(endpoint, {
        headers: buildAdminHeaders(adminPassword, tfaToken),
        credentials: 'same-origin',
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(json?.error || `HTTP ${res.status}: ${res.statusText}`);
    }
    const reports: ListedReport[] = Array.isArray(json.reports) ? json.reports.map((r: any): ListedReport => {
        if (!r || typeof r !== 'object') return { id: '', reason: '', outcome: 'open' };
        const targetPubkey = normalizeKeeperPubkey(r.targetPubkey) || normalizeKeeperPubkey(r.target_pubkey);
        const reporterPubkey = normalizeKeeperPubkey(r.reporterPubkey) || normalizeKeeperPubkey(r.reporter_pubkey);
        const outcome = REPORT_OUTCOMES.has(r.outcome)
            ? r.outcome
            : (r.status === 'reviewed' ? 'dismissed' : r.status === 'actioned' ? 'actioned' : 'open');
        return {
            ...r,
            id: r.id !== undefined && r.id !== null ? String(r.id) : '',
            targetPubkey,
            target_pubkey: targetPubkey,
            reporterPubkey,
            reporter_pubkey: reporterPubkey,
            reason: typeof r.reason === 'string' ? r.reason : (typeof r.description === 'string' ? r.description : ''),
            severity: typeof r.severity === 'string' ? r.severity : 'Report',
            status: typeof r.status === 'string' ? r.status : 'pending',
            outcome,
            title: r.title ?? r.postTitle ?? null,
            postTitle: r.postTitle ?? r.title ?? null,
            postId: typeof r.postId === 'string' ? r.postId : null,
            postAuthorCallsign: r.postAuthorCallsign ?? null,
            postRemoved: typeof r.postRemoved === 'boolean' ? r.postRemoved : null,
        };
    }) : [];
    return {
        success: json.success ?? true,
        reports,
        total: typeof json.total === 'number' ? json.total : reports.length,
        pendingCount: typeof json.pendingCount === 'number' ? json.pendingCount : reports.filter((r) => r.outcome === 'open').length,
        limit: typeof json.limit === 'number' ? json.limit : limit,
        offset: typeof json.offset === 'number' ? json.offset : offset,
    };
}

/**
 * Acts on a report: takes the reported post down (the author is told, with the reason), takes a reported Pulse
 * item off the feed, or neither (marks it handled). Never suspends anyone: that stays in People & Safety.
 */
export async function actionNodeReport(
    nodeUrl: string,
    reportId: string,
    action: { deletePost?: boolean; removePulseItem?: boolean; reasonCategory?: string },
    adminPassword?: string,
    tfaToken?: string,
): Promise<{ success: boolean; error?: string }> {
    if (!reportId || typeof reportId !== 'string' || !reportId.trim()) {
        throw new Error('Valid report ID is required');
    }
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/reports/${encodeURIComponent(reportId.trim())}/action`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        credentials: 'same-origin',
        body: JSON.stringify({
            deletePost: !!action.deletePost,
            removePulseItem: !!action.removePulseItem,
            ...(action.reasonCategory ? { reasonCategory: action.reasonCategory } : {}),
            ...(adminPassword ? { password: adminPassword } : {}),
        }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}: ${res.statusText}`);
    return data;
}

export async function generateNodeInvite(
    nodeUrl: string,
    adminPassword?: string,
    type: 'standard' | 'trusted' | 'ambassador' | 'elder' = 'standard',
    tfaToken?: string
): Promise<{ success: boolean; code: string; type: string }> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/admin/seed-invite');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ password: adminPassword, type }),
    });
    if (!res.ok) {
        // The node's own words (e.g. 'Invalid password', 'Only an owner or admin of this node can issue invites').
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}: ${res.statusText}`);
    }
    const data = await res.json();
    // A 200 without a code is not an invite. Never hand the caller something to print.
    if (!data || typeof data.code !== 'string' || !data.code.trim()) {
        throw new Error('The node answered but sent no invite code');
    }
    return data;
}

export async function updateNodeUserTier(
    nodeUrl: string,
    pubkey: string,
    tier: 'Newcomer' | 'Resident' | 'Steward' | 'Elder',
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean; tier: string }> {
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/users/${encodeURIComponent(pubkey)}/tier`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
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
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean; granted: boolean }> {
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/users/${encodeURIComponent(pubkey)}/voucher`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
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
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean }> {
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/users/${encodeURIComponent(pubkey)}/operator`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ granted, password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export interface NodeRoleRecord {
    member_pubkey: string;
    role: 'owner' | 'admin' | 'moderator';
    granted_at: string;
    granted_by: string | null;
    callsign?: string;
}

export async function fetchNodeRoles(
    nodeUrl: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<NodeRoleRecord[]> {
    const url = resolveNodeApiUrl(nodeUrl, '/api/local/admin/node-roles');
    const res = await fetch(url, {
        headers: buildAdminHeaders(adminPassword, tfaToken),
    });
    if (!res.ok) {
        // Pass the node's own words through (e.g. break-glass mode, an expired key session).
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `Failed to fetch node roles (HTTP ${res.status})`);
    }
    const data = await res.json();
    return data.roles || [];
}

export async function grantNodeRoleApi(
    nodeUrl: string,
    pubkey: string,
    role: 'owner' | 'admin' | 'moderator',
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean; message?: string }> {
    const url = resolveNodeApiUrl(nodeUrl, '/api/local/admin/node-roles');
    const res = await fetch(url, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ pubkey, role }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || 'Failed to grant node role');
    }
    return data;
}

export async function revokeNodeRoleApi(
    nodeUrl: string,
    pubkey: string,
    role: 'owner' | 'admin' | 'moderator',
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean; message?: string }> {
    const url = resolveNodeApiUrl(nodeUrl, `/api/local/admin/node-roles/${encodeURIComponent(pubkey)}/${encodeURIComponent(role)}`);
    const res = await fetch(url, {
        method: 'DELETE',
        headers: buildAdminHeaders(adminPassword, tfaToken),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || 'Failed to revoke node role');
    }
    return data;
}

export async function fetchTreasuryKeepers(
    nodeUrl: string,
    treasuryPubkey: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<any[]> {
    const url = resolveNodeApiUrl(nodeUrl, `/api/local/admin/treasury/${encodeURIComponent(treasuryPubkey)}/operators`);
    const res = await fetch(url, {
        headers: buildAdminHeaders(adminPassword, tfaToken),
    });
    if (!res.ok) {
        throw new Error('Failed to fetch keepers');
    }
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data.keepers) ? data.keepers : [];
}

export async function assignTreasuryKeeper(
    nodeUrl: string,
    treasuryPubkey: string,
    memberPubkey: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<any[]> {
    const url = resolveNodeApiUrl(nodeUrl, `/api/local/admin/treasury/${encodeURIComponent(treasuryPubkey)}/operators`);
    const res = await fetch(url, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ pubkey: memberPubkey }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || 'Failed to assign keeper');
    }
    return Array.isArray(data.keepers) ? data.keepers : [];
}

export async function revokeTreasuryKeeper(
    nodeUrl: string,
    treasuryPubkey: string,
    memberPubkey: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<any[]> {
    const url = resolveNodeApiUrl(nodeUrl, `/api/local/admin/treasury/${encodeURIComponent(treasuryPubkey)}/operators/${encodeURIComponent(memberPubkey)}`);
    const res = await fetch(url, {
        method: 'DELETE',
        headers: buildAdminHeaders(adminPassword, tfaToken),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || 'Failed to revoke keeper');
    }
    return Array.isArray(data.keepers) ? data.keepers : [];
}

export interface NodeTreasury {
    publicKey: string;
    name: string;
    avatar?: string;
    avatarUrl?: string;
    balance: number;
    creditLine: number;
    liveOffers: number;
    workingCapitalCeiling?: number | null;
    purpose?: string | null;
    keepers?: any[];
    lat?: number | null;
    lng?: number | null;
    locationAuthSigner?: string | null;
    locationUpdatedAt?: string | null;
}

export async function fetchNodeTreasuries(nodeUrl: string): Promise<NodeTreasury[]> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/treasuries');
    const res = await fetch(endpoint);
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    const rawList = Array.isArray(data.treasuries) ? data.treasuries : (Array.isArray(data) ? data : []);
    return rawList.map((t: any) => {
        if (!t || typeof t !== 'object') return t;
        const normalized: any = { ...t };
        if ('keepers' in t && t.keepers !== undefined) {
            normalized.keepers = Array.isArray(t.keepers) ? t.keepers : normalizeKeepers(t.keepers);
        }
        return normalized;
    });
}

export async function createNodeTreasury(
    nodeUrl: string,
    data: { name: string; avatar: string; creditLine?: number; workingCapitalCeiling?: number | null; purpose?: string; lat?: number | null; lng?: number | null },
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean; publicKey: string }> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/treasury');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ ...data, password: adminPassword }),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function updateEnterpriseLocation(
    nodeUrl: string,
    treasuryPubkey: string,
    location: { lat: number | null; lng: number | null } | null,
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean; lat: number | null; lng: number | null; locationAuthSigner?: string | null; locationUpdatedAt?: string | null }> {
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/treasury/${encodeURIComponent(treasuryPubkey)}/location`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ ...(location || {}), password: adminPassword }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function clearEnterpriseLocation(
    nodeUrl: string,
    treasuryPubkey: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean; lat: null; lng: null; locationAuthSigner?: string | null; locationUpdatedAt?: string | null }> {
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/treasury/${encodeURIComponent(treasuryPubkey)}/location`);
    const res = await fetch(endpoint, {
        method: 'DELETE',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ password: adminPassword }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function seedTreasuryOffer(
    nodeUrl: string,
    treasuryPubkey: string,
    offer: { title: string; category: string; credits: number; description?: string; priceType?: string; repeatable?: boolean },
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean; post: Record<string, unknown> }> {
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/treasury/${encodeURIComponent(treasuryPubkey)}/offer`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ ...offer, password: adminPassword }),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}: ${res.statusText}`);
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
    /** Why the keys are not secured, in words (e.g. a token-only node: database only). */
    identityNote?: string | null;
    identityFiles: string[];
    historyCount: number;
}

export interface HarvesterStatusResponse {
    // Mirrors the sanitised shape the server sends. adminPassword and replicationToken are
    // deliberately absent — the dashboard has never needed either.
    nodes: Array<{ id: string; name: string; url: string; isPrimary?: boolean }>;
    harvestState: Record<string, HarvesterNodeState>;
}

// The three harvester helpers below talk to /api/manager/* on the SAME ORIGIN — the server
// hosting this dashboard, not the node being inspected — and every one of those routes is behind
// checkAdminAuth. They were sending no credential at all, so each answered 401 and the Harvested
// Fleet Backups tab sat permanently empty. Same class of bug as the download buttons in #377.
// The password travels in X-Admin-Password only, never a query parameter (see the note above
// buildAdminHeaders): checkAdminAuth reads the header ahead of ?password= in its fallback chain,
// and a credential in a URL ends up in access logs and browser history.
export async function fetchHarvesterStatus(adminPassword?: string, tfaToken?: string): Promise<HarvesterStatusResponse> {
    const headers = buildAdminHeaders(adminPassword, tfaToken);
    const res = await fetch('/api/manager/backups/status', { headers });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

// `managerPassword` authenticates US to the local manager API. `adminPassword` is the TARGET
// node's own credential and stays in the body, where the server forwards it to that node — the
// two are different secrets and must not be conflated. The server resolves the target's password
// as `body.adminPassword || body.password || found.adminPassword`, so putting the manager's
// password in `password` would override the configured per-node credential and make the harvest
// authenticate to a remote node with the wrong secret.
export async function triggerHarvesterSync(
    nodeId: string,
    url?: string,
    adminPassword?: string,
    managerPassword?: string,
    tfaToken?: string,
): Promise<any> {
    const managerAuth = managerPassword ?? adminPassword;
    const headers = buildAdminHeaders(managerAuth, tfaToken);
    const res = await fetch('/api/manager/backups/trigger', {
        method: 'POST',
        headers,
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

export async function fetchNodeHistory(nodeId: string, adminPassword?: string, tfaToken?: string): Promise<HistoryFileItem[]> {
    const headers = buildAdminHeaders(adminPassword, tfaToken);
    const res = await fetch(`/api/manager/backups/history?nodeId=${encodeURIComponent(nodeId)}`, { headers });
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

export async function fetchNodeSnapshots(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<SnapshotItem[]> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/snapshots/list');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ password: adminPassword }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.snapshots || [];
}

export async function createNodeSnapshot(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<SnapshotItem> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/snapshots/create');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const data = await res.json();
    return data.snapshot;
}

export async function deleteNodeSnapshot(nodeUrl: string, name: string, adminPassword?: string, tfaToken?: string): Promise<void> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/snapshots/delete');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ name, password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
}

export interface SnapshotScheduleConfig {
    enabled: boolean;
    intervalHours: number;
    keep: number;
}

export interface BackupVerificationResult {
    success: boolean;
    ok: boolean;
    verifiedAt: string;
    result?: unknown[];
}

export async function fetchNodeSnapshotSchedule(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<SnapshotScheduleConfig> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/snapshots/config');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ password: adminPassword }),
    });
    if (!res.ok) {
        return { enabled: true, intervalHours: 24, keep: 7 };
    }
    const data = await res.json();
    return data.config || { enabled: true, intervalHours: 24, keep: 7 };
}

export async function updateNodeSnapshotSchedule(
    nodeUrl: string,
    config: Partial<SnapshotScheduleConfig>,
    adminPassword?: string,
    tfaToken?: string
): Promise<SnapshotScheduleConfig> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/snapshots/config');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ ...config, password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const data = await res.json();
    return data.config;
}

export async function verifyNodeBackup(
    nodeUrl: string,
    snapshotName?: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<BackupVerificationResult> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/backup/verify');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ name: snapshotName, password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function updateNodeReplicationCadence(
    nodeUrl: string,
    pullSeconds: number,
    reconcileMinutes: number,
    adminPassword?: string,
    tfaToken?: string
): Promise<void> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/backup-config');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ pullSeconds, reconcileMinutes, password: adminPassword }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
}

export async function forceNodeResync(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<void> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/replication-resync');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
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
    adminPassword?: string,
    tfaToken?: string
): Promise<RegistrarAllocation[]> {
    const headers = buildAdminHeaders(adminPassword, tfaToken);
    if (adminPassword) {
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
    adminPassword?: string,
    tfaToken?: string
): Promise<{ status: string; name: string }> {
    let nodeUrl = nodeUrlOrName;
    let name = nameOrPassword;
    let pwd = adminPassword;

    if (!nameOrPassword) {
        name = nodeUrlOrName;
        nodeUrl = '';
        pwd = undefined;
    }

    const headers = buildAdminHeaders(pwd, tfaToken);
    if (pwd) {
        headers['x-admin-secret'] = pwd;
    }
    const endpoint = nodeUrl
        ? resolveNodeApiUrl(nodeUrl, `/api/local/admin/registrar/${encodeURIComponent(name || '')}/approve`)
        : `/api/local/admin/registrar/${encodeURIComponent(name || '')}/approve`;

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
    adminPassword?: string,
    tfaToken?: string
): Promise<{ status: string; name: string }> {
    let nodeUrl = nodeUrlOrName;
    let name = nameOrPassword;
    let pwd = adminPassword;

    if (!nameOrPassword) {
        name = nodeUrlOrName;
        nodeUrl = '';
        pwd = undefined;
    }

    const headers = buildAdminHeaders(pwd, tfaToken);
    if (pwd) {
        headers['x-admin-secret'] = pwd;
    }
    const endpoint = nodeUrl
        ? resolveNodeApiUrl(nodeUrl, `/api/local/admin/registrar/${encodeURIComponent(name || '')}/revoke`)
        : `/api/local/admin/registrar/${encodeURIComponent(name || '')}/revoke`;

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

// ======================== REPLICATION TOKEN & ACCESS AUDIT ========================

export interface ReplicationAccessEvent {
    at: string;
    ip: string;
    auth: string;
    reason?: string;
}

export interface ReplicationAccessData {
    hasToken?: boolean;
    tokenOnly?: boolean;
    totalPulls?: number;
    lastPullAt?: string | null;
    lastPullIp?: string | null;
    lastPullAuth?: string | null;
    totalRejected?: number;
    lastRejectedAt?: string | null;
    lastRejectedIp?: string | null;
    recent?: ReplicationAccessEvent[];
    [key: string]: unknown;
}

export interface ReplicationTokenStatus {
    hasToken: boolean;
    tokenOnly: boolean;
    createdAt?: string | null;
}

export async function getReplicationTokenStatus(
    nodeUrl: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<ReplicationTokenStatus> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/replication-token/status');
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

export async function generateReplicationToken(
    nodeUrl: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean; token: string }> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/replication-token/generate');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ password: adminPassword }),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function setReplicationTokenMode(
    nodeUrl: string,
    tokenOnly: boolean,
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean; tokenOnly: boolean }> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/replication-token/mode');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ tokenOnly, password: adminPassword }),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function clearReplicationToken(
    nodeUrl: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean }> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/replication-token/clear');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ password: adminPassword }),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

// ======================== OWNERS' "12 WORDS CHECKED" ========================
// sealed-keys.md §7 (slice 7). Each owner's own signed statement that they checked their 12 words on their device.
// The server cannot verify a words check; this list shows only what each owner said, and when.

export interface OwnerWordsCheck {
    pubkey: string;
    callsign: string;
    /** ms since epoch, or null: not checked yet. */
    wordsCheckedAt: number | null;
    /**
     * The owner's device's silent open check (slice 6): did it open a lock, which, and when. null: no report yet.
     * Absent (undefined) from servers before slice 6, which cannot say either way.
     */
    lockOpen?: { envelopeId: string; opened: boolean; checkedAt: number; current: boolean } | null;
}

export async function getOwnerWordsChecks(
    nodeUrl: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<{ owners: OwnerWordsCheck[]; lock?: { envelopeId: string | null; sealedAt: string | null } }> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/takeover/words-checks');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ password: adminPassword }),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

// ======================== TAKE-OVER LOCK & RECOVERY CODE ========================
// sealed-keys.md §2.6, §7. The recovery code comes back from makeRecoveryCode ONCE: callers keep it in component
// state only (never localStorage, sessionStorage, IndexedDB or a log) and drop it when the card closes.

export interface TakeoverOwner { pubkey: string; callsign: string }

export interface TakeoverStatus {
    state: 'sealed' | 'no-recipients' | 'no-identity' | 'no-genesis' | 'standby' | 'error';
    /** One sentence from the node, safe to show as it is. */
    message: string;
    envelopeId: string | null;
    /** When the take-over keys were last locked (re-sealed). */
    sealedAt: string | null;
    sealReason: string | null;
    recipients: { owners: TakeoverOwner[]; codes: { codeId: number; createdAt: string }[] };
    /** Owners the lock could not include, and why. */
    skippedOwners: (TakeoverOwner & { why: string })[];
    recoveryCode: { codeId: number; createdAt: string } | null;
    /** After a take-over by code: that code is spent until a new one is made (sealed keys slice 5). */
    codeUsed?: { codeId: number; at: string; message: string } | null;
    /** Whether the envelope carries the key that opens members' sign-in recovery copies, in the node's words (recovery
     *  seal S2). Null with no envelope; absent from a node older than S2. */
    recoverySealKey?: { carried: boolean; message: string } | null;
}

/** Whether the next backup leaves locked (backup-status → backupLock, sealed backups #968). */
export type BackupLockStatus =
    | { locked: true; codeId: number; message: string }
    | { locked: false; reason: string; message: string };

export interface MadeRecoveryCode {
    /** The code itself. Shown once; never stored. */
    code: string;
    codeId: number;
    createdAt: string;
    replacedCodeId: number | null;
    status: TakeoverStatus;
}

/** A refusal from a take-over route, carrying the node's own sentence. */
export class TakeoverRequestError extends Error {
    constructor(message: string, public readonly status: number, public readonly body: Record<string, unknown>) {
        super(message);
        this.name = 'TakeoverRequestError';
    }
}

async function takeoverPost(nodeUrl: string, apiPath: string, body: Record<string, unknown>, adminPassword?: string, tfaToken?: string): Promise<Record<string, unknown>> {
    const res = await fetch(resolveNodeApiUrl(nodeUrl, apiPath), {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ ...body, password: adminPassword }),
    });
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
        throw new TakeoverRequestError(typeof json.error === 'string' && json.error ? json.error : `HTTP ${res.status}`, res.status, json);
    }
    return json;
}

export async function fetchTakeoverStatus(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<TakeoverStatus> {
    return await takeoverPost(nodeUrl, '/api/local/admin/takeover/status', {}, adminPassword, tfaToken) as unknown as TakeoverStatus;
}

/** Null when the node is too old to say (before #968). */
export async function fetchBackupLock(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<BackupLockStatus | null> {
    const json = await takeoverPost(nodeUrl, '/api/local/admin/backup-status', {}, adminPassword, tfaToken);
    const lock = json.backupLock as BackupLockStatus | undefined;
    return lock && typeof lock.locked === 'boolean' && typeof lock.message === 'string' ? lock : null;
}

/** Make the recovery code, or with `replace` a new one in place of the current one. Owners only. */
export async function makeRecoveryCode(nodeUrl: string, replace: boolean, adminPassword?: string, tfaToken?: string): Promise<MadeRecoveryCode> {
    const json = await takeoverPost(nodeUrl, '/api/local/admin/takeover/recovery-code', { replace }, adminPassword, tfaToken);
    if (typeof json.code !== 'string' || !json.code) throw new TakeoverRequestError('The node did not return a code.', 500, {});
    return json as unknown as MadeRecoveryCode;
}

/**
 * Does a typed code match this node's current recovery code? `typo` when the check characters already say it was
 * mistyped (the node answers that before any guess is counted).
 */
export async function checkRecoveryCodeApi(
    nodeUrl: string, code: string, adminPassword?: string, tfaToken?: string,
): Promise<{ matches: boolean; codeId: number | null; typo?: boolean; message?: string }> {
    try {
        const json = await takeoverPost(nodeUrl, '/api/local/admin/takeover/recovery-code/check', { code }, adminPassword, tfaToken);
        return { matches: json.matches === true, codeId: typeof json.codeId === 'number' ? json.codeId : null };
    } catch (e) {
        if (e instanceof TakeoverRequestError && e.status === 400 && e.body.typo) {
            return { matches: false, codeId: null, typo: true, message: e.message };
        }
        throw e;
    }
}

export async function getReplicationAccess(
    nodeUrl: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<ReplicationAccessData> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/replication-access');
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

// ======================== ESCROW DISPUTES ========================

export interface EscrowDisputeItem {
    id: string;
    postId: string;
    buyerPubkey: string;
    sellerPubkey: string;
    buyerCallsign?: string;
    buyerName?: string;
    sellerCallsign?: string;
    sellerName?: string;
    credits: number;
    status: string;
    createdAt: number;
    daysStuck: number;
    post: {
        id: string;
        title: string;
        description: string;
        authorPubkey: string;
        authorName?: string;
        authorCallsign?: string;
        priceCredits: number;
        unitPrice: number;
        category: string;
        imageUrl?: string;
    } | null;
    chatContext: {
        id: string;
        senderPubkey: string;
        recipientPubkey: string;
        senderName?: string;
        senderCallsign?: string;
        content: string;
        createdAt: number;
        type?: string;
    }[];
    parties?: {
        buyer?: { pubkey?: string; callsign?: string };
        seller?: { pubkey?: string; callsign?: string };
    };
    resolution?: 'release_to_seller' | 'refund_to_buyer' | 'split' | null;
    resolvedAt?: number | null;
    resolvedBy?: string | null;
}

export const COMMUNITY_ADMIN = 'a community admin';

export function formatResolverName(signer?: string | null): string {
    if (!signer || typeof signer !== 'string') return COMMUNITY_ADMIN;
    const s = signer.trim();
    if (s === 'owner:password' || s === 'admin' || /^[0-9a-f]{64}$/i.test(s)) {
        return COMMUNITY_ADMIN;
    }
    return s;
}

export interface EscrowDisputesResponse {
    disputes: EscrowDisputeItem[];
    total: number;
    /** Every tab's count, whichever status was asked for. Absent on servers older than PR #977. */
    counts?: { pending: number; resolved: number; all: number };
    count?: number;
    minDays: number;
    limit?: number;
    offset?: number;
}

export interface EscrowDisputesOptions {
    limit?: number;
    offset?: number;
    status?: 'all' | 'pending' | 'resolved';
}

export async function fetchEscrowDisputes(
    nodeUrl: string,
    minDays = 7,
    adminPassword?: string,
    tfaToken?: string,
    options?: EscrowDisputesOptions
): Promise<EscrowDisputesResponse> {
    const params: Record<string, string> = { minDays: String(minDays) };
    if (options?.limit !== undefined) params.limit = String(options.limit);
    if (options?.offset !== undefined) params.offset = String(options.offset);
    if (options?.status !== undefined) params.status = options.status;
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/disputes', params);
    const res = await fetch(endpoint, {
        headers: buildAdminHeaders(adminPassword, tfaToken),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export interface ResolveEscrowDisputeResponse {
    success: boolean;
    transactionId: string;
    resolution: 'release_to_seller' | 'refund_to_buyer' | 'split';
    authSigner: string;
    transaction: any;
}

export async function resolveEscrowDisputeApi(
    nodeUrl: string,
    disputeId: string,
    action: 'release_to_seller' | 'refund_to_buyer' | 'split',
    reason?: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<ResolveEscrowDisputeResponse> {
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/disputes/${encodeURIComponent(disputeId)}/resolve`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ action, reason }),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

// ===================== STRANDED ESCROW WRITE-OFF =====================

export interface StrandedEscrowItem {
    escrowId: string;
    balance: number;
    tradeId: string;
    trade: { status: string; credits: number; postId: string; createdAt: string | null; completedAt: string | null } | null;
    transactionCount: number;
    lastTransaction: { memo: string; amount: number; timestamp: string } | null;
    writeOff: { eligible: boolean; refusal: string | null; commonsAfter: number | null; wouldDeficit: boolean };
}

export interface StrandedEscrowsResponse {
    success: boolean;
    commonsBalance: number;
    escrows: StrandedEscrowItem[];
    commonsAfterAll: number;
    eligibleCount: number;
}

export async function fetchStrandedEscrows(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<StrandedEscrowsResponse> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/stranded-escrows');
    const res = await fetch(endpoint, {
        headers: buildAdminHeaders(adminPassword, tfaToken),
        cache: 'no-store',
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export interface StrandedEscrowWriteOffResponse {
    success: true;
    escrowId: string;
    tradeId: string;
    amount: number;
    transactionId: string;
    memo: string;
    commonsBefore: number;
    commonsAfter: number;
}

/** A refused write-off. `code` says why; a deficit refusal also carries the Commons now and after. */
export class StrandedEscrowWriteOffError extends Error {
    constructor(
        message: string,
        readonly code: string | undefined,
        readonly commonsBalance?: number,
        readonly commonsAfter?: number,
    ) {
        super(message);
        this.name = 'StrandedEscrowWriteOffError';
    }
}

export async function writeOffStrandedEscrow(
    nodeUrl: string,
    escrowId: string,
    reason: string,
    confirmDeficit: boolean,
    adminPassword?: string,
    tfaToken?: string,
): Promise<StrandedEscrowWriteOffResponse> {
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/stranded-escrows/${encodeURIComponent(escrowId)}/write-off`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ reason, confirmDeficit }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new StrandedEscrowWriteOffError(body.error || `HTTP ${res.status}: ${res.statusText}`, body.code, body.commonsBalance, body.commonsAfter);
    }
    return body;
}

// ===================== COMMUNITY DECISIONS & EMERGENCY SUSPENSION =====================

export interface AdminDecisionItem {
    id: string;
    title: string;
    description: string;
    effect: string;
    touches: 'member' | 'pool';
    status: string;
    subject: string | null;
    subjectName: string | null;
    params: Record<string, unknown> | null;
    opensAt: string;
    closesAt: string;
    gracePeriodEndsAt: string | null;
    /** Totals only — the node never serves who voted how. */
    tally: {
        totalVoters: number;
        electorate: number;
        quorumRequired: number;
        quorumMet: boolean;
        yesWeight: number;
        noWeight: number;
        supportRatio: number;
        thresholdRequired: number;
    };
}

async function postAdmin<T>(nodeUrl: string, path: string, body: Record<string, unknown>, adminPassword?: string, tfaToken?: string): Promise<T> {
    const res = await fetch(resolveNodeApiUrl(nodeUrl, path), {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ ...body, password: adminPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}: ${res.statusText}`);
    return data as T;
}

/** Open Decisions and removals in their grace window: the ones an admin can still halt. */
export async function fetchAdminDecisions(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<AdminDecisionItem[]> {
    const data = await postAdmin<{ decisions?: AdminDecisionItem[] }>(nodeUrl, '/api/local/admin/decisions', {}, adminPassword, tfaToken);
    return Array.isArray(data?.decisions) ? data.decisions : [];
}

/** The admin brake. The written reason (10+ characters) is public on the Decision. */
export async function haltDecision(nodeUrl: string, decisionId: string, reason: string, adminPassword?: string, tfaToken?: string): Promise<{ success: boolean }> {
    return postAdmin(nodeUrl, `/api/local/admin/decisions/${encodeURIComponent(decisionId)}/halt`, { reason }, adminPassword, tfaToken);
}

/**
 * Emergency suspension: takes effect at once and opens a 7-day "Keep this suspension?" Decision. If members
 * don't keep it, it lifts by itself. The reason (10+ characters) is shown to members on that Decision.
 */
export async function emergencySuspendMember(
    nodeUrl: string,
    pubkey: string,
    reason: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean; decision?: { id: string; closesAt: string } }> {
    return postAdmin(nodeUrl, `/api/local/admin/users/${encodeURIComponent(pubkey)}/suspend`, { reason }, adminPassword, tfaToken);
}

/** Lift a suspension by hand; an open "Keep this suspension?" vote about it closes with it. */
export async function liftMemberSuspension(nodeUrl: string, pubkey: string, adminPassword?: string, tfaToken?: string): Promise<{ success: boolean }> {
    return postAdmin(nodeUrl, `/api/local/admin/users/${encodeURIComponent(pubkey)}/status`, { status: 'active' }, adminPassword, tfaToken);
}

// ===================== MEMBER WIZARDS (docs/settings-ia.md §5 items 1 & 4, Item 9b) =====================

export interface RekeyStatusResponse {
    isInvalidated: boolean;
    invalidatedInfo: {
        public_key: string;
        reason: string;
        invalidated_at: string;
        rekeyed_to: string | null;
    } | null;
    pendingRequest: {
        id: number;
        code: string;
        old_pubkey: string;
        new_pubkey: string | null;
        operator_pubkey: string;
        status: string;
        created_at: string;
        expires_at: string;
    } | null;
    history: Array<{
        id: number;
        old_pubkey: string;
        new_pubkey: string;
        reenrollment_code: string;
        operator_pubkey: string;
        performed_at: string;
        completed_at: string | null;
        details: string | null;
    }>;
}

export interface IssueRekeyCodeResponse {
    success: boolean;
    code: string;
    oldPubkey: string;
    callsign: string;
    expiresAt: string;
    operator: string;
}

export interface CompleteRekeyResponse {
    success: boolean;
    oldPubkey: string;
    newPubkey: string;
    callsign: string;
}

export interface OffboardPreviewResponse {
    member: {
        publicKey: string;
        callsign: string;
        status: string;
        joinedAt: string;
    };
    balance: number;
    commonsBalance: number;
    costToCommunity: number;
    projectedCommonsBalance: number;
    pendingEscrowsCount: number;
    isSoleOwner: boolean;
    activeMembers: Array<{
        publicKey: string;
        callsign: string;
    }>;
}

export interface OffboardResponse {
    success: boolean;
    memberPubkey: string;
    callsign: string;
    resolution: string;
    balanceSettled: number;
}

export async function fetchRekeyStatusApi(
    nodeUrl: string,
    pubkey: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<RekeyStatusResponse> {
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/members/${encodeURIComponent(pubkey)}/rekey/status`);
    const res = await fetch(endpoint, { headers: buildAdminHeaders(adminPassword, tfaToken) });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function issueRekeyCodeApi(
    nodeUrl: string,
    pubkey: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<IssueRekeyCodeResponse> {
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/members/${encodeURIComponent(pubkey)}/rekey/issue-code`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function completeRekeyApi(
    nodeUrl: string,
    pubkey: string,
    code: string,
    newPubkey: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<CompleteRekeyResponse> {
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/members/${encodeURIComponent(pubkey)}/rekey/complete`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ code, newPubkey }),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function fetchOffboardPreviewApi(
    nodeUrl: string,
    pubkey: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<OffboardPreviewResponse> {
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/members/${encodeURIComponent(pubkey)}/offboard/preview`);
    const res = await fetch(endpoint, { headers: buildAdminHeaders(adminPassword, tfaToken) });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

export async function executeOffboardApi(
    nodeUrl: string,
    pubkey: string,
    payload: {
        resolution: 'donate_to_commons' | 'gift_to_member' | 'write_off_commons' | 'prune_zero_balance';
        giftRecipientPubkey?: string;
    },
    adminPassword?: string,
    tfaToken?: string
): Promise<OffboardResponse> {
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/members/${encodeURIComponent(pubkey)}/offboard`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err: any = new Error(body.error || `HTTP ${res.status}: ${res.statusText}`);
        err.code = body.code;
        err.status = res.status;
        throw err;
    }
    return res.json();
}

// ======================== ADDRESSES MEMBERS' APPS USE (request binding) ========================
// A member's app signs each request for the address it reaches the community at, and the node accepts only its own
// addresses (apps/server engine/own-addresses.ts). Settings lists them, offers to confirm one the node doesn't know,
// and says how many apps are too old to name a community (engine/member-signature.ts).

export interface AppAddress {
    address: string;
    /** public-address: the registrar's (or CF_RECORD_NAME); env: BEANPOOL_ADDRESSES; owner: confirmed here; registrar: the registrar's name for this key. */
    source: 'public-address' | 'env' | 'owner' | 'registrar';
    today: number;
    busiestDay: number;
}

export interface AppAddressesReport {
    addresses: AppAddress[];
    /** Addresses apps reached this node at while it knew none of its own: offered to confirm. */
    unconfirmed: { address: string; today: number; busiestDay: number }[];
    /** Apps that signed in the old format, bound to no community. */
    oldApps: { today: number; busiestDay: number };
    /** The day (UTC) old apps stop working here, or null when they already don't. */
    unboundSignaturesUntil: string | null;
    unboundSignaturesAccepted: boolean;
}

async function appAddressesCall(nodeUrl: string, path: string, init: RequestInit): Promise<AppAddressesReport> {
    const res = await fetch(resolveNodeApiUrl(nodeUrl, path), init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}: ${res.statusText}`);
    return body as AppAddressesReport;
}

export function getAppAddresses(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<AppAddressesReport> {
    return appAddressesCall(nodeUrl, '/api/local/admin/app-addresses', { headers: buildAdminHeaders(adminPassword, tfaToken) });
}

export function confirmAppAddress(nodeUrl: string, address: string, adminPassword?: string, tfaToken?: string): Promise<AppAddressesReport> {
    return appAddressesCall(nodeUrl, '/api/local/admin/app-addresses/confirm', {
        method: 'POST', headers: buildAdminHeaders(adminPassword, tfaToken), body: JSON.stringify({ address }),
    });
}

export function removeAppAddress(nodeUrl: string, address: string, adminPassword?: string, tfaToken?: string): Promise<AppAddressesReport> {
    return appAddressesCall(nodeUrl, '/api/local/admin/app-addresses/remove', {
        method: 'POST', headers: buildAdminHeaders(adminPassword, tfaToken), body: JSON.stringify({ address }),
    });
}
