/**
 * Settings, Deep Links, Root Redirect, Version, Node Config routes.
 */

import Router from '@koa/router';
import { getVersion, getCommit } from '../version.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import {
    getNodeConfig, updateNodeConfig, getDirectoryInfo, exportLedgerAudit,
    getNodeRole, getMemberStats, isNodeMember, type NodeConfig,
} from '../state-engine.js';
import { isPrivatePreview } from '../config/private-preview.js';
import {
    getLocalConfig, saveLocalConfig, updateLocalConfig,
    getThresholds, updateThresholds, DEFAULT_THRESHOLDS, thresholdProblem,
    getGatewayConfig, isBreakGlassMode, isPasswordRetired,
} from '../config/local-config.js';
import { consumeHandshakeToken, PHONE_HANDOFF_IDLE_TTL_MS, validateAdminSession, setAdminSessionCookie, restampPasswordSession } from '../admin-key-auth.js';
import { generateTotpSecret, generateTotpCode, verifyTotpCode, useTotpCode, generateBackupCodes, generateOtpauthUri, hashBackupCode } from '../totp.js';
import { issue2faSessionToken, requireAdminRole, requireCurrentSecondFactor, PASSWORD_RETIRED_CODE, type AdminRole } from '../admin-auth.js';
import { logger } from '../logger.js';
import qrcode from 'qrcode';
import { initDirectoryPublisher, pushDirectoryNow, NOT_LISTED_MESSAGE } from '../services/directory-publisher.js';
import { getConfiguredSwitches, setSwitchOverride } from '../config/node-profile.js';
import { getDoor, setDoor, doorSettingRefusal, type CommunityDoor } from '../config/door.js';
import { HealthError, healthSummary, readHealthAccessLog, setHealthSettings } from '../engine/community-health.js';
import { KnownFloorError, knownFloorSettings, setKnownFloorSettings, knownFloorExceptions, readKnownFloorLog, setKnownFloorException, knownFloorForMember } from '../config/known-floor.js';
import { isDirectoryPushInterval, MAX_DIRECTORY_PUSH_INTERVAL_HOURS } from '../config/community-settings.js';
import { renderInviteTrampoline } from './invite-trampoline.js';
import { useAppDocumentPolicy, useDocumentPolicy } from '../app-document-csp.js';
import { countWebAppPageLoad } from '../engine/web-visits.js';
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

