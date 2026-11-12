/**
 * Settings, Deep Links, Root Redirect, Version, Node Config routes.
 */

import Router from '@koa/router';
import { getVersion, getCommit, shownVersion } from '../version.js';
import { backgroundUpdateCheck, cachedNodeUpdateInfo, lookUpNewestNodeRelease, semverGreater } from '../node-release-check.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import {
    getNodeConfig, updateNodeConfig, getDirectoryInfo, exportLedgerAudit,
    getNodeRole, getMemberStats, isNodeMember, broadcast, dispatchPushNotification, type NodeConfig,
} from '../state-engine.js';
import { isPrivatePreview } from '../config/private-preview.js';
import { placeAs, placeShownTo, type PlaceShown } from '../config/community-place.js';
import {
    saveLocalConfig,
    getThresholds, updateThresholds, DEFAULT_THRESHOLDS, thresholdProblem,
    getGatewayConfig,
} from '../config/local-config.js';
import { requireAdminRole, requireFreshProof, TOKEN_REFUSED_CODE, type AdminRole } from '../admin-auth.js';
import { actingAs } from '../services/security-signal.js';
import { initDirectoryPublisher, pushDirectoryNow, NOT_LISTED_MESSAGE, directoryPromiseStatus, directoryPromiseSaved } from '../services/directory-publisher.js';
import { listingFields, publicListingFields, setPromiseTicks } from '../engine/directory-promise.js';
import { getConfiguredSwitches } from '../config/node-profile.js';
import { getDoor } from '../config/door.js';
import { HealthError, healthSummary, readHealthAccessLog, setHealthSettings } from '../engine/community-health.js';
import { KnownFloorError, knownFloorSettings, knownFloorExceptions, readKnownFloorLog, setKnownFloorException, knownFloorForMember } from '../config/known-floor.js';
import { isDirectoryPushInterval, MAX_DIRECTORY_PUSH_INTERVAL_HOURS } from '../config/community-settings.js';
import { readShape } from '../config/community-shape.js';
import { applyShapeChanges, shapeChangeAsksFreshProof, ShapeChangeError, SHAPE_OWNER_ONLY, CORE_PROOF_ACTION } from '../config/community-shape-write.js';
import { adviseTheOwners, ADVICE_ROLE_ONLY, ADVICE_TOKEN_REFUSED } from '../config/core-advice.js';
import { renderInviteTrampoline } from './invite-trampoline.js';
import { useAppDocumentPolicy, useDocumentPolicy } from '../app-document-csp.js';
import { countWebAppPageLoad } from '../engine/web-visits.js';
import type { RouteDeps } from './types.js';
import { PROTOCOL_CONSTANTS, word, VOUCH_PRESETS, VOUCH_MAX, VOUCHER_BUDGET_MAX } from '@beanpool/core';
import { myVouching, readVoucherCard, VoucherError, tellVoucherNotice } from '../engine/vouchers.js';
import { setStartCommunityUrl, START_COMMUNITY_URL_MAX } from '../config/start-community.js';
import { cleanLabel, AREA_NAME_MAX } from '../config/clean-label.js';
import { cardLanguage, serveCommunityCard } from './community-card.js';
import { servePeekPage } from './peek.js';

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
                        }
                        // No "/app*": every link the phone opens is on "/" (app/+native-intent.ts), and /app is the
                        // web app's, which a browser keeps (cutover N2, audit E5).
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

    // The phone's Manage button hands its sign-in over in the fragment (`/settings#handoff=…`), which the manager
    // redeems with POST /api/local/admin/auth/exchange (routes/admin.ts). The query form `/settings?token=` of builds
    // before 1.2.57 is gone (cutover N2, audit E4): a token in the query is never read here, so it signs nobody in.

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

// The legacy settings page (/settings-legacy and its /settings.js) is gone (design case 18, D9): every button it had that
// could wipe or delete has a copy there. Settings is the manager.


