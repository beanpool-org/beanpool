/**
 * Who the public directory holds back, and that the owners are told (PR #1935, fix round 1).
 *
 * A community is held back only while it has no name of its own (blank, or exactly "BeanPool Community", the name the
 * screens show before it is named), or while its server's .env says DIRECTORY_UNLISTED=1 (our own test and review
 * nodes). Never by its address or a callsign. A held-back community is never held back silently: the owners'
 * diagnostics (read by the manager's Directory Publishing and static/settings.js) say which.
 *
 * Boots the real server (real middleware) as a main server whose community has no name yet, with the registry pointed
 * at a local fixture, and starts the publisher as index.ts does at boot. Asserts:
 *   1. unnamed: the boot starts the publisher anyway, nothing is sent, and the diagnostics say `unnamed`
 *   2. the default name "BeanPool Community" saved through POST /api/local/update-identity: still nothing sent
 *   3. a real name saved through that route is published at once: no restart, no push-interval save (the first-start
 *      wizard saves the name alone), and the diagnostics then say nothing holds it back
 *   4. a rename is published at once too
 *   5. a test-looking address (CF_RECORD_NAME test.example.org) and callsign ("test") hide nothing
 *   6. DIRECTORY_UNLISTED=1: a rename sends nothing, the diagnostics say `unlisted`, and the manual push answers 409
 *      saying why; removed again, a rename is published
 *   7. docker-compose.yml passes DIRECTORY_UNLISTED from a node's .env (it passes only what it names), and .env.example
 *      lists it
 *
 * Contacts no registry: DIRECTORY_REGISTRY_URL is the fixture on 127.0.0.1.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-directory-hold-back.ts (the runner: SERVER_SUITES_ONLY)
 */
import http from 'node:http';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.PUBLIC_ADDRESS_NAME;
delete process.env.PUBLIC_ADDRESS_AUTO;
delete process.env.DIRECTORY_UNLISTED;
delete process.env.NODE_PROFILE;
process.env.REGISTRAR_URL = 'http://127.0.0.1:1';
process.env.ADMIN_PASSWORD = 'HoldBackAdmin123!';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// The fixture registry: every push it receives, in order.
const pushes: Record<string, unknown>[] = [];
const registry = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        try { pushes.push(JSON.parse(body)); } catch { pushes.push({ unreadable: body }); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"ok"}');
    });
});
await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
process.env.DIRECTORY_REGISTRY_URL = `http://127.0.0.1:${(registry.address() as { port: number }).port}/functions/v1/directory-register`;

let BASE = '';
let ADMIN: Record<string, string> = {};

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...ADMIN },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
}

/** The next push after `from` pushes, or null if none came within `ms`. */
async function nextPush(from: number, ms: number): Promise<Record<string, unknown> | null> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (pushes.length > from) return pushes[from];
        await new Promise((r) => setTimeout(r, 50));
    }
    return pushes.length > from ? pushes[from] : null;
}

const heldBack = async () => (await call('GET', '/api/local/admin/diagnostics')).json?.directoryHeldBack;
const rename = (communityName: string) => call('POST', '/api/local/update-identity', { communityName });

