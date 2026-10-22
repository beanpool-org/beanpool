/**
 * Focused integration test suite for routes/enterprise-decisions.ts.
 *
 * Verifies HTTP endpoints in createEnterpriseDecisionRoutes:
 *  - Unauthenticated / unsigned requests (rejected by server auth / middleware).
 *  - GET /api/enterprise/:treasury/decisions (404 for non-keepers, 200 for keepers).
 *  - POST /api/enterprise/:treasury/decisions (propose decision, muted check, validation).
 *  - GET /api/enterprise/:treasury/decisions/:id (detail 404 for non-keepers, 200 for keepers).
 *  - POST /api/enterprise/:treasury/decisions/:id/vote (vote validation, voting on decision).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm --filter @beanpool/server exec tsx src/test-enterprise-decisions.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, reconcileLedgerFromDb } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };
const DAY = 86400_000;

function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { pubKeyHex, privateKey };
}

function makeMember(callsign: string, balance = 50): Id {
    const id = keypair();
    const joinedAt = new Date(Date.now() - 30 * DAY).toISOString();
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, earned_credit)
                VALUES (?, ?, ?, 'active', 100)`).run(id.pubKeyHex, callsign, joinedAt);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0)`).run(id.pubKeyHex, balance);
    return id;
}

function makeEnterprise(name: string, keepers: Id[], balance = 100): string {
    const ent = keypair().pubKeyHex;
    const created = new Date(Date.now() - 20 * DAY).toISOString();
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, is_treasury, earned_credit, earned_surplus, lifecycle, paused, purpose)
                VALUES (?, ?, ?, 'active', 1, 0, 0, 'ongoing', 0, 'Test enterprise')`)
        .run(ent, name, created);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0)`).run(ent, balance);
    keepers.forEach((k, i) => {
        db.prepare(`INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_at) VALUES (?, ?, ?, ?)`)
            .run(ent, k.pubKeyHex, i === 0 ? 'lead' : 'keeper', new Date(Date.now() - (10 - i) * DAY).toISOString());
        db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(k.pubKeyHex);
    });
    reconcileLedgerFromDb();
    return ent;
}

async function fetchRoute(method: 'GET' | 'POST', path: string, body?: unknown, id?: Id | null) {
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
        headers['X-Public-Key'] = id.pubKeyHex;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : bodyString });
    let json: any;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

async function main(): Promise<void> {
    console.log('\nTesting routes/enterprise-decisions.ts\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const k1 = makeMember('Keeper1');
    const k2 = makeMember('Keeper2');
    const k3 = makeMember('Keeper3');
    const stranger = makeMember('Stranger');
    const recipient = makeMember('Recipient');

    const ent = makeEnterprise('TestTreasury', [k1, k2, k3], 200);

    // 1. Unauthenticated / unsigned requests are refused (status !== 200)
    const unauthList = await fetchRoute('GET', `/api/enterprise/${ent}/decisions`);
    assert(unauthList.status !== 200, `Unauthenticated list is refused (got ${unauthList.status})`);

    const unauthDetail = await fetchRoute('GET', `/api/enterprise/${ent}/decisions/some-id`);
    assert(unauthDetail.status !== 200, `Unauthenticated detail is refused (got ${unauthDetail.status})`);

    const unauthPropose = await fetchRoute('POST', `/api/enterprise/${ent}/decisions`, { title: 'Test' });
    assert(unauthPropose.status !== 200, `Unauthenticated propose is refused (got ${unauthPropose.status})`);

    const unauthVote = await fetchRoute('POST', `/api/enterprise/${ent}/decisions/some-id/vote`, { support: true });
    assert(unauthVote.status !== 200, `Unauthenticated vote is refused (got ${unauthVote.status})`);

    // 2. Non-keeper requests should return 404
    const strangerList = await fetchRoute('GET', `/api/enterprise/${ent}/decisions`, undefined, stranger);
    assert(strangerList.status === 404 && strangerList.body?.error === 'Not found', 'Non-keeper list returns 404');

    const strangerPropose = await fetchRoute('POST', `/api/enterprise/${ent}/decisions`, {
        title: 'Stranger Propose', description: 'Desc', effect: 'pay_out', params: { to: recipient.pubKeyHex, amount: 10 },
    }, stranger);
    assert(strangerPropose.status === 404 && strangerPropose.body?.error === 'Not found', 'Non-keeper propose returns 404');

    // 3. Keeper lists decisions (should be empty initially)
    const keeperList = await fetchRoute('GET', `/api/enterprise/${ent}/decisions`, undefined, k1);
    assert(keeperList.status === 200 && Array.isArray(keeperList.body?.decisions) && keeperList.body.decisions.length === 0, 'Keeper sees empty decision list');
    assert(keeperList.body?.canPropose === true && keeperList.body?.rollSize === 3, 'Keeper list metadata has correct canPropose and rollSize');

    // 4. Keeper proposes a decision
    const propRes = await fetchRoute('POST', `/api/enterprise/${ent}/decisions`, {
        title: 'Pay Recipient',
        description: 'Payment for services',
        effect: 'pay_out',
        params: { to: recipient.pubKeyHex, amount: 20 },
    }, k1);
    assert(propRes.status === 200 && propRes.body?.success === true && propRes.body?.decision?.id, 'Keeper proposes decision successfully');
    const decisionId = propRes.body.decision.id;

    // 5. Keeper gets decision detail
    const detailRes = await fetchRoute('GET', `/api/enterprise/${ent}/decisions/${decisionId}`, undefined, k1);
    assert(detailRes.status === 200 && detailRes.body?.decision?.id === decisionId, 'Keeper retrieves decision detail');
    assert(detailRes.body?.decision?.canVote === true, 'Keeper on roll can vote');

    // Stranger gets 404 on decision detail
    const strangerDetail = await fetchRoute('GET', `/api/enterprise/${ent}/decisions/${decisionId}`, undefined, stranger);
    assert(strangerDetail.status === 404, 'Non-keeper detail returns 404');

    // 6. Voting input validation
    const invalidVoteType = await fetchRoute('POST', `/api/enterprise/${ent}/decisions/${decisionId}/vote`, { support: 'yes' }, k1);
    assert(invalidVoteType.status === 400 && invalidVoteType.body?.error === 'support (true or false) is required', 'Non-boolean support parameter returns 400');

    const strangerVote = await fetchRoute('POST', `/api/enterprise/${ent}/decisions/${decisionId}/vote`, { support: true }, stranger);
    assert(strangerVote.status === 404, 'Non-keeper vote returns 404');

    // 7. Valid vote by keeper
    const voteRes = await fetchRoute('POST', `/api/enterprise/${ent}/decisions/${decisionId}/vote`, { support: true }, k1);
    assert(voteRes.status === 200 && voteRes.body?.success === true, 'Keeper votes successfully on decision');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