// ===================== ROOT =====================
// The web app is at /app; the root sends a browser there, query and all (`?post=`, `?shop=`, a sign-in's return), and the
// web app's identity gate decides the rest. Two exceptions, each plain HTML from THIS server: an invite link opened
// without the app (below), and a stranger at a local community's bare address, who gets the community's public card
// (routes/community-card.ts, front doors S15) rather than a sign-in form. A browser that keeps an account here says so
// with the web app's hint cookie and goes to the web app as before, as does the global community's lobby.
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
        // The store badges' alt text is in the visitor's language (?lang=, else Accept-Language), as the community card is.
        ctx.vary('Accept-Language');
        ctx.body = renderInviteTrampoline({ webJoin, lang: cardLanguage(ctx) });
        return;
    }
    // A post shared outside the community (`?post=<id>&peek=<ticket>`, front doors S6): its share page for a stranger, or
    // the community's card where the link opens nothing now (routes/peek.ts). A member's browser goes to the web app.
    if (servePeekPage(ctx)) return;
    if (serveCommunityCard(ctx)) return;
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
//   - dmRequests (withKnockSetting, below): the manager's Node Identity screen
// The operator's public address is read from the admin route /api/local/admin/public-address/status.
// The service area's centre is the manager's one map pin, which is also the node's place, and an operator may have set it
// at home: config/community-place.ts says who gets it (public-routes audit NEW-1: it was served to ~1 m). An owner or admin
// gets it exact, as the manager's Node Identity screen reads it with its admin credential, so a save never writes a
// rounded pin back; a member who reads as one (not suspended or disabled) to two decimals (~1 km); anyone else to two
// decimals with "Share Location & Radius" on, and null with it off. The web app and the phone sign this read when they
// hold a key, so a member's map still centres.
function publicNodeConfig(config: NodeConfig, shown: PlaceShown) {
    return {
        serviceRadius: placeAs(config.serviceRadius, shown),
        // The town or area a stranger's card names (routes/community-card.ts): the place in words, so it goes where the
        // place goes, and nowhere it doesn't.
        areaName: shown === 'none' ? null : config.areaName ?? null,
        publishLocation: config.publishLocation,
        publishMembers: config.publishMembers,
        publishContactEmail: config.publishContactEmail,
        publishContactPhone: config.publishContactPhone,
        publishHealth: config.publishHealth,
        directoryPushIntervalHours: config.directoryPushIntervalHours,
        lastDirectoryPush: config.lastDirectoryPush,
    };
}

// `acceptKnocks`: whether this community takes "ask to join" requests (G6, D4: on unless an owner turns it off). It is
// the `knocks` profile switch as configured, so it travels with the profile record (config/node-profile.ts), and it
// is said here beside the directory settings because Settings shows them together. Public, like the switch itself in
// /api/community/info; how many requests are waiting is the operator's only (/api/local/admin/knocks). These three are
// read here and changed only under How this community works (POST /api/local/admin/community-shape).
// `door`: who may invite here (config/door.ts): `members`, `admins`, or `open` where the profile opens the door and takes
// no invites. Public, as `features.door` in /api/community/info is.
// `dmRequests`: whether a stranger's first message waits as a request until it is accepted (engine/dm-requests.ts): the
// `dmRequests` profile switch as configured, on for the global community and off for a local one unless the operator turns
// it on. Public, as `features.dmRequests` is.
function withKnockSetting<T extends object>(config: T): T & { acceptKnocks: boolean; door: ReturnType<typeof getDoor>; dmRequests: boolean } {
    const switches = getConfiguredSwitches();
    return { ...config, acceptKnocks: switches.knocks, door: getDoor(), dmRequests: switches.dmRequests };
}

/**
 * Whether this request is an owner's or admin's (checkAdminAuth, then the role), as /api/local/dashboard asks, but never a
 * refusal: this read is public, and the web app on the same origin sends the manager's session cookie, so a cookie that
 * has run out must still get the public answer, not a 401. The refusal checkAdminAuth wrote is replaced by that answer.
 */
