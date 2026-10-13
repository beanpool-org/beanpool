/**
 * A "verified account" badge means the node asked the platform (#1830).
 *
 * Boots the real HTTPS server and drives `/api/member/pulse/oauth-exchange` with signed requests
 * through the real middleware. A fake TikTok and Instagram answer the token, identity and
 * long-lived-token calls (`setPlatformRequestForTests`); nothing here reaches a real platform.
 *
 *   1. The #1830 repro: a neighbour's handle never badges, and a body username is ignored.
 *   2. Exact matching: `art`, `artbyjan`, `artbyjane2` never badge `@artbyjane`; the right account
 *      does, in any case; a rename keeps the badge through the stable id. YouTube rows match exactly.
 *   3. Instagram: no username → identity_unavailable (no display-name fallback); the Tester-role
 *      error → identity_unavailable with the role hint; a proper answer badges and returns the token.
 *   4. Ownership and shape: another member's channel 403; wrong platform 400; a short link 400
 *      not_verifiable; Facebook never badges. None of these spends a code.
 *   5. Refresh: a proven row makes no identity call; an unbadged row re-verifies silently.
 *   6. Old phones: verify-oauth answers 410 update_required; a connect with no channel 400.
 *   7. The 11th exchange in an hour → 429.
 *   8. Nothing stored: the data dir and the captured output hold no token and no refused handle.
 *   9. The switch: a badge with no platform account id is cleared once, items kept.
 *
 *   SERVER_SUITES_ONLY=test-pulse-verify-identity node scripts/run-server-suites.mjs
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
process.env.ADMIN_PASSWORD = 'VerifyIdentity123!';
process.env.TIKTOK_CLIENT_KEY = 'fake-client-key';
process.env.TIKTOK_CLIENT_SECRET = 'fake-client-secret';
process.env.INSTAGRAM_APP_ID = 'fake-ig-app';
process.env.INSTAGRAM_APP_SECRET = 'fake-ig-secret';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';
import { addChannel, clearUnprovenOauthBadges } from './engine/creator-channels.js';
import { setPlatformRequestForTests, channelIdentityFromRow, matchIdentity, type PlatformRequest } from './engine/platform-identity.js';
import { resetPulseOAuthRelayLimits } from './routes/channels.js';

// Everything the SERVER prints, so the suite can prove no token or identity reaches a log line. The
// suite's own lines go straight to the real streams and are not captured: they quote responses.
const captured: string[] = [];
const rawOut = process.stdout.write.bind(process.stdout);
const rawErr = process.stderr.write.bind(process.stderr);
(process.stdout as any).write = (chunk: any, ...rest: any[]) => { captured.push(String(chunk)); return rawOut(chunk, ...rest); };
(process.stderr as any).write = (chunk: any, ...rest: any[]) => { captured.push(String(chunk)); return rawErr(chunk, ...rest); };

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; rawOut(`✓ ${msg}\n`); } else { rawErr(`✗ ${msg}\n`); process.exitCode = 1; }
}

let BASE = '';
const DAY = 86_400_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any; text: string };
const show = (r: Res) => `${r.status} ${r.text.slice(0, 220)}`;

function makeMember(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const id = { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`).run(id.pk, name, ago(30 * DAY));
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    return id;
}

function resetLimits(relayToo = true): void {
    resetGatewayRateLimit();
    resetAdminRateLimit();
    resetAdminAuthTarpit();
    pruneAuthAttempts(Date.now() + 120_000);
    if (relayToo) resetPulseOAuthRelayLimits();
}

async function call(method: string, id: Id | null, urlPath: string, body?: unknown, relayReset = true): Promise<Res> {
    resetLimits(relayReset);
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { /* empty */ }
    return { status: res.status, body: json, text };
}

// ── The fake platform ────────────────────────────────────────────────────────────────────────
// A code or refresh token names the account the member "signed in to". Every token the fake
// issues is remembered so the suite can grep the data dir and the output for all of them.
type Account = { openId: string; username: string };
const tiktokAccounts: Record<string, Account> = {};
const issuedTokens = new Set<string>();
const tokenOwner = new Map<string, Account>();
const calls = { tiktokToken: 0, tiktokUserInfo: 0, igToken: 0, igMe: 0, igLong: 0, other: [] as string[] };
const userInfoUrls: string[] = [];
const IG_SCENARIOS: Record<string, { userId: number; me: { status: number; json: any } }> = {
    'ig-good': { userId: 17841400000000001, me: { status: 200, json: { id: 'ig-app-scoped-1', username: 'IG_Jane' } } },
    'ig-nameonly': { userId: 17841400000000002, me: { status: 200, json: { id: 'ig-app-scoped-2', name: 'Jane Display Name' } } },
    'ig-tester': {
        userId: 17841400000000003,
        me: { status: 400, json: { error: { message: 'Unsupported request - method type: get', type: 'IGApiException', code: 100 } } },
    },
};
const igTokenScenario = new Map<string, string>();

