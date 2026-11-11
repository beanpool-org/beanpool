/**
 * Who reads an enterprise's discussion thread (#2157), against the REAL server, with read auth ON (the plain run) and
 * opted out (ENFORCE_READ_AUTH=false, the readauth-off variant).
 *
 * The thread is public to every member of this community, keepers or not (docs/the-commons.md §2.2; routes/messaging.ts
 * canOpenChat), and to nobody else: the read gate's own test of its route (passesReadGate, a suspended member included),
 * whatever ENFORCE_READ_AUTH says, as a DM, a group's chat and an event's chat are their people's (#2119). Its
 * conversation id is the enterprise's own key, which the enterprises' list names, so it is no secret.
 *
 * Every read of it holds that one rule: GET /api/messages/:conversationId and the thread's own route under each of its
 * three spellings (routes/treasury.ts). With read auth opted out, an unsigned caller, a key that is no member here and a
 * visitor's row each read the whole thread by either before.
 *
 * Also pinned, in both modes: a keeper and a member who is no keeper read it; a gone (pruned) enterprise's thread is 404
 * to a member on both routes, as before; a stranger is refused a gone one exactly as a live one.
 *
 * The flag is a module const read at import, so each mode is its own run:
 *   SERVER_SUITES_ONLY=test-enterprise-thread-read-gate node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, createTreasury, postEnterpriseThreadMessage } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

const OPEN = process.env.ENFORCE_READ_AUTH === 'false';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

type Identity = { pubKeyHex: string; privateKey: crypto.KeyObject };

function newKey(): Identity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}

function makeMember(callsign: string, opts: { status?: string; visitor?: boolean } = {}): Identity {
    const id = newKey();
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, is_visitor) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?)`)
        .run(id.pubKeyHex, callsign, opts.status ?? 'active', opts.visitor ? 1 : 0);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
    return id;
}

interface Answer { status: number; body: any; text: string }

async function read(path: string, id?: Identity, method: 'GET' | 'HEAD' = 'GET'): Promise<Answer> {
    const headers: Record<string, string> = {};
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = { method, path: path.split('?')[0], timestamp: ts, nonce };
        headers['X-Public-Key'] = id.pubKeyHex;
        headers['X-Signature'] = signRequest(id.privateKey, canonical);
        headers[SIGNED_FOR_HEADER] = signedForHost();
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers });
    const text = method === 'HEAD' ? '' : await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* */ }
    return { status: res.status, body, text };
}

const show = (a: Answer) => `${a.status} ${a.body?.error ?? ''}${a.body?.code ? ` [${a.body.code}]` : ''}`.trim();

async function main() {
    console.log(`Running enterprise thread read gate checks (#2157), read auth ${OPEN ? 'OPTED OUT' : 'on'}...\n`);
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const keeper = makeMember('KeeperKim');
    const member = makeMember('MemberMo');
    const suspended = makeMember('SuspendedSue', { status: 'suspended' });
    const visitor = makeMember('VisitorVi', { visitor: true });
    const stranger = newKey(); // signs, and has no row here

    const { publicKey: bakery } = createTreasury('Bakery', AVATAR, 0, { leadKeeperPubkey: keeper.pubKeyHex });
    const SECRET = 'who has the ute on Saturday';
    postEnterpriseThreadMessage(bakery, member.pubKeyHex, SECRET);

    const paths = (ent: string) => [
        `/api/messages/${ent}`,
        `/api/treasury/${ent}/thread`,
        `/api/enterprise/${ent}/thread`,
        `/api/enterprises/${ent}/thread`,
    ];
    const lineOf = (a: Answer) => (a.body?.messages ?? []).some((m: any) => Buffer.from(m.ciphertext ?? '', 'base64').toString('utf8') === SECRET);

    console.log('── Who reads it ──');
    for (const path of paths(bakery)) {
        for (const [who, id] of [['a keeper', keeper], ['a member who is no keeper', member], ['a suspended member (the gate lets them read)', suspended]] as const) {
            const a = await read(path, id);
            assert(a.status === 200 && lineOf(a), `${who} reads the thread at ${path} (${show(a)})`);
        }
    }

    console.log('\n── Who does not ──');
    for (const path of paths(bakery)) {
        const unsigned = await read(path);
        assert(unsigned.status === 401 && !unsigned.text.includes(bakery) && !lineOf(unsigned),
            `an unsigned read is refused 401 at ${path}, nothing of the thread in it (${show(unsigned)})`);
        for (const [who, id] of [['a key that is no member here', stranger], ["a visitor's row", visitor]] as const) {
            const a = await read(path, id);
            assert(a.status === 403 && a.body?.code === 'not_a_member' && !lineOf(a) && !a.text.includes(SECRET),
                `${who} is refused 403 not_a_member at ${path}, nothing of the thread in it (${show(a)})`);
        }
    }
    // HEAD runs the GET handler: its Content-Length would say what the GET would not.
    const head = await read(`/api/messages/${bakery}`, undefined, 'HEAD');
    assert(head.status === 401, `an unsigned HEAD of the thread by its id is refused 401 (got ${head.status})`);

    // The words go through word(): the same sentence in both modes, the gate's.
    const strangerById = await read(`/api/messages/${bakery}`, stranger);
    assert(strangerById.body?.error === 'Read access requires a member identity',
        `the refusal is the read gate's own sentence (got "${strangerById.body?.error}")`);

    console.log('\n── A gone enterprise\'s thread ──');
    const { publicKey: closed } = createTreasury('ClosedShop', AVATAR, 0, { leadKeeperPubkey: keeper.pubKeyHex });
    postEnterpriseThreadMessage(closed, member.pubKeyHex, SECRET);
    db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(closed);
    const goneById = await read(`/api/messages/${closed}`, member);
    assert(goneById.status === 404 && goneById.body?.error === 'Conversation not found',
        `a member gets 404 Conversation not found for a pruned enterprise's thread by its id, as before (${show(goneById)})`);
    for (const path of paths(closed).slice(1)) {
        const own = await read(path, member);
        assert(own.status === 404 && own.body?.error === 'Enterprise not found',
            `a member gets 404 Enterprise not found at ${path} for a pruned enterprise, as before (${show(own)})`);
    }
    for (const path of paths(closed)) {
        const a = await read(path, stranger);
        assert(a.status === 403 && a.body?.code === 'not_a_member',
            `a stranger is refused a gone enterprise's thread at ${path} as a live one's, 403 (${show(a)})`);
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log(`⭐️ Enterprise thread read gate checks PASSED (read auth ${OPEN ? 'opted out' : 'on'}).`);
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
