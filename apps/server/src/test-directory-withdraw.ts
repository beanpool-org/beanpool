/**
 * A community leaves the public directory at once (front doors S13, DESIGN-doors-follow-through-fable.md §2.2): the node
 * sends one signed withdraw when its owners switch Listed off, one on its closing day, and one at boot when
 * DIRECTORY_UNLISTED is set on a server that pushed before; a node that never pushed sends nothing.
 *
 * Boots the real server (real middleware, the owners' real routes) as a named main server, with the registry pointed at a
 * FIXTURE on 127.0.0.1 that answers as the directory-register function v6 does: the JSON, the fields and the 5-minute
 * window (supabase/functions/directory-register/rules.ts checkBeforeSignature), the key's PeerId and the ed25519
 * signature over the raw body (zip215: false), then the v6 decision (rules.ts decideAfterSignature): an unlist deletes the
 * row, a push from one of our test servers is a 403, anything else is written. A switch puts it back to v5 (a push's
 * fields always required, no unlist). Asserts:
 *   1. never pushed: Listed off sends nothing, and neither does a boot with DIRECTORY_UNLISTED
 *   2. pushed, then Listed off: exactly one request, `{ nodeId, timestamp, unlist: true }` and nothing else, signed as a
 *      push is with the same key; the v6 rules take it and the row is gone; the record is cleared, so Listed on and off
 *      again before any push sends nothing
 *   3. a registry still on v5 refuses the withdraw for its missing callsign (400) and lists nothing; the record stays
 *   4. pushed, then a boot with DIRECTORY_UNLISTED: one withdraw, the row gone; a second boot sends none; no push either
 *   5. the closing day: set to today, the row goes at once; a timed or manual push sends nothing more (409, says why);
 *      cleared, the community is listed again
 *   6. a push from one of our own test servers is refused with the 403 sentence, which the node's answer carries; its
 *      withdraw is still taken
 *
 * Contacts no registry: DIRECTORY_REGISTRY_URL is the fixture on 127.0.0.1.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-directory-withdraw.ts (the runner: SERVER_SUITES_ONLY)
 */
import http from 'node:http';
import { ed25519 } from '@noble/curves/ed25519.js';
import { publicKeyFromProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import { localFetch } from './keepalive-test-fetch.js';

// The function's own rules file, outside this package (so outside tsc's rootDir): loaded by URL, under tsx as the
// runner runs every suite. No package.json above it says "module", so tsx loads it as CommonJS: its exports arrive on
// the default import.
interface Rules {
    checkBeforeSignature(payload: unknown, now: number): { status: number; error: string } | null;
    decideAfterSignature(payload: unknown, denyList: readonly string[]): { action: 'unlist' } | { action: 'upsert' } | { action: 'refuse'; status: 403; error: string };
    parseDenyHosts(raw: string | null | undefined): string[];
    DENIED_HOST_MESSAGE: string;
}
const RULES_URL = new URL('../../../supabase/functions/directory-register/rules.ts', import.meta.url).href;
const loadedRules = await import(RULES_URL) as Rules & { default?: Rules };
const { checkBeforeSignature, decideAfterSignature, parseDenyHosts, DENIED_HOST_MESSAGE } =
    typeof loadedRules.default?.checkBeforeSignature === 'function' ? loadedRules.default : loadedRules;

// The publisher's own first push, 30 s after each start of its timer (initDirectoryPublisher, which Listed on and off
// call), is its schedule, not what this suite tests: a stray one landing mid-section would list the community again.
// Only that callback is dropped; this suite pushes by hand through the owners' route.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) =>
    (typeof fn === 'function' && fn.name === 'safePush' && ms === 30_000 ? realSetTimeout(() => { /* the publisher's first timed push */ }, 0)
        : realSetTimeout(fn, ms, ...rest))) as unknown as typeof setTimeout;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.PUBLIC_ADDRESS_NAME;
