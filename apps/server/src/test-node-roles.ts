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
 *   9. createVotingRound uses the same admin predicate (isNodeAdmin).
 *  10. getBalance() and member read paths expose nodeRole ('owner', 'admin', null).
 *  11. Admin HTTP management routes: GET, POST, DELETE with permission enforcement.
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
    keeperOf,
    unvouchMember,
    createTreasury,
    createProject,
    createVotingRound,
    closeVotingRound,
    adminSetVoucher,
    vouchMember,
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

    // Owner can revoke admin
    revokeNodeRole('dave', 'admin', 'gen_alice');
    assert(nodeRoleOf('dave') === null, 'Dave admin role revoked');

    // Re-grant Dave as admin for subsequent override checks
    grantNodeRole('dave', 'admin', 'gen_alice');

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

    // ── 7. Overrides: Former getAdminPubkey() call sites ──
    // Owner (Alice): has overrides
    assert(hasListedOffer('gen_alice') === true, 'Owner hasListedOffer override');
    assert(hasLiveOffer('gen_alice') === true, 'Owner hasLiveOffer override');
    assert(canVouch('gen_alice') === true, 'Owner canVouch override');
    assert(canOperate('gen_alice') === true, 'Owner canOperate override');
    assert(canOperateTreasury('gen_alice', tPub) === true, 'Owner canOperateTreasury override');
    assert(keeperOf('gen_alice').includes(tPub), 'Owner keeperOf includes all treasuries');

    // Admin (Dave): also has overrides
    assert(hasListedOffer('dave') === true, 'Admin hasListedOffer override');
    assert(hasLiveOffer('dave') === true, 'Admin hasLiveOffer override');
    assert(canVouch('dave') === true, 'Admin canVouch override');
    assert(canOperate('dave') === true, 'Admin canOperate override');
    assert(canOperateTreasury('dave', tPub) === true, 'Admin canOperateTreasury override');
    assert(keeperOf('dave').includes(tPub), 'Admin keeperOf includes all treasuries');

    // Plain user: no overrides
    assert(hasListedOffer('plain_user') === false, 'Plain member does NOT have hasListedOffer override');
    assert(hasLiveOffer('plain_user') === false, 'Plain member does NOT have hasLiveOffer override');
    assert(canVouch('plain_user') === false, 'Plain member does NOT have canVouch override');
    assert(canOperate('plain_user') === false, 'Plain member does NOT have canOperate override');
    assert(canOperateTreasury('plain_user', tPub) === false, 'Plain member does NOT have canOperateTreasury override');
    assert(keeperOf('plain_user').length === 0, 'Plain member keeperOf is empty');

    // SYSTEM: no overrides
    assert(hasListedOffer('SYSTEM') === false, 'SYSTEM does NOT have hasListedOffer override');
    assert(hasLiveOffer('SYSTEM') === false, 'SYSTEM does NOT have hasLiveOffer override');
    assert(canVouch('SYSTEM') === false, 'SYSTEM does NOT have canVouch override');
    assert(canOperate('SYSTEM') === false, 'SYSTEM does NOT have canOperate override');
    assert(canOperateTreasury('SYSTEM', tPub) === false, 'SYSTEM does NOT have canOperateTreasury override');

    // unvouchMember override check:
    adminSetVoucher('gen_alice', true);
    vouchMember('gen_alice', 'plain_user');
    assert(getBalance('plain_user').floor === -25, 'plain_user vouched');
    // Dave (admin) can withdraw Alice's vouch because Dave is admin
    unvouchMember('dave', 'plain_user');
    assert(getBalance('plain_user').floor === 0, 'Admin Dave withdrew Alice voucher vouch');

    // ── 8. createVotingRound admin check ──
    const proj1 = createProject('plain_user', 'Community Park', 'desc', 100)!;
    assert(!!proj1, 'Project created');

    // Plain member cannot create voting round
    const roundPlain = createVotingRound('plain_user', [proj1.id], new Date(Date.now() + 3600_000).toISOString());
    assert(roundPlain === null, 'Plain member cannot create voting round');

    // SYSTEM cannot create voting round
    const roundSystem = createVotingRound('SYSTEM', [proj1.id], new Date(Date.now() + 3600_000).toISOString());
    assert(roundSystem === null, 'SYSTEM cannot create voting round');

    // Admin (Dave) CAN create voting round
    const roundDave = createVotingRound('dave', [proj1.id], new Date(Date.now() + 3600_000).toISOString());
    assert(roundDave !== null, 'Admin Dave CAN create voting round');
    closeVotingRound(roundDave!.id);

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

        // POST /api/local/admin/node-roles: non-owner attempting to grant owner -> 403
        const postNonOwner = await fetch(`${base}/api/local/admin/node-roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pubkey: 'plain_user', role: 'owner', actorPubkey: 'dave' }),
        });
        assert(postNonOwner.status === 403, 'POST /api/local/admin/node-roles with non-owner actor returns 403');

        // POST /api/local/admin/node-roles: attempting to grant to treasury -> 400
        const postTreasury = await fetch(`${base}/api/local/admin/node-roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pubkey: tPub, role: 'admin', actorPubkey: 'gen_alice' }),
        });
        assert(postTreasury.status === 400, 'POST /api/local/admin/node-roles for treasury returns 400');

        // POST /api/local/admin/node-roles: owner granting owner -> 200
        const postOwner = await fetch(`${base}/api/local/admin/node-roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pubkey: 'charlie', role: 'owner', actorPubkey: 'gen_alice' }),
        });
        const postOwnerBody: any = await postOwner.json();
        assert(postOwner.status === 200 && postOwnerBody.success === true, 'POST /api/local/admin/node-roles granting owner returns 200');
        assert(isNodeOwner('charlie') === true, 'Charlie is now owner via HTTP endpoint');

        // DELETE /api/local/admin/node-roles/:pubkey/:role: non-owner actor -> 403
        const delNonOwner = await fetch(`${base}/api/local/admin/node-roles/charlie/owner`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actorPubkey: 'dave' }),
        });
        assert(delNonOwner.status === 403, 'DELETE /api/local/admin/node-roles with non-owner actor returns 403');

        // DELETE /api/local/admin/node-roles/:pubkey/:role: owner actor -> 200
        const delOwner = await fetch(`${base}/api/local/admin/node-roles/charlie/owner`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actorPubkey: 'gen_alice' }),
        });
        const delOwnerBody: any = await delOwner.json();
        assert(delOwner.status === 200 && delOwnerBody.success === true, 'DELETE /api/local/admin/node-roles with owner actor returns 200');
        assert(isNodeOwner('charlie') === false, 'Charlie revoked via HTTP endpoint');

        // DELETE last owner -> 400
        const delLastOwner = await fetch(`${base}/api/local/admin/node-roles/gen_alice/owner`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actorPubkey: 'gen_alice' }),
        });
        assert(delLastOwner.status === 400, 'DELETE last owner returns 400');
        assert(isNodeOwner('gen_alice') === true, 'Alice cannot be deleted as last owner');

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
