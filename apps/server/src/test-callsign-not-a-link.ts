/**
 * A name that is an invite or a web address is refused by the node, over REAL HTTP (Marty, 14 Nov 2026, card
 * callsign-link-guard: on 5 Sep a member pasted her invite link into the name box, and her account on Byron is named
 * "https://mullum.beanpool.org/?inv"). Through the real middleware, every route that writes a name:
 *   1. POST /api/invite/redeem: her link, an invite code and a bare community address as the name are 400
 *      `callsign_link` with the one line, no member is written and the code stays unused; a name joins with that code;
 *   2. POST /api/community/register: a member re-registering under a link is 400 `callsign_link`, name unchanged;
 *   3. POST /api/profile/update: a rename to a web address is 400 `callsign_link`, name unchanged; a member whose name
 *      already is a link (hers, written as it was) still saves a bio with it, and keeps it (no conversion code);
 *   4. POST /api/join (the open door, words and sign-in): 400 `callsign_link` before any work or sign-in is read, and
 *      POST /api/join/knock (asking to join: a yes joins under that name) the same, no request kept;
 *   5. POST /api/local/update-identity: the node's own name as a link is 400 `callsign_link`, nothing stored.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-callsign-not-a-link.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME; // self-signed / LAN mode
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { NAME_BOX_WORDS, solveDoorWorkSync } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, generateInvite } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { getLocalConfig } from './config/local-config.js';
import { db } from './db/db.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

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

async function call(method: string, id: Id | null, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    resetGatewayRateLimit();
    resetAdminRateLimit();
    pruneAuthAttempts(Date.now() + 120_000);
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { ...extra };
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = signRequest(id.priv, { method, path: path.split('?')[0], timestamp: ts, nonce, body: bodyString });
        headers[SIGNED_FOR_HEADER] = signedForHost();
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

const nameOf = (pk: string) => (db.prepare('SELECT callsign FROM members WHERE public_key = ?').get(pk) as { callsign: string } | undefined)?.callsign;
const codeUsedBy = (code: string) => (db.prepare('SELECT used_by FROM invite_codes WHERE code = ?').get(code) as { used_by: string | null } | undefined)?.used_by ?? null;
const refusedAs = (r: Res, line: string) => r.status === 400 && r.body?.code === 'callsign_link' && (r.body?.error === line || r.body?.message === line);

// What her name box held, whole, and what the 32-character profile box kept of it (her name on Byron).
const HER_LINK = 'https://mullum.beanpool.org/?invite=INV-K7Q2-BSXA';
const HER_NAME = HER_LINK.slice(0, 32);

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    const founder = keypair();
    seedGenesisMember(founder.pk, 'Founder');

    console.log('── 1. joining by an invite ──');
    const code = generateInvite(founder.pk)!.code;
    for (const [name, line] of [
        [HER_LINK, NAME_BOX_WORDS.inviteLink],
        [HER_LINK.slice(0, 20), NAME_BOX_WORDS.webLink],
        ['INV-K7Q2-BSXA', NAME_BOX_WORDS.inviteCode],
        ['byron.beanpool.org', NAME_BOX_WORDS.webLink],
    ] as const) {
        const joiner = keypair();
        const r = await call('POST', joiner, '/api/invite/redeem', { code, publicKey: joiner.pk, callsign: name });
        assert(refusedAs(r, line), `redeem with ${JSON.stringify(name)} as the name: 400 callsign_link, "${line}" (got ${r.status} ${JSON.stringify(r.body)})`);
        assert(nameOf(joiner.pk) === undefined, `  and no member is written for ${JSON.stringify(name)}`);
    }
    assert(codeUsedBy(code) === null, 'the invite stays unused after every refusal');
    const dee = keypair();
    const joined = await call('POST', dee, '/api/invite/redeem', { code, publicKey: dee.pk, callsign: 'Dee Dee' });
    assert(joined.status === 200 && nameOf(dee.pk) === 'Dee Dee', `the same invite joins with a name (got ${joined.status} ${nameOf(dee.pk)})`);
    const dotted = keypair();
    const dottedJoin = await call('POST', dotted, '/api/invite/redeem', { code: generateInvite(founder.pk)!.code, publicKey: dotted.pk, callsign: 'J.R. St.Kilda' });
    assert(dottedJoin.status === 200 && nameOf(dotted.pk) === 'J.R. St.Kilda', `a name with dots in it joins (got ${dottedJoin.status})`);

    console.log('\n── 2. re-registering ──');
    const reReg = await call('POST', dee, '/api/community/register', { publicKey: dee.pk, callsign: 'www.deedee.com' });
    assert(refusedAs(reReg, NAME_BOX_WORDS.webLink), `re-register as www.deedee.com: 400 callsign_link (got ${reReg.status} ${JSON.stringify(reReg.body)})`);
    assert(nameOf(dee.pk) === 'Dee Dee', 'and the name is unchanged');

    console.log('\n── 3. the profile ──');
    const rename = await call('POST', dee, '/api/profile/update', { callsign: 'https://example.org/me' });
    assert(refusedAs(rename, NAME_BOX_WORDS.webLink), `a rename to a web address: 400 callsign_link (got ${rename.status} ${JSON.stringify(rename.body)})`);
    // As this route's other name refusals answer (callsign_taken, callsign_too_short): the code in `error`, the line in
    // `message`. The phone reads `error` to drop a waiting name for good (apps/native/utils/pending-profile-sync.ts
    // nameRefusedForGood): a sentence there kept a copied link name, and the photo with it, resent at every sync.
    assert(rename.body?.error === 'callsign_link' && rename.body?.message === NAME_BOX_WORDS.webLink,
        `the profile route's refusal has error "callsign_link" and the line in message (got ${JSON.stringify(rename.body)})`);
    const renameInvite = await call('POST', dee, '/api/profile/update', { callsign: HER_LINK });
    assert(refusedAs(renameInvite, NAME_BOX_WORDS.inviteLink), `a rename to her invite link, read whole before the 32-character cut, says invite link (got ${renameInvite.status} ${JSON.stringify(renameInvite.body)})`);
    assert(nameOf(dee.pk) === 'Dee Dee', 'and the name is unchanged');
    const renamed = await call('POST', dee, '/api/profile/update', { callsign: 'Dee' });
    assert(renamed.status === 200 && nameOf(dee.pk) === 'Dee', `a rename to a name still saves (got ${renamed.status})`);
    // Her account as it is on Byron: the name is kept, and a save of something else that sends it back still saves.
    db.prepare('UPDATE members SET callsign = ? WHERE public_key = ?').run(HER_NAME, dee.pk);
    const bio = await call('POST', dee, '/api/profile/update', { callsign: HER_NAME, bio: 'Hello' });
    assert(bio.status === 200 && nameOf(dee.pk) === HER_NAME, `the name she already has is never refused: a bio save with it answers 200 and keeps it (got ${bio.status} ${JSON.stringify(bio.body)})`);
    // Register cuts a name to 20, and a cut name used to rename her to it ("https://mullum.beanp"): now refused, name kept.
    const reEnter = await call('POST', dee, '/api/community/register', { publicKey: dee.pk, callsign: HER_NAME });
    assert(refusedAs(reEnter, NAME_BOX_WORDS.webLink) && nameOf(dee.pk) === HER_NAME,
        `re-registering with her name, which register cuts to 20, is refused and her name kept (got ${reEnter.status} ${nameOf(dee.pk)})`);
    // A link name that fits register's 20 (what a redeem would have stored) is sent back unchanged: 200, kept.
    const SHORT = HER_LINK.slice(0, 20);
    db.prepare('UPDATE members SET callsign = ? WHERE public_key = ?').run(SHORT, dee.pk);
    const reEnterShort = await call('POST', dee, '/api/community/register', { publicKey: dee.pk, callsign: SHORT });
    assert(reEnterShort.status === 200 && nameOf(dee.pk) === SHORT, `re-registering with a kept link name unchanged answers 200 and keeps it (got ${reEnterShort.status})`);

    console.log('\n── 4. the open door ──');
    process.env.NODE_PROFILE = 'global';
    const walker = keypair();
    const words = await call('POST', walker, '/api/join', { door: 'words', callsign: HER_LINK, work: {} });
    assert(refusedAs(words, NAME_BOX_WORDS.inviteLink), `the 12-words door: 400 callsign_link before the work is read (got ${words.status} ${JSON.stringify(words.body)})`);
    const signIn = await call('POST', walker, '/api/join', { callsign: 'INV-K7Q2-BSXA', provider: 'google', idToken: 'not-read', nonce: 'not-read' });
    assert(refusedAs(signIn, NAME_BOX_WORDS.inviteCode), `the sign-in door: 400 callsign_link before the sign-in is read (got ${signIn.status} ${JSON.stringify(signIn.body)})`);
    assert(nameOf(walker.pk) === undefined, 'and nobody joined');
    // The door keeps 20 characters, and "x.comet" cut there is "x.com": the engine refuses the cut name, after the work,
    // as 400 callsign_link, never the 503 "try again" that would be refused the same way.
    const cutter = keypair();
    const handed = await call('POST', cutter, '/api/join/work', { door: 'words' });
    const challenge = String(handed.body?.work?.challenge ?? '');
    const cut = await call('POST', cutter, '/api/join', { door: 'words', callsign: 'Rowan at Byron x.comet', work: { challenge, counters: solveDoorWorkSync(challenge) } });
    assert(refusedAs(cut, NAME_BOX_WORDS.webLink) && nameOf(cutter.pk) === undefined,
        `a name that is an address only once the door cuts it: 400 callsign_link, nobody joined (got ${cut.status} ${JSON.stringify(cut.body)})`);
    delete process.env.NODE_PROFILE;

    console.log('\n── 4b. asking to join ──');
    const knocker = keypair();
    const knock = await call('POST', knocker, '/api/join/knock', { callsign: HER_LINK, message: 'Hello, I live nearby.' });
    assert(refusedAs(knock, NAME_BOX_WORDS.inviteLink), `a knock under her link: 400 callsign_link (got ${knock.status} ${JSON.stringify(knock.body)})`);
    const knocked = (db.prepare('SELECT COUNT(*) AS n FROM join_requests WHERE pubkey = ?').get(knocker.pk) as { n: number }).n;
    assert(knocked === 0, 'and no request to join is kept');
    const named = await call('POST', knocker, '/api/join/knock', { callsign: 'Dee Dee', message: 'Hello, I live nearby.' });
    assert(named.status === 201, `a knock under a name is taken (got ${named.status} ${JSON.stringify(named.body)})`);

    console.log('\n── 5. the node\'s own name ──');
    const { ownerSessionHeaders } = await import('./admin-auth-test-harness.js');
    const before = getLocalConfig().callsign;
    const identity = await call('POST', null, '/api/local/update-identity', { callsign: 'http://192.168.1.20' }, ownerSessionHeaders(founder.pk));
    assert(refusedAs(identity, NAME_BOX_WORDS.webLink), `update-identity with a link as the callsign: 400 callsign_link (got ${identity.status} ${JSON.stringify(identity.body)})`);
    assert(getLocalConfig().callsign === before, 'and nothing is stored');
    const nodeNamed = await call('POST', null, '/api/local/update-identity', { callsign: 'Mullum' }, ownerSessionHeaders(founder.pk));
    assert(nodeNamed.status === 200 && getLocalConfig().callsign === 'Mullum', `a name is stored (got ${nodeNamed.status})`);

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
