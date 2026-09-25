/**
 * Settings, Deep Links, Root Redirect, Version, Node Config routes.
 */

import Router from '@koa/router';
import { getVersion } from '../version.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'node:child_process';
import {
    getNodeConfig, updateNodeConfig, getDirectoryInfo, exportLedgerAudit,
    getNodeRole, getMemberStats, type NodeConfig,
} from '../state-engine.js';
import {
    getLocalConfig, saveLocalConfig, updateLocalConfig,
    getThresholds, updateThresholds, DEFAULT_THRESHOLDS,
    getGatewayConfig, isBreakGlassMode,
} from '../config/local-config.js';
import { consumeHandshakeToken, validateAdminSession } from '../admin-key-auth.js';
import { generateTotpSecret, generateTotpCode, verifyTotpCode, generateBackupCodes, generateOtpauthUri, hashBackupCode } from '../totp.js';
import { issue2faSessionToken, requireAdminRole, requireCurrentSecondFactor, type AdminRole } from '../admin-auth.js';
import qrcode from 'qrcode';
import { initDirectoryPublisher, pushDirectoryNow, NOT_LISTED_MESSAGE } from '../services/directory-publisher.js';
import { renderInviteTrampoline } from './invite-trampoline.js';
import { useAppDocumentPolicy, useDocumentPolicy } from '../app-document-csp.js';
import type { RouteDeps } from './types.js';
import { PROTOCOL_CONSTANTS } from '@beanpool/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, '../..');
const resolveServerPath = (subpath: string): string => {
    const local = path.resolve(subpath);
    if (fs.existsSync(local)) return local;
    return path.join(SERVER_ROOT, subpath);
};
const PUBLIC_DIR = resolveServerPath('public');

export function createSettingsRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth, rateLimit } = deps;
    // Who may do what: see OWNER_ONLY in routes/community.ts. Owner-only here: turning 2FA on or off.
    const OWNER_ONLY: readonly AdminRole[] = ['owner'];
    const OWNER_OR_ADMIN: readonly AdminRole[] = ['owner', 'admin'];

// ===================== UNIVERSAL DEEP LINKS (AASA / ASSETLINKS) =====================
// Apple App Site Association
const handleAppleAppSiteAssociation = async (ctx: any) => {
    // IMPORTANT: Set APPLE_TEAM_ID in your .env to the 10-character Team ID of the new Apple Developer Account.
    // Failing to do so will break Universal Links (deep linking) for the iOS app.
    const teamId = process.env.APPLE_TEAM_ID || '485XM2R33S'; // Fallback to original Assignor Team ID
    const bundleId = 'org.beanpool.pillar';

    ctx.type = 'application/json';
    ctx.body = {
        applinks: {
            details: [
                {
                    appIDs: [`${teamId}.${bundleId}`],
                    components: [
                        {
                            "/": "/",
                            "?": { "invite": "*" },
                            "comment": "Match invite links with query parameters"
                        },
                        {
                            "/": "/app*",
                            "comment": "Match legacy app paths"
                        }
                    ]
                }
            ]
        }
    };
};

router.get('/.well-known/apple-app-site-association', handleAppleAppSiteAssociation);
router.get('/apple-app-site-association', handleAppleAppSiteAssociation);

