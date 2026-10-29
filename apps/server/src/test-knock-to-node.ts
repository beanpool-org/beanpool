/**
 * A knock is taken only by the community it was addressed to (routes/knocks.ts "Addressed here";
 * DESIGN-account-without-global-fable.md §3.5, closed in slice S3), over REAL HTTPS through the real signature middleware.
 *
 * The phone puts the community it asks in the body as `toNode`, inside what is signed. An old-format signature names no
 * host, so a community that received a knock could send the same signed request on to another community for five
 * minutes, and learn from the answer whether that key is a member there. Each case below sends such a request.
 *
 *   1. a node that knows none of its names (as a self-hoster's first boot): a knock addressed to the host it came to is
 *      taken, with or without a port; one with no `toNode` is taken as before; one addressed to another community, or to
 *      another host on the home network, is refused 421 `wrong_community`, and nothing is written
 *   2. a node that knows its name: a knock addressed to that name is taken whatever host it came to; one addressed to
 *      another community, or to loopback, is refused, and nothing is written
 *   3. the refusal comes before anything about the key: a member of this community whose knock names another community
 *      hears `wrong_community`, never "already a member"
 *   4. a `toNode` that is not an address is refused too
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-knock-to-node.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.BEANPOOL_ADDRESSES;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { forgetOwnAddresses } from './engine/own-addresses.js';

let BASE = '';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pk = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { pk, priv: privateKey, name };
}

interface Res { status: number; body: any }

/** A knock through the real stack, signed in the old format (no host in what is signed), as a relayed one would be. */
async function knock(id: Id, extra: Record<string, unknown>): Promise<Res> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    // A new day for the address limit (3 a day from one network): every case here comes from the test's one address.
    try { db.prepare('UPDATE join_requests SET ip_hash = NULL').run(); } catch { /* no table yet */ }
    const path = '/api/join/knock';
    const raw = JSON.stringify({ callsign: id.name, message: `Hello from ${id.name}.`, ...extra });
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Public-Key': id.pk,
            'X-Signature': crypto.sign(null, Buffer.from(`POST\n${path}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64'),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
        body: raw,
    });
    let body: any;
    try { body = await res.json(); } catch { body = undefined; }
    return { status: res.status, body };
}

function rowsFor(pk: string): number {
    try { return (db.prepare('SELECT COUNT(*) AS n FROM join_requests WHERE pubkey = ?').get(pk) as { n: number }).n; } catch { return -1; }
}

const refused = (r: Res) => r.status === 421 && r.body?.code === 'wrong_community';
const taken = (r: Res) => r.status === 201 && r.body?.knock?.status === 'pending';

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const mia = newId('Mia');
    seedGenesisMember(mia.pk, mia.name);

    // 1. A node that knows none of its names: the host the request came to is its name for now.
    forgetOwnAddresses();
    {
        const here = newId('Robin');
        const r = await knock(here, { toNode: 'localhost' });
        assert(taken(r) && rowsFor(here.pk) === 1, `1a. a knock addressed to the host it came to is taken (${r.status})`);
        const withPort = newId('Sky');
        const p = await knock(withPort, { toNode: `localhost:${port}` });
        assert(taken(p) && rowsFor(withPort.pk) === 1, `1b. …with the port the phone used, too (${p.status})`);
        const none = newId('Ash');
        const n = await knock(none, {});
        assert(taken(n) && rowsFor(none.pk) === 1, `1c. a knock with no toNode claims nothing to check, and is taken as before (${n.status})`);
        const away = newId('Kit');
        const a = await knock(away, { toNode: 'castlemaine.example.org' });
        assert(refused(a), `1d. a knock addressed to another community is refused 421 wrong_community (${a.status} ${a.body?.code})`);
        assert(rowsFor(away.pk) === 0, '1e. …and nothing is written for it');
        const lan = newId('Bo');
        const l = await knock(lan, { toNode: '192.168.1.9' });
        assert(refused(l) && rowsFor(lan.pk) === 0, `1f. one addressed to another host on the home network is refused too (${l.status})`);
        assert(typeof a.body?.error === 'string' && a.body.error.length > 0, '1g. the refusal says why, in words the app shows as given');
    }

    // 2. A node that knows its name (BEANPOOL_ADDRESSES, one of the sources engine/own-addresses.ts reads).
    process.env.BEANPOOL_ADDRESSES = 'riverside.example.org';
    forgetOwnAddresses();
    {
        const named = newId('Wren');
        const r = await knock(named, { toNode: 'riverside.example.org' });
        assert(taken(r) && rowsFor(named.pk) === 1, `2a. a knock addressed to the node's name is taken, whatever host it came to (${r.status})`);
        const away = newId('Fen');
        const a = await knock(away, { toNode: 'castlemaine.example.org' });
        assert(refused(a) && rowsFor(away.pk) === 0, `2b. one addressed to another community is refused, nothing written (${a.status})`);
        const loop = newId('Lee');
        const l = await knock(loop, { toNode: 'localhost' });
        assert(refused(l) && rowsFor(loop.pk) === 0, `2c. loopback is no name of a node that has one: refused (${l.status})`);
        const cased = newId('Jo');
        const c = await knock(cased, { toNode: 'Riverside.Example.org.' });
        assert(taken(c), `2d. the name as a host is read (case, a trailing dot) the way signatures read it (${c.status})`);
    }

    // 3. Before anything about the key: a member here, addressed elsewhere, is not told it is a member.
    {
        const before = rowsFor(mia.pk);
        const m = await knock(mia, { toNode: 'castlemaine.example.org' });
        assert(refused(m), `3a. a member's knock addressed to another community gets wrong_community, not already_member (${m.status} ${m.body?.code})`);
        assert(rowsFor(mia.pk) === before, '3b. …and nothing is written');
        const own = await knock(mia, { toNode: 'riverside.example.org' });
        assert(own.status === 409 && own.body?.code === 'already_member', `3c. addressed here, the member hears what it always did (${own.status} ${own.body?.code})`);
    }

    // 4. Not an address at all.
    {
        for (const bad of [42, 'not a host!', 'https://', 'x'.repeat(400)]) {
            const id = newId('Pat');
            const r = await knock(id, { toNode: bad });
            assert(refused(r) && rowsFor(id.pk) === 0, `4. toNode ${JSON.stringify(bad).slice(0, 40)} is refused (${r.status})`);
        }
    }

    delete process.env.BEANPOOL_ADDRESSES;
    forgetOwnAddresses();
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
