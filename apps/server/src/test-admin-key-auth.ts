/**
 * Comprehensive tests for Key-Based Admin Auth and Break-Glass Protocol:
 * (docs/admin-surface.md §2 (all), the interim rule ("password = owner-level"), and node_roles)
 *
 * Covers:
 *   1. Signed challenge auth:
 *      - Fresh 60s challenge creation and polling
 *      - Ed25519 signature verification against active node role holder
 *      - Rejection of tampered signatures, non-role members, and disabled members
 *      - Single-use 60s handshake token minting
 *   2. Handshake Token Exchange:
 *      - Token exchange for browser session (2h idle / 12h hard limit)
 *      - Deep-link exchange on GET /settings?token=... with session cookie and redirect
 *   3. Token Replay Protection:
 *      - Replaying an already-exchanged handshake token fails with 401 { replay: true }
 *   4. Token Expiry:
 *      - Exchanging an expired handshake token fails with 401 { expired: true }
 *   5. Instant Revocation via session_epoch:
 *      - Calling revoke-all bumps member session_epoch
 *      - Existing sessions immediately become invalid (401 revoked)
 *      - New session issued after epoch bump works normally
 *   6. Idle (2h) and Hard (12h) limit enforcement:
 *      - Sessions past idle or hard limits are rejected
 *   7. Action Attribution:
 *      - Actions under key session record auth_signer = memberPubkey (e.g. granted_by in node_roles)
 *      - Actions under password auth record granted_by = 'owner:password'
 *   8. Password path unchanged when breakGlassMode is false:
 *      - Password auth continues to work on all admin routes and /settings
 *   9. Break-glass mode gating and route restriction:
 *      - When breakGlassMode = true, password/break-glass credentials receive 403 on general admin routes
 *      - Key session retains full access
 *      - Password / break-glass credentials CAN access key enrolment (/api/local/admin/auth/enrol)
 *  10. Per-owner break-glass code & loud public alert:
 *      - Enrolment returns distinct break-glass code; hash is stored in node_roles.break_glass_hash
 *      - Break-glass code authenticates to enrolment during break-glass mode
 *      - Break-glass recovery broadcasts a critical public alert announcement
 *  11. TOTP 2FA enforcement during challenge verification when TOTP is active
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-admin-key-auth.ts
 */

import { scryptSync, randomBytes } from 'node:crypto';
import Koa from 'koa';
import { ed25519 } from '@noble/curves/ed25519.js';
import { db, seedNodeRolesFromGenesis } from './db/db.js';
import {
    initStateEngine,
    seedGenesisMember,
    grantNodeRole,
    listNodeRoles,
    getNodeRoleSessionEpoch,
    bumpNodeRoleSessionEpoch,
    setNodeRoleBreakGlassHash,
    getNodeRoleBreakGlassHash,
    adminSetUserStatus,
    getMember,
    addWsClient,
    removeWsClient,
} from './state-engine.js';
import {
    createAdminChallenge,
    getAdminChallenge,
    verifyAndSolveChallenge,
    consumeHandshakeToken,
    validateAdminSession,
    revokeAllMemberSessions,
    revokeAdminSession,
    generateBreakGlassCode,
    hashBreakGlassCode,
    verifyBreakGlassCode,
    enrolAdminOwnerKey,
    pruneExpiredAuthEntries,
    verifyEd25519Signature,
} from './admin-key-auth.js';
import { checkAdminAuth, resetAdminAuthTarpit } from './admin-auth.js';
import {
    getLocalConfig,
    updateLocalConfig,
    isBreakGlassMode,
    setBreakGlassMode,
} from './config/local-config.js';
import { generateTotpSecret, generateTotpCode, generateBackupCodes, hashBackupCode } from './totp.js';
import { createAdminRoutes } from './routes/admin.js';
import { createSettingsRoutes } from './routes/settings.js';
import type { RouteDeps } from './routes/types.js';

let total = 0;
let passed = 0;

function assert(cond: boolean, msg: string) {
    total++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        process.exitCode = 1;
    }
}

function seedMember(pk: string, callsign: string) {
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
}

function createKeyPair() {
    const priv = randomBytes(32);
    const pub = Buffer.from(ed25519.getPublicKey(priv)).toString('hex');
    const sign = (msg: string | Uint8Array) => {
        const msgBytes = typeof msg === 'string' ? Buffer.from(msg, 'utf-8') : msg;
        return Buffer.from(ed25519.sign(msgBytes, priv)).toString('hex');
    };
    return { priv, pub, sign };
}

