/**
 * The Moderator role is real and narrow: reports and removing reported posts, nothing else (Marty's decision on the
 * board, 2026-09-19). Checked against EVERY admin route the node mounts, found at run time rather than listed here,
 * so a route added later is covered without anyone remembering this file.
 *
 *   1. A moderator signs in with their key (challenge → signature → token → session) and the session says
 *      'moderator'. (Sign-in by QR, #974, is covered in test-settings-qr-signin.ts.)
 *   2. The sweep: every route of every route module whose handler calls checkAdminAuth is called with the
 *      moderator's session. Each one outside MODERATOR_ROUTES answers 403 { moderator: true } and never runs.
 *      Every MODERATOR_ROUTES entry must be a route the node really mounts.
 *   3. The allowlist works: list reports (open filter, open count), dismiss one, mark one actioned, take down the
 *      reported post (both ways), a fresh CSRF token. Refused even there: suspending the member from a report, and
 *      removing a post nobody reported.
 *   4. The password path never yields a moderator: it is owner level, whatever else is sent.
 *   5. A moderator whose role is taken away, or changed, loses the session at once. Signing yourself out everywhere
 *      works; signing someone else out does not.
 *   6. The app's queue shows a moderator only the reports waiting.
 *
 * A Koa app with the real checkAdminAuth and the real route modules, as https-server.ts mounts them. Local only.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-moderator-routes.ts
 */
import crypto from 'node:crypto';
import Koa from 'koa';
import type Router from '@koa/router';
import {
    initStateEngine, seedGenesisMember, grantNodeRole, revokeNodeRole, nodeRoleOf,
    createPost, submitReport, getMember,
} from './state-engine.js';
import { db } from './db/db.js';
import { checkAdminAuth, resetAdminAuthTarpit, MODERATOR_ROUTES } from './admin-auth.js';
import { createAdminChallenge, verifyAndSolveChallenge, consumeHandshakeToken } from './admin-key-auth.js';
import { updateLocalConfig, hashPassword } from './config/local-config.js';
import { createSettingsRoutes } from './routes/settings.js';
import { createCommunityRoutes } from './routes/community.js';
import { createAdminRoutes } from './routes/admin.js';
import { createBackupRoutes } from './routes/backup.js';
import { createTakeoverEnvelopeRoutes } from './routes/takeover-envelope.js';
import { createMarketplaceRoutes } from './routes/marketplace.js';
import { createGroupRoutes } from './routes/groups.js';
import { createFederationPurchaseRoutes } from './routes/federation-purchase.js';
import { createFederationCommissionRoutes } from './routes/federation-commission.js';
import { createMessagingRoutes } from './routes/messaging.js';
import { createCommonsRoutes } from './routes/commons.js';
import { createTreasuryRoutes } from './routes/treasury.js';
import { createPublicAddressRoutes } from './routes/public-address.js';
import { createManagerBackupsRoutes } from './routes/manager-backups.js';
import { createKeeperRoutes } from './routes/keepers.js';
import { createChannelRoutes } from './routes/channels.js';
import { createNodeAdminRoutes } from './routes/node-admin.js';
import { createSettingsSigninRoutes } from './routes/settings-signin.js';
import { createRecoveryCollectRoutes } from './routes/recovery-collect.js';
import { createPairingRoutes } from './routes/pairing.js';
import { createPricingGuideRoutes } from './routes/pricing-guide.js';
import { createActivityRouter } from './routes/activity.js';
import { createPulseRoutes } from './routes/pulse.js';
import { createPulseSubmitRoutes } from './routes/pulse-submit.js';
import { createAvatarRoutes } from './routes/avatar.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const PW = 'ModeratorRoutes123!';

function makeKeypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    return { privateKey, pubKeyHex };
}
type Keypair = ReturnType<typeof makeKeypair>;

/** Key sign-in as the app does it: challenge → signature → handshake token → session. */
function keySession(kp: Keypair): { sessionId?: string; csrfToken?: string; role?: string; error?: string } {
    const chal = createAdminChallenge();
    const signature = crypto.sign(null, Buffer.from(chal.challenge, 'utf-8'), kp.privateKey).toString('hex');
    const solved = verifyAndSolveChallenge({ challengeId: chal.challengeId, memberPubkey: kp.pubKeyHex, signature });
    if (!solved.ok) return { error: solved.error };
    const ex = consumeHandshakeToken(solved.handshakeToken!);
    return ex.ok ? { sessionId: ex.sessionId, csrfToken: ex.csrfToken, role: ex.role } : { error: ex.error };
}

