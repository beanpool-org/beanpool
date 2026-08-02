import json
import os

comments = []

db_finding = {
    "path": "apps/server/src/state-engine.ts",
    "position": 1211,
    "side": "RIGHT",
    "body": """### Database Architecture
**Risk:** Unhandled DB-memory consistency hazard. If `reconcileLedgerFromDb()` throws an error inside the `catch` block of `conservingTransaction` after a database rollback, the in-memory ledger remains permanently out of sync with the SQLite database. Subsequent in-memory operations will read and write corrupt balances, leading to money creation/destruction. A failure to resync memory to database truth after a transaction rollback is an unrecoverable consistency fault and the node process should immediately log and halt.

**Suggested Fix:**
```typescript
        } catch (resyncError: any) {
            console.error('[Ledger] FATAL: Resync after a failed write FAILED. Halting to protect ledger consistency:', resyncError?.message || resyncError);
            process.exit(1);
        }
```"""
}

impact_finding = {
    "path": "apps/server/src/state-engine.ts",
    "position": 2695,
    "side": "RIGHT",
    "body": """### Consequences & Impact
**Risk:** Premature WebSocket broadcast during transaction execution. `adminSetUserStatus` synchronously dispatches a `profile_updated` WebSocket broadcast to all connected clients. Because `adminSetUserStatus` is invoked *inside* `conservingTransaction` within `adminPruneUser`, if the subsequent `UPDATE posts` query fails or throws, SQLite rolls back the DB write and memory is restored, but the WebSocket broadcast has already been sent. Connected clients will update UI state believing the user was pruned, while the backend transaction actually failed and rolled back.

**Suggested Fix:**
```typescript
        // Perform status and post update statements directly in the transaction block
        db.prepare("UPDATE members SET status='pruned' WHERE public_key=?").run(publicKey);
        db.prepare("UPDATE posts SET status='cancelled', active=0 WHERE author_pubkey=? AND status IN ('active', 'pending')").run(publicKey);
    });
    // Broadcast events ONLY after the transaction successfully commits
    broadcast({ type: 'profile_updated', publicKey });
    broadcast({ type: 'user_pruned', publicKey });
```"""
}

comments.append(db_finding)
comments.append(impact_finding)

with open('scratch/review_comments.json', 'w') as f:
    json.dump(comments, f, indent=2)

print(f"Successfully compiled {len(comments)} review comments to scratch/review_comments.json")