// Android App Links
router.get('/.well-known/assetlinks.json', async (ctx) => {
    // Android verifies App Links against the cert the INSTALLED app is signed with.
    // Because we distribute via Google Play as an App Bundle, Google re-signs with the
    // Play "app signing key" — so THAT fingerprint (not the upload key) is what phones
    // check. Publishing only the upload key silently fails verification and sends invite
    // links to the browser instead of the app. We publish BOTH: the Play app-signing key
    // (required for Play installs) and the upload key (used by internal/direct-install
    // builds), plus any extra comma-separated fingerprints supplied via env.
    const PLAY_APP_SIGNING_SHA256 = '46:AA:D0:CB:A8:9D:1F:E7:EF:F0:60:99:77:CE:06:5D:85:DD:7E:AC:13:57:D4:48:97:EC:70:AF:B2:02:6C:81';
    const UPLOAD_KEY_SHA256 = 'FA:55:52:D6:8C:4A:D6:19:2F:AD:A6:A7:78:39:B4:E8:4D:50:FE:E9:FD:6C:C5:DF:6B:0F:51:E7:CB:DC:03:2B';
    const envShas = (process.env.ANDROID_CERT_SHA256 || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const sha256Fingerprints = [...new Set([PLAY_APP_SIGNING_SHA256, UPLOAD_KEY_SHA256, ...envShas])];
    const packageName = 'org.beanpool.pillar';

    ctx.type = 'application/json';
    ctx.body = [
        {
            relation: ["delegate_permission/common.handle_all_urls"],
            target: {
                namespace: "android_app",
                package_name: packageName,
                sha256_cert_fingerprints: sha256Fingerprints
            }
        }
    ];
});

// ===================== SETTINGS PAGE =====================

router.get(['/settings', '/settings/(.*)'], async (ctx, next) => {
    // If request has a file extension (e.g. .js, .css, .png) and is under /settings/, let static middleware handle it
    if (ctx.path !== '/settings' && ctx.path !== '/settings/' && path.extname(ctx.path)) {
        return next();
    }
    // The Settings UI and its sign-in pages run inline scripts (app-document-csp.ts).
    useDocumentPolicy(ctx);

    // 1. Deep-link Handshake Token Exchange (phone button flow)
    const token = ctx.query.token as string | undefined;
    if (token) {
        const exchangeRes = consumeHandshakeToken(token);
        if (exchangeRes.ok && exchangeRes.sessionId) {
            ctx.cookies.set('admin_session', exchangeRes.sessionId, {
                httpOnly: true,
                sameSite: 'lax',
                maxAge: 12 * 3600 * 1000,
                path: '/',
            });
            ctx.redirect('/settings');
            return;
        } else {
            ctx.status = exchangeRes.replay ? 401 : (exchangeRes.expired ? 401 : 400);
            ctx.type = 'text/html';
            ctx.body = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Sign-In Failed — BeanPool</title></head><body style="background:#0f172a;color:#f8fafc;font-family:system-ui,sans-serif;padding:3rem;text-align:center;"><main role="alert"><h1 style="font-size:1.5rem;font-weight:600;margin-bottom:1rem;"><span aria-hidden="true">⚠️</span> Sign-In Failed</h1><p style="color:#94a3b8;max-width:480px;margin:0 auto 1.5rem;line-height:1.5;">${exchangeRes.error || 'The authentication token is invalid or has expired.'}</p><a href="/settings" style="display:inline-block;background:#3b82f6;color:#ffffff;padding:0.6rem 1.2rem;border-radius:8px;text-decoration:none;font-weight:500;">Return to Settings</a></main></body></html>`;
            return;
        }
    }

    // 2. Break-glass mode enforcement: settings is restricted to enrolled key sessions
    if (isBreakGlassMode()) {
        const rawToken =
            (ctx.cookies && typeof ctx.cookies.get === 'function' ? ctx.cookies.get('admin_session') : null) ||
            (typeof ctx.get === 'function' ? ctx.get('x-admin-session') : null) ||
            ctx.request?.headers?.['x-admin-session'] ||
            ctx.headers?.['x-admin-session'];
        const sessionToken = Array.isArray(rawToken) ? rawToken[0] : (rawToken ? String(rawToken) : null);

        const sessionRes = sessionToken ? validateAdminSession(sessionToken) : null;
        const hasValidSession = sessionRes?.valid;
        if (!hasValidSession) {
            ctx.status = 403;
            ctx.type = 'text/html';
            const isExpired = sessionRes?.expired || sessionRes?.idleTimeout || sessionRes?.hardLimit;
            const heading = isExpired ? 'Admin Session Expired' : 'Break-Glass Mode Active';
            const message = isExpired
                ? (sessionRes?.error || 'Your admin session has expired. Please sign in again with your key.')
                : 'Settings access is restricted to enrolled key sessions. Password access is disabled except for key enrolment.';
            ctx.body = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${heading} — BeanPool</title></head><body style="background:#0f172a;color:#f8fafc;font-family:system-ui,sans-serif;padding:3rem;text-align:center;"><main role="alert"><h1 style="font-size:1.5rem;font-weight:600;margin-bottom:1rem;"><span aria-hidden="true">${isExpired ? "⏱️" : "🔒"}</span> ${heading}</h1><p style="color:#94a3b8;max-width:480px;margin:0 auto 1.5rem;line-height:1.5;">${message}</p><a href="/settings" style="display:inline-block;background:#3b82f6;color:#ffffff;padding:0.6rem 1.2rem;border-radius:8px;text-decoration:none;font-weight:500;">Sign In with Key</a></main></body></html>`;
            return;
        }
    }

    const managerPath = resolveServerPath('public/settings/index.html');
    const publicPath = resolveServerPath('public/settings.html');
    const staticPath = resolveServerPath('static/settings.html');
    const resolvedPath = fs.existsSync(managerPath) ? managerPath : (fs.existsSync(publicPath) ? publicPath : staticPath);

    if (fs.existsSync(resolvedPath)) {
        ctx.type = 'html';
        ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        ctx.body = fs.createReadStream(resolvedPath);
    } else {
        ctx.status = 404;
        ctx.body = 'Settings page not found. Ensure manager build or settings.html exists.';
    }
});

router.get('/settings-legacy', async (ctx) => {
    useDocumentPolicy(ctx);
    const staticPath = resolveServerPath('static/settings.html');
    const publicPath = resolveServerPath('public/settings.html');
    const resolvedPath = fs.existsSync(staticPath) ? staticPath : publicPath;
    if (fs.existsSync(resolvedPath)) {
        ctx.type = 'html';
        ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        ctx.body = fs.createReadStream(resolvedPath);
    } else {
        ctx.status = 404;
        ctx.body = 'Legacy settings page not found.';
    }
});

router.get('/settings.js', async (ctx) => {
    const publicPath = resolveServerPath('public/settings.js');
    const staticPath = resolveServerPath('static/settings.js');
    const resolvedPath = fs.existsSync(publicPath) ? publicPath : staticPath;

    if (fs.existsSync(resolvedPath)) {
        ctx.type = 'application/javascript';
        ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        ctx.body = fs.createReadStream(resolvedPath);
    } else {
        ctx.status = 404;
        ctx.body = '// settings.js not found';
    }
});


// ===================== ROOT REDIRECT =====================
// Redirect root to the PWA app — existing users auto-login via IndexedDB identity
// Preserve query params (e.g. ?invite=BP-XXXX-XXXX) for invite URL flow
router.get('/', async (ctx) => {
    // An invite link opened on a device WITHOUT the app installed lands here (an
    // installed app intercepts the https link via verified App/Universal Links
    // first and never reaches the server). Serve the install trampoline instead
    // of dropping the invitee into the web PWA — which would redeem and burn
    // their single-use code. This page is plain HTML from THIS server, not the
    // PWA bundle; it creates no identity and redeems nothing.
    if (ctx.query.invite) {
        const webJoin = getGatewayConfig().features?.servePwa !== false;
        useDocumentPolicy(ctx); // its install steps are an inline script
        ctx.type = 'html';
        ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        ctx.body = renderInviteTrampoline({ webJoin });
        return;
    }
    const query = ctx.querystring ? `?${ctx.querystring}` : '';
    ctx.redirect(`/app${query}`);
});

// ===================== NODE CONFIG =====================

// Public read (PUBLIC_READ_EXACT), so it names each field it returns and never passes the stored config through:
// that also holds the public-address agent's state (publicAddress: the Cloudflare tunnel token, the registrar
// contact), which no reader of this route uses. Who reads what:
//   - serviceRadius: the web app's map and marketplace, the phone's map (unsigned), the manager, static/settings.js
//   - the directory switches, push interval and last push: the manager's Node Identity screen and static/settings.js
// The operator's public address is read from the admin route /api/local/admin/public-address/status.
function publicNodeConfig(config: NodeConfig) {
    const r = config.serviceRadius;
    return {
        serviceRadius: r && typeof r === 'object' ? { lat: r.lat, lng: r.lng, radiusKm: r.radiusKm } : r,
        publishLocation: config.publishLocation,
        publishMembers: config.publishMembers,
        publishContacts: config.publishContacts,
        publishHealth: config.publishHealth,
        directoryPushIntervalHours: config.directoryPushIntervalHours,
        lastDirectoryPush: config.lastDirectoryPush,
    };
}

router.get('/api/node/config', async (ctx) => {
    ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    ctx.body = publicNodeConfig(getNodeConfig());
});

router.post('/api/local/admin/node/config', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) {
        console.log("Auth failed for updateNodeConfig");
        return;
    }
    const { publishLocation, publishMembers, publishContacts, publishHealth, serviceRadius, directoryPushIntervalHours } = (ctx as any).requestBody || {};
    console.log("Updating node config:", { publishLocation, publishMembers, publishContacts, publishHealth, serviceRadius, directoryPushIntervalHours });
    ctx.body = updateNodeConfig({ publishLocation, publishMembers, publishContacts, publishHealth, serviceRadius, directoryPushIntervalHours });
    
    // Re-initialize the publisher with the new interval
    if (directoryPushIntervalHours !== undefined) {
        initDirectoryPublisher();
    }
});

