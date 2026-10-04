/**
 * Typed Node Client — Communicates with sovereign node REST and WebSocket APIs
 */

import { audienceOf } from '@beanpool/core';
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
    /** The community's contacts as stored (null for none); absent on a node from before they moved off the public route. */
    contactEmail?: string | null;
    contactPhone?: string | null;
    shutdownStatus?: ShutdownStatus;
    diskHealth?: DiskHealth;
    /** The node's watch on its standbys (apps/server services/standby-health.ts): owners only, null to anyone else. */
    standbyHealth?: StandbyHealthBanner | null;
    /** Off-box backups that need the owners (apps/server services/offbox-backups.ts): owners only, null to anyone else. */
    offboxBackups?: { problems: string[] } | null;
}

/** When the standby needs its owners: an incident, in the node's words, and each standby it watches. */
export interface StandbyHealthBanner {
    incident: { id: string; startedAt: number; pushed: boolean; lines: string[]; whatToDo: string[] } | null;
    standbys: { id: string; label: string; lastPullAt: number; lastCopyAt: number | null; lastExactAt: number | null; healthy: boolean }[];
}

/** An owner's "this standby is gone for good": the node stops watching it until it reports again. */
export async function forgetStandby(
    nodeUrl: string,
    id: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<{ success: boolean } & StandbyHealthBanner> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/standby-health/forget');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ ...passwordField(adminPassword), id }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
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
    description?: string;
    severity?: string;
    status?: string;
    outcome?: 'open' | 'dismissed' | 'actioned' | string;
    reporterCallsign?: string;
    targetCallsign?: string;
    postId?: string | null;
    postTitle?: string | null;
    title?: string | null;
    postAuthorCallsign?: string | null;
    /** The reported post's author's key, read by the node from the post (null when no post is reported). */
    postAuthorPubkey?: string | null;
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
    /** Each member's posts and messages counts; no member's trades (queue item 29). */
    memberStats?: Record<string, unknown>;
    /** Of trades, only the community's totals: completed deals, their volume in Beans, cancelled. */
    tradeTotals?: { deals: number; volume: number; cancelled: number };
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
        body: JSON.stringify({ ...passwordField(adminPassword), totpCode }),
    });
    const body = await res.json();
    if (!res.ok) {
        throw new Error(body?.error || `HTTP ${res.status}`);
    }
    return body;
}

/**
 * CSRF token for the session cookie (lib/key-session.ts): a key sign-in's, or the password sign-in's. The session
 * rides in an httpOnly cookie that the browser attaches by itself, so the node refuses cookie-authenticated changes
 * without this header, and takes it only from the session it was issued to. Held in memory only; a reload fetches a
 * new one. Null in fleet mode, whose profiles send their password in a header instead.
 */
let keySessionCsrfToken: string | null = null;

export function setKeySessionCsrfToken(token: string | null): void {
    keySessionCsrfToken = token;
}

/** An owner automation token's shape (server automation-tokens.ts TOKEN_SHAPE): bp_ + 12 hex + _ + 64 hex. */
const AUTOMATION_TOKEN_SHAPE = /^bp_[0-9a-f]{12}_[0-9a-f]{64}$/;

/**
 * Whether a profile's credential (profiles.ts nodeCredential) is an automation token rather than a password. Decided by
 * the token's exact shape: the server takes any bearer starting bp_ as a token, and a token is never sent as a password.
 */
export function isAutomationToken(credential: string | undefined | null): credential is string {
    return typeof credential === 'string' && AUTOMATION_TOKEN_SHAPE.test(credential);
}

/**
 * The body's `password` for a request: the password itself, or nothing when the credential is a token (it travels only
 * in the Authorization header, buildAdminHeaders). Every request body that used to say `...passwordField(adminPassword)`
 * spreads this instead, so a token never lands in a body.
 */
export function passwordField(credential: string | undefined): { password?: string } {
    return isAutomationToken(credential) ? {} : { password: credential };
}

/**
 * Build headers for node API calls from a profile's credential (profiles.ts nodeCredential) and optional 2FA session
 * token. A password goes in X-Admin-Password (with the 2FA session, so TOTP-enabled nodes work transparently); an
 * automation token goes as `Authorization: Bearer` alone: it asks for no 2FA, and the password header is never sent
 * with it. Every fetch helper below uses this.
 */
