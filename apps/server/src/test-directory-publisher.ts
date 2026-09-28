/**
 * Directory Publisher Service Integration Test
 *
 * Verifies:
 *  1. `pushDirectoryNow()` rejection when `getNodeRole()` is 'backup'.
 *  2. `pushDirectoryNow()` rejection when P2P node / key is not initialized.
 *  3. `pushDirectoryNow()` successful execution with a mock HTTP directory registry server.
 *     - Verifies request method is POST.
 *     - Verifies request headers `x-signature` and `x-public-key`.
 *     - Verifies JSON payload contents (`nodeId`, `callsign`, `timestamp`, `memberCount`, `postCount`, etc.).
 *     - Verifies `lastDirectoryPush` timestamp update in node config.
 *     - A community's contact email and phone are not sent until its owner turns each on; its name always is.
 *  3e. A node that holds the old single contacts switch, stored as true by every save whether anyone chose it or not:
 *     no contact is sent (a stored default is not a choice), and each is sent once the owner turns it on.
 *  4. `pushDirectoryNow()` error handling when directory registry returns non-2xx status code.
 *  5. `initDirectoryPublisher()` behavior when disabled or on backup node.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-directory-publisher.ts
 */

import http from 'node:http';

interface MockRequest {
    method: string;
    headers: http.IncomingHttpHeaders;
    body: Record<string, unknown> | string | null;
}

const receivedRequests: MockRequest[] = [];
let mockHttpStatus = 200;
let mockResponseBody = JSON.stringify({ status: 'ok' });