router.post('/api/local/admin/directory/push', async (ctx) => {
    // checkAdminAuth has answered (401, or 403 for a moderator's session): keep its status.
    if (!(await checkAdminAuth(ctx as any))) return;
    const result = await pushDirectoryNow();
    if (!result.success) {
        // Not listed by the profile's switch (the global node) is the node's setting, not a failure.
        ctx.status = result.error === NOT_LISTED_MESSAGE ? 409 : 500;
    }
    ctx.body = result;
});

// Local directory info endpoint (used by settings preview)
// No CORS headers - should only be called from same origin (admin PWA)
router.get('/api/directory/info', async (ctx) => {
    const info = getDirectoryInfo();
    if (!info) {
        ctx.status = 403;
        ctx.body = { error: 'This node has opted out of the directory' };
        return;
    }
    ctx.body = info;
});


// ===================== VERSION & UPDATES =====================

// Version now lives in ../version.js so /api/version and /api/community/health
// cannot drift apart again.

// Get git commit hash
function getCommitHash(): string {
    try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch { return 'unknown'; }
}

// ===================== BACKGROUND UPDATE CHECKER =====================
let cachedUpdateInfo: {
    updateAvailable: boolean;
    latestVersion: string;
    releaseNotes: string;
    releaseUrl: string;
    publishedAt: string;
    lastChecked: string;
} | null = null;

