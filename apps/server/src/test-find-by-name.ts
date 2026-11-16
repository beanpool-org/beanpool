/**
 * Finding someone in another community by their exact name, when they said yes (slice N1: scratch/fable-design/
 * DESIGN-cross-chat-voice-fable.md §3.6, §3.7, §11 row F1, renamed N1), through the real middleware.
 *
 * Two communities in one process, as test-relay-complaint has them: the node under test is b.example, the real server with
 * its real routes, signature door and database; a.example and c.example are played by this suite (their server keys and key
 * documents, handed to the node's door by the test fetch hook, double-locked by BEANPOOL_SSRF_TEST_HOOK=1; c.example's
 * /api/relay/find, which the node's look-ups reach through the relay transport hook). No other server is contacted.
 *
 * INVARIANT: nobody can map a community's members. The same answer, the same bytes, the same steps for "no such member",
 * "not findable", "blocked", "left", "removed" and "over the day at the target"; nothing found is logged by name.
 *
 *   1  the switch: off until turned on; on only with the member's own card, naming this community and their name here
 *   2  THE TABLE (b.example answers a.example): target (opted in, not opted in, no such name, case and spacing variants, a
 *      part of the name, a letter short, blocked the asker, removed, left, the asker themselves) x the day (under, the
 *      10th, the 11th, a.example past its 200) x the request (signed, unsigned, replayed, signed for another server)
 *      -> the card / the one "nobody" answer, byte for byte, the same steps / refused at the door
 *   3  refused requests count nothing; a look-up that is not one is 400
 *   4  asking (Ben at b.example asks c.example): the request b.example signs; what comes back x what Ben is told; refused
 *      here with nothing sent (this community, no community, no name, a visitor); the 11th look-up today is 429, nothing sent
 *   5  the owner's switch off: asking refused here, answering "nobody"
 *   6  a renamed member: nobody by either name until their app hands a new card
 *   7  the logs: no name typed, no key, no community named, in any line
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) BEANPOOL_SSRF_TEST_HOOK=1 pnpm exec tsx src/test-find-by-name.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.BEANPOOL_SSRF_TEST_HOOK = '1';
process.env.BEANPOOL_ADDRESSES = 'b.example,b-alias.example';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
    FIND_BY_NAME_PER_DAY, FIND_NOBODY_BODY, NODE_KEY_VALIDITY_MS, NODE_REQUEST_HEADER, RELAY_FIND_PATH, addressCardVerifies,
    buildNodeRequestHeaders, nodeRequestSignatureVerifies, parseNodeRequestHeader, readNodeKeyDocument, signAddressCard,
    signNodeKeyDocument, type AddressCard,
} from '@beanpool/core';
import { signedHeaders } from './signed-request-test-helper.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// Every line the server writes, for 7: stdout and stderr both, as they go.
const logs: string[] = [];
for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    (stream as any).write = (chunk: any, ...rest: any[]) => {
        const text = String(chunk);
        if (!text.startsWith('✓ ') && !text.startsWith('✗ ')) logs.push(text);
        return write(chunk, ...rest);
    };
}

let BASE = '';
/** The gateway's per-address limit, emptied before each request: every request here comes from one address (the table makes ~1,400). */
let resetGateway: () => void = () => {};
interface Answer { status: number; body: any; text: string; type: string; cache: string }
async function send(method: string, p: string, headers: Record<string, string>, body?: string): Promise<Answer> {
    resetGateway();
    const res = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* no body */ }
    return { status: res.status, body: parsed, text, type: res.headers.get('content-type') ?? '', cache: res.headers.get('cache-control') ?? '' };
}

