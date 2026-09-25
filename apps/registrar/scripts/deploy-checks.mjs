// The checks the registrar deploy workflow (.github/workflows/registrar-deploy.yml) runs around `wrangler deploy`
// (design §5.2). Pure functions, unit-tested by apps/server/src/test-registrar-contract.ts, and a small CLI:
//
//   node scripts/deploy-checks.mjs bootstrapped < <output of `wrangler d1 execute … --json --command "SELECT name FROM d1_migrations"`>
//       Fails unless the database's d1_migrations table records 0001_init.sql, i.e. bootstrap-d1-migrations.sql
//       has run on it. Until then `wrangler d1 migrations apply --remote` would run 0001 against the live database
//       (re-seeding name_policy rows the live table has since dropped). Note that `wrangler d1 migrations list` and
//       `apply` both CREATE an empty d1_migrations table when there is none, so the table existing proves nothing.
//
//   node scripts/deploy-checks.mjs health --url <…/api/registrar/health> --commit <sha> --node-client <registrar-client.ts>
//       Polls the live health until it reports `commit` and accepts every protocol the node can send (the keys of
//       the node client's PROTOCOLS); fails after --tries (default 18) × --interval seconds (default 10).

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The keys of the node's PROTOCOLS literal, read from the source of apps/server/src/services/registrar-client.ts
// (the workflow has no TypeScript toolchain). The contract test checks this reads the real file right.
export function nodeProtocols(source) {
    const m = /^export const PROTOCOLS = \{\n([\s\S]*?)\n\} as const;$/m.exec(source);
    if (!m) throw new Error('no `export const PROTOCOLS = { … } as const;` in the node client');
    const keys = [...m[1].matchAll(/^\s*(v\d+)\s*:/gm)].map((x) => x[1]);
    if (!keys.length) throw new Error('the node client\'s PROTOCOLS names no protocol');
    return keys;
}

// What is wrong with a /health answer for a deploy of `commit` whose nodes speak `protos`: [] when nothing.
export function healthProblems(health, { commit, protos }) {
    if (!commit) throw new Error('no commit to check for');
    if (!health || typeof health !== 'object' || Array.isArray(health)) return ['health did not answer a JSON object'];
    const problems = [];
    if (health.status !== 'ok') problems.push(`status is ${JSON.stringify(health.status)}, not "ok"`);
    if (health.commit !== commit) problems.push(`commit is ${JSON.stringify(health.commit)}, not ${commit} (not deployed yet, or another deploy won)`);
    const accepted = Array.isArray(health.accepted_proto) ? health.accepted_proto : [];
    const missing = protos.filter((p) => !accepted.includes(p));
    if (!Array.isArray(health.accepted_proto) || missing.length)
        problems.push(`accepted_proto is ${JSON.stringify(health.accepted_proto)}: the Worker must accept every protocol the node can send (${protos.join(', ')})`);
    return problems;
}

// What is wrong with the d1_migrations rows (`wrangler d1 execute --json` output) before a remote
// `migrations apply`: [] when 0001_init.sql is recorded.
export function bootstrapProblems(wranglerJson) {
    let out;
    try { out = JSON.parse(wranglerJson); } catch { return ['wrangler did not answer JSON (is d1_migrations there at all?)']; }
    const names = (Array.isArray(out) ? out : [out]).flatMap((r) => (Array.isArray(r?.results) ? r.results : [])).map((row) => row?.name);
    if (names.includes('0001_init.sql')) return [];
    return [`d1_migrations records ${JSON.stringify(names)}, not 0001_init.sql: run scripts/bootstrap-d1-migrations.sql on the live database first (README "Deploy workflow"); applying migrations now would run 0001 against it`];
}

function arg(args, name, fallback) {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

async function health(args) {
    const url = arg(args, 'url');
    const commit = arg(args, 'commit');
    const client = arg(args, 'node-client');
    const tries = parseInt(arg(args, 'tries', '18'), 10);
    const interval = parseInt(arg(args, 'interval', '10'), 10);
    if (!url || !commit || !client) throw new Error('usage: health --url <health url> --commit <sha> --node-client <registrar-client.ts>');
    const protos = nodeProtocols(readFileSync(client, 'utf8'));
    let problems = [];
    for (let i = 1; i <= tries; i++) {
        let body = null;
        try {
            const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
            body = await res.json().catch(() => null);
            problems = res.ok ? healthProblems(body, { commit, protos }) : [`health answered HTTP ${res.status}`];
        } catch (e) {
            problems = [`health unreachable: ${e.message || e}`];
        }
        if (!problems.length) {
            console.log(`registrar health: commit ${commit}, accepted_proto ${JSON.stringify(body.accepted_proto)} ⊇ node ${JSON.stringify(protos)}`);
            return 0;
        }
        console.log(`try ${i}/${tries}: ${problems.join('; ')}`);
        if (i < tries) await new Promise((r) => setTimeout(r, interval * 1000));
    }
    console.log(`::error::the live registrar is not the Worker this run deployed: ${problems.join('; ')}`);
    return 1;
}

async function bootstrapped() {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    const problems = bootstrapProblems(text);
    if (problems.length) {
        console.log(`::error::${problems.join('; ')}`);
        return 1;
    }
    console.log('d1_migrations records 0001_init.sql: wrangler will apply only the migrations after what the database has');
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    const [cmd, ...args] = process.argv.slice(2);
    const run = { health: () => health(args), bootstrapped }[cmd];
    if (!run) {
        console.error('usage: deploy-checks.mjs health … | bootstrapped < wrangler-json');
        process.exit(2);
    }
    run().then((code) => process.exit(code), (e) => { console.error(`::error::${e.message || e}`); process.exit(1); });
}