/** Text into the HTML of the sign-in error pages below. Every value is a fixed server string today; escaped anyway. */
function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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
    // The manager (the React Settings) and these error pages run no inline script: the web app's strict policy
    // (app-document-csp.ts, Fable's web review M2). Only the old static settings.html, served below when no manager
    // build is there, keeps the older one.
    useAppDocumentPolicy(ctx);

    // 1. Deep-link Handshake Token Exchange (an older phone app's Manage button): a page in the phone's in-app
    //    browser, so the phone hand-off's short idle limit (admin-key-auth.ts PHONE_HANDOFF_IDLE_TTL_MS).
    const token = ctx.query.token as string | undefined;
    if (token) {
        const exchangeRes = consumeHandshakeToken(token, Date.now(), { idleTtlMs: PHONE_HANDOFF_IDLE_TTL_MS });
        if (exchangeRes.ok && exchangeRes.sessionId) {
            setAdminSessionCookie(ctx, exchangeRes.sessionId);
            ctx.redirect('/settings');
            return;
        } else {
            ctx.status = exchangeRes.replay ? 401 : (exchangeRes.expired ? 401 : 400);
            ctx.type = 'text/html';
            ctx.body = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Sign-In Failed — BeanPool</title></head><body style="background:#0f172a;color:#f8fafc;font-family:system-ui,sans-serif;padding:3rem;text-align:center;"><main role="alert"><h1 style="font-size:1.5rem;font-weight:600;margin-bottom:1rem;"><span aria-hidden="true">⚠️</span> Sign-In Failed</h1><p style="color:#94a3b8;max-width:480px;margin:0 auto 1.5rem;line-height:1.5;">${escapeHtml(exchangeRes.error || 'The authentication token is invalid or has expired.')}</p><a href="/settings" style="display:inline-block;background:#3b82f6;color:#ffffff;padding:0.6rem 1.2rem;border-radius:8px;text-decoration:none;font-weight:500;">Return to Settings</a></main></body></html>`;
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
                ? escapeHtml(sessionRes?.error || 'Your admin session has expired. Please sign in again with your key.')
                : 'Settings access is restricted to enrolled key sessions. Password access is disabled except for key enrolment.';
            ctx.body = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${heading} — BeanPool</title></head><body style="background:#0f172a;color:#f8fafc;font-family:system-ui,sans-serif;padding:3rem;text-align:center;"><main role="alert"><h1 style="font-size:1.5rem;font-weight:600;margin-bottom:1rem;"><span aria-hidden="true">${isExpired ? "⏱️" : "🔒"}</span> ${heading}</h1><p style="color:#94a3b8;max-width:480px;margin:0 auto 1.5rem;line-height:1.5;">${message}</p><a href="/settings" style="display:inline-block;background:#3b82f6;color:#ffffff;padding:0.6rem 1.2rem;border-radius:8px;text-decoration:none;font-weight:500;">Sign In with Key</a></main></body></html>`;
            return;
        }
    }

    const managerPath = resolveServerPath('public/settings/index.html');
    const publicPath = resolveServerPath('public/settings.html');
    const staticPath = resolveServerPath('static/settings.html');
    const resolvedPath = fs.existsSync(managerPath) ? managerPath : (fs.existsSync(publicPath) ? publicPath : staticPath);
    // The old page runs inline handlers and unpkg's Leaflet.
    if (resolvedPath !== managerPath) useDocumentPolicy(ctx);

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
//   - acceptKnocks and door (withKnockSetting, below): the manager's Node Identity screen and People & Safety → Invites
// The operator's public address is read from the admin route /api/local/admin/public-address/status.
function publicNodeConfig(config: NodeConfig) {
    const r = config.serviceRadius;
    return {
        serviceRadius: r && typeof r === 'object' ? { lat: r.lat, lng: r.lng, radiusKm: r.radiusKm } : r,
        publishLocation: config.publishLocation,
        publishMembers: config.publishMembers,
        publishContactEmail: config.publishContactEmail,
        publishContactPhone: config.publishContactPhone,
        publishHealth: config.publishHealth,
        directoryPushIntervalHours: config.directoryPushIntervalHours,
        lastDirectoryPush: config.lastDirectoryPush,
    };
}

// `acceptKnocks`: whether this community takes "ask to join" requests (G6, D4: on unless the operator turns it off). It is
// the `knocks` profile switch as configured, so it travels with the profile record (config/node-profile.ts), and it
// is said here beside the directory settings because Settings shows them together. Public, like the switch itself in
// /api/community/info; how many requests are waiting is the operator's only (/api/local/admin/knocks).
// `door`: who may invite here (config/door.ts): `members`, `admins`, or `open` where the profile opens the door and takes
// no invites. Public, as `features.door` in /api/community/info is.
function withKnockSetting<T extends object>(config: T): T & { acceptKnocks: boolean; door: ReturnType<typeof getDoor> } {
    return { ...config, acceptKnocks: getConfiguredSwitches().knocks, door: getDoor() };
}

router.get('/api/node/config', async (ctx) => {
    ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    const config = publicNodeConfig(getNodeConfig());
    // A private preview (config/private-preview.ts): the phone map reads this unsigned for the community's service area
    // (apps/native map.tsx, which can't change here), so it is open, and a reader who is no member here (as that read
    // is) gets the area alone: the place the community serves, no member's anything, and none of the other settings.
    if (isPrivatePreview() && !isNodeMember(ctx.state.actor as string | undefined)) {
        ctx.body = { serviceRadius: config.serviceRadius ?? null };
        return;
    }
    ctx.body = withKnockSetting(config);
});

// The known floor (config/known-floor.ts, community modes slice 4): every owner and admin reads the settings, the
// exceptions and the log; only an owner changes the dial, the known floor or the cap; an owner or admin sets one member's
// exception. Every change is a line in the log.
/** The owner's or admin's own key behind this session, or null: the node password and an automation token name nobody. */
function ownKeySessionActor(ctx: any): string | null {
    const actor = ctx.state?.actor;
    return !ctx.state?.automationTokenId && typeof actor === 'string' && /^[0-9a-f]{64}$/.test(actor) ? actor : null;
}

function knownFloorRefusal(ctx: any, e: unknown): void {
    if (!(e instanceof KnownFloorError)) throw e;
    ctx.status = e.status;
    ctx.body = { error: e.message, code: e.code };
}

router.get('/api/local/admin/known-floor', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    ctx.body = { ...knownFloorSettings(), exceptions: knownFloorExceptions(), log: readKnownFloorLog(100) };
});