function mint(prefix: string): string {
    const t = `${prefix}-SECRET-${crypto.randomBytes(8).toString('hex')}`;
    issuedTokens.add(t);
    return t;
}

const fakePlatform: PlatformRequest = async (method, url, opts) => {
    if (method === 'POST' && url === 'https://open.tiktokapis.com/v2/oauth/token/') {
        calls.tiktokToken++;
        const form = opts?.form || {};
        const key = form.grant_type === 'refresh_token' ? form.refresh_token : form.code;
        const account = tiktokAccounts[key];
        if (!account) return { status: 400, json: { error: 'invalid_grant', error_description: 'Code is expired' } };
        const access = mint('tt-access');
        const refresh = mint('tt-refresh');
        tokenOwner.set(access, account);
        tiktokAccounts[refresh] = account;
        return { status: 200, json: { access_token: access, refresh_token: refresh, open_id: account.openId, expires_in: 86400, scope: 'user.info.basic,user.info.profile', token_type: 'Bearer' } };
    }
    if (method === 'GET' && url.startsWith('https://open.tiktokapis.com/v2/user/info/')) {
        calls.tiktokUserInfo++;
        userInfoUrls.push(url);
        const account = opts?.bearer ? tokenOwner.get(opts.bearer) : undefined;
        if (!account) return { status: 401, json: { error: { code: 'access_token_invalid' } } };
        return { status: 200, json: { data: { user: { open_id: account.openId, username: account.username } }, error: { code: 'ok' } } };
    }
    if (method === 'POST' && url === 'https://api.instagram.com/oauth/access_token') {
        calls.igToken++;
        const scenario = IG_SCENARIOS[opts?.form?.code || ''];
        if (!scenario) return { status: 400, json: { error_type: 'OAuthException', error_message: 'Invalid code' } };
        const short = mint('ig-short');
        igTokenScenario.set(short, opts!.form!.code);
        return { status: 200, json: { access_token: short, user_id: scenario.userId } };
    }
    if (method === 'GET' && url.startsWith('https://graph.instagram.com/v21.0/me?')) {
        calls.igMe++;
        const token = new URL(url).searchParams.get('access_token') || '';
        const scenario = IG_SCENARIOS[igTokenScenario.get(token) || ''];
        if (!scenario) return { status: 400, json: { error: { message: 'Invalid OAuth access token', code: 190 } } };
        return scenario.me;
    }
    if (method === 'GET' && url.startsWith('https://graph.instagram.com/access_token?')) {
        calls.igLong++;
        return { status: 200, json: { access_token: mint('ig-long'), token_type: 'bearer', expires_in: 5184000 } };
    }
    calls.other.push(`${method} ${new URL(url).host}`);
    throw new Error('the fake platform does not answer that');
};

function channelRow(id: string): any {
    return db.prepare(`SELECT * FROM creator_channels WHERE id = ?`).get(id);
}

function exchange(who: Id, body: Record<string, unknown>, relayReset = true): Promise<Res> {
    return call('POST', who, '/api/member/pulse/oauth-exchange', body, relayReset);
}

function tiktokConnect(who: Id, channelId: string | undefined, account: Account, extra: Record<string, unknown> = {}): Promise<Res> {
    const code = `code-${crypto.randomBytes(6).toString('hex')}`;
    tiktokAccounts[code] = account;
    return exchange(who, { platform: 'tiktok', grantType: 'authorization_code', code, codeVerifier: 'v'.repeat(43), redirectUri: 'beanpool://auth/tiktok', channelId, ...extra });
}

