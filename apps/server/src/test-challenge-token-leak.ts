/**
 * The key sign-in challenge never hands the sign-in token to someone who only knows the challenge id.
 *
 * Fable's review of #974 (Optional 5a): GET /api/local/admin/auth/challenge/:id returned the 60 s handshake
 * token once an admin had signed the challenge, so whoever saw the id (a QR photo, a shoulder-surfer, a log
 * line) could redeem it before the real browser and get an owner's /settings session. Over REAL HTTPS:
 *
 *   1. Knowing the id alone gives no token, no signer and no role — pending or resolved.
 *   2. The legitimate flow still signs in: the phone that proved the key gets the token from verify-challenge
 *      and the page redeems it once at /exchange.
 *   3. Replay is refused: a second exchange of the token, and a second solve of the same challenge.
 *
 * Local only — it talks to the server it starts on localhost and nothing else.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-challenge-token-leak.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, grantNodeRole } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { updateLocalConfig } from './config/local-config.js';

const PORT = 8696;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

interface Identity { pub: string; priv: crypto.KeyObject }
function keypair(): Identity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}
const signText = (who: Identity, text: string) => crypto.sign(null, Buffer.from(text), who.priv).toString('base64');

function seedMember(pk: string, callsign: string) {
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(pk, callsign);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text, headers: res.headers };
}

async function main() {
    console.log('Running challenge token leak tests (real HTTPS)...\n');
    await initTls();
    initStateEngine();

    const owner = keypair();
    seedMember(owner.pub, 'leakOwner');
    grantNodeRole(owner.pub, 'owner', 'SYSTEM');
    updateLocalConfig({ totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [], breakGlassMode: false } as any);

    await startHttpsServer(PORT);

    // The phone asks for a challenge. From here on the attacker knows its id.
    const chal = await call('POST', '/api/local/admin/auth/challenge', {});
    assert(chal.status === 200 && typeof chal.body.challengeId === 'string', 'a challenge is issued');
    const id: string = chal.body.challengeId;

    console.log('\n1. Knowing the challenge id alone');
    {
        const pending = await call('GET', `/api/local/admin/auth/challenge/${id}`);
        assert(pending.status === 200 && pending.body.status === 'pending', 'before signing, the id shows pending');
        assert(!('handshakeToken' in (pending.body || {})), 'and no token');
    }

    // The owner's phone signs it and gets the token back, as the app's Manage button does.
    const solved = await call('POST', '/api/local/admin/auth/verify-challenge', {
        challengeId: id,
        memberPubkey: owner.pub,
        signature: signText(owner, chal.body.challenge),
    });
    assert(solved.status === 200 && typeof solved.body.handshakeToken === 'string', 'the signer gets the token from verify-challenge');
    const token: string = solved.body.handshakeToken;

    {
        const resolved = await call('GET', `/api/local/admin/auth/challenge/${id}`);
        assert(resolved.status === 200 && resolved.body.status === 'resolved', 'after signing, the id shows resolved');
        assert(!('handshakeToken' in (resolved.body || {})), 'the resolved challenge carries no handshakeToken field');
        assert(!resolved.text.includes(token), 'the token appears nowhere in the response');
        assert(!resolved.text.includes(owner.pub), "nor does the signer's key");
        assert(!('role' in (resolved.body || {})), 'nor the role');
    }

    console.log('\n2. The legitimate flow still signs in');
    {
        const ex = await call('POST', '/api/local/admin/auth/exchange', { token });
        assert(ex.status === 200 && ex.body.success === true, "the signer's token redeems once at /exchange");
        assert(ex.body.memberPubkey === owner.pub && ex.body.role === 'owner', 'as the owner, by key');
        const cookie = ex.headers.get('set-cookie') || '';
        const sid = cookie.match(/admin_session=([0-9a-f]+)/)?.[1];
        assert(!!sid, 'and sets the session cookie');
        const session = await fetch(`${BASE}/api/local/admin/auth/session`, { headers: { Cookie: `admin_session=${sid}` } });
        const sessionBody: any = await session.json();
        assert(sessionBody.authenticated === true && sessionBody.memberPubkey === owner.pub, 'the session is live and names the owner');
    }

    console.log('\n3. Replay');
    {
        const again = await call('POST', '/api/local/admin/auth/exchange', { token });
        assert(again.status === 401 && again.body.replay === true, 'the token cannot be redeemed twice');
        const resolveAgain = await call('POST', '/api/local/admin/auth/verify-challenge', {
            challengeId: id,
            memberPubkey: owner.pub,
            signature: signText(owner, chal.body.challenge),
        });
        assert(resolveAgain.status !== 200 && !resolveAgain.body?.handshakeToken, 'the same signed challenge cannot mint a second token');
        const stillNothing = await call('GET', `/api/local/admin/auth/challenge/${id}`);
        assert(!stillNothing.text.includes(token), 'the id still reveals no token after use');
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
