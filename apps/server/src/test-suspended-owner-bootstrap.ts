/**
 * A suspended sole owner no longer lets an admin make themselves owner (#1006).
 *
 * `grantNodeRole` has a deliberate BOOTSTRAP branch: on a node with no owner, a signed-in admin may
 * create the first one, so a fresh node is never ownerless. It used to ask "are there any ACTIVE
 * owners?", and a community Decision that suspends an owner parks their role in
 * `suspended_node_roles` and stops them being active — so a node whose only owner was suspended read
 * as ownerless, and ANY admin key session could POST /api/local/admin/node-roles {role:'owner'} for
 * itself. `handleEnrol` already refused the same thing; the asymmetry was the bug.
 *
 * `nodeHasOwner()` now answers that one question for both routes — they both reach it through
 * `grantNodeRole` — and counts a parked owner role: a community that suspended its owner still has
 * one.
 *
 * HOW THE STATE IS REACHED HERE. A node's LAST ACTIVE owner cannot be suspended (`isSoleOwner`
 * guards `adminEmergencySuspend` and the Decision preflight), so the setup below does what the live
 * path does: two owners, a Decision-backed suspension parks the first one's role, and the second
 * then leaves by a route that takes an owner out without parking anything. That is the state #1006
 * describes — zero active owners, one held aside.
 *
 * Every refusal is checked over HTTP through the REAL `checkAdminAuth` and the real Ed25519
 * challenge/exchange, never by calling the router or the engine directly: a route test that skipped
 * the middleware once hid a real break for weeks.
 *
 * Covers:
 *   1. Fresh node, no owner at all: an admin key session bootstraps the first owner -> allowed.
 *   2. Sole owner suspended: the enrol path refuses an admin key session owner grant -> 403 (it was
 *      already guarded; pinned here).
 *   3. The same node: an admin KEY session asking for owner for itself -> 403, and no row is written.
 *   4. The same node, the admin PASSWORD session grants owner -> allowed (the operator's way out).
 *   5. The suspended owner reinstated -> their owner role is back, and the owners are exactly those
 *      expected.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-suspended-owner-bootstrap.ts
 */

import { randomBytes, scryptSync } from 'node:crypto';
import Koa from 'koa';
import { ed25519 } from '@noble/curves/ed25519.js';
import { db } from './db/db.js';
import {
    initStateEngine,
    grantNodeRole,
    listNodeRoles,
    nodeRoleOf,
    isNodeOwner,
    adminSetUserStatus,
} from './state-engine.js';
import { adminEmergencySuspend, adminLiftSuspension } from './decisions-engine.js';
import { checkAdminAuth } from './admin-auth.js';
import { updateLocalConfig } from './config/local-config.js';
import { createAdminRoutes } from './routes/admin.js';
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
    const sign = (msg: string) => Buffer.from(ed25519.sign(Buffer.from(msg, 'utf-8'), priv)).toString('hex');
    return { priv, pub, sign };
}

/** The owners this node currently has, as the roles list reports them. */
function activeOwners(): string[] {
    return listNodeRoles().filter(r => r.role === 'owner').map(r => r.member_pubkey).sort();
}

/** Owner roles parked by a suspension — what the community gets back if it lifts one. */
function parkedOwners(): string[] {
    return (db.prepare("SELECT member_pubkey FROM suspended_node_roles WHERE role = 'owner'").all() as { member_pubkey: string }[])
        .map(r => r.member_pubkey).sort();
}