async function backgroundUpdateCheck() {
    try {
        const response = await fetch(
            'https://api.github.com/repos/beanpool-org/beanpool/releases/latest',
            { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'BeanPool-Node' } }
        );
        if (response.ok) {
            const release = await response.json() as any;
            const latestVersion = (release.tag_name || '').replace(/^v/, '');
            const currentVersion = getVersion();
            cachedUpdateInfo = {
                updateAvailable: semverGreater(latestVersion, currentVersion),
                latestVersion,
                releaseNotes: release.body || '',
                releaseUrl: release.html_url || '',
                publishedAt: release.published_at || '',
                lastChecked: new Date().toISOString(),
            };
        } else {
            // Fallback to tags
            const tagsResponse = await fetch(
                'https://api.github.com/repos/beanpool-org/beanpool/tags?per_page=1',
                { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'BeanPool-Node' } }
            );
            if (tagsResponse.ok) {
                const tags = await tagsResponse.json() as any[];
                const latestTag = tags[0]?.name?.replace(/^v/, '') || '';
                const currentVersion = getVersion();
                cachedUpdateInfo = {
                    updateAvailable: semverGreater(latestTag, currentVersion),
                    latestVersion: latestTag,
                    releaseNotes: '',
                    releaseUrl: '',
                    publishedAt: '',
                    lastChecked: new Date().toISOString(),
                };
            }
        }
        if (cachedUpdateInfo?.updateAvailable) {
            console.log(`[Update] New version available: v${cachedUpdateInfo.latestVersion} (current: v${getVersion()})`);
        }
    } catch (e: any) {
        console.log(`[Update] Background check failed: ${e.message || 'unknown error'}`);
    }
}

