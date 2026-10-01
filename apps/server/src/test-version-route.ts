/**
 * GET /api/version and the background update check (routes/settings.ts, version.ts), over real HTTP:
 *
 *   1. The commit /api/version answers is asked of git once, not on every request (the confirm review of #1384: a git
 *      spawn per unauthenticated request, about 6 ms of blocked event loop each where git exists). A `git` first on PATH
 *      that logs each call stands in for the real one: after the first answer, 1,000 more requests run it no more, and
 *      each still answers the commit it gave.
 *   2. The update check's switch reaches a node and its operator: docker-compose.yml passes DISABLE_UPDATE_CHECK from the
 *      node's .env to the server (a variable it leaves out never reaches the container), .env.example lists it, the
 *      server reads it, and the operator manual tells operators how to turn the check off.
 *
 * On origin/main both fail: every request ran git, and nothing passed or documented the switch.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-version-route.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

async function main() {
    // ── 1. git is asked once ────────────────────────────────────────────────────────────────────────────
    console.log('\n— 1. /api/version asks git once —');
    {
        // A git that logs its arguments and answers a made-up commit, first on PATH before the server is loaded.
        const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-route-git-'));
        const log = path.join(shimDir, 'calls.log');
        fs.writeFileSync(path.join(shimDir, 'git'), `#!/bin/sh\necho "$@" >> '${log}'\necho 0badc0de\n`, { mode: 0o755 });
        process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`;
        const gitCalls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(l => l.startsWith('rev-parse')).length : 0;

        const { initTls } = await import('./services/tls.js');
        const se = await import('./state-engine.js');
        const { startHttpsServer } = await import('./https-server.js');
        const { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
        await initTls();
        se.initStateEngine();
        const port = await startHttpsServer(0);
        // The gateway's limit would answer 429 from the 121st request on, before the route runs: off, so all reach it.
        updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });
        const version = async () => {
            const r = await fetch(`https://localhost:${port}/api/version`);
            return { status: r.status, body: await r.json().catch(() => null) as { version?: string; commit?: string } | null };
        };

        const first = await version();
        assert(first.status === 200 && first.body?.commit === '0badc0de' && typeof first.body?.version === 'string',
            `the first answer carries the commit git gave (${first.status} ${JSON.stringify(first.body)})`);
        const before = gitCalls();
        const statuses = new Map<string, number>();
        for (let i = 0; i < 1000; i++) {
            const r = await version();
            const key = `${r.status} ${r.body?.commit}`;
            statuses.set(key, (statuses.get(key) ?? 0) + 1);
        }
        const during = gitCalls() - before;
        assert(statuses.size === 1 && statuses.get('200 0badc0de') === 1000,
            `1,000 more requests each answer 200 with that commit (${[...statuses].map(([k, n]) => `${n}× ${k}`).join(', ')})`);
        assert(during === 0, `and run git no more: ${during} call(s) during them`);
        assert(gitCalls() <= 1, `git was asked ${gitCalls()} time(s) in all`);
        fs.rmSync(shimDir, { recursive: true, force: true });
    }

    // ── 2. The update check's switch ────────────────────────────────────────────────────────────────────
    console.log('\n— 2. the update check can be turned off —');
    {
        const compose = read('docker-compose.yml');
        assert(/^\s*- DISABLE_UPDATE_CHECK=\$\{DISABLE_UPDATE_CHECK:-\}\s*$/m.test(compose),
            'docker-compose.yml passes DISABLE_UPDATE_CHECK from .env to the server, empty (the check on) by default');
        assert(/^DISABLE_UPDATE_CHECK=\s*$/m.test(read('.env.example')), '.env.example lists it, empty');
        assert(/process\.env\.DISABLE_UPDATE_CHECK !== 'true'/.test(read('apps/server/src/routes/settings.ts')),
            "the server's background check runs unless it is 'true' (routes/settings.ts)");
        const manual = ['packages/beanpool-guide/operators/server/updates-and-health.md', 'packages/beanpool-guide/operators/privacy/what-the-server-sees.md'];
        const missing = manual.filter(p => !read(p).includes('DISABLE_UPDATE_CHECK=true'));
        assert(missing.length === 0, `the operator manual's updates page and its page on what the server sends elsewhere say how to turn it off (${missing.length ? `missing in ${missing.join(', ')}` : 'both'})`);
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ /api/version runs git once, and the update check has an operator switch.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