async function ownerOrAdminAsking(ctx: any): Promise<boolean> {
    if ((await checkAdminAuth(ctx)) && OWNER_OR_ADMIN.includes(ctx.state?.adminRole)) return true;
    ctx.status = 200;
    ctx.remove('Retry-After');
    ctx.remove('WWW-Authenticate');
    return false;
}

router.get('/api/node/config', async (ctx) => {
    ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    const ownerOrAdmin = await ownerOrAdminAsking(ctx);
    // Read after checkAdminAuth: a key session (the manager's, which isn't a signed request) names its member there.
    const signer = ctx.state.actor as string | undefined;
    const config = publicNodeConfig(getNodeConfig(), placeShownTo({ ownerOrAdmin, signer }));
    // A private preview (config/private-preview.ts): the phone map reads this unsigned for the community's service area
    // (apps/native map.tsx, which can't change here), so it is open, and a reader who is no member here (as that read
    // is) gets the area alone: the place the community serves (null with "Share Location & Radius" off), no member's
    // anything, and none of the other settings. An owner or admin gets the whole config, as off a preview: the node
    // password names no member, and the Node Identity screen that reads with it saves every setting back.
    if (isPrivatePreview() && !ownerOrAdmin && !isNodeMember(signer)) {
        ctx.body = { serviceRadius: config.serviceRadius ?? null };
        return;
    }
    ctx.body = withKnockSetting(config);
});

// The known floor (config/known-floor.ts, community modes slice 4): every owner and admin reads the settings, the
// exceptions and the log; only an owner changes the dial, the known floor or the cap, and only under How this community
// works (POST /api/local/admin/community-shape `knownFloor`, below), which logs it and tells the members; an owner or admin
// sets one member's exception. Every change is a line in the log.
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

// How this community works (config/community-shape.ts; the design's §6.1, slice S1): every structural setting as it is set
// and as the node runs it, with each lock in the server's words. Every owner and admin reads it, and a read token; a
// moderator's session never gets this far (checkAdminAuth).
router.get('/api/local/admin/community-shape', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!requireAdminRole(ctx, ['owner', 'admin'], 'Only an owner or admin of this community can read how it works.')) return;
    ctx.set('Cache-Control', 'no-store');
    ctx.body = readShape();
});

// The one place its owners change it (config/community-shape-write.ts; the design's §6.1, slice S2): `{ changes, note? }`,
// all or nothing. An owner only: an admin is refused (403), and so is every automation token and the phone's hand-off past
// its step-up (requireAdminRole); a standby changes nothing (409). Each lock answers 409 with its own sentence and code,
// a bad request 400, and nothing is written. Answers `{ shape, told: 'members' | 'nobody' }`.
// Core settings (config/core-settings.ts, DESIGN-core-settings-fable.md §8.3, slice C1): `lock: true` confirms and locks
// them (no fresh proof: nothing is undone). Once locked, a request that changes a Core setting is written only with the
// owner's fresh proof (requireFreshProof: the phone's unlock within 90 s of Manage, or the password with a current code as
// `code` or X-Fresh-Proof; never a token, a computer's session or a break-glass code), refused in its own words otherwise
// and nothing written. The request is checked whole first, so one refused anyway never asks for, or spends, a code.
router.post('/api/local/admin/community-shape', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!requireAdminRole(ctx, ['owner'], SHAPE_OWNER_ONLY)) return;
    ctx.set('Cache-Control', 'no-store');
    const body = (ctx as any).requestBody || {};
    try {
        const asksProof = shapeChangeAsksFreshProof(body);
        if (asksProof && !(await requireFreshProof(ctx, body.code ?? ctx.get('x-fresh-proof'), CORE_PROOF_ACTION))) return;
        const { shape, told } = applyShapeChanges(actingAs(ctx.state, 'owner'), body, { freshProof: asksProof });
        ctx.body = { shape, told };
    } catch (e) {
        if (!(e instanceof ShapeChangeError)) throw e;
        ctx.status = e.status;
        ctx.body = { error: e.message, code: e.code, ...(e.setting ? { setting: e.setting } : {}), ...(e.unlock ? { unlock: e.unlock } : {}) };
    }
});

