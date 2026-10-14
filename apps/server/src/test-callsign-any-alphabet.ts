/**
 * Names in any alphabet, over REAL HTTP (#1956; deciding review of #1951, P1).
 *
 * SQLite's lower() folds A–Z only, while the server folded a typed name with JS toLowerCase(), so a member named
 * "Олег", "Émile" or "İpek", typed exactly as stored, was found by nothing, and the same name in another case read as
 * free. For each name, through the real middleware:
 *   1. joining by an invite keeps the name;
 *   2. the public recovery lookup finds the member typed as stored, in small letters and in capitals;
 *   3. the name check says it is taken, in either case;
 *   4. a recovery collect by the name in small letters opens a session for that member;
 *   5. a second join with the name in another case, and with the exact name, gets a numbered name, never the same one.
 * Plus the fold's own cases (İ/ı/I, final sigma, ß, a combining accent, fullwidth letters).
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-callsign-any-alphabet.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME; // self-signed / LAN mode

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, generateInvite } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
type Id = { pk: string; priv: crypto.KeyObject };
type Res = { status: number; body: any };

function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}

function resetLimits(): void {
    resetGatewayRateLimit();
    resetAdminRateLimit();
    pruneAuthAttempts(Date.now() + 120_000);
}

async function call(method: string, id: Id | null, path: string, body?: unknown): Promise<Res> {
    resetLimits();
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

let founder: Id;

/** Joins by a fresh invite, signed by the joining key, as a phone does. */
async function join(callsign: string): Promise<{ id: Id; res: Res; stored: string | undefined }> {
    const id = keypair();
    const code = generateInvite(founder.pk)!.code;
    const res = await call('POST', id, '/api/invite/redeem', { code, publicKey: id.pk, callsign });
    const stored = (db.prepare('SELECT callsign FROM members WHERE public_key = ?').get(id.pk) as { callsign: string } | undefined)?.callsign;
    return { id, res, stored };
}

const lookup = async (name: string) => call('GET', null, `/api/recovery/lookup/${encodeURIComponent(name)}`);
const available = async (name: string) => call('GET', null, `/api/members/callsign-available/${encodeURIComponent(name)}`);

async function main(): Promise<void> {
    console.log('Names in any alphabet, over real HTTP\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    founder = keypair();
    seedGenesisMember(founder.pk, 'Founder');

    // [the name, typed in small letters, typed in capitals, another case for a second join]
    const cases: Array<[string, string, string, string]> = [
        ['Олег', 'олег', 'ОЛЕГ', 'олег'],
        ['Émile', 'émile', 'ÉMILE', 'émile'],
        ['İpek', 'ipek', 'IPEK', 'Ipek'],
    ];

    for (const [name, small, capitals, other] of cases) {
        console.log(`\n— ${name} —`);
        const first = await join(name);
        assert(first.res.status === 200 && first.stored === name, `${name}: joining by an invite keeps the name (got ${first.res.status}, "${first.stored}")`);
        // The lookup lists a member who can come back with a sign-in, as test-keeper-http seeds one.
        db.prepare(`INSERT INTO recovery_shares (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag, generation)
                    VALUES (?, 'sso', 'google', 1, 'x', 'y', 'z', 1)`).run(first.id.pk);

        for (const typed of [name, small, capitals]) {
            const r = await lookup(typed);
            const keys = Array.isArray(r.body) ? r.body.map((c: any) => c.publicKey) : [];
            assert(r.status === 200 && keys.length === 1 && keys[0] === first.id.pk,
                `${name}: the recovery lookup for "${typed}" finds the member (got ${r.status}, ${keys.length} found)`);
        }
        for (const typed of [small, capitals]) {
            const r = await available(typed);
            assert(r.status === 200 && r.body?.available === false, `${name}: the name check says "${typed}" is taken (got available=${r.body?.available})`);
        }
        const device = keypair();
        const collect = await call('POST', device, '/api/recovery/collect', { callsign: small });
        assert(collect.status === 200 && typeof collect.body?.collectionId === 'string',
            `${name}: a recovery collect for "${small}" opens a session (got ${collect.status} ${JSON.stringify(collect.body?.error ?? '')})`);

        const second = await join(other);
        assert(second.res.status === 200 && second.stored === `${other}2`,
            `${name}: a second join as "${other}" gets "${other}2", not the same name in another case (got ${second.res.status}, "${second.stored}")`);
        const exact = await join(name);
        assert(exact.res.status === 200 && exact.stored === `${name}3`,
            `${name}: a third join as exactly "${name}" gets "${name}3" (got ${exact.res.status}, "${exact.stored}")`);
    }

    console.log('\n— one name, typed several ways —');
    const sameName: Array<[string, string, string]> = [
        ['Οδυσσεύς', 'ΟΔΥΣΣΕΎΣ', 'Greek final sigma'],
        ['Straße', 'STRASSE', 'German ß'],
        ['René', 'René', 'an accent typed as a combining mark'],
        ['Ｋｏｈａｎａ', 'Kohana', 'fullwidth letters'],
        ['ıpek-x', 'IPEK-X', 'Turkish dotless ı'],
    ];
    for (const [stored, typed, why] of sameName) {
        const j = await join(stored);
        const r = await available(typed);
        assert(j.res.status === 200 && r.body?.available === false, `${why}: "${stored}" is taken when "${typed}" is checked (got available=${r.body?.available})`);
    }
    const differs = await available('Emile');
    assert(differs.body?.available === true, 'accents are kept: "Emile" is free beside "Émile"');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Names in any alphabet PASSED.');
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