router.post('/api/local/admin/known-floor', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!requireAdminRole(ctx, ['owner'], 'Only an owner of this community can change the known floor or the cap.')) return;
    try {
        ctx.body = setKnownFloorSettings((ctx.state as any)?.actor || 'owner:password', (ctx as any).requestBody || {});
    } catch (e) { knownFloorRefusal(ctx, e); }
});

// The Community health panel in Settings (engine/community-health.ts): every owner and admin reads the totals, the two
// lines and who opened the exceptions; only an owner moves the lines. The exceptions themselves open on an admin's phone,
// where the names list is (GET /api/names/health/exceptions, signed with their key, logged).
router.get('/api/local/admin/community-health', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!requireAdminRole(ctx, ['owner', 'admin'], 'Only an owner or admin of this community can open Community health.')) return;
    ctx.set('Cache-Control', 'no-store');
    ctx.body = { ...healthSummary(), log: readHealthAccessLog(100, 'balance'), tradeLog: readHealthAccessLog(100, 'trades') };
});

router.post('/api/local/admin/community-health', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!requireAdminRole(ctx, ['owner'], 'Only an owner of this community can change what the admins see.')) return;
    try {
        ctx.body = setHealthSettings((ctx.state as any)?.actor || 'owner:password', (ctx as any).requestBody || {});
    } catch (e) {
        if (!(e instanceof HealthError)) throw e;
        ctx.status = e.status;
        ctx.body = { error: e.message, code: e.code };
    }
});

// One member's line for the Manager's member screen (owner or admin): confirmed, their exception, the known grant. Never
// their balance.
router.get('/api/local/admin/known-floor/member/:pubkey', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!requireAdminRole(ctx, ['owner', 'admin'], 'Only an owner or admin of this community can see a member\'s known floor.')) return;
    ctx.set('Cache-Control', 'no-store');
    try {
        ctx.body = knownFloorForMember(ctx.params.pubkey, ownKeySessionActor(ctx));
    } catch (e) { knownFloorRefusal(ctx, e); }
});

router.post('/api/local/admin/known-floor/exception', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!requireAdminRole(ctx, ['owner', 'admin'], 'Only an owner or admin of this community can change a member\'s known floor.')) return;
    // One member's credit is money, and nobody sets their own: only an owner's or admin's own key session, which names the
    // person. Never an automation token (it acts as whoever issued it) nor the node password (it names nobody).
    const actor = ownKeySessionActor(ctx);
    if (!actor) {
        ctx.status = 403;
        ctx.body = { error: 'Sign in with your own key to change a member\'s known floor.', code: 'key_session_only' };
        return;
    }
    try {
        ctx.body = setKnownFloorException(actor, (ctx as any).requestBody || {});
    } catch (e) { knownFloorRefusal(ctx, e); }
});

