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
 *  3d. With every switch off, the push still sends the community's name and web address: being unlisted is the push
 *     interval 0 (section 5) or the profile's publishToDirectory, not the switches.
 *  3e. A node that holds the old single contacts switch, stored as true by every save whether anyone chose it or not:
 *     no contact is sent (a stored default is not a choice), and each is sent once the owner turns it on.
 *  3f. Every push says `listingsFromHere` (list-on-global G5), true or false, never null: on until an owner turns it off, a
 *     stored value that is no boolean reads as on, and the owners' switch in How this community works pushes at once.
 *  4. `pushDirectoryNow()` error handling when directory registry returns non-2xx status code.
 *  2b. Held back: a community with no name of its own (blank, or the default "BeanPool Community") or a server with
 *     DIRECTORY_UNLISTED=1 sends nothing, and the answer says which (the rest: test-directory-hold-back.ts).
 *  2c. Held back while the registrar's last answer about this server's live name said `probation: true` (registrar
 *     slice S3): nothing sent, the answer and the owners' diagnostics say `probation`; a name with no probation, a
 *     pending one, or none at all is not held back for it (a node never needs the registrar).
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
const { initDirectoryPublisher, pushDirectoryNow, directoryHeldBack, HELD_BACK_NAME_MESSAGE, HELD_BACK_UNLISTED_MESSAGE, HELD_BACK_PROBATION_MESSAGE } = await import('./services/directory-publisher.js');
const { db } = await import('./db/db.js');
const { setSwitchOverride } = await import('./config/node-profile.js');

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
    // A named community: an unnamed one is held back before the key is looked at (2b).
    updateLocalConfig({ communityName: 'Mullum Creek' });
    const uninitRes = await pushDirectoryNow();
    assert(uninitRes.success === false, 'pushDirectoryNow fails when P2P node is not ready');
    assert(uninitRes.error === 'P2P node not ready', 'pushDirectoryNow reports P2P node not ready');

    // Initialize P2P node (ephemeral ports)
    const p2pNode = await startP2P(0, 0);

    // ── 2b. Held back: no name of its own, or DIRECTORY_UNLISTED (test-directory-hold-back.ts boots the server for the rest)
    const requestsBefore = receivedRequests.length;
    updateLocalConfig({ communityName: 'BeanPool Community' });
    const defaultRes = await pushDirectoryNow();
    assert(defaultRes.success === false && defaultRes.error === HELD_BACK_NAME_MESSAGE && defaultRes.heldBack === 'unnamed',
        'pushDirectoryNow holds back a community still called the default "BeanPool Community", saying why');

    updateLocalConfig({ communityName: '   ' });
    const emptyRes = await pushDirectoryNow();
    assert(emptyRes.success === false && emptyRes.error === HELD_BACK_NAME_MESSAGE,
        'pushDirectoryNow holds back a community whose name is blank');

    // Our own test and review nodes: DIRECTORY_UNLISTED in their .env, read at every push. Nothing else holds a named one back.
    updateLocalConfig({ communityName: 'Valid Community' });
    process.env.DIRECTORY_UNLISTED = '1';
    const unlistedRes = await pushDirectoryNow();
    assert(unlistedRes.success === false && unlistedRes.error === HELD_BACK_UNLISTED_MESSAGE && unlistedRes.heldBack === 'unlisted',
        'pushDirectoryNow holds back a server with DIRECTORY_UNLISTED=1, saying why');
    assert(initDirectoryPublisher() === false,
        'initDirectoryPublisher sets no timer under DIRECTORY_UNLISTED (only a restart changes the env)');
    delete process.env.DIRECTORY_UNLISTED;

    // ── 2c. Held back while the registrar's name is on probation (S3): the push waits until its answer drops it.
    const probation = { name: 'newtown', hostname: 'newtown.beanpool.org', mode: 'tunnel', status: 'live', probation: true };
    updateNodeConfig({ publicAddress: probation } as any);
    const probationRes = await pushDirectoryNow();
    assert(probationRes.success === false && probationRes.error === HELD_BACK_PROBATION_MESSAGE && probationRes.heldBack === 'probation',
        'pushDirectoryNow holds back a community whose new registrar name is on probation, saying why');
    assert(directoryHeldBack() === 'probation', "the owners' diagnostics say probation");
    // Not for a pending name (nothing routed yet), a name the registrar no longer says it of, or no name at all.
    for (const pa of [{ ...probation, status: 'pending' }, { ...probation, probation: undefined }, null]) {
        updateNodeConfig({ publicAddress: pa } as any);
        assert(directoryHeldBack() === null, `nothing holds back ${pa ? `a ${pa.status} name${pa.probation ? ' on probation' : ''}` : 'a server with no registrar name'}`);
    }
    updateNodeConfig({ publicAddress: null } as any);

    assert(receivedRequests.length === requestsBefore,
        'no request was sent to directory registry when node was held back');

    // ── 3. Successful Directory Push with Mock Server ───────────────────────
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
    assert(bodyObj4.contactEmail === null && bodyObj4.contactPhone === null && !/hello@mullum|6684 0000/.test(JSON.stringify(bodyObj4)),
        'Payload nulls the contact email and phone, and holds neither anywhere');
    assert(bodyObj4.nodeVersion === null, 'Payload omits/nulls nodeVersion when publishHealth is off');
    assert(bodyObj4.version === null, 'Payload omits/nulls version when publishHealth is off');

    // ── 3d. Every Switch Off: Still Listed by Name and Address ──────────────
    // Whether the community is listed at all is the push interval (0 = never, section 5) and the profile's
    // publishToDirectory. While it pushes, the directory always gets its name and web address, so people on the global
    // node can find it and ask to join; the switches leave out only what they cover.
    updateNodeConfig({
        publicAddress: { name: 'quiet', hostname: 'quiet.beanpool.org' } as any,
        publishLocation: false, publishMembers: false, publishContactEmail: false, publishContactPhone: false, publishHealth: false,
    });
    const quietInfo = getDirectoryInfo();
    assert(quietInfo !== null && quietInfo.name === 'Mullum Creek' && quietInfo.communityName === 'Mullum Creek' && quietInfo.publicUrl === 'https://quiet.beanpool.org',
        `getDirectoryInfo still names the community and its address with every switch off (${JSON.stringify(quietInfo)})`);
    const pushAllOffRes = await pushDirectoryNow();
    assert(pushAllOffRes.success === true, 'pushDirectoryNow succeeds when all publish flags are off');
    assert(receivedRequests.length === 6, 'Mock directory registry received 6th request');
    const bodyObj5 = receivedRequests[5].body as Record<string, unknown>;
    assert(bodyObj5.name === 'Mullum Creek' && bodyObj5.communityName === 'Mullum Creek',
        `Payload holds the community's name with every switch off (${JSON.stringify({ name: bodyObj5.name, communityName: bodyObj5.communityName })})`);
    assert(bodyObj5.publicUrl === 'https://quiet.beanpool.org', `Payload holds its web address with every switch off (${bodyObj5.publicUrl})`);
    assert(bodyObj5.serviceRadius === null && bodyObj5.memberCount === null,
        `Payload holds no service area and no member count (${JSON.stringify({ serviceRadius: bodyObj5.serviceRadius, memberCount: bodyObj5.memberCount })})`);
    assert(bodyObj5.nodeVersion === null && bodyObj5.version === null && bodyObj5.status === null, 'Payload holds no version or health');
    assert(bodyObj5.contactEmail === null && bodyObj5.contactPhone === null && !/hello@mullum|6684 0000/.test(JSON.stringify(bodyObj5)),
        'and says it has no contact email or phone, so the directory holds none it was sent before');
    updateNodeConfig({ publicAddress: null });

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
    assert(legacyBody.contactEmail === null && legacyBody.contactPhone === null && !/hello@mullum|6684 0000/.test(JSON.stringify(legacyBody)),
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

    // ── 3f. The community's name on members' listings on the global community (list-on-global G5) ──
    // Every push says it, true or false, never null and never left out: absent at the registry reads as on, so a community
    // that turned it off must say so every time, or a registry that lost the row would put its name back.
    updateNodeConfig({ publishContactEmail: false, publishContactPhone: false });
    assert((getNodeConfig() as any).publishListingsFromHere === true, 'the switch reads on until an owner turns it off');
    const onBody = await lastBody('with the name on members\' listings on');
    assert(onBody.listingsFromHere === true, `the push says listingsFromHere: true (${JSON.stringify(onBody.listingsFromHere)})`);
    updateNodeConfig({ publishListingsFromHere: false } as any);
    const offBody = await lastBody('with the name on members\' listings off');
    assert(offBody.listingsFromHere === false, `the push says listingsFromHere: false (${JSON.stringify(offBody.listingsFromHere)})`);
    assert(typeof offBody.communityName === 'string' && offBody.communityName === onBody.communityName && typeof offBody.memberCount === 'number', 'and the rest of the row as before: being found is another switch');
    // A stored value that is no boolean (a hand edit, a bad copy) reads as on, as an unset one does: the push still says a boolean.
    const storedNow = JSON.parse((db.prepare("SELECT value FROM node_config WHERE key = 'node_config'").get() as { value: string }).value);
    db.prepare("UPDATE node_config SET value = ? WHERE key = 'node_config'").run(JSON.stringify({ ...storedNow, publishListingsFromHere: 'no' }));
    assert((getNodeConfig() as any).publishListingsFromHere === true, 'a stored value that is not false reads as on');
    const oddBody = await lastBody('with a stored value that is no boolean');
    assert(oddBody.listingsFromHere === true, `the push says true, never the stored text (${JSON.stringify(oddBody.listingsFromHere)})`);
    updateNodeConfig({ publishLocation: false, publishMembers: false, publishHealth: false, publishListingsFromHere: false } as any);
    const quietOff = await lastBody('with every switch off');
    assert(quietOff.listingsFromHere === false && 'listingsFromHere' in quietOff, 'every switch off: the push still says false');
    updateNodeConfig({ publishListingsFromHere: true } as any);

    // Switched in How this community works (the owners' Being found row): pushed at once while the community is listed, so the
    // name goes from the global community within the hour of its mirror, not at the next timed push.
    assert(initDirectoryPublisher() === true, 'the publisher runs');
    const { applyShapeChanges } = await import('./config/community-shape-write.js');
    const sentBefore = receivedRequests.length;
    const changed = applyShapeChanges({ actor: 'owner:password', actorRole: 'owner' }, { changes: { shareListingsFromHere: false } });
    assert(changed.changed.includes('shareListingsFromHere') && changed.told === 'nobody', `the owners' switch is set, and no member is told (${JSON.stringify({ changed: changed.changed, told: changed.told })})`);
    assert((changed.shape.settings as any).shareListingsFromHere?.value === false && (changed.shape.settings as any).shareListingsFromHere?.source === 'owner',
        'the shape reads it off, set by an owner');
    const until = Date.now() + 3000;
    while (receivedRequests.length === sentBefore && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    const sentNow = receivedRequests[receivedRequests.length - 1]?.body as Record<string, unknown> | undefined;
    assert(receivedRequests.length > sentBefore && sentNow?.listingsFromHere === false, `a push went at once, saying false (${receivedRequests.length - sentBefore} sent)`);
    const sentOn = receivedRequests.length;
    applyShapeChanges({ actor: 'owner:password', actorRole: 'owner' }, { changes: { shareListingsFromHere: true } });
    const untilOn = Date.now() + 3000;
    while (receivedRequests.length === sentOn && Date.now() < untilOn) await new Promise((r) => setTimeout(r, 25));
    assert((receivedRequests[receivedRequests.length - 1]?.body as Record<string, unknown> | undefined)?.listingsFromHere === true, 'and on again, at once, saying true');

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
    // Listed off (How this community works) is the one way not to be listed: the schedule's 0, Never, is gone (S3). A
    // stored 0 is carried over to Listed off at boot (config/community-shape-upgrade.ts), before the publisher starts;
    // one that is there all the same means the carry didn't run or failed: it fails closed, so nothing is sent.
    updateNodeConfig({ directoryPushIntervalHours: 0 });
    assert(initDirectoryPublisher() === false, 'a stored old 0 (Never) the carry-over did not translate sets no timer: it fails closed');
    updateNodeConfig({ directoryPushIntervalHours: 7.5 });
    assert(initDirectoryPublisher() === true, 'any other stored value that is no schedule reads as the default: the publisher runs');
    setSwitchOverride('publishToDirectory', false);
    assert(initDirectoryPublisher() === false, 'with Listed off no timer is set: this is how a community is not listed');
    setSwitchOverride('publishToDirectory', true);
    updateNodeConfig({ directoryPushIntervalHours: 12 });

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
