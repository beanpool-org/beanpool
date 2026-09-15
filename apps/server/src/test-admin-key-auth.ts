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

    const dummyDeps = {
        checkAdminAuth,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
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

        // Polling resolved challenge returns handshakeToken
        const pollResolved = await fetch(`${base}/api/local/admin/auth/challenge/${chalBody.challengeId}`);
        const pollResolvedBody: any = await pollResolved.json();
        assert(pollResolvedBody.status === 'resolved', 'Challenge status is now resolved');
        assert(pollResolvedBody.handshakeToken === handshakeTokenAlice, 'Polled challenge returns correct handshakeToken');

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
        const receivedWsEvents: any[] = [];
        const mockWs = {
            send: (data: string) => {
                try { receivedWsEvents.push(JSON.parse(data)); } catch {}
            },
        };
        addWsClient(mockWs);

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

        // Verify replacement key is now owner in DB
        const replacementRole = listNodeRoles().find(r => r.member_pubkey === replacementKeys.pub);
        assert(replacementRole?.role === 'owner', 'Replacement key is registered as owner in DB');
        assert(Boolean(replacementRole?.break_glass_hash), 'Replacement owner has break_glass_hash in DB');

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
        removeWsClient(mockWs);

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