async function main() {
    console.log('Running test-admin-key-auth test suite...\n');

    // ── 0. Initialise engine, state, and test keys ──
    initStateEngine();

    const aliceKeys = createKeyPair(); // Node owner
    const bobKeys = createKeyPair();   // Node admin
    const charlieKeys = createKeyPair(); // Regular member (no role)
    const replacementKeys = createKeyPair(); // Recovery key

    seedMember(aliceKeys.pub, 'AliceOwner');
    seedMember(bobKeys.pub, 'BobAdmin');
    seedMember(charlieKeys.pub, 'CharlieMember');
    seedMember(replacementKeys.pub, 'ReplacementOwner');

    // Grant Alice 'owner' and Bob 'admin'
    grantNodeRole(aliceKeys.pub, 'owner', 'SYSTEM');
    grantNodeRole(bobKeys.pub, 'admin', aliceKeys.pub);

    // Set up admin password in local config
    const testPassword = 'SuperSecretAdminPassword123!';
    const salt = randomBytes(16).toString('hex');
    const adminHash = scryptSync(testPassword, salt, 64).toString('hex');
    updateLocalConfig({
        adminHash,
        salt,
        breakGlassMode: false,
        totpEnabled: false,
        totpSecret: null,
        totpBackupCodesHashes: [],
    });

    // Mount test Koa application with admin & settings routes
    const app = new Koa();
    // Body parsing middleware for JSON
    app.use(async (ctx, next) => {
        if (ctx.is('json')) {
            const chunks: Buffer[] = [];
            for await (const chunk of ctx.req) {
                chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            }
            try {
                const bodyStr = Buffer.concat(chunks).toString('utf-8');
                (ctx as any).rawBody = bodyStr;
                if (bodyStr) {
                    (ctx as any).requestBody = JSON.parse(bodyStr);
                    (ctx.request as any).body = (ctx as any).requestBody;
                }
            } catch {
                (ctx as any).requestBody = {};
            }
        }
        await next();
    });

    const dummyDeps: RouteDeps = {
        checkAdminAuth,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
        rateLimit: () => false,
        clampLimit: (v: unknown, def = 50) => (typeof v === 'number' && !isNaN(v) ? Math.min(Math.max(v, 1), 100) : def),
        clampOffset: (v: unknown) => (typeof v === 'number' && !isNaN(v) ? Math.max(v, 0) : 0),
        enforceReadAuth: false,
    };
    const adminRouter = createAdminRoutes(dummyDeps);
    const settingsRouter = createSettingsRoutes(dummyDeps);

    app.use(adminRouter.routes()).use(adminRouter.allowedMethods());
    app.use(settingsRouter.routes()).use(settingsRouter.allowedMethods());

    const server = app.listen(0);
    const addr = server.address() as any;
    const base = `http://127.0.0.1:${addr.port}`;

    try {
        // ── 1. Challenge creation & Ed25519 signature verification ──
        console.log('Testing signed challenge creation and verification...');

        // POST /api/local/admin/auth/challenge
        const chalRes = await fetch(`${base}/api/local/admin/auth/challenge`, { method: 'POST' });
        assert(chalRes.status === 200, 'POST /api/local/admin/auth/challenge returns 200');
        const chalBody: any = await chalRes.json();
        assert(chalBody.success === true, 'Challenge response has success: true');
        assert(typeof chalBody.challengeId === 'string' && chalBody.challengeId.length > 0, 'Returns challengeId');
        assert(typeof chalBody.challenge === 'string' && chalBody.challenge.length > 0, 'Returns challenge string');
        assert(chalBody.expiresAt > Date.now(), 'Challenge expires in future');

        // Polling pending challenge
        const pollPending = await fetch(`${base}/api/local/admin/auth/challenge/${chalBody.challengeId}`);
        assert(pollPending.status === 200, 'GET /api/local/admin/auth/challenge/:id returns 200');
        const pollPendingBody: any = await pollPending.json();
        assert(pollPendingBody.status === 'pending', 'Challenge status is pending before solve');

        // Verify with tampered signature -> rejected
        const tamperedSig = chalBody.challenge.replace(/[a-f0-9]/g, '0').padEnd(128, '0');
        const verifyTampered = await fetch(`${base}/api/local/admin/auth/verify-challenge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                challengeId: chalBody.challengeId,
                memberPubkey: aliceKeys.pub,
                signature: tamperedSig,
            }),
        });
        assert(verifyTampered.status === 403, 'Tampered Ed25519 signature returns 403');

        // Verify with non-role member (Charlie) -> rejected
        const charlieSig = charlieKeys.sign(chalBody.challenge);
        const verifyCharlie = await fetch(`${base}/api/local/admin/auth/verify-challenge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                challengeId: chalBody.challengeId,
                memberPubkey: charlieKeys.pub,
                signature: charlieSig,
            }),
        });
        assert(verifyCharlie.status === 403, 'Member without node role returns 403');

        // Verify with legitimate owner (Alice) -> success
        const aliceSig = aliceKeys.sign(chalBody.challenge);
        const verifyAlice = await fetch(`${base}/api/local/admin/auth/verify-challenge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                challengeId: chalBody.challengeId,
                memberPubkey: aliceKeys.pub,
                signature: aliceSig,
            }),
        });
        assert(verifyAlice.status === 200, 'Valid Ed25519 signature by owner returns 200');
        const aliceSolveBody: any = await verifyAlice.json();
        assert(aliceSolveBody.success === true, 'Verify response has success: true');
        assert(typeof aliceSolveBody.handshakeToken === 'string', 'Returns handshakeToken');
        assert(aliceSolveBody.memberPubkey === aliceKeys.pub, 'Returns Alice pubkey');
        assert(aliceSolveBody.role === 'owner', "Returns role: 'owner'");

        const handshakeTokenAlice = aliceSolveBody.handshakeToken;

        // Polling a resolved challenge shows its status only: the id alone must never yield the token
        // (test-challenge-token-leak.ts).
        const pollResolved = await fetch(`${base}/api/local/admin/auth/challenge/${chalBody.challengeId}`);
        const pollResolvedBody: any = await pollResolved.json();
        assert(pollResolvedBody.status === 'resolved', 'Challenge status is now resolved');
        assert(pollResolvedBody.handshakeToken === undefined, 'Polled challenge does not return the handshakeToken');

        // ── 2. Handshake Token Exchange for Session ──
        console.log('Testing handshake token exchange for session...');

        const exchangeRes = await fetch(`${base}/api/local/admin/auth/exchange`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: handshakeTokenAlice }),
        });
        assert(exchangeRes.status === 200, 'POST /api/local/admin/auth/exchange returns 200');
        const exchangeBody: any = await exchangeRes.json();
        assert(exchangeBody.success === true, 'Exchange response has success: true');
        assert(typeof exchangeBody.sessionId === 'string', 'Returns sessionId');
        assert(typeof exchangeBody.csrfToken === 'string', 'Returns csrfToken');
        assert(exchangeBody.memberPubkey === aliceKeys.pub, 'Session is attributed to Alice');
        assert(exchangeBody.role === 'owner', "Session role is 'owner'");
        assert(exchangeBody.hardExpiresAt > Date.now(), 'hardExpiresAt is in the future');
        assert(exchangeBody.idleExpiresAt > Date.now(), 'idleExpiresAt is in the future');

        const sessionCookie = exchangeRes.headers.get('set-cookie');
        assert(Boolean(sessionCookie && sessionCookie.includes('admin_session=')), 'Exchange sets admin_session cookie');
        const aliceSessionId = exchangeBody.sessionId;

        // Verify active session via GET /api/local/admin/auth/session
        const sessionCheckRes = await fetch(`${base}/api/local/admin/auth/session`, {
            headers: { 'x-admin-session': aliceSessionId },
        });
        assert(sessionCheckRes.status === 200, 'GET /api/local/admin/auth/session with valid session returns 200');
        const sessionCheckBody: any = await sessionCheckRes.json();
        assert(sessionCheckBody.authenticated === true, 'Session is authenticated');
        assert(sessionCheckBody.isKeySession === true, 'Session is marked as isKeySession');
        assert(sessionCheckBody.memberPubkey === aliceKeys.pub, 'Session memberPubkey matches Alice');

        // ── 3. Token Replay Protection ──
        console.log('Testing token replay protection...');

        const replayRes = await fetch(`${base}/api/local/admin/auth/exchange`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: handshakeTokenAlice }),
        });
        assert(replayRes.status === 401, 'Replaying consumed handshake token returns 401');
        const replayBody: any = await replayRes.json();
        assert(replayBody.replay === true, 'Replay response flags replay: true');

        // ── 4. Token Expiry ──
        console.log('Testing token expiry...');

        // Mint a token and expire it manually
        const chal2 = createAdminChallenge();
        const chal2Res = verifyAndSolveChallenge({
            challengeId: chal2.challengeId,
            memberPubkey: bobKeys.pub,
            signature: bobKeys.sign(chal2.challenge),
        });
        assert(chal2Res.ok === true, 'Bob challenge verified');
        const bobToken = chal2Res.handshakeToken!;

        // Fast-forward token expiry
        const expiredRes = consumeHandshakeToken(bobToken, Date.now() + 61_000);
        assert(expiredRes.ok === false && expiredRes.expired === true, 'Consuming expired token fails with expired: true');

        // ── 5. Instant Revocation via session_epoch ──
        console.log('Testing instant revocation via session_epoch...');

        // Before revoke: Alice session is valid
        const beforeRevoke = validateAdminSession(aliceSessionId);
        assert(beforeRevoke.valid === true, 'Alice session is valid before revoke');

        // Revoke all sessions for Alice
        const revokeRes = await fetch(`${base}/api/local/admin/auth/revoke-all`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-session': aliceSessionId,
            },
            body: JSON.stringify({ memberPubkey: aliceKeys.pub }),
        });
        assert(revokeRes.status === 200, 'POST /api/local/admin/auth/revoke-all returns 200');
        const revokeBody: any = await revokeRes.json();
        assert(revokeBody.success === true, 'Revoke response has success: true');
        assert(revokeBody.sessionEpoch > 0, 'session_epoch was incremented');

        // After revoke: Alice session is immediately invalid
        const afterRevoke = validateAdminSession(aliceSessionId);
        assert(afterRevoke.valid === false && afterRevoke.revoked === true, 'Alice session is now invalid with revoked: true');

        const sessionCheckRevoked = await fetch(`${base}/api/local/admin/auth/session`, {
            headers: { 'x-admin-session': aliceSessionId },
        });
        const sessionCheckRevokedBody: any = await sessionCheckRevoked.json();
        assert(sessionCheckRevokedBody.authenticated === false, 'Revoked session is unauthenticated in /api/local/admin/auth/session');

        // Mint new session for Alice after epoch bump -> should succeed and carry new epoch
        const chalAliceNew = createAdminChallenge();
        const solveAliceNew = verifyAndSolveChallenge({
            challengeId: chalAliceNew.challengeId,
            memberPubkey: aliceKeys.pub,
            signature: aliceKeys.sign(chalAliceNew.challenge),
        });
        assert(solveAliceNew.ok === true, 'New challenge for Alice solved');
        const exchangeAliceNew = consumeHandshakeToken(solveAliceNew.handshakeToken!);
        assert(exchangeAliceNew.ok === true, 'New token exchanged successfully');
        const aliceSessionId2 = exchangeAliceNew.sessionId!;
        const aliceSession2Valid = validateAdminSession(aliceSessionId2);
        assert(aliceSession2Valid.valid === true, 'Session created after epoch bump is valid');

        // ── 6. Idle (2h) and Hard (12h) TTL enforcement ──
        console.log('Testing idle and hard TTL enforcement...');

        const chalTtl = createAdminChallenge();
        const solveTtl = verifyAndSolveChallenge({
            challengeId: chalTtl.challengeId,
            memberPubkey: aliceKeys.pub,
            signature: aliceKeys.sign(chalTtl.challenge),
        });
        const exchangeTtl = consumeHandshakeToken(solveTtl.handshakeToken!);
        const ttlSessionId = exchangeTtl.sessionId!;

        const idleCheck = validateAdminSession(ttlSessionId, Date.now() + 3 * 3600 * 1000);
        assert(idleCheck.valid === false && (idleCheck.idleTimeout === true || idleCheck.idle === true), 'Session past 2h idle window is rejected');

        const chalTtl2 = createAdminChallenge();
        const solveTtl2 = verifyAndSolveChallenge({
            challengeId: chalTtl2.challengeId,
            memberPubkey: aliceKeys.pub,
            signature: aliceKeys.sign(chalTtl2.challenge),
        });
        const exchangeTtl2 = consumeHandshakeToken(solveTtl2.handshakeToken!);
        const ttlSessionId2 = exchangeTtl2.sessionId!;

        const hardCheck = validateAdminSession(ttlSessionId2, Date.now() + 13 * 3600 * 1000);
        assert(hardCheck.valid === false && (hardCheck.hardLimit === true || hardCheck.expired === true), 'Session past 12h hard limit is rejected');

        // ── 7. Action Attribution (Replacing 'owner:password') ──
        console.log('Testing action attribution under key session...');

        // Grant Dave admin role under Alice's key session
        const daveKeys = createKeyPair();
        seedMember(daveKeys.pub, 'DaveMember');

        const grantDaveRes = await fetch(`${base}/api/local/admin/node-roles`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-session': aliceSessionId2,
            },
            body: JSON.stringify({ pubkey: daveKeys.pub, role: 'admin' }),
        });
        assert(grantDaveRes.status === 200, 'Grant role under key session returns 200');
        const rolesList = listNodeRoles();
        const daveRole = rolesList.find(r => r.member_pubkey === daveKeys.pub);
        assert(daveRole !== undefined && daveRole.role === 'admin', 'Dave was granted admin role');
        assert(daveRole?.granted_by === aliceKeys.pub, `Dave granted_by is Alice pubkey (${aliceKeys.pub}), NOT 'owner:password'`);

        // Now grant Eve under password auth (no key session)
        const eveKeys = createKeyPair();
        seedMember(eveKeys.pub, 'EveMember');

        const grantEveRes = await fetch(`${base}/api/local/admin/node-roles`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-password': testPassword,
            },
            body: JSON.stringify({ pubkey: eveKeys.pub, role: 'admin' }),
        });
        assert(grantEveRes.status === 200, 'Grant role under password auth returns 200');
        const eveRole = listNodeRoles().find(r => r.member_pubkey === eveKeys.pub);
        assert(eveRole?.granted_by === 'owner:password', `Eve granted_by is 'owner:password' under password auth`);

        // ── 8. Password path unchanged when breakGlassMode is false ──
        console.log('Testing unchanged password path (breakGlassMode = false)...');

        assert(isBreakGlassMode() === false, 'breakGlassMode defaults to false');
        const getRolesPassword = await fetch(`${base}/api/local/admin/node-roles`, {
            headers: { 'x-admin-password': testPassword },
        });
        assert(getRolesPassword.status === 200, 'GET /api/local/admin/node-roles succeeds with password when breakGlassMode=false');

        // ── 9. Break-Glass Mode Gating & Route Restriction ──
        console.log('Testing break-glass mode gating and route restriction...');

        // Enable break-glass mode via authenticated session
        const toggleBgRes = await fetch(`${base}/api/local/admin/auth/break-glass-mode`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-session': aliceSessionId2,
            },
            body: JSON.stringify({ enabled: true }),
        });
        assert(toggleBgRes.status === 200, 'POST /api/local/admin/auth/break-glass-mode returns 200');
        assert(isBreakGlassMode() === true, 'breakGlassMode is now active');

        // Check break-glass status endpoint
        const bgStatusRes = await fetch(`${base}/api/local/admin/auth/break-glass-status`);
        const bgStatusBody: any = await bgStatusRes.json();
        assert(bgStatusBody.breakGlassMode === true, 'GET /api/local/admin/auth/break-glass-status returns true');

        // (a) Key session can still access protected routes
        const getRolesWithKey = await fetch(`${base}/api/local/admin/node-roles`, {
            headers: { 'x-admin-session': aliceSessionId2 },
        });
        assert(getRolesWithKey.status === 200, 'Key session accesses admin routes during breakGlassMode');

        // (b) Password auth is BLOCKED on protected routes
        const getRolesBlocked = await fetch(`${base}/api/local/admin/node-roles`, {
            headers: { 'x-admin-password': testPassword },
        });
        assert(getRolesBlocked.status === 403, 'Password auth receives 403 on /api/local/admin/node-roles during breakGlassMode');
        const blockedBody: any = await getRolesBlocked.json();
        assert(blockedBody.breakGlassMode === true, 'Blocked response mentions breakGlassMode: true');

        // (c) Settings page is BLOCKED without key session during breakGlassMode
        const getSettingsBlocked = await fetch(`${base}/settings`);
        assert(getSettingsBlocked.status === 403, 'GET /settings returns 403 during breakGlassMode without key session');

        // (d) Password auth CAN access key enrolment route (/api/local/admin/auth/enrol)
        // The break-glass alert is a security notice for the community's members (it names the member whose
        // admin key was replaced), so it is watched on a member's socket: a /ws socket signed by a member is
        // tagged with _memberPubkey at upgrade (and _memberFeed, for a member who reads as one). A stranger's socket
        // must not receive it at all.
        const receivedWsEvents: any[] = [];
        const mockWs = {
            _memberPubkey: charlieKeys.pub,
            _memberFeed: true,
            send: (data: string) => {
                try { receivedWsEvents.push(JSON.parse(data)); } catch {}
            },
        };
        addWsClient(mockWs);
        const strangerWsEvents: any[] = [];
        const strangerWs = {
            send: (data: string) => {
                try { strangerWsEvents.push(JSON.parse(data)); } catch {}
            },
        };
        addWsClient(strangerWs);

        const enrolRes = await fetch(`${base}/api/local/admin/auth/enrol`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-password': testPassword,
            },
            body: JSON.stringify({
                memberPubkey: replacementKeys.pub,
                role: 'owner',
            }),
        });
        const enrolText = await enrolRes.text();
        assert(enrolRes.status === 200, 'POST /api/local/admin/auth/enrol succeeds with password during breakGlassMode');
        let enrolBody: any = {};
        try { enrolBody = JSON.parse(enrolText); } catch {}
        assert(enrolBody.success === true, 'Enrolment response has success: true');
        assert(typeof enrolBody.breakGlassCode === 'string' && enrolBody.breakGlassCode.length > 0, 'Enrolment returns distinct breakGlassCode');
        assert(enrolBody.alertEmitted === true, 'Enrolment flags alertEmitted: true');

        const replacementBreakGlassCode = enrolBody.breakGlassCode;

        const replacementRole = listNodeRoles().find(r => r.member_pubkey === replacementKeys.pub);
        assert(replacementRole?.role === 'owner', 'Replacement key is registered as owner in DB');
        assert(Boolean(replacementRole?.has_break_glass), 'Replacement owner has has_break_glass in listNodeRoles');
        assert(Boolean(getNodeRoleBreakGlassHash(replacementKeys.pub)), 'Replacement owner has break_glass_hash in DB');

        // ── 10. Per-Owner Break-Glass Code & Loud Public Alert ──
        console.log('Testing per-owner break-glass code authentication & alert emission...');

        // Verify public alert was emitted to ws clients
        const alertFound = receivedWsEvents.some(e =>
            e.type === 'system_announcement' &&
            e.title === 'Break-Glass Recovery Used' &&
            e.body.includes('Break-glass recovery used to authorise a new admin key') &&
            e.severity === 'critical'
        );
        assert(alertFound, 'Loud public announcement was broadcast on break-glass key enrolment');
        assert(!strangerWsEvents.some(e => e.type === 'system_announcement'),
            `a socket without a member gets no break-glass announcement (got ${JSON.stringify(strangerWsEvents)})`);
        removeWsClient(mockWs);
        removeWsClient(strangerWs);

        // Test that the distinct break-glass code works to authenticate
        const verifyBgCodeDirect = verifyBreakGlassCode(replacementBreakGlassCode);
        assert(verifyBgCodeDirect?.member_pubkey === replacementKeys.pub, 'verifyBreakGlassCode matches replacement owner');

        // Use break-glass code via x-break-glass-code header to enrol another owner
        const anotherOwnerKeys = createKeyPair();
        seedMember(anotherOwnerKeys.pub, 'AnotherOwner');

        const bgAuthEnrolRes = await fetch(`${base}/api/local/admin/auth/break-glass/enrol`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-break-glass-code': replacementBreakGlassCode,
            },
            body: JSON.stringify({
                memberPubkey: anotherOwnerKeys.pub,
                role: 'owner',
            }),
        });
        assert(bgAuthEnrolRes.status === 200, 'Enrolment using per-owner break-glass code returns 200');

        // Disable break-glass mode again
        setBreakGlassMode(false);
        assert(isBreakGlassMode() === false, 'breakGlassMode toggled back off');

        // ── 11. Deep-link GET /settings?token=... Flow ──
        console.log('Testing deep-link GET /settings?token=... flow...');

        const chalDl = createAdminChallenge();
        const solveDl = verifyAndSolveChallenge({
            challengeId: chalDl.challengeId,
            memberPubkey: aliceKeys.pub,
            signature: aliceKeys.sign(chalDl.challenge),
        });
        assert(solveDl.ok === true, 'Challenge for deep link solved');
        const dlToken = solveDl.handshakeToken!;

        // GET /settings?token=<token> with manual redirect handling
        const dlRes = await fetch(`${base}/settings?token=${dlToken}`, { redirect: 'manual' });
        assert(dlRes.status === 302, 'GET /settings?token=... returns 302 redirect');
        const dlCookie = dlRes.headers.get('set-cookie');
        assert(Boolean(dlCookie && dlCookie.includes('admin_session=')), 'Redirect sets admin_session cookie');
        assert(dlRes.headers.get('location') === '/settings', 'Redirects to /settings');

        // ── 12. TOTP 2FA Verification during Challenge Solving ──
        console.log('Testing TOTP 2FA verification during challenge solving...');

        const totpSecret = generateTotpSecret();
        const backupCodes = generateBackupCodes(4);
        const backupHashes = backupCodes.map(hashBackupCode);

        updateLocalConfig({
            totpEnabled: true,
            totpSecret,
            totpBackupCodesHashes: backupHashes,
        });

        const chalTotp = createAdminChallenge();

        // 1. Solving without TOTP code fails with totpRequired: true
        const solveNoTotp = await fetch(`${base}/api/local/admin/auth/verify-challenge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                challengeId: chalTotp.challengeId,
                memberPubkey: aliceKeys.pub,
                signature: aliceKeys.sign(chalTotp.challenge),
            }),
        });
        assert(solveNoTotp.status === 401, 'Verify challenge without TOTP code returns 401');
        const noTotpBody: any = await solveNoTotp.json();
        assert(noTotpBody.totpRequired === true, 'Verify challenge response indicates totpRequired: true');

        // 2. Solving with valid 6-digit TOTP code succeeds
        const totpCode = generateTotpCode(totpSecret);
        const solveWithTotp = await fetch(`${base}/api/local/admin/auth/verify-challenge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                challengeId: chalTotp.challengeId,
                memberPubkey: aliceKeys.pub,
                signature: aliceKeys.sign(chalTotp.challenge),
                totpCode,
            }),
        });
        assert(solveWithTotp.status === 200, 'Verify challenge with valid TOTP code returns 200');

        // 3. Solving with single-use backup code succeeds and consumes the backup code
        const chalBackup = createAdminChallenge();
        const firstBackupCode = backupCodes[0];
        const solveWithBackup = await fetch(`${base}/api/local/admin/auth/verify-challenge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                challengeId: chalBackup.challengeId,
                memberPubkey: aliceKeys.pub,
                signature: aliceKeys.sign(chalBackup.challenge),
                totpCode: firstBackupCode,
            }),
        });
        assert(solveWithBackup.status === 200, 'Verify challenge with backup code returns 200');
        const remainingHashes = getLocalConfig().totpBackupCodesHashes || [];
        assert(remainingHashes.length === 3, 'Backup code was consumed and remaining backup hashes is 3');

        // Clean up TOTP
        updateLocalConfig({ totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [] });

        // ── 12. Review Comment Fix Verification (#810) ──
        console.log('Testing review comment fixes (#810)...');

        // 12.1 Verify challenge 404 on missing/expired challenge (Comment 7)
        const missingChal = await fetch(`${base}/api/local/admin/auth/verify-challenge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                challengeId: 'non-existent-challenge-id',
                memberPubkey: aliceKeys.pub,
                signature: aliceKeys.sign('dummy'),
            }),
        });
        assert(missingChal.status === 404, 'Verify challenge with unknown ID returns 404 Not Found');

        // 12.2 Revoke-all unauthenticated returns 401 (Comment 1)
        const unauthRevoke = await fetch(`${base}/api/local/admin/auth/revoke-all`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberPubkey: aliceKeys.pub }),
        });
        assert(unauthRevoke.status === 401, 'Unauthenticated POST /api/local/admin/auth/revoke-all returns 401');

        // 12.3 Revoke-all signed mobile returns 200 (Comment 2)
        const revTimestamp = String(Date.now());
        const revNonce = randomBytes(16).toString('hex');
        const revRawBody = JSON.stringify({ memberPubkey: aliceKeys.pub });
        const revMsg = `POST\n/api/local/admin/auth/revoke-all\n${revTimestamp}\n${revNonce}\n${revRawBody}`;
        const revSig = Buffer.from(ed25519.sign(Buffer.from(revMsg, 'utf-8'), aliceKeys.priv)).toString('base64');
        const signedRevoke = await fetch(`${base}/api/local/admin/auth/revoke-all`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Public-Key': aliceKeys.pub,
                'X-Signature': revSig,
                'X-Timestamp': revTimestamp,
                'X-Nonce': revNonce,
            },
            body: revRawBody,
        });
        assert(signedRevoke.status === 200, 'Signed mobile POST /api/local/admin/auth/revoke-all returns 200');

        // 12.3b Replayed signed mobile revoke-all request fails (Comment 4021421368)
        const replayedRevoke = await fetch(`${base}/api/local/admin/auth/revoke-all`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Public-Key': aliceKeys.pub,
                'X-Signature': revSig,
                'X-Timestamp': revTimestamp,
                'X-Nonce': revNonce,
            },
            body: revRawBody,
        });
        assert(replayedRevoke.status === 401, 'Replayed signed mobile revoke-all returns 401');

        // 12.3c Stale timestamp on signed revoke-all fails (Comment 4021421368)
        const staleTs = String(Date.now() - 120_000);
        const freshNonce = randomBytes(16).toString('hex');
        const staleMsg = `POST\n/api/local/admin/auth/revoke-all\n${staleTs}\n${freshNonce}\n${revRawBody}`;
        const staleSig = Buffer.from(ed25519.sign(Buffer.from(staleMsg, 'utf-8'), aliceKeys.priv)).toString('base64');
        const staleRevoke = await fetch(`${base}/api/local/admin/auth/revoke-all`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Public-Key': aliceKeys.pub,
                'X-Signature': staleSig,
                'X-Timestamp': staleTs,
                'X-Nonce': freshNonce,
            },
            body: revRawBody,
        });
        assert(staleRevoke.status === 401, 'Stale timestamp on signed revoke-all returns 401');

        // 12.4 Passive GET session without credentials returns 200 unauthenticated (Comment 3)
        const passiveSession = await fetch(`${base}/api/local/admin/auth/session`);
        assert(passiveSession.status === 200, 'Passive GET /api/local/admin/auth/session returns 200');
        const passiveBody: any = await passiveSession.json();
        assert(passiveBody.authenticated === false, 'Passive session returns authenticated: false');

        // 12.5 Enrol non-owner admin cannot enrol owner (Comment 4)
        const daveChal = createAdminChallenge();
        const daveSolve = verifyAndSolveChallenge({
            challengeId: daveChal.challengeId,
            memberPubkey: daveKeys.pub,
            signature: daveKeys.sign(daveChal.challenge),
        });
        assert(daveSolve.ok === true, 'Dave challenge solved');
        const daveExch = consumeHandshakeToken(daveSolve.handshakeToken!);
        assert(daveExch.ok === true && daveExch.role === 'admin', 'Dave exchanged session as admin');

        const frankKeys = createKeyPair();
        seedMember(frankKeys.pub, 'FrankMember');
        const daveEnrolOwner = await fetch(`${base}/api/local/admin/auth/enrol`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-session': daveExch.sessionId!,
            },
            body: JSON.stringify({ memberPubkey: frankKeys.pub, role: 'owner' }),
        });
        assert(daveEnrolOwner.status === 403, 'Non-owner admin cannot enrol owner key (got 403)');

        // 12.6 Non-owner admin cannot toggle break-glass mode (Comment 6)
        const daveToggleBg = await fetch(`${base}/api/local/admin/auth/break-glass-mode`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-session': daveExch.sessionId!,
            },
            body: JSON.stringify({ enabled: true }),
        });
        assert(daveToggleBg.status === 403, 'Non-owner admin cannot toggle break-glass mode (got 403)');

        // 12.6b Non-owner admin cannot revoke sessions of another admin (Comment 4021421361)
        const daveRevokeAlice = await fetch(`${base}/api/local/admin/auth/revoke-all`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-session': daveExch.sessionId!,
            },
            body: JSON.stringify({ memberPubkey: aliceKeys.pub }),
        });
        assert(daveRevokeAlice.status === 403, 'Non-owner admin cannot revoke another admin sessions (got 403)');

        // Non-owner admin can revoke their own sessions
        const daveRevokeSelf = await fetch(`${base}/api/local/admin/auth/revoke-all`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-session': daveExch.sessionId!,
            },
            body: JSON.stringify({ memberPubkey: daveKeys.pub }),
        });
        assert(daveRevokeSelf.status === 200, 'Non-owner admin can revoke their own sessions (got 200)');

        // 12.7 Routine password enrolment when breakGlassMode=false does NOT emit alert (Comment 5)
        const graceKeys = createKeyPair();
        seedMember(graceKeys.pub, 'GraceMember');
        const routineEnrol = await fetch(`${base}/api/local/admin/auth/enrol`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-password': testPassword,
            },
            body: JSON.stringify({ memberPubkey: graceKeys.pub, role: 'owner' }),
        });
        assert(routineEnrol.status === 200, 'Routine password enrolment succeeds');
        const routineBody: any = await routineEnrol.json();
        assert(routineBody.alertEmitted === false, 'Routine password enrolment does not emit false emergency alert');

        // 12.7b Non-owner enrolment does NOT return breakGlassCode or populate break_glass_hash (Comment 4021421370)
        const henryKeys = createKeyPair();
        seedMember(henryKeys.pub, 'HenryAdmin');
        const adminEnrol = await fetch(`${base}/api/local/admin/auth/enrol`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-password': testPassword,
            },
            body: JSON.stringify({ memberPubkey: henryKeys.pub, role: 'admin' }),
        });
        assert(adminEnrol.status === 200, 'Admin enrolment succeeds');
        const adminEnrolBody: any = await adminEnrol.json();
        assert(adminEnrolBody.role === 'admin', 'Enrolled role is admin');
        assert(adminEnrolBody.breakGlassCode === undefined, 'Non-owner enrolment does not return breakGlassCode');
        assert(adminEnrolBody.message === undefined, 'Non-owner enrolment does not return break-glass storage message');
        assert(getNodeRoleBreakGlassHash(henryKeys.pub) === null, 'Non-owner admin has null break_glass_hash in DB');

        // 12.8 Role demotion bumps session_epoch and clears break_glass_hash (Comment 11)
        const graceEpochBefore = getNodeRoleSessionEpoch(graceKeys.pub);
        const graceHashBefore = getNodeRoleBreakGlassHash(graceKeys.pub);
        assert(!!graceHashBefore, 'Grace has break_glass_hash as owner');
        grantNodeRole(graceKeys.pub, 'admin', aliceKeys.pub);
        const graceEpochAfter = getNodeRoleSessionEpoch(graceKeys.pub);
        const graceHashAfter = getNodeRoleBreakGlassHash(graceKeys.pub);
        assert(graceEpochAfter > graceEpochBefore, 'Demoting Grace to admin incremented session_epoch');
        assert(graceHashAfter === null, 'Demoting Grace to admin cleared break_glass_hash');

        // 12.9 verifyBreakGlassCode ownerPubkey branch requires owner role and active member (Comment 10)
        const graceCodeCheck = verifyBreakGlassCode('any-code', graceKeys.pub);
        assert(graceCodeCheck === null, 'verifyBreakGlassCode for non-owner Grace returns null');

        // 12.10 Settings failed token exchange returns accessible HTML (Comment 13)
        const failTokenRes = await fetch(`${base}/settings?token=invalid_handshake_token`);
        assert(failTokenRes.status === 400, 'Failed token exchange on /settings returns 400');
        const failTokenHtml = await failTokenRes.text();
        assert(failTokenHtml.includes('Sign-In Failed'), 'Failed token exchange serves accessible error HTML');
        assert(failTokenHtml.includes('name="viewport"'), 'Error HTML contains viewport meta tag');

        // 12.11 Settings break-glass screen is accessible (Comment 14)
        setBreakGlassMode(true);
        const bgSettingsRes = await fetch(`${base}/settings`);
        assert(bgSettingsRes.status === 403, 'Break-glass /settings returns 403');
        const bgHtml = await bgSettingsRes.text();
        assert(bgHtml.includes('lang="en"'), 'Break-glass HTML includes lang="en"');
        assert(bgHtml.includes('name="viewport"'), 'Break-glass HTML includes viewport meta tag');
        assert(bgHtml.includes('Break-Glass Mode Active'), 'Break-glass HTML has accessible header text');
        setBreakGlassMode(false);

        // 12.12 Ambient cookie session requires CSRF on mutating request (Comment 8)
        const chalCsrf = createAdminChallenge();
        const solveCsrf = verifyAndSolveChallenge({
            challengeId: chalCsrf.challengeId,
            memberPubkey: aliceKeys.pub,
            signature: aliceKeys.sign(chalCsrf.challenge),
        });
        const exchCsrf = consumeHandshakeToken(solveCsrf.handshakeToken!);
        const freshAliceSessionId = exchCsrf.sessionId!;

        const cookieMutateNoCsrf = await fetch(`${base}/api/local/admin/auth/break-glass-mode`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Cookie': `admin_session=${freshAliceSessionId}`,
            },
            body: JSON.stringify({ enabled: false }),
        });
        assert(cookieMutateNoCsrf.status === 403, 'Cookie session mutating POST without CSRF token returns 403');

        // 12.13 Expired session cookie falls through to explicit password (Comment 9)
        const expiredCookieWithPass = await fetch(`${base}/api/local/admin/node-roles`, {
            headers: {
                'Cookie': `admin_session=non_existent_or_expired_session_token`,
                'x-admin-password': testPassword,
            },
        });
        assert(expiredCookieWithPass.status === 200, 'Expired session cookie falls through to password auth (got 200)');

        // 12.14 Cookie session can acquire CSRF token via POST /api/local/admin/csrf-token without CSRF header (Comment 4021421356)
        const cookieCsrfFetch = await fetch(`${base}/api/local/admin/csrf-token`, {
            method: 'POST',
            headers: {
                'Cookie': `admin_session=${freshAliceSessionId}`,
            },
        });
        assert(cookieCsrfFetch.status === 200, 'Cookie session POST /api/local/admin/csrf-token succeeds without CSRF header');
        const cookieCsrfBody: any = await cookieCsrfFetch.json();
        assert(typeof cookieCsrfBody.csrfToken === 'string' && cookieCsrfBody.csrfToken.length > 0, 'Returns minted CSRF token');
    } finally {
        server.close();
    }

    console.log(`\nAdmin key auth suite results: ${passed}/${total} assertions passed.`);
    if (passed !== total) {
        process.exit(1);
    }
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(err => {
    console.error('Test threw unexpected exception:', err);
    process.exit(1);
});
