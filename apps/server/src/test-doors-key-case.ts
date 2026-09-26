/**
 * Every door reads a key in one spelling (engine/member-key.ts): an existing member's key in capitals can't make a
 * second member row.
 *
 * A member's key is kept as 64 hexadecimal characters in lower case. The node's hex decoder forgives case and stops at
 * the first character that isn't hex, while every lookup on members.public_key is case-sensitive, so each spelling of
 * one key was a different key here: an unsigned invite redeem naming a member's key in capitals made a second member
 * row for it, under a name the caller picked, and the key's holder could sign as that spelling and act, and vote, as a
 * second member. #1182's confirmation 3b found it. Every request goes over HTTP through the real signature middleware,
 * or over /ws, unless a section says it calls a function (the federation paths arrive from a peer, not over HTTP).
 *
 *  1. The invite redeem and the offline ticket (unsigned, the key named in the body): a member's key, a visitor's and a
 *     new key, each in capitals, in mixed case, with 0x before it, and 63 and 65 characters long, are refused 400
 *     bad_key; nothing is written and the code or the ticket stays unused. Named in capitals by a request another key
 *     signed, the same. The one spelling still joins; a key in capitals that the request's own signature proves joins
 *     under the one spelling.
 *  2. The doors the signature middleware sees (knocks, the open door, re-keying, recovery, re-registering, invites, a
 *     send, a DM): signed as 0x…, as 63 or 65 characters or with …zz after the key (which the decoder reads as the key),
 *     by a member, a visitor and a new key: 400 bad_key before any route, and nothing written. /ws refuses the same.
 *  3. Signed in capitals or mixed case (the signature proves the key): the signer IS that key, in the one spelling. A
 *     member makes an invite and sends Beans as themselves, a new key's and a visitor's knock is kept under the one
 *     spelling, a member's knock is a member's, a /ws socket gets the member's messages, and a body naming the signer in
 *     capitals is refused 400 bad_key. A re-key to a new key in capitals is refused; in the one spelling it binds.
 *  4. Keys named by someone else: a send, a DM, a node role (grant and enrol), a peer's listing author and a peer's
 *     cross-node buyer, each a member's key, a visitor's and a new key in the other spellings: refused, nothing written.
 *     The one spelling still works.
 *  5. Rows made before this rule: a boot check lists each person's row stored under another spelling, and changes
 *     nothing. Such a row signs in to Settings with no role it holds, names no admin, is re-keyed and offboarded by
 *     nobody (which would have acted on the member whose key it is), and once an operator removes it the member whose
 *     key it is still acts and keeps what they wrote when they knocked.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-doors-key-case.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
process.env.ADMIN_PASSWORD = 'DoorsKeyCase123!';

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import {
    initStateEngine, transfer, seedGenesisMember, createPost, acceptPost, completePostTransaction, generateInvite,
    getBalance, assertMemberActive,
} from './state-engine.js';
import { issueRekeyCode, getOffboardPreview, executeOffboard } from './engine/member-wizards.js';
import { adminActorName } from './engine/admin-actor-name.js';
import { authorizeKeySigner } from './admin-key-auth.js';
import { cacheRemoteListings } from './federation-listings.js';
import { handlePurchaseRequest } from './federation-settlement-exchange.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const ADMIN_PW = 'DoorsKeyCase123!';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

function makeMember(name: string, beans = 100): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_url, status)
                VALUES (?, ?, ?, 'genesis', 'TEST', ?, 'active')`).run(id.pk, name, ago(30 * DAY), AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    if (beans > 0) transfer('genesis', id.pk, beans, `seed ${name}`, 'direct', true);
    return id;
}

/** The spellings of a key the doors must refuse when someone names it: none of them is the one spelling. */
function namedSpellings(pk: string): Array<[string, string]> {
    return [
        ['in capitals', pk.toUpperCase()],
        ['in mixed case', [...pk].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('')],
        ['with 0x before it', `0x${pk}`],
        ['63 characters long', pk.slice(0, 63)],
        ['65 characters long', `${pk}0`],
    ];
}

/** The spellings a signer can send that the hex decoder reads as some other key, or as its own: all refused. */
function badSignerSpellings(pk: string): Array<[string, string]> {
    return [
        ['0x before the key', `0x${pk}`],
        ['63 characters', pk.slice(0, 63)],
        ['65 characters (a 65th hex digit, which the decoder drops)', `${pk}0`],
        ['…zz after the key (which the decoder skips)', `${pk}zz`],
    ];
}

