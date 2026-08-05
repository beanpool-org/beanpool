/**
 * Regression test for Issue #129: Ledger conservation audit startup check.
 *
 * Verifies:
 * A. runLedgerAudit() returns ok=true on a fresh, balanced node
 * B. runLedgerAudit() detects drift when a regular account balance drifts from baseline
 * C. Rebaseline write updates node_config correctly
 * D. runLedgerAudit() returns ok=true after rebaseline
 */
import assert from 'node:assert';
import { initStateEngine, runLedgerAudit, createMember } from './state-engine.js';
import { db } from './db/db.js';

console.log('Running #129 ledger conservation audit startup test...');

// Init with empty DB
initStateEngine();

// A. Fresh node: should be balanced (sum=0, baseline=0, drift=0)
const result1 = runLedgerAudit();
assert.strictEqual(result1.ok, true, 'A. Fresh node must be balanced');
assert.ok(Math.abs(result1.drift) < 0.01, `A. drift must be < 0.01, got ${result1.drift}`);
assert.strictEqual(result1.strandedEscrows, 0, 'A. No stranded escrows on fresh node');
console.log(`  A. Baseline established at: ${result1.baseline.toFixed(4)}`);

// B. Simulate drift: insert a phantom account balance that wasn't part of a transaction
// (This mirrors what happened on the 'review' node — a direct balance write)
db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES ('phantom_test_account', 100, 0)`).run();
const result2 = runLedgerAudit();
// Baseline is 0 from step A; sum is now 100; drift = 100
assert.strictEqual(result2.ok, false, 'B. Drift of 100 must be detected as not ok');
assert.ok(Math.abs(result2.drift - 100) < 0.01, `B. Drift must be ~100, got ${result2.drift}`);
assert.ok(Math.abs(result2.sumBalances - 100) < 0.01, `B. Sum must be ~100, got ${result2.sumBalances}`);
console.log(`  B. Drift correctly detected: sum=${result2.sumBalances.toFixed(4)}, drift=${result2.drift.toFixed(4)}`);

// C. Simulate rebaseline (as the admin endpoint does):
const newBaseline = result2.sumBalances;
const note = `[${new Date().toISOString()}] test rebaseline — simulating acknowledged drift for test purposes`;
db.prepare(`INSERT OR REPLACE INTO node_config (key, value) VALUES ('ledger_audit_baseline', ?)`).run(String(newBaseline));
db.prepare(`INSERT OR REPLACE INTO node_config (key, value) VALUES ('ledger_audit_rebaseline_note', ?)`).run(note);
console.log(`  C. Rebaselined to: ${newBaseline.toFixed(4)}`);

// D. After rebaseline, audit should be ok again
const result3 = runLedgerAudit();
assert.strictEqual(result3.ok, true, 'D. After rebaseline, audit must be ok');
assert.ok(Math.abs(result3.drift) < 0.01, `D. Drift must be ~0 after rebaseline, got ${result3.drift}`);
assert.ok(Math.abs(result3.baseline - newBaseline) < 0.01, `D. Baseline must equal rebaselined value (${newBaseline}), got ${result3.baseline}`);
console.log(`  D. Post-rebaseline audit ok: drift=${result3.drift.toFixed(4)}`);

console.log('✅ #129 ledger conservation audit startup test PASSED!');