delete process.env.PUBLIC_ADDRESS_AUTO;
delete process.env.DIRECTORY_UNLISTED;
delete process.env.NODE_PROFILE;
process.env.REGISTRAR_URL = 'http://127.0.0.1:1';
process.env.ADMIN_PASSWORD = 'WithdrawAdmin123!';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── the fixture registry: directory-register v6 (or v5), with the table it writes ─────────────────────────────────────
interface Request { raw: string; body: any; status: number; answer: any; verified: boolean }
const requests: Request[] = [];
const table = new Map<string, Record<string, unknown>>();
let v5 = false;
const DENY = parseDenyHosts('review.beanpool.org,test.beanpool.org,*.test.beanpool.org');

/** The key and the signature, as the function checks them: the PeerId of the key is the nodeId; ed25519, zip215: false. */
function signedBy(raw: string, body: any, publicKeyHex: string, signatureHex: string): boolean {
    try {
        const keyBytes = Buffer.from(publicKeyHex, 'hex');
        if (peerIdFromPublicKey(publicKeyFromProtobuf(keyBytes)).toString() !== body?.nodeId) return false;
        return ed25519.verify(Buffer.from(signatureHex, 'hex'), new TextEncoder().encode(raw), keyBytes.subarray(keyBytes.length - 32), { zip215: false });
    } catch {
        return false;
    }
}

function answerRegistry(raw: string, headers: http.IncomingHttpHeaders): { status: number; answer: any; verified: boolean; body: any } {
    let body: any = null;
    try { body = JSON.parse(raw); } catch { return { status: 400, answer: { error: 'Invalid JSON body' }, verified: false, body }; }
    const early = v5
        ? (!body?.nodeId || !body?.callsign || !body?.timestamp ? { status: 400, error: 'Missing required fields' } : null)
        : checkBeforeSignature(body, Date.now());
    if (early) return { status: early.status, answer: { error: early.error }, verified: false, body };
    const verified = signedBy(raw, body, String(headers['x-public-key'] ?? ''), String(headers['x-signature'] ?? ''));
    if (!verified) return { status: 401, answer: { error: 'Invalid Signature' }, verified, body };
    const decision = v5 ? { action: 'upsert' as const } : decideAfterSignature(body, DENY);
    if (decision.action === 'refuse') return { status: decision.status, answer: { error: decision.error }, verified, body };
    if (decision.action === 'unlist') {
        table.delete(body.nodeId);
        return { status: 200, answer: { success: true, unlisted: true }, verified, body };
    }
    table.set(body.nodeId, { node_id: body.nodeId, callsign: body.callsign, community_name: body.communityName ?? null, node_url: body.publicUrl ?? null });
    return { status: 200, answer: { success: true }, verified, body };
}

const registry = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        const r = answerRegistry(raw, req.headers);
        requests.push({ raw, body: r.body, status: r.status, answer: r.answer, verified: r.verified });
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.answer));
    });
});
await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
process.env.DIRECTORY_REGISTRY_URL = `http://127.0.0.1:${(registry.address() as { port: number }).port}/functions/v1/directory-register`;

