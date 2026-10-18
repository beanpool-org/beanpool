/**
 * The listing promise (mothership slice A2, DESIGN-global-mothership-fable.md §1.2): made in Settings → Directory,
 * measured at every push, carried in the signed push as counts and booleans only, kept by a global node's mirror only
 * in its exact shape, and the order it gives communities at the same distance.
 *
 * Boots the real server (real middleware) as a named main server, with the registry pointed at a FIXTURE on 127.0.0.1
 * (POST is a push, GET is the table a mirror reads). Asserts:
 *   1. before anything is ticked: no promise in the push, and the owners' diagnostics say it is not made and that there
 *      is no recovery code; the push still carries acceptingKnocks and closingOn
 *   2. one owner: ticked, with a recovery code and snapshots on, the push carries NO promise, and the diagnostics say it
 *      needs two owners
 *   3. two owners: the push carries exactly { v: 1, owners: 2, backups: true, reports: true, notice: true }, no owner's
 *      name or key anywhere in its body, signed by the node key over the raw body (ed25519, zip215: false), and the mirror
 *      takes it as it is
 *   4. backups stopped (snapshots off, no off-box destination): the promise is dropped from the push and the
 *      diagnostics say why; an off-box destination counts as backups running again
 *   5. Settings → Directory: only an owner changes the ticks or the closing day (unsigned 401, an admin 403); a bad value
 *      is a 400 and changes nothing; a saved tick is pushed at once; the closing day is pushed, and null clears it;
 *      the door at "only admins" says acceptingKnocks false
 *   6. a registry that refuses the new fields (its schema predates them): the push is sent again without them and the
 *      community stays listed; the answer says the promise was refused
 *   7. the mirror treats every promise as untrusted: a promise with names inside, a list of owners, a "true" as text,
 *      one owner, a sixth field, an oversized text: all dropped; a good one as an object or as JSON text kept; a bad
 *      accepting_knocks or closing_on is none
 *   8. the order (global profile): two communities at the same distance without the promise come in both orders over 50
 *      reads, and the one keeping the promise and taking requests is always first; a promise without knocks, and a
 *      forged promise, are not first; member count never sorts; the next band comes after; paging with the reader's own
 *      `order` walks one order; the card's answer carries promise, acceptingKnocks and closingOn
 *   9. the ticks travel to a standby with the community's settings, rewritten to their three fields
 *
 * Contacts no registry: DIRECTORY_REGISTRY_URL and DIRECTORY_MIRROR_URL are the fixture on 127.0.0.1.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-directory-promise.ts (the runner: SERVER_SUITES_ONLY)
 */
import http from 'node:http';
import { ed25519 } from '@noble/curves/ed25519.js';
import { localFetch } from './keepalive-test-fetch.js';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.PUBLIC_ADDRESS_NAME;
delete process.env.PUBLIC_ADDRESS_AUTO;
delete process.env.DIRECTORY_UNLISTED;
delete process.env.NODE_PROFILE;
for (const k of Object.keys(process.env)) if (k.startsWith('BACKUP_OFFBOX_')) delete process.env[k];
process.env.REGISTRAR_URL = 'http://127.0.0.1:1';
process.env.ADMIN_PASSWORD = 'PromiseAdmin123!';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── the fixture registry: POST is a node's push, GET the table a global node's mirror reads ──────────────────────────
interface Push { raw: string; body: any; signature: string; publicKey: string; status: number }
const pushes: Push[] = [];
/** When set, a push carrying any listing field is refused, as a registry whose schema predates them might. */
let refuseListingFields = false;
let table: unknown[] = [];
const registry = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        if (req.method === 'POST') {
            let body: any = null;
            try { body = JSON.parse(raw); } catch { /* recorded as sent */ }
            const carries = body && ['promise', 'acceptingKnocks', 'closingOn'].some(k => k in body);
            const status = refuseListingFields && carries ? 400 : 200;
            pushes.push({ raw, body, signature: String(req.headers['x-signature'] ?? ''), publicKey: String(req.headers['x-public-key'] ?? ''), status });
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(status === 200 ? '{"status":"ok"}' : '{"error":"unknown field promise"}');
            return;
        }
        const u = new URL(req.url || '/', 'http://fixture');
        const limit = Number(u.searchParams.get('limit') ?? table.length);
        const offset = Number(u.searchParams.get('offset') ?? 0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(table.slice(offset, offset + limit)));
    });
});
await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
const REGISTRY = `http://127.0.0.1:${(registry.address() as { port: number }).port}`;
process.env.DIRECTORY_REGISTRY_URL = `${REGISTRY}/functions/v1/directory-register`;
process.env.DIRECTORY_MIRROR_URL = `${REGISTRY}/rest/v1/directory_nodes?select=*`;
process.env.DIRECTORY_MIRROR_KEY = 'sb_publishable_TEST-promise-fixture';