function addMember(kp: Keypair, callsign: string, invitedBy: string) {
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)`)
        .run(kp.pubKeyHex, callsign, new Date().toISOString(), invitedBy, 'TEST');
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(kp.pubKeyHex);
}

/** A concrete path for a route pattern: every :param and regex group becomes a harmless literal. */
function concretePath(pattern: string): string {
    return pattern.replace(/:[A-Za-z_]+(\([^)]*\))?/g, 'x').replace(/\([^)]*\)/g, 'x');
}

async function main() {
    console.log('--- TEST: moderators reach reports and removing reported posts, nothing else ---');
    initStateEngine();
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [], breakGlassMode: false } as any);

    const olive = makeKeypair(); // owner
    const mo = makeKeypair();    // moderator
    const rita = makeKeypair();  // reporter
    const oscar = makeKeypair(); // author of the reported posts
    const pat = makeKeypair();   // plain member
    seedGenesisMember(olive.pubKeyHex, 'Olive');
    addMember(mo, 'Mo', olive.pubKeyHex);
    addMember(rita, 'Rita', olive.pubKeyHex);
    addMember(oscar, 'Oscar', olive.pubKeyHex);
    addMember(pat, 'Pat', olive.pubKeyHex);
    grantNodeRole(mo.pubKeyHex, 'moderator', olive.pubKeyHex);
    // Posting needs a profile photo.
    db.prepare(`UPDATE members SET avatar_url = 'https://example.com/a.jpg' WHERE public_key = ?`).run(oscar.pubKeyHex);

    // Which request reached checkAdminAuth: the sweep tells a refused admin route from a route that never asked.
    const app = new Koa();
    app.use(async (ctx, next) => {
        if (ctx.method !== 'GET') {
            const chunks: Buffer[] = [];
            for await (const chunk of ctx.req) chunks.push(chunk as Buffer);
            const str = Buffer.concat(chunks).toString('utf8');
            (ctx as any).rawBody = str;
            try { (ctx as any).requestBody = str ? JSON.parse(str) : {}; } catch { (ctx as any).requestBody = {}; }
        }
        // The app's signed requests set ctx.state.actor (https-server.ts); here a test header stands in for it.
        const actor = ctx.get('x-test-actor');
        if (actor) ctx.state.actor = actor;
        await next();
        if (ctx.state.__adminAuthCalled) ctx.set('x-test-admin-auth', '1');
    });
    const deps: any = {
        checkAdminAuth: (ctx: any) => {
            ctx.state = ctx.state || {};
            ctx.state.__adminAuthCalled = true;
            return checkAdminAuth(ctx);
        },
        rateLimit: () => true,
        clampLimit: (v: unknown, d = 50) => Math.max(1, Math.min(Number(v) || d, 500)),
        clampOffset: (v: unknown) => Math.max(0, Number(v) || 0),
        enforceReadAuth: false,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
        broadcast: () => { /* nobody listening */ },
    };
    // As https-server.ts mounts them (the Apple probe registers nothing unless APPLE_PROBE=1).
    const modules: Router[] = [
        createSettingsRoutes(deps), createCommunityRoutes(deps), createAdminRoutes(deps), createBackupRoutes(deps),
        createTakeoverEnvelopeRoutes(deps), createMarketplaceRoutes(deps), createGroupRoutes(deps),
        createFederationPurchaseRoutes(deps), createFederationCommissionRoutes(deps), createMessagingRoutes(deps),
        createCommonsRoutes(deps), createTreasuryRoutes(deps), createPublicAddressRoutes(deps),
        createManagerBackupsRoutes(deps), createKeeperRoutes(deps), createChannelRoutes(deps),
        createNodeAdminRoutes(deps), createSettingsSigninRoutes(deps), createRecoveryCollectRoutes(deps),
        createPairingRoutes(deps), createPricingGuideRoutes(deps), createActivityRouter(deps), createPulseRoutes(deps),
        createPulseSubmitRoutes(deps), createAvatarRoutes(deps),
    ];
    for (const m of modules) app.use(m.routes()).use(m.allowedMethods());
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as any).port}`;

    async function call(method: string, path: string, headers: Record<string, string>, body?: any) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 5_000);
        try {
            const send = method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body ?? {});
            const res = await fetch(`${base}${path}`, {
                method,
                headers: { ...(send !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
                body: send,
                signal: ctl.signal,
            });
            let b: any = {};
            try { b = await res.json(); } catch { /* not json */ }
            return { status: res.status, body: b, reachedAuth: res.headers.get('x-test-admin-auth') === '1' };
        } finally {
            clearTimeout(timer);
        }
    }

    try {
        // ── 1. Key sign-in ──
        console.log('\n1. A moderator signs in with their key');
        const modSession = keySession(mo);
        assert(!!modSession.sessionId && modSession.role === 'moderator', `the moderator gets a key session, role 'moderator' (${modSession.error ?? modSession.role})`);
        const asMod = { 'x-admin-session': modSession.sessionId! };
        const whoami = await call('GET', '/api/local/admin/auth/session', asMod);
        assert(whoami.body.authenticated === true && whoami.body.role === 'moderator', 'the session says moderator');
        const patTry = keySession(pat);
        assert(!patTry.sessionId, `a member with no role still gets no session (${patTry.error})`);

        // ── 2. The sweep ──
        console.log('\n2. Every admin route, as the moderator');
        type Found = { method: string; path: string; allowed: boolean };
        const found: Found[] = [];
        const seen = new Set<string>();
        for (const m of modules) {
            for (const layer of (m as any).stack as any[]) {
                const src = (layer.stack as Function[]).map(fn => fn.toString()).join('\n');
                if (!src.includes('checkAdminAuth')) continue;
                const paths: string[] = Array.isArray(layer.path) ? layer.path : [layer.path];
                for (const p of paths) {
                    if (typeof p !== 'string') continue;
                    for (const method of layer.methods as string[]) {
                        if (method === 'HEAD') continue;
                        const key = `${method} ${p}`;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        found.push({ method, path: p, allowed: MODERATOR_ROUTES.some(r => r.method === method && r.path === p) });
                    }
                }
            }
        }
        assert(found.length >= 130, `the sweep finds every admin route the node mounts (${found.length})`);
        for (const r of MODERATOR_ROUTES) {
            assert(found.some(f => f.method === r.method && f.path === r.path), `allowlisted ${r.method} ${r.path} is a real admin route`);
        }

        const notGated: string[] = [];
        for (const r of found) {
            // The allowlist is exercised with real data below (and revoke-all would end this very session).
            if (r.allowed) continue;
            resetAdminAuthTarpit();
            const res = await call(r.method, concretePath(r.path), asMod, {});
            if (!res.reachedAuth) {
                // The handler answered without asking checkAdminAuth for this request: it must not be a success
                // an admin session would get. Listed, and checked one by one below.
                notGated.push(`${r.method} ${r.path} → ${res.status}`);
                continue;
            }
            assert(res.status === 403 && res.body?.moderator === true, `${r.method} ${r.path}: moderator → 403 (got ${res.status} ${JSON.stringify(res.body).slice(0, 80)})`);
        }
        // Routes whose handler mentions checkAdminAuth but answered this request without it. Each is named here with
        // why, and none may answer a moderator's session with a success it would not give a stranger:
        const EXPECTED_NOT_GATED: Record<string, { why: string; status: number }> = {
            // Who is signed in: the moderator's own session, read back.
            'GET /api/local/admin/auth/session': { why: 'reports the caller\'s own session', status: 200 },
            // The backup's pull takes a replication token or the password header, never a key session.
            'GET /api/local/admin/sync-snapshot': { why: 'replication token or password only', status: 401 },
            'GET /api/local/admin/sync-delta': { why: 'replication token or password only', status: 401 },
            // Member routes sharing a handler with the Settings one; they check the member's signature instead.
            'POST /api/enterprise/:treasury/location': { why: 'signed member route (keeper)', status: 404 },
            'POST /api/treasury/:treasury/location': { why: 'signed member route (keeper)', status: 404 },
            'DELETE /api/enterprise/:treasury/location': { why: 'signed member route (keeper)', status: 404 },
            'DELETE /api/treasury/:treasury/location': { why: 'signed member route (keeper)', status: 404 },
        };
        for (const n of notGated) {
            const [key, got] = n.split(' → ');
            const known = EXPECTED_NOT_GATED[key];
            assert(!!known && Number(got) === known.status, `answered without checkAdminAuth: ${n} (${known?.why ?? 'NOT a known case'})`);
        }
        const stillIn = await call('GET', '/api/local/admin/auth/session', asMod);
        assert(stillIn.body.authenticated === true && stillIn.body.role === 'moderator', 'after the sweep the moderator is still signed in, still a moderator');
        assert(nodeRoleOf(mo.pubKeyHex) === 'moderator' && nodeRoleOf(olive.pubKeyHex) === 'owner', 'and nothing the sweep sent changed a role');

        // ── 3. The allowlist, for real ──
        console.log('\n3. Reports and reported posts');
        const postA = createPost('offer', 'other', 'Rude offer', 'Something rude', 10, 'fixed', oscar.pubKeyHex);
        const postB = createPost('offer', 'other', 'Spam offer', 'Buy now buy now', 10, 'fixed', oscar.pubKeyHex);
        const postC = createPost('offer', 'other', 'Fine offer', 'Nothing wrong here', 10, 'fixed', oscar.pubKeyHex);
        const postD = createPost('offer', 'other', 'Other offer', 'Reported, then taken down directly', 10, 'fixed', oscar.pubKeyHex);
        const repA = submitReport(rita.pubKeyHex, oscar.pubKeyHex, 'Rude', postA.id)!;
        const repB = submitReport(rita.pubKeyHex, oscar.pubKeyHex, 'Spam', postB.id)!;
        const repC = submitReport(rita.pubKeyHex, oscar.pubKeyHex, 'Not sure', postC.id)!;
        submitReport(rita.pubKeyHex, oscar.pubKeyHex, 'Also rude', postD.id);
        const csrf = await call('POST', '/api/local/admin/csrf-token', asMod);
        assert(csrf.status === 200 && typeof csrf.body.csrfToken === 'string', `a fresh CSRF token after a reload (got ${csrf.status})`);

        const open = await call('GET', '/api/local/admin/reports?status=open', asMod);
        assert(open.status === 200 && open.body.pendingCount === 4 && open.body.reports.length === 4, `the moderator lists the open reports (got ${open.status}, ${open.body.pendingCount})`);
        const shownA = open.body.reports.find((r: any) => r.id === repA.id);
        assert(shownA?.postTitle === 'Rude offer' && shownA?.postDescription === 'Something rude' && shownA?.reporterCallsign === 'Rita',
            'a report shows what the post says and who reported it');

        const dismissC = await call('POST', `/api/local/admin/reports/${repC.id}/dismiss`, asMod);
        assert(dismissC.status === 200, `the moderator dismisses a report (got ${dismissC.status})`);
        const suspend = await call('POST', `/api/local/admin/reports/${repA.id}/action`, asMod, { deletePost: true, suspendUser: true });
        assert(suspend.status === 403, `the moderator cannot suspend the member from a report (got ${suspend.status})`);
        assert(getMember(oscar.pubKeyHex)?.status === 'active', 'the author is still active');
        const takeDown = await call('POST', `/api/local/admin/reports/${repA.id}/action`, asMod, { deletePost: true, reasonCategory: 'harassment' });
        assert(takeDown.status === 200, `the moderator takes the reported post down from its report (got ${takeDown.status})`);
        const postARow = db.prepare('SELECT active FROM posts WHERE id = ?').get(postA.id) as any;
        assert(postARow?.active === 0, 'the post is down');
        const markOnly = await call('POST', `/api/local/admin/reports/${repB.id}/action`, asMod, {});
        assert(markOnly.status === 200, `the moderator marks a report actioned (got ${markOnly.status})`);
        const direct = await call('POST', `/api/local/admin/posts/${postD.id}/delete`, asMod, { reasonCategory: 'spam' });
        assert(direct.status === 200, `the moderator removes a reported post by the takedown route (got ${direct.status})`);
        const postE = createPost('offer', 'other', 'Unreported', 'Nobody reported this', 10, 'fixed', oscar.pubKeyHex);
        const unreported = await call('POST', `/api/local/admin/posts/${postE.id}/delete`, asMod, {});
        assert(unreported.status === 403, `…but not a post nobody reported (got ${unreported.status})`);
        assert((db.prepare('SELECT active FROM posts WHERE id = ?').get(postE.id) as any)?.active === 1, 'which stays up');
        const after = await call('GET', '/api/local/admin/reports?status=open', asMod);
        assert(after.status === 200 && after.body.pendingCount === 0, `no report is left open (got ${after.body.pendingCount})`);
        const actioned = await call('GET', '/api/local/admin/reports?status=actioned', asMod);
        assert(actioned.status === 200 && actioned.body.reports.length === 3, `the actioned filter shows the three acted on (got ${actioned.body.reports?.length})`);

        // ── 4. The password path ──
        console.log('\n4. The password never yields a moderator');
        resetAdminAuthTarpit();
        const pw = await call('GET', '/api/local/admin/auth/session', { 'X-Admin-Password': PW });
        assert(pw.body.authenticated === true && pw.body.role === 'owner', `the password is owner level (got ${pw.body.role})`);
        const pwWithMod = await call('GET', '/api/local/admin/auth/session', { 'X-Admin-Password': PW, 'x-admin-session': 'not-a-session' });
        assert(pwWithMod.body.role !== 'moderator', 'a dead session beside the password does not make it a moderator');
        // The password login takes the password and nothing else: a moderator's session stands in for none of it.
        const modPwRoute = await call('POST', '/api/local/verify-password', asMod, { password: 'not-the-password' });
        assert(modPwRoute.status === 401, `a moderator's session does not get past the password login (got ${modPwRoute.status})`);
        const modPwHeader = await call('GET', '/api/local/admin/auth/session', { ...asMod, 'X-Admin-Password': 'not-the-password' });
        assert(modPwHeader.body.role === 'moderator', 'a session with a wrong password beside it stays a moderator session, never more');
        const modPwAdmin = await call('POST', '/api/local/admin/data', { ...asMod, 'X-Admin-Password': 'not-the-password' });
        assert(modPwAdmin.status === 403 && modPwAdmin.body.moderator === true, `…and is still refused an admin route (got ${modPwAdmin.status})`);
        const modRoles = await call('POST', '/api/local/admin/node-roles', asMod, { memberPubkey: pat.pubKeyHex, role: 'moderator' });
        assert(modRoles.status === 403 && nodeRoleOf(pat.pubKeyHex) === null, 'nor change roles');

        // ── 5. Losing the role ──
        console.log('\n5. A moderator who loses the role loses the session at once');
        const s2 = keySession(mo);
        const s3 = keySession(mo);
        revokeNodeRole(mo.pubKeyHex, 'moderator', olive.pubKeyHex);
        const dead = await call('GET', '/api/local/admin/reports', { 'x-admin-session': s2.sessionId! });
        assert(dead.status === 401, `a demoted moderator's session is refused on its next request (got ${dead.status})`);
        const dead2 = await call('GET', '/api/local/admin/auth/session', { 'x-admin-session': s3.sessionId! });
        assert(dead2.body.authenticated === false, 'every one of their sessions');
        grantNodeRole(mo.pubKeyHex, 'moderator', olive.pubKeyHex);
        const s4 = keySession(mo);
        grantNodeRole(mo.pubKeyHex, 'admin', olive.pubKeyHex);
        const promoted = await call('GET', '/api/local/admin/reports', { 'x-admin-session': s4.sessionId! });
        assert(promoted.status === 401, `a role change ends the moderator session too (got ${promoted.status})`);
        grantNodeRole(mo.pubKeyHex, 'moderator', olive.pubKeyHex);

        const s5 = keySession(mo);
        const other = await call('POST', '/api/local/admin/auth/revoke-all', { 'x-admin-session': s5.sessionId! }, { memberPubkey: olive.pubKeyHex });
        assert(other.status === 403, `a moderator cannot sign someone else out (got ${other.status})`);
        const own = await call('POST', '/api/local/admin/auth/revoke-all', { 'x-admin-session': s5.sessionId! }, {});
        assert(own.status === 200, `a moderator can sign themselves out everywhere (got ${own.status})`);
        const gone = await call('GET', '/api/local/admin/reports', { 'x-admin-session': s5.sessionId! });
        assert(gone.status === 401, 'and the session is gone');

        // ── 6. The app's queue ──
        console.log("\n6. The app's queue");
        submitReport(rita.pubKeyHex, oscar.pubKeyHex, 'Again', postE.id);
        db.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, franchise, status, closes_at)
            VALUES ('d-susp', ?, 'Keep it?', 'Keep the suspension?', 'member', 'keep_suspension', '1m1v', 'open', strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days'))`).run(olive.pubKeyHex);
        const modQueue = await call('GET', '/api/node-admin/queue', { 'x-test-actor': mo.pubKeyHex });
        assert(modQueue.status === 200 && modQueue.body.items.length === 1 && modQueue.body.items[0].kind === 'reports' && modQueue.body.total === 1,
            `a moderator's queue holds the reports only (got ${JSON.stringify(modQueue.body.items?.map((i: any) => i.kind))})`);
        const ownerQueue = await call('GET', '/api/node-admin/queue', { 'x-test-actor': olive.pubKeyHex });
        assert(ownerQueue.status === 200 && ownerQueue.body.items.some((i: any) => i.kind === 'suspensions'), "the owner's queue still holds everything");
        const patQueue = await call('GET', '/api/node-admin/queue', { 'x-test-actor': pat.pubKeyHex });
        assert(patQueue.status === 403, `a member with no role sees no queue (got ${patQueue.status})`);
        const me = await call('GET', '/api/node-admin/me', { 'x-test-actor': mo.pubKeyHex });
        assert(me.body.role === 'moderator', "the app is told the member's role is moderator");
    } finally {
        server.close();
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
    setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