interface Keys { seed: Uint8Array; key: string }
const keys = (): Keys => { const seed = crypto.randomBytes(32); return { seed, key: Buffer.from(ed25519.getPublicKey(seed)).toString('hex') }; };
const signerOf = (seed: Uint8Array) => (b: Uint8Array) => ed25519.sign(b, seed);

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    if (!dataDir) throw new Error('BEANPOOL_DATA_DIR must be set to a fresh directory');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    fs.writeFileSync(path.join(dataDir, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));

    const { initTls } = await import('./services/tls.js');
    const { initStateEngine, seedGenesisMember } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { __useNodeKeyFetchForTests } = await import('./engine/node-signature.js');
    const { applyShapeChanges } = await import('./config/community-shape-write.js');
    const { addBlocks } = await import('./engine/member-blocks.js');
    const outbox = await import('./engine/relay-outbox.js');
    const find = await import('./engine/find-by-name.js');
    resetGateway = (await import('./gateway-rate-limit.js')).resetGatewayRateLimit;

    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    // ── Who is where ──────────────────────────────────────────────────────────────────────
    const olive = keys();
    seedGenesisMember(olive.key, 'Olive');
    const addLocal = (k: Keys, name: string, status = 'active') => {
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'TEST', ?)`).run(k.key, name, olive.key, status);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(k.key);
    };
    const wren = keys(), moss = keys(), juno = keys(), rook = keys(), fern = keys(), sky = keys(), ben = keys();
    const NAMES = { wren: 'Wren Tallowmere', moss: 'Moss Ferrandel', juno: 'Juno Ashby', rook: 'Rook Penhallow', fern: 'Fern Oakhollow', sky: 'Sky Marlowe', ben: 'Benedikt Quill' };
    addLocal(wren, NAMES.wren);
    addLocal(moss, NAMES.moss);
    addLocal(juno, NAMES.juno);
    addLocal(rook, NAMES.rook);
    addLocal(fern, NAMES.fern);
    addLocal(sky, NAMES.sky);
    addLocal(ben, NAMES.ben);

    const A = keys(), C = keys();
    const now = Date.now();
    const docs = new Map<string, unknown>([
        ['https://a.example/api/node/key', await signNodeKeyDocument({ key: A.key, validUntil: now + NODE_KEY_VALIDITY_MS, previousKeys: [] }, signerOf(A.seed))],
        ['https://c.example/api/node/key', await signNodeKeyDocument({ key: C.key, validUntil: now + NODE_KEY_VALIDITY_MS, previousKeys: [] }, signerOf(C.seed))],
    ]);
    __useNodeKeyFetchForTests(async (url) => {
        if (!docs.has(url)) throw new Error('no such server');
        return docs.get(url);
    });
    const bDoc = readNodeKeyDocument(await (await fetch(`${BASE}/api/node/key`)).json());
    if (!bDoc) throw new Error('b.example has no key document');

    // c.example's side of the node's look-ups (4).
    interface Forward { url: string; signed: boolean; body: any }
    const forwards: Forward[] = [];
    let cAnswer: () => { status: number; body?: unknown } | 'unreachable' = () => ({ status: 200, body: JSON.parse(FIND_NOBODY_BODY) });
    outbox.__useRelayTransportForTests(async (url, init) => {
        const u = new URL(url);
        const header = parseNodeRequestHeader(init.headers[NODE_REQUEST_HEADER] ?? '');
        const signed = !!header && header.key === bDoc.key && header.origin === 'b.example' && header.destination === u.host
            && nodeRequestSignatureVerifies(header, { method: 'POST', path: u.pathname, body: init.body });
        forwards.push({ url, signed, body: JSON.parse(init.body) });
        const a = cAnswer();
        if (a === 'unreachable') throw new Error('connect ECONNREFUSED');
        return a;
    });

    // ── Helpers ───────────────────────────────────────────────────────────────────────────
    async function asMember(who: Keys, method: 'GET' | 'POST', p: string, body?: unknown): Promise<Answer> {
        const text = body === undefined ? '' : JSON.stringify(body);
        const headers = signedHeaders({ method, path: p, body: text, publicKeyHex: who.key, key: who.seed, host: 'b.example' });
        return send(method, p, headers, method === 'GET' ? undefined : text);
    }
    const cardOf = (who: Keys, name: string, home = 'b.example'): Promise<AddressCard> =>
        signAddressCard({ key: who.key, home, name }, signerOf(who.seed));
    type Mode = 'signed' | 'unsigned' | 'replayed' | 'wrong destination';
    /** a.example (or `as`) brings b.example a look-up for `name` by `asker`, as `mode` says. */
    async function lookup(asker: string, name: string, mode: Mode = 'signed', as: { name: string; k: Keys } = { name: 'a.example', k: A }): Promise<Answer> {
        const body = JSON.stringify({ v: 1, asker, name });
        if (mode === 'unsigned') return send('POST', RELAY_FIND_PATH, {}, body);
        const destination = mode === 'wrong destination' ? 'c.example' : 'b.example';
        const headers = await buildNodeRequestHeaders({ method: 'POST', url: `https://${destination}${RELAY_FIND_PATH}`, body, origin: as.name, keyHex: as.k.key, sign: signerOf(as.k.seed) });
        if (mode === 'replayed') await send('POST', RELAY_FIND_PATH, headers, body);
        return send('POST', RELAY_FIND_PATH, headers, body);
    }
    const sameSteps = () => JSON.stringify(find.stepsOfLastAnswer()) === JSON.stringify(find.FIND_STEPS);

    // ── 1. The switch ─────────────────────────────────────────────────────────────────────
    console.log('\n1. The switch: off until a member turns it on, with their own card');
    let me = await asMember(wren, 'GET', '/api/find/me');
    assert(me.status === 200 && me.body?.findable === false && me.cache === 'no-store', `1a. off until turned on (got ${me.status} ${me.text})`);
    const wrenCard = await cardOf(wren, NAMES.wren);
    const bad: Array<[string, unknown]> = [
        ["another member's card", await cardOf(moss, NAMES.moss)],
        ['a card naming another community', await cardOf(wren, NAMES.wren, 'c.example')],
        ['a card under another name', await cardOf(wren, NAMES.moss)],
        ['a card changed after it was signed', { ...wrenCard, name: 'Wren Tallowmere ' }],
        ['no card', undefined],
    ];
    for (const [why, card] of bad) {
        const r = await asMember(wren, 'POST', '/api/find/me', { on: true, card });
        assert(r.status === 400 && r.body?.code === 'bad_card', `1b. refused: ${why} (got ${r.status} ${r.body?.code})`);
    }
    const notSwitch = await asMember(wren, 'POST', '/api/find/me', { on: 'yes', card: wrenCard });
    assert(notSwitch.status === 400 && notSwitch.body?.code === 'bad_switch', `1c. on is true or false (got ${notSwitch.status})`);
    me = await asMember(wren, 'GET', '/api/find/me');
    assert(me.body?.findable === false, '1d. still off after every refusal');
    const stampBefore = (db.prepare('SELECT updated_at FROM members WHERE public_key = ?').get(wren.key) as { updated_at: string }).updated_at;
    await new Promise((r) => setTimeout(r, 5));
    const on = await asMember(wren, 'POST', '/api/find/me', { on: true, card: wrenCard });
    assert(on.status === 200 && on.body?.findable === true, `1e. on with her own card (got ${on.status} ${on.text})`);
    const stampAfter = (db.prepare('SELECT updated_at FROM members WHERE public_key = ?').get(wren.key) as { updated_at: string }).updated_at;
    assert(stampAfter !== stampBefore, '1f. her row is stamped, so a standby copies the switch');
    me = await asMember(wren, 'GET', '/api/find/me');
    assert(me.body?.findable === true, '1g. and reads back on');
    const stranger = keys();
    const notMember = await asMember(stranger, 'POST', '/api/find/me', { on: true, card: await cardOf(stranger, 'Stray') });
    assert(notMember.status === 403, `1h. a key that is no member here is refused (got ${notMember.status})`);
    // Everyone else the table needs, switched on by their own hand (Moss never is).
    for (const [who, name] of [[juno, NAMES.juno], [rook, NAMES.rook], [fern, NAMES.fern], [sky, NAMES.sky]] as Array<[Keys, string]>) {
        const r = await asMember(who, 'POST', '/api/find/me', { on: true, card: await cardOf(who, name) });
        assert(r.status === 200 && r.body?.findable === true, `1i. ${name} turns it on`);
    }
    // Then Rook is removed (paused) and Fern leaves.
    db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(rook.key);
    db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(fern.key);

    // ── 2. The table ──────────────────────────────────────────────────────────────────────
    console.log('\n2. The table: target x the day x the request');
    interface Target { id: string; name: string; found: boolean; asker?: Keys; before?: (asker: string) => void }
    const targets: Target[] = [
        { id: 'opted in', name: NAMES.wren, found: true },
        { id: 'not opted in', name: NAMES.moss, found: false },
        { id: 'no such name', name: 'Nobody Atall', found: false },
        { id: 'case variant', name: 'wREN TALLOWMERE', found: true },
        { id: 'spacing variant', name: '  Wren    Tallowmere ', found: true },
        { id: 'a part of the name', name: 'Wren', found: false },
        { id: 'a letter short', name: 'Wren Tallowmer', found: false },
        { id: 'blocked the asker', name: NAMES.juno, found: false, before: (asker) => { addBlocks(juno.key, [asker]); } },
        { id: 'removed', name: NAMES.rook, found: false },
        { id: 'left', name: NAMES.fern, found: false },
        { id: 'the asker themselves', name: NAMES.sky, found: false, asker: sky },
    ];
    type Day = 'under' | 'the 10th' | 'the 11th' | 'the asking server past its day';
    const days: Day[] = ['under', 'the 10th', 'the 11th', 'the asking server past its day'];
    const modes: Mode[] = ['signed', 'unsigned', 'replayed', 'wrong destination'];
    const refusedAs: Record<Exclude<Mode, 'signed'>, number> = { unsigned: 401, replayed: 403, 'wrong destination': 421 };
    let nobodyType = '';
    let rows = 0, rowsGood = 0;
    const tableFailures: string[] = [];
    for (const day of days) {
        find.forgetFindCounts();
        if (day === 'the asking server past its day') {
            for (let i = 0; i < find.FIND_PER_ORIGIN_DAY; i++) await lookup(keys().key, 'Nobody Atall');
        }
        for (const t of targets) {
            for (const mode of modes) {
                if (day !== 'the asking server past its day') find.forgetFindCounts();
                const asker = t.asker?.key ?? keys().key;
                t.before?.(asker);
                const prior = day === 'the 10th' ? FIND_BY_NAME_PER_DAY - 1 : day === 'the 11th' ? FIND_BY_NAME_PER_DAY : 0;
                for (let i = 0; i < prior; i++) await lookup(asker, 'Nobody Atall');
                const r = await lookup(asker, t.name, mode);
                const label = `${t.id} x ${day} x ${mode}`;
                let ok: boolean;
                let why = '';
                if (mode !== 'signed') {
                    ok = r.status === refusedAs[mode] && !r.text.includes('"card"');
                    why = `expected ${refusedAs[mode]}, got ${r.status} ${r.text.slice(0, 80)}`;
                } else if (t.found && (day === 'under' || day === 'the 10th')) {
                    const card = r.body?.card;
                    ok = r.status === 200 && r.body?.v === 1 && addressCardVerifies(card) && card.key === wren.key && card.home === 'b.example' && sameSteps();
                    why = `expected Wren's card, got ${r.status} ${r.text.slice(0, 80)} steps ${JSON.stringify(find.stepsOfLastAnswer())}`;
                } else {
                    if (!nobodyType) nobodyType = r.type;
                    ok = r.status === 200 && r.text === FIND_NOBODY_BODY && r.type === nobodyType && r.cache === 'no-store' && sameSteps();
                    why = `expected the one nobody, got ${r.status} ${r.type} ${r.cache} ${r.text.slice(0, 80)} steps ${JSON.stringify(find.stepsOfLastAnswer())}`;
                }
                rows++;
                if (ok) rowsGood++; else tableFailures.push(`${label}: ${why}`);
            }
        }
    }
    for (const f of tableFailures.slice(0, 20)) console.error(`  ${f}`);
    assert(rows === targets.length * days.length * modes.length && rowsGood === rows,
        `2a. every row answers as the table says: ${rowsGood} of ${rows} (${targets.length} targets x ${days.length} days x ${modes.length} requests)`);
    assert(nobodyType.startsWith('application/json'), `2b. the one nobody is JSON (${nobodyType})`);

    // ── 3. Refused requests count nothing; a look-up that is not one ──────────────────────
    console.log('\n3. Refused requests count nothing');
    find.forgetFindCounts();
    const quiet = keys().key;
    for (let i = 0; i < FIND_BY_NAME_PER_DAY + 2; i++) await lookup(quiet, 'Nobody Atall', i % 2 === 0 ? 'unsigned' : 'wrong destination');
    const still = await lookup(quiet, NAMES.wren);
    assert(addressCardVerifies(still.body?.card), `3a. twelve refused look-ups later, the asker is still within the day (got ${still.text.slice(0, 60)})`);
    for (const [why, body] of [['no asker', { v: 1, name: NAMES.wren }], ['no name', { v: 1, asker: quiet }], ['a name past 60', { v: 1, asker: quiet, name: 'x'.repeat(61) }], ['another version', { v: 2, asker: quiet, name: NAMES.wren }]] as Array<[string, unknown]>) {
        const text = JSON.stringify(body);
        const headers = await buildNodeRequestHeaders({ method: 'POST', url: `https://b.example${RELAY_FIND_PATH}`, body: text, origin: 'a.example', keyHex: A.key, sign: signerOf(A.seed) });
        const r = await send('POST', RELAY_FIND_PATH, headers, text);
        assert(r.status === 400 && r.body?.code === 'not_a_lookup' && !r.text.includes(wren.key), `3b. not a look-up (${why}): 400, nothing of anyone's (got ${r.status})`);
    }
    const asMemberHere = await (async () => {
        const text = JSON.stringify({ v: 1, asker: quiet, name: NAMES.wren });
        return send('POST', RELAY_FIND_PATH, signedHeaders({ method: 'POST', path: RELAY_FIND_PATH, body: text, publicKeyHex: ben.key, key: ben.seed, host: 'b.example' }), text);
    })();
    assert(asMemberHere.status === 401 && !asMemberHere.text.includes('"card"'), `3c. a member's signature is not a server's: 401 (got ${asMemberHere.status})`);

    // ── 4. Asking another community ───────────────────────────────────────────────────────
    console.log('\n4. Ben (b.example) asks c.example');
    const cara = keys();
    const CARA = 'Cara Windlestraw';
    const caraCard = await cardOf(cara, CARA, 'c.example');
    const benCard = await cardOf(ben, NAMES.ben, 'c.example');
    const asks: Array<{ why: string; answer: () => { status: number; body?: unknown } | 'unreachable'; expect: 'card' | 'nobody' | 502 }> = [
        { why: 'a card that carries the name', answer: () => ({ status: 200, body: { v: 1, card: caraCard } }), expect: 'card' },
        { why: 'the one nobody', answer: () => ({ status: 200, body: { v: 1, card: null } }), expect: 'nobody' },
        { why: 'a card under another name', answer: () => ({ status: 200, body: { v: 1, card: { ...caraCard } } }), expect: 'nobody' },
        { why: "the asker's own card", answer: () => ({ status: 200, body: { v: 1, card: benCard } }), expect: 'nobody' },
        { why: 'a card its key did not sign', answer: () => ({ status: 200, body: { v: 1, card: { ...caraCard, home: 'd.example' } } }), expect: 'nobody' },
        { why: 'a 500', answer: () => ({ status: 500 }), expect: 502 },
        { why: 'no answer at all', answer: () => 'unreachable', expect: 502 },
        { why: 'a 200 that is no answer', answer: () => ({ status: 200, body: { hello: 1 } }), expect: 502 },
    ];
    for (const a of asks) {
        find.forgetFindCounts();
        forwards.length = 0;
        cAnswer = a.answer;
        const name = a.why === 'a card under another name' ? 'Cara Windle' : (a.why === "the asker's own card" ? NAMES.ben : CARA);
        const r = await asMember(ben, 'POST', '/api/find/name', { home: 'c.example', name });
        const f = forwards[0];
        assert(forwards.length === 1 && f.url === `https://c.example${RELAY_FIND_PATH}` && f.signed && f.body?.v === 1 && f.body?.asker === ben.key && f.body?.name === name,
            `4a. ${a.why}: one request to c.example, signed by b.example for c.example, naming Ben and the name (got ${forwards.length} ${JSON.stringify(f?.body)})`);
        if (a.expect === 'card') assert(r.status === 200 && r.body?.found === true && r.body.card?.key === cara.key && addressCardVerifies(r.body.card), `4b. ${a.why}: Ben gets her card (got ${r.status} ${r.text.slice(0, 80)})`);
        else if (a.expect === 'nobody') assert(r.status === 200 && r.text === '{"found":false}', `4b. ${a.why}: Ben is told nobody (got ${r.status} ${r.text.slice(0, 80)})`);
        else assert(r.status === 502 && r.body?.code === 'not_reached', `4b. ${a.why}: 502, that community could not be asked (got ${r.status} ${r.text.slice(0, 80)})`);
    }
    const spaced = await (async () => { forwards.length = 0; cAnswer = asks[0].answer; return asMember(ben, 'POST', '/api/find/name', { home: ' https://C.example/ ', name: '  cara   WINDLESTRAW ' }); })();
    assert(spaced.body?.found === true && forwards[0]?.url === `https://c.example${RELAY_FIND_PATH}` && forwards[0]?.body?.name === 'cara WINDLESTRAW',
        `4c. an address typed as a link, a name with spaces and other case: asked as c.example, "cara WINDLESTRAW", found (got ${spaced.text.slice(0, 60)})`);
    const refusedHere: Array<[string, Keys, unknown, number, string]> = [
        ['this community', ben, { home: 'b.example', name: NAMES.wren }, 400, 'own_community'],
        ['this community by its other name', ben, { home: 'b-alias.example', name: NAMES.wren }, 400, 'own_community'],
        ['no community', ben, { home: 'not a host!', name: CARA }, 400, 'bad_home'],
        ['no name', ben, { home: 'c.example', name: '   ' }, 400, 'bad_name'],
        ['a name past 60', ben, { home: 'c.example', name: 'x'.repeat(61) }, 400, 'bad_name'],
        ['a key that is no member here', keys(), { home: 'c.example', name: CARA }, 403, 'not_a_member'],
    ];
    for (const [why, who, body, status, code] of refusedHere) {
        forwards.length = 0;
        const r = await asMember(who, 'POST', '/api/find/name', body);
        assert(r.status === status && r.body?.code === code && forwards.length === 0, `4d. ${why}: ${status} ${code}, nothing sent (got ${r.status} ${r.body?.code}, ${forwards.length} sent)`);
    }
    find.forgetFindCounts();
    forwards.length = 0;
    cAnswer = asks[1].answer;
    let within = 0;
    for (let i = 0; i < FIND_BY_NAME_PER_DAY; i++) if ((await asMember(ben, 'POST', '/api/find/name', { home: 'c.example', name: `Someone ${i}` })).status === 200) within++;
    const eleventh = await asMember(ben, 'POST', '/api/find/name', { home: 'c.example', name: CARA });
    assert(within === FIND_BY_NAME_PER_DAY && forwards.length === FIND_BY_NAME_PER_DAY, `4e. ten look-ups today, each asked (${within}, ${forwards.length} sent)`);
    assert(eleventh.status === 429 && eleventh.body?.code === 'find_day_used' && forwards.length === FIND_BY_NAME_PER_DAY, `4f. the 11th is refused here, 429, nothing sent (got ${eleventh.status} ${eleventh.body?.code})`);

    // ── 5. The owner's switch off ─────────────────────────────────────────────────────────
    console.log("\n5. The owner's switch off");
    find.forgetFindCounts();
    applyShapeChanges({ actor: olive.key, actorRole: 'owner' }, { changes: { outsideMessages: false } });
    forwards.length = 0;
    const offAsk = await asMember(ben, 'POST', '/api/find/name', { home: 'c.example', name: CARA });
    assert(offAsk.status === 403 && offAsk.body?.code === 'outside_off' && forwards.length === 0, `5a. asking is refused here, nothing sent (got ${offAsk.status})`);
    const offAnswer = await lookup(keys().key, NAMES.wren);
    assert(offAnswer.status === 200 && offAnswer.text === FIND_NOBODY_BODY && sameSteps(), `5b. answering: the one nobody, the same steps (got ${offAnswer.text.slice(0, 60)})`);
    applyShapeChanges({ actor: olive.key, actorRole: 'owner' }, { changes: { outsideMessages: true } });

    // ── 6. Renamed, and off again ─────────────────────────────────────────────────────────
    console.log('\n6. A renamed member, and the switch off again');
    find.forgetFindCounts();
    db.prepare('UPDATE members SET callsign = ? WHERE public_key = ?').run('Wren Hartwell', wren.key);
    const oldName = await lookup(keys().key, NAMES.wren);
    const newName = await lookup(keys().key, 'Wren Hartwell');
    assert(oldName.text === FIND_NOBODY_BODY && newName.text === FIND_NOBODY_BODY, '6a. renamed: nobody by the old name or the new, until her app hands a new card');
    const renamedOn = await asMember(wren, 'POST', '/api/find/me', { on: true, card: await cardOf(wren, 'Wren Hartwell') });
    const afterNew = await lookup(keys().key, 'Wren Hartwell');
    assert(renamedOn.body?.findable === true && afterNew.body?.card?.name === 'Wren Hartwell', '6b. with her new card she is found by her new name');
    const off = await asMember(wren, 'POST', '/api/find/me', { on: false });
    const afterOff = await lookup(keys().key, 'Wren Hartwell');
    me = await asMember(wren, 'GET', '/api/find/me');
    assert(off.body?.findable === false && me.body?.findable === false && afterOff.text === FIND_NOBODY_BODY && sameSteps(), '6c. off: nobody, the same bytes and steps');
    const kept = db.prepare("SELECT COUNT(*) AS n FROM member_preferences WHERE public_key = ? AND pref_key = 'find_by_name'").get(wren.key) as { n: number };
    assert(kept.n === 0, '6d. off keeps nothing of her card');

    // ── 7. The logs ───────────────────────────────────────────────────────────────────────
    console.log('\n7. Nothing found or typed is logged');
    const secrets = [...Object.values(NAMES), CARA, 'Wren Hartwell', 'Nobody Atall', 'wREN TALLOWMERE', wren.key, sky.key, ben.key, cara.key, juno.key];
    const named = logs.filter((line) => secrets.some((s) => line.includes(s)));
    assert(named.length === 0, `7a. no log line names a name typed or a key (${named.length}: ${named.slice(0, 2).join(' | ').slice(0, 200)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
