/**
 * Stop Node writing the environment into a diagnostic report — and do it before anything else can crash.
 *
 * THIS FILE MUST IMPORT NOTHING, AND IT MUST BE THE FIRST IMPORT OF THE ENTRY POINT. Both halves matter,
 * and the reason is how ES modules are evaluated: every `import` in a module is resolved and evaluated
 * before the first statement of that module's body runs. `index.ts` imports the whole application — and
 * `db/db.ts` opens SQLite at import — so a statement at the top of `index.ts` is not early at all. It is
 * after twenty-eight modules have already had their chance to throw.
 *
 * An exception thrown while that graph loads is exactly the failure an owner hits: `state.db` unopenable
 * or locked, a native binding missing from the image, a migration throwing at import. Nodes run with
 * `--report-uncaught-exception --report-directory=/data`, so Node writes its report right then. MEASURED
 * on the current entry point, with a marker in the environment and `state.db` unopenable:
 *
 *     has environmentVariables: true | marker present: true | event: Exception
 *
 * and with this module imported first: `false | false`. That is ADMIN_PASSWORD, BACKUP_ADMIN_PASSWORD,
 * CF_API_TOKEN and the rest, in plaintext, in the data dir.
 *
 * Why it cannot wait for the scrub in `process-handlers.ts`: a node that fails at import CRASH-LOOPS.
 * Every restart writes another report and no boot ever reaches the scrub, so nothing cleans them — and it
 * is precisely the owner whose node will not start who packs up the data dir and hands it to a stranger
 * for help. The manual tells them that file is safe to hand on. This is what makes that true.
 *
 * A module with imports of its own would defeat the point: those imports would evaluate first, and one of
 * them could be the thing that throws. So: no imports, ever, and nothing here may throw.
 *
 * This covers THIS thread. A worker thread keeps its own copy of the flag, so a report written by a
 * process that has workers (a loader, `pnpm dev`) still carries their `workers[].environmentVariables`.
 * The `--report-exclude-env` flag in the node's NODE_OPTIONS is what reaches those — MEASURED — and the
 * scrub in `process-handlers.ts` cleans whatever is already on disk. A node started as `node dist/index.js`
 * has no workers at all.
 */

try {
    if (process.report) process.report.excludeEnv = true;
} catch {
    // Node before 22.13 has no such property. Nothing else to do from here, and this must never throw:
    // it runs before any handler exists to catch it.
}

export {};