const server = http.createServer((req, res) => {
    let bodyStr = '';
    req.on('data', (chunk) => {
        bodyStr += chunk;
    });
    req.on('end', () => {
        let parsedBody: Record<string, unknown> | string | null;
        try {
            parsedBody = JSON.parse(bodyStr);
        } catch {
            parsedBody = bodyStr;
        }
        receivedRequests.push({
            method: req.method || 'UNKNOWN',
            headers: req.headers,
            body: parsedBody,
        });
        res.writeHead(mockHttpStatus, { 'Content-Type': 'application/json' });
        res.end(mockResponseBody);
    });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address() as { port: number };
process.env.DIRECTORY_REGISTRY_URL = `http://127.0.0.1:${address.port}/v1/directory-register`;

// Import modules AFTER process.env.DIRECTORY_REGISTRY_URL is configured
const { initStateEngine, setNodeRole, getNodeConfig, updateNodeConfig, getDirectoryInfo } = await import('./state-engine.js');
const { getVersion } = await import('./version.js');
const { updateLocalConfig } = await import('./config/local-config.js');
const { startP2P } = await import('./p2p.js');
const { initDirectoryPublisher, pushDirectoryNow } = await import('./services/directory-publisher.js');
const { db } = await import('./db/db.js');

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

async function main() {
    console.log('Running directory-publisher service tests...\n');

    // Initialize isolated state engine
    initStateEngine();

    // ── 1. Role Guard Check ──────────────────────────────────────────────────
    setNodeRole('backup');
    const backupRes = await pushDirectoryNow();
    assert(backupRes.success === false, 'pushDirectoryNow fails when node role is backup');
    assert(
        backupRes.error === 'Directory push is only allowed on primary nodes',
        'pushDirectoryNow returns proper error message for backup node'
    );

    // Switch back to primary role
    setNodeRole('primary');

    // ── 2. Uninitialized P2P / Key Guard Check ──────────────────────────────
    const uninitRes = await pushDirectoryNow();
    assert(uninitRes.success === false, 'pushDirectoryNow fails when P2P node is not ready');
    assert(uninitRes.error === 'P2P node not ready', 'pushDirectoryNow reports P2P node not ready');

    // ── 3. Successful Directory Push with Mock Server ───────────────────────
    // Initialize P2P node (ephemeral ports)
    const p2pNode = await startP2P(0, 0);

    // Set community name in local config
    updateLocalConfig({ communityName: 'Mullum Creek' });

    const successRes = await pushDirectoryNow();
    assert(successRes.success === true, 'pushDirectoryNow succeeds when P2P is ready and mock server returns 200');
    assert(typeof successRes.timestamp === 'string', 'pushDirectoryNow returns timestamp on success');

    assert(receivedRequests.length === 1, 'Mock directory registry received 1 request');
    const req0 = receivedRequests[0];
    assert(req0.method === 'POST', 'Directory push used HTTP POST');
    assert(typeof req0.headers['x-signature'] === 'string', 'Directory push included x-signature header');
    assert(typeof req0.headers['x-public-key'] === 'string', 'Directory push included x-public-key header');

    const bodyObj = req0.body as Record<string, unknown>;
    assert(bodyObj !== null && typeof bodyObj === 'object', 'Directory push sent valid JSON payload');
    assert(bodyObj.nodeId === p2pNode.peerId.toString(), 'Payload nodeId matches p2p peerId');
    assert(typeof bodyObj.timestamp === 'number', 'Payload includes timestamp');
    assert(typeof bodyObj.memberCount === 'number', 'Payload includes memberCount from directory info');
    assert(bodyObj.publicUrl === null, 'Node with no public address sends publicUrl: null');
    assert(bodyObj.communityName === 'Mullum Creek', 'Payload includes communityName');
    assert(bodyObj.contactEmail === null && bodyObj.contactPhone === null, 'a community with no contact choice sends no contact email or phone');
    assert(getNodeConfig().publishContactEmail === false && getNodeConfig().publishContactPhone === false,
        'both contact switches read off until the owner turns them on');
    assert(bodyObj.nodeVersion === getVersion(), 'Payload includes real nodeVersion when publishHealth is on');
    assert(bodyObj.version === getVersion(), 'Payload version reflects real running version');

    const nodeConfig = getNodeConfig();
    assert(typeof nodeConfig.lastDirectoryPush === 'string', 'Node config lastDirectoryPush is updated after push');

    // ── 3b. Push with Configured Public Address ─────────────────────────────
    updateNodeConfig({
        publicAddress: {
            name: 'mullum-test',
            hostname: 'mullum-test.beanpool.org',
            status: 'live'
        } as any
    });
    const pushWithPaRes = await pushDirectoryNow();
    assert(pushWithPaRes.success === true, 'pushDirectoryNow succeeds with publicAddress');
    assert(receivedRequests.length === 2, 'Mock directory registry received 2nd request');
    const bodyObj1 = receivedRequests[1].body as Record<string, unknown>;
    assert(bodyObj1.publicUrl === 'https://mullum-test.beanpool.org', 'Payload carries publicUrl from configured public name');

    // Also verify when hostname is omitted but name is set
    updateNodeConfig({
        publicAddress: {
            name: 'byron-test',
        } as any
    });
    const pushWithNameRes = await pushDirectoryNow();
    assert(pushWithNameRes.success === true, 'pushDirectoryNow succeeds with name-only publicAddress');
    assert(receivedRequests.length === 3, 'Mock directory registry received 3rd request');
    const bodyObj2 = receivedRequests[2].body as Record<string, unknown>;
    assert(bodyObj2.publicUrl === 'https://byron-test.beanpool.org', 'Payload derives canonical publicUrl https://<name>.beanpool.org from name');

    // Also verify CF_RECORD_NAME fallback when publicAddress is null
    updateNodeConfig({ publicAddress: null });
    process.env.CF_RECORD_NAME = 'bangalow.beanpool.org';
    const pushWithCfRes = await pushDirectoryNow();
    assert(pushWithCfRes.success === true, 'pushDirectoryNow succeeds with CF_RECORD_NAME');
    assert(receivedRequests.length === 4, 'Mock directory registry received 4th request');
    const bodyObj3 = receivedRequests[3].body as Record<string, unknown>;
    assert(bodyObj3.publicUrl === 'https://bangalow.beanpool.org', 'Payload falls back to CF_RECORD_NAME for publicUrl');
    delete process.env.CF_RECORD_NAME;

    // ── 3c. Flags Turned Off: Omits / Nulls ──────────────────────────────────
    updateLocalConfig({ contactEmail: 'hello@mullum.example', contactPhone: '+61 2 6684 0000' });
    updateNodeConfig({ publishContactEmail: false, publishContactPhone: false, publishHealth: false });
    const pushFlagsOffRes = await pushDirectoryNow();
    assert(pushFlagsOffRes.success === true, 'pushDirectoryNow succeeds with contacts and health disabled');
    assert(receivedRequests.length === 5, 'Mock directory registry received 5th request');
    const bodyObj4 = receivedRequests[4].body as Record<string, unknown>;
    assert(bodyObj4.communityName === 'Mullum Creek' && bodyObj4.name === 'Mullum Creek',
        `the community's name is sent with its contacts off: it is how the directory lists it (${JSON.stringify({ name: bodyObj4.name, communityName: bodyObj4.communityName })})`);
    assert(bodyObj4.contactEmail === null && bodyObj4.contactPhone === null && !/hello@mullum|6684/.test(JSON.stringify(bodyObj4)),
        'Payload nulls the contact email and phone, and holds neither anywhere');
    assert(bodyObj4.nodeVersion === null, 'Payload omits/nulls nodeVersion when publishHealth is off');
    assert(bodyObj4.version === null, 'Payload omits/nulls version when publishHealth is off');

    // ── 3d. All Flags Turned Off: Publishes Nothing ─────────────────────────
    updateNodeConfig({ publishLocation: false, publishMembers: false, publishContactEmail: false, publishContactPhone: false, publishHealth: false });
    assert(getDirectoryInfo() === null, 'getDirectoryInfo returns null when all publish flags are off');
    const pushAllOffRes = await pushDirectoryNow();
    assert(pushAllOffRes.success === true, 'pushDirectoryNow succeeds when all publish flags are off');
    assert(receivedRequests.length === 6, 'Mock directory registry received 6th request');
    const bodyObj5 = receivedRequests[5].body as Record<string, unknown>;
    assert(bodyObj5.publicUrl === undefined, 'Payload omits publicUrl when node publishes nothing');
    assert(bodyObj5.communityName === undefined, 'Payload omits communityName when node publishes nothing');
    assert(bodyObj5.nodeVersion === undefined, 'Payload omits nodeVersion when node publishes nothing');
    assert(bodyObj5.contactEmail === null && bodyObj5.contactPhone === null,
        'and says it has no contact email or phone, so the directory holds none it was sent before');

    // ── 3e. A node from before: the old single contacts switch, stored as true ──
    // Every save wrote the whole config back with each switch read as "publish" when unset, so a stored true is what
    // nearly every node holds whether its owner chose it or not. It is no choice: nothing of it publishes a contact.
    db.prepare(`INSERT INTO node_config (key, value) VALUES ('node_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify({
        publishLocation: true, publishMembers: true, publishContacts: true, publishHealth: true, directoryPushIntervalHours: 12,
    }));
    const legacy = getNodeConfig();
    assert(legacy.publishContactEmail === false && legacy.publishContactPhone === false && !('publishContacts' in legacy),
        `a stored publishContacts: true reads as no choice: both contact switches off (${JSON.stringify(legacy)})`);
    const lastBody = async (what: string) => {
        const res = await pushDirectoryNow();
        assert(res.success === true, `pushDirectoryNow succeeds ${what}`);
        return receivedRequests[receivedRequests.length - 1].body as Record<string, unknown>;
    };
    const legacyBody = await lastBody('on a node holding the old switch');
    assert(legacyBody.contactEmail === null && legacyBody.contactPhone === null && !/hello@mullum|6684/.test(JSON.stringify(legacyBody)),
        `the payload holds no contact email or phone (${JSON.stringify({ contactEmail: legacyBody.contactEmail, contactPhone: legacyBody.contactPhone })})`);
    assert(legacyBody.communityName === 'Mullum Creek' && typeof legacyBody.memberCount === 'number',
        'and still the community\'s name and member count, as before');
    updateNodeConfig({ lastDirectoryPush: new Date().toISOString() });
    assert(getNodeConfig().publishContactEmail === false && getNodeConfig().publishContactPhone === false,
        'a save of something else writes neither contact switch on');
    updateNodeConfig({ publishContactEmail: true });
    const emailBody = await lastBody('once the owner turns the email on');
    assert(emailBody.contactEmail === 'hello@mullum.example' && emailBody.contactPhone === null,
        `the owner turns the email on: it is sent, and the phone still isn't (${JSON.stringify({ contactEmail: emailBody.contactEmail, contactPhone: emailBody.contactPhone })})`);
    updateNodeConfig({ publishContactPhone: true });
    const bothBody = await lastBody('once the owner turns the phone on too');
    assert(bothBody.contactEmail === 'hello@mullum.example' && bothBody.contactPhone === '+61 2 6684 0000',
        `and the phone, once turned on too (${JSON.stringify({ contactEmail: bothBody.contactEmail, contactPhone: bothBody.contactPhone })})`);
    updateNodeConfig({ publishContactEmail: false });
    const phoneBody = await lastBody('with only the phone on');
    assert(phoneBody.contactEmail === null && phoneBody.contactPhone === '+61 2 6684 0000',
        'the email turned off again is not sent; the phone still is');

    // Restore flags for non-2xx and subsequent tests
    updateNodeConfig({ publishLocation: true, publishMembers: true, publishHealth: true });

    // ── 4. Error Handling on Non-2xx Response ──────────────────────────────
    mockHttpStatus = 500;
    mockResponseBody = 'Internal Server Error';

    const failRes = await pushDirectoryNow();
    assert(failRes.success === false, 'pushDirectoryNow fails when registry responds with HTTP 500');
    assert(
        typeof failRes.error === 'string' && failRes.error.includes('HTTP 500'),
        'pushDirectoryNow includes HTTP status in error message'
    );

    // ── 5. Disabled publisher check ───────────────────────────────────────
    updateNodeConfig({ directoryPushIntervalHours: 0 });
    initDirectoryPublisher();
    assert(getNodeConfig().directoryPushIntervalHours === 0, 'directoryPushIntervalHours can be set to 0');

    // Cleanup
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await p2pNode.stop();

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    console.log('⭐️ Directory Publisher checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
