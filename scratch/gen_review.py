import json

comments = [
    {
        "path": "apps/server/src/state-engine.ts",
        "position": 1257,
        "side": "RIGHT",
        "body": """### Database Architecture & State Integrity
**Risk:** Allowing `COMMONS_BALANCE` to enter a deficit via `payFromCommons` with `opts?.allowDeficit` persists a negative balance for `'COMMONS_POOL'` in SQLite. However, node initialization in `state-engine.ts` (line 330) checks `if (commonsRow && commonsRow.balance > 0)` when restoring `COMMONS_BALANCE` on startup. When `commonsRow.balance` is negative, boot restoration is skipped and `COMMONS_BALANCE` resets to `0`, silently wiping out the recorded deficit and violating total currency conservation upon server restart.

**Suggested Fix:**
Update the boot restoration logic in `apps/server/src/state-engine.ts` (line 330) to check for any non-zero numeric balance:
```typescript
const commonsRow = db.prepare("SELECT balance FROM accounts WHERE public_key = 'COMMONS_POOL'").get() as any;
if (commonsRow && typeof commonsRow.balance === 'number' && commonsRow.balance !== 0) {
    setCommonsBalance(commonsRow.balance);
    console.log(`🏛️ Restored Commons Pool balance: ${commonsRow.balance.toFixed(2)}`);
}
```"""
    },
    {
        "path": "apps/server/src/federation-settlement-state.ts",
        "position": 207,
        "side": "RIGHT",
        "body": """### Database Architecture & Concurrency Control
**Risk:** In `advanceSettlement`, when the compare-and-swap update yields `result.changes === 0` (due to a concurrent transition), the code checks `if (current?.state === to) return current;`. If a concurrent worker transitioned the settlement to state `to` *without* passing metadata (or with empty metadata), this early return skips persisting `extra.receipt` or `extra.receiptPayload` supplied by the caller, stranding receipt metadata needed for replay verification.

**Suggested Fix:**
```typescript
if (result.changes === 0) {
    const current = getSettlement(key);
    if (current?.state === to) {
        if ((extra?.receipt && !current.receipt) || (extra?.receiptPayload && !current.receiptPayload)) {
            db.prepare(`
                UPDATE settlements
                SET receipt = COALESCE(?, receipt), receipt_payload = COALESCE(?, receipt_payload)
                WHERE key = ?
            `).run(extra?.receipt ?? null, extra?.receiptPayload ?? null, key);
            return getSettlement(key)!;
        }
        return current;
    }
    throw new Error(`Concurrent settlement transition conflict for ${key} (expected ${row.state})`);
}
```"""
    },
    {
        "path": "apps/server/src/db/db.ts",
        "position": 170,
        "side": "RIGHT",
        "body": """### Database Schema & DDL Migration Constraints
**Risk:** In `db.ts`, columns are added via `ALTER TABLE settlements ADD COLUMN fee REAL NOT NULL DEFAULT 0`. As noted in the comments, SQLite does not support adding `CHECK` constraints (e.g., `CHECK (fee >= 0)`) via `ALTER TABLE`. Pre-existing databases created prior to step 3b will lack database-level constraint protection against negative fee values.

**Suggested Fix:**
Ensure all DB modification helpers (such as `crossNodeFee`) explicitly guard against negative fee values before executing SQL writes:
```typescript
// Ensure fee calculations are strictly non-negative at runtime gate
const fee = Math.max(0, calculatedFee);
```"""
    },
    {
        "path": "apps/server/src/federation-settlement-state.ts",
        "position": 254,
        "side": "RIGHT",
        "body": """### Database Performance & Query Optimization
**Risk:** `reservedAgainstPeer` executes `SELECT COALESCE(SUM(amount), 0) FROM settlements WHERE direction = 'inbound' AND peer_id = ? AND state IN ('reserved', 'held')`. `idx_settlements_peer` covers `(peer_id, state)`, requiring SQLite to evaluate `direction = 'inbound'` via table scan filter. While `peer_id` and `state` provide good selectivity, compound indexing including `direction` prevents unnecessary row fetches as settlement records grow.

**Suggested Fix:**
```sql
-- Consider updating idx_settlements_peer in schema.sql to cover direction:
CREATE INDEX IF NOT EXISTS idx_settlements_peer ON settlements(peer_id, direction, state);
```"""
    },
    {
        "path": "apps/server/src/federation-settlement-exchange.ts",
        "position": 137,
        "side": "RIGHT",
        "body": """### Database Architecture & Dual-State Consistency
**Risk / Architectural Affirmation:** Direct in-memory mutations to `ledger` and `COMMONS_BALANCE` occur alongside SQLite writes in `transfer()`, `moveToCommons()`, and `payFromCommons()`. Wrapped inside `settlementTransaction`, any SQLite transaction failure correctly triggers `reconcileLedgerFromDb()` and restores `COMMONS_BALANCE` from snapshot (`setCommonsBalance(commonsBefore)`), ensuring SQLite rollbacks do not leave in-memory state desynchronized.

**Suggested Fix:**
Maintain this strict rollback isolation pattern across all state-mutating federation exchange procedures."""
    }
]

with open('scratch/review_comments.json', 'w') as f:
    json.dump(comments, f, indent=2)

print('Saved', len(comments), 'comments to scratch/review_comments.json')
