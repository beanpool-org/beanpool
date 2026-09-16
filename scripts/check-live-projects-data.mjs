// Read-only inspection script for projects, commons proposals, and treasuries data.
// Safe to run against any DB: uses readonly: true, does not mutate rows or schema.
// Usage:
//   node scripts/check-live-projects-data.mjs [path/to/state.db]

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const dbPath = process.argv[2] || (
    process.env.BEANPOOL_DATA_DIR
        ? path.join(process.env.BEANPOOL_DATA_DIR, 'state.db')
        : path.join(process.cwd(), 'data', 'state.db')
);

console.log(`[check-live-data] Inspecting database at: ${dbPath}`);

if (!fs.existsSync(dbPath)) {
    console.log(`[check-live-data] Database file does not exist at ${dbPath}. Database is completely empty / uninitialized.`);
    process.exit(0);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

function tableExists(tableName) {
    const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
    return !!row;
}

const report = {
    dbPath,
    crowdfundProjects: { count: 0, rows: [] },
    commonsProjectsBlob: { exists: false, count: 0, proposals: [] },
    votingRoundsBlob: { exists: false, count: 0, rounds: [] },
    treasuries: { count: 0, rows: [] },
    projectTransactions: { count: 0, rows: [] },
};

if (tableExists('projects')) {
    const countRow = db.prepare('SELECT COUNT(*) as c FROM projects').get();
    report.crowdfundProjects.count = countRow ? countRow.c : 0;
    if (report.crowdfundProjects.count > 0) {
        report.crowdfundProjects.rows = db.prepare('SELECT id, creator_pubkey, title, goal_amount, current_amount, status, created_at FROM projects').all();
    }
}

if (tableExists('node_config')) {
    const cpRow = db.prepare("SELECT value FROM node_config WHERE key = 'commons_projects'").get();
    if (cpRow && cpRow.value) {
        report.commonsProjectsBlob.exists = true;
        try {
            const parsed = JSON.parse(cpRow.value);
            report.commonsProjectsBlob.count = Array.isArray(parsed) ? parsed.length : 0;
            report.commonsProjectsBlob.proposals = parsed;
        } catch (e) {
            report.commonsProjectsBlob.error = `Failed to parse commons_projects JSON: ${e.message}`;
        }
    }

    const vrRow = db.prepare("SELECT value FROM node_config WHERE key = 'voting_rounds'").get();
    if (vrRow && vrRow.value) {
        report.votingRoundsBlob.exists = true;
        try {
            const parsed = JSON.parse(vrRow.value);
            report.votingRoundsBlob.count = Array.isArray(parsed) ? parsed.length : 0;
            report.votingRoundsBlob.rounds = parsed;
        } catch (e) {
            report.votingRoundsBlob.error = `Failed to parse voting_rounds JSON: ${e.message}`;
        }
    }
}

if (tableExists('members')) {
    const memberCols = db.prepare("PRAGMA table_info(members)").all().map(c => c.name);
    if (memberCols.includes('is_treasury')) {
        const countRow = db.prepare('SELECT COUNT(*) as c FROM members WHERE is_treasury = 1').get();
        report.treasuries.count = countRow ? countRow.c : 0;
        if (report.treasuries.count > 0) {
            report.treasuries.rows = db.prepare('SELECT public_key, callsign, status, earned_credit, earned_surplus, working_capital_ceiling FROM members WHERE is_treasury = 1').all();
        }
    }
}

if (tableExists('transactions')) {
    const cols = db.prepare("PRAGMA table_info(transactions)").all().map(c => c.name);
    if (cols.includes('project_id')) {
        const countRow = db.prepare('SELECT COUNT(*) as c FROM transactions WHERE project_id IS NOT NULL').get();
        report.projectTransactions.count = countRow ? countRow.c : 0;
        if (report.projectTransactions.count > 0) {
            report.projectTransactions.rows = db.prepare('SELECT id, from_pubkey, to_pubkey, amount, memo, project_id FROM transactions WHERE project_id IS NOT NULL LIMIT 20').all();
        }
    }
}

console.log('\n--- Live Data Summary ---');
console.log(`Crowdfund 'projects' table rows: ${report.crowdfundProjects.count}`);
console.log(`Commons 'commons_projects' blob proposals: ${report.commonsProjectsBlob.count}`);
console.log(`Commons 'voting_rounds' blob rounds: ${report.votingRoundsBlob.count}`);
console.log(`Existing Enterprise/Treasury members: ${report.treasuries.count}`);
console.log(`Transactions referencing a project: ${report.projectTransactions.count}`);

if (report.crowdfundProjects.count > 0) {
    console.log('\nCrowdfund Projects:');
    for (const p of report.crowdfundProjects.rows) {
        console.log(`  - [${p.id}] "${p.title}" by ${p.creator_pubkey.slice(0, 12)}… (${p.current_amount}/${p.goal_amount} Beans, status=${p.status})`);
    }
}

if (report.commonsProjectsBlob.count > 0) {
    console.log('\nCommons Proposals:');
    for (const cp of report.commonsProjectsBlob.proposals) {
        console.log(`  - [${cp.id}] "${cp.title}" by ${(cp.proposerPubkey || '').slice(0, 12)}… (${cp.requestedAmount} Beans, status=${cp.status})`);
    }
}

if (report.treasuries.count > 0) {
    console.log('\nTreasuries / Enterprises:');
    for (const t of report.treasuries.rows) {
        console.log(`  - [${t.public_key.slice(0, 12)}…] ${t.callsign} (status=${t.status}, earnedCredit=${t.earned_credit}, earnedSurplus=${t.earned_surplus})`);
    }
}

console.log('\nInspection complete (0 mutations performed).');
