#!/usr/bin/env node
// server-suite-durations-snapshot.mjs — writes scripts/server-suite-durations.json, the committed durations that
// SERVER_SUITES_SHARD splits the server suites by (scripts/server-suite-shards.mjs).
//
// It reads the "Time per run, slowest first" table that scripts/run-server-suites.mjs prints, from one or more
// server_suites.log files: CI uploads them in each shard's test-all-logs-<shard> artifact when a run fails, so
// `gh run download <run id> --dir <folder>` fetches them. Each run's duration is the median of its PASSING times across
// the logs given (a failed or timed-out run's time says nothing about its length). Only runs the manifest still lists
// are kept; a run in none of the logs is left out, and the sharder puts it first.
//
// Refresh it when the shards' wall times drift apart (the aggregate job's slowest shard is the run's wall clock):
//   node scripts/server-suite-durations-snapshot.mjs <dir>/**/server_suites.log > scripts/server-suite-durations.json

import fs from 'node:fs';
import { SUITES, VARIANTS } from './server-suites.mjs';

const files = process.argv.slice(2);
if (files.length === 0) {
    console.error('usage: node scripts/server-suite-durations-snapshot.mjs <server_suites.log>...');
    process.exit(2);
}

const ids = new Set([
    ...SUITES.map((e) => (typeof e === 'string' ? e : e.name)),
    ...VARIANTS.map((v) => (v.tag ? `${v.name}(${v.tag})` : v.name)),
]);

// "3m21s" -> 201, "47.2s" -> 47.2
const seconds = (t) => {
    const m = /^(?:(\d+)m)?(\d+(?:\.\d+)?)s$/.exec(t);
    return m ? Number(m[1] || 0) * 60 + Number(m[2]) : NaN;
};

const times = new Map();
for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const start = lines.findIndex((l) => l.startsWith('──── Time per run'));
    if (start === -1) {
        console.error(`${file}: no "Time per run" table (the run stopped before its report?)`);
        process.exit(1);
    }
    for (const line of lines.slice(start + 1)) {
        const row = /^\s+(\S+)\s{2}(.) (\S+)(?:\s+\[serial\])?$/.exec(line);
        if (!row) break;
        const [, time, mark, id] = row;
        if (mark !== ' ' || !ids.has(id)) continue;
        if (!times.has(id)) times.set(id, []);
        times.get(id).push(seconds(time));
    }
}

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const out = {};
for (const id of [...times.keys()].sort()) out[id] = Math.round(median(times.get(id)) * 10) / 10;
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
console.error(`${Object.keys(out).length} of ${ids.size} runs from ${files.length} log(s)`);