async function main() {
    console.log('Running test-suspended-owner-bootstrap test suite...\n');

    initStateEngine();

    const testPassword = 'SuperSecretAdminPassword123!';
    const salt = randomBytes(16).toString('hex');
    updateLocalConfig({
        adminHash: scryptSync(testPassword, salt, 64).toString('hex'),
        salt,
        breakGlassMode: false,
        totpEnabled: false,
        totpSecret: null,
        totpBackupCodesHashes: [],
    });

    const bella = createKeyPair();   // founding admin, then the node's first owner
    const olivia = createKeyPair();  // the owner the community suspends
    const adam = createKeyPair();    // the admin who tries to promote himself
    const priya = createKeyPair();   // the recovery owner the password appoints
    seedMember(bella.pub, 'BellaFounder');
    seedMember(olivia.pub, 'OliviaOwner');
    seedMember(adam.pub, 'AdamAdmin');
    seedMember(priya.pub, 'PriyaRecovery');

    const app = new Koa();
    app.use(async (ctx, next) => {
        if (ctx.is('json')) {
            const chunks: Buffer[] = [];
            for await (const chunk of ctx.req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            const bodyStr = Buffer.concat(chunks).toString('utf-8');
            (ctx as any).rawBody = bodyStr;
            try {
                (ctx as any).requestBody = bodyStr ? JSON.parse(bodyStr) : {};
                (ctx.request as any).body = (ctx as any).requestBody;
            } catch {
                (ctx as any).requestBody = {};
            }
        }
        await next();
    });

    const deps: RouteDeps = {
        checkAdminAuth,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
        rateLimit: () => false,
        clampLimit: (v: unknown, def = 50) => (typeof v === 'number' && !isNaN(v) ? Math.min(Math.max(v, 1), 100) : def),
        clampOffset: (v: unknown) => (typeof v === 'number' && !isNaN(v) ? Math.max(v, 0) : 0),
        enforceReadAuth: false,
    };
    const adminRouter = createAdminRoutes(deps);
    app.use(adminRouter.routes()).use(adminRouter.allowedMethods());

    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as any).port}`;

    /** A real admin session: challenge, Ed25519 signature, handshake token, exchange. */
    async function openKeySession(keys: { pub: string; sign: (m: string) => string }): Promise<string> {
        const chal: any = await (await fetch(`${base}/api/local/admin/auth/challenge`, { method: 'POST' })).json();
        const verify = await fetch(`${base}/api/local/admin/auth/verify-challenge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ challengeId: chal.challengeId, memberPubkey: keys.pub, signature: keys.sign(chal.challenge) }),
        });
        const solved: any = await verify.json();
        if (verify.status !== 200 || !solved.handshakeToken) {
            throw new Error(`could not open a key session for ${keys.pub.slice(0, 8)}: ${verify.status} ${JSON.stringify(solved)}`);
        }
        const exch = await fetch(`${base}/api/local/admin/auth/exchange`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: solved.handshakeToken }),
        });
        const session: any = await exch.json();
        if (exch.status !== 200 || !session.sessionId) {
            throw new Error(`handshake exchange failed for ${keys.pub.slice(0, 8)}: ${exch.status} ${JSON.stringify(session)}`);
        }
        return session.sessionId;
    }

    try {
        // — 1. A fresh node with no owner at all still bootstraps its first owner —
        console.log('Testing the bootstrap of a node that has no owner at all...');

        grantNodeRole(bella.pub, 'admin', 'SYSTEM');
        assert(activeOwners().length === 0 && parkedOwners().length === 0, 'the node starts with no owner, active or parked');

        const bellaSession = await openKeySession(bella);
        const bootstrap = await fetch(`${base}/api/local/admin/node-roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-session': bellaSession },
            body: JSON.stringify({ pubkey: bella.pub, role: 'owner' }),
        });
        assert(bootstrap.status === 200, `an admin key session takes the owner role on a node with no owner (got ${bootstrap.status})`);
        assert(isNodeOwner(bella.pub) === true, 'that admin is now the node owner');

        // — 2. Set up the state #1006 describes: zero active owners, one parked by a suspension —
        console.log('\nSuspending the owner the community voted on, and losing the other owner...');

        grantNodeRole(olivia.pub, 'owner', bella.pub);
        assert(activeOwners().length === 2, 'the node now has two owners');

        const suspend = adminEmergencySuspend(olivia.pub, 'owner:password', 'The community asked for this while a dispute is heard.');
        assert(suspend.success === true, 'a Decision-backed suspension of an owner succeeds while a co-owner remains');
        assert(parkedOwners().includes(olivia.pub), "the suspended owner's role is parked in suspended_node_roles");

        // The remaining owner leaves by a route that does not park a role (a disabled or pruned owner).
        adminSetUserStatus(bella.pub, 'disabled');
        assert(activeOwners().length === 0, 'no ACTIVE owner is left on the node');
        assert(parkedOwners().length === 1 && parkedOwners()[0] === olivia.pub, 'exactly one owner role is held aside');

        // — 3. An admin key session cannot use that as a bootstrap —
        console.log('\nTesting the admin key session against the suspended-owner node...');

        grantNodeRole(adam.pub, 'admin', 'owner:password');
        const adamSession = await openKeySession(adam);

        // The enrol path FIRST, and on its own: it was already guarded, and this pins that. Run after the
        // node-roles attempt it would prove nothing on a node that still has the bug — the successful
        // grant bumps the admin's session epoch, so every later call is a 401 rather than a refusal.
        const enrolSelf = await fetch(`${base}/api/local/admin/auth/enrol`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-session': adamSession },
            body: JSON.stringify({ memberPubkey: adam.pub, role: 'owner' }),
        });
        assert(enrolSelf.status === 403, `the enrol route refuses an admin key session asking for owner (got ${enrolSelf.status})`);
        assert(nodeRoleOf(adam.pub) === 'admin', 'the admin still holds only the admin role after the enrol attempt');
        assert(activeOwners().length === 0, 'no owner role row was written by the enrol attempt');

        const selfPromote = await fetch(`${base}/api/local/admin/node-roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-session': adamSession },
            body: JSON.stringify({ pubkey: adam.pub, role: 'owner' }),
        });
        const selfPromoteBody: any = await selfPromote.json();
        assert(selfPromote.status === 403, `an admin key session asking for owner for itself is refused with 403 (got ${selfPromote.status})`);
        assert(/currently suspended/.test(String(selfPromoteBody.error)),
            `the refusal names the suspended owner and the way out — "${selfPromoteBody.error}"`);
        assert(nodeRoleOf(adam.pub) === 'admin', 'that admin still holds only the admin role');
        assert(activeOwners().length === 0, 'no owner role row was written');

        // The same key session cannot hand the owner role to anyone else either.
        const promoteAlly = await fetch(`${base}/api/local/admin/node-roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-session': adamSession },
            body: JSON.stringify({ pubkey: priya.pub, role: 'owner' }),
        });
        assert(promoteAlly.status === 403, `nor may that admin make someone else an owner (got ${promoteAlly.status})`);
        assert(nodeRoleOf(priya.pub) === null, 'and that member holds no role');

        // — 4. The admin PASSWORD is owner-level: the node is never stranded —
        console.log('\nTesting the operator password on the same node...');

        const passwordGrant = await fetch(`${base}/api/local/admin/node-roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-password': testPassword },
            body: JSON.stringify({ pubkey: priya.pub, role: 'owner' }),
        });
        assert(passwordGrant.status === 200, `the password-authenticated session may still appoint an owner (got ${passwordGrant.status})`);
        assert(isNodeOwner(priya.pub) === true, 'the operator has appointed a working owner');
        const priyaRole = listNodeRoles().find(r => r.member_pubkey === priya.pub);
        assert(priyaRole?.granted_by === 'owner:password', "the grant is attributed to 'owner:password'");

        // — 5. Reinstating the suspended owner gives the role back —
        console.log('\nTesting reinstatement of the suspended owner...');

        const lift = adminLiftSuspension(olivia.pub, 'owner:password');
        assert(lift.success === true, `the suspension lifts (${lift.error || 'no error'})`);
        assert(isNodeOwner(olivia.pub) === true, 'the reinstated owner holds the owner role again');
        assert(parkedOwners().length === 0, 'nothing is held aside for them any more');
        assert(
            JSON.stringify(activeOwners()) === JSON.stringify([olivia.pub, priya.pub].sort()),
            'the node has exactly the expected owners: the reinstated one and the one the operator appointed',
        );
        assert(nodeRoleOf(adam.pub) === 'admin', 'and the admin who tried to promote himself never became one');
    } finally {
        server.close();
    }

    console.log(`\nSuspended-owner bootstrap suite results: ${passed}/${total} assertions passed.`);
    if (passed !== total) {
        process.exit(1);
    }
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(err => {
    console.error('Test threw unexpected exception:', err);
    process.exit(1);
});