/** The limits a sweep of refusals would otherwise run into (as test-visitors-cant-act's resetLimits). */
function resetLimits(): void {
    resetGatewayRateLimit();
    resetAdminRateLimit();
    resetAdminAuthTarpit();
    pruneAuthAttempts(Date.now() + 120_000);
    db.prepare('UPDATE join_requests SET ip_hash = NULL').run();
}

/** A request, signed by `id` with `as` in X-Public-Key (its own key by default), or unsigned. */
async function call(method: string, id: Id | null, path: string, body?: unknown, as?: string, extra: Record<string, string> = {}): Promise<Res> {
    resetLimits();
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { ...extra };
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = as ?? id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}
const admin = (method: string, path: string, body?: unknown) => call(method, null, path, body, undefined, { 'X-Admin-Password': ADMIN_PW });

/** A /ws socket signed by `id` as `as`, and everything it is sent; rejects when the upgrade is refused. */
type Sock = { ws: WebSocket; events: any[] };
function socket(id: Id, as?: string): Promise<Sock> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.priv).toString('base64');
    const url = `${BASE.replace('https', 'wss')}/ws?pubkey=${encodeURIComponent(as ?? id.pk)}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const s: Sock = { ws, events: [] };
        ws.on('message', d => { try { s.events.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', () => resolve(s));
        ws.on('error', reject);
    });
}
const settle = (ms = 200) => new Promise(r => setTimeout(r, ms));

/**
 * The whole database, table by table, so a refusal can say which table changed. A signed write stamps its signer's
 * members.last_active_at before any route runs, whatever the route answers, so that column is left out, as is the
 * minute tick's event_reminders_sent. `except` leaves out tables a caller's own authentication writes (the admin log).
 */
function snapshot(except: string[] = []): Map<string, string> {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'event_reminders_sent' ORDER BY name").all() as { name: string }[];
    const out = new Map<string, string>();
    for (const { name } of tables) {
        if (except.includes(name)) continue;
        const h = crypto.createHash('sha256');
        for (const row of db.prepare(`SELECT * FROM "${name}"`).iterate() as Iterable<Record<string, unknown>>) {
            if (name === 'members') delete row.last_active_at;
            h.update(JSON.stringify(row));
        }
        out.set(name, h.digest('hex'));
    }
    return out;
}
const changedTables = (a: Map<string, string>, b: Map<string, string>) =>
    [...new Set([...a.keys(), ...b.keys()])].filter(t => a.get(t) !== b.get(t));

const rowsFor = (pk: string) => db.prepare('SELECT public_key, callsign, is_visitor, status FROM members WHERE lower(public_key) LIKE ?').all(`${pk.slice(0, 63).toLowerCase()}%`) as any[];
const hasRow = (pk: string) => !!db.prepare('SELECT 1 FROM members WHERE public_key = ?').get(pk);
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body ?? null).slice(0, 120)}`;
const isBadKey = (r: Res) => r.status === 400 && r.body?.code === 'bad_key' && typeof r.body?.error === 'string' && r.body.error.length > 20;

function offlineTicket(inviter: Id): string {
    const payload = JSON.stringify({ i: inviter.pk, t: Date.now(), n: crypto.randomBytes(4).toString('hex') });
    return Buffer.from(JSON.stringify({ p: payload, s: crypto.sign(null, Buffer.from(payload), inviter.priv).toString('base64') })).toString('base64');
}
const ticketCode = (ticket: string) => {
    const { s } = JSON.parse(Buffer.from(ticket, 'base64').toString('utf8'));
    return crypto.createHash('sha256').update(s).digest('hex').substring(0, 16);
};