// Advise the owners (config/core-advice.ts, DESIGN-core-settings-fable.md §5, slice C4): `{ setting, advice }`, up to 200
// characters about one Core setting, from an admin (who reads every Core setting and changes none) or an owner. One log
// line and one owner alert; it changes nothing, tells no member and asks no proof. A moderator never gets this far
// (checkAdminAuth); an automation token of any scope is refused here, since requireAdminRole lets an admin-level token
// through and a token acts as whoever issued it, not as a person with something to say. Answers `{ shape, told: 'owners' }`.
router.post('/api/local/admin/community-shape/advice', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if ((ctx.state as any)?.automationTokenId) {
        ctx.status = 403;
        ctx.body = { error: ADVICE_TOKEN_REFUSED, code: TOKEN_REFUSED_CODE };
        return;
    }
    if (!requireAdminRole(ctx, ['owner', 'admin'], ADVICE_ROLE_ONLY)) return;
    ctx.set('Cache-Control', 'no-store');
    const role = (ctx.state as any).adminRole === 'owner' ? 'owner' : 'admin';
    try {
        const { shape } = adviseTheOwners(actingAs(ctx.state, role), role, (ctx as any).requestBody || {});
        ctx.body = { shape, told: 'owners' };
    } catch (e) {
        if (!(e instanceof ShapeChangeError)) throw e;
        ctx.status = e.status;
        ctx.body = { error: e.message, code: e.code, ...(e.setting ? { setting: e.setting } : {}) };
    }
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

// Where the 🏘️ Local community sheet's Start a community leads (config/start-community.ts). Owner only: it is the
// community's own word to strangers. `{ url }`: an https address; null, empty or the default goes back to beanpool.org's.
router.post('/api/local/admin/start-community-url', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!requireAdminRole(ctx, ['owner'], 'Only an owner of this community can change where Start a community leads.')) return;
    const set = setStartCommunityUrl(((ctx as any).requestBody || {}).url);
    if (!set.ok) {
        ctx.status = 400;
        ctx.body = { error: `Send url as a web address starting https:// (at most ${START_COMMUNITY_URL_MAX} characters), or null for the default.` };
        return;
    }
    ctx.body = { startCommunityUrl: set.startCommunityUrl };
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

// One member's voucher card for the Manager's member screen (owner or admin).
router.get('/api/local/admin/known-floor/vouchers/member/:pubkey', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!requireAdminRole(ctx, ['owner', 'admin'], 'Only an owner or admin of this community can see a member\'s voucher card.')) return;
    ctx.set('Cache-Control', 'no-store');
    const actor = (ctx.state?.actor as string | undefined) || 'owner:password';
    try {
        ctx.body = readVoucherCard(actor, ctx.params.pubkey);
    } catch (e) {
        if (e instanceof VoucherError) {
            ctx.status = e.status;
            ctx.body = { error: e.message, code: e.code };
            return;
        }
        throw e;
    }
});

// The signed-in admin's own vouching status, budget, and presets for the Manager (Invites module).
router.get('/api/local/admin/vouchers/me', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const actor = ctx.state?.actor as string | undefined;
    if (!actor || actor === 'owner:password') {
        ctx.body = { voucher: false, presets: [...VOUCH_PRESETS], vouchMax: VOUCH_MAX, budgetMax: VOUCHER_BUDGET_MAX };
        return;
    }
    ctx.set('Cache-Control', 'private, no-store');
    ctx.body = myVouching(actor);
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
        // A change that writes tells the member (a confirmed one, with the dial on: engine/credit-notices.ts).
        ctx.body = setKnownFloorException(actor, (ctx as any).requestBody || {}, (notice) => tellVoucherNotice(notice, { broadcast, dispatchPushNotification }));
    } catch (e) { knownFloorRefusal(ctx, e); }
});

