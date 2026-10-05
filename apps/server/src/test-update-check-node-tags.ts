/**
 * Every node's update check reads only node releases (v<semver>), never a vault-v* or native-v* one
 * (scratch/vault-golive/BLOCKERS.md, Hazards 1). POST /api/admin/check-update and the background check that
 * GET /api/version carries, over real HTTP through the real middleware (startHttpsServer), with GitHub answered here:
 *
 *   1. A vault-v1.0.0 release that GitHub made Latest, with v1.2.27 the newest node release: the check reports 1.2.27,
 *      its notes and its link, in one request, and never asks for releases/latest.
 *   2. The newest node release is the highest version, not the newest date (a v1.2.9 published after v1.10.0).
 *   3. Drafts, prereleases and v<semver>-suffix tags are not node releases.
 *   4. A list with no node release reads the tags, the same way (vault-v* and native-v* tags ignored).
 *   5. GitHub failing answers as before: the releases refused → the tags (now also read for v<semver> only); both
 *      refused → 502 "Could not reach GitHub"; fetch throwing → 500 with its message; no releases and no tags → 200
 *      with no version.
 *   6. The background check: GET /api/version shows 1.2.27 after it, and a failed later check keeps that answer.
 *
 * On origin/main 1–4, the tags fallback of 5 and 6 fail (5's error answers pass there too: they are unchanged): the check read releases/latest and answered "ault-v1.0.0" (the v stripped from
 * vault-v1.0.0), which never reads as newer, so no node would ever be told of v1.2.28.
 *
 * Run: SERVER_SUITES_ONLY=test-update-check-node-tags node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'UpdateCheckNodeTags123!';
process.env.APP_VERSION = '1.2.20';

import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { turnOn2faForTests } from './admin-auth-test-harness.js';

const PW = 'UpdateCheckNodeTags123!';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

// ── GitHub, answered here: nothing leaves this machine ───────────────────────────────────────────────────
type Answer = { status: number; body: unknown } | 'throw';
const github: { releases: Answer; tags: Answer; latest: Answer } = {
    releases: { status: 404, body: {} }, tags: { status: 404, body: {} }, latest: { status: 404, body: {} },
};
let asked: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input?.url ?? String(input));
    if (url.hostname !== 'api.github.com') return realFetch(input, init);
    asked.push(url.pathname + url.search);
    const p = url.pathname;
    const answer: Answer = p === '/repos/beanpool-org/beanpool/releases/latest' ? github.latest
        : p === '/repos/beanpool-org/beanpool/releases' ? github.releases
        : p === '/repos/beanpool-org/beanpool/tags' ? github.tags
        : { status: 404, body: { message: 'Not Found' } };
    if (answer === 'throw') throw new Error('getaddrinfo ENOTFOUND api.github.com');
    return new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body),
        { status: answer.status, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

const rel = (tag: string, published: string, extra: Record<string, unknown> = {}) => ({
    tag_name: tag, name: tag, draft: false, prerelease: false, body: `notes for ${tag}`, published_at: published, created_at: published,
    html_url: `https://github.com/beanpool-org/beanpool/releases/tag/${tag}`, ...extra,
});
const tag = (name: string) => ({ name, commit: { sha: '0'.repeat(40) } });
const ok = (body: unknown): Answer => ({ status: 200, body });

// GitHub lists releases newest first. The vault's first release is the newest, and Latest.
const VAULT = rel('vault-v1.0.0', '2026-10-06T00:00:00Z');
const WITH_VAULT = [VAULT, rel('native-v1.2.28', '2026-10-04T00:00:00Z'), rel('v1.2.27', '2026-10-01T00:00:00Z'), rel('v1.2.26', '2026-09-20T00:00:00Z')];
const TAGS = [tag('vault-v1.0.0'), tag('native-v1.2.28'), tag('v1.2.27'), tag('v1.2.26'), tag('native-v1.1.99')];

let BASE = '';
let tfa: ReturnType<typeof turnOn2faForTests>;
async function checkUpdate(): Promise<{ status: number; body: any }> {
    asked = [];
    const r = await fetch(`${BASE}/api/admin/check-update`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...tfa.headers() } });
    return { status: r.status, body: await r.json().catch(() => null) };
}
async function version(): Promise<any> {
    const r = await fetch(`${BASE}/api/version`);
    return r.json();
}

async function main() {
    console.log('--- TEST: the update check reads only node releases (v<semver>) ---');
    initAdminPassword();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    tfa = turnOn2faForTests(PW);

    // ── 1. A vault release is GitHub's Latest ───────────────────────────────────────────────────────────
    console.log('\n— 1. vault-v1.0.0 is Latest, v1.2.27 the newest node release —');
    github.latest = ok(VAULT);
    github.releases = ok(WITH_VAULT);
    github.tags = ok(TAGS);
    {
        const { status, body } = await checkUpdate();
        assert(status === 200 && body?.latestVersion === '1.2.27',
            `the check reports 1.2.27, not the vault's release (${status} latestVersion=${JSON.stringify(body?.latestVersion)})`);
        assert(body?.currentVersion === '1.2.20' && body?.updateAvailable === true, `1.2.27 is newer than this node's 1.2.20 (updateAvailable=${body?.updateAvailable})`);
        assert(body?.releaseUrl === 'https://github.com/beanpool-org/beanpool/releases/tag/v1.2.27' && body?.releaseNotes === 'notes for v1.2.27'
            && body?.publishedAt === '2026-10-01T00:00:00Z', `with v1.2.27's link, notes and date (${body?.releaseUrl})`);
        assert(JSON.stringify(Object.keys(body ?? {}).sort()) === JSON.stringify(['currentVersion', 'latestVersion', 'publishedAt', 'releaseNotes', 'releaseUrl', 'updateAvailable']),
            `the answer keeps its shape (${Object.keys(body ?? {}).join(', ')})`);
        assert(asked.length === 1 && asked[0].startsWith('/repos/beanpool-org/beanpool/releases?'),
            `one request, the releases list (asked: ${asked.join(' ')})`);
    }

    // ── 2. By version, not by date ──────────────────────────────────────────────────────────────────────
    console.log('\n— 2. the highest version wins, whatever its date —');
    github.releases = ok([
        rel('v1.2.9', '2026-10-05T00:00:00Z'),   // a fix for an old line, published last
        rel('v1.9.3', '2026-09-30T00:00:00Z'),
        rel('v1.10.0', '2026-09-01T00:00:00Z'),  // 1.10 > 1.9: numbers, not strings
        rel('v1.2.27', '2026-08-01T00:00:00Z'),
    ]);
    {
        const { status, body } = await checkUpdate();
        assert(status === 200 && body?.latestVersion === '1.10.0' && body?.releaseNotes === 'notes for v1.10.0',
            `v1.10.0 over a later v1.2.9 and over v1.9.3 (${status} latestVersion=${JSON.stringify(body?.latestVersion)})`);
    }

    // ── 3. Drafts and prereleases ───────────────────────────────────────────────────────────────────────
    console.log('\n— 3. drafts, prereleases and suffixed tags are not node releases —');
    github.releases = ok([
        rel('v1.4.0', '2026-10-05T00:00:00Z', { draft: true, published_at: null }),
        rel('v1.3.0', '2026-10-04T00:00:00Z', { prerelease: true }),
        rel('v1.3.1-rc.1', '2026-10-03T00:00:00Z'),
        rel('1.3.2', '2026-10-02T00:00:00Z'),
        VAULT,
        rel('v1.2.27', '2026-10-01T00:00:00Z'),
    ]);
    {
        const { status, body } = await checkUpdate();
        assert(status === 200 && body?.latestVersion === '1.2.27',
            `the draft v1.4.0, prerelease v1.3.0, v1.3.1-rc.1 and 1.3.2 are passed over (${status} latestVersion=${JSON.stringify(body?.latestVersion)})`);
    }

    // ── 4. No node release in the list: the tags ────────────────────────────────────────────────────────
    console.log('\n— 4. releases with no node release → the tags, read the same way —');
    github.releases = ok([VAULT, rel('native-v1.2.28', '2026-10-04T00:00:00Z')]);
    {
        const { status, body } = await checkUpdate();
        assert(status === 200 && body?.latestVersion === '1.2.27' && body?.updateAvailable === true && body?.releaseUrl === '' && body?.releaseNotes === '',
            `the newest v<semver> tag, 1.2.27, with no link or notes (${status} ${JSON.stringify(body)})`);
        assert(asked.length === 2 && asked[1].startsWith('/repos/beanpool-org/beanpool/tags?'), `the releases, then the tags (asked: ${asked.join(' ')})`);
    }

    // ── 5. GitHub failing: as before ────────────────────────────────────────────────────────────────────
    console.log('\n— 5. GitHub failing answers as before —');
    // releases/latest fails the same way, so origin/main's check meets the same GitHub: only the tags' order differs.
    github.releases = github.latest = { status: 403, body: { message: 'API rate limit exceeded' } };
    {
        const { status, body } = await checkUpdate();
        assert(status === 200 && body?.latestVersion === '1.2.27' && body?.releaseUrl === '',
            `the releases refused (403) → the tags: 1.2.27 (${status} ${JSON.stringify(body)})`);
    }
    github.tags = { status: 503, body: { message: 'unavailable' } };
    {
        const { status, body } = await checkUpdate();
        assert(status === 502 && JSON.stringify(body) === JSON.stringify({ currentVersion: '1.2.20', latestVersion: '', updateAvailable: false, error: 'Could not reach GitHub' }),
            `both refused → 502 "Could not reach GitHub" (${status} ${JSON.stringify(body)})`);
    }
    github.releases = github.latest = 'throw';
    {
        const { status, body } = await checkUpdate();
        assert(status === 500 && body?.error === 'getaddrinfo ENOTFOUND api.github.com' && body?.latestVersion === '' && body?.updateAvailable === false,
            `fetch throwing → 500 with its message (${status} ${JSON.stringify(body)})`);
    }
    github.releases = ok([]);
    github.latest = { status: 404, body: { message: 'Not Found' } };
    github.tags = ok([]);
    {
        const { status, body } = await checkUpdate();
        assert(status === 200 && body?.latestVersion === '' && body?.updateAvailable === false,
            `no releases and no tags → 200, no version, no update (${status} ${JSON.stringify(body)})`);
    }

    // ── 6. The background check, through GET /api/version ──────────────────────────────────────────────
    console.log('\n— 6. the background check —');
    {
        const before = await version();
        assert(before.latestVersion === undefined && before.updateAvailable === undefined, `before any check /api/version names no newer version (${JSON.stringify(before.latestVersion)})`);
        let check: (() => Promise<void>) | undefined;
        try { check = (await import('./node-release-check.js')).backgroundUpdateCheck; } catch (e: any) { console.error(`  (no background check to run: ${e.message})`); }
        assert(typeof check === 'function', 'the background check can be run');
        if (check) {
            github.latest = ok(VAULT);
            github.releases = ok(WITH_VAULT);
            github.tags = ok(TAGS);
            await check();
            const after = await version();
            assert(after.latestVersion === '1.2.27' && after.updateAvailable === true && typeof after.lastUpdateCheck === 'string',
                `after it, /api/version says 1.2.27 is available (${JSON.stringify({ latestVersion: after.latestVersion, updateAvailable: after.updateAvailable })})`);
            github.releases = github.latest = { status: 500, body: {} };
            github.tags = { status: 500, body: {} };
            await check();
            github.releases = github.latest = 'throw';
            await check();
            const kept = await version();
            assert(kept.latestVersion === '1.2.27' && kept.lastUpdateCheck === after.lastUpdateCheck,
                `a later check that can't reach GitHub keeps the last answer (${kept.latestVersion}, ${kept.lastUpdateCheck})`);
        }
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