router.post('/api/local/admin/node/config', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) {
        console.log("Auth failed for updateNodeConfig");
        return;
    }
    // `publishContacts`, the old single switch for both contacts, is not read: a page that still sends it turns nothing on.
    const { publishLocation, publishMembers, publishContactEmail, publishContactPhone, publishHealth, serviceRadius, directoryPushIntervalHours, acceptKnocks, door } = (ctx as any).requestBody || {};
    // Only when sent, and only true or false: a Settings page from before G6 doesn't send it, and must not turn it back on.
    if (acceptKnocks !== undefined && typeof acceptKnocks !== 'boolean') {
        ctx.status = 400;
        ctx.body = { error: 'acceptKnocks must be true or false' };
        return;
    }
    // Who may invite (config/door.ts): only when sent, only by an owner (the node password is an owner's), and only a door
    // this node can have; refused before anything in this request is written. An admin runs the community day to day
    // but doesn't decide who may bring people into it (design §5: "an owner can also set each dial").
    if (door !== undefined) {
        if (!requireAdminRole(ctx, ['owner'], 'Only an owner of this community can change who may invite.')) return;
        const refusal = doorSettingRefusal(door);
        if (refusal) {
            ctx.status = refusal.status;
            ctx.body = { error: refusal.error, code: refusal.code };
            return;
        }
    }
    // The contact switches are an owner's choice to publish, so only a real true or false is taken.
    for (const [name, v] of [['publishContactEmail', publishContactEmail], ['publishContactPhone', publishContactPhone]] as const) {
        if (v !== undefined && typeof v !== 'boolean') {
            ctx.status = 400;
            ctx.body = { error: `${name} must be true or false` };
            return;
        }
    }
    // Whole hours up to what the publisher's timer can hold (config/community-settings.ts isDirectoryPushInterval): past
    // it, below zero or a sliver of an hour, the timer fires every millisecond at the directory registry.
    if (directoryPushIntervalHours !== undefined && !isDirectoryPushInterval(directoryPushIntervalHours)) {
        ctx.status = 400;
        ctx.body = { error: `directoryPushIntervalHours must be a whole number of hours from 0 (never) to ${MAX_DIRECTORY_PUSH_INTERVAL_HOURS}` };
        return;
    }
    console.log("Updating node config:", { publishLocation, publishMembers, publishContactEmail, publishContactPhone, publishHealth, serviceRadius, directoryPushIntervalHours, acceptKnocks, door });
    if (typeof acceptKnocks === 'boolean') setSwitchOverride('knocks', acceptKnocks);
    if (door !== undefined && door !== getDoor()) {
        setDoor(door as CommunityDoor);
        // Who changed who may bring people in, for the owners: a member key under a key session, the password otherwise.
        console.log(`🚪 Who may invite is now ${door === 'admins' ? 'only admins' : 'any member'}, set by ${(ctx.state as any)?.actor || 'owner:password'}.`);
    }
    // Only the fields sent. One left out and passed on as undefined would be dropped from the stored object, and the
    // location, member count and health switches read unset as "publish": a request that changed one switch published
    // the member count the community had turned off. Settings sends every field (null clears the service area).
    const sent = Object.fromEntries(Object.entries({ publishLocation, publishMembers, publishContactEmail, publishContactPhone, publishHealth, serviceRadius, directoryPushIntervalHours })
        .filter(([, v]) => v !== undefined));
    // The public fields only, as GET /api/node/config answers: the stored config also holds the tunnel token, and an admin
    // (who may save these switches) must never read it. No caller reads more from this answer than ok or error.
    ctx.body = withKnockSetting(publicNodeConfig(updateNodeConfig(sent)));
    
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

// Local directory info endpoint (used by settings preview): what a push sends, which holds only what the switches publish.
// No CORS headers - should only be called from same origin (admin PWA)
router.get('/api/directory/info', async (ctx) => {
    ctx.body = getDirectoryInfo();
});


// ===================== VERSION & UPDATES =====================

// Version now lives in ../version.js so /api/version and /api/community/health
// cannot drift apart again. So does the commit, asked of git once rather than on every request.

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

// Run initial check after 30s startup delay, then every 6 hours (unref'd so timers don't block process exit).
// DISABLE_UPDATE_CHECK=true turns the background lookup off (the server-suites runner sets it: a test node must never
// ask GitHub, and a slow run used to outlive the 30s delay and trip the suites' "nothing leaves this machine" check).
// Unset, a real node behaves exactly as before. The manual "check for updates" route is unaffected.
if (process.env.DISABLE_UPDATE_CHECK !== 'true') {
    setTimeout(() => backgroundUpdateCheck(), 30000).unref();
    setInterval(() => backgroundUpdateCheck(), 6 * 60 * 60 * 1000).unref();
}

