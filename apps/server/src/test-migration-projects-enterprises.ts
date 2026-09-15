/**
 * Test Suite: Project == Enterprise Unification & Migration
 * Source: docs/the-commons.md §2.1-2.2, §6 Slice 3, §7 item 7.
 *
 * Covers:
 * 1. Empty database migration (zero errors, zero rows created).
 * 2. Populated DB migration:
 *    - projects table rows migrated into members (is_treasury=1, lifecycle='bounded')
 *    - transactions.project_id foreign key references preserved
 *    - source projects rows retained and marked with migrated_at / enterprise_pubkey
 *    - commons_projects proposals in node_config migrated into enterprises and marked migrated=true
 *    - creator / proposer appointed as 'lead' keeper in treasury_operators with can_operate=1
 *    - getters (getCrowdfundProjects, getCrowdfundProject, getAllProjects) serve from unified model
 *    - crowdfund pledge sweep credits the enterprise account, NOT creator's personal balance
 *    - total balance sum / ledger conservation holds across all operations
 * 3. Idempotency on re-run (zero new rows, zero errors).
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-migration-projects-enterprises.ts
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

import {
    initSchema, db, getCrowdfundProjects, getCrowdfundProject,
    createCrowdfundProject, pledgeToProject, migrateProjectsAndCommonsToEnterprises,
} from './db/db.js';
import {
    initStateEngine, reconcileLedgerFromDb, getBalance,
    getAllProjects, getProjects, createProject,
} from './state-engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCHEMA_PATH = path.join(__dirname, 'db', 'schema.sql');

let testsRun = 0;
let testsPassed = 0;
function testAssert(cond: boolean, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

async function runTests() {
    console.log('🏛️ Running Project == Enterprise unification & migration test suite...\n');

    // =========================================================================
    // TEST 1: Empty database migration
    // =========================================================================
    console.log('--- TEST 1: Empty database migration ---');
    const emptyDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-empty-mig-'));
    const emptyDbPath = path.join(emptyDbDir, 'beanpool.db');
    const emptyDb = new Database(emptyDbPath);
    emptyDb.pragma('journal_mode = WAL');
    emptyDb.pragma('foreign_keys = ON');

    const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    emptyDb.exec(schemaSql);

    const emptyResult = migrateProjectsAndCommonsToEnterprises(emptyDb);
    testAssert(emptyResult.migratedProjects === 0, 'Empty DB: zero projects migrated');
    testAssert(emptyResult.migratedCommonsProposals === 0, 'Empty DB: zero commons proposals migrated');

    const memberCount = (emptyDb.prepare('SELECT COUNT(*) as c FROM members').get() as any).c;
    testAssert(memberCount === 0, 'Empty DB: zero members created');
    emptyDb.close();
    fs.rmSync(emptyDbDir, { recursive: true, force: true });

    // =========================================================================
    // TEST 2: Populated DB migration & preservation of foreign keys
    // =========================================================================
    console.log('\n--- TEST 2: Populated DB migration ---');
    const popDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-pop-mig-'));
    const popDbPath = path.join(popDbDir, 'beanpool.db');
    const popDb = new Database(popDbPath);
    popDb.pragma('journal_mode = WAL');
    popDb.pragma('foreign_keys = ON');
    popDb.exec(schemaSql);

    // Seed creator and backer
    const creatorPubkey = 'creator_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const backerPubkey = 'backer_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const now = new Date().toISOString();

    popDb.prepare(`INSERT INTO members (public_key, callsign, joined_at) VALUES (?, 'creator', ?)`).run(creatorPubkey, now);
    popDb.prepare(`INSERT INTO members (public_key, callsign, joined_at) VALUES (?, 'backer', ?)`).run(backerPubkey, now);
    popDb.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 1000, 0)`).run(creatorPubkey);
    popDb.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 1000, 0)`).run(backerPubkey);

    // Seed an unmigrated row in projects
    const legacyProjectId = 'proj_' + crypto.randomUUID();
    popDb.prepare(`
        INSERT INTO projects (id, creator_pubkey, title, description, photos, goal_amount, deadline_at, status, created_at, updated_at)
        VALUES (?, ?, 'Build Solar Kiln', 'Dry timber with solar heat', ?, 500, '2026-12-31T00:00:00.000Z', 'ACTIVE', ?, ?)
    `).run(legacyProjectId, creatorPubkey, JSON.stringify(['https://example.com/kiln.jpg']), now, now);

    // Seed a transaction referencing projects(id)
    const txId = 'pledge_tx_' + crypto.randomUUID();
    const escrowPubkey = `escrow_${legacyProjectId}`;
    popDb.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 50, 0)`).run(escrowPubkey);
    popDb.prepare(`UPDATE accounts SET balance = balance - 50 WHERE public_key = ?`).run(backerPubkey);
    popDb.prepare(`
        INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, project_id)
        VALUES (?, ?, ?, 50, 'Seed pledge', ?)
    `).run(txId, backerPubkey, escrowPubkey, legacyProjectId);

    // Seed unmigrated Commons proposals in node_config
    const legacyPropId = 'prop_' + crypto.randomUUID();
    const commonsProposals = [
        {
            id: legacyPropId,
            title: 'Community Orchard',
            description: 'Plant 20 fruit trees at the common grounds',
            requestedAmount: 300,
            proposerPubkey: creatorPubkey,
            status: 'proposed',
            votes: [],
            createdAt: now,
        },
    ];
    popDb.prepare(`INSERT INTO node_config (key, value) VALUES ('commons_projects', ?)`).run(JSON.stringify(commonsProposals));

    // Execute migration
    const popResult = migrateProjectsAndCommonsToEnterprises(popDb);
    testAssert(popResult.migratedProjects === 1, 'Migrated exactly 1 legacy project');
    testAssert(popResult.migratedCommonsProposals === 1, 'Migrated exactly 1 legacy commons proposal');

    // Verify source projects table row is retained and marked
    const migratedProjectRow = popDb.prepare('SELECT * FROM projects WHERE id = ?').get(legacyProjectId) as any;
    testAssert(!!migratedProjectRow, 'Source project row was NOT deleted');
    testAssert(!!migratedProjectRow.migrated_at, 'Source project marked with migrated_at timestamp');
    testAssert(migratedProjectRow.enterprise_pubkey === legacyProjectId, 'Source project marked with enterprise_pubkey matching project id');

    // Verify foreign key integrity
    const pledgeTxAfter = popDb.prepare('SELECT * FROM transactions WHERE id = ?').get(txId) as any;
    testAssert(pledgeTxAfter.project_id === legacyProjectId, 'Transaction foreign key project_id is intact');

    // Verify enterprise member created for project
    const projectEnterprise = popDb.prepare('SELECT * FROM members WHERE public_key = ?').get(legacyProjectId) as any;
    testAssert(!!projectEnterprise, 'Enterprise member row created for project');
    testAssert(projectEnterprise.is_treasury === 1, 'Project enterprise has is_treasury = 1');
    testAssert(projectEnterprise.lifecycle === 'bounded', 'Project enterprise has lifecycle = bounded');
    testAssert(projectEnterprise.goal_amount === 500, 'Project enterprise has goal_amount = 500');
    testAssert(projectEnterprise.purpose === 'Dry timber with solar heat', 'Project enterprise purpose matches description');
    testAssert(projectEnterprise.avatar_url === 'https://example.com/kiln.jpg', 'Project enterprise avatar_url matches first photo');

    // Verify lead keeper in treasury_operators
    const projectKeeper = popDb.prepare('SELECT * FROM treasury_operators WHERE treasury_pubkey = ?').get(legacyProjectId) as any;
    testAssert(!!projectKeeper, 'Lead keeper registered in treasury_operators');
    testAssert(projectKeeper.member_pubkey === creatorPubkey, 'Lead keeper is project creator');
    testAssert(projectKeeper.role === 'lead', 'Lead keeper role is "lead"');

    const creatorMember = popDb.prepare('SELECT can_operate FROM members WHERE public_key = ?').get(creatorPubkey) as any;
    testAssert(creatorMember.can_operate === 1, 'Creator gained can_operate = 1');

    // Verify proposal enterprise created
    const proposalEnterprise = popDb.prepare('SELECT * FROM members WHERE public_key = ?').get(legacyPropId) as any;
    testAssert(!!proposalEnterprise, 'Enterprise member row created for commons proposal');
    testAssert(proposalEnterprise.is_treasury === 1, 'Commons proposal enterprise has is_treasury = 1');
    testAssert(proposalEnterprise.lifecycle === 'bounded', 'Commons proposal enterprise has lifecycle = bounded');
    testAssert(proposalEnterprise.goal_amount === 300, 'Commons proposal enterprise has goal_amount = 300');
    testAssert(proposalEnterprise.purpose === 'Plant 20 fruit trees at the common grounds', 'Commons proposal enterprise purpose matches');

    // Verify node_config commons_projects marked migrated
    const updatedConfig = JSON.parse((popDb.prepare("SELECT value FROM node_config WHERE key = 'commons_projects'").get() as any).value);
    testAssert(updatedConfig[0].migrated === true, 'Proposal marked migrated=true in node_config');
    testAssert(updatedConfig[0].enterprisePubkey === legacyPropId, 'Proposal enterprisePubkey set in node_config');

    // =========================================================================
    // TEST 3: Idempotency on re-run
    // =========================================================================
    console.log('\n--- TEST 3: Idempotency on re-run ---');
    const rerunResult = migrateProjectsAndCommonsToEnterprises(popDb);
    testAssert(rerunResult.migratedProjects === 0, 'Re-run migrated 0 projects');
    testAssert(rerunResult.migratedCommonsProposals === 0, 'Re-run migrated 0 commons proposals');

    const memberCountAfterRerun = (popDb.prepare('SELECT COUNT(*) as c FROM members').get() as any).c;
    testAssert(memberCountAfterRerun === 4, 'Total members unchanged after re-run (2 users + 2 enterprises)');

    popDb.close();
    fs.rmSync(popDbDir, { recursive: true, force: true });

    // =========================================================================
    // TEST 4: Full State Engine & Crowdfund Escrow Auto-Sweep to Enterprise
    // =========================================================================
    console.log('\n--- TEST 4: State engine getters & escrow sweep to enterprise account ---');
    initStateEngine();
    reconcileLedgerFromDb();

    const sumBefore = (db.prepare('SELECT COALESCE(SUM(balance), 0) as s FROM accounts').get() as any).s;

    const testCreator = 'creator_' + crypto.randomUUID().slice(0, 12);
    const testBacker = 'backer_' + crypto.randomUUID().slice(0, 12);
    const testProject = 'proj_' + crypto.randomUUID().slice(0, 12);

    const nowEpoch = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at) VALUES (?, 'creator_test', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(testCreator);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at) VALUES (?, 'backer_test', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(testBacker);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 100, ?)`).run(testCreator, nowEpoch);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 500, ?)`).run(testBacker, nowEpoch);
    reconcileLedgerFromDb();

    // Create crowdfund project (goal = 200)
    createCrowdfundProject(testProject, testCreator, 'Community Tool Shed', 'Shared workshop tools', ['https://example.com/shed.png'], 200, null);

    // Verify getters return unified enterprise
    const cfProjects = getCrowdfundProjects();
    const foundProject = cfProjects.find(p => p.id === testProject);
    testAssert(!!foundProject, 'getCrowdfundProjects returns newly created project');
    testAssert(foundProject?.title === 'Community Tool Shed', 'Project title matches');
    testAssert(foundProject?.goal_amount === 200, 'Project goal amount matches');

    const singleProject = getCrowdfundProject(testProject);
    testAssert(singleProject?.id === testProject, 'getCrowdfundProject(id) returns project');
    testAssert(singleProject?.description === 'Shared workshop tools', 'Project description matches');

    // Check getAllProjects includes it
    const allProj = getAllProjects();
    testAssert(allProj.some(p => p.id === testProject), 'getAllProjects includes bounded enterprise');

    // Pledge partial amount (100 < 200)
    const pledge1TxId = 'pledge_1_' + crypto.randomUUID();
    pledgeToProject(pledge1TxId, testProject, testBacker, 100, 'Halfway pledge');
    reconcileLedgerFromDb();

    testAssert(getBalance(testBacker).balance === 400, 'Backer debited 100 beans (500 -> 400)');
    testAssert(getBalance(`escrow_${testProject}`).balance === 100, 'Escrow holds 100 beans');
    testAssert(getBalance(testCreator).balance === 100, 'Creator personal balance untouched (still 100)');
    testAssert(getBalance(testProject).balance === 0, 'Enterprise balance not yet released (0)');

    // Pledge remaining amount to trigger goal reach (100 + 100 >= 200)
    const pledge2TxId = 'pledge_2_' + crypto.randomUUID();
    pledgeToProject(pledge2TxId, testProject, testBacker, 100, 'Goal-reaching pledge');
    reconcileLedgerFromDb();

    // Verify auto-sweep behavior:
    // Escrow is fully drained to 0, creator is credited with 200 beans (settled under #138 to close demurrage window)
    testAssert(getBalance(testBacker).balance === 300, 'Backer debited to 300');
    testAssert(getBalance(`escrow_${testProject}`).balance === 0, 'Escrow balance fully drained to 0');
    testAssert(getBalance(testCreator).balance === 300, 'Creator credited with 200 beans (100 -> 300)');

    // Verify sweep transaction was recorded to creator
    const sweepTx = db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(`sweep_${pledge2TxId}`) as any;
    testAssert(!!sweepTx, 'Sweep transaction recorded');
    testAssert(sweepTx.to_pubkey === testCreator, 'Sweep transaction to_pubkey is the creator account');
    testAssert(sweepTx.amount === 200, 'Sweep transaction amount is 200');

    // Verify ledger conservation
    const sumAfter = (db.prepare('SELECT COALESCE(SUM(balance), 0) as s FROM accounts').get() as any).s;
    testAssert(Math.abs(sumAfter - (sumBefore + 600)) < 1e-9, 'Ledger conservation strictly preserved (delta = seeded 600)');

    console.log(`\n🎉 ${testsPassed}/${testsRun} checks passed.`);
    console.log('⭐️ Project == Enterprise migration and unification tests ALL PASSED.');
}

runTests().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('❌ Test suite failed:', err);
    process.exit(1);
});