let BASE = '';
let OWNER: Record<string, string> = {};

async function call(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = OWNER): Promise<{ status: number; json: any }> {
    const res = await localFetch(`${BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
}

/** The next push after `from` pushes, or null if none came within `ms`. */
async function nextPush(from: number, ms: number): Promise<Push | null> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (pushes.length > from) return pushes[from];
        await new Promise((r) => setTimeout(r, 50));
    }
    return pushes.length > from ? pushes[from] : null;
}

/** A manual push through the owners' route; the push it sent (the last one recorded when it answered). */
async function pushNow(): Promise<{ answer: any; push: Push | null }> {
    const from = pushes.length;
    const r = await call('POST', '/api/local/admin/directory/push', {});
    return { answer: { status: r.status, ...r.json }, push: pushes.length > from ? pushes[pushes.length - 1] : null };
}

const diagnostics = async () => (await call('GET', '/api/local/admin/diagnostics')).json?.directoryPromise;
const KEPT = { v: 1, owners: 2, backups: true, reports: true, notice: true };
const DAY_MS = 86_400_000;
const day = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);

async function main() {
    console.log('The listing promise: made by owners, measured at every push, kept by a mirror only as it is...\n');
    const { initTls } = await import('./services/tls.js');
    const { initAdminPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { initStateEngine, setNodeRole } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { startP2P } = await import('./p2p.js');
    const { initDirectoryPublisher } = await import('./services/directory-publisher.js');
    const { makeRecoveryCode } = await import('./services/takeover-envelope.js');
    const { updateAutoSnapshotConfig } = await import('./services/snapshot-scheduler.js');
    const { setDoor } = await import('./config/door.js');
    const { db } = await import('./db/db.js');
    const harness = await import('./admin-auth-test-harness.js');
    const { mintHandshakeToken, consumeHandshakeToken } = await import('./admin-key-auth.js');
    const { grantNodeRole } = await import('./state-engine.js');
    const cache = await import('./engine/directory-cache.js');
    const { runDirectoryMirror } = await import('./services/directory-mirror.js');
    const { parseCommunitySettings, readCommunitySettings } = await import('./config/community-settings.js');
    const { ensureGenesis } = await import('./genesis.js');

    await initTls();
    initAdminPassword();
    initStateEngine();
    // A community's genesis.json: what a backup is locked with, besides the recovery code (services/takeover-envelope.ts).
    await ensureGenesis();
    setNodeRole('primary');
    const firstOwner = harness.seedOwnerForTests('Ownerann');
    OWNER = harness.ownerSessionHeaders(firstOwner);
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    const p2p = await startP2P(0, 0);
    updateLocalConfig({ communityName: 'Riverbend Commons' });
    assert(initDirectoryPublisher() === true, 'the publisher runs for a named main server');

    // ── 1. Nothing ticked, no recovery code ─────────────────────────────────────────────────────────────────────────
    console.log('\n── 1. not made yet ──');
    let d = await diagnostics();
    assert(d && d.kept === false && d.gaps.includes('not_made') && d.gaps.includes('no_recovery_code') && d.gaps.includes('one_owner'),
        `the owners' diagnostics say the promise is not made, with one owner and no recovery code (${JSON.stringify(d?.gaps)})`);
    assert(Array.isArray(d?.why) && d.why.length === d.gaps.length && d.why.every((w: unknown) => typeof w === 'string' && w.length > 20),
        `each reason in a sentence (${JSON.stringify(d?.why)})`);
    let p = await pushNow();
    assert(p.answer.success === true && p.push !== null, `the community is still listed (${JSON.stringify(p.answer)})`);
    assert(p.push?.body?.promise === null && p.push?.body?.acceptingKnocks === true && p.push?.body?.closingOn === null,
        `the push says promise null, acceptingKnocks true and closingOn null (${JSON.stringify(p.push?.body && { promise: p.push.body.promise, acceptingKnocks: p.push.body.acceptingKnocks, closingOn: p.push.body.closingOn })})`);
    assert(p.answer.promise === 'none', `and the answer says no promise went (${p.answer.promise})`);

    // ── 2. One owner: ticked, locked and running backups, still no promise ─────────────────────────────────────────
    console.log('\n── 2. one owner → no promise ──');
    await makeRecoveryCode();
    updateAutoSnapshotConfig({ enabled: true });
    const ticked = await call('POST', '/api/local/admin/directory/promise', { reports: true, notice: true });
    assert(ticked.status === 200 && ticked.json?.promise?.reports === true && ticked.json?.promise?.notice === true,
        `an owner ticks both lines (${ticked.status} ${JSON.stringify(ticked.json)})`);
    d = await diagnostics();
    assert(d && d.kept === false && same(d.gaps, ['one_owner']) && d.owners === 1 && d.backupsLocked === true && d.backupsRunning === true,
        `with one owner the diagnostics say it needs two, and nothing else (${JSON.stringify(d)})`);
    assert(/two owners/i.test(String(d?.why?.[0])), `in words (${JSON.stringify(d?.why)})`);
    p = await pushNow();
    assert(p.push !== null && p.push.body?.promise === null, `one owner → no promise in the push (${JSON.stringify(p.push?.body?.promise)})`);

    // ── 3. Two owners: the promise, counts and booleans only, signed ───────────────────────────────────────────────
    console.log('\n── 3. two owners → the promise ──');
    const secondOwner = harness.seedOwnerForTests('Ownerbo');
    d = await diagnostics();
    assert(d?.kept === true && same(d?.gaps, []) && d?.owners === 2, `two owners: the diagnostics say it is kept (${JSON.stringify(d)})`);
    p = await pushNow();
    assert(p.answer.promise === 'sent' && same(p.push?.body?.promise, KEPT), `the push carries exactly the promise (${JSON.stringify(p.push?.body?.promise)})`);
    const raw = p.push?.raw ?? '';
    assert(raw.length > 0 && !raw.includes('Ownerann') && !raw.includes('Ownerbo') && !raw.includes(firstOwner) && !raw.includes(secondOwner),
        'no owner\'s name or key anywhere in the push');
    const keyBytes = Buffer.from(p.push?.publicKey ?? '', 'hex');
    let verified = false;
    try {
        verified = ed25519.verify(Buffer.from(p.push?.signature ?? '', 'hex'), new TextEncoder().encode(raw), keyBytes.subarray(keyBytes.length - 32), { zip215: false });
    } catch { verified = false; }
    assert(verified, 'the promise is inside the body the node key signed (ed25519, zip215: false)');
    assert(p.push?.body?.nodeId === p2p.peerId.toString(), 'signed as this node');
    assert(same(cache.listingPromise(p.push?.body?.promise), KEPT), 'a mirror takes what the push sends, as it is');
    const info = (await call('GET', '/api/directory/info', undefined, {})).json;
    assert(same(info?.promise, KEPT) && info?.acceptingKnocks === true, `the public preview of a push says the same (${JSON.stringify(info && { promise: info.promise, acceptingKnocks: info.acceptingKnocks })})`);

    // ── 4. Backups stopped ──────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. backups stopped → dropped, and why ──');
    updateAutoSnapshotConfig({ enabled: false });
    p = await pushNow();
    assert(p.push !== null && p.push.body?.promise === null && p.answer.success === true,
        `snapshots off and no off-box destination: no promise in the push, still listed (${JSON.stringify(p.push?.body?.promise)})`);
    d = await diagnostics();
    assert(d?.kept === false && same(d?.gaps, ['backups_off']) && d?.backupsRunning === false && /snapshots/i.test(String(d?.why?.[0])),
        `the diagnostics say backups stopped, in words (${JSON.stringify(d && { gaps: d.gaps, why: d.why })})`);
    Object.assign(process.env, {
        BACKUP_OFFBOX_1_ENDPOINT: 'https://s3.example.org', BACKUP_OFFBOX_1_BUCKET: 'promise-test', BACKUP_OFFBOX_1_REGION: 'auto',
        BACKUP_OFFBOX_1_ACCESS_KEY_ID: 'AKIDPROMISETEST', BACKUP_OFFBOX_1_SECRET_ACCESS_KEY: 'promise-test-secret',
    });
    d = await diagnostics();
    assert(d?.kept === true && d?.backupsRunning === true, `an off-box destination counts as backups running (${JSON.stringify(d?.gaps)})`);
    for (const k of Object.keys(process.env)) if (k.startsWith('BACKUP_OFFBOX_')) delete process.env[k];
    updateAutoSnapshotConfig({ enabled: true });
    p = await pushNow();
    assert(same(p.push?.body?.promise, KEPT), 'snapshots on again: the promise is back at the next push');

    // ── 5. Settings → Directory ─────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. Settings → Directory: owners only, checked ──');
    const unsigned = await call('POST', '/api/local/admin/directory/promise', { reports: false }, {});
    const unsignedRead = await call('GET', '/api/local/admin/directory/promise', undefined, {});
    assert(unsigned.status === 401 && unsignedRead.status === 401, `no credential: 401 to read and to change (${unsigned.status}, ${unsignedRead.status})`);
    // A member made an admin (seeded as an owner, then the owner row taken away, as the harness only seeds owners).
    const adminKey = harness.seedOwnerForTests('Adminfay');
    db.prepare("DELETE FROM node_roles WHERE member_pubkey = ? AND role = 'owner'").run(adminKey);
    grantNodeRole(adminKey, 'admin', firstOwner);
    const adminSession = consumeHandshakeToken(mintHandshakeToken(adminKey, 'admin').handshakeToken);
    const ADMIN = { 'X-Admin-Session': String(adminSession.sessionId) };
    const asAdmin = await call('POST', '/api/local/admin/directory/promise', { reports: false }, ADMIN);
    const adminRead = await call('GET', '/api/local/admin/directory/promise', undefined, ADMIN);
    assert(asAdmin.status === 403, `an admin may not change the promise: 403 (${asAdmin.status} ${JSON.stringify(asAdmin.json)})`);
    assert(adminRead.status === 200 && adminRead.json?.promise?.kept === true, `but may read it (${adminRead.status})`);
    for (const bad of [{ reports: 'yes' }, { notice: 1 }, { closingOn: '2026-02-30' }, { closingOn: day(-3) }, { closingOn: day(500) },
        { closingOn: '18/12/2026' }, { closingOn: 20261218 }]) {
        const r = await call('POST', '/api/local/admin/directory/promise', bad);
        assert(r.status === 400 && typeof r.json?.error === 'string', `${JSON.stringify(bad)} → 400 (${r.status} ${JSON.stringify(r.json)})`);
    }
    const stillKept = (await call('GET', '/api/local/admin/directory/promise')).json;
    assert(stillKept?.promise?.kept === true && stillKept?.promise?.closingOn === null, 'and nothing changed');
    let from = pushes.length;
    const closing = day(45);
    const setDay = await call('POST', '/api/local/admin/directory/promise', { closingOn: closing });
    assert(setDay.status === 200 && setDay.json?.promise?.closingOn === closing && setDay.json?.listing?.closingOn === closing,
        `an owner sets the closing day (${setDay.status} ${JSON.stringify(setDay.json?.listing)})`);
    const atOnce = await nextPush(from, 5000);
    assert(atOnce !== null && atOnce.body?.closingOn === closing && same(atOnce.body?.promise, KEPT),
        `and it is pushed at once, with the promise (${JSON.stringify(atOnce?.body && { closingOn: atOnce.body.closingOn, promise: atOnce.body.promise })})`);
    from = pushes.length;
    await call('POST', '/api/local/admin/directory/promise', { closingOn: null });
    const cleared = await nextPush(from, 5000);
    assert(cleared !== null && cleared.body?.closingOn === null, `null clears it (${JSON.stringify(cleared?.body?.closingOn)})`);
    from = pushes.length;
    await call('POST', '/api/local/admin/directory/promise', { notice: false });
    const unticked = await nextPush(from, 5000);
    d = await diagnostics();
    assert(unticked !== null && unticked.body?.promise === null && same(d?.gaps, ['not_made']),
        `an owner unticks a line: no promise at once, and the diagnostics say it is not made (${JSON.stringify(d?.gaps)})`);
    from = pushes.length;
    await call('POST', '/api/local/admin/directory/promise', { notice: true });
    assert(same((await nextPush(from, 5000))?.body?.promise, KEPT), 'ticked again: the promise is pushed at once');
    setDoor('admins');
    p = await pushNow();
    assert(p.push?.body?.acceptingKnocks === false && same(p.push?.body?.promise, KEPT),
        `the door at "only admins": acceptingKnocks false, the promise unchanged (${JSON.stringify(p.push?.body?.acceptingKnocks)})`);
    setDoor('members');

    // ── 6. A registry from before the promise ───────────────────────────────────────────────────────────────────────
    console.log('\n── 6. a registry that refuses the new fields ──');
    refuseListingFields = true;
    from = pushes.length;
    p = await pushNow();
    // Each refused push is followed by one without the fields (the boot's timed push may land here too: the same pair).
    const tries = pushes.slice(from);
    const refusedTries = tries.filter(t => t.status === 400);
    const takenTries = tries.filter(t => t.status === 200);
    const withoutFields = (t: Push) => !['promise', 'acceptingKnocks', 'closingOn'].some(k => k in (t.body ?? {}));
    assert(p.answer.success === true && p.answer.promise === 'refused', `the community stays listed, and the answer says the promise was refused (${JSON.stringify(p.answer)})`);
    assert(refusedTries.length >= 1 && refusedTries.every(t => 'promise' in (t.body ?? {})) && takenTries.length === refusedTries.length
        && takenTries.every(t => withoutFields(t) && t.body?.communityName === 'Riverbend Commons' && t.body?.nodeId === p2p.peerId.toString()),
        `it was pushed again without the three fields, as before (${tries.map(t => `${t.status}:${Object.keys(t.body ?? {}).length} fields`).join(', ')})`);
    refuseListingFields = false;
    p = await pushNow();
    assert(p.answer.promise === 'sent' && same(p.push?.body?.promise, KEPT), 'a registry that takes them gets them at the next push');

    // ── 7. The mirror's check ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 7. every promise is untrusted ──');
    const row = (promise: unknown, extra: Record<string, unknown> = {}) => cache.normaliseRegistryRow({ node_id: 'peer-x', community_name: 'X', promise, ...extra });
    for (const [label, forged] of [
        ['names inside', { ...KEPT, ownerNames: ['Ann Example', 'Bo Example'] }],
        ['owners as a list of names', { ...KEPT, owners: ['Ann Example', 'Bo Example'] }],
        ['an owner\'s key inside', { ...KEPT, owner: firstOwner }],
        ['"true" as text', { ...KEPT, backups: 'true' }],
        ['one owner', { ...KEPT, owners: 1 }],
        ['owners not whole', { ...KEPT, owners: 2.5 }],
        ['owners past the bound', { ...KEPT, owners: 1_000_001 }],
        ['a line missing', { v: 1, owners: 2, backups: true, reports: true }],
        ['another version', { ...KEPT, v: 2 }],
        ['a list', [KEPT]],
        ['text that is not JSON', '{v:1'],
        ['oversized text', JSON.stringify({ ...KEPT }) + ' '.repeat(300)],
        ['true', true],
    ] as const) {
        assert(row(forged)?.promise === null, `a promise with ${label} → dropped (${JSON.stringify(row(forged)?.promise)})`);
    }
    assert(same(row(KEPT)?.promise, KEPT) && same(row(JSON.stringify({ ...KEPT, owners: 3 }))?.promise, { ...KEPT, owners: 3 }),
        'a good promise is kept, as an object or as JSON text');
    assert(row(null, { accepting_knocks: 'true' })?.acceptingKnocks === null && row(null, { accepting_knocks: false })?.acceptingKnocks === false
        && row(null, { acceptingKnocks: true })?.acceptingKnocks === true, 'accepting_knocks is true, false, or unknown');
    for (const bad of ['2026-02-30', '2026-13-01', day(-10), day(450), '2026-12-01T00:00:00Z', 20261201, '']) {
        assert(row(null, { closing_on: bad })?.closingOn === null, `closing_on ${JSON.stringify(bad)} → none`);
    }
    assert(row(null, { closing_on: day(30) })?.closingOn === day(30), 'a closing day to come is kept');

    // ── 8. The order on a global node ───────────────────────────────────────────────────────────────────────────────
    console.log('\n── 8. the order: the promise first, random among ties, never member count ──');
    process.env.NODE_PROFILE = 'global';
    const HERE = { lat: -33.87, lng: 151.21 };
    const at = (lat: number, lng: number) => ({ lat, lng, radiusKm: 10 });
    const far = at(-33.6, 151.21); // 30 km north: the next 25 km band
    const closeDay = day(60);
    table = [
        { node_id: 'peer-small', community_name: 'Harbour Small', node_url: 'https://small.example.org', service_radius: at(HERE.lat, HERE.lng), member_count: 1, accepting_knocks: true },
        { node_id: 'peer-big', community_name: 'Harbour Big', node_url: 'https://big.example.org', service_radius: at(HERE.lat, HERE.lng), member_count: 5000, accepting_knocks: true },
        { node_id: 'peer-keeps', community_name: 'Harbour Keeps', node_url: 'https://keeps.example.org', service_radius: at(HERE.lat, HERE.lng), member_count: 3,
            promise: KEPT, accepting_knocks: true, closing_on: closeDay },
        { node_id: 'peer-shut', community_name: 'Harbour Shut', service_radius: at(HERE.lat, HERE.lng), promise: KEPT, accepting_knocks: false },
        { node_id: 'peer-forged', community_name: 'Harbour Forged', service_radius: at(HERE.lat, HERE.lng), accepting_knocks: true,
            promise: { ...KEPT, ownerNames: ['Ann Example', 'Bo Example'] } },
        { node_id: 'peer-far', community_name: 'North Shore', service_radius: far, member_count: 900, accepting_knocks: true },
        { node_id: 'peer-far-keeps', community_name: 'North Shore Keeps', service_radius: far, promise: KEPT, accepting_knocks: true },
    ];
    const mirrored = await runDirectoryMirror();
    assert(mirrored.ran === true && (mirrored as any).ok === true && (mirrored as any).added === 7, `the mirror takes the seven rows (${JSON.stringify(mirrored)})`);
    const stored = db.prepare("SELECT promise FROM directory_cache WHERE community_key = 'peer-forged'").get() as { promise: string | null } | undefined;
    assert(stored !== undefined && stored.promise === null, `the forged promise is not stored (${JSON.stringify(stored)})`);

    const TIES = ['peer-big', 'peer-forged', 'peer-shut', 'peer-small'];
    const seen = new Set<string>();
    const tiesFirst = new Set<string>();
    let wrong = 0;
    let firstAnswer: any = null;
    for (let i = 0; i < 50; i++) {
        const r = await call('GET', `/api/global/communities?lat=${HERE.lat}&lng=${HERE.lng}`, undefined, {});
        const ks: string[] = (r.json?.communities ?? []).map((c: any) => c.key);
        if (i === 0) firstAnswer = r.json;
        if (r.status !== 200 || ks.length !== 7 || ks[0] !== 'peer-keeps' || !same([...ks.slice(1, 5)].sort(), TIES)
            || ks[5] !== 'peer-far-keeps' || ks[6] !== 'peer-far') wrong++;
        seen.add(ks.indexOf('peer-small') < ks.indexOf('peer-big') ? 'small first' : 'big first');
        tiesFirst.add(ks[1]);
    }
    assert(wrong === 0, `over 50 reads the community keeping the promise and taking requests is always first, the next band after (${wrong} reads otherwise)`);
    assert(seen.size === 2, `two communities at the same distance come in both orders over 50 reads (${[...seen].join(', ')})`);
    assert(tiesFirst.size >= 3, `and any of the four ties can come next: the promise without knocks and the forged one are only ties (${[...tiesFirst].join(', ')})`);
    const keeps = (firstAnswer?.communities ?? []).find((c: any) => c.key === 'peer-keeps');
    const shut = (firstAnswer?.communities ?? []).find((c: any) => c.key === 'peer-shut');
    const forged = (firstAnswer?.communities ?? []).find((c: any) => c.key === 'peer-forged');
    assert(same(keeps?.promise, KEPT) && keeps?.acceptingKnocks === true && keeps?.closingOn === closeDay,
        `the card's answer carries promise, acceptingKnocks and closingOn (${JSON.stringify(keeps && { promise: keeps.promise, acceptingKnocks: keeps.acceptingKnocks, closingOn: keeps.closingOn })})`);
    assert(same(shut?.promise, KEPT) && shut?.acceptingKnocks === false && forged?.promise === null && forged?.acceptingKnocks === true,
        'a promise without knocks is shown as it is; a forged one as none');
    // A reader that pages picks its own shuffle and sends it with every page.
    const order = '5eed0a2b';
    const whole = (await call('GET', `/api/global/communities?lat=${HERE.lat}&lng=${HERE.lng}&order=${order}`, undefined, {})).json;
    const again = (await call('GET', `/api/global/communities?lat=${HERE.lat}&lng=${HERE.lng}&order=${order}`, undefined, {})).json;
    const page1 = (await call('GET', `/api/global/communities?lat=${HERE.lat}&lng=${HERE.lng}&order=${order}&limit=3`, undefined, {})).json;
    const page2 = (await call('GET', `/api/global/communities?lat=${HERE.lat}&lng=${HERE.lng}&order=${order}&limit=3&offset=3`, undefined, {})).json;
    const page3 = (await call('GET', `/api/global/communities?lat=${HERE.lat}&lng=${HERE.lng}&order=${order}&limit=3&offset=6`, undefined, {})).json;
    const keysOf = (b: any): string[] => (b?.communities ?? []).map((c: any) => c.key);
    assert(keysOf(whole).length === 7 && keysOf(whole)[0] === 'peer-keeps' && same(keysOf(again), keysOf(whole))
        && same([...keysOf(page1), ...keysOf(page2), ...keysOf(page3)], keysOf(whole)),
        `the same order gives the same answer, and its pages walk it with nothing skipped or repeated (${JSON.stringify([keysOf(page1), keysOf(page2), keysOf(page3)])})`);
    assert(!('order' in (firstAnswer ?? {})) && same(Object.keys(firstAnswer ?? {}).sort(), ['communities', 'fetchedAt', 'limit', 'offset', 'total']),
        `the answer's own fields are as before (${JSON.stringify(Object.keys(firstAnswer ?? {}))})`);
    const badOrder = await call('GET', `/api/global/communities?lat=${HERE.lat}&lng=${HERE.lng}&order=zz`, undefined, {});
    assert(badOrder.status === 400, `an order that isn't one → 400 (${badOrder.status})`);
    let homeWrong = 0;
    for (let i = 0; i < 20; i++) {
        const h = await call('GET', `/api/global/home?lat=${HERE.lat}&lng=${HERE.lng}`, undefined, {});
        const ks: string[] = (h.json?.communities ?? []).map((c: any) => c.key);
        if (h.status !== 200 || ks.length !== 3 || ks[0] !== 'peer-keeps' || !ks.slice(1).every(k => TIES.includes(k))
            || !same(h.json?.communities?.[0]?.promise, KEPT)) homeWrong++;
    }
    assert(homeWrong === 0, `the landing card's three: the promising one first, then two of the ties, with the promise (${homeWrong} reads otherwise)`);
    const byName = await call('GET', '/api/global/communities', undefined, {});
    assert(same(keysOf(byName.json), ['peer-big', 'peer-forged', 'peer-keeps', 'peer-shut', 'peer-small', 'peer-far', 'peer-far-keeps']),
        `without a point: by name, as before (${JSON.stringify(keysOf(byName.json))})`);
    delete process.env.NODE_PROFILE;

    // ── 9. The ticks travel to a standby ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 9. the ticks are a community setting ──');
    const record = readCommunitySettings();
    const row9 = (record.nodeConfig as Record<string, unknown>).directory_promise;
    assert(typeof row9 === 'string' && JSON.parse(row9 as string).reports === true && JSON.parse(row9 as string).notice === true,
        `the main server's record carries the ticks (${JSON.stringify(row9)})`);
    const parsed = parseCommunitySettings({ localConfig: {}, directory: {}, nodeConfig: {
        directory_promise: JSON.stringify({ reports: true, notice: true, closingOn: closeDay, owners: ['Ann Example'] }),
    } });
    assert(same(parsed?.record.nodeConfig, { directory_promise: JSON.stringify({ reports: true, notice: true, closingOn: closeDay }) }),
        `a standby keeps them rewritten to their three fields (${JSON.stringify(parsed?.record.nodeConfig)})`);
    const garbage = parseCommunitySettings({ localConfig: {}, directory: {}, nodeConfig: { directory_promise: '[1,2]' } });
    assert(garbage !== null && !('directory_promise' in garbage.record.nodeConfig) && garbage.left.some(l => l.startsWith('nodeConfig.directory_promise')),
        `and leaves out one that isn't theirs (${JSON.stringify(garbage?.left)})`);

    console.log(`\n${passed}/${run} checks passed.`);
    await p2p.stop();
    registry.close();
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Listing promise checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