router.get('/api/version', (ctx) => {
    ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    ctx.body = {
        version: getVersion(),
        commit: getCommit(),
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
    // Only allow known threshold keys. A number out of its range (negative, Infinity, a fraction of a day) is refused
    // and nothing is saved; anything that isn't a number (an emptied field arrives as null) is left out, as before.
    const allowed = Object.keys(DEFAULT_THRESHOLDS);
    const filtered: Record<string, number> = {};
    for (const [k, v] of Object.entries(updates)) {
        if (allowed.includes(k) && typeof v === 'number') {
            const problem = thresholdProblem(k, v);
            if (problem) {
                ctx.status = 400;
                ctx.body = { error: problem };
                return;
            }
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
 * Once an owner retired the admin password (admin.ts retire-password) the 2FA that guarded it was deleted with it, and
 * setup, verify and backup codes refuse: a 2FA turned on again would guard nothing but these routes, and a later
 * take-over or sealed restore would clear it without a word (takeover-envelope.ts bundledLocalConfigUpdates). Off
 * stays open, so a 2FA turned on before this check existed can still be turned off.
 */
const NO_SERVER_2FA = "This server has no admin password, so it has no server 2FA: your phone's lock is your second factor";
function refuse2faWhileRetired(ctx: any): boolean {
    if (!isPasswordRetired()) return false;
    ctx.status = 403;
    ctx.body = { error: NO_SERVER_2FA, code: PASSWORD_RETIRED_CODE, passwordRetired: true };
    return true;
}

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
        // Settings draws one line instead of the 2FA card (refuse2faWhileRetired). Absent on a node from before.
        passwordRetired: !!config.passwordRetired,
    };
});

/**
 * POST /api/local/admin/2fa/setup — Generates a new secret + QR code + backup codes for setup.
 * Does NOT disarm existing active 2FA or overwrite totpSecret until verified via /2fa/verify.
 */
router.post('/api/local/admin/2fa/setup', async (ctx) => {
    // First, so a refusal is never cached either: the answer carries the new secret and backup codes (#1531).
    ctx.set('Cache-Control', 'no-store');
    if (!(await checkAdminAuth(ctx as any))) return;
    if (refuse2faWhileRetired(ctx)) return;
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
    if (refuse2faWhileRetired(ctx)) return;
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

    // The code that confirmed the new authenticator is spent like any accepted code (totp.ts useTotpCode): once this
    // secret is the node's, it signs nobody in during the 90 seconds it stays right. Checked as right above.
    useTotpCode(String(code).trim(), secretToVerify);

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
    // Every password session opened without this authenticator ends; the one that turned it on carries on.
    restampPasswordSession(ctx);
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
    restampPasswordSession(ctx);
    console.log('🔓 [AdminAuth] TOTP 2FA disabled for admin account');
    ctx.body = { success: true, message: '2FA disabled successfully', totpEnabled: false };
});

/**
 * POST /api/local/admin/2fa/backup-codes — eight new backup codes, shown once; the old ones stop working. Owner only,
 * and only with the 6-digit code the authenticator shows right now in `code` or `totpCode`: not a backup code (one of
 * those must never buy eight more), and not a code this request already spent signing in, so `secondFactorJustVerified`
 * is not taken here. Stored as SHA-256 hashes like every backup code; the log line never carries a code.
 */
router.post('/api/local/admin/2fa/backup-codes', async (ctx) => {
    // First, so a refusal is never cached either (#1531).
    ctx.set('Cache-Control', 'no-store');
    if (!rateLimit(ctx)) return;
    if (!(await checkAdminAuth(ctx as any))) return;
    if (refuse2faWhileRetired(ctx)) return;
    if (!requireAdminRole(ctx, OWNER_ONLY, 'Only an owner of this node can see new 2FA backup codes')) return;
    const config = getLocalConfig();
    if (!config.totpEnabled || !config.totpSecret) {
        ctx.status = 409;
        ctx.body = { error: 'Two-factor sign-in is off, so there are no backup codes. Turn it on first.' };
        return;
    }
    const body = (ctx as any).requestBody || (ctx.request as any)?.body || {};
    const code = String(body.code ?? body.totpCode ?? '').trim();
    if (!/^\d{6}$/.test(code)) {
        ctx.status = 401;
        ctx.body = { error: 'Enter the 6-digit code your authenticator app shows now to see new backup codes', totpRequired: true };
        return;
    }
    (ctx.state as any).secondFactorJustVerified = false;
    if (!(await requireCurrentSecondFactor(ctx, code, 'to see new backup codes'))) return;
    const backupCodes = generateBackupCodes(8);
    updateLocalConfig({ totpBackupCodesHashes: backupCodes.map(hashBackupCode) });
    const by = (ctx.state as any).isKeySession ? `owner ${String((ctx.state as any).actor).slice(0, 12)}…` : 'the admin password';
    logger.security('AUTH', `New 2FA backup codes were made by ${by}; the old ones no longer work`);
    ctx.body = { success: true, backupCodes };
});

// NOTE: /api/admin/update (signal-file approach) has been removed.
// Updates are notification-only — admin runs `docker compose pull && docker compose up -d` manually.

// ===================== MIDDLEWARE =====================

// Serve PWA at /app
router.get('/app', async (ctx) => {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
        // One visit when a person opens it (engine/web-visits.ts): a count a day, nobody identified. /app/… is counted in
        // https-server.ts's SPA fallback.
        countWebAppPageLoad(ctx);
        useAppDocumentPolicy(ctx);
        ctx.type = 'html';
        ctx.body = fs.createReadStream(indexPath);
    }
});

    return router;
}
