/**
 * Integration & unit test coverage for routes/money-limits-gate.ts.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { initTls } from './services/tls.js';
import { initStateEngine, reconcileLedgerFromDb } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import {
    enterpriseActingFor,
    malformedMoneyId,
    moneyPlanFor,
    respondMoneyLimit,
    MONEY_ROUTES,
} from './routes/money-limits-gate.js';
import { MoneyLimitError } from './engine/money-limits.js';
import { setMemberPhoto } from '@beanpool/engine';

let PORT = 0;
let BASE = '';

let run = 0;
let passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

interface Identity {
    pub: string;
    priv: crypto.KeyObject;
}

function makeIdentity(): Identity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { pub, priv: privateKey };
}

function insertMember(id: Identity, callsign: string, balance = 1000): void {
    db.prepare(
        `INSERT OR IGNORE INTO members (public_key, callsign, joined_at, status)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active')`
    ).run(id.pub, callsign);
    setMemberPhoto(db, id.pub, 'data:image/png;base64,iVBORw0KGgo=');
    db.prepare(
        `INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0)`
    ).run(id.pub, balance);
}

function completedTrade(buyer: string, seller: string, credits: number) {
    const pid = `mlg-post-${crypto.randomBytes(4).toString('hex')}`;
    db.prepare(
        `INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status)
         VALUES (?, 'offer', 'misc', 'test', 'test', ?, ?, 'completed')`
    ).run(pid, credits, seller);
    db.prepare(
        `INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status)
         VALUES (?, ?, ?, ?, ?, 'completed')`
    ).run(`mlg-mtx-${crypto.randomBytes(4).toString('hex')}`, pid, buyer, seller, credits);
}

async function sendRequest(
    method: string,
    path: string,
    body: unknown,
    signer?: Identity
): Promise<{ status: number; body: any }> {
    const bodyString = JSON.stringify(body);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (signer) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
        headers['X-Public-Key'] = signer.pub;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), signer.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: bodyString });
    let resBody: any = null;
    try {
        resBody = await res.json();
    } catch {
        /* not json */
    }
    return { status: res.status, body: resBody };
}