// Run initial check after 30s startup delay, then every 6 hours (unref'd so timers don't block process exit)
setTimeout(() => backgroundUpdateCheck(), 30000).unref();
setInterval(() => backgroundUpdateCheck(), 6 * 60 * 60 * 1000).unref();

router.get('/api/version', (ctx) => {
    ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    ctx.body = {
        version: getVersion(),
        commit: getCommitHash(),
        buildTime: new Date().toISOString(),
        node: process.env.CF_RECORD_NAME || 'local',
        // Include cached update info if available
        ...(cachedUpdateInfo ? {
            updateAvailable: cachedUpdateInfo.updateAvailable,
            latestVersion: cachedUpdateInfo.latestVersion,
            lastUpdateCheck: cachedUpdateInfo.lastChecked,
        } : {}),
    };
});

// ===================== THRESHOLDS API =====================

router.post('/api/admin/thresholds', async (ctx) => {
    const { password, totpCode, ...updates } = (ctx as any).requestBody || {};
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!requireAdminRole(ctx, OWNER_OR_ADMIN, 'Only an owner or admin of this node can change its thresholds')) return;
    // Only allow known threshold keys
    const allowed = Object.keys(DEFAULT_THRESHOLDS);
    const filtered: Record<string, number> = {};
    for (const [k, v] of Object.entries(updates)) {
        if (allowed.includes(k) && typeof v === 'number') {
            filtered[k] = v;
        }
    }
    const result = updateThresholds(filtered);
    ctx.body = { thresholds: result };
});

router.post('/api/admin/thresholds/get', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    ctx.body = { thresholds: getThresholds(), defaults: DEFAULT_THRESHOLDS };
});

function semverGreater(a: string, b: string): boolean {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) > (pb[i] || 0)) return true;
        if ((pa[i] || 0) < (pb[i] || 0)) return false;
    }
    return false;
}

router.post('/api/admin/check-update', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!requireAdminRole(ctx, OWNER_OR_ADMIN, 'Only an owner or admin of this node can check for updates')) return;
    try {
        const response = await fetch(
            'https://api.github.com/repos/beanpool-org/beanpool/releases/latest',
            { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'BeanPool-Node' } }
        );
        if (response.ok) {
            const release = await response.json() as any;
            const latestVersion = (release.tag_name || '').replace(/^v/, '');
            const currentVersion = getVersion();
            const isNewer = semverGreater(latestVersion, currentVersion);
            ctx.body = {
                currentVersion,
                latestVersion,
                updateAvailable: isNewer,
                releaseUrl: release.html_url || '',
                releaseNotes: release.body || '',
                publishedAt: release.published_at || '',
            };
        } else {
            // No releases yet — check tags instead
            const tagsResponse = await fetch(
                'https://api.github.com/repos/beanpool-org/beanpool/tags?per_page=1',
                { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'BeanPool-Node' } }
            );
            if (tagsResponse.ok) {
                const tags = await tagsResponse.json() as any[];
                const latestTag = tags[0]?.name?.replace(/^v/, '') || '';
                const currentVersion = getVersion();
                ctx.body = {
                    currentVersion,
                    latestVersion: latestTag,
                    updateAvailable: semverGreater(latestTag, currentVersion),
                    releaseUrl: '',
                    releaseNotes: '',
                    publishedAt: '',
                };
            } else {
                // Return Bad Gateway if upstream update source (GitHub API) is unreachable
                ctx.status = 502;
                ctx.body = {
                    currentVersion: getVersion(),
                    latestVersion: '',
                    updateAvailable: false,
                    error: 'Could not reach GitHub',
                };
            }
        }
    } catch (e: any) {
        // Return Internal Server Error on unhandled update check exceptions
        ctx.status = 500;
        ctx.body = {
            currentVersion: getVersion(),
            latestVersion: '',
            updateAvailable: false,
            error: e.message || 'Failed to check',
        };
    }
});