async function main(): Promise<void> {
    console.log('Every door reads a key in one spelling\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    const memberKey = await import('./engine/member-key.js').catch(() => null) as
        { reportMisspeltMemberKeys(log?: (line: string) => void): Array<{ publicKey: string; sameKeyAs: string | null; nodeRole: string | null }> } | null;

    const founder = keypair('Founder');
    seedGenesisMember(founder.pk, founder.name);
    const alice = makeMember('Alice');
    const bob = makeMember('Bob');
    const offer = (m: Id, t: string) => createPost('offer', 'produce', t, `${t}, fresh`, 5, 'fixed', m.pk)!;
    offer(alice, 'Alice seedlings'); offer(bob, 'Bob seedlings');
    // A completed trade each, so both may send Beans (the send gate).
    completePostTransaction(acceptPost(offer(bob, 'Bob eggs').id, alice.pk).id, alice.pk);
    completePostTransaction(acceptPost(offer(alice, 'Alice jam').id, bob.pk).id, bob.pk);
    // Vera: a visitor's row, made by a member's DM.
    const vera = keypair('Vera');
    const veraDm = await call('POST', alice, '/api/messages/conversation', { type: 'dm', participants: [alice.pk, vera.pk], createdBy: alice.pk });
    assert(veraDm.status === 200 && rowsFor(vera.pk).length === 1 && rowsFor(vera.pk)[0].is_visitor === 1, `setup: Alice's DM makes Vera a visitor's row (${show(veraDm)})`);
    const nia = keypair('Nia');   // a new key: no row here

    // ── 1. The invite redeem and the offline ticket: a key named in the body ──
    console.log('\n── 1. the invite redeem and the offline ticket take a named key only in the one spelling ──');
    const targets: Array<[string, Id]> = [['member Bob', bob], ['visitor Vera', vera], ['new key Nia', nia]];
    const code = generateInvite(alice.pk)!.code;
    const ticket = offlineTicket(alice);
    for (const [who, id] of targets) {
        for (const [how, spelt] of namedSpellings(id.pk)) {
            const before = snapshot();
            const r = await call('POST', null, '/api/invite/redeem', { code, publicKey: spelt, callsign: 'Official Admin' });
            const t = await call('POST', null, '/api/invite/redeem-offline', { ticketB64: ticket, publicKey: spelt, callsign: 'Official Admin' });
            const changed = changedTables(before, snapshot());
            assert(isBadKey(r) && isBadKey(t) && changed.length === 0,
                `${who}'s key ${how}, unsigned: the redeem and the offline ticket are refused 400 bad_key and nothing is written (${show(r)}; ${show(t)}; changed: ${changed.join(', ') || 'nothing'})`);
        }
    }
    const bobCaps = bob.pk.toUpperCase();
    {
        const before = snapshot();
        const r = await call('POST', alice, '/api/invite/redeem', { code, publicKey: bobCaps, callsign: 'Official Admin' });
        const t = await call('POST', alice, '/api/invite/redeem-offline', { ticketB64: ticket, publicKey: bobCaps, callsign: 'Official Admin' });
        assert(isBadKey(r) && isBadKey(t) && changedTables(before, snapshot()).length === 0,
            `Bob's key in capitals, named in a redeem Alice signed: refused 400 bad_key, nothing written (${show(r)}; ${show(t)})`);
    }
    const codeRow = () => db.prepare('SELECT used_by FROM invite_codes WHERE code = ?').get(code) as { used_by: string | null } | undefined;
    assert(codeRow()?.used_by == null && !db.prepare('SELECT 1 FROM invite_codes WHERE code = ?').get(ticketCode(ticket)),
        'the invite code is still unused, and the offline ticket was never recorded');
    assert(rowsFor(bob.pk).length === 1 && rowsFor(vera.pk).length === 1 && rowsFor(nia.pk).length === 0,
        `still one row for Bob's key, one for Vera's, none for Nia's (${rowsFor(bob.pk).length}/${rowsFor(vera.pk).length}/${rowsFor(nia.pk).length})`);

    const niaJoin = await call('POST', null, '/api/invite/redeem', { code, publicKey: nia.pk, callsign: 'Nia' });
    assert(niaJoin.status === 200 && niaJoin.body?.member?.publicKey === nia.pk && codeRow()?.used_by === nia.pk,
        `the one spelling still joins: Nia is a member and the code is used by her key (${show(niaJoin)})`);
    const bobAgain = await call('POST', null, '/api/invite/redeem', { code: generateInvite(alice.pk)!.code, publicKey: bob.pk, callsign: 'Bob' });
    assert(bobAgain.status === 200 && bobAgain.body?.alreadyMember === true && rowsFor(bob.pk).length === 1,
        `Bob's key in the one spelling is answered "already a member", as before (${show(bobAgain)})`);
    const nora = keypair('Nora');
    const noraTicket = offlineTicket(alice);
    const noraJoin = await call('POST', null, '/api/invite/redeem-offline', { ticketB64: noraTicket, publicKey: nora.pk, callsign: 'Nora' });
    assert(noraJoin.status === 200 && hasRow(nora.pk)
        && (db.prepare('SELECT used_by FROM invite_codes WHERE code = ?').get(ticketCode(noraTicket)) as any)?.used_by === nora.pk,
        `the one spelling still joins with an offline ticket (${show(noraJoin)})`);
    const veraJoin = await call('POST', vera, '/api/invite/redeem', { code: generateInvite(alice.pk)!.code, publicKey: vera.pk, callsign: 'Vera' });
    assert(veraJoin.status === 200 && rowsFor(vera.pk).length === 1 && rowsFor(vera.pk)[0].is_visitor === 0,
        `a visitor's own signed redeem in the one spelling makes her row a member's, still one row (${show(veraJoin)})`);

    const ola = keypair('Ola');   // a new key whose own signature proves it, named in capitals
    const olaCode = generateInvite(alice.pk)!.code;
    const olaJoin = await call('POST', ola, '/api/invite/redeem', { code: olaCode, publicKey: ola.pk.toUpperCase(), callsign: 'Ola' }, ola.pk.toUpperCase());
    assert(olaJoin.status === 200 && olaJoin.body?.member?.publicKey === ola.pk && hasRow(ola.pk) && !hasRow(ola.pk.toUpperCase())
        && (db.prepare('SELECT used_by FROM invite_codes WHERE code = ?').get(olaCode) as any)?.used_by === ola.pk,
        `a redeem naming a new key in capitals, signed by that key: it joins under the one spelling, and nothing under capitals (${show(olaJoin)})`);
    const pim = keypair('Pim');
    const pimTicket = offlineTicket(alice);
    const pimJoin = await call('POST', pim, '/api/invite/redeem-offline', { ticketB64: pimTicket, publicKey: pim.pk.toUpperCase(), callsign: 'Pim' }, pim.pk.toUpperCase());
    assert(pimJoin.status === 200 && hasRow(pim.pk) && !hasRow(pim.pk.toUpperCase()),
        `the same with an offline ticket (${show(pimJoin)})`);

    // ── 2. The doors the signature middleware sees: a signer spelt so the decoder reads some other key ──
    console.log('\n── 2. a signer spelt as anything but 64 hex characters is refused before any door ──');
    const quinn = keypair('Quinn');   // a new key for this section
    const signers: Array<[string, Id]> = [['member Bob', bob], ['visitor-turned-member Vera', vera], ['new key Quinn', quinn]];
    // Vera is a member now (section 1); a visitor's row for this sweep:
    const wes = keypair('Wes');
    await call('POST', alice, '/api/messages/conversation', { type: 'dm', participants: [alice.pk, wes.pk], createdBy: alice.pk });
    assert(rowsFor(wes.pk)[0]?.is_visitor === 1, 'setup: Wes is a visitor\'s row');
    signers.push(['visitor Wes', wes]);
    const doors = (spelt: string): Array<[string, string, unknown]> => [
        ['POST', '/api/join/knock', { callsign: 'Knocker', message: 'Hello, I live nearby and would like to join.', fromNode: 'https://global.beanpool.org/' }],
        ['POST', '/api/join/sso-nonce', {}],
        ['POST', '/api/join', { callsign: 'Joiner', provider: 'google', idToken: 'x', nonce: 'x' }],
        ['POST', '/api/member/re-enroll', { code: 'ABCD-EFGH', newPublicKey: spelt, signature: 'x' }],
        ['POST', '/api/recovery/collect', { callsign: 'bob' }],
        ['POST', '/api/recovery/shares/status', {}],
        ['POST', '/api/community/register', { publicKey: spelt, callsign: 'Official Admin' }],
        ['POST', '/api/invite/generate', { publicKey: spelt }],
        ['POST', '/api/ledger/transfer', { to: alice.pk, amount: 1, memo: 'hi' }],
        ['POST', '/api/messages/conversation', { type: 'dm', participants: [spelt, alice.pk], createdBy: spelt }],
        ['POST', `/api/commons/decisions/nope/vote`, { support: true }],
    ];
    for (const [who, id] of signers) {
        for (const [how, spelt] of badSignerSpellings(id.pk)) {
            const before = snapshot();
            const answers: string[] = [];
            let allBad = true;
            for (const [method, path, body] of doors(spelt)) {
                const r = await call(method, id, path, body, spelt);
                if (!isBadKey(r)) { allBad = false; answers.push(`${path} → ${show(r)}`); }
            }
            const changed = changedTables(before, snapshot());
            assert(allBad && changed.length === 0,
                `${who} signing with ${how}: every door (knock, open door, re-key, recovery, register, invite, send, DM, vote) is refused 400 bad_key and nothing is written${answers.length ? ` — ${answers.join('; ')}` : ''}${changed.length ? ` (changed: ${changed.join(', ')})` : ''}`);
        }
    }
    assert(!hasRow(quinn.pk) && rowsFor(quinn.pk).length === 0 && !db.prepare('SELECT 1 FROM join_requests WHERE lower(pubkey) LIKE ?').get(`${quinn.pk.slice(0, 60)}%`),
        'Quinn has no row and no knock under any spelling');
    for (const [how, spelt] of badSignerSpellings(bob.pk)) {
        let refused = false;
        try { const s = await socket(bob, spelt); s.ws.close(); } catch { refused = true; }
        assert(refused, `/ws signed by Bob with ${how}: the upgrade is refused`);
    }

    // ── 3. Signed in capitals: the signer IS the key, in the one spelling ──
    console.log('\n── 3. a signer in capitals or mixed case is that key, in the one spelling ──');
    for (const [how, spelt] of [['capitals', bobCaps], ['mixed case', namedSpellings(bob.pk)[1][1]]] as const) {
        const inv = await call('POST', bob, '/api/invite/generate', { publicKey: bob.pk }, spelt);
        assert(inv.status === 200 && inv.body?.invite?.createdBy === bob.pk,
            `Bob signing in ${how} makes an invite as Bob, under his key in the one spelling (${show(inv)})`);
        const before = snapshot();
        const caps = await call('POST', bob, '/api/invite/generate', { publicKey: spelt }, spelt);
        assert(isBadKey(caps) && changedTables(before, snapshot()).length === 0,
            `…and a body naming him in ${how} is refused 400 bad_key, no invite written (${show(caps)})`);
    }
    const aliceBefore = getBalance(alice.pk).balance, bobBefore = getBalance(bob.pk).balance;
    const send = await call('POST', alice, '/api/ledger/transfer', { to: bob.pk, amount: 2, memo: 'for Bob' }, alice.pk.toUpperCase());
    assert(send.status === 200 && getBalance(alice.pk).balance === aliceBefore - 2 && getBalance(bob.pk).balance === bobBefore + 2 && !hasRow(alice.pk.toUpperCase()),
        `Alice signing in capitals sends 2 Beans from her own account to Bob's (${show(send)}; ${aliceBefore}→${getBalance(alice.pk).balance})`);

    const kit = keypair('Kit');
    const kitKnock = await call('POST', kit, '/api/join/knock', { callsign: 'Kit', message: 'Hello, I live nearby and would like to join.', fromNode: 'https://global.beanpool.org/' }, kit.pk.toUpperCase());
    const kitRows = db.prepare('SELECT pubkey FROM join_requests WHERE lower(pubkey) = ?').all(kit.pk) as { pubkey: string }[];
    assert(kitKnock.status === 201 && kitRows.length === 1 && kitRows[0].pubkey === kit.pk,
        `a new key knocking signed in capitals: one knock, kept under the one spelling (${show(kitKnock)})`);
    const kitStatus = await call('GET', kit, '/api/join/knock/status');
    assert(kitStatus.status === 200 && kitStatus.body?.status === 'pending', `…which the key reads in the one spelling (${show(kitStatus)})`);
    const wesKnock = await call('POST', wes, '/api/join/knock', { callsign: 'Wes', message: 'Hello, I live nearby and would like to join.', fromNode: 'https://global.beanpool.org/' }, namedSpellings(wes.pk)[1][1]);
    const wesRows = db.prepare('SELECT pubkey FROM join_requests WHERE lower(pubkey) = ?').all(wes.pk) as { pubkey: string }[];
    assert(wesKnock.status === 201 && wesRows.length === 1 && wesRows[0].pubkey === wes.pk,
        `a visitor knocking signed in mixed case: one knock, under the one spelling (${show(wesKnock)})`);
    const bobKnockLower = await call('POST', bob, '/api/join/knock', { callsign: 'Bob', message: 'Hello, I live nearby and would like to join.', fromNode: 'https://global.beanpool.org/' });
    const bobKnockCaps = await call('POST', bob, '/api/join/knock', { callsign: 'Bob', message: 'Hello, I live nearby and would like to join.', fromNode: 'https://global.beanpool.org/' }, bobCaps);
    assert(bobKnockCaps.status === 409 && bobKnockCaps.body?.code === 'already_member' && bobKnockLower.status === bobKnockCaps.status,
        `a member knocking signed in capitals is that member: 409 already_member, as in the one spelling (${show(bobKnockCaps)})`);

    const bobSock = await socket(bob, bobCaps);
    const dm = await call('POST', alice, '/api/messages/conversation', { type: 'dm', participants: [alice.pk, bob.pk], createdBy: alice.pk });
    const line = await call('POST', alice, '/api/messages/send', { conversationId: dm.body?.conversation?.id, authorPubkey: alice.pk, ciphertext: 'c2VjcmV0', nonce: 'bm9uY2U=' });
    await settle();
    assert(line.status === 200 && bobSock.events.some(e => e.type === 'new_message' && e.conversationId === dm.body?.conversation?.id),
        `Bob's /ws socket signed in capitals is Bob's: it gets the line Alice sent him (${show(line)}; ${bobSock.events.map(e => e.type).join(',')})`);
    bobSock.ws.close();

    // A re-key: the new key in capitals is refused; in the one spelling it binds.
    const rex = makeMember('Rex', 0);
    const rexNew = keypair('RexNew');
    const rekey = issueRekeyCode(rex.pk, founder.pk);
    const proof = (k: Id) => crypto.sign(null, Buffer.from(rekey.code), k.priv).toString('hex');
    {
        const before = snapshot();
        const caps = await call('POST', rexNew, '/api/member/re-enroll', { code: rekey.code, newPublicKey: rexNew.pk.toUpperCase(), signature: proof(rexNew) }, rexNew.pk.toUpperCase());
        assert(isBadKey(caps) && changedTables(before, snapshot()).length === 0 && hasRow(rex.pk) && !hasRow(rexNew.pk),
            `a re-key naming the new key in capitals is refused 400 bad_key and nothing moves (${show(caps)})`);
        const ok = await call('POST', rexNew, '/api/member/re-enroll', { code: rekey.code, newPublicKey: rexNew.pk, signature: proof(rexNew) });
        assert(ok.status === 200 && hasRow(rexNew.pk) && !hasRow(rex.pk), `…in the one spelling it binds (${show(ok)})`);
    }

    // ── 4. Keys named by someone else: a send, a DM, a node role, a peer's listing and buyer ──
    console.log('\n── 4. a key someone else names is taken only in the one spelling ──');
    const fay = keypair('Fay');   // a new key
    const named: Array<[string, Id]> = [['member Bob', bob], ['visitor Wes', wes], ['new key Fay', fay]];
    for (const [who, id] of named) {
        for (const [how, spelt] of namedSpellings(id.pk)) {
            const before = snapshot();
            const s = await call('POST', alice, '/api/ledger/transfer', { to: spelt, amount: 1, memo: 'hi' });
            const d = await call('POST', alice, '/api/messages/conversation', { type: 'dm', participants: [alice.pk, spelt], createdBy: alice.pk });
            const changed = changedTables(before, snapshot());
            assert(isBadKey(s) && isBadKey(d) && changed.length === 0,
                `Alice sends Beans to, and opens a DM with, ${who}'s key ${how}: both refused 400 bad_key, nothing written (${show(s)}; ${show(d)}; changed: ${changed.join(', ') || 'nothing'})`);
        }
    }
    const fayTo = await call('POST', alice, '/api/ledger/transfer', { to: fay.pk, amount: 1, memo: 'hi' });
    assert(fayTo.status === 200 && rowsFor(fay.pk).length === 1 && hasRow(fay.pk) && getBalance(fay.pk).balance === 1,
        `a send to a new key in the one spelling still makes its visitor's row, holding the Beans (${show(fayTo)})`);

    for (const [how, spelt] of namedSpellings(bob.pk)) {
        const before = snapshot(['system_logs']);
        const g = await admin('POST', '/api/local/admin/node-roles', { pubkey: spelt, role: 'moderator' });
        const e = await admin('POST', '/api/local/admin/auth/enrol', { memberPubkey: spelt, role: 'moderator' });
        const changed = changedTables(before, snapshot(['system_logs']));
        assert(isBadKey(g) && isBadKey(e) && changed.length === 0,
            `an operator granting a role to, and enrolling, Bob's key ${how}: refused 400 bad_key, nothing written (${show(g)}; ${show(e)}; changed: ${changed.join(', ') || 'nothing'})`);
    }
    const grant = await admin('POST', '/api/local/admin/node-roles', { pubkey: bob.pk, role: 'moderator' });
    assert(grant.status === 200 && (db.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(bob.pk) as any)?.role === 'moderator',
        `in the one spelling the role is granted (${show(grant)})`);

    // A peer's listings and a peer's cross-node buyer arrive from a peer connection, not over HTTP: the functions.
    const PEER = '12D3KooWDoorsKeyCasePeer';
    const PEER_URL = 'https://peer.example.test';
    const listing = (author: string, title: string) => ({ id: crypto.randomUUID(), type: 'offer', category: 'other', title, description: 'Maths', credits: 3, priceType: 'fixed', authorPublicKey: author, authorCallsign: 'Remote Tutor' });
    for (const [who, id] of named) {
        for (const [how, spelt] of namedSpellings(id.pk)) {
            const before = snapshot();
            const res = cacheRemoteListings(PEER, PEER_URL, [listing(spelt, `By ${who} ${how}`)]);
            const buy = handlePurchaseRequest({ key: `k-${crypto.randomUUID()}`, peerId: PEER, buyerPublicKey: spelt, buyerCallsign: 'Official Admin', buyerHomeNode: PEER_URL, sellerPublicKey: alice.pk, amount: 1 } as any) as any;
            const changed = changedTables(before, snapshot());
            assert(res.cached === 0 && res.dropped === 1 && buy.accepted === false && buy.reason === 'invalid_parties' && changed.length === 0,
                `a peer names ${who}'s key ${how} as a listing's author and as a buyer: the listing is dropped, the purchase refused (invalid_parties), nothing written (${res.cached}/${res.dropped}; ${buy.reason}; changed: ${changed.join(', ') || 'nothing'})`);
        }
    }
    const remote = keypair('Remote');
    const kept = cacheRemoteListings(PEER, PEER_URL, [listing(remote.pk, 'Remote tutoring')]);
    assert(kept.cached === 1 && hasRow(remote.pk), `a remote author in the one spelling is still cached, with a visitor's row (${kept.cached}/${kept.dropped})`);

    // ── 5. Rows made before this rule ──
    console.log('\n── 5. rows a door stored under another spelling before this rule ──');
    // As the old doors made them (named so as not to meet a row the old doors made above, on a tree without this rule):
    // Bob's key in capitals as a member named by the caller, holding a role; …zz after
    // Bob's key; and Pia's key in capitals as a visitor's row holding Beans sent before she joined (older than her own).
    const pia = keypair('Pia');
    const PIA = pia.pk.toUpperCase();
    const insertStray = (pk: string, callsign: string, visitor: number, joined: string, invitedBy: string | null) => {
        // An upsert: on a tree without this rule, section 1 already made some of these through the doors.
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_visitor) VALUES (?, ?, ?, ?, ?, 'active', ?)
                    ON CONFLICT(public_key) DO UPDATE SET callsign = excluded.callsign, joined_at = excluded.joined_at, status = 'active', is_visitor = excluded.is_visitor`)
            .run(pk, callsign, joined, invitedBy, invitedBy ? 'OLD-DOOR' : null, visitor);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
    };
    insertStray(PIA, 'Stray Pia', 1, ago(10 * DAY), null);
    transfer('genesis', PIA, 3, 'sent to the capitals', 'direct', true);
    insertStray(bobCaps, 'Official Bob', 0, ago(DAY), alice.pk);
    db.prepare(`INSERT OR IGNORE INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'admin', 'owner:password')`).run(bobCaps);
    insertStray(`${bob.pk}zz`, 'Stray Bob zz', 0, ago(DAY), alice.pk);
    // Pia knocks, then joins, in the one spelling.
    const piaKnock = await call('POST', pia, '/api/join/knock', { callsign: 'Pia', message: 'Hello, I grow tomatoes nearby.', fromNode: 'https://global.beanpool.org/' });
    const piaJoin = await call('POST', pia, '/api/invite/redeem', { code: generateInvite(alice.pk)!.code, publicKey: pia.pk, callsign: 'Pia' });
    assert(piaKnock.status === 201 && piaJoin.status === 200 && hasRow(pia.pk), `setup: Pia knocks and joins in the one spelling (${show(piaKnock)}; ${show(piaJoin)})`);

    assert(!!memberKey, 'the boot check exists (engine/member-key.ts reportMisspeltMemberKeys)');
    if (memberKey) {
        const before = snapshot();
        const lines: string[] = [];
        const found = memberKey.reportMisspeltMemberKeys(l => lines.push(l));
        const keys = found.map(f => f.publicKey).sort();
        assert(JSON.stringify(keys) === JSON.stringify([PIA, bobCaps, `${bob.pk}zz`].sort()),
            `it lists exactly the three stray rows, and no enterprise, project or SYSTEM (${keys.map(k => k.slice(0, 6)).join(', ')})`);
        const bobLine = found.find(f => f.publicKey === bobCaps);
        assert(bobLine?.sameKeyAs === 'Bob' && bobLine?.nodeRole === 'admin' && found.find(f => f.publicKey === PIA)?.sameKeyAs === 'Pia',
            'it says whose key each is, spelt another way, and the role one holds');
        assert(lines.some(l => /Official Bob/.test(l) && /same key as "Bob"/.test(l)) && lines.some(l => /What to do: remove each one/.test(l)),
            `it logs a line per row and what an operator should do (${lines.length} lines)`);
        assert(changedTables(before, snapshot()).length === 0, 'and changes nothing');
    }

    assert(!authorizeKeySigner({ memberPubkey: bobCaps, signatureValid: () => true }).ok,
        'Bob\'s key in capitals signs in to Settings with no role the stray row holds (a key sign-in is for the one spelling)');
    assert(adminActorName(bobCaps) === 'Bob' && adminActorName(bob.pk) === 'Bob',
        `an admin action Bob signs names Bob, never the stray row's "Official Bob" (${adminActorName(bobCaps)})`);
    const inv = await call('POST', bob, '/api/invite/generate', { publicKey: bob.pk }, bobCaps);
    assert(inv.status === 200 && inv.body?.invite?.createdBy === bob.pk, `Bob signing in capitals is still Bob, not the stray row (${show(inv)})`);
    {
        const before = snapshot(['system_logs']);
        let rekeyErr = '', previewErr = '', offboardErr = '';
        try { issueRekeyCode(bobCaps, founder.pk); } catch (e: any) { rekeyErr = e.message; }
        try { getOffboardPreview(bobCaps); } catch (e: any) { previewErr = e.message; }
        try { executeOffboard(bobCaps, { resolution: 'donate_to_commons' } as any, founder.pk); } catch (e: any) { offboardErr = e.message; }
        const stray = /isn’t written the way this community keeps keys/;
        assert(stray.test(rekeyErr) && stray.test(previewErr) && stray.test(offboardErr) && changedTables(before, snapshot(['system_logs'])).length === 0
            && (db.prepare('SELECT status FROM members WHERE public_key = ?').get(bob.pk) as any)?.status === 'active'
            && !db.prepare('SELECT 1 FROM invalidated_keys WHERE public_key = ?').get(bob.pk),
            `re-keying or offboarding the stray row is refused, and never reaches Bob (${rekeyErr.slice(0, 40)} / ${previewErr.slice(0, 40)} / ${offboardErr.slice(0, 40)})`);
    }
    let noraRekey = '';
    try { noraRekey = issueRekeyCode(nora.pk.toUpperCase(), founder.pk).oldPubkey; } catch (e: any) { noraRekey = `threw ${e.message}`; }
    assert(noraRekey === nora.pk, `a member's key named in capitals with no stray row still finds that member to re-key, as before (${noraRekey.slice(0, 20)})`);

    // An operator removes the stray rows, by their exact keys.
    for (const k of [bobCaps, PIA]) {
        const pr = await admin('POST', `/api/local/admin/users/${encodeURIComponent(k)}/prune`, {});
        assert(pr.status === 200 && (db.prepare('SELECT status FROM members WHERE public_key = ?').get(k) as any)?.status === 'pruned',
            `an operator removes the stray row ${k.slice(0, 6)}… by its exact key (${show(pr)})`);
    }
    let piaActive = true, bobActive = true;
    try { assertMemberActive(pia.pk); } catch { piaActive = false; }
    try { assertMemberActive(bob.pk); } catch { bobActive = false; }
    assert(piaActive && bobActive, 'Pia and Bob, whose keys those were, are still active members (their own rows, not a case-blind match)');
    assert((db.prepare('SELECT status FROM members WHERE public_key = ?').get(bob.pk) as any)?.status === 'active'
        && (db.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(bob.pk) as any)?.role === 'moderator',
        'Bob keeps his row and his own role');
    const piaKnockRow = db.prepare('SELECT callsign, message FROM join_requests WHERE pubkey = ?').get(pia.pk) as { callsign: string; message: string } | undefined;
    assert(piaKnockRow?.callsign === 'Pia' && /tomatoes/.test(piaKnockRow?.message ?? ''),
        `what Pia wrote when she knocked is kept: removing the stray row scrubbed no one else's knock (${JSON.stringify(piaKnockRow)})`);
    const piaSend = await call('POST', bob, '/api/ledger/transfer', { to: pia.pk, amount: 1, memo: 'welcome' });
    assert(piaSend.status === 200, `and Bob still sends Beans to Pia (${show(piaSend)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch(e => { console.error(e); process.exit(1); });