const noTokenIn = (r: Res) => ![...issuedTokens].some(t => r.text.includes(t));

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    setPlatformRequestForTests(fakePlatform);
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const mallory = makeMember('mallory');
    const neighbour = makeMember('neighbour');
    const jane = makeMember('jane');
    const sam = makeMember('sam');
    const bob = makeMember('bob');

    // ── 1. The #1830 repro ─────────────────────────────────────────────────────────────────
    const stolen = addChannel({ ownerPubkey: mallory.pk, platform: 'tiktok', raw: '@a_real_neighbour', category: 'art' });
    const malloryAccount = { openId: 'oid-mallory', username: 'mallory_secret_handle' };
    const repro = await tiktokConnect(mallory, stolen.id, malloryAccount, { platformUsername: 'a_real_neighbour', username: 'a_real_neighbour' });
    assert(repro.status === 400 && repro.body?.error === 'account_mismatch',
        `Mallory's own TikTok account never badges a neighbour's handle, whatever the body says (${show(repro)})`);
    assert(noTokenIn(repro), 'the refused connect returns no token');
    assert(channelRow(stolen.id).oauth_verified_at === null && channelRow(stolen.id).platform_account_id === null,
        'no badge and no account id are stored on the refused channel');

    const oldVerify = await call('POST', mallory, `/api/member/channels/${stolen.id}/verify-oauth`, { platform: 'tiktok', platformUsername: 'a_real_neighbour' });
    assert(oldVerify.status === 410 && oldVerify.body?.error === 'update_required' && /Update BeanPool/.test(oldVerify.body?.message || ''),
        `an old phone's verify-oauth gets a plain "update" refusal (${show(oldVerify)})`);
    assert(channelRow(stolen.id).oauth_verified_at === null, 'verify-oauth never sets a badge any more');
    const unsignedVerify = await call('POST', null, `/api/member/channels/${stolen.id}/verify-oauth`, { platform: 'tiktok', platformUsername: 'x' });
    assert(unsignedVerify.status === 401, 'an unsigned verify-oauth is still 401');

    const tokenCallsBefore = calls.tiktokToken;
    const oldConnect = await tiktokConnect(mallory, undefined, malloryAccount);
    assert(oldConnect.status === 400 && oldConnect.body?.error === 'update_required',
        `an old phone's connect with no channel is refused with the update message (${show(oldConnect)})`);
    assert(calls.tiktokToken === tokenCallsBefore, 'and no code is exchanged for it');

    // ── 2. Exact matching, never a prefix ───────────────────────────────────────────────────
    const art = addChannel({ ownerPubkey: jane.pk, platform: 'tiktok', raw: 'https://www.tiktok.com/@artbyjane', category: 'art' });
    for (const near of ['art', 'artbyjan', 'artbyjane2', 'xartbyjane', 'artbyjane.']) {
        const r = await tiktokConnect(jane, art.id, { openId: `oid-${near}`, username: near });
        assert(r.status === 400 && r.body?.error === 'account_mismatch' && noTokenIn(r),
            `a TikTok account named "${near}" never badges @artbyjane (${show(r)})`);
    }
    assert(channelRow(art.id).oauth_verified_at === null, 'after five near misses the channel is still unbadged');

    const janeAccount = { openId: 'oid-jane', username: 'artbyjane' };
    const right = await tiktokConnect(jane, art.id, janeAccount);
    const rightRow = channelRow(art.id);
    assert(right.status === 200 && typeof right.body?.data?.access_token === 'string' && issuedTokens.has(right.body.data.access_token),
        `the right account connects and the phone gets its token back (${show(right)})`);
    assert(!!rightRow.oauth_verified_at && rightRow.supports_autolist === 1 && rightRow.platform_account_id === 'oid-jane' && rightRow.verified_handle === 'artbyjane',
        'the badge is set with the platform\'s stable id and the handle it named');
    assert(right.body?.channel?.oauthVerifiedAt && right.body?.identity?.handle === 'artbyjane', 'the response carries the badged channel and the handle');
    assert(userInfoUrls.every(u => u === 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,username'),
        'the identity call asks TikTok for open_id and username only, with the token in a header, not the URL');

    const caseFold = addChannel({ ownerPubkey: sam.pk, platform: 'tiktok', raw: '@samsings', category: 'art' });
    const folded = await tiktokConnect(sam, caseFold.id, { openId: 'oid-sam', username: 'SamSings' });
    assert(folded.status === 200 && channelRow(caseFold.id).verified_handle === 'samsings', `a platform handle in another case still matches (${show(folded)})`);

    const renamed = await tiktokConnect(jane, art.id, { openId: 'oid-jane', username: 'jane_renamed' });
    const renamedRow = channelRow(art.id);
    assert(renamed.status === 200 && renamedRow.verified_handle === 'jane_renamed' && renamedRow.url === 'https://www.tiktok.com/@artbyjane',
        `a renamed account keeps the badge through its stable id; the stored url is not rewritten (${show(renamed)})`);
    const otherOnBadged = await tiktokConnect(jane, art.id, { openId: 'oid-someone', username: 'someone_else' });
    assert(otherOnBadged.status === 400 && otherOnBadged.body?.error === 'account_mismatch' && noTokenIn(otherOnBadged),
        'a token for a different account never badges, even on a channel that was verified before');

    const ytHandle = channelIdentityFromRow('youtube', 'https://www.youtube.com/@artbyjane', '@artbyjane');
    assert(ytHandle?.kind === 'handle' && !matchIdentity(ytHandle, { accountId: 'UCx', handle: 'artbyjan' })
        && !matchIdentity(ytHandle, { accountId: 'UCx', handle: 'art' }) && matchIdentity(ytHandle, { accountId: 'UCx', handle: 'artbyjane' }),
        'a YouTube @ row matches its exact handle only');
    const ucId = 'UC' + 'aB3_dE5-gH7iJ9kL1mN2oP';
    const ytId = channelIdentityFromRow('youtube', `https://www.youtube.com/channel/${ucId}`, ucId);
    assert(ytId?.kind === 'id' && matchIdentity(ytId, { accountId: ucId, handle: null })
        && !matchIdentity(ytId, { accountId: ucId.toLowerCase(), handle: null }) && !matchIdentity(ytId, { accountId: ucId.slice(0, -1), handle: null }),
        'a YouTube /channel/UC… row matches its id byte for byte only');
    assert(channelIdentityFromRow('youtube', 'https://youtu.be/abc', null) === null
        && channelIdentityFromRow('youtube', 'https://www.youtube.com/c/artbyjane', 'artbyjane') === null
        && channelIdentityFromRow('tiktok', 'https://www.tiktok.com/@artbyjane', '@someone') === null,
        'short links, /c/ names and a handle column that disagrees with the URL are not verifiable');

    // ── 3. Instagram ─────────────────────────────────────────────────────────────────────────
    const ig = addChannel({ ownerPubkey: jane.pk, platform: 'instagram', raw: 'https://www.instagram.com/ig_jane/', category: 'art' });
    const igConnect = (code: string) => exchange(jane, { platform: 'instagram', grantType: 'authorization_code', code, redirectUri: 'beanpool://auth/instagram', channelId: ig.id });
    const nameOnly = await igConnect('ig-nameonly');
    assert(nameOnly.status === 502 && nameOnly.body?.error === 'identity_unavailable' && noTokenIn(nameOnly) && channelRow(ig.id).oauth_verified_at === null,
        `Instagram with a display name but no username never badges: no fallback (${show(nameOnly)})`);
    const tester = await igConnect('ig-tester');
    assert(tester.status === 502 && tester.body?.error === 'identity_unavailable' && /Tester/.test(tester.body?.message || '') && noTokenIn(tester),
        `Instagram's Tester-role refusal gives the role hint and no token (${show(tester)})`);
    const longBefore = calls.igLong;
    assert(calls.igLong === longBefore && calls.igLong === 0, 'no long-lived token is fetched for a refused connect');
    const igGood = await igConnect('ig-good');
    const igRow = channelRow(ig.id);
    assert(igGood.status === 200 && /^ig-long-SECRET-/.test(igGood.body?.data?.access_token || '') && calls.igLong === 1,
        `a proper Instagram answer badges and returns the long-lived token (${show(igGood)})`);
    assert(!!igRow.oauth_verified_at && igRow.platform_account_id === 'ig-app-scoped-1' && igRow.verified_handle === 'ig_jane',
        `the Instagram badge keeps /me's string id, never the token's 17-digit user_id that JSON.parse rounds (${igRow.platform_account_id})`);

    // ── 4. Ownership, platform, verifiability, Facebook ──────────────────────────────────────
    const codesBefore = calls.tiktokToken + calls.igToken;
    const bobOnJane = await tiktokConnect(bob, art.id, { openId: 'oid-bob', username: 'artbyjane' });
    assert(bobOnJane.status === 403, `another member's channel id is 403 even when the account name matches (${show(bobOnJane)})`);
    const wrongPlatform = await tiktokConnect(jane, ig.id, janeAccount);
    assert(wrongPlatform.status === 400 && wrongPlatform.body?.error === 'bad_platform', `a TikTok token for an Instagram channel is 400 (${show(wrongPlatform)})`);
    const short = addChannel({ ownerPubkey: bob.pk, platform: 'tiktok', raw: 'https://vm.tiktok.com/ZMabc123/', category: 'art' });
    const shortR = await tiktokConnect(bob, short.id, { openId: 'oid-bob', username: 'bob' });
    assert(shortR.status === 400 && shortR.body?.error === 'not_verifiable' && /@handle/.test(shortR.body?.message || ''),
        `a short link cannot be verified and says how to fix it (${show(shortR)})`);
    const fb = addChannel({ ownerPubkey: bob.pk, platform: 'facebook', raw: 'https://www.facebook.com/bobspage', category: 'art' });
    const fbAsTiktok = await tiktokConnect(bob, fb.id, { openId: 'oid-bob', username: 'bobspage' });
    const fbDirect = await exchange(bob, { platform: 'facebook', grantType: 'authorization_code', code: 'x', channelId: fb.id });
    assert(fbAsTiktok.status === 400 && fbDirect.status === 400 && channelRow(fb.id).oauth_verified_at === null
        && channelIdentityFromRow('facebook', 'https://www.facebook.com/bobspage', 'bobspage') === null,
        `a Facebook channel never badges (${show(fbAsTiktok)} / ${show(fbDirect)})`);
    const ghost = await tiktokConnect(bob, 'no-such-channel', { openId: 'oid-bob', username: 'bob' });
    assert(ghost.status === 404, 'an unknown channel is 404');
    assert(calls.tiktokToken + calls.igToken === codesBefore, 'none of those refusals spent a code with the platform');

    // ── 5. Refresh: proven rows skip the identity call; unbadged rows re-verify silently ─────
    const janeRefresh = right.body.data.refresh_token as string;
    const infoBefore = calls.tiktokUserInfo;
    const routine = await exchange(jane, { platform: 'tiktok', grantType: 'refresh_token', refreshToken: janeRefresh, channelId: art.id });
    assert(routine.status === 200 && issuedTokens.has(routine.body?.data?.access_token) && calls.tiktokUserInfo === infoBefore,
        `a refresh on a proven channel returns a token and makes no identity call (${show(routine)})`);
    const plain = await exchange(jane, { platform: 'tiktok', grantType: 'refresh_token', refreshToken: janeRefresh });
    assert(plain.status === 200 && calls.tiktokUserInfo === infoBefore && plain.body?.channel === null,
        'a refresh naming no channel is a plain relay: no identity call, no badge');

    const silent = addChannel({ ownerPubkey: sam.pk, platform: 'tiktok', raw: '@sam_quiet', category: 'art' });
    const samRefresh = 'refresh-held-by-the-phone';
    tiktokAccounts[samRefresh] = { openId: 'oid-sam-quiet', username: 'sam_quiet' };
    const reverify = await exchange(sam, { platform: 'tiktok', grantType: 'refresh_token', refreshToken: samRefresh, channelId: silent.id });
    const silentRow = channelRow(silent.id);
    assert(reverify.status === 200 && calls.tiktokUserInfo === infoBefore + 1 && !!silentRow.oauth_verified_at && silentRow.platform_account_id === 'oid-sam-quiet',
        `a refresh on an unbadged channel re-verifies silently with one identity call (${show(reverify)})`);
    tiktokAccounts['refresh-wrong'] = { openId: 'oid-other', username: 'not_sam' };
    const silentSteal = addChannel({ ownerPubkey: sam.pk, platform: 'tiktok', raw: '@someone_famous', category: 'art' });
    const steal = await exchange(sam, { platform: 'tiktok', grantType: 'refresh_token', refreshToken: 'refresh-wrong', channelId: silentSteal.id });
    assert(steal.status === 400 && steal.body?.error === 'account_mismatch' && noTokenIn(steal) && channelRow(silentSteal.id).oauth_verified_at === null,
        'a refresh token for another account never badges either');

    // ── 6. Rate limit ────────────────────────────────────────────────────────────────────────
    resetPulseOAuthRelayLimits();
    tiktokAccounts['refresh-bob'] = { openId: 'oid-bob', username: 'bob' };
    let lastOk = 0;
    for (let i = 0; i < 10; i++) {
        const r = await exchange(bob, { platform: 'tiktok', grantType: 'refresh_token', refreshToken: 'refresh-bob' }, false);
        if (r.status === 200) lastOk++;
    }
    const eleventh = await exchange(bob, { platform: 'tiktok', grantType: 'refresh_token', refreshToken: 'refresh-bob' }, false);
    assert(lastOk === 10 && eleventh.status === 429, `ten exchanges an hour pass and the eleventh is 429 (${lastOk} ok, then ${show(eleventh)})`);
    const otherMember = await exchange(sam, { platform: 'tiktok', grantType: 'refresh_token', refreshToken: 'refresh-bob' }, false);
    assert(otherMember.status === 200, 'the cap is per member: another member still gets through');

    // ── 7. Nothing stored, nothing logged ────────────────────────────────────────────────────
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* the bytes are read from every file anyway */ }
    const dataDir = process.env.BEANPOOL_DATA_DIR || '';
    const files: string[] = [];
    const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
    walk(dataDir);
    const bytes = Buffer.concat(files.map(f => fs.readFileSync(f)));
    const storedTokens = [...issuedTokens].filter(t => bytes.includes(Buffer.from(t)));
    assert(dataDir.length > 0 && files.length > 0 && issuedTokens.size >= 10 && storedTokens.length === 0,
        `no token the fake platform issued is anywhere in the data dir (${files.length} files, ${issuedTokens.size} tokens, ${storedTokens.length} found)`);
    const refusedHandles = ['mallory_secret_handle', 'artbyjane2', 'someone_else', 'not_sam', 'jane display name'];
    const storedHandles = refusedHandles.filter(h => bytes.toString('latin1').toLowerCase().includes(h));
    assert(storedHandles.length === 0, `no refused identity is stored anywhere (${storedHandles.join(', ') || 'none'})`);
    const out = captured.join('');
    const loggedTokens = [...issuedTokens].filter(t => out.includes(t));
    const identities = ['mallory_secret_handle', 'oid-mallory', 'oid-jane', 'jane_renamed', 'oid-sam-quiet', 'ig-app-scoped-1'];
    const loggedIdentities = identities.filter(h => out.includes(h));
    assert(loggedTokens.length === 0 && loggedIdentities.length === 0,
        `the server printed no token and no platform identity (${loggedTokens.length} tokens, ${loggedIdentities.join(', ') || 'no identities'})`);
    assert(calls.other.length === 0, `nothing else was contacted (${calls.other.join(', ') || 'none'})`);

    // ── 8. The switch clears every badge no platform was asked about ────────────────────────
    const legacy = addChannel({ ownerPubkey: neighbour.pk, platform: 'tiktok', raw: '@a_real_neighbour', category: 'art' });
    const legacyYt = addChannel({ ownerPubkey: neighbour.pk, platform: 'youtube', raw: 'https://www.youtube.com/@neighbour_tube', category: 'art' });
    const stamp = new Date(Date.now() - DAY).toISOString();
    db.prepare(`UPDATE creator_channels SET oauth_verified_at = ?, supports_autolist = 1, updated_at = ? WHERE id IN (?, ?)`).run(stamp, stamp, legacy.id, legacyYt.id);
    db.prepare(`INSERT INTO pulse_items (id, channel_id, owner_pubkey, platform, category, source)
                VALUES ('item-legacy', ?, ?, 'tiktok', 'art', 'manual')`)
        .run(legacy.id, neighbour.pk);
    const cleared = clearUnprovenOauthBadges();
    const legacyRow = channelRow(legacy.id), legacyYtRow = channelRow(legacyYt.id);
    assert(cleared === 2 && legacyRow.oauth_verified_at === null && legacyYtRow.oauth_verified_at === null,
        `a badge with no platform account id is cleared at the switch (${cleared} cleared)`);
    assert(legacyRow.supports_autolist === 0 && legacyYtRow.supports_autolist === 1, 'each goes back to its platform\'s native autolist support');
    assert(legacyRow.updated_at > stamp, 'the clear bumps updated_at, so it replicates');
    assert(!!db.prepare(`SELECT 1 FROM pulse_items WHERE id = 'item-legacy'`).get(), 'items already ingested stay');
    assert(!!channelRow(art.id).oauth_verified_at && !!channelRow(ig.id).oauth_verified_at && !!channelRow(silent.id).oauth_verified_at,
        'badges the node proved survive the switch');
    assert(clearUnprovenOauthBadges() === 0, 'the switch runs once: the next boot clears nothing');

    setPlatformRequestForTests(null);
    rawOut(`\n${passed}/${run} passed\n`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
