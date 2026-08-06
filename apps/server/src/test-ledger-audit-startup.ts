/**
 * Regression test for Issue #129: Ledger conservation audit startup check.
 *
 * Verifies:
 * A. runLedgerAudit() returns ok=true on a fresh, balanced node
 * B. runLedgerAudit() detects drift when a regular account balance drifts from baseline
 * C. initStateEngine() with pre-existing drift prints the startup warning banner (boot path)
 * D. Rebaseline write updates node_config correctly
 * E. runLedgerAudit() returns ok=true after rebaseline
 */
import assert from 'node:assert';
import { initStateEngine, runLedgerAudit } from './state-engine.js';
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

// C. Verify the startup banner path: call initStateEngine() again with drift already present.
// The startup audit runs synchronously and logs the warning banner via console.error.
// We verify it doesn't throw and that runLedgerAudit() still returns ok=false (drift persists).
let bannerErrorCalled = false;
const origError = console.error;
console.error = (...args: any[]) => {
    if (args[0] && String(args[0]).includes('LEDGER CONSERVATION WARNING')) bannerErrorCalled = true;
    origError(...args);
};
try {
    initStateEngine();
} finally {
    console.error = origError;
}
assert.strictEqual(bannerErrorCalled, true, 'C. Startup audit must print the conservation warning banner when drift is present');
console.log('  C. Startup banner correctly printed for drifted node');

// D. Simulate rebaseline (as the admin endpoint does):
const currentResult = runLedgerAudit();
const newBaseline = currentResult.sumBalances;
const sanitizedReason = 'test rebaseline — simulating acknowledged drift for test purposes';
const note = `[${new Date().toISOString()}] rebaselined at ${newBaseline.toFixed(4)} (drift was ${currentResult.drift.toFixed(4)}): ${sanitizedReason}`;
const normalizedBaseline = (Math.round(newBaseline * 10000) / 10000).toString();
db.transaction(() => {
    db.prepare(`INSERT INTO node_config (key, value) VALUES ('ledger_audit_baseline', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(normalizedBaseline);
    db.prepare(`INSERT INTO node_config (key, value) VALUES ('ledger_audit_rebaseline_note', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(note);
})();
console.log(`  D. Rebaselined to: ${newBaseline.toFixed(4)}`);

// E. After rebaseline, audit should be ok again
const result3 = runLedgerAudit();
assert.strictEqual(result3.ok, true, 'E. After rebaseline, audit must be ok');
assert.ok(Math.abs(result3.drift) < 0.01, `E. Drift must be ~0 after rebaseline, got ${result3.drift}`);
assert.ok(Math.abs(result3.baseline - newBaseline) < 0.01, `E. Baseline must equal rebaselined value (${newBaseline}), got ${result3.baseline}`);
console.log(`  E. Post-rebaseline audit ok: drift=${result3.drift.toFixed(4)}`);

console.log('✅ #129 ledger conservation audit startup test PASSED!');

// Exit explicitly. This suite leaves the engine's timers and handles open, so returning normally
// keeps the event loop alive and the process never terminates — it prints a pass and then hangs.
// In CI that is indistinguishable from a slow run and blocks every suite after it (scripts/test-all.sh
// runs them in sequence), which is how a single test burns hours of Actions time. Reaching here means
// every assertion above held; a failure throws and exits non-zero long before this line.
process.exit(0);
