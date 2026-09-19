/**
 * Comprehensive tests for the Node Roles model:
 * (docs/admin-surface.md §1, §5; docs/the-commons.md §9.2)
 *
 * Covers:
 *   1. Seeding migration runs idempotently on boot.
 *   2. SYSTEM is NEVER seeded as an owner or admin.
 *   3. A node with no genesis member seeds nothing and warns.
 *   4. Multi-genesis seeding on boot seeds all human genesis members as 'owner'.
 *   5. Only an owner can grant 'owner'; only an owner can grant 'admin'.
 *   6. The last owner cannot be removed.
 *   7. A treasury (is_treasury=1) can NEVER hold a node role.
 *   8. Each former getAdminPubkey() call site authorises owner and admin, and refuses regular/SYSTEM.
 *   9. getBalance() and member read paths expose nodeRole ('owner', 'admin', null).
 *  10. Admin HTTP management routes: GET, POST, DELETE with permission enforcement.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-node-roles.ts
 */

import {
    initStateEngine,
    seedGenesisMember,
    isNodeOwner,
    isNodeAdmin,
    nodeRoleOf,
    getFirstNodeAdminPubkey,
    listNodeRoles,
    grantNodeRole,
    revokeNodeRole,
    getBalance,
    hasListedOffer,
    hasLiveOffer,
    canVouch,
    canOperate,
    canOperateTreasury,
    canAdministerTreasury,
    keeperOf,
    unvouchMember,
    createTreasury,
    adminSetVoucher,
    vouchMember,
    adminPruneUser,
    purgeMemberSelf,
    adminSetUserStatus,
    getMember,
    adminSendMessage,
} from './state-engine.js';
import { db, seedNodeRolesFromGenesis } from './db/db.js';
import Koa from 'koa';
import { createAdminRoutes } from './routes/admin.js';
import { createCommunityRoutes } from './routes/community.js';

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

function throws(fn: () => void, needle: string, msg: string) {
    total++;
    try {
        fn();
        console.error(`✗ ${msg} (expected to throw, but succeeded)`);
        process.exitCode = 1;
    } catch (e: any) {
        if (String(e?.message || e).includes(needle)) {
            passed++;
            console.log(`✓ ${msg} — threw "${e?.message}"`);
        } else {
            console.error(`✗ ${msg} — expected "${needle}", got "${e?.message}"`);
            process.exitCode = 1;
        }
    }
}

function seedMember(pk: string, callsign: string) {
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
}