async function main() {
    console.log('Running money-limits-gate tests...');

    await initTls();
    initStateEngine();

    // 1. Unit Tests
    console.log('\n--- Unit Tests ---');

    // Unit test: malformedMoneyId
    const transferRoute = MONEY_ROUTES.find((r) => r.path.test('/api/ledger/transfer'))!;
    assert(
        malformedMoneyId(transferRoute, { to: 'validpubkey' }) === null,
        'malformedMoneyId returns null for valid string id'
    );
    assert(
        malformedMoneyId(transferRoute, { to: 12345 }) === 'to',
        'malformedMoneyId detects numeric id'
    );
    assert(
        malformedMoneyId(transferRoute, { to: ['pubkey1', 'pubkey2'] }) === 'to',
        'malformedMoneyId detects array id'
    );
    assert(
        malformedMoneyId(transferRoute, { to: '' }) === 'to',
        'malformedMoneyId detects empty string id'
    );
    assert(
        malformedMoneyId(transferRoute, {}) === null,
        'malformedMoneyId returns null if id field is omitted'
    );

    // Unit test: moneyPlanFor
    assert(
        moneyPlanFor('POST', '/api/ledger/transfer', null, { to: 'rec' }) === null,
        'moneyPlanFor returns null when actor is null'
    );
    const transferPlan = moneyPlanFor('POST', '/api/ledger/transfer', 'actor1', { to: 'recipient1' });
    assert(
        transferPlan !== null && transferPlan.account === 'actor1' && transferPlan.acts[0].kind === 'payment',
        'moneyPlanFor creates payment plan for transfer'
    );
    assert(
        moneyPlanFor('GET', '/api/ledger/transfer', 'actor1', {}) === null,
        'moneyPlanFor returns null for GET request'
    );
    assert(
        moneyPlanFor('POST', '/api/unknown/route', 'actor1', {}) === null,
        'moneyPlanFor returns null for unmapped route'
    );

    // Unit test: respondMoneyLimit
    const mockCtx: { status: number; body: any; headers: Record<string, string>; set(k: string, v: string): void } = {
        status: 200,
        body: null,
        headers: {},
        set(k: string, v: string) {
            this.headers[k] = v;
        },
    };
    assert(
        respondMoneyLimit(mockCtx, new Error('generic')) === false,
        'respondMoneyLimit returns false for generic Error'
    );
    const resetsAt = new Date(Date.now() + 60000).toISOString();
    const moneyErr = new MoneyLimitError('money_payments_day', 'Limit reached', resetsAt);
    assert(
        respondMoneyLimit(mockCtx, moneyErr) === true,
        'respondMoneyLimit returns true for MoneyLimitError'
    );
    assert(mockCtx.status === 429, 'respondMoneyLimit sets HTTP status 429');
    assert(mockCtx.body?.error === 'Limit reached', 'respondMoneyLimit sets error message');
    assert(mockCtx.body?.code === 'money_payments_day', 'respondMoneyLimit sets error code');
    assert(!!mockCtx.headers['Retry-After'], 'respondMoneyLimit sets Retry-After header');

    // Unit test: enterpriseActingFor
    const alice = makeIdentity();
    insertMember(alice, 'alice_unit');
    assert(
        enterpriseActingFor(null, '/api/treasury/ent1/approve') === null,
        'enterpriseActingFor returns null without actor'
    );
    assert(
        enterpriseActingFor(alice.pub, '/api/other/ent1/approve') === null,
        'enterpriseActingFor returns null for non-enterprise path'
    );
    assert(
        enterpriseActingFor(alice.pub, '/api/treasury/nonexistent/approve') === null,
        'enterpriseActingFor returns null for non-existent enterprise'
    );

    // 2. HTTP Integration Tests
    console.log('\n--- HTTP Integration Tests ---');
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;

    const memberA = makeIdentity();
    const memberB = makeIdentity();
    insertMember(memberA, 'member_a', 1000);
    insertMember(memberB, 'member_b', 1000);
    completedTrade(memberA.pub, memberB.pub, 50);
    reconcileLedgerFromDb();

    // Test malformed ID rejection (number)
    const resBadNum = await sendRequest(
        'POST',
        '/api/ledger/transfer',
        { to: 12345, amount: 10 },
        memberA
    );
    assert(resBadNum.status === 400, 'POST /api/ledger/transfer with numeric "to" returns 400');
    assert(
        resBadNum.body?.error === 'to must be an id, sent as text.',
        'POST /api/ledger/transfer returns correct malformed id error text'
    );

    // Test malformed ID rejection (array)
    const resBadArr = await sendRequest(
        'POST',
        '/api/ledger/transfer',
        { to: [memberB.pub], amount: 10 },
        memberA
    );
    assert(resBadArr.status === 400, 'POST /api/ledger/transfer with array "to" returns 400');
    assert(
        resBadArr.body?.error === 'to must be an id, sent as text.',
        'POST /api/ledger/transfer returns correct malformed array id error text'
    );

    // Test malformed ID rejection (empty string)
    const resBadEmpty = await sendRequest(
        'POST',
        '/api/ledger/transfer',
        { to: '', amount: 10 },
        memberA
    );
    assert(resBadEmpty.status === 400, 'POST /api/ledger/transfer with empty string "to" returns 400');
    assert(
        resBadEmpty.body?.error === 'to must be an id, sent as text.',
        'POST /api/ledger/transfer returns correct malformed empty string id error text'
    );

    // Test valid money transfer
    const resValid = await sendRequest(
        'POST',
        '/api/ledger/transfer',
        { to: memberB.pub, amount: 10, memo: 'Test transfer' },
        memberA
    );
    assert(resValid.status === 200, 'POST /api/ledger/transfer with valid parameters returns 200');

    // Test release hold when handler returns 4xx
    // Attempt transfer with invalid negative amount (handler fails validation)
    const resFail = await sendRequest(
        'POST',
        '/api/ledger/transfer',
        { to: memberB.pub, amount: -50 },
        memberA
    );
    assert(resFail.status === 400, 'POST /api/ledger/transfer with negative amount returns 400');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ money-limits-gate checks PASSED.');
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error('❌ Test failed:', e);
        process.exit(1);
    });
