/**
 * Registrar contract: one signing contract, two speakers, tested together (registrar PR 4; design §5.1 in
 * scratch/registrar/DESIGN-2026-09-24-fable.md).
 *
 * On 2026-09-24 the node changed its signing format alone (#542): the Worker could verify nothing, every signed
 * request 401'd, and names were freed. This suite signs with the node's real code (src/services/registrar-client.ts,
 * with the node's real identity key from startP2P) and verifies with the Worker's own code, imported from
 * apps/registrar/src, so it fails on main the moment one side changes a tag alone.
 *
 *  1. The two protocol tables agree, and every protocol the node can send verifies at the Worker: its signed requests
 *     (verifySignedRequest answers the node's key) and its attestations (attestOne answers 'ok').
 *  2. v1 on the wire is what it was before protocol versions existed: no x-bp-proto, the same four attestation
 *     fields, signatures over the same bytes.
 *  3. End to end: the node's own client calls against the Worker's fetch handler (a real SQLite D1 and a fake
 *     Cloudflare, apps/registrar/test/harness.js), and the Worker's sweep attesting the node's real /api/attest route.
 *  4. A one-sided tag change, to either tag on either side (a patched copy of that side), fails check 1.
 *  5. Two versions in flight (patched copies adding a v(n+1)): both sides accepting it agree; a node sending it to a
 *     Worker without it falls back once, with a warning; and the incident in reverse: an attestation tagged with a
 *     version the Worker lacks is 'unverifiable', and sweeps change nothing.
 *  6. The deploy workflow's checks (apps/registrar/scripts/deploy-checks.mjs) read the node's protocols right, and
 *     judge a health answer and the migrations bootstrap as they should.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Koa from 'koa';
import { startP2P } from './p2p.js';
import { createPublicAddressRoutes } from './routes/public-address.js';
import * as node from './services/registrar-client.js';
import type { RouteDeps } from './routes/types.js';

type NodeClient = typeof node;
type Tags = { request: string; attest: string };
type Env = Record<string, unknown>;
type Row = Record<string, unknown> & { name: string; hostname: string; node_pubkey: string };
interface Worker {
    sign: {
        PROTOCOLS: Record<string, Tags>;
        DEFAULT_PROTO: string;
        ACCEPTED_PROTOS: readonly string[];
        verifySignedRequest(request: Request, bodyText: string): Promise<string | null>;
    };
    index: {
        default: { fetch(request: Request, env: Env): Promise<Response> };
        attestOne(env: Env, a: { hostname: string; node_pubkey: string }): Promise<string>;
        attestSweep(env: Env): Promise<{ action: string; live: number; ok: number; unverifiable: number; impostor: number }>;
    };
}
interface Harness {
    sqliteD1(): { d1: unknown; sqlite: { prepare(sql: string): { run(...a: unknown[]): unknown } }; all(sql: string, ...a: unknown[]): Row[] };
    fakeCloudflare(): { calls: string[]; handle(method: string, url: URL, body: unknown): Promise<Response> };
    makeKey(): Promise<{ pubHex: string }>;
    attestsAs(key: { pubHex: string }): (nonce: string) => Promise<Response>;
}
interface DeployChecks {
    nodeProtocols(source: string): string[];
    healthProblems(health: unknown, want: { commit: string; protos: string[] }): string[];
    bootstrapProblems(wranglerJson: string): string[];
}

let testsRun = 0;
let testsPassed = 0;

function assert(cond: boolean, msg: string, detail?: unknown): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
        return;
    }
    console.error(`✗ ${msg}`);
    if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
    throw new Error(`assertion failed: ${msg}`);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRAR = path.resolve(HERE, '../../registrar');
const CLIENT_SOURCE = path.join(HERE, 'services', 'registrar-client.ts');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'registrar-contract-'));
const importFile = (file: string) => import(pathToFileURL(file).href);

// `find` must occur exactly once in `src`: a patch that silently matched nothing (or twice) would prove nothing.
function once(src: string, find: string, replace: string): string {
    const n = src.split(find).length - 1;
    if (n !== 1) throw new Error(`patch: expected ${JSON.stringify(find)} exactly once, found it ${n} times`);
    return src.replace(find, () => replace);
}

// --- Patched copies of each side, in a temp dir (never the working tree) ---
let copies = 0;

async function workerCopy(patch: (signJs: string) => string): Promise<Worker> {
    const dir = path.join(TMP, `worker-${++copies}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    for (const f of fs.readdirSync(path.join(REGISTRAR, 'src'))) fs.copyFileSync(path.join(REGISTRAR, 'src', f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, 'sign.js'), patch(fs.readFileSync(path.join(dir, 'sign.js'), 'utf8')));
    return { sign: await importFile(path.join(dir, 'sign.js')), index: await importFile(path.join(dir, 'index.js')) };
}

// The copy's imports are made absolute: the node's own p2p module (so the copy signs with the very same identity
// key) and the same packages.
async function nodeCopy(patch: (clientTs: string) => string): Promise<NodeClient> {
    const dir = path.join(TMP, `node-${++copies}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    const src = fs.readFileSync(CLIENT_SOURCE, 'utf8').replace(/(from\s+)'([^']+)'/g, (_m, from: string, spec: string) => {
        const abs = spec.startsWith('.')
            ? pathToFileURL(path.resolve(path.dirname(CLIENT_SOURCE), spec.replace(/\.js$/, '.ts'))).href
            : import.meta.resolve(spec);
        return `${from}'${abs}'`;
    });
    fs.writeFileSync(path.join(dir, 'registrar-client.ts'), patch(src));
    return importFile(path.join(dir, 'registrar-client.ts'));
}

const protoNumber = (p: string) => Number(p.slice(1));
// A version neither side has yet (set in run(), once the Worker's table is loaded), and its tags.
let NEXT = '';
let NEXT_TAGS: Tags;
// Step 1 of a format change on the Worker: it accepts NEXT too.
const workerAcceptingNext = (src: string) =>
    once(src, '\n});', `\n    ${NEXT}: Object.freeze({ request: '${NEXT_TAGS.request}', attest: '${NEXT_TAGS.attest}' }),\n});`);
// Steps 1 and 2 on the node: it speaks NEXT and sends it.
const nodeSendingNext = (src: string) => once(
    once(src, '\n} as const;', `\n    ${NEXT}: { request: '${NEXT_TAGS.request}', attest: '${NEXT_TAGS.attest}' },\n} as const;`),
    `export const SEND_PROTO: Proto = '${node.SEND_PROTO}';`, `export const SEND_PROTO: Proto = '${NEXT}';`);
// The 2026-09-24 mistake: one side edits a tag in place.
const changeTag = (tag: string) => (src: string) => once(src, `'${tag}'`, `'${tag}-changed'`);

// --- The network the two sides meet on ---
const REGISTRAR_HOST = 'registrar.contract.test';
const realFetch = globalThis.fetch;
const nodesAt = new Map<string, (nonce: string) => Promise<Response>>();   // hostname → the node answering /api/attest there
const sent: { path: string; proto: string | null; xbp: string[]; status: number }[] = [];   // signed requests the registrar got
let registrar: Worker;
let world: ReturnType<typeof newWorld>;
let harness: Harness;

function newWorld() {
    const { d1, sqlite, all } = harness.sqliteD1();
    const cf = harness.fakeCloudflare();
    const env: Env = {
        BASE_DOMAIN: 'beanpool.org', ATTEST_FAIL_LIMIT: '2', ADMIN_SECRET: 'contract-admin-secret',
        CF_ACCOUNT_ID: 'acct', CF_ZONE_ID: 'zone', CF_API_TOKEN: 'not-a-token', DB: d1,
    };
    const row = (name: string) => all('SELECT * FROM name_allocations WHERE name = ?', name)[0];
    const events = (name: string) => all('SELECT event, detail FROM name_events WHERE name = ? ORDER BY id', name);
    return { env, cf, sqlite, row, events };
}

async function route(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const bodyText = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
    if (url.hostname === 'api.cloudflare.com') return world.cf.handle(req.method, url, bodyText ? JSON.parse(bodyText) : null);
    if (url.host === REGISTRAR_HOST) {
        const res = await registrar.index.default.fetch(new Request(`https://beanpool.org${url.pathname}${url.search}`, {
            method: req.method, headers: req.headers, body: bodyText || undefined,
        }), world.env);
        sent.push({
            path: url.pathname, proto: req.headers.get('x-bp-proto'), status: res.status,
            xbp: [...req.headers.keys()].filter((k) => k.startsWith('x-bp-')).sort(),
        });
        return res;
    }
    const answer = nodesAt.get(url.hostname);
    if (answer && url.pathname === '/api/attest') return answer(url.searchParams.get('nonce') || '');
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    throw new Error(`contract test network: no route to ${url}`);
}

// What a Worker says of an attestation `serve` answers for our nonce, at a hostname registered to the node's key.
async function attestAt(w: Worker, pubkey: string, serve: (nonce: string) => Promise<unknown>): Promise<string> {
    nodesAt.set('contract.beanpool.org', async (nonce) => Response.json(await serve(nonce)));
    try { return await w.index.attestOne({}, { hostname: 'contract.beanpool.org', node_pubkey: pubkey }); }
    finally { nodesAt.delete('contract.beanpool.org'); }
}

// Everything that goes wrong between Worker `w` and node `n`: [] when every protocol the node can send verifies.
async function contractProblems(w: Worker, n: NodeClient): Promise<string[]> {
    const problems: string[] = [];
    if (n.DEFAULT_PROTO !== w.sign.DEFAULT_PROTO) problems.push(`default protocol: node ${n.DEFAULT_PROTO}, Worker ${w.sign.DEFAULT_PROTO}`);
    const pubkey = n.nodePubkeyHex();
    for (const [proto, tags] of Object.entries(n.PROTOCOLS) as [node.Proto, Tags][]) {
        const theirs = w.sign.PROTOCOLS[proto];
        if (!w.sign.ACCEPTED_PROTOS.includes(proto) || !theirs) problems.push(`the Worker does not accept ${proto}`);
        else if (!isDeepStrictEqual({ ...theirs }, { ...tags })) problems.push(`${proto}: node tags ${JSON.stringify(tags)}, Worker tags ${JSON.stringify(theirs)}`);
        const requests: [string, string, string][] = [
            ['POST', '/api/registrar/claim', JSON.stringify({ name: 'contract', mode: 'tunnel' })],
            ['GET', '/api/registrar/status', ''],
        ];
        for (const [method, p, body] of requests) {
            const headers = await n.signRequest(method, p, body, proto);
            const signer = await w.sign.verifySignedRequest(new Request(`https://beanpool.org${p}`, { method, headers, body: body || undefined }), body);
            if (signer !== pubkey) problems.push(`a ${proto} ${method} ${p} does not verify at the Worker`);
        }
        const verdict = await attestAt(w, pubkey, (nonce) => n.buildAttestation(nonce, proto));
        if (verdict !== 'ok') problems.push(`a ${proto} attestation is '${verdict}' at the Worker`);
    }
    return problems;
}

async function verifyRaw(pubkeyHex: string, message: string, signatureHex: string): Promise<boolean> {
    const key = await crypto.subtle.importKey('raw', Buffer.from(pubkeyHex, 'hex'), { name: 'Ed25519' }, false, ['verify']);
    return crypto.subtle.verify({ name: 'Ed25519' }, key, Buffer.from(signatureHex, 'hex'), new TextEncoder().encode(message));
}

async function run() {
    console.log('🚀 Registrar contract: the node signs, the Worker verifies (registrar PR 4)...\n');
    harness = await importFile(path.join(REGISTRAR, 'test', 'harness.js'));
    const checks: DeployChecks = await importFile(path.join(REGISTRAR, 'scripts', 'deploy-checks.mjs'));
    const worker: Worker = { sign: await importFile(path.join(REGISTRAR, 'src', 'sign.js')), index: await importFile(path.join(REGISTRAR, 'src', 'index.js')) };
    registrar = worker;
    NEXT = `v${Math.max(...[...Object.keys(node.PROTOCOLS), ...worker.sign.ACCEPTED_PROTOS].map(protoNumber)) + 1}`;
    NEXT_TAGS = { request: `contract-test-request/${NEXT}`, attest: `contract-test-attest/${NEXT}` };
    globalThis.fetch = route as typeof fetch;
    process.env.REGISTRAR_URL = `https://${REGISTRAR_HOST}`;

    const p2pNode = await startP2P(0, 0);
    const pubkey = node.nodePubkeyHex();
    const koa = new Koa();
    const routes = createPublicAddressRoutes({ checkAdminAuth: async () => false } as unknown as RouteDeps);
    koa.use(routes.routes());
    const server = http.createServer(koa.callback());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const nodePort = (server.address() as { port: number }).port;
    const nodeRoute = (nonce: string) => realFetch(`http://127.0.0.1:${nodePort}/api/attest?nonce=${encodeURIComponent(nonce)}`);

    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); realWarn(...a); };

    try {
        // ── 1. The contract ──
        console.log(`— the node speaks ${Object.keys(node.PROTOCOLS).join(', ')} and sends ${node.SEND_PROTO}; the Worker accepts ${worker.sign.ACCEPTED_PROTOS.join(', ')}`);
        const problems = await contractProblems(worker, node);
        assert(problems.length === 0, 'every protocol the node can send verifies at the Worker: signed requests (the node\'s key) and attestations (ok)', problems);
        assert(Object.hasOwn(node.PROTOCOLS, node.SEND_PROTO) && worker.sign.ACCEPTED_PROTOS.includes(node.SEND_PROTO),
            `the node sends ${node.SEND_PROTO}, which it speaks and the Worker accepts`);
        const allTags = [...Object.values(worker.sign.PROTOCOLS), ...Object.values(node.PROTOCOLS)];
        const requestTags = new Set(allTags.map((t) => t.request));
        const attestTags = new Set(allTags.map((t) => t.attest));
        assert([...requestTags].every((t) => !attestTags.has(t)), 'no request tag is an attestation tag, in any version on either side (domain separation, #542)');
        const ownTags = (table: Record<string, Tags>) => {
            const versions = Object.values(table);
            return new Set(versions.map((t) => t.request)).size === versions.length && new Set(versions.map((t) => t.attest)).size === versions.length;
        };
        assert(ownTags(worker.sign.PROTOCOLS) && ownTags(node.PROTOCOLS), 'on each side, every version\'s tags are its own (no two versions share a tag)');
        assert([...requestTags, ...attestTags].every((t) => !t.includes('\n')), 'no tag contains a newline');

        // ── 2. v1 on the wire is unchanged ──
        if (Object.hasOwn(node.PROTOCOLS, 'v1')) {
            const body = JSON.stringify({ name: 'contract', mode: 'tunnel' });
            const h = await node.signRequest('POST', '/api/registrar/claim', body, 'v1');
            assert(isDeepStrictEqual(Object.keys(h), ['x-bp-pubkey', 'x-bp-timestamp', 'x-bp-signature']),
                'a v1 request carries exactly the three signature headers it always did, in order (no x-bp-proto)', Object.keys(h));
            assert(await verifyRaw(pubkey, `beanpool-registrar-request/v1\nPOST\n/api/registrar/claim\n${h['x-bp-timestamp']}\n${body}`, h['x-bp-signature']),
                'its signature is over the pre-versioning bytes (literal format, verified independently of both sides)');
            const att = await node.buildAttestation('contract-nonce-1', 'v1');
            assert(isDeepStrictEqual(Object.keys(att), ['pubkey', 'nonce', 'timestamp', 'signature']),
                'a v1 attestation has exactly the four fields it always had, in order (no proto)', Object.keys(att));
            assert(await verifyRaw(pubkey, `beanpool-node-attest/v1\ncontract-nonce-1\n${att.timestamp}`, att.signature),
                'its signature is over the pre-versioning bytes');
        }

        // ── 3. End to end ──
        console.log('— end to end: the node\'s client ↔ the Worker\'s fetch handler, the Worker\'s sweep ↔ the node\'s /api/attest');
        world = newWorld();
        sent.length = 0;
        const claimed = await node.claimAddress('contract-e2e', 'tunnel', 'http://beanpool-node:8080', 'ops@contract.test', 'Contract Test');
        assert(claimed.status === 'live' && claimed.hostname === 'contract-e2e.beanpool.org' && typeof claimed.tunnelToken === 'string',
            'claim: the Worker verifies the node\'s signed claim and makes the name live, with a tunnel token', claimed);
        assert(world.row('contract-e2e')?.node_pubkey === pubkey, 'the Worker bound the name to the node\'s key');
        const st = await node.addressStatus();
        assert(st.status === 'live' && st.name === 'contract-e2e', 'status: verifies, live', st);
        const up = await node.updateAddressMetadata('Contract Test 2', 'ops2@contract.test');
        assert(up.status === 'ok' && world.row('contract-e2e').community_name === 'Contract Test 2', 'update: verifies, saved', up);
        const reply = await (await nodeRoute('contract-nonce-2')).json();
        assert(isDeepStrictEqual(Object.keys(reply), node.SEND_PROTO === node.DEFAULT_PROTO ? ['pubkey', 'nonce', 'timestamp', 'signature'] : ['pubkey', 'nonce', 'timestamp', 'signature', 'proto']),
            `the node's /api/attest answers ${node.SEND_PROTO === node.DEFAULT_PROTO ? 'the four fields it always did' : 'its protocol too'}`, reply);
        nodesAt.set('contract-e2e.beanpool.org', nodeRoute);
        assert(await worker.index.attestOne(world.env, world.row('contract-e2e')) === 'ok', 'the Worker attests the node\'s real /api/attest route: ok');
        const sweep = await worker.index.attestSweep(world.env);
        assert(sweep.action === 'applied' && sweep.ok === 1 && !!world.row('contract-e2e').last_ok_at, 'the Worker\'s sweep: applied, the name ok', sweep);
        nodesAt.delete('contract-e2e.beanpool.org');
        const rel = await node.releaseAddress();
        assert(rel.status === 'released' && world.row('contract-e2e').status === 'released', 'release (/offline): verifies, released', rel);
        const expectHeader = node.SEND_PROTO === node.DEFAULT_PROTO ? null : node.SEND_PROTO;
        assert(sent.length === 4 && sent.every((r) => r.status === 200 && r.proto === expectHeader),
            `all four signed calls went out once each, ${expectHeader ? `with x-bp-proto: ${expectHeader}` : 'with no x-bp-proto'}, and verified`, sent);
        assert(sent.every((r) => isDeepStrictEqual(r.xbp, expectHeader ? ['x-bp-proto', 'x-bp-pubkey', 'x-bp-signature', 'x-bp-timestamp'] : ['x-bp-pubkey', 'x-bp-signature', 'x-bp-timestamp'])),
            'and carried no other x-bp-* header', sent);
        assert(warnings.length === 0, 'no protocol warning when both sides agree', warnings);

        // ── 4. A one-sided change fails the contract ──
        console.log(`— one side changes a ${node.SEND_PROTO} tag alone (patched copies)`);
        const sendTags: Tags = node.PROTOCOLS[node.SEND_PROTO];
        for (const side of ['Worker', 'node'] as const) {
            for (const which of ['request', 'attest'] as const) {
                const found = side === 'Worker'
                    ? await contractProblems(await workerCopy(changeTag(sendTags[which])), node)
                    : await contractProblems(worker, await nodeCopy(changeTag(sendTags[which])));
                const caught = found.find((p) => (which === 'request' ? /does not verify/ : /attestation is 'unverifiable'/).test(p));
                assert(!!caught, `the ${side} changing its ${which} tag alone fails the contract: "${caught}"`, found);
            }
        }
        // The exact 2026-09-24 shape: a node signing its attestation under a tag the Worker doesn't know, without naming
        // any protocol. The Worker must call that unverifiable, never an impostor.
        const drifted = await nodeCopy(changeTag(node.PROTOCOLS[node.DEFAULT_PROTO].attest));
        assert(await attestAt(worker, pubkey, (nonce) => drifted.buildAttestation(nonce, drifted.DEFAULT_PROTO)) === 'unverifiable',
            'an attestation under an unknown tag (the #542 drift) is unverifiable, not impostor');

        // ── 5. Two versions in flight ──
        console.log(`— a format change in flight: ${NEXT} (patched copies)`);
        const nodeNext = await nodeCopy(nodeSendingNext);
        const workerNext = await workerCopy(workerAcceptingNext);
        assert(nodeNext.nodePubkeyHex() === pubkey && nodeNext.SEND_PROTO === NEXT, `the patched node speaks ${NEXT}, sends it, and signs with the same identity key`);
        assert((await contractProblems(workerNext, nodeNext)).length === 0, `both sides accepting ${NEXT}: every protocol the node can send verifies`, await contractProblems(workerNext, nodeNext));
        assert((await contractProblems(workerNext, node)).length === 0, `the Worker accepting ${NEXT} still accepts everything today's node sends (deploy order doesn't matter)`);
        const behind = await contractProblems(worker, nodeNext);
        assert(behind.some((p) => p === `the Worker does not accept ${NEXT}`), `a node that can send ${NEXT} before any Worker accepts it fails the contract`, behind);

        // The node falls back once when the Worker is behind it.
        world = newWorld();
        sent.length = 0;
        warnings.length = 0;
        const fallback = await nodeNext.claimAddress('contract-next', 'tunnel', 'http://beanpool-node:8080');
        assert(fallback.status === 'live' && world.row('contract-next')?.node_pubkey === pubkey,
            `a node sending ${NEXT} to a Worker without it still claims its name`, fallback);
        assert(isDeepStrictEqual(sent.map((r) => [r.proto, r.status]), [[NEXT, 401], [null, 200]]),
            `by one retry: ${NEXT} → 401 (with accepted_proto), then ${node.DEFAULT_PROTO} → 200`, sent);
        assert(warnings.length === 1 && warnings[0].includes('the address service is behind this node'), 'with one warning, not an error', warnings);
        sent.length = 0;
        const fbStatus = await nodeNext.addressStatus();
        assert(fbStatus.status === 'live' && sent.length === 2, 'every call falls back the same way (status: live)', sent);

        // No fallback once the Worker accepts it.
        world = newWorld();
        registrar = workerNext;
        sent.length = 0;
        warnings.length = 0;
        const direct = await nodeNext.claimAddress('contract-next', 'tunnel', 'http://beanpool-node:8080');
        assert(direct.status === 'live' && isDeepStrictEqual(sent.map((r) => [r.proto, r.status]), [[NEXT, 200]]) && warnings.length === 0,
            `a Worker accepting ${NEXT} verifies it first time: no retry, no warning`, sent);
        registrar = worker;

        // The incident in reverse: a live name whose node attests under NEXT, swept by a Worker without it. Two healthy
        // neighbours make every sweep an applied one, so what is shown is that even an applied sweep leaves the name alone.
        world = newWorld();
        await nodeNext.claimAddress('contract-next', 'tunnel', 'http://beanpool-node:8080');
        nodesAt.set('contract-next.beanpool.org', async (nonce) => Response.json(await nodeNext.buildAttestation(nonce)));
        for (const n of ['neighbour-a', 'neighbour-b']) {
            const key = await harness.makeKey();
            world.sqlite.prepare(`INSERT INTO name_allocations (name, node_pubkey, hostname, mode, status, attest_fails, requested_at)
                VALUES (?, ?, ?, 'tunnel', 'live', 0, ?)`).run(n, key.pubHex, `${n}.beanpool.org`, Math.floor(Date.now() / 1000));
            nodesAt.set(`${n}.beanpool.org`, harness.attestsAs(key));
        }
        const tagged = world.row('contract-next');
        const taggedEvents = world.events('contract-next');
        const cfCalls = world.cf.calls.length;
        assert(await worker.index.attestOne(world.env, tagged) === 'unverifiable', `an attestation tagged ${NEXT} is unverifiable at a Worker without ${NEXT}`);
        for (let i = 1; i <= 3; i++) {
            const s = await worker.index.attestSweep(world.env);
            assert(s.action === 'applied' && s.unverifiable === 1 && s.impostor === 0 && s.ok === 2, `sweep ${i}: applied (the neighbours ok), the tagged name unverifiable, no impostor`, s);
        }
        assert(isDeepStrictEqual(world.row('contract-next'), tagged), 'three applied sweeps later the tagged name\'s row is exactly as it was (live, no fails)', world.row('contract-next'));
        assert(isDeepStrictEqual(world.events('contract-next'), taggedEvents) && world.cf.calls.length === cfCalls, 'no event logged for it, and no Cloudflare call made');
        assert(['neighbour-a', 'neighbour-b'].every((n) => !!world.row(n).last_ok_at), 'while the neighbours were marked ok (the sweeps did act)');
        for (const n of ['contract-next.beanpool.org', 'neighbour-a.beanpool.org', 'neighbour-b.beanpool.org']) nodesAt.delete(n);

        // ── 6. The deploy workflow's checks ──
        console.log('— the deploy workflow\'s checks (apps/registrar/scripts/deploy-checks.mjs)');
        const source = fs.readFileSync(CLIENT_SOURCE, 'utf8');
        assert(isDeepStrictEqual(checks.nodeProtocols(source), Object.keys(node.PROTOCOLS)), 'it reads the node\'s protocols from registrar-client.ts exactly as the module has them', checks.nodeProtocols(source));
        assert(isDeepStrictEqual(checks.nodeProtocols(nodeSendingNext(source)), [...Object.keys(node.PROTOCOLS), NEXT]), `and sees a ${NEXT} added to them`);
        const protos = Object.keys(node.PROTOCOLS);
        const health = await (await worker.index.default.fetch(new Request('https://beanpool.org/api/registrar/health'), { GIT_SHA: 'abc123' })).json();
        assert(checks.healthProblems(health, { commit: 'abc123', protos }).length === 0, 'this Worker\'s own health, deployed at the commit, passes', health);
        assert(checks.healthProblems(health, { commit: 'def456', protos }).some((p) => p.startsWith('commit')), 'another commit fails');
        assert(checks.healthProblems(health, { commit: 'abc123', protos: [...protos, NEXT] }).some((p) => p.startsWith('accepted_proto')),
            `a Worker that doesn't accept every protocol the node can send (${NEXT}) fails`);
        assert(checks.healthProblems({ status: 'ok' }, { commit: 'abc123', protos }).length === 2, 'the pre-PR-4 health ({status:"ok"}) fails on both counts');
        for (const bad of [null, [], 'ok', { status: 'down', commit: 'abc123', accepted_proto: protos }])
            assert(checks.healthProblems(bad, { commit: 'abc123', protos }).length > 0, `health ${JSON.stringify(bad)} fails`);
        const wranglerRows = (names: string[]) => JSON.stringify([{ results: names.map((name) => ({ name })), success: true, meta: {} }]);
        assert(checks.bootstrapProblems(wranglerRows(['0001_init.sql', '0002_states.sql'])).length === 0, 'the migrations guard passes a bootstrapped database');
        assert(checks.bootstrapProblems(wranglerRows([])).length === 1, 'and refuses an empty d1_migrations (what `wrangler d1 migrations list` makes)');
        assert(checks.bootstrapProblems(wranglerRows(['0002_states.sql'])).length === 1, 'or one without 0001_init.sql');
        assert(checks.bootstrapProblems('✘ [ERROR] no such table: d1_migrations').length === 1, 'or no table at all');
    } finally {
        console.warn = realWarn;
        globalThis.fetch = realFetch;
        server.close();
        await p2pNode.stop();
        fs.rmSync(TMP, { recursive: true, force: true });
    }
}

run().then(() => {
    console.log(`\n✅ Registrar contract: ${testsPassed}/${testsRun} passed`);
    process.exit(0);
}, (err) => {
    console.error(`\n❌ Registrar contract failed (${testsPassed}/${testsRun} passed):`, err);
    process.exit(1);
});