router.post('/api/local/admin/node/config', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) {
        console.log("Auth failed for updateNodeConfig");
        return;
    }
    const body = (ctx as any).requestBody || {};
    // `publishContacts`, the old single switch for both contacts, is not read: a page that still sends it turns nothing on.
    const { publishLocation, publishMembers, publishContactEmail, publishContactPhone, publishHealth, serviceRadius, directoryPushIntervalHours } = body;
    // The town or area the community's card names (NodeConfig `areaName`): text, cut to AREA_NAME_MAX, or null (or nothing
    // left once cleaned) for none. Anything else is refused before anything is written.
    if (body.areaName !== undefined && body.areaName !== null && typeof body.areaName !== 'string') {
        ctx.status = 400;
        ctx.body = { error: 'areaName must be text, or null for none', code: 'bad_area_name' };
        return;
    }
    const areaName = body.areaName === undefined ? undefined : (cleanLabel(body.areaName, AREA_NAME_MAX) ?? null);
    // Requests to join, message requests and who may invite are how this community works, changed only there, by an owner,
    // logged and told to the members (POST /api/local/admin/community-shape; the design's §3.4). Sent here, the whole
    // request is refused before anything in it is written: half a save would look like a whole one.
    for (const [field, setting] of [['acceptKnocks', 'knocks'], ['dmRequests', 'dmRequests'], ['door', 'join']] as const) {
        if (body[field] === undefined) continue;
        ctx.status = 400;
        ctx.body = {
            error: `${field} is changed under How this community works now, by an owner (POST /api/local/admin/community-shape, changes.${setting}). Nothing in this request was saved.`,
            code: 'moved_to_community_shape',
            setting,
        };
        return;
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
    // it, below zero or a sliver of an hour, the timer fires every millisecond at the directory registry. 0 was Never, a
    // second way not to be listed: Listed under How this community works is the one now (design §3.3, §6.3).
    if (directoryPushIntervalHours === 0) {
        ctx.status = 400;
        ctx.body = { error: word('0 is no longer a schedule: switch Listed off under How this community works.'), code: 'bad_interval' };
        return;
    }
    if (directoryPushIntervalHours !== undefined && !isDirectoryPushInterval(directoryPushIntervalHours)) {
        ctx.status = 400;
        ctx.body = { error: `directoryPushIntervalHours must be a whole number of hours from 1 to ${MAX_DIRECTORY_PUSH_INTERVAL_HOURS}`, code: 'bad_interval' };
        return;
    }
    console.log("Updating node config:", { publishLocation, publishMembers, publishContactEmail, publishContactPhone, publishHealth, serviceRadius, directoryPushIntervalHours, areaName });
    // Only the fields sent. One left out and passed on as undefined would be dropped from the stored object, and the
    // location, member count and health switches read unset as "publish": a request that changed one switch published
    // the member count the community had turned off. Settings sends every field (null clears the service area).
    const sent = Object.fromEntries(Object.entries({ publishLocation, publishMembers, publishContactEmail, publishContactPhone, publishHealth, serviceRadius, directoryPushIntervalHours, areaName })
        .filter(([, v]) => v !== undefined));
    // The public fields only, as GET /api/node/config answers: the stored config also holds the tunnel token, and an admin
    // (who may save these switches) must never read it. No caller reads more from this answer than ok or error.
    ctx.body = withKnockSetting(publicNodeConfig(updateNodeConfig(sent), 'exact'));
    
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
        // Not listed by the profile's switch (the global node), held back (no name of its own yet, DIRECTORY_UNLISTED), or
        // past its closing day, is the node's setting, not a server failure: 409, with the answer saying which.
        ctx.status = (result.error === NOT_LISTED_MESSAGE || result.heldBack || result.closed) ? 409 : 500;
    }
    ctx.body = result;
});

