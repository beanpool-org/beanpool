/**
 * The community's welcome for new members (scratch/fable-design/DESIGN-onboarding-home-landing-fable.md §4.5, slice S6;
 * config/community-welcome.ts) over HTTPS, through the real middleware, on a local community:
 *
 *   1. The table: {owner, admin, member, suspended member, stranger, guest, an owner's automation token} ×
 *      {set it, read it in Settings, read it on Home, read the public card}. Only an owner sets it; an owner or an admin
 *      reads it in Settings; whoever reads Home as a member gets it (`cards.community.welcome`), nobody else; the public
 *      card never has it. A refused set changes nothing.
 *   2. The visitors' view (a node that shows visitors the listings): an unsigned reader and a stranger are answered Home,
 *      without the welcome; a member's Home has it.
 *   3. Nothing public says it: the bare address's card, /api/community/info, /api/local/community-info, /api/directory/info
 *      and what the directory is sent.
 *   4. The limits, refused in words with a code, and nothing stored: 281 characters, 4 line breaks, control characters,
 *      not text. 280 characters on four lines are kept; a Windows line end is kept as one break; null and '' clear it.
 *   5. The standby copy: the sync payload's community settings carry it; a record with one a standby can't take leaves it
 *      out; a kept record installs it, and one with none removes it.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-community-welcome.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { COMMUNITY_WELCOME_WORDS, type CommunityWelcomeProblem } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, exportSyncState, getDirectoryInfo } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerSessionHeaders, ownerTokenHeaders, ownerPhoneSessionHeaders } from './admin-auth-test-harness.js';
import { grantNodeRole } from './engine/node-roles.js';
import { mintHandshakeToken, consumeHandshakeToken, backdateAdminSessionForTests } from './admin-key-auth.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';
import { setSwitchOverride } from './config/node-profile.js';
import { COMMUNITY_WELCOME_KEY, readCommunityWelcome } from './config/community-welcome.js';
import { readCommunitySettings, parseCommunitySettings, keepMainServerCommunitySettings, installCommunitySettings } from './config/community-settings.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any; text: string };
const show = (r: Res) => `${r.status} ${r.text.slice(0, 160)}`;
const j = JSON.stringify;

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

function makeMember(name: string, status = 'active'): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'TEST', ?)`).run(id.pk, name, status);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    return id;
}

function keySession(pk: string, role: 'owner' | 'admin'): Record<string, string> {
    const { handshakeToken } = mintHandshakeToken(pk, role);
    const s = consumeHandshakeToken(handshakeToken);
    if (!s.ok || !s.sessionId) throw new Error(`could not open a test key session: ${s.error}`);
    return { 'X-Admin-Session': s.sessionId };
}

async function call(method: string, id: Id | null, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    resetGatewayRateLimit();
    resetAdminRateLimit();
    resetAdminAuthTarpit();
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
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text };
}

const storedRow = () => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(COMMUNITY_WELCOME_KEY) as { value: string } | undefined)?.value ?? null;
const ROUTE = '/api/local/admin/community-welcome';
const WELCOME = "Sentinel welcome: market day is Saturday at the hall.\nPost what you grow, make or can lend.";
const SENTINEL = 'Sentinel welcome';

async function main(): Promise<void> {
    console.log("The community's welcome for new members over HTTPS\n");
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const founder = keypair('Founder');
    seedGenesisMember(founder.pk, founder.name);
    grantNodeRole(founder.pk, 'owner', 'SYSTEM');
    const ada = makeMember('Ada');
    grantNodeRole(ada.pk, 'admin', 'SYSTEM');
    const sam = makeMember('Samwise');
    const dan = makeMember('Dannie', 'disabled'); // suspended: reads as a non-member while it lasts

    const ownerAdmin = ownerSessionHeaders(founder.pk);
    const adaAdmin = keySession(ada.pk, 'admin');
    const ownerToken = ownerTokenHeaders('admin', founder.pk);

    // ── 0. Empty by default ──
    console.log('\n— 0. empty by default —');
    assert(storedRow() === null && readCommunityWelcome() === null, 'a community starts with no welcome: no row');
    const home0 = await call('GET', sam, '/api/home?cards=community');
    assert(home0.status === 200 && home0.body?.cards?.community?.welcome === null,
        `a member's Home says there is none yet: welcome null, present (${show(home0)})`);

    // ── 1. The table ──
    console.log('\n— 1. who may set it and who reads it —');
    type Reader = { who: string; id: Id | null; admin?: Record<string, string> };
    const readers: Reader[] = [
        { who: 'owner', id: founder, admin: ownerAdmin },
        { who: 'admin', id: ada, admin: adaAdmin },
        { who: 'member', id: sam },
        { who: 'suspended member', id: dan },
        { who: 'stranger', id: keypair('Stranger') },
        { who: 'guest', id: null },
        { who: "owner's automation token", id: null, admin: ownerToken },
    ];
    // allowed / refused, and Home: 'has' the welcome, 'without' it (answered, no field), or 'refused'.
    const expected: Record<string, { set: 'allowed' | 'refused'; settings: 'allowed' | 'refused'; home: 'has' | 'without' | 'refused' }> = {
        owner: { set: 'allowed', settings: 'allowed', home: 'has' },
        admin: { set: 'refused', settings: 'allowed', home: 'has' },
        member: { set: 'refused', settings: 'refused', home: 'has' },
        'suspended member': { set: 'refused', settings: 'refused', home: 'without' },
        stranger: { set: 'refused', settings: 'refused', home: 'refused' },
        guest: { set: 'refused', settings: 'refused', home: 'refused' },
        "owner's automation token": { set: 'refused', settings: 'allowed', home: 'refused' },
    };
    // The owner sets it first, so every read below has a welcome to give or keep back.
    const set = await call('POST', null, ROUTE, { welcome: WELCOME }, ownerAdmin);
    assert(set.status === 200 && set.body?.welcome === WELCOME && storedRow() === WELCOME, `owner: sets the welcome (${show(set)})`);
    for (const r of readers) {
        const want = expected[r.who];
        // Set: a refused set changes nothing.
        const before = storedRow();
        const attempt = await call('POST', r.admin ? null : r.id, ROUTE, { welcome: `${r.who} rewrote it` }, r.admin ?? {});
        if (want.set === 'allowed') {
            assert(attempt.status === 200 && storedRow() === `${r.who} rewrote it`, `${r.who} × set: allowed (${show(attempt)})`);
            await call('POST', null, ROUTE, { welcome: WELCOME }, ownerAdmin);
        } else {
            assert(attempt.status >= 400 && attempt.status < 500 && attempt.status !== 404 && storedRow() === before,
                `${r.who} × set: refused, nothing changed (${show(attempt)})`);
        }
        // Read in Settings.
        const settings = await call('GET', r.admin ? null : r.id, ROUTE, undefined, r.admin ?? {});
        if (want.settings === 'allowed') assert(settings.status === 200 && settings.body?.welcome === WELCOME, `${r.who} × read in Settings: allowed (${show(settings)})`);
        else assert(settings.status >= 400 && settings.status < 500 && !settings.text.includes(SENTINEL), `${r.who} × read in Settings: refused (${show(settings)})`);
        // Read via Home, signed by the reader's own key (a token is no member's read).
        const home = await call('GET', r.id, '/api/home', undefined, r.admin && !r.id ? r.admin : {});
        if (want.home === 'has') {
            assert(home.status === 200 && home.body?.cards?.community?.welcome === WELCOME, `${r.who} × read via /api/home: has it (${show(home)})`);
        } else if (want.home === 'without') {
            assert(home.status === 200 && home.body?.cards?.community !== undefined && !('welcome' in home.body.cards.community) && !home.text.includes(SENTINEL),
                `${r.who} × read via /api/home: answered, without it (${show(home)})`);
        } else {
            assert(home.status >= 400 && home.status < 500 && !home.text.includes(SENTINEL), `${r.who} × read via /api/home: refused (${show(home)})`);
        }
        // The public card: never.
        const card = await call('GET', r.id, '/api/community/card', undefined, r.admin && !r.id ? r.admin : {});
        assert(card.status === 200 && !card.text.includes(SENTINEL) && !card.text.includes('market day'),
            `${r.who} × read via the public card: absent (${card.status})`);
    }
    assert(storedRow() === WELCOME, `after the table, the owner's welcome is the one kept (${j(storedRow())})`);
    // An owner's phone hand-off past its 5-minute unlock (admin-auth.ts requirePhoneStepUp): it still reads, and a change
    // waits for Manage to be pressed again.
    const stalePhone = ownerPhoneSessionHeaders(founder.pk);
    backdateAdminSessionForTests(stalePhone['X-Admin-Session'], 6 * 60_000);
    const staleSet = await call('POST', null, ROUTE, { welcome: 'From a stale phone' }, stalePhone);
    assert(staleSet.status === 403 && staleSet.body?.code === 'step_up_required' && storedRow() === WELCOME,
        `a stale phone hand-off: the change waits for the step-up, nothing changed (${show(staleSet)})`);
    const staleRead = await call('GET', null, ROUTE, undefined, stalePhone);
    assert(staleRead.status === 200 && staleRead.body?.welcome === WELCOME, `a stale phone hand-off still reads it (${show(staleRead)})`);

    // ── 2. The visitors' view ──
    console.log("\n— 2. a node that shows visitors the listings —");
    setSwitchOverride('guestListingsOnly', true);
    for (const [who, id] of [['guest', null], ['stranger', keypair('Visitor')]] as const) {
        const home = await call('GET', id, '/api/home');
        assert(home.status === 200 && !home.text.includes(SENTINEL) && !('welcome' in (home.body?.cards?.community ?? {})),
            `${who}: the visitors' Home is answered, without the welcome (${show(home)})`);
    }
    const memberHome = await call('GET', sam, '/api/home');
    assert(memberHome.status === 200 && memberHome.body?.cards?.community?.welcome === WELCOME, `a member's Home there has it (${show(memberHome)})`);
    setSwitchOverride('guestListingsOnly', false);

    // ── 3. Nothing public says it ──
    console.log('\n— 3. nothing public says it —');
    for (const path of ['/', '/api/community/info', '/api/local/community-info', '/api/directory/info', '/api/community/card']) {
        const r = await call('GET', null, path, undefined, { Accept: path === '/' ? 'text/html' : 'application/json' });
        assert(r.status < 500 && !r.text.includes(SENTINEL) && !r.text.includes('market day'), `${path} never says it (${r.status})`);
    }
    assert(!j(getDirectoryInfo()).includes(SENTINEL), 'what the directory is sent never says it');

    // ── 4. The limits ──
    console.log('\n— 4. the limits, refused in words —');
    const refusals: Array<[string, unknown, string]> = [
        ['281 characters', 'a'.repeat(281), 'too_long'],
        ['4 line breaks', 'one\ntwo\nthree\nfour\nfive', 'too_many_lines'],
        ['a NUL', 'Welcome\u0000', 'control_character'],
        ['an escape sequence', 'Welcome \u001b[31mred', 'control_character'],
        ['a DEL', 'Wel\u007fcome', 'control_character'],
        ['a number', 42, 'not_text'],
        // JSON leaves an undefined out: a body with no welcome at all, which must never erase the one kept.
        ['no welcome in the body', undefined, 'not_text'],
    ];
    for (const [what, welcome, code] of refusals) {
        const r = await call('POST', null, ROUTE, { welcome }, ownerAdmin);
        // Core's words, the sentence Settings shows beside the count before Save (one source of words, #3313 review).
        assert(r.status === 400 && r.body?.code === code && r.body?.error === COMMUNITY_WELCOME_WORDS[code as CommunityWelcomeProblem] && storedRow() === WELCOME,
            `${what}: refused in core's words (${code}), nothing stored (${show(r)})`);
    }
    const longest = `${'a'.repeat(70)}\n${'b'.repeat(70)}\n${'c'.repeat(70)}\n${'d'.repeat(67)}`;
    const kept = await call('POST', null, ROUTE, { welcome: longest }, ownerAdmin);
    assert(longest.length === 280 && kept.status === 200 && storedRow() === longest, `280 characters on four lines are kept (${show(kept)})`);
    const crlf = await call('POST', null, ROUTE, { welcome: '  Hello\r\nand welcome  ' }, ownerAdmin);
    assert(crlf.status === 200 && storedRow() === 'Hello\nand welcome', `a Windows line end is kept as one break, the ends trimmed (${j(storedRow())})`);
    for (const empty of [null, '', '   ']) {
        await call('POST', null, ROUTE, { welcome: WELCOME }, ownerAdmin);
        const cleared = await call('POST', null, ROUTE, { welcome: empty }, ownerAdmin);
        const home = await call('GET', sam, '/api/home?cards=community');
        assert(cleared.status === 200 && cleared.body?.welcome === null && storedRow() === null && home.body?.cards?.community?.welcome === null,
            `${j(empty)} clears it: no row, and Home says none (${show(cleared)})`);
    }

    // ── 5. The standby copy ──
    console.log('\n— 5. the standby copy —');
    await call('POST', null, ROUTE, { welcome: WELCOME }, ownerAdmin);
    const payload: any = await exportSyncState('welcome-suite');
    assert(payload?.communitySettings?.nodeConfig?.community_welcome === WELCOME,
        `the sync payload's community settings carry it (${j(payload?.communitySettings?.nodeConfig?.community_welcome)})`);
    const record = readCommunitySettings();
    for (const [what, bad] of [['281 characters', 'x'.repeat(281)], ['a control character', 'Hi\u0007'], ['untrimmed text', ' Hi'], ['a number', 5]] as const) {
        const parsed = parseCommunitySettings({ ...record, nodeConfig: { ...record.nodeConfig, community_welcome: bad } });
        assert(!!parsed && !('community_welcome' in parsed.record.nodeConfig) && parsed.left.includes('nodeConfig.community_welcome (not a value it can take)'),
            `a record with ${what} as its welcome: a standby leaves it out (${j(parsed?.left)})`);
    }
    // A standby's side, on this database: keep a record whose welcome differs, then install it, as a take-over does.
    const theirs = 'From the main server: welcome, and say hello.';
    const keptRecord = keepMainServerCommunitySettings({ ...record, nodeConfig: { ...record.nodeConfig, community_welcome: theirs } }, new Date().toISOString());
    assert(keptRecord.kept && !keptRecord.left.some((l) => l.includes('community_welcome')) && storedRow() === WELCOME,
        `a standby keeps the main server's welcome, applied to nothing (${j(storedRow())})`);
    const installed = installCommunitySettings();
    assert(installed.installed && storedRow() === theirs && readCommunityWelcome() === theirs, `a take-over installs it (${j(storedRow())})`);
    keepMainServerCommunitySettings({ ...record, nodeConfig: { ...record.nodeConfig, community_welcome: null } }, new Date().toISOString());
    const cleared = installCommunitySettings();
    assert(cleared.installed && storedRow() === null, `a record with none installs none: the row goes (${j(storedRow())})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