// ===================== TOTP 2FA ENDPOINTS (#135) =====================

/**
 * GET /api/local/admin/2fa/status — Returns current 2FA status (enabled/disabled).
 * Same auth as every admin route. This used to take the password alone, so the UI could learn whether 2FA was on
 * before it had a code; it no longer needs to: with 2FA on, the password alone gets 401 { totpRequired: true },
 * which says exactly that. The password alone also let a caller clear the password brake between wrong codes.
 */
router.get('/api/local/admin/2fa/status', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!requireAdminRole(ctx, OWNER_OR_ADMIN, 'Only an owner or admin of this node can read its 2FA status')) return;
    const config = getLocalConfig();
    ctx.body = {
        success: true,
        totpEnabled: !!config.totpEnabled,
        hasSecret: !!config.totpSecret,
        pendingSetup: !!config.totpPendingSecret,
        backupCodesRemaining: config.totpBackupCodesHashes ? config.totpBackupCodesHashes.length : 0,
    };
});

/**
 * POST /api/local/admin/2fa/setup — Generates a new secret + QR code + backup codes for setup.
 * Does NOT disarm existing active 2FA or overwrite totpSecret until verified via /2fa/verify.
 */
router.post('/api/local/admin/2fa/setup', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!requireAdminRole(ctx, OWNER_ONLY, 'Only an owner of this node can set up 2FA')) return;
    const config = getLocalConfig();
    const secret = generateTotpSecret();
    const backupCodes = generateBackupCodes(8);
    const backupCodesHashes = backupCodes.map(hashBackupCode);
    const label = config.communityName || config.callsign || 'Admin';
    const otpauthUri = generateOtpauthUri(secret, label, 'BeanPool');

    try {
        const qrDataUrl = await qrcode.toDataURL(otpauthUri);
        // #135 CR: Stash in totpPendingSecret and SHA-256 hashes so active 2FA is NOT disarmed during re-setup.
        updateLocalConfig({
            totpPendingSecret: secret,
            totpPendingBackupCodesHashes: backupCodesHashes,
        });

        // #135 CR: Return formattedSecret (e.g. "ABCD EFGH IJKL MNOP") for manual entry legibility.
        const formattedSecret = secret.match(/.{1,4}/g)?.join(' ') || secret;

        ctx.body = {
            success: true,
            secret,
            formattedSecret,
            qrDataUrl,
            otpauthUri,
            backupCodes,
        };
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { success: false, error: e?.message || 'Failed to generate QR code' };
    }
});

/**
 * POST /api/local/admin/2fa/verify — Verifies the setup code (`code` or `totpCode`, from the NEW authenticator) and
 * makes the secret from /2fa/setup the active one.
 *
 * While 2FA is already on this replaces the authenticator, so it asks for the same proof as turning 2FA off: a code
 * that is right now from the CURRENT authenticator, or a backup code, in `currentCode` or X-Admin-TOTP
 * (requireCurrentSecondFactor: a 2FA session or key session alone is not enough, and wrong codes are braked).
 * Otherwise anyone holding a stolen owner session could enrol their own authenticator, then use it to turn 2FA off.
 *
 * With 2FA on and no setup in progress, `code` is checked against the active authenticator, under the same brake,
 * and a right one only issues a 2FA session: nothing changes.
 */