export function buildAdminHeaders(adminPassword?: string, tfaSessionToken?: string): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (isAutomationToken(adminPassword)) {
        headers['Authorization'] = `Bearer ${adminPassword}`;
        if (keySessionCsrfToken) headers['X-CSRF-Token'] = keySessionCsrfToken;
        return headers;
    }
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
 * 2FA session tokens of the fleet manager's password profiles, held in this page's memory only. They used to be in
 * sessionStorage, which on a node is the members' web app's origin too: a script there could take one with the
 * password and skip 2FA (Fable's web review, M1). A reload asks for a code again. Single-node Settings needs none:
 * its session is the node's httpOnly cookie, which a code opened once.
 */
const tfaSessionTokens = new Map<string, string>();

export function getTfaSessionToken(profileId: string): string | undefined {
    return tfaSessionTokens.get(profileId);
}

export function setTfaSessionToken(profileId: string, token: string | undefined): void {
    if (token) tfaSessionTokens.set(profileId, token);
    else tfaSessionTokens.delete(profileId);
}

export function clearAllTfaSessionTokens(): void {
    tfaSessionTokens.clear();
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
    // The dashboard's own /api/manager routes are not a node: they get no credential (see isManagerApi).
    const managerApi = isManagerApi(endpointPath);
    const headers = managerApi ? {} : buildAdminHeaders(adminPassword, tfaToken);
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
        throw new Error(managerApi ? `${HARVESTER_UNAVAILABLE} (${detail})` : detail);
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

/**
 * Sign-in step 7c: a node with two-factor sign-in off refuses the admin password sent with a request, 403
 * password_needs_2fa. A profile with only a password then needs one of these, said after the node's own words.
 */
export const PASSWORD_NEEDS_2FA_HINT = 'This profile signs in with the admin password; an owner\'s token works without it';

/** Sign-in step 10: the node answered 403 password_retired. A profile with only a password needs a token from now on. */
export const PASSWORD_RETIRED_HINT = "This node's password is retired: use a token";

/** The error for a request refused that way: the node's words plus the hint. Null for any other answer; the body is left unread. */
export async function passwordNeeds2faError(res: Response): Promise<Error | null> {
    if (res.status !== 403) return null;
    // A copy, so the caller can still read the body; a stand-in Response without clone() is read as it is.
    const copy = typeof res.clone === 'function' ? res.clone() : res;
    const body = await Promise.resolve().then(() => copy.json()).catch(() => null) as { error?: unknown; code?: unknown } | null;
    if (body?.code === 'password_retired') {
        return new Error(`${PASSWORD_RETIRED_HINT} (an owner makes one in Settings, Access & Security, Automation tokens).`);
    }
    if (body?.code !== 'password_needs_2fa') return null;
    const words = typeof body.error === 'string' && body.error.trim() ? body.error.trim() : 'This node needs two-factor sign-in for the admin password';
    return new Error(`${words}${/[.!?]$/.test(words) ? '' : '.'} ${PASSWORD_NEEDS_2FA_HINT}.`);
}

/**
 * Does this error mean "the credential was refused" rather than "node unreachable"?
 *
 * `fetchDiagnostics` throws `HTTP 401: Unauthorized`; the friendlier per-endpoint
 * messages say the same thing in words. Both are matched, because retrying is futile
 * either way — no amount of waiting turns a rejected password into an accepted one.
 * A password refused because the node's two-factor sign-in is off (passwordNeeds2faError) is one too.
 */
export function isAuthFailure(message: string): boolean {
    return /\b401\b/.test(message) || /unauthor/i.test(message) || /admin password/i.test(message)
        || message.includes(PASSWORD_NEEDS_2FA_HINT) || message.includes(PASSWORD_RETIRED_HINT);
}

export async function fetchDiagnostics(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<DiagnosticsResponse> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/diagnostics');
    const res = await fetch(endpoint, {
        headers: buildAdminHeaders(adminPassword, tfaToken),
        cache: 'no-store',
    });
    if (!res.ok) {
        throw (await passwordNeeds2faError(res)) ?? new Error(`HTTP ${res.status}: ${res.statusText}`);
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
        body: JSON.stringify({ ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ ...passwordField(adminPassword) }),
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
    /** Whether the open door takes joins now (the node's `openJoin`). A node from before it was sent leaves it out. */
    openDoor?: boolean;
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

/** One UTC day of web app visits: page loads, and about how many different visitors made them. */
export interface WebVisitDay {
    day: string;
    visits: number;
    uniques: number;
}

export interface WebVisitsResponse {
    days: number;
    retentionDays: number;
    /** Exactly `days` entries, oldest first; the last is today (UTC). */
    series: WebVisitDay[];
}

/** The node's own count of web app visits a day (no cookies, nobody identified): the manager's Home card. */
export async function fetchWebVisits(
    nodeUrl: string,
    adminPassword?: string,
    days = 30,
    tfaToken?: string,
): Promise<WebVisitsResponse> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/web-visits', { days: String(days) });
    const res = await fetch(endpoint, {
        headers: buildAdminHeaders(adminPassword, tfaToken),
        cache: 'no-store',
    });
    if (!res.ok) {
        if (res.status === 401) {
            throw new Error("Wrong or missing admin password for this node — check it under the node's settings.");
        }
        if (res.status === 404) {
            throw new Error("This node's build doesn't count web app visits yet. Update it to see them.");
        }
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

/** One phone platform's floor and the app versions its members run (server routes/admin.ts GET /api/local/admin/app-versions). */
export interface AppPlatformVersions {
    /** The floor as set (MIN_APP_VERSION_<PLATFORM>, else MIN_APP_VERSION, else the default). */
    floor: string;
    /** The newest build the node has seen in that store, or null. */
    store: string | null;
    /** The floor apps are held to: `floor` once the store has it, else null. */
    enforced: string | null;
    /** The store has a build, but below the floor: the floor waits for it. */
    held: boolean;
    /** The grace date (ISO), or null: the block applies already. */
    from: string | null;
    /** The grace date was set but is not a date: the block is off. */
    fromInvalid: boolean;
    /** An app below `enforced` stops at its next safe moment. */
    blocking: boolean;
    /** Members per app version, newest first. */
    versions: Array<{ version: string; members: number }>;
}

export interface AppVersionsResponse {
    /** Counted from (ISO): the later of the server's start and `windowDays` ago. */
    since: string;
    windowDays: number;
    minAppVersion: string;
    minAppVersionFrom: string | null;
    storeCheckedAt: string | null;
    platforms: { android: AppPlatformVersions; ios: AppPlatformVersions };
}

/** The phone app's floors and the versions members run, as counts (nobody named): the manager's Home card. */
export async function fetchAppVersions(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<AppVersionsResponse> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/app-versions');
    const res = await fetch(endpoint, {
        headers: buildAdminHeaders(adminPassword, tfaToken),
        cache: 'no-store',
    });
    if (!res.ok) {
        if (res.status === 401) {
            throw new Error("Wrong or missing admin password for this node — check it under the node's settings.");
        }
        if (res.status === 404) {
            throw new Error("This node's build doesn't count app versions yet. Update it to see them.");
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
        body: JSON.stringify({ ...updates, ...passwordField(adminPassword) }),
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
                // A Pulse report is about its item, whatever post a node joined to it (reportSubject): no post.
                postId: typeof r.postId === 'string' && !onPulseItem(r) ? r.postId : null,
                postAuthorCallsign: onPulseItem(r) ? null : (r.postAuthorCallsign ?? null),
                postAuthorPubkey: onPulseItem(r) ? null : (normalizeKeeperPubkey(r.postAuthorPubkey) || null),
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

/**
 * The alerts' names-free summary (POST /api/local/admin/alerts-summary): each alert's kind and severity, the ones that
 * name members with no member, description or Beans, the reports' count and each report's id (no reporter, member or
 * reason). The node logs nothing for it, so the background flag check reads this, never the full data (review
 * r4177560410), and a report's id is enough to light the ALERT dot and to keep a dismissed one dark (r4177719213).
 */
export async function fetchAlertsSummary(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<{ flags: NodeHealthFlag[]; reportCount: number; reportIds: string[] }> {
    const res = await fetch(resolveNodeApiUrl(nodeUrl, '/api/local/admin/alerts-summary'), {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ ...passwordField(adminPassword) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const json = await res.json();
    return {
        flags: Array.isArray(json?.flags) ? json.flags : [],
        reportCount: typeof json?.reportCount === 'number' ? json.reportCount : 0,
        reportIds: Array.isArray(json?.reportIds) ? json.reportIds.filter((id: unknown): id is string => typeof id === 'string') : [],
    };
}

export async function fetchNodeData(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<NodeDataPayload> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/data');
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ ...passwordField(adminPassword), limit: 50 }),
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
        body: JSON.stringify({ freeze, ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ ...passwordField(adminPassword) }),
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
        credentials: 'same-origin',
        body: JSON.stringify({ ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ removePulseItem: true, ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ ...passwordField(adminPassword) }),
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
            // A Pulse report is about its item, whatever post a node joined to it (reportSubject): no post.
            postId: typeof r.postId === 'string' && !onPulseItem(r) ? r.postId : null,
            postAuthorCallsign: onPulseItem(r) ? null : (r.postAuthorCallsign ?? null),
            postAuthorPubkey: onPulseItem(r) ? null : (normalizeKeeperPubkey(r.postAuthorPubkey) || null),
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
            ...(adminPassword ? { ...passwordField(adminPassword) } : {}),
        }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}: ${res.statusText}`);
    return data;
}

// ── Clean-up by burst (server: engine/burst-cleanup.ts) ─────────────────────────────────────────────────────────────
// From one account, the others that joined through the open door from the same connection within a day of it. The node
// says nothing about the connection itself: only which accounts share one.

export interface BurstAccount {
    publicKey: string;
    callsign: string | null;
    /** When they joined through the door. */
    joinedAt: string;
    status: 'active' | 'suspended' | 'removed';
    standing: number;
    standingParts: { weeks: number; keptPosts: number; dealPartners: number };
    /** Standing at or above the node's `establishedStanding`: an action names them only when told so. */
    established: boolean;
    postsUp: number;
    postsHidden: number;
    openReports: number;
    /** Owner, admin or moderator: never part of an action. */
    holdsRole: boolean;
}

export interface Burst {
    account: BurstAccount;
    joinedThroughDoor: boolean;
    others: BurstAccount[];
    count: number;
    removedAlready: number;
    establishedStanding: number;
}

export interface BurstDigestLine {
    accounts: number;
    stillHere: number;
    removed: number;
    reported: number;
    postsHidden: number;
    firstJoinAt: string;
    lastJoinAt: string;
    open: { publicKey: string; callsign: string | null } | null;
}

export interface BurstActionLine {
    id: string;
    kind: 'hide' | 'remove';
    at: string;
    by: 'owner' | 'admin' | 'moderator';
    accounts: number;
    posts: number;
    undoneAt: string | null;
    account: { publicKey: string; callsign: string | null } | null;
}

export interface BurstDigest {
    bursts: BurstDigestLine[];
    actions: BurstActionLine[];
    minAccounts: number;
    days: number;
}

/** A refusal from the node, with its code, and for `established` the accounts it means. */
export class BurstRequestError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string, readonly established?: string[]) {
        super(message);
        this.name = 'BurstRequestError';
    }
}

async function burstRequest<T>(nodeUrl: string, path: string, method: 'GET' | 'POST', body: unknown, adminPassword?: string, tfaToken?: string): Promise<T> {
    const res = await fetch(resolveNodeApiUrl(nodeUrl, path), {
        method,
        headers: buildAdminHeaders(adminPassword, tfaToken),
        credentials: 'same-origin',
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new BurstRequestError(data?.error || `HTTP ${res.status}: ${res.statusText}`, res.status, data?.code,
            Array.isArray(data?.established) ? data.established : undefined);
    }
    return data as T;
}

/**
 * The digest: recent bursts and the actions taken. Null where there are none to have: a node whose door labels no joins
 * (every local community, 404), or one from before this (404 or 403).
 */
export async function fetchBurstDigest(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<BurstDigest | null> {
    try {
        const d = await burstRequest<Partial<BurstDigest>>(nodeUrl, '/api/local/admin/bursts', 'GET', undefined, adminPassword, tfaToken);
        return {
            bursts: Array.isArray(d.bursts) ? d.bursts : [],
            actions: Array.isArray(d.actions) ? d.actions : [],
            minAccounts: typeof d.minAccounts === 'number' ? d.minAccounts : 5,
            days: typeof d.days === 'number' ? d.days : 7,
        };
    } catch (e: unknown) {
        if (e instanceof BurstRequestError && (e.status === 404 || e.status === 403)) return null;
        throw e;
    }
}

/** Whether a report is on a Pulse item: then it is about the item's owner, whatever post id the row carries. */
function onPulseItem(report: { targetPulseItemId?: unknown; pulseItem?: unknown }): boolean {
    return (typeof report.targetPulseItemId === 'string' && report.targetPulseItemId !== '')
        || (!!report.pulseItem && typeof report.pulseItem === 'object');
}

/**
 * The member a report is about: whom a moderator suspends, freezes, names as its target or opens "Who joined with them"
 * from. A report on a Pulse item is about its owner, the report's target as the node sets it, whatever post id the row
 * carries (a node before #1444 joined that post to it). A report on a post is about the post's author, as the node reads it from the post (`postAuthorPubkey`), never the
 * key the reporter sent (`targetPubkey`): a crafted report could name anyone beside a real spam post. A node that doesn't
 * say who wrote it gets null, so nothing is offered. Otherwise (a member, or a Pulse item, whose owner the node sets) the
 * report's target.
 */
export function reportSubject(report: {
    postId?: unknown; postAuthorPubkey?: unknown; targetPubkey?: unknown; target_pubkey?: unknown; targetPulseItemId?: unknown; pulseItem?: unknown;
}): string | null {
    if (!onPulseItem(report) && typeof report.postId === 'string' && report.postId) {
        return typeof report.postAuthorPubkey === 'string' && report.postAuthorPubkey ? report.postAuthorPubkey : null;
    }
    const target = typeof report.targetPubkey === 'string' && report.targetPubkey ? report.targetPubkey
        : (typeof report.target_pubkey === 'string' ? report.target_pubkey : '');
    return target || null;
}

/** One account's burst: the account, and the others still here, oldest join first. */
export async function fetchBurst(nodeUrl: string, pubkey: string, adminPassword?: string, tfaToken?: string): Promise<Burst> {
    return burstRequest<Burst>(nodeUrl, `/api/local/admin/members/${encodeURIComponent(pubkey)}/burst`, 'GET', undefined, adminPassword, tfaToken);
}

/** Exactly these accounts, and how many, as the node's guard asks. `includeEstablished` only once the screen has said so. */
function selection(members: string[], includeEstablished: boolean) {
    return { members, count: members.length, ...(includeEstablished ? { includeEstablished: true } : {}) };
}

export async function hideBurstPosts(
    nodeUrl: string, anchor: string, members: string[], includeEstablished: boolean, adminPassword?: string, tfaToken?: string,
): Promise<{ action: { id: string; kind: 'hide'; accounts: number; posts: number } }> {
    return burstRequest(nodeUrl, `/api/local/admin/members/${encodeURIComponent(anchor)}/burst/hide`, 'POST', selection(members, includeEstablished), adminPassword, tfaToken);
}

/** Owners and admins only: the node refuses a moderator. */
export async function removeBurstAccounts(
    nodeUrl: string, anchor: string, members: string[], includeEstablished: boolean, adminPassword?: string, tfaToken?: string,
): Promise<{ removed: number; failed: { publicKey: string; error: string }[] }> {
    return burstRequest(nodeUrl, `/api/local/admin/members/${encodeURIComponent(anchor)}/burst/remove`, 'POST', selection(members, includeEstablished), adminPassword, tfaToken);
}

export async function undoBurstHide(nodeUrl: string, actionId: string, adminPassword?: string, tfaToken?: string): Promise<{ restored: number; keptHidden: number }> {
    return burstRequest(nodeUrl, `/api/local/admin/bursts/${encodeURIComponent(actionId)}/undo`, 'POST', {}, adminPassword, tfaToken);
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
        body: JSON.stringify({ ...passwordField(adminPassword), type }),
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
        body: JSON.stringify({ tier, ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ grant: canVouch, ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ granted, ...passwordField(adminPassword) }),
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
    /** Whether this owner holds a break-glass code now. */
    has_break_glass?: boolean;
    /** When their code was last made (null: no code, or made before nodes recorded it; absent from an older node). */
    break_glass_made_at?: string | null;
    /** From which kind of session: 'key-session' | 'app' | 'password' | 'break-glass' | 'recover'. */
    break_glass_made_by?: string | null;
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

/**
 * The node's enterprises, asked with the admin password (GET /api/local/admin/treasury): the public list is members'
 * on every node now (the server's https-server.ts MEMBERS_ONLY_READS_PATTERNS), and Settings signs as no member.
 */
export async function fetchNodeTreasuries(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<NodeTreasury[]> {
    const endpoint = resolveNodeApiUrl(nodeUrl, '/api/local/admin/treasury');
    const res = await fetch(endpoint, { headers: buildAdminHeaders(adminPassword, tfaToken) });
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
        body: JSON.stringify({ ...data, ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ ...(location || {}), ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ ...offer, ...passwordField(adminPassword) }),
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

// The harvester helpers below talk to /api/manager/* on the SAME ORIGIN: the server behind this dashboard, not the
// node being inspected. No credential goes there, token or password (node sign-in step 7b-1). A profile's credential
// belongs to its own node only, and no server route handles /api/manager today (the fleet manager's nightly backup
// pull was retired), so a credential sent there could only reach a server that isn't its node.
export const HARVESTER_UNAVAILABLE = 'No harvested backups here: the server behind this dashboard keeps none';

/** True for the dashboard's own /api/manager routes, which never get a node's credential. */
export function isManagerApi(path: string): boolean {
    const p = new URL(path, typeof window !== 'undefined' ? window.location.href : 'http://localhost').pathname.toLowerCase();
    return p === '/api/manager' || p.startsWith('/api/manager/');
}

export async function fetchHarvesterStatus(): Promise<HarvesterStatusResponse> {
    const res = await fetch('/api/manager/backups/status');
    if (!res.ok) {
        throw new Error(`${HARVESTER_UNAVAILABLE} (HTTP ${res.status})`);
    }
    return res.json();
}

// A harvest only ever did something by forwarding the target node's credential to the server behind this page, which
// no longer happens; so this says so and sends nothing.
export async function triggerHarvesterSync(nodeId: string): Promise<never> {
    throw new Error(`${HARVESTER_UNAVAILABLE}, so there is no harvest to start for ${nodeId}`);
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
        throw new Error(`${HARVESTER_UNAVAILABLE} (HTTP ${res.status})`);
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
        body: JSON.stringify({ ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ name, ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ ...passwordField(adminPassword) }),
    });
    // The node's real schedule or an error: never a made-up default shown as if it were the node's.
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const data = await res.json();
    if (!data?.config) throw new Error("The node didn't say its backup schedule");
    return data.config;
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
        body: JSON.stringify({ ...config, ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ name: snapshotName, ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ pullSeconds, reconcileMinutes, ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ ...passwordField(adminPassword) }),
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
    if (adminPassword && !isAutomationToken(adminPassword)) {
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
    if (pwd && !isAutomationToken(pwd)) {
        headers['x-admin-secret'] = pwd;
    }
    const endpoint = nodeUrl
        ? resolveNodeApiUrl(nodeUrl, `/api/local/admin/registrar/${encodeURIComponent(name || '')}/approve`)
        : `/api/local/admin/registrar/${encodeURIComponent(name || '')}/approve`;

    const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...passwordField(pwd) }),
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
    if (pwd && !isAutomationToken(pwd)) {
        headers['x-admin-secret'] = pwd;
    }
    const endpoint = nodeUrl
        ? resolveNodeApiUrl(nodeUrl, `/api/local/admin/registrar/${encodeURIComponent(name || '')}/revoke`)
        : `/api/local/admin/registrar/${encodeURIComponent(name || '')}/revoke`;

    const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...passwordField(pwd) }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

// ======================== REPLICATION TOKEN & ACCESS AUDIT ========================

export interface ReplicationAccessEvent {
    /** Epoch milliseconds from the node (a string from older fixtures). */
    at: string | number;
    /** Null once the entry is 7 days old: the node keeps an address no longer (server services/address-retention.ts). */
    ip: string | null;
    auth: string;
    reason?: string;
}

export interface ReplicationAccessData {
    hasToken?: boolean;
    tokenOnly?: boolean;
    totalPulls?: number;
    lastPullAt?: string | number | null;
    lastPullIp?: string | null;
    lastPullAuth?: string | null;
    totalRejected?: number;
    lastRejectedAt?: string | number | null;
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
        body: JSON.stringify({ ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ tokenOnly, ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ ...body, ...passwordField(adminPassword) }),
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
        body: JSON.stringify({ ...passwordField(adminPassword) }),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return res.json();
}

// ======================== OFF-BOX BACKUPS ========================
// The main server's locked backups, sent on a schedule to S3-compatible stores its owners choose (apps/server
// services/offbox-backups.ts). Every route is an owner's. A secret is never sent back: `secretSet` says one is set.

export type OffboxHealth = 'ok' | 'waiting' | 'failing' | 'stale' | 'broken';

export interface OffboxDestinationStatus {
    id: string;
    name: string;
    /** `env`: set in the server's .env, changed only there. */
    source: 'env' | 'settings';
    endpoint: string | null;
    bucket: string | null;
    region: string | null;
    prefix: string | null;
    /** Shortened by the node; never the whole key id. */
    accessKeyId: string | null;
    secretSet: boolean;
    /** Why a destination can't be used, by setting name. */
    problems: string[];
    health: OffboxHealth;
    lastSuccessAt: number | null;
    lastSuccessBytes: number | null;
    lastAttemptAt: number | null;
    lastError: string | null;
    failures: number;
    nextAttemptAt: number | null;
    lastPruneAt: number | null;
    lastPruneError: string | null;
}

export interface OffboxStatus {
    state: 'sending' | 'none' | 'not-locked' | 'standby' | 'replaced';
    message: string;
    intervalHours: number;
    intervalFrom: 'settings' | 'env' | 'default';
    retentionDays: number;
    retentionFrom: 'settings' | 'env' | 'default';
    maxRetentionDays: number;
    maxIntervalHours: number;
    running: boolean;
    destinations: OffboxDestinationStatus[];
}

export interface OffboxDestinationInput {
    /** Set to change one; absent to add one. */
    id?: string;
    name: string;
    endpoint: string;
    bucket: string;
    region: string;
    prefix: string;
    accessKeyId: string;
    /** Empty when changing one keeps the secret the node holds. */
    secretAccessKey: string;
}

export interface OffboxSettingsUpdate {
    intervalHours?: number | null;
    retentionDays?: number | null;
    destination?: OffboxDestinationInput;
    removeId?: string;
}

export interface OffboxListedBackup {
    key: string;
    community: string;
    file: string;
    madeAt: number;
    bytes: number;
    /** This server's own community (a fresh server restoring a lost one lists the lost one's as not its own). */
    ours: boolean;
}

/** POST to an off-box route; a refusal comes back as an Error carrying the node's own sentence. */
async function offboxPost<T>(nodeUrl: string, apiPath: string, body: object, adminPassword?: string, tfaToken?: string): Promise<T> {
    const res = await fetch(resolveNodeApiUrl(nodeUrl, apiPath), {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
        body: JSON.stringify({ ...passwordField(adminPassword), ...body }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => null) as { error?: string } | null;
        throw Object.assign(new Error(err?.error || `HTTP ${res.status}: ${res.statusText}`), { status: res.status });
    }
    return res.json();
}

export function getOffboxStatus(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<OffboxStatus> {
    return offboxPost(nodeUrl, '/api/local/admin/offbox-backups/status', {}, adminPassword, tfaToken);
}

export function saveOffboxSettings(
    nodeUrl: string, update: OffboxSettingsUpdate, adminPassword?: string, tfaToken?: string,
): Promise<{ success: boolean; status: OffboxStatus }> {
    return offboxPost(nodeUrl, '/api/local/admin/offbox-backups/settings', update, adminPassword, tfaToken);
}

/** Send one now to every destination. Answers at once; `status.running` says when it is done. */
export function runOffboxBackupNow(nodeUrl: string, adminPassword?: string, tfaToken?: string): Promise<{ started: boolean; status: OffboxStatus }> {
    return offboxPost(nodeUrl, '/api/local/admin/offbox-backups/run', {}, adminPassword, tfaToken);
}

export function listOffboxBackups(
    nodeUrl: string, destination: string, adminPassword?: string, tfaToken?: string,
): Promise<{ destination: string; backups: OffboxListedBackup[] }> {
    return offboxPost(nodeUrl, '/api/local/admin/offbox-backups/list', { destination }, adminPassword, tfaToken);
}

/** Save one off-box backup, to restore with the Restore wizard. */
export function downloadOffboxBackup(
    nodeUrl: string, destination: string, backup: OffboxListedBackup, adminPassword?: string, tfaToken?: string,
): Promise<DownloadNotice> {
    return downloadAdminFile(
        resolveNodeApiUrl(nodeUrl, '/api/local/admin/offbox-backups/download'),
        { destination, key: backup.key },
        adminPassword,
        backup.file,
        tfaToken,
    );
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
        body: JSON.stringify({ ...body, ...passwordField(adminPassword) }),
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

/**
 * Whether the node runs formal Decisions (`features.decisions` in its public `/api/community/info`). Off on the global
 * node: there an emergency suspension opens no vote and lifts by itself after 7 days. Only a node that says outright
 * it has none has none: every server before the switch allowed them, and one that can't be read is taken as on.
 */
export async function fetchNodeDecisionsOn(nodeUrl: string): Promise<boolean> {
    try {
        const res = await fetch(resolveNodeApiUrl(nodeUrl, '/api/community/info'));
        if (!res.ok) return true;
        const data = await res.json().catch(() => null);
        return data?.features?.decisions !== false;
    } catch {
        return true;
    }
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
): Promise<{ success: boolean; decision?: { id: string; closesAt: string; params?: { noVote?: boolean } } }> {
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
        /**
         * Left out for an owner's or admin's re-key unless the reader issued it or is an owner; and, from a phone session
         * past its step-up window, until Manage is pressed again (then `codeNeedsStepUp` is true).
         */
        code?: string;
        codeNeedsStepUp?: boolean;
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

/** The node’s answer to a cancelled re-key code: the member’s status now, and a note when it was guessed (an older code). */
export interface CancelRekeyCodeResponse {
    success: boolean;
    cancelled: true;
    oldPubkey: string;
    callsign: string;
    status: string;
    note?: string;
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

/** Cancels a re-key code nobody has used: the member’s key works again and their status is put back. */
export async function cancelRekeyCodeApi(
    nodeUrl: string,
    pubkey: string,
    adminPassword?: string,
    tfaToken?: string
): Promise<CancelRekeyCodeResponse> {
    const endpoint = resolveNodeApiUrl(nodeUrl, `/api/local/admin/members/${encodeURIComponent(pubkey)}/rekey/cancel`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: buildAdminHeaders(adminPassword, tfaToken),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // A node before the cancel answers 404 with no message.
        throw new Error(body.error || (res.status === 404 ? 'This node can’t cancel a re-key code yet: update it first.' : `HTTP ${res.status}: ${res.statusText}`));
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
    /** A BeanPool name this community's key held before: still accepted, no longer published. */
    former?: boolean;
    today: number;
    busiestDay: number;
    /**
     * Another community holds it and answers there, or this community released it and the hold is over: refused, never
     * published (apps/server services/registrar-name-watch.ts). Absent from a server before 2026-09-28.
     */
    lost?: boolean;
    /** With `lost`: members' apps refused there, today and on the busiest day of the last 7. */
    tried?: { today: number; busiestDay: number };
    /** A BeanPool name the address service no longer gives this community, and what that means here. */
    standing?: NameStanding;
}

/** apps/server services/registrar-name-watch.ts NameStanding. */
export interface NameStanding {
    /**
     * at-risk: the address service says it isn't this community's, and it is still accepted; contradiction: it says
     * another community holds it, but it still leads to this server; lost.
     */
    state: 'at-risk' | 'contradiction' | 'lost';
    /** other, free, released (by this community), or the address service's latest word (none, revoked…). */
    registrarSays: string | null;
    releasedOn: string | null;
    /** Until when a name this community released is still accepted. */
    acceptedUntil: string | null;
    /** This server's own key answered at the name the last time it was asked. */
    leadsHere: boolean;
    lostSince: string | null;
    why: 'another-key' | 'released' | null;
    checkedAt: string | null;
}

export interface AddressSighting {
    address: string;
    /** Members' apps that reached the node at it today. */
    today: number;
    /** Members' apps that reached it there on the busiest day of the last 7. */
    busiestDay: number;
    /** Whether an owner's or admin's app reached it there this week. Absent from a server before 2026-09-27's guard. */
    ownerOrAdmin?: boolean;
}

export interface HeldBackAddress extends AddressSighting {
    /**
     * another-community: a beanpool.org name that isn't this community's (never confirmed here); directory: the
     * BeanPool directory the node holds lists it as a community's address (confirmed only once ticked, after a warning
     * naming that community; only a node that holds the directory says so); not-this-page: any other address but the
     * one Settings is open at (confirmed only once ticked, whoever's apps reached it).
     */
    reason: 'another-community' | 'directory' | 'not-this-page';
    /** The directory's entry for it, when it lists it: that community's name, or null when it gives none. */
    directory?: { name: string | null };
}

export interface AppAddressesReport {
    addresses: AppAddress[];
    /**
     * Whether any of `addresses` names this community. A loopback name listed on the server (for an SSH tunnel) names
     * none, so a node with only that still accepts any address until the switch. Absent from a server before 2026-09-27.
     */
    named?: boolean;
    /**
     * Addresses offered to confirm with one tap. From a server with the guard, only ever the one Settings is open at
     * (sent as `host`), with the count of apps that reached the node there (apps/server engine/address-offers.ts). A
     * server from before it lists every address apps reached this node at while it knew none of its own.
     */
    unconfirmed: AddressSighting[];
    /** Addresses apps reached it at that are not offered with one tap, and why. Absent from a server before the guard. */
    heldBack?: HeldBackAddress[];
    /** Apps that signed in the old format, bound to no community. */
    oldApps: { today: number; busiestDay: number };
    /** The day (UTC) old apps stop working here, or null when they already don't. */
    unboundSignaturesUntil: string | null;
    unboundSignaturesAccepted: boolean;
    /**
     * Where the community lives now, as /api/community/info says it: its live BeanPool name, else the first of its
     * published addresses; null with none. Absent from a server before 2026-09-28 (lost-name L4).
     */
    primaryAddress?: string | null;
    /**
     * Members' apps that signed for any of its former BeanPool names, today and on the busiest day of the last 7: the
     * members still to move. Absent from a server before 2026-09-28.
     */
    formerApps?: { today: number; busiestDay: number };
}

/**
 * Each call sends the host Settings reaches the node at (`host`): the only address the node offers with one tap, unless
 * the directory it holds lists it as a community's, which only the node knows (apps/server routes/app-addresses.ts).
 */
async function appAddressesCall(nodeUrl: string, path: string, init: RequestInit): Promise<AppAddressesReport> {
    const host = audienceOf(nodeUrl);
    const res = await fetch(resolveNodeApiUrl(nodeUrl, path, host ? { host } : undefined), init);
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

export type SignOutEverywhereResult = { ok: true; breakGlassCodeRetired: boolean } | { ok: false; message: string };

/**
 * "Sign out everywhere" for the person signed in to this node's Settings with their key (POST auth/revoke-all, same
 * origin, the session cookie and its CSRF token): the node ends every Settings session of theirs, on every computer and
 * phone, and retires a break-glass code one of those sessions made. Names nobody in the body, so it can only ever be the
 * caller's own key. Never claims success unless the node said so.
 */
export async function signOutEverywhere(): Promise<SignOutEverywhereResult> {
    let res: Response;
    try {
        res = await fetch('/api/local/admin/auth/revoke-all', {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: buildAdminHeaders(),
            body: '{}',
        });
    } catch {
        return { ok: false, message: 'Could not reach the node, so you may still be signed in elsewhere. Check the connection and try again.' };
    }
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (res.ok && body.success === true) return { ok: true, breakGlassCodeRetired: body.breakGlassCodeRetired === true };
    const said = typeof body.error === 'string' && body.error ? body.error : null;
    if (res.status === 401) return { ok: false, message: said ? `${said}. Sign in again, then try once more.` : 'Your sign-in here has already ended. Sign in again, then try once more.' };
    return { ok: false, message: said ?? `The node did not sign you out (${res.status}). Nothing changed.` };
}
