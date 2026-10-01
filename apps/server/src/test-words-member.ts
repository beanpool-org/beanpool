/**
 * A member who came in with 12 words (the two-doors design §2.3, §2.5: scratch/global-node/DESIGN-global-two-doors-
 * fable.md): the same features as anyone, a slower start, one report to hide a post while new, and a sign-in they can add
 * at any time. Over REAL HTTPS through the real signature middleware, on the global profile. No provider is contacted:
 * the Google JWKS is a test key, as in test-open-join. "The clock" is moved by moving rows back in time (members.joined_at,
 * a post's created_at), which is all the rules read.
 *
 *   1. the 12-words rules: /api/community/me says `words`, 2 posts, 4 photos, 3 new people a day, 7 days; the 3rd post in
 *      24 hours → 429 probation_limit saying why and that a sign-in lifts it; 5 photos on a post → 429, 4 → 200; a 4th
 *      new person → 429, while a reply to someone who wrote first is never limited. A sign-in member beside them keeps
 *      the ordinary 3 posts. Four days in with 3 kept posts a 12-words member is still on probation, a sign-in member is
 *      not; eight days in, neither
 *   2. one report: an established member's single report (off probation: 10 days, 3 kept posts) hides a 12-words
 *      newcomer's post; the same report on a sign-in newcomer's post hides nothing (3 needed); a report from a member under
 *      7 days old hides nothing; nor does one from a member still on probation however old (a 12-words member 8 days in
 *      with no kept posts, an invited member 10 days in with none), while an established member's on the same post does
 *   3. adding a sign-in (POST /api/join/link): unsigned → 401; a key that is no member → 403; a sign-in member → 409
 *      already_linked; a member who joined another way (the genesis owner) → 409 not_words_member; a sign-in account
 *      another member joined with → 409 already_joined, a removed member's → 403 removed, the row still `words` after
 *      each, and neither counted as a failed join in the funnel; the link nonce is bound to adding a sign-in for this
 *      key: a recovery nonce is refused there and a link nonce on the recovery route, without spending it; a vault
 *      ticket where the door takes none → 401 ticket_unsupported
 *   4. the link: 200 with the recovery copy stored from the same sign-in; the row is that provider's, its hash the
 *      node's for that account, `joined_at` kept and `updated_at` stamped, `invited_by` still open:words; the member is
 *      on the ordinary rules at once, counted from the original join (off probation four days in with 3 kept posts); the
 *      sign-in account is theirs now (a new key joining with it → 409 already_joined); a second link → 409
 *      already_linked; one report no longer hides their post
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-words-member.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.GOOGLE_CLIENT_IDS;
delete process.env.BEANPOOL_VAULT_TICKET_KEYS;

import crypto from 'node:crypto';
import { sealSeedToSso, solveDoorWorkSync } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, createPost, adminPruneUser } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { _resetJwksCacheForTests, _clearNoncesForTests } from './sso.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { openJoinHash } from './engine/open-join.js';
import { nodeSha256 } from './services/door-work.js';
import { lockedDm } from './dm-test-payload.js';
import { getFunnel } from './engine/funnel.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const GOOGLE_KID = 'test-words-member-google';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
function mint(sub: string, nonce: string): string {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', kid: GOOGLE_KID, typ: 'JWT' });
    const payload = b64({ iss: 'https://accounts.google.com', aud: GOOGLE_AUD, sub, email_verified: true, iat: now, exp: now + 3600, nonce });
    return `${header}.${payload}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), google.privateKey).toString('base64url')}`;
}

interface Id { pk: string; priv: crypto.KeyObject; seed: Uint8Array; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'),
        priv: privateKey,
        seed: new Uint8Array((privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).subarray(-32)),
        name,
    };
}

interface Res { status: number; body: any }
async function call(method: 'GET' | 'POST', id: Id | null, path: string, body?: unknown): Promise<Res> {
    resetGatewayRateLimit();
    pruneAuthAttempts(Date.now() + 120_000);
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : raw });
    let parsed: any;
    try { parsed = await res.json(); } catch { parsed = undefined; }
    return { status: res.status, body: parsed };
}
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)}`;

const DAY = 24 * 3600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const AVATAR = 'https://example.com/a.jpg';

/** Joins by 12 words, with a photo (posting needs one). */
async function wordsMember(name: string): Promise<Id> {
    const id = newId(name);
    const w = await call('POST', id, '/api/join/work', { door: 'words' });
    const work = { challenge: w.body?.work?.challenge, counters: solveDoorWorkSync(w.body?.work?.challenge, nodeSha256) };
    const j = await call('POST', id, '/api/join', { door: 'words', callsign: name, work });
    if (j.status !== 200) throw new Error(`${name} did not join by 12 words: ${show(j)}`);
    db.prepare('UPDATE members SET avatar_url = ? WHERE public_key = ?').run(AVATAR, id.pk);
    return id;
}
/** Joins with a Google sign-in, with a photo. */
async function signInMember(name: string, sub: string): Promise<Id> {
    const id = newId(name);
    const n = await call('POST', id, '/api/join/sso-nonce', {});
    const j = await call('POST', id, '/api/join', { callsign: name, provider: 'google', idToken: mint(sub, n.body?.nonce), nonce: n.body?.nonce });
    if (j.status !== 200) throw new Error(`${name} did not join with a sign-in: ${show(j)}`);
    db.prepare('UPDATE members SET avatar_url = ? WHERE public_key = ?').run(AVATAR, id.pk);
    return id;
}
/** A member of `daysAgo` days, written straight in (as test-global-moderation does), to report with. */
function oldMember(name: string, daysAgo: number, owner: Id): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_url, status)
                VALUES (?, ?, ?, ?, 'TEST', ?, 'active')`).run(id.pk, name, ago(daysAgo * DAY), owner.pk, AVATAR);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    return id;
}
let n = 0;
const post = (id: Id, extra: Record<string, unknown> = {}) =>
    call('POST', id, '/api/marketplace/posts', { type: 'offer', category: 'other', title: `${id.name} offer ${++n}`, description: 'An offer', credits: 0, authorPublicKey: id.pk, ...extra });
/** Kept posts from two days ago, out of every window. */
function keptPosts(id: Id, count: number): void {
    for (let i = 0; i < count; i++) {
        const p = createPost('offer', 'other', `${id.name} old ${i}`, 'An old offer', 0, 'fixed', id.pk)!;
        db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(ago(2 * DAY), p.id);
    }
}
const photo = (seed: string) => {
    const scan = crypto.createHash('sha512').update(seed).digest().map(b => (b === 0xff ? 0xfe : b));
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]), scan, Buffer.from([0xff, 0xd9])]);
    return `data:image/jpeg;base64,${bytes.toString('base64')}`;
};
const openDm = (from: Id, to: Id) => call('POST', from, '/api/messages/conversation', { type: 'dm', participants: [from.pk, to.pk], createdBy: from.pk });
const line = (from: Id, conversationId: string) => call('POST', from, '/api/messages/send', { conversationId, authorPubkey: from.pk, ...lockedDm() });
const report = (reporter: Id, postId: string, author: Id) =>
    call('POST', reporter, '/api/reports', { reporterPubkey: reporter.pk, targetPubkey: author.pk, targetPostId: postId, reason: 'spam' });
const hiddenAt = (postId: string) => (db.prepare('SELECT hidden_by_reports_at FROM posts WHERE id = ?').get(postId) as any)?.hidden_by_reports_at ?? null;
const probation = async (id: Id) => (await call('GET', id, '/api/community/me')).body?.probation;
const joinRow = (pk: string) => db.prepare('SELECT * FROM open_joins WHERE member_pubkey = ?').get(pk) as any;
/** Today's `open_join_failed`, every reason, in the onboarding funnel. */
const failedJoins = () => getFunnel(1).filter(r => r.event === 'open_join_failed').reduce((n, r) => n + r.count, 0);
const setJoined = (id: Id, ms: number) => db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(ago(ms), id.pk);

async function main(): Promise<void> {
    console.log('\n=== A member who came in with 12 words ===\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    _resetJwksCacheForTests();
    _resetJwksCacheForTests('google', { keys: [{ ...google.publicKey.export({ format: 'jwk' }), kid: GOOGLE_KID, alg: 'RS256', use: 'sig' } as any], expiresAt: Date.now() + 3600_000 });
    _clearNoncesForTests();
    process.env.NODE_PROFILE = 'global';

    const owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    // Established: ten days a member and 3 kept posts, so off probation (design §2.3).
    const rep = oldMember('Rep', 10, owner);
    keptPosts(rep, 3);
    const fresh = oldMember('Fresh', 1, owner);

    // ── 1. the 12-words rules ────────────────────────────────────────────────────────────────────
    console.log('── 1. the 12-words rules ──');
    const wes = await wordsMember('Wes');
    const sam = await signInMember('Sam', 'sam-google-sub');
    const wesRules = await probation(wes);
    const samRules = await probation(sam);
    assert(wesRules?.onProbation === true && wesRules?.rules === 'words' && wesRules?.limits?.posts?.limit === 2 && wesRules?.limits?.photos?.limit === 4
        && wesRules?.limits?.new_dm_recipients?.limit === 3 && wesRules?.endsWhen?.hours === 168 && wesRules?.endsWhen?.keptPosts === 3,
        `Wes (12 words): /api/community/me says the 12-words rules, 2 posts, 4 photos, 3 new people, 7 days and 3 kept posts (${JSON.stringify(wesRules)})`);
    assert(samRules?.rules === 'ordinary' && samRules?.limits?.posts?.limit === 3 && samRules?.endsWhen?.hours === 72,
        `Sam (a sign-in): the ordinary rules, 3 posts, 72 hours (${JSON.stringify({ rules: samRules?.rules, posts: samRules?.limits?.posts?.limit })})`);
    const wesPosts = [await post(wes), await post(wes), await post(wes)];
    assert(wesPosts[0].status === 200 && wesPosts[1].status === 200 && wesPosts[2].status === 429 && wesPosts[2].body?.code === 'probation_limit'
        && /make 2 posts in any 24 hours/.test(wesPosts[2].body?.error) && /first 7 days/.test(wesPosts[2].body?.error) && /Adding a sign-in lifts them/.test(wesPosts[2].body?.error),
        `Wes's 3rd post in 24 hours → 429 probation_limit, saying the 12-words limit and that a sign-in lifts it (${show(wesPosts[2])})`);
    const samPosts = [await post(sam), await post(sam), await post(sam), await post(sam)];
    assert(samPosts.slice(0, 3).every(r => r.status === 200) && samPosts[3].status === 429,
        `Sam, beside him, keeps the ordinary 3 (${samPosts.map(r => r.status).join(', ')})`);
    const pip = await wordsMember('Pip');
    const fivePhotos = await post(pip, { photos: ['1', '2', '3', '4', '5'].map(photo) });
    const fourPhotos = await post(pip, { photos: ['6', '7', '8', '9'].map(photo) });
    assert(fivePhotos.status === 429 && fivePhotos.body?.code === 'probation_limit' && fourPhotos.status === 200,
        `Pip (12 words): 5 photos on a post → 429, 4 → 200 (${fivePhotos.status}, ${fourPhotos.status})`);
    const people = [1, 2, 3, 4].map(i => oldMember(`Person${i}`, 30, owner));
    const opened = [];
    for (const p of people) opened.push(await openDm(wes, p));
    assert(opened.slice(0, 3).every(r => r.status === 200) && opened[3].status === 429 && opened[3].body?.code === 'probation_limit',
        `Wes reaches 3 new people; the 4th → 429 (${opened.map(r => r.status).join(', ')})`);
    const writer = oldMember('Writer', 30, owner);
    const toWes = await openDm(writer, wes);
    const writerLine = await line(writer, toWes.body?.conversation?.id);
    const reply = await line(wes, toWes.body?.conversation?.id);
    assert(toWes.status === 200 && writerLine.status === 200 && reply.status === 200, `a reply to someone who wrote first is never limited (${reply.status})`);
    // Four days in, 3 kept posts: past a sign-in member's 72 hours, inside the 12-words 7 days.
    const vin = await wordsMember('Vin');
    const una = await signInMember('Una', 'una-google-sub');
    for (const id of [vin, una]) { setJoined(id, 4 * DAY); keptPosts(id, 3); }
    const vinDay4 = await probation(vin);
    const unaDay4 = await probation(una);
    assert(vinDay4?.onProbation === true && unaDay4?.onProbation === false,
        `four days in with 3 kept posts: still new by 12 words (${vinDay4?.onProbation}), past it with a sign-in (${unaDay4?.onProbation})`);
    setJoined(vin, 8 * DAY);
    assert((await probation(vin))?.onProbation === false, 'eight days in, the 12-words member is past it too: it ends by itself');

    // ── 2. one report ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. one report hides a 12-words newcomer\'s post ──');
    const pipPost = fourPhotos.body?.post?.id ?? fourPhotos.body?.id;
    const samPost = samPosts[0].body?.post?.id ?? samPosts[0].body?.id;
    const wesPost = wesPosts[0].body?.post?.id ?? wesPosts[0].body?.id;
    const r1 = await report(rep, pipPost, pip);
    assert(r1.status === 200 && !!hiddenAt(pipPost), `one report from an established member hides Pip's post, pending review (${r1.status}, ${hiddenAt(pipPost)})`);
    const r2 = await report(rep, samPost, sam);
    assert(r2.status === 200 && hiddenAt(samPost) === null, `the same member's report on Sam's post hides nothing: a sign-in newcomer's needs 3 (${r2.status})`);
    const r3 = await report(fresh, wesPost, wes);
    assert(r3.status === 200 && hiddenAt(wesPost) === null, `a report from a member a day old hides nothing, even a 12-words newcomer's (${r3.status})`);
    // A newcomer's report hides nothing (design §2.3, §7.3), however old the account: Sly came in by 12 words 8 days
    // ago and never posted, so he is still on probation. Then Rep, established, reports the same post: hidden.
    const sly = await wordsMember('Sly');
    setJoined(sly, 8 * DAY);
    const slyRules = await probation(sly);
    const nia = await wordsMember('Nia');
    const niaPost = await post(nia);
    const niaPostId = niaPost.body?.post?.id ?? niaPost.body?.id;
    const r5 = await report(sly, niaPostId, nia);
    assert(slyRules?.onProbation === true && slyRules?.rules === 'words' && niaPost.status === 200 && r5.status === 200 && hiddenAt(niaPostId) === null,
        `Sly, 8 days a 12-words member with 0 kept posts (on probation: ${slyRules?.onProbation}, ${slyRules?.rules}), reports Nia's post: it stays up (${r5.status}, ${hiddenAt(niaPostId)})`);
    const veg = oldMember('Veg', 10, owner);
    const r6 = await report(veg, niaPostId, nia);
    assert(r6.status === 200 && hiddenAt(niaPostId) === null,
        `nor an invited member 10 days in with no kept posts, still on probation (${r6.status}, ${hiddenAt(niaPostId)})`);
    const r7 = await report(rep, niaPostId, nia);
    assert(r7.status === 200 && !!hiddenAt(niaPostId), `then Rep, established, reports it: hidden (${r7.status}, ${hiddenAt(niaPostId)})`);

    // ── 3. adding a sign-in: the refusals ────────────────────────────────────────────────────────
    console.log('\n── 3. adding a sign-in: the refusals ──');
    const rob = await signInMember('Rob', 'rob-google-sub');
    adminPruneUser(rob.pk, 'owner:password');
    const linkNonce = async (id: Id) => call('POST', id, '/api/join/link/sso-nonce', {});
    const link = (id: Id, sub: string, nonce: string, extra: Record<string, unknown> = {}) =>
        call('POST', id, '/api/join/link', { provider: 'google', idToken: mint(sub, nonce), nonce, ...extra });
    assert((await call('POST', null, '/api/join/link/sso-nonce', {})).status === 401, 'unsigned → 401');
    const stranger = await linkNonce(newId('Stranger'));
    assert(stranger.status === 403 && stranger.body?.code === 'not_a_member', `a key that is no member here → 403 not_a_member (${show(stranger)})`);
    const samLink = await linkNonce(sam);
    assert(samLink.status === 409 && samLink.body?.code === 'already_linked', `a sign-in member → 409 already_linked (${show(samLink)})`);
    const ownerLink = await linkNonce(owner);
    assert(ownerLink.status === 409 && ownerLink.body?.code === 'not_words_member', `a member who joined another way (the genesis owner) → 409 not_words_member (${show(ownerLink)})`);
    const failedBefore = failedJoins();
    const wesNonce1 = (await linkNonce(wes)).body?.nonce as string;
    const takenBySam = await link(wes, 'sam-google-sub', wesNonce1);
    assert(takenBySam.status === 409 && takenBySam.body?.code === 'already_joined' && joinRow(wes.pk)?.provider === 'words',
        `Sam's Google account → 409 already_joined, and Wes's row is still words (${show(takenBySam)})`);
    const wesNonce2 = (await linkNonce(wes)).body?.nonce as string;
    const robs = await link(wes, 'rob-google-sub', wesNonce2);
    assert(robs.status === 403 && robs.body?.code === 'removed' && joinRow(wes.pk)?.provider === 'words',
        `the Google account of Rob, whom the community removed → 403 removed: it lifts no new account (${show(robs)})`);
    assert(failedJoins() === failedBefore, `neither link refusal is counted as a failed join in the onboarding funnel (open_join_failed ${failedBefore} → ${failedJoins()})`);
    const recoveryNonce = (await call('POST', wes, '/api/recovery/sso-nonce', {})).body?.nonce as string;
    const withRecoveryNonce = await link(wes, 'wes-google-sub', recoveryNonce);
    assert(withRecoveryNonce.status === 401 && withRecoveryNonce.body?.code === 'sign_in' && joinRow(wes.pk)?.provider === 'words',
        `a recovery nonce is not a link nonce → 401 (${show(withRecoveryNonce)})`);
    const wesNonce3 = (await linkNonce(wes)).body?.nonce as string;
    const sealed = await sealSeedToSso(wes.seed, 'google', 'wes-google-sub');
    const shares = [{ holderType: 'sso', holderRef: 'google', shareIndex: 1, ...sealed }];
    const onRecovery = await call('POST', wes, '/api/recovery/shares/sso', { provider: 'google', idToken: mint('wes-google-sub', wesNonce3), nonce: wesNonce3, shares });
    assert(onRecovery.status >= 400 && onRecovery.status < 500, `nor a link nonce a recovery one: refused on the recovery route (${onRecovery.status})`);
    const ticketHere = await link(wes, 'wes-google-sub', wesNonce3, { vaultTicket: 'not.a-ticket' });
    assert(ticketHere.status === 401 && ticketHere.body?.code === 'ticket_unsupported', `a vault ticket where the door takes none → 401 ticket_unsupported (${show(ticketHere)})`);

    // ── 4. the link ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. the link ──');
    setJoined(wes, 4 * DAY);
    keptPosts(wes, 3);
    const joinedBefore = (db.prepare('SELECT joined_at FROM members WHERE public_key = ?').get(wes.pk) as any).joined_at;
    const rowBefore = joinRow(wes.pk);
    assert((await probation(wes))?.onProbation === true, 'setup: Wes four days in, 3 kept posts, still new by 12 words');
    const linked = await link(wes, 'wes-google-sub', wesNonce3, { recovery: { shares } });
    const rowAfter = joinRow(wes.pk);
    assert(linked.status === 200 && linked.body?.success === true && linked.body?.provider === 'google' && linked.body?.recovery?.enrolled === true,
        `the link nonce, unspent by the refusals above, adds Google, and the recovery copy is stored from the same sign-in (${show(linked)})`);
    assert(rowAfter?.provider === 'google' && rowAfter?.join_hash === openJoinHash('google', 'wes-google-sub') && rowAfter?.joined_at === rowBefore?.joined_at
        && rowAfter?.updated_at > rowBefore?.updated_at && (db.prepare('SELECT invited_by FROM members WHERE public_key = ?').get(wes.pk) as any).invited_by === 'open:words'
        && (db.prepare('SELECT joined_at FROM members WHERE public_key = ?').get(wes.pk) as any).joined_at === joinedBefore,
        'the row is Google\'s now, its hash the node\'s for that account, joined_at kept and updated_at stamped (it travels); invited_by still open:words');
    const wesNow = await probation(wes);
    assert(wesNow?.rules === 'ordinary' && wesNow?.onProbation === false,
        `on the ordinary rules at once, counted from his original join: four days in with 3 kept posts, past probation (${JSON.stringify({ rules: wesNow?.rules, on: wesNow?.onProbation })})`);
    const someoneElse = newId('Copycat');
    const ccNonce = (await call('POST', someoneElse, '/api/join/sso-nonce', {})).body?.nonce as string;
    const copycat = await call('POST', someoneElse, '/api/join', { callsign: 'Copycat', provider: 'google', idToken: mint('wes-google-sub', ccNonce), nonce: ccNonce });
    assert(copycat.status === 409 && copycat.body?.code === 'already_joined', `the Google account is Wes's now: a new key joining with it → 409 already_joined (${show(copycat)})`);
    const twice = await linkNonce(wes);
    assert(twice.status === 409 && twice.body?.code === 'already_linked', `a second link → 409 already_linked (${show(twice)})`);
    const wesNewPost = await post(wes);
    const wesNewPostId = wesNewPost.body?.post?.id ?? wesNewPost.body?.id;
    const r4 = await report(rep, wesNewPostId, wes);
    assert(wesNewPost.status === 200 && r4.status === 200 && hiddenAt(wesNewPostId) === null, 'and one report no longer hides his post');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ A 12-words member: every feature, a slower start, one report while new, and a sign-in to add whenever they like.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