let BASE = '';
let OWNER: Record<string, string> = {};

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await localFetch(`${BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...OWNER },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** What reached the registry from `from` on, once it has been quiet for a moment (a withdraw is not awaited). */
async function settled(from: number, ms = 1500): Promise<Request[]> {
    let seen = -1;
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (requests.length === seen) break;
        seen = requests.length;
        await sleep(300);
    }
    return requests.slice(from);
}
const unlists = (rs: Request[]) => rs.filter((r) => r.body?.unlist === true);
const DAY_MS = 86_400_000;
const day = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);

async function main() {
    console.log('A community leaves the directory at once: one signed withdraw, only after a push...\n');
    const { initTls } = await import('./services/tls.js');
    const { initAdminPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { initStateEngine, setNodeRole, updateNodeConfig, getNodeConfig } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { startP2P } = await import('./p2p.js');
    const publisher = await import('./services/directory-publisher.js');
    const harness = await import('./admin-auth-test-harness.js');
    const { ensureGenesis } = await import('./genesis.js');

    await initTls();
    initAdminPassword();
    initStateEngine();
    await ensureGenesis();
    setNodeRole('primary');
    updateNodeConfig({ publicAddress: { name: 'riverbend', hostname: 'riverbend.example.org', status: 'live' } as any });
    OWNER = harness.ownerSessionHeaders(harness.seedOwnerForTests('Ownerwyn'));
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    const p2p = await startP2P(0, 0);
    const nodeId = p2p.peerId.toString();
    updateLocalConfig({ communityName: 'Riverbend Commons' });
    assert(publisher.initDirectoryPublisher() === true, 'the publisher runs for a named main server');

    const listed = (on: boolean) => call('POST', '/api/local/admin/community-shape', { changes: { listed: on } });
    const pushNow = () => call('POST', '/api/local/admin/directory/push', {});

    // ── 1. Never pushed ─────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 1. a node that never pushed sends nothing ──');
    assert(!getNodeConfig().lastDirectoryPush, 'no push recorded yet');
    let from = requests.length;
    const off1 = await listed(false);
    assert(off1.status === 200 && off1.json?.shape?.settings?.listed?.configured === false, `Listed goes off (${off1.status})`);
    assert((await settled(from)).length === 0, `Listed off on a node that never pushed sends nothing (${requests.length - from} requests)`);
    process.env.DIRECTORY_UNLISTED = '1';
    from = requests.length;
    const boot1 = await publisher.withdrawIfUnlistedAtBoot();
    assert(boot1 === null && (await settled(from)).length === 0, `a boot with DIRECTORY_UNLISTED that never pushed sends nothing (${JSON.stringify(boot1)})`);
    delete process.env.DIRECTORY_UNLISTED;
    assert((await listed(true)).status === 200, 'Listed back on');

    // ── 2. Pushed, then Listed off ──────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. Listed off sends one signed withdraw, and the row goes ──');
    from = requests.length;
    const pushed = await pushNow();
    assert(pushed.status === 200 && pushed.json?.success === true && table.has(nodeId), `the community is listed (${pushed.status} ${JSON.stringify(pushed.json)})`);
    const thePush = requests[requests.length - 1];
    assert(typeof getNodeConfig().lastDirectoryPush === 'string', 'the push is recorded');
    from = requests.length;
    await listed(false);
    let after = await settled(from);
    assert(after.length === 1 && unlists(after).length === 1, `exactly one request, a withdraw (${after.length}: ${after.map((r) => r.raw).join(' | ')})`);
    const w = after[0];
    assert(same(Object.keys(w?.body ?? {}).sort(), ['nodeId', 'timestamp', 'unlist']) && w?.body?.nodeId === nodeId && w?.body?.unlist === true
        && typeof w?.body?.timestamp === 'number', `it says who is leaving and when, and nothing else, not even the callsign (${w?.raw})`);
    assert(w?.verified === true, 'signed by the node key over the raw body, its PeerId the nodeId (ed25519, zip215: false)');
    assert(w?.status === 200 && same(w?.answer, { success: true, unlisted: true }), `the v6 rules take it (${w?.status} ${JSON.stringify(w?.answer)})`);
    assert(!table.has(nodeId), 'the row is gone');
    assert(thePush.verified && JSON.parse(thePush.raw).nodeId === w?.body?.nodeId, 'with the same key as the push');
    assert(!getNodeConfig().lastDirectoryPush, 'the record is cleared');
    from = requests.length;
    await listed(true);
    await listed(false);
    assert((await settled(from)).length === 0, `Listed on and off again before any push sends nothing (${requests.length - from})`);

    // ── 3. A registry still on v5 ───────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. a registry from before v6 refuses the withdraw and lists nothing ──');
    await listed(true);
    await pushNow();
    assert(table.has(nodeId) && !!getNodeConfig().lastDirectoryPush, 'listed again');
    v5 = true;
    table.delete(nodeId); // so a withdraw mistaken for a push would show
    from = requests.length;
    await listed(false);
    after = await settled(from);
    assert(after.length === 1 && after[0].status === 400 && after[0].answer?.error === 'Missing required fields',
        `v5 refuses it for the missing callsign (${after.map((r) => `${r.status} ${JSON.stringify(r.answer)}`).join(' | ')})`);
    assert(!table.has(nodeId), 'and never writes it as a push');
    assert(!!getNodeConfig().lastDirectoryPush, 'the record stays, so a later way out tries again');
    v5 = false;

    // ── 4. A boot with DIRECTORY_UNLISTED ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. DIRECTORY_UNLISTED at boot: one withdraw, then never again ──');
    await listed(true);
    await pushNow();
    assert(table.has(nodeId), 'listed');
    process.env.DIRECTORY_UNLISTED = '1';
    from = requests.length;
    assert(publisher.initDirectoryPublisher() === false, 'the publisher sets no timer');
    const boot2 = await publisher.withdrawIfUnlistedAtBoot();
    after = await settled(from);
    assert(boot2?.sent === true && boot2?.ok === true && after.length === 1 && unlists(after).length === 1 && after[0].verified,
        `one signed withdraw (${JSON.stringify(boot2)}, ${after.length} requests)`);
    assert(!table.has(nodeId) && !getNodeConfig().lastDirectoryPush, 'the row is gone and the record cleared');
    from = requests.length;
    publisher.initDirectoryPublisher();
    const boot3 = await publisher.withdrawIfUnlistedAtBoot();
    const refused = await pushNow();
    assert(boot3 === null && (await settled(from)).length === 0 && refused.status === 409,
        `the next boot sends none, and a push is held back (${JSON.stringify(boot3)}, push ${refused.status})`);
    delete process.env.DIRECTORY_UNLISTED;

    // ── 5. The closing day ──────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. the closing day: the row goes on the day, and no push lists it again ──');
    assert(publisher.initDirectoryPublisher() === true, 'the publisher runs again');
    await pushNow();
    assert(table.has(nodeId), 'listed');
    from = requests.length;
    const setDay = await call('POST', '/api/local/admin/directory/promise', { closingOn: day(0) });
    after = await settled(from, 3000);
    assert(setDay.status === 200 && unlists(after).length === 1 && after.length === 1 && after[0].verified,
        `an owner sets the closing day to today: one signed withdraw (${setDay.status}; ${after.map((r) => r.raw).join(' | ')})`);
    assert(!table.has(nodeId) && !getNodeConfig().lastDirectoryPush, 'the row is gone and the record cleared');
    from = requests.length;
    const closed = await pushNow();
    assert(closed.status === 409 && closed.json?.closed === true && /closing day/.test(String(closed.json?.error))
        && (await settled(from)).length === 0, `a push sends nothing more, and says why (${closed.status} ${JSON.stringify(closed.json)})`);
    from = requests.length;
    const cleared = await call('POST', '/api/local/admin/directory/promise', { closingOn: null });
    after = await settled(from, 3000);
    assert(cleared.status === 200 && after.length === 1 && !after[0].body?.unlist && table.has(nodeId),
        `cleared, it is pushed and listed again (${after.map((r) => r.raw.slice(0, 80)).join(' | ')})`);

    // ── 6. One of our own test servers ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. a push from one of our test servers: 403 with the sentence; leaving is still allowed ──');
    updateNodeConfig({ publicAddress: { name: 'lane-3', hostname: 'lane-3.test.beanpool.org', status: 'live' } as any });
    from = requests.length;
    const denied = await pushNow();
    after = await settled(from);
    assert(after.length > 0 && after.every((r) => r.status === 403 && r.answer?.error === DENIED_HOST_MESSAGE),
        `the registry answers 403 with the sentence (${after.map((r) => `${r.status} ${JSON.stringify(r.answer)}`).join(' | ')})`);
    assert(denied.json?.success === false && String(denied.json?.error).includes(DENIED_HOST_MESSAGE),
        `and the node's answer carries it (${JSON.stringify(denied.json)})`);
    assert(table.has(nodeId), 'the row it had stays until it leaves');
    from = requests.length;
    await listed(false);
    after = await settled(from);
    assert(unlists(after).length === 1 && after[0].status === 200 && !table.has(nodeId),
        `its withdraw is taken (${after.map((r) => `${r.status} ${JSON.stringify(r.answer)}`).join(' | ')})`);

    console.log(`\n${passed}/${run} checks passed.`);
    await p2p.stop();
    registry.close();
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Directory withdraw checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