async function main() {
    console.log('The directory holds back only an unnamed community or a DIRECTORY_UNLISTED server, and says so...\n');
    const { initTls } = await import('./services/tls.js');
    const { initAdminPassword, getLocalConfig } = await import('./config/local-config.js');
    const { initStateEngine, setNodeRole, getNodeConfig } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { startP2P } = await import('./p2p.js');
    const { initDirectoryPublisher } = await import('./services/directory-publisher.js');

    await initTls();
    initAdminPassword();
    initStateEngine();
    setNodeRole('primary');
    ADMIN = (await import('./admin-auth-test-harness.js')).ownerSessionHeaders();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    const p2p = await startP2P(0, 0);

    // ── 1. Unnamed at boot ───────────────────────────────────────────────────────────────────────────────────────────
    assert(getLocalConfig().communityName === null, 'a new community has no name');
    assert((getNodeConfig().directoryPushIntervalHours ?? 12) > 0, 'and is set to publish (the default interval)');
    // As index.ts boots a main server. The timer must run: it is what lists the community once it is named.
    const started = initDirectoryPublisher();
    assert(started === true, `the boot starts the publisher on an unnamed community too (initDirectoryPublisher() = ${started})`);
    assert(await heldBack() === 'unnamed', `the owners' diagnostics say it is held back for having no name (${JSON.stringify(await heldBack())})`);

    // ── 2. The default name is no name ───────────────────────────────────────────────────────────────────────────────
    let from = pushes.length;
    const dflt = await rename('BeanPool Community');
    assert(dflt.status === 200, `saving the default name answers 200 (${dflt.status})`);
    assert(await nextPush(from, 1500) === null, 'the default name "BeanPool Community" is not published');
    assert(await heldBack() === 'unnamed', 'and the diagnostics still say unnamed');

    // ── 3. Named after boot: published at once, without a restart ────────────────────────────────────────────────────
    from = pushes.length;
    const named = await rename('Riverbend Commons');
    assert(named.status === 200, `saving a real name answers 200 (${named.status})`);
    const first = await nextPush(from, 5000);
    assert(first !== null && first.communityName === 'Riverbend Commons',
        `the name saved through the route is published at once, with no restart and no interval save (${JSON.stringify(first && { communityName: first.communityName, nodeId: first.nodeId })})`);
    assert(first !== null && first.nodeId === p2p.peerId.toString(), 'signed as this node');
    assert(await heldBack() === null, `the diagnostics then say nothing holds it back (${JSON.stringify(await heldBack())})`);

    // ── 4. A rename is published at once ─────────────────────────────────────────────────────────────────────────────
    from = pushes.length;
    await rename('Riverbend Valley');
    const renamed = await nextPush(from, 5000);
    assert(renamed !== null && renamed.communityName === 'Riverbend Valley', `a rename is published at once (${JSON.stringify(renamed?.communityName)})`);

    // ── 5. No address or callsign hides a real community ─────────────────────────────────────────────────────────────
    process.env.CF_RECORD_NAME = 'test.example.org';
    await call('POST', '/api/local/update-identity', { callsign: 'test' });
    assert(await heldBack() === null, `a test-looking address and callsign hold nothing back (${JSON.stringify(await heldBack())})`);
    const manual = await call('POST', '/api/local/admin/directory/push', {});
    assert(manual.status === 200 && manual.json?.success === true, `a manual push from it is published (${manual.status} ${JSON.stringify(manual.json)})`);
    delete process.env.CF_RECORD_NAME;

    // ── 6. DIRECTORY_UNLISTED: our test and review nodes ─────────────────────────────────────────────────────────────
    process.env.DIRECTORY_UNLISTED = '1';
    assert(await heldBack() === 'unlisted', `with DIRECTORY_UNLISTED=1 the diagnostics say unlisted (${JSON.stringify(await heldBack())})`);
    from = pushes.length;
    await rename('Review Node Vale');
    assert(await nextPush(from, 1500) === null, 'a rename under DIRECTORY_UNLISTED sends nothing');
    const refused = await call('POST', '/api/local/admin/directory/push', {});
    assert(refused.status === 409 && refused.json?.success === false && /DIRECTORY_UNLISTED/.test(String(refused.json?.error)),
        `the manual push answers 409 saying why (${refused.status} ${JSON.stringify(refused.json)})`);
    assert(pushes.length === from, 'and sends nothing');
    delete process.env.DIRECTORY_UNLISTED;
    from = pushes.length;
    await rename('Riverbend Again');
    const back = await nextPush(from, 5000);
    assert(back !== null && back.communityName === 'Riverbend Again', `without it, a rename is published again (${JSON.stringify(back?.communityName)})`);

    // ── 7. The flag reaches a node: docker-compose.yml passes only the variables it names from a node's .env ───────────
    const fs = await import('node:fs');
    const root = new URL('../../../', import.meta.url);
    assert(/^\s*- DIRECTORY_UNLISTED=\$\{DIRECTORY_UNLISTED:-\}\s*$/m.test(fs.readFileSync(new URL('docker-compose.yml', root), 'utf-8')),
        'docker-compose.yml passes DIRECTORY_UNLISTED from the node\'s .env to the server, empty by default');
    assert(/^DIRECTORY_UNLISTED=\s*$/m.test(fs.readFileSync(new URL('.env.example', root), 'utf-8')), '.env.example lists it, empty');

    console.log(`\n${passed}/${run} checks passed.`);
    await p2p.stop();
    registry.close();
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Directory hold-back checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