router.post('/api/local/admin/2fa/verify', async (ctx) => {
    if (!rateLimit(ctx)) return;
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!requireAdminRole(ctx, OWNER_ONLY, 'Only an owner of this node can turn 2FA on')) return;
    const body = (ctx as any).requestBody || (ctx.request as any)?.body || {};
    const code = body.code || body.totpCode;
    if (!code) {
        ctx.status = 400;
        ctx.body = { success: false, error: 'code is required' };
        return;
    }

    const config = getLocalConfig();
    const alreadyOn = !!(config.totpEnabled && config.totpSecret);
    if (!config.totpPendingSecret) {
        if (!alreadyOn) {
            ctx.status = 400;
            ctx.body = { success: false, error: 'No 2FA setup in progress — call /2fa/setup first' };
            return;
        }
        if (!(await requireCurrentSecondFactor(ctx, code, 'to confirm'))) return;
        const tfaSessionToken = issue2faSessionToken();
        ctx.set('X-Admin-2FA-Session', tfaSessionToken);
        ctx.body = { success: true, message: '2FA is already on', totpEnabled: true, tfaSessionToken, sessionToken: tfaSessionToken };
        return;
    }
    const secretToVerify = config.totpPendingSecret;

    const valid = verifyTotpCode(String(code).trim(), secretToVerify);
    if (!valid) {
        ctx.status = 400;
        ctx.body = { success: false, error: 'Invalid 6-digit 2FA code — check authenticator app time sync' };
        return;
    }

    if (alreadyOn) {
        const current = body.currentCode
            || (typeof (ctx as any).get === 'function' ? (ctx as any).get('x-admin-totp') : null);
        if (!(await requireCurrentSecondFactor(ctx, current, 'from the authenticator you are replacing, to replace it'))) return;
        // The wait for the brake may have let a concurrent verify or disable through: promote only what this
        // request checked.
        if (getLocalConfig().totpPendingSecret !== secretToVerify) {
            ctx.status = 409;
            ctx.body = { success: false, error: '2FA setup changed while this was being checked — start again' };
            return;
        }
    }

    // Promote pending secret & backup code hashes to active configuration
    // #135 CR2 fix: Check array length (Boolean([]) is truthy in JS, so [] would overwrite active hashes!)
    const activeBackupHashes = (config.totpPendingBackupCodesHashes && config.totpPendingBackupCodesHashes.length > 0)
        ? config.totpPendingBackupCodesHashes
        : (config.totpBackupCodesHashes || []);

    updateLocalConfig({
        totpSecret: secretToVerify,
        totpBackupCodesHashes: activeBackupHashes,
        totpEnabled: true,
        totpPendingSecret: null,
        totpPendingBackupCodesHashes: [],
    });
    const tfaSessionToken = issue2faSessionToken();
    ctx.set('X-Admin-2FA-Session', tfaSessionToken);
    console.log(alreadyOn
        ? '🔒 [AdminAuth] TOTP 2FA authenticator replaced (current code checked)'
        : '🔒 [AdminAuth] TOTP 2FA successfully enabled for admin account');
    ctx.body = {
        success: true,
        message: '2FA enabled successfully',
        totpEnabled: true,
        tfaSessionToken,
        sessionToken: tfaSessionToken,
    };
});

/**
 * POST /api/local/admin/2fa/disable — Disables 2FA. Owner only, and only with a code that is right NOW (from the
 * authenticator, or a backup code) in `code`, `totpCode` or X-Admin-TOTP: a 2FA session from earlier, or a key
 * session, is not enough (requireCurrentSecondFactor says why).
 */
router.post('/api/local/admin/2fa/disable', async (ctx) => {
    if (!rateLimit(ctx)) return;
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!requireAdminRole(ctx, OWNER_ONLY, 'Only an owner of this node can turn 2FA off')) return;
    const body = (ctx as any).requestBody || (ctx.request as any)?.body || {};
    const code = body.code || body.totpCode
        || (typeof (ctx as any).get === 'function' ? (ctx as any).get('x-admin-totp') : null);
    if (!(await requireCurrentSecondFactor(ctx, code))) return;
    updateLocalConfig({
        totpEnabled: false,
        totpSecret: null,
        totpBackupCodesHashes: [],
        totpPendingSecret: null,
        totpPendingBackupCodesHashes: [],
    });
    console.log('🔓 [AdminAuth] TOTP 2FA disabled for admin account');
    ctx.body = { success: true, message: '2FA disabled successfully', totpEnabled: false };
});

// NOTE: /api/admin/update (signal-file approach) has been removed.
// Updates are notification-only — admin runs `docker compose pull && docker compose up -d` manually.

// ===================== MIDDLEWARE =====================

// Serve PWA at /app
router.get('/app', async (ctx) => {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
        useAppDocumentPolicy(ctx);
        ctx.type = 'html';
        ctx.body = fs.createReadStream(indexPath);
    }
});

    return router;
}
