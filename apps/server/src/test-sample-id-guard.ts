/**
 * No write takes an id from the sample community (sample-id-guard.ts; DESIGN-global-showcase-fable.md §6 W1, the
 * safety line "no number from the fixture may ever reach a ledger or any API write"), over a REAL HTTPS round trip
 * through every middleware the server mounts.
 *
 *   1. the guard's own reading: a sample id under an id key at any depth, arrays included, is found; free text and a
 *      sample-looking word that isn't the id shape are not
 *   2. the sweep: every write route the server serves (each POST, PUT, PATCH and DELETE on its routers), three ways —
 *      a sample id in its path (each parameter), in its query, and in its body (rotating through the id keys the apps
 *      send) — answers 400 `sample_id`, and no table changes
 *   3. the guard is the guard and nothing else: the same routes with the same sample word under a free-text key, or a
 *      real-shaped id, never answer `sample_id`; reads (GET) with a sample id in the path are never refused by it
 *   4. the Start a community owner route refuses an unsigned caller (and the address stays)
 *
 * Local only: it talks to the server it starts on localhost and nothing else.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-sample-id-guard.ts
 */
// A module, not a global script: everything loads by `await import`, and without this its `main` collides with the one
// in phone-door-test-harness.ts (TS2393 in the server build).
export {};

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function main() {
    const { findSampleIdInBody, findSampleIdInUrl, SAMPLE_ID_REFUSAL } = await import('./sample-id-guard.js');

    console.log('── 1. what the guard reads ──');
    const found: [unknown, boolean, string][] = [
        [{ id: 'sample-tx-bread' }, true, 'a top-level id'],
        [{ postId: 'sample-deal-shelves' }, true, 'postId'],
        [{ transactionIds: ['real-1', 'sample-tx-gift'] }, true, 'an array of ids'],
        [{ vote: { decisionId: 'sample-decision-compost-bay' } }, true, 'a nested decisionId'],
        [{ to: 'sample-community-example-valley' }, true, 'to'],
        [{ targetPubkey: 'sample-x' }, true, 'targetPubkey'],
        [{ items: [{ enterpriseId: 'sample-enterprise-bakery' }] }, true, 'an id inside an array of objects'],
        [{ title: 'sample-sale' }, false, 'a title that is the word "sample-sale" (free text is not read)'],
        [{ description: 'sample-tx-bread' }, false, 'a description'],
        [{ id: 'Sample-tx' }, false, 'an id not of the sample shape'],
        [{ id: 'a sample-tx' }, false, 'an id with a space'],
        [{ id: 'abc123' }, false, 'a real-shaped id'],
        [{ id: 42 }, false, 'a number'],
        [null, false, 'no body'],
        ['sample-x', false, 'a bare string body'],
    ];
    for (const [body, want, label] of found) {
        assert((findSampleIdInBody(body) !== null) === want, `body ${label}: ${want ? 'refused' : 'passed'}`);
    }
    assert(findSampleIdInUrl('/api/decisions/sample-decision-compost-bay/vote', {}) !== null, 'a sample id in a path segment is found');
    assert(findSampleIdInUrl('/api/decisions/sample%2Ddecision/vote', {}) !== null, 'a percent-encoded one too');
    assert(findSampleIdInUrl('/api/marketplace/posts', { id: 'sample-tx' }) !== null, 'a sample id in the query is found');
    assert(findSampleIdInUrl('/api/marketplace/posts', { id: ['x', 'sample-tx'] }) !== null, 'a repeated query value too');
    assert(findSampleIdInUrl('/api/marketplace/posts/abc', { q: 'sample' }) === null, 'a plain path and query are not');

    console.log('\n── 2. the sweep: every write route, through the real middleware ──');
    const { db } = await import('./db/db.js');
    const { initStateEngine } = await import('./state-engine.js');
    const { initTls } = await import('./services/tls.js');
    const https = await import('./https-server.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    initStateEngine();
    await initTls();
    const port = await https.startHttpsServer(0);
    const BASE = `https://localhost:${port}`;

    const app: any = https.getKoaApp();
    const served = [...new Set<string>(app.middleware.filter((m: any) => m.router).flatMap((m: any) => m.router.stack)
        .flatMap((l: any) => (l.methods as string[]).map((m) => `${m} ${l.path}`)))].sort();
    const writes = served.filter(r => WRITE_METHODS.has(r.split(' ')[0]));
    const reads = served.filter(r => r.startsWith('GET '));
    assert(writes.length > 150, `the server serves many write routes, every one swept (${writes.length})`);
    const withParams = writes.filter(r => /:[A-Za-z0-9_]+/.test(r));
    assert(withParams.length > 40, `many of them take an id in the path (${withParams.length})`);

    const materialise = (p: string, value: string) => p.replace(/:([A-Za-z0-9_]+)\??/g, value).replace(/\(\.\*\)/g, 'x');
    const call = async (method: string, url: string, body?: unknown) => {
        // The limiters in front of the parser count every call from this one address; reset, each call meets the guard.
        resetGatewayRateLimit();
        https.resetAdminRateLimit();
        const res = await fetch(`${BASE}${url}`, {
            method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
        });
        const text = await res.text();
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, code: json?.code as string | undefined };
    };

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('event_reminders_sent')").all() as { name: string }[]).map(t => t.name);
    const counts = () => Object.fromEntries(tables.map(t => [t, (db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get() as { c: number }).c]));
    const before = counts();

    // The id keys the apps send, in turn, so the sweep covers flat, array and nested shapes across the routes.
    const BODIES: ((v: string) => unknown)[] = [
        v => ({ id: v }),
        v => ({ postId: v }),
        v => ({ transactionId: v }),
        v => ({ transactionIds: ['00000000', v] }),
        v => ({ decisionId: v, choice: 'for' }),
        v => ({ enterpriseId: v, amount: 1 }),
        v => ({ to: v, amount: 1 }),
        v => ({ targetPubkey: v }),
        v => ({ nested: { treasuryId: v } }),
        v => ({ list: [{ projectId: v }] }),
    ];
    const missed: string[] = [];
    let i = 0;
    for (const route of writes) {
        const [method, routePath] = route.split(' ');
        const ways: [string, string, unknown][] = [
            ['body', `${materialise(routePath, 'sentinel')}`, BODIES[i++ % BODIES.length]('sample-sweep-body')],
            ['query', `${materialise(routePath, 'sentinel')}?id=sample-sweep-query`, undefined],
        ];
        if (/:[A-Za-z0-9_]+/.test(routePath)) ways.push(['path', materialise(routePath, 'sample-sweep-path'), {}]);
        for (const [way, url, body] of ways) {
            const r = await call(method, url, body);
            if (r.status !== 400 || r.code !== SAMPLE_ID_REFUSAL) missed.push(`${route} (${way}: ${r.status} ${r.code ?? ''})`);
        }
    }
    assert(missed.length === 0, `every write route answers 400 ${SAMPLE_ID_REFUSAL} to a sample id in its path, query and body (${writes.length} routes; missed: ${missed.slice(0, 10).join(', ') || 'none'})`);
    const after = counts();
    const changed = tables.filter(t => before[t] !== after[t]);
    assert(changed.length === 0, `and no table changed (${changed.join(', ') || 'none'})`);

    console.log('\n── 3. the guard refuses sample ids, and nothing else ──');
    // Free text and real-shaped ids pass the guard to whatever comes next (a 401, a 404, a 400 of the route's own): never
    // `sample_id`. Only member routes here: an admin route's refusals are tarpitted (memory http-sweep-test-gotchas).
    const memberWrites = writes.filter(r => !/ \/api\/(local\/admin|manager|admin)\//.test(r)).slice(0, 60);
    const falseHits: string[] = [];
    for (const route of memberWrites) {
        const [method, routePath] = route.split(' ');
        for (const body of [{ title: 'sample-sale', description: 'sample-sweep', message: 'sample-x' }, { id: 'abc123', postId: 'f00d' }]) {
            const r = await call(method, materialise(routePath, 'sentinel'), body);
            if (r.code === SAMPLE_ID_REFUSAL) falseHits.push(`${route} ${JSON.stringify(body)}`);
        }
    }
    assert(memberWrites.length > 30 && falseHits.length === 0,
        `free text and real-shaped ids are never refused as sample ids (${memberWrites.length} routes; hits: ${falseHits.slice(0, 5).join(', ') || 'none'})`);
    const readHits: string[] = [];
    for (const route of reads.filter(r => /:[A-Za-z0-9_]+/.test(r) && !/ \/api\/(local\/admin|manager|admin)\//.test(r)).slice(0, 40)) {
        const r = await call('GET', materialise(route.split(' ')[1], 'sample-sweep-read'));
        if (r.code === SAMPLE_ID_REFUSAL) readHits.push(route);
    }
    assert(readHits.length === 0, `a read with a sample id in its path is not the guard's to refuse (${readHits.join(', ') || 'none'})`);

    console.log('\n── 4. the Start a community owner route ──');
    const { getStartCommunityUrl } = await import('./config/start-community.js');
    const was = getStartCommunityUrl();
    const unsigned = await call('POST', '/api/local/admin/start-community-url', { url: 'https://elsewhere.example.org/start' });
    assert((unsigned.status === 401 || unsigned.status === 403) && getStartCommunityUrl() === was,
        `an unsigned caller can't change where Start a community leads (${unsigned.status})`);

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
