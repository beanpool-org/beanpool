// server-suite-shards.mjs — splits the server-suite runs into K shards, for SERVER_SUITES_SHARD=i/K in
// scripts/run-server-suites.mjs: .github/workflows/ci.yml runs each shard in a job of its own.
//
// Every shard of a run computes the split for itself, on a different runner, so all of them must get the SAME split or
// a run is made twice or never. It reads only the manifest and the committed snapshot scripts/server-suite-durations.json
// (never a machine's own recorded durations), and every tie is broken by run id.
//
// LPT: the runs, longest first, each to the shard with the least work so far (the first such shard). A shard's work is
// its pooled runs' time divided by the runs a CI shard makes at once (CI_POOL_JOBS, run-server-suites.mjs's CI default),
// plus the whole time of its serial runs, which have the shard to themselves after its pool. A run the snapshot lacks (a
// new suite) goes before all the rest with a guessed UNKNOWN_S, so new suites spread across the shards, one each in turn.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SNAPSHOT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server-suite-durations.json');
export const CI_POOL_JOBS = 3;
export const UNKNOWN_S = 120;

/** run id -> seconds, from the committed snapshot; {} when it is missing or unreadable. */
export function readSnapshot(file = SNAPSHOT_FILE) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

/** "2/6" -> { index: 2, count: 6 }; null when the spec is not i/K with 1 <= i <= K. */
export function parseShard(spec) {
    const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(spec || '');
    if (!m) return null;
    const index = Number(m[1]);
    const count = Number(m[2]);
    return index >= 1 && index <= count ? { index, count } : null;
}

/**
 * The runs split into `count` shards: [{ runs, load }], shard 1 first. `runs` are { id } objects (the runner's), kept as
 * given; `serial` is the manifest's SERIAL map; `durations` the snapshot.
 */
export function splitIntoShards(runs, { durations, serial, count }) {
    const known = (r) => Object.hasOwn(durations, r.id);
    const cost = (r) => (known(r) ? durations[r.id] : UNKNOWN_S) / (serial[r.id] ? 1 : CI_POOL_JOBS);
    const order = [...runs].sort((a, b) => (known(a) - known(b)) || (cost(b) - cost(a)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const shards = Array.from({ length: count }, () => ({ runs: [], load: 0 }));
    for (const run of order) {
        let least = shards[0];
        for (const s of shards) if (s.load < least.load) least = s;
        least.runs.push(run);
        least.load += cost(run);
    }
    return shards;
}