async function main() {
    console.log('Running test-node-roles test suite...\n');

    // ── 1. Boot on fresh DB with no genesis member ──
    initStateEngine();

    const initialRoles = db.prepare("SELECT * FROM node_roles").all();
    assert(initialRoles.length === 0, 'node_roles is empty on a node with no human genesis member');
    assert(getFirstNodeAdminPubkey() === '', 'getFirstNodeAdminPubkey() returns empty string when no admin exists');

    // SYSTEM is in members, but NOT in node_roles
    const systemRow = db.prepare("SELECT public_key, invited_by FROM members WHERE public_key = 'SYSTEM'").get() as any;
    assert(!!systemRow && systemRow.invited_by === 'genesis', 'SYSTEM member exists in members table');
    assert(nodeRoleOf('SYSTEM') === null, 'SYSTEM has nodeRoleOf = null');
    assert(isNodeOwner('SYSTEM') === false, 'SYSTEM has isNodeOwner = false');
    assert(isNodeAdmin('SYSTEM') === false, 'SYSTEM has isNodeAdmin = false');

    // Calling seedNodeRolesFromGenesis on empty node_roles with no human genesis member warns and returns 0
    const reseedZero = seedNodeRolesFromGenesis();
    assert(reseedZero === 0, 'seedNodeRolesFromGenesis() returns 0 when no human genesis member exists');

    // ── 2. Multi-genesis seeding migration ──
    // Simulate legacy node that had 2 human genesis members BEFORE node_roles table existed
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code)
                VALUES ('gen_alice', 'Alice', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run();
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES ('gen_alice', 100, 0)`).run();
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code)
                VALUES ('gen_bob', 'Bob', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run();
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES ('gen_bob', 100, 0)`).run();

    const seededCount = seedNodeRolesFromGenesis();
    assert(seededCount === 2, 'seedNodeRolesFromGenesis() seeds both human genesis members as owner');
    assert(isNodeOwner('gen_alice') === true, 'Alice is an owner');
    assert(isNodeOwner('gen_bob') === true, 'Bob is an owner');
    assert(isNodeOwner('SYSTEM') === false, 'SYSTEM is NOT an owner after seeding');

    // Idempotence: calling seedNodeRolesFromGenesis again does nothing
    const reseedCount = seedNodeRolesFromGenesis();
    assert(reseedCount === 0, 'seedNodeRolesFromGenesis() is idempotent and writes 0 rows on re-run');
    assert(db.prepare("SELECT COUNT(*) AS c FROM node_roles").pluck().get() === 2, 'node_roles row count unchanged after reseed');

    // Regression: Pruned ghost genesis member is NEVER resurrected
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES ('gen_ghost', 'Ghost', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis', 'pruned')`).run();
    seedNodeRolesFromGenesis();
    assert(isNodeOwner('gen_ghost') === false, 'Pruned genesis member is NEVER resurrected as owner');
    assert(nodeRoleOf('gen_ghost') === null, 'Pruned genesis member has nodeRoleOf = null');

    // Regression: Late genesis member IS seeded even when node_roles already has rows (no short-circuit)
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES ('gen_late', 'LateGenesis', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis', 'active')`).run();
    const lateSeeded = seedNodeRolesFromGenesis();
    assert(lateSeeded === 1, 'seedNodeRolesFromGenesis() seeds late genesis member without short-circuiting');
    assert(isNodeOwner('gen_late') === true, 'Late genesis member is now owner');
    // clean up gen_late so subsequent tests keep expected owner count
    db.prepare("DELETE FROM node_roles WHERE member_pubkey = 'gen_late'").run();
    db.prepare("DELETE FROM members WHERE public_key = 'gen_late'").run();

    // ── 3. Role predicates and role hierarchy ──
    assert(nodeRoleOf('gen_alice') === 'owner', "nodeRoleOf(Alice) === 'owner'");
    assert(isNodeAdmin('gen_alice') === true, 'isNodeAdmin(Alice) is true (owners have admin rights)');

    seedMember('plain_user', 'Plain');
    assert(nodeRoleOf('plain_user') === null, 'nodeRoleOf(plain_user) is null');
    assert(isNodeOwner('plain_user') === false, 'isNodeOwner(plain_user) is false');
    assert(isNodeAdmin('plain_user') === false, 'isNodeAdmin(plain_user) is false');

    // ── 4. Treasury accounts can NEVER hold a node role ──
    const treasury = createTreasury('TownTreasury', 't.png', 1000);
    assert(Boolean(treasury && treasury.publicKey), 'TownTreasury created');
    const tPub = treasury.publicKey;

    throws(() => grantNodeRole(tPub, 'admin', 'gen_alice'), 'Treasury accounts cannot hold a node role', 'Cannot grant admin to treasury');
    throws(() => grantNodeRole(tPub, 'owner', 'gen_alice'), 'Treasury accounts cannot hold a node role', 'Cannot grant owner to treasury');
    assert(nodeRoleOf(tPub) === null, 'Treasury account has no node role');

    // ── 5. Permission enforcement: Appointing and removing admins and owners ──
    seedMember('charlie', 'Charlie');
    seedMember('dave', 'Dave');

    // Non-owner cannot grant owner
    throws(() => grantNodeRole('charlie', 'owner', 'plain_user'), 'Only an owner may grant the owner role', 'Plain member cannot grant owner');

    // Non-owner cannot grant admin
    throws(() => grantNodeRole('dave', 'admin', 'plain_user'), 'Only an owner may grant the admin role', 'Plain member cannot grant admin');

    // Regression (Finding 1): Missing actorPubkey cannot grant admin
    throws(() => grantNodeRole('dave', 'admin'), 'Only an owner may grant the admin role', 'Missing actorPubkey cannot grant admin');
    throws(() => grantNodeRole('dave', 'admin', ''), 'Only an owner may grant the admin role', 'Empty actorPubkey cannot grant admin');

    // Owner CAN grant admin
    grantNodeRole('dave', 'admin', 'gen_alice');
    assert(nodeRoleOf('dave') === 'admin', "nodeRoleOf(Dave) is 'admin'");
    assert(isNodeOwner('dave') === false, 'Dave is NOT an owner');
    assert(isNodeAdmin('dave') === true, 'Dave IS an admin');

    // Admin cannot grant admin
    throws(() => grantNodeRole('charlie', 'admin', 'dave'), 'Only an owner may grant the admin role', 'Admin Dave cannot grant admin');

    // Admin cannot grant owner
    throws(() => grantNodeRole('charlie', 'owner', 'dave'), 'Only an owner may grant the owner role', 'Admin Dave cannot grant owner');

    // Owner CAN grant owner
    grantNodeRole('charlie', 'owner', 'gen_alice');
    assert(isNodeOwner('charlie') === true, 'Charlie is now an owner');

    // Non-owner cannot revoke admin
    throws(() => revokeNodeRole('dave', 'admin', 'plain_user'), 'Only an owner may revoke the admin role', 'Plain member cannot revoke admin');

    // Admin cannot revoke admin
    throws(() => revokeNodeRole('dave', 'admin', 'dave'), 'Only an owner may revoke the admin role', 'Admin Dave cannot revoke admin');

    // Regression (Finding 1): Missing actorPubkey cannot revoke admin
    throws(() => revokeNodeRole('dave', 'admin'), 'Only an owner may revoke the admin role', 'Missing actorPubkey cannot revoke admin');
    throws(() => revokeNodeRole('dave', 'admin', ''), 'Only an owner may revoke the admin role', 'Empty actorPubkey cannot revoke admin');

    // Owner can revoke admin
    revokeNodeRole('dave', 'admin', 'gen_alice');
    assert(nodeRoleOf('dave') === null, 'Dave admin role revoked');

    // Re-grant Dave as admin for subsequent override checks
    grantNodeRole('dave', 'admin', 'gen_alice');

    // ── Regression (Finding 4): Exactly ONE node role per member, promotion & demotion ──
    // 1. Promote admin Dave to owner -> replaces admin row with owner row
    grantNodeRole('dave', 'owner', 'gen_alice');
    assert(nodeRoleOf('dave') === 'owner', "Promoting Dave to owner sets nodeRoleOf to 'owner'");
    assert(isNodeOwner('dave') === true, 'Dave is now an owner');
    assert(db.prepare("SELECT COUNT(*) AS c FROM node_roles WHERE member_pubkey = 'dave'").pluck().get() === 1, 'Dave holds exactly 1 row after promotion');
    assert(listNodeRoles().filter(r => r.member_pubkey === 'dave').length === 1, 'Dave appears exactly once in listNodeRoles');

    // 2. Demote owner Dave back to admin -> replaces owner row with admin row, stripping owner privileges
    grantNodeRole('dave', 'admin', 'gen_alice');
    assert(nodeRoleOf('dave') === 'admin', "Demoting Dave to admin sets nodeRoleOf to 'admin'");
    assert(isNodeOwner('dave') === false, 'Dave is NO LONGER an owner after demotion');
    assert(isNodeAdmin('dave') === true, 'Dave is still an admin after demotion');
    assert(db.prepare("SELECT COUNT(*) AS c FROM node_roles WHERE member_pubkey = 'dave'").pluck().get() === 1, 'Dave holds exactly 1 row after demotion');
    assert(listNodeRoles().filter(r => r.member_pubkey === 'dave').length === 1, 'Dave appears exactly once in listNodeRoles after demotion');

    // ── 6. Last owner removal protection ──
    // Currently owners: gen_alice, gen_bob, charlie (3 owners)
    // Remove gen_bob: allowed because 2 owners remain
    revokeNodeRole('gen_bob', 'owner', 'gen_alice');
    assert(isNodeOwner('gen_bob') === false, 'Bob revoked as owner');

    // Remove charlie: allowed because gen_alice remains
    revokeNodeRole('charlie', 'owner', 'gen_alice');
    assert(isNodeOwner('charlie') === false, 'Charlie revoked as owner');

    // Now only 1 owner remains (gen_alice)
    throws(() => revokeNodeRole('gen_alice', 'owner', 'gen_alice'), 'Cannot remove the last owner', 'Cannot remove the last owner');
    assert(isNodeOwner('gen_alice') === true, 'Alice is STILL an owner');

    // Demoting the last owner to admin is also blocked
    throws(() => grantNodeRole('gen_alice', 'admin', 'gen_alice'), 'Cannot remove the last owner', 'Demoting the last owner to admin throws');
    assert(isNodeOwner('gen_alice') === true, 'Alice is STILL an owner after blocked demotion');

    // Regression (Finding 3): Revoking owner from a non-owner on a single-owner node does NOT throw "Cannot remove the last owner"
    revokeNodeRole('plain_user', 'owner', 'gen_alice');
    assert(isNodeOwner('plain_user') === false, 'Revoking non-owner on single-owner node is safe no-op');
    revokeNodeRole('dave', 'owner', 'gen_alice');
    assert(isNodeOwner('dave') === false, 'Revoking admin from owner role on single-owner node does not raise false last-owner error');
    assert(isNodeOwner('gen_alice') === true, 'Alice is STILL an owner after non-owner revoke attempts');

    // ── 7. Overrides: Former getAdminPubkey() call sites ──
    // Owner (Alice): has overrides
    assert(hasListedOffer('gen_alice') === true, 'Owner hasListedOffer override');
    assert(hasLiveOffer('gen_alice') === true, 'Owner hasLiveOffer override');
    assert(canVouch('gen_alice') === true, 'Owner canVouch override');
    assert(canOperate('gen_alice') === true, 'Owner canOperate override');
    assert(canAdministerTreasury('gen_alice', tPub) === true, 'Owner canAdministerTreasury override');
    assert(canOperateTreasury('gen_alice', tPub) === false, 'Owner with no operator binding cannot spend (#774)');
    assert(keeperOf('gen_alice').length === 0, 'Owner keeperOf is empty with no explicit binding (#774)');

    // Admin (Dave): also has overrides
    assert(hasListedOffer('dave') === true, 'Admin hasListedOffer override');
    assert(hasLiveOffer('dave') === true, 'Admin hasLiveOffer override');
    assert(canVouch('dave') === true, 'Admin canVouch override');
    assert(canOperate('dave') === true, 'Admin canOperate override');
    assert(canAdministerTreasury('dave', tPub) === true, 'Admin canAdministerTreasury override');
    assert(canOperateTreasury('dave', tPub) === false, 'Admin with no operator binding cannot spend (#774)');
    assert(keeperOf('dave').length === 0, 'Admin keeperOf is empty with no explicit binding (#774)');

    // Plain user: no overrides
    assert(hasListedOffer('plain_user') === false, 'Plain member does NOT have hasListedOffer override');
    assert(hasLiveOffer('plain_user') === false, 'Plain member does NOT have hasLiveOffer override');
    assert(canVouch('plain_user') === false, 'Plain member does NOT have canVouch override');
    assert(canOperate('plain_user') === false, 'Plain member does NOT have canOperate override');
    assert(canAdministerTreasury('plain_user', tPub) === false, 'Plain member does NOT have canAdministerTreasury override');
    assert(canOperateTreasury('plain_user', tPub) === false, 'Plain member does NOT have canOperateTreasury override');
    assert(keeperOf('plain_user').length === 0, 'Plain member keeperOf is empty');

    // SYSTEM: no overrides
    assert(hasListedOffer('SYSTEM') === false, 'SYSTEM does NOT have hasListedOffer override');
    assert(hasLiveOffer('SYSTEM') === false, 'SYSTEM does NOT have hasLiveOffer override');
    assert(canVouch('SYSTEM') === false, 'SYSTEM does NOT have canVouch override');
    assert(canOperate('SYSTEM') === false, 'SYSTEM does NOT have canOperate override');
    assert(canAdministerTreasury('SYSTEM', tPub) === false, 'SYSTEM does NOT have canAdministerTreasury override');
    assert(canOperateTreasury('SYSTEM', tPub) === false, 'SYSTEM does NOT have canOperateTreasury override');

    // unvouchMember override check:
    adminSetVoucher('gen_alice', true);
    vouchMember('gen_alice', 'plain_user');
    assert(getBalance('plain_user').floor === -25, 'plain_user vouched');
    // Dave (admin) can withdraw Alice's vouch because Dave is admin
    unvouchMember('dave', 'plain_user');
    assert(getBalance('plain_user').floor === 0, 'Admin Dave withdrew Alice voucher vouch');

    // ── 9. Read paths expose nodeRole ──
    const aliceBal = getBalance('gen_alice');
    assert(aliceBal.nodeRole === 'owner', "getBalance(Alice).nodeRole === 'owner'");

    const daveBal = getBalance('dave');
    assert(daveBal.nodeRole === 'admin', "getBalance(Dave).nodeRole === 'admin'");

    const plainBal = getBalance('plain_user');
    assert(plainBal.nodeRole === null, "getBalance(Plain).nodeRole === null");

    // ── 10. HTTP Admin Routes ──
    const app = new Koa();
    app.use(async (ctx, next) => {
        // Test auth harness: simulate signature-verified actor in ctx.state.actor
        if (ctx.header['x-verified-actor']) {
            (ctx.state as any).actor = ctx.header['x-verified-actor'];
        }
        if (ctx.method === 'POST' || ctx.method === 'PUT' || ctx.method === 'DELETE') {
            const chunks: Buffer[] = [];
            for await (const chunk of ctx.req) chunks.push(chunk as Buffer);
            const str = Buffer.concat(chunks).toString('utf8');
            try {
                (ctx as any).requestBody = str ? JSON.parse(str) : {};
            } catch {
                (ctx as any).requestBody = {};
            }
        }
        await next();
    });

    // Dummy checkAdminAuth middleware that accepts all in tests
    const dummyDeps: any = {
        checkAdminAuth: async () => true,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
    };
    const adminRouter = createAdminRoutes(dummyDeps);
    const communityRouter = createCommunityRoutes({} as any);
    app.use(adminRouter.routes()).use(adminRouter.allowedMethods());
    app.use(communityRouter.routes()).use(communityRouter.allowedMethods());
    const server = app.listen(0);
    const addr = server.address() as any;
    const base = `http://127.0.0.1:${addr.port}`;

    try {
        // GET /api/local/admin/node-roles
        const getRes = await fetch(`${base}/api/local/admin/node-roles`);
        const getBody: any = await getRes.json();
        assert(getRes.status === 200, 'GET /api/local/admin/node-roles returns 200');
        assert(getBody.success === true, 'GET /api/local/admin/node-roles has success=true');
        assert(Array.isArray(getBody.roles), 'GET /api/local/admin/node-roles returns roles array');
        assert(getBody.roles.some((r: any) => r.member_pubkey === 'gen_alice' && r.role === 'owner'), 'Alice listed as owner');
        assert(getBody.roles.some((r: any) => r.member_pubkey === 'dave' && r.role === 'admin'), 'Dave listed as admin');

        // Under controller design decision (2026-09-14): password-authenticated admin calls without signed actor
        // succeed as owner, ignoring any spoofed actor in body/header and attributing to 'owner:password'.
        const postPasswordAuth = await fetch(`${base}/api/local/admin/node-roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pubkey: 'charlie', role: 'owner', actorPubkey: 'spoofed_key', actor: 'spoofed_key' }),
        });
        const postPasswordBody: any = await postPasswordAuth.json();
        assert(postPasswordAuth.status === 200 && postPasswordBody.success === true, 'POST /api/local/admin/node-roles without signed actor succeeds under password auth as owner');
        assert(isNodeOwner('charlie') === true, 'Charlie is now owner via password auth');
        const rolesAfterCharlie = listNodeRoles();
        const charlieRole = rolesAfterCharlie.find(r => r.member_pubkey === 'charlie');
        assert(charlieRole?.granted_by === 'owner:password', "Charlie granted_by is recorded as 'owner:password', ignoring body actorPubkey");

        // Parameter aliases: publicKey and member_pubkey
        seedMember('eve', 'Eve');
        const postAlias = await fetch(`${base}/api/local/admin/node-roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ publicKey: 'eve', role: 'admin' }),
        });
        assert(postAlias.status === 200, 'POST /api/local/admin/node-roles accepts publicKey alias');
        assert(isNodeAdmin('eve') === true, 'Eve is now admin via publicKey alias');

        // Member not found returns 404
        const postNonExistent = await fetch(`${base}/api/local/admin/node-roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pubkey: 'nonexistent_key', role: 'admin' }),
        });
        assert(postNonExistent.status === 404, 'POST /api/local/admin/node-roles for non-existent member returns 404');

        // POST /api/local/admin/node-roles: verified non-owner actor attempting to grant owner -> 403
        const postNonOwner = await fetch(`${base}/api/local/admin/node-roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-verified-actor': 'dave' },
            body: JSON.stringify({ pubkey: 'plain_user', role: 'owner' }),
        });
        assert(postNonOwner.status === 403, 'POST /api/local/admin/node-roles with verified non-owner actor returns 403');

        // POST /api/local/admin/node-roles: attempting to grant to treasury -> 400
        const postTreasury = await fetch(`${base}/api/local/admin/node-roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-verified-actor': 'gen_alice' },
            body: JSON.stringify({ pubkey: tPub, role: 'admin' }),
        });
        assert(postTreasury.status === 400, 'POST /api/local/admin/node-roles for treasury returns 400');

        // DELETE /api/local/admin/node-roles: password-authenticated call without signed actor succeeds as owner
        const delPasswordAuth = await fetch(`${base}/api/local/admin/node-roles/charlie/owner`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actorPubkey: 'spoofed_key' }),
        });
        const delPasswordBody: any = await delPasswordAuth.json();
        assert(delPasswordAuth.status === 200 && delPasswordBody.success === true, 'DELETE /api/local/admin/node-roles without signed actor succeeds under password auth as owner');
        assert(isNodeOwner('charlie') === false, 'Charlie revoked via password auth');

        // DELETE /api/local/admin/node-roles/:pubkey/:role: verified non-owner actor -> 403
        seedMember('frank', 'Frank');
        grantNodeRole('frank', 'admin', 'gen_alice');
        const delNonOwner = await fetch(`${base}/api/local/admin/node-roles/frank/admin`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'x-verified-actor': 'dave' },
        });
        assert(delNonOwner.status === 403, 'DELETE /api/local/admin/node-roles with non-owner actor returns 403');

        // DELETE /api/local/admin/node-roles/:pubkey/:role: verified owner actor -> 200
        const delOwner = await fetch(`${base}/api/local/admin/node-roles/frank/admin`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'x-verified-actor': 'gen_alice' },
        });
        const delOwnerBody: any = await delOwner.json();
        assert(delOwner.status === 200 && delOwnerBody.success === true, 'DELETE /api/local/admin/node-roles with owner actor returns 200');
        assert(isNodeAdmin('frank') === false, 'Frank revoked via HTTP endpoint');

        // The old voting-round admin route was deleted with voting rounds (2026-09-19).
        const retiredRound = await fetch(`${base}/api/local/admin/commons/round`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-verified-actor': 'gen_alice' },
            body: JSON.stringify({ action: 'create', projectIds: ['p'], closesAt: new Date(Date.now() + 3600_000).toISOString() }),
        });
        assert(retiredRound.status === 404, `POST /api/local/admin/commons/round no longer exists (${retiredRound.status})`);

        // DELETE last owner -> 400
        const delLastOwner = await fetch(`${base}/api/local/admin/node-roles/gen_alice/owner`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'x-verified-actor': 'gen_alice' },
        });
        assert(delLastOwner.status === 400, 'DELETE last owner returns 400');
        assert(isNodeOwner('gen_alice') === true, 'Alice cannot be deleted as last owner');

        // DELETE role member does not hold -> 404
        const delUnheld = await fetch(`${base}/api/local/admin/node-roles/plain_user/owner`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'x-verified-actor': 'gen_alice' },
        });
        assert(delUnheld.status === 404, 'DELETE unheld role returns 404');

        // Community members read path exposes nodeRole
        const memRes = await fetch(`${base}/api/community/members`);
        assert(memRes.status === 200, 'GET /api/community/members returns 200');
        const membersList: any = await memRes.json();
        const aliceInList = membersList.find((m: any) => m.publicKey === 'gen_alice');
        const daveInList = membersList.find((m: any) => m.publicKey === 'dave');
        const plainInList = membersList.find((m: any) => m.publicKey === 'plain_user');
        assert(aliceInList && aliceInList.nodeRole === 'owner', "Alice has nodeRole 'owner' in /api/community/members");
        assert(daveInList && daveInList.nodeRole === 'admin', "Dave has nodeRole 'admin' in /api/community/members");
        assert(plainInList && plainInList.nodeRole === null, "Plain has nodeRole null in /api/community/members");

        // Public /api/members read path also batches nodeRole
        const allMemRes = await fetch(`${base}/api/members`);
        assert(allMemRes.status === 200, 'GET /api/members returns 200');
        const allMembersList: any = await allMemRes.json();
        const aliceInAll = allMembersList.find((m: any) => m.publicKey === 'gen_alice');
        const daveInAll = allMembersList.find((m: any) => m.publicKey === 'dave');
        const plainInAll = allMembersList.find((m: any) => m.publicKey === 'plain_user');
        assert(aliceInAll && aliceInAll.nodeRole === 'owner', "Alice has nodeRole 'owner' in /api/members");
        assert(daveInAll && daveInAll.nodeRole === 'admin', "Dave has nodeRole 'admin' in /api/members");
        assert(plainInAll && plainInAll.nodeRole === null, "Plain has nodeRole null in /api/members");

        // rowToMember standardizes on nodeRole: null (not omitted/undefined)
        const plainMember = getMember('plain_user');
        assert(plainMember !== undefined, 'getMember(plain_user) returns member');
        const plainJson = JSON.stringify(plainMember);
        assert(plainJson.includes('"nodeRole":null'), 'JSON.stringify(plainMember) includes "nodeRole":null');

        // adminSendMessage fallback to 'system' does not blackhole
        adminSendMessage('plain_user', 'Hello from fallback system', 'SYSTEM');
        const inboxRes = await fetch(`${base}/api/local/admin/inbox`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        assert(inboxRes.status === 200, 'POST /api/local/admin/inbox returns 200');
        const inboxBody: any = await inboxRes.json();
        assert(Array.isArray(inboxBody.conversations), 'inbox returns conversations array');
        const systemConv = inboxBody.conversations.find((c: any) => c.participants.includes('system') && c.participants.includes('plain_user'));
        assert(Boolean(systemConv), 'Admin inbox retrieves conversation created via system fallback');

        // ── 11. Pruned account privilege revocation ──
        seedMember('pruned_target', 'PrunedMember');
        grantNodeRole('pruned_target', 'admin', 'gen_alice');
        assert(nodeRoleOf('pruned_target') === 'admin', 'Target is admin before prune');
        adminPruneUser('pruned_target', 'owner:password');
        assert(nodeRoleOf('pruned_target') === null, 'Pruned member has nodeRoleOf = null');
        assert(isNodeAdmin('pruned_target') === false, 'Pruned member has isNodeAdmin = false');
        assert(isNodeOwner('pruned_target') === false, 'Pruned member has isNodeOwner = false');
        throws(() => grantNodeRole('pruned_target', 'admin', 'gen_alice'), 'Pruned accounts cannot hold a node role', 'Cannot grant role to pruned account');

        // SYSTEM account cannot hold a role
        throws(() => grantNodeRole('SYSTEM', 'admin', 'gen_alice'), 'SYSTEM placeholder account cannot hold a node role', 'Cannot grant role to SYSTEM');
        throws(() => grantNodeRole('SYSTEM', 'owner', 'gen_alice'), 'SYSTEM placeholder account cannot hold a node role', 'Cannot grant owner role to SYSTEM');

        // Disabled account cannot hold a role
        seedMember('disabled_user', 'DisabledUser');
        db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = 'disabled_user'").run();
        throws(() => grantNodeRole('disabled_user', 'admin', 'gen_alice'), 'Only active accounts can hold a node role', 'Cannot grant role to disabled account');

        // Role revocation on status change
        seedMember('status_change_user', 'StatusChangeUser');
        grantNodeRole('status_change_user', 'admin', 'gen_alice');
        assert(nodeRoleOf('status_change_user') === 'admin', 'status_change_user holds admin role');
        adminSetUserStatus('status_change_user', 'disabled');
        assert(nodeRoleOf('status_change_user') === null, 'status_change_user role is null after status changed to disabled');
        assert(isNodeAdmin('status_change_user') === false, 'status_change_user is not admin after status changed to disabled');
        const roleRow = db.prepare("SELECT * FROM node_roles WHERE member_pubkey = 'status_change_user'").get();
        assert(!roleRow, 'node_roles row was deleted when status changed to disabled');

        // Sole owner cannot be pruned or self-purged
        throws(() => adminPruneUser('gen_alice', 'owner:password'), 'Cannot prune the sole node owner; appoint another owner first', 'Cannot prune the sole node owner');
        throws(() => purgeMemberSelf('gen_alice'), 'Cannot purge the sole node owner; appoint another owner first', 'Cannot self-purge the sole node owner');

    } finally {
        server.close();
    }

    console.log(`\nNode roles suite results: ${passed}/${total} assertions passed.`);
    if (passed !== total) {
        process.exit(1);
    }
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(err => {
    console.error('Test threw unexpected exception:', err);
    process.exit(1);
});