// Settings → Directory: the listing promise (engine/directory-promise.ts, mothership A2). The read is an owner's or an
// admin's: what the next push says, the two measured lines as counts and switches, and why the promise is left out, in
// sentences. Null as `promise` where nothing is pushed at all (a standby, a profile never listed, the interval Never).
router.get('/api/local/admin/directory/promise', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    ctx.set('Cache-Control', 'no-store');
    ctx.body = { promise: directoryPromiseStatus(), listing: listingFields().fields };
});

// The two ticked lines and "closing on", an owner's only: the community's word to every stranger the directory sends.
// `{ reports?, notice?, closingOn? }`, each changed only when sent: true or false; a day YYYY-MM-DD from today, or null to
// clear it. Pushed at once when the community is listed (directoryPromiseSaved).
router.post('/api/local/admin/directory/promise', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!requireAdminRole(ctx, ['owner'], 'Only an owner of this community can make or change its listing promise.')) return;
    const { reports, notice, closingOn } = (ctx as any).requestBody || {};
    const set = setPromiseTicks({ reports, notice, closingOn });
    if (!set.ok) {
        ctx.status = 400;
        ctx.body = { error: set.error };
        return;
    }
    console.log(`📜 The listing promise is now ${JSON.stringify(set.ticks)}, set by ${(ctx.state as any)?.actor || 'owner:password'}.`);
    directoryPromiseSaved();
    ctx.set('Cache-Control', 'no-store');
    ctx.body = { promise: directoryPromiseStatus(), listing: listingFields().fields };
});

// Local directory info endpoint (used by settings preview): what a push sends, which holds only what the switches publish,
// and the listing promise's three fields (counts and booleans, as the public directory holds them).
// No CORS headers - should only be called from same origin (admin PWA)
router.get('/api/directory/info', async (ctx) => {
    ctx.body = { ...getDirectoryInfo(), ...publicListingFields() };
});


// ===================== VERSION & UPDATES =====================

// Version now lives in ../version.js so /api/version and /api/community/health
// cannot drift apart again. So does the commit, asked of git once rather than on every request.

// ===================== BACKGROUND UPDATE CHECKER =====================
// The lookup and its cache live in ../node-release-check.ts: only v<semver> releases are node releases (a vault-v* or
// native-v* release never reads as a newer node).

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
    const cachedUpdateInfo = cachedNodeUpdateInfo();
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
    const updates = (ctx as any).requestBody || {};
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

router.post('/api/admin/check-update', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    if (!requireAdminRole(ctx, OWNER_OR_ADMIN, 'Only an owner or admin of this node can check for updates')) return;
    try {
        const release = await lookUpNewestNodeRelease();
        if (release) {
            const currentVersion = getVersion();
            ctx.body = {
                currentVersion: shownVersion(currentVersion),
                latestVersion: release.latestVersion,
                updateAvailable: semverGreater(release.latestVersion, currentVersion),
                releaseUrl: release.releaseUrl,
                releaseNotes: release.releaseNotes,
                publishedAt: release.publishedAt,
            };
        } else {
            // Return Bad Gateway if upstream update source (GitHub API) is unreachable
            ctx.status = 502;
            ctx.body = {
                currentVersion: shownVersion(getVersion()),
                latestVersion: '',
                updateAvailable: false,
                error: 'Could not reach GitHub',
            };
        }
    } catch (e: any) {
        // Return Internal Server Error on unhandled update check exceptions
        ctx.status = 500;
        ctx.body = {
            currentVersion: shownVersion(getVersion()),
            latestVersion: '',
            updateAvailable: false,
            error: e.message || 'Failed to check',
        };
    }
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
