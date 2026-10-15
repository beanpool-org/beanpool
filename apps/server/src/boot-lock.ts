/**
 * The node's `data/.node-running.lock` (node-running-lock.ts), taken as index.ts's modules load: right after the report
 * scrub, before db/swap-at-boot.ts renames anything and before db/db.ts opens state.db, which both happen as they are
 * imported. While a `beanpool restore` or another node holds it, the import blocks here, so nothing of this node touches
 * the database until it is let go.
 *
 * Blocking, not a top-level await: an await here would not hold back the imports after it, which would evaluate (and open
 * state.db) while this waited (measured, #2017 fix round 1). Imports nothing of the server's but the lock.
 */
import { holdNodeRunningLock } from './node-running-lock.js';

holdNodeRunningLock();
