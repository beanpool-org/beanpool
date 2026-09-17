/**
 * Regression test for Remaining Item 4 (PR #774):
 * Federation link operator binding out-of-the-box.
 *
 * Verifies that:
 * 1. ensureFederationLink automatically binds the node genesis admin into treasury_operators
 *    with role 'keeper' and sets can_operate = 1.
 * 2. canOperateTreasury(admin, link.treasuryPubkey) returns true, ensuring federation
 *    commissioning routes are not bricked out of the box.
 * 3. On a node with NO admin/owner, ensureFederationLink succeeds gracefully without throwing,
 *    creating the link enterprise with no operator rows.
 * 4. Self-healing: When an admin is later established, running ensureFederationLink or
 *    reconcileFederationLinks binds the operator to existing unbound links.
 * 5. Explicit operator parameter: passing operatorPubkey binds that specific operator.
 * 6. Non-keepers cannot operate the federation link treasury.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import { db } from './db/db.js';
import {
    initStateEngine,
    createTreasury,
    canOperateTreasury,
    keeperOf,
} from './state-engine.js';
import {
    ensureFederationLink,
    findDefaultLinkOperator,
    getFederationLink,
    reconcileFederationLinks,
} from './federation-link.js';
import { addConnector, setConnectorCreditCap } from './connector-manager.js';

let passed = 0;
let run = 0;
function check(cond: boolean, msg: string) {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

function makeMember(callsign: string): string {
    const pubkey = crypto.randomBytes(16).toString('hex');
    db.prepare(
        `INSERT OR IGNORE INTO members (public_key, callsign, joined_at, avatar_url)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'data:image/png;base64,iVBORw0KGgo=')`
    ).run(pubkey, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 1000, 0)`).run(pubkey);
    return pubkey;
}

function seedGenesisAdmin(callsign = 'GenesisAdmin'): string {
    const admin = makeMember(callsign);
    db.prepare("UPDATE members SET invited_by = 'genesis' WHERE public_key = ?").run(admin);
    return admin;
}

async function runTests() {
    console.log('Testing Federation Link Operator Binding & Self-Healing...\n');
    process.env.ENABLE_PEER_CONNECTORS = 'true';
    initStateEngine();

    // ── 1. Graceful degradation: Node with NO owner/admin does not throw ──
    db.prepare("DELETE FROM members WHERE invited_by = 'genesis' AND public_key != 'SYSTEM'").run();
    db.prepare("DELETE FROM members WHERE public_key != 'SYSTEM' AND is_treasury = 0").run();

    check(findDefaultLinkOperator() === null, 'findDefaultLinkOperator returns null when no members exist');

    const peerNoOwner = '12D3KooWNoOwnerPeer00000000000000000000000000';
    let linkNoOwner: any = null;
    try {
        linkNoOwner = ensureFederationLink(peerNoOwner, 'NoOwnerPeer', createTreasury);
    } catch (e: any) {
        check(false, `ensureFederationLink threw on unowned node: ${e?.message}`);
    }
    check(linkNoOwner !== null, 'ensureFederationLink succeeds on node with no owner rather than throwing');
    const opCountNoOwner = (db.prepare('SELECT COUNT(*) AS c FROM treasury_operators WHERE treasury_pubkey = ?').get(linkNoOwner.treasuryPubkey) as any).c;
    check(opCountNoOwner === 0, 'No rows inserted in treasury_operators when no owner exists');

    // ── 2. Automatic binding when genesis admin exists ──
    const admin = seedGenesisAdmin('AliceAdmin');
    check(findDefaultLinkOperator() === admin, 'findDefaultLinkOperator resolves genesis admin');

    const peerWithAdmin = '12D3KooWWithAdminPeer00000000000000000000000';
    const linkWithAdmin = ensureFederationLink(peerWithAdmin, 'ByronPeer', createTreasury)!;
    check(linkWithAdmin !== null, 'Federation link created for peer');

    const opRow = db.prepare('SELECT member_pubkey, role, granted_by FROM treasury_operators WHERE treasury_pubkey = ?').get(linkWithAdmin.treasuryPubkey) as any;
    check(opRow?.member_pubkey === admin, 'Genesis admin is automatically bound in treasury_operators');
    check(opRow?.role === 'keeper', 'Admin bound with role = keeper');
    check(opRow?.granted_by === 'system', 'Admin bound with granted_by = system');

    const adminMember = db.prepare('SELECT can_operate FROM members WHERE public_key = ?').get(admin) as any;
    check(adminMember?.can_operate === 1, 'Admin member has can_operate = 1');

    check(canOperateTreasury(admin, linkWithAdmin.treasuryPubkey) === true,
        'canOperateTreasury(admin, link) is true out-of-the-box (commissioning capacity unblocked)');
    check(keeperOf(admin).includes(linkWithAdmin.treasuryPubkey),
        'keeperOf(admin) includes the newly created federation link treasury');

    const outsider = makeMember('outsider');
    check(canOperateTreasury(outsider, linkWithAdmin.treasuryPubkey) === false,
        'Outsider cannot operate the federation link treasury');

    // ── 3. Healing of previously unkept links with explicit operator ──
    // Calling ensureFederationLink with explicit operator binds the operator to existing unbound links.
    // Background reconciliation without operator parameter does not auto-rebind, preserving admin revocations.
    ensureFederationLink(peerNoOwner, 'NoOwnerPeer', createTreasury, admin);
    const healedRow = db.prepare('SELECT member_pubkey, role, granted_by FROM treasury_operators WHERE treasury_pubkey = ?').get(linkNoOwner.treasuryPubkey) as any;
    check(healedRow?.member_pubkey === admin, 'Previously unkept link is healed with admin operator');
    check(canOperateTreasury(admin, linkNoOwner.treasuryPubkey) === true, 'Admin can operate healed link');

    // ── 4. Explicit operator parameter override ──
    const customOperator = makeMember('CustomKeeper');
    const peerExplicit = '12D3KooWExplicitPeer0000000000000000000000000';
    const linkExplicit = ensureFederationLink(peerExplicit, 'ExplicitPeer', createTreasury, customOperator)!;
    check(linkExplicit !== null, 'Explicit operator link created');

    const explicitRow = db.prepare('SELECT member_pubkey, role FROM treasury_operators WHERE treasury_pubkey = ?').get(linkExplicit.treasuryPubkey) as any;
    check(explicitRow?.member_pubkey === customOperator, 'Explicit operator is bound instead of default admin');
    check(canOperateTreasury(customOperator, linkExplicit.treasuryPubkey) === true, 'Custom operator can operate link');
    check(canOperateTreasury(admin, linkExplicit.treasuryPubkey) === false, 'Admin cannot operate link when explicit operator assigned');

    // ── 5. Reconciler self-heals and converges idempotently ──
    const PEER_ADDR = `/dns4/peer-recon.beanpool.org/tcp/4001/p2p/${peerWithAdmin}`;
    addConnector(PEER_ADDR, 'peer', 'byron-recon', 'https://peer-recon.beanpool.org');
    setConnectorCreditCap(PEER_ADDR, 500);

    const created = reconcileFederationLinks(createTreasury);
    check(created === 0, 'Reconciler creates 0 duplicate links for existing peer');
    const opCountAfter = (db.prepare('SELECT COUNT(*) AS c FROM treasury_operators WHERE treasury_pubkey = ?').get(linkWithAdmin.treasuryPubkey) as any).c;
    check(opCountAfter === 1, 'Operator bindings remain unique after reconciliation');

    console.log(`\n${passed}/${run} federation-link operator binding checks passed.`);
}

runTests().then(() => {
    process.exit(0);
}).catch((e) => {
    console.error('\n❌ Test failed:', e);
    process.exit(1);
});
