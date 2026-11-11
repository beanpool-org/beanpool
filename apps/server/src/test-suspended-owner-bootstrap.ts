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
 *   4. The same node: the operator's way out is the server's shell, `beanpool recover`, which appoints an owner
 *      (the node has no admin password, Marty 11 Nov 2026: an old one in the header appoints nobody, 401).
 *   5. The suspended owner reinstated -> their owner role is back, and the owners are exactly those
 *      expected.
 *   6. A suspended owner deletes their own account -> the role held aside for them goes with them, the
 *      node honestly reports no owner, and the bootstrap works again. `nodeHasOwner()` only tells the
 *      truth while nothing can orphan a parked row; `purgeMemberSelf` used to leave one behind, which
 *      would have blocked the admin-key bootstrap on a genuinely ownerless node forever.
 *   7. The only owner's key waits on a re-key code (the deciding review of #1992, note 2): the code makes them
 *      'suspended' with their owner row kept for the new key, which read as ownerless. The node still has an owner
 *      (nodeHasOwner, and the shell's claim command), an admin key session asking for owner for itself -> 403, and
 *      the admin can neither suspend them (directly or through a report), nor prune them, nor bind their new key: they
 *      are its only owner. The way out is the shell again: `beanpool recover` appoints an owner, who binds the new key
 *      from the phone, and the owner role is on the new key.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-suspended-owner-bootstrap.ts
 */

import { randomBytes } from 'node:crypto';
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
    purgeMemberSelf,
} from './state-engine.js';
import { nodeHasOwner } from './engine/node-roles.js';
import { issueRekeyCode } from './engine/member-wizards.js';
import { readNodeView } from './claim-command.js';
import { adminEmergencySuspend, adminLiftSuspension } from './decisions-engine.js';
import { checkAdminAuth } from './admin-auth.js';
import { recoverOwner, RECOVER_ACTOR } from './recover-command.js';
import { ownerPhoneSessionHeaders } from './admin-auth-test-harness.js';
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
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
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

    /** What an older install's admin password looked like: no credential now. */
    const testPassword = 'SuperSecretAdminPassword123!';

    const bella = createKeyPair();   // founding admin, then the node's first owner
    const olivia = createKeyPair();  // the owner the community suspends
    const adam = createKeyPair();    // the admin who tries to promote himself
    const priya = createKeyPair();   // the recovery owner the operator appoints from the server's shell
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
        // The exchange answers the session in its httpOnly cookie only, never in the body (Fable's web review, L3).
        const sessionId = (exch.headers.get('set-cookie') || '').match(/admin_session=([0-9a-f]+)/)?.[1];
        if (exch.status !== 200 || !sessionId) {
            throw new Error(`handshake exchange failed for ${keys.pub.slice(0, 8)}: ${exch.status} ${JSON.stringify(session)}`);
        }
        return sessionId;
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

        // — 4. The operator's way out is the server's shell: the node is never stranded —
        console.log("\nTesting the operator's way out on the same node...");

        // The node has no admin password: an old one in the header is no credential, and appoints nobody...
        const passwordAlone = await fetch(`${base}/api/local/admin/node-roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-password': testPassword },
            body: JSON.stringify({ pubkey: priya.pub, role: 'owner' }),
        });
        const passwordAloneBody: any = await passwordAlone.json().catch(() => ({}));
        assert(passwordAlone.status === 401 && passwordAloneBody.notSignedIn === true,
            `an old admin password is no credential (401 notSignedIn) (got ${passwordAlone.status} ${JSON.stringify(passwordAloneBody)})`);
        assert(nodeRoleOf(priya.pub) === null, 'and no role is written');
        // ...so the operator's way out is the server's shell (recover-command.ts, `beanpool recover`), whoever holds it.
        const recovered = recoverOwner(priya.pub);
        assert(recovered.ok === true, `\`beanpool recover\` on the server may still appoint an owner (${recovered.ok ? 'ok' : recovered.reason})`);
        assert(isNodeOwner(priya.pub) === true, 'the operator has appointed a working owner');
        const priyaRole = listNodeRoles().find(r => r.member_pubkey === priya.pub);
        assert(priyaRole?.granted_by === RECOVER_ACTOR, `the grant is attributed to ${RECOVER_ACTOR}`);

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

        // — 6. A suspended owner who deletes their own account leaves nothing parked behind —
        console.log('\nTesting a suspended owner who purges their own account...');

        // Back to the same state as step 2: suspend one of the two owners, then lose the other. This pause is the appointed
        // owner's: whoever brought a vote on removing a member that ended without removing them (the password's, which the
        // lift above stopped) waits 90 days to bring another (removal by vote, Amendment A point 5; test-removal-fairness).
        const suspendAgain = adminEmergencySuspend(olivia.pub, priya.pub, 'A second dispute, heard while the appointed owner is still here.');
        assert(suspendAgain.success === true, `the owner is suspended again while a co-owner remains (${suspendAgain.error || 'no error'})`);
        adminSetUserStatus(priya.pub, 'disabled');
        assert(activeOwners().length === 0 && parkedOwners().length === 1, 'the node is back to zero active owners with one role held aside');
        assert(nodeHasOwner() === true, 'and it still reports an owner, because the suspended one can come back');

        // The request-signing middleware does not check `members.status`, so a suspended member can
        // still sign POST /api/member/purge for themselves; their role is parked rather than in
        // node_roles, so the sole-owner guard does not see an owner and the purge goes ahead.
        const purge = purgeMemberSelf(olivia.pub);
        assert(purge.ok === true, 'a suspended owner can still delete their own account');
        assert(parkedOwners().length === 0, 'the owner role held aside for them goes with them — no orphaned row is left');
        assert(nodeHasOwner() === false, 'so the node reports what is now true: it has no owner at all');

        // ...and the bootstrap that `nodeHasOwner()` guards works again. A node is never locked out.
        const adamSessionAfterPurge = await openKeySession(adam);
        const rebootstrap = await fetch(`${base}/api/local/admin/node-roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-session': adamSessionAfterPurge },
            body: JSON.stringify({ pubkey: adam.pub, role: 'owner' }),
        });
        assert(rebootstrap.status === 200, `an admin key session bootstraps an owner again on the now genuinely ownerless node (got ${rebootstrap.status})`);
        assert(isNodeOwner(adam.pub) === true, 'and that admin is the node owner');

        // — 7. The only owner's key waits on a re-key code: the node still has an owner —
        console.log("\nTesting a node whose only owner's key waits on a re-key code...");

        const zara = createKeyPair();   // an admin while the only owner recovers a lost phone
        seedMember(zara.pub, 'ZaraAdmin');
        grantNodeRole(zara.pub, 'admin', adam.pub);
        const rekey = issueRekeyCode(adam.pub, 'owner:password');
        const roleRow = (pk: string) => (db.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(pk) as { role: string } | undefined)?.role ?? null;
        const statusOf = (pk: string) => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(pk) as { status: string } | undefined)?.status ?? null;
        const stillWaiting = () => statusOf(adam.pub) === 'suspended' && roleRow(adam.pub) === 'owner' && parkedOwners().length === 0;
        assert(stillWaiting() && activeOwners().length === 0 && isNodeOwner(adam.pub) === false,
            "the only owner's key waits on a re-key code: suspended, the owner row kept, no owner whose role acts");
        assert(nodeHasOwner() === true, 'and the node still has an owner: the one recovering their phone');
        const view = readNodeView();
        assert(!('missing' in view) && view.owner === true && view.claim === null, "the shell's claim command reads it the same way: an owner, no claim");

        const zaraSession = await openKeySession(zara);
        const zaraSelf = await fetch(`${base}/api/local/admin/node-roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-session': zaraSession },
            body: JSON.stringify({ pubkey: zara.pub, role: 'owner' }),
        });
        assert(zaraSelf.status === 403, `an admin key session asking for owner for itself is refused with 403 (got ${zaraSelf.status})`);
        assert(nodeRoleOf(zara.pub) === 'admin' && activeOwners().length === 0 && stillWaiting(), 'that admin still holds only the admin role, and no owner row was written');

        // The only owner: neither suspended (directly or through a report) nor pruned by the admin who is left, nor their new
        // key bound: no owner can act, and only an owner re-keys an owner.
        const asZara = () => ({ 'Content-Type': 'application/json', 'x-admin-session': zaraSession });
        const suspendSole = await fetch(`${base}/api/local/admin/users/${adam.pub}/suspend`, {
            method: 'POST', headers: asZara(), body: JSON.stringify({ reason: 'The only owner, while they re-key.' }),
        });
        assert(suspendSole.status === 400 && stillWaiting(), `suspending the only owner while they re-key, by the admin -> 400, nothing changed (got ${suspendSole.status} ${await suspendSole.text()})`);
        const reportId = `rpt-${randomBytes(6).toString('hex')}`;
        db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, reason, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`)
            .run(reportId, zara.pub, adam.pub, 'bootstrap suite', new Date().toISOString());
        const reportSole = await fetch(`${base}/api/local/admin/reports/${reportId}/action`, {
            method: 'POST', headers: asZara(), body: JSON.stringify({ suspendUser: true }),
        });
        assert(reportSole.status === 400 && stillWaiting(), `suspending them through a report, by the admin -> 400, nothing changed (got ${reportSole.status} ${await reportSole.text()})`);
        const pruneSole = await fetch(`${base}/api/local/admin/users/${adam.pub}/prune`, {
            method: 'POST', headers: asZara(), body: '{}',
        });
        assert(pruneSole.status === 400 && stillWaiting(), `pruning them, by the admin -> 400, nothing changed (got ${pruneSole.status} ${await pruneSole.text()})`);
        const adamNew = createKeyPair();
        const zaraBind = await fetch(`${base}/api/local/admin/members/${adam.pub}/rekey/complete`, {
            method: 'POST', headers: asZara(), body: JSON.stringify({ code: rekey.code, newPubkey: adamNew.pub }),
        });
        assert(zaraBind.status === 403 && stillWaiting() && nodeRoleOf(adamNew.pub) === null,
            `nor may the admin bind their new key: only an owner re-keys an owner -> 403, nothing changed (got ${zaraBind.status})`);

        // The way out is the shell: `beanpool recover` appoints an owner, who binds the new key from the phone (the fresh
        // proof). The owner role is on the new key, and the admin is still an admin.
        const ruth = createKeyPair();   // the member the operator appoints from the server's shell
        seedMember(ruth.pub, 'RuthOperator');
        const ruthRecovered = recoverOwner(ruth.pub);
        assert(ruthRecovered.ok === true && isNodeOwner(ruth.pub) === true, `\`beanpool recover\` appoints an owner beside the one re-keying (${ruthRecovered.ok ? 'ok' : ruthRecovered.reason})`);
        const bind = await fetch(`${base}/api/local/admin/members/${adam.pub}/rekey/complete`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...ownerPhoneSessionHeaders(ruth.pub) }, body: JSON.stringify({ code: rekey.code, newPubkey: adamNew.pub }),
        });
        assert(bind.status === 200 && isNodeOwner(adamNew.pub) === true && roleRow(adam.pub) === null,
            `the re-key completes, and the owner role is on the new key (got ${bind.status})`);
        assert(JSON.stringify(activeOwners()) === JSON.stringify([adamNew.pub, ruth.pub].sort()) && nodeRoleOf(zara.pub) === 'admin',
            'the node has exactly the owners expected, the one who re-keyed and the one the shell appointed, and the admin is still an admin');
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
