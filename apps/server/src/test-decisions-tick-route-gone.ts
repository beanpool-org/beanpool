/**
 * POST /api/commons/decisions/tick is gone — over a REAL HTTPS round trip, through the middleware.
 *
 * Decisions close and execute on their own: state-engine.ts runs tickDecisions() on a timer, every 60
 * seconds, and that is the only mechanism any node has ever relied on. The HTTP route was a second door
 * onto the same function. Since #1021 it demanded a valid signature AND node admin credentials at once, a
 * combination no client has ever sent, and nothing in apps/pwa, apps/native or apps/manager called it at
 * all. It was removed rather than left as an unreachable admin-only way to run the engine by hand.
 *
 * This has to go over the wire. A router-level test cannot tell "removed" from "still mounted": the test
 * harness asks the router for the layer by name, so a missing route raises inside the harness instead of
 * producing what a caller would actually get.
 *
 * Verifies:
 *  1. The one request shape that used to work — signed AND carrying the admin password — is refused by the
 *     router: 405, because the sibling GET /api/commons/decisions/:id still matches that path, so
 *     @koa/router's allowedMethods() answers Method Not Allowed rather than 404. Either way no handler
 *     runs. On a tree that still has the route this request is 200.
 *  2. Nothing ticked: a Decision sitting past its close time is untouched by that request...
 *  3. ...and the same Decision does close on the real mechanism, tickDecisions(), called straight after. So
 *     check 2 means "the route did not run the engine", not "this Decision was never going to move".
 *  4. The rest of the Decisions API is still mounted (GET /api/commons/decisions → 200), so the refusal
 *     above is the one route being gone rather than the whole router being unmounted.
 *
 * An unsigned POST is 401 from the signature middleware, before routing, exactly as it was — removing a
 * route cannot change what never reaches the router. Asserted here only to say so out loud.
 *
 * Local only — it talks to the server it starts on localhost and nothing else.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-decisions-tick-route-gone.ts
 */

// Self-signed cert in LAN mode → relax TLS verification for the test client only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, createDecision, tickDecisions, reconcileLedgerFromDb } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { updateLocalConfig, hashPassword } from './config/local-config.js';

const PORT = 8709;
const BASE = `https://localhost:${PORT}`;
const TICK_PATH = '/api/commons/decisions/tick';
const ADMIN_PW = 'TickRouteGone123!';

// Every assertion runs and failures are reported together, so one broken finding does not hide the others.
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };

function makeMember(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    const joinedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, earned_credit)
                VALUES (?, ?, ?, 'active', 100)`).run(pubKeyHex, callsign, joinedAt);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 50, 0)`).run(pubKeyHex);
    reconcileLedgerFromDb();
    return { pubKeyHex, privateKey };
}

const statusOf = (id: string) =>
    (db.prepare('SELECT status FROM decisions WHERE id = ?').get(id) as { status: string } | undefined)?.status;

/** The replay-proof scheme the real middleware requires: method + path + timestamp + nonce + body. */
async function signedFetch(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    id: Id | null,
    extraHeaders: Record<string, string> = {},
) {
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = { ...extraHeaders };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
        headers['X-Public-Key'] = id.pubKeyHex;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: method === 'GET' ? undefined : bodyString,
    });
    let json: any;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body: json, error: json?.error as string | undefined };
}

async function main(): Promise<void> {
    console.log('\nThe decisions tick route is gone, over real HTTPS\n');
    await initTls();
    initStateEngine();
    const { hash, salt } = hashPassword(ADMIN_PW);
    updateLocalConfig({ adminHash: hash, salt });
    await startHttpsServer(PORT);

    const author = makeMember('TickTina');
    const subject = makeMember('TickTom');

    // A Decision past its close time: the tick has work to do, so "nothing happened" below is a real result.
    const decision = createDecision({
        authorPubkey: author.pubKeyHex,
        title: 'A Decision the tick should close',
        description: 'Nobody votes; the tick closes it unresolved.',
        touches: 'member',
        effect: 'suspend_member',
        subject: subject.pubKeyHex,
    });
    db.prepare("UPDATE decisions SET closes_at = datetime('now', '-10 seconds') WHERE id = ?").run(decision.id);
    assert(statusOf(decision.id) === 'open', `the fixture Decision starts open (got ${statusOf(decision.id)})`);

    // The only shape that ever worked since #1021: a signed request that also carries the admin password.
    const admin = await signedFetch('POST', TICK_PATH, {}, author, { 'x-admin-password': ADMIN_PW });
    assert(admin.status === 405 || admin.status === 404,
        `a signed POST ${TICK_PATH} with the admin password is refused by the router (got ${admin.status} ${admin.error ?? ''})`);
    assert(admin.body?.success !== true, 'the refusal carries no tick result');
    assert(statusOf(decision.id) === 'open',
        `and the overdue Decision is untouched — nothing ticked (got ${statusOf(decision.id)})`);

    // The real mechanism, the one the node runs on a timer, still closes it.
    tickDecisions();
    assert(statusOf(decision.id) !== 'open',
        `tickDecisions() closes the same Decision (got ${statusOf(decision.id)})`);

    // Unchanged by this removal, and said out loud: an unsigned POST dies in the middleware, before routing.
    const unsigned = await signedFetch('POST', TICK_PATH, {}, null);
    assert(unsigned.status === 401,
        `an unsigned POST ${TICK_PATH} is still 401 from the middleware (got ${unsigned.status})`);

    const list = await signedFetch('GET', '/api/commons/decisions', null, author);
    assert(list.status === 200 && Array.isArray(list.body?.decisions),
        `the rest of the Decisions API is still mounted (GET /api/commons/decisions → ${list.status})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ THE DECISIONS TICK ROUTE IS GONE.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
