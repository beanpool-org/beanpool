/**
 * Test Suite: the default Home's node half (scratch/fable-design/DESIGN-home-default-fable.md §2.4, §2.5, §2.7, §5.3, slice D1;
 * Marty's picks of 13 Nov 2026), over REAL HTTPS through the real signature middleware, on a local community:
 *   1. `me.wayBack`: an invited member, a member nobody invited, or a sign-in joiner with no copy here gets `words`; one
 *      with a sign-in's copy linked here gets `covered`, however they joined. A copy of an older generation is no way back.
 *      The safety card (asked for by `cards=safety`, as the default list asks) keeps the 12-words door's rule until slices
 *      D2 and D3 (review of #3110, round 2): a 12-words joiner with no sign-in, and nobody else, so Home's word and
 *      /api/community/me's `rules` agree for every one of them.
 *   2. "I still have my 12 words" kept on the account (`words_kept`, one way: a false never un-sets it), and the recovery
 *      kit saved writing the same record: First steps' `words` line is ticked, a 12-words joiner's safety card goes,
 *      `wayBack` stays what the node can see.
 *   3. `me.invitedBy`: the name and key of whoever's invite they used, in the invitee's own answer and no one else's; none
 *      for a member nobody invited, nor once the inviter has gone.
 *   4. The new-account limits for an invited member are unchanged: their own rule (ordinary), not `wayBack`.
 *   5. First steps on a local community: there on day 29 with a line left, absent on day 31, absent once every line is done;
 *      its `words` line: null when the account is covered, false while the words are the only way back, true once kept.
 *   6. The community card writes no zero figure: no trades, events or Commons pot of 0. Trades of 0 are left out; a
 *      member's who-joined, events and pot of 0 are sent as null, so the phone's card keeps its rows on a quiet week.
 *   7. `me.wordsKept` (review of #3114, finding 2): the account's "I still have my 12 words" on every answer of the
 *      member's own, false until said and true after, with no `steps` asked, once First steps' days are up (a global
 *      joiner on day 15) and once its last line is done: the 12-words card ends on it, not on First steps' line.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-home-way-back.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, setMemberPreferences } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { PROBATION, probationRuleSet } from './engine/probation.js';
import { setMemberPhoto } from '@beanpool/engine';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        process.exitCode = 1;
    }
}

interface Id { pk: string; privateKey: crypto.KeyObject; callsign: string }
const DAY = 86_400_000;

function makeMember(callsign: string, opts: { invitedBy?: string | null; joinedAt?: string } = {}): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pk = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, invited_by, invite_code) VALUES (?, ?, ?, 'active', ?, ?)`)
        .run(pk, callsign, opts.joinedAt ?? new Date().toISOString(), opts.invitedBy ?? null, opts.invitedBy ? `code-${callsign}` : null);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(pk);
    return { pk, privateKey, callsign };
}

async function signed(method: 'GET' | 'POST', path: string, id: Id, body?: unknown) {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'X-Public-Key': id.pk,
        'X-Signature': signRequest(id.privateKey, { method, path: path.split('?')[0], timestamp: ts, nonce, body: bodyString }),
        [SIGNED_FOR_HEADER]: signedForHost(),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json, text };
}

const home = (id: Id, cards = 'needs,safety,steps,community') => signed('GET', `/api/home?cards=${cards}`, id);
const savePrefs = (id: Id, preferences: Record<string, unknown>) => signed('POST', '/api/members/preferences', id, { publicKey: id.pk, preferences });

/** A sign-in's copy of the account linked here: one current `sso` share (the recovery-shares row a link writes). */
function linkSignIn(pk: string, generation = 1): void {
    db.prepare(`INSERT INTO recovery_shares (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag, generation)
                VALUES (?, 'sso', 'google', 1, 'x', 'x', 'x', ?)`).run(pk, generation);
}

/** A join through the open door with 12 words alone: its open-joins row says `words` (engine/open-join.ts). */
function wordsJoin(pk: string): void {
    db.prepare("INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at) VALUES (?, 'words', ?, ?)").run(pk, `words:${crypto.randomUUID()}`, new Date().toISOString());
}

async function main() {
    console.log('=== The default Home, node half (D1): wayBack, invitedBy, First steps 30 days, zero figures ===\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    db.prepare("INSERT INTO node_config (key, value) VALUES ('nodeProfile.probation', 'true') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

    const ana = makeMember('WayBackAna');
    const ben = makeMember('WayBackBen', { invitedBy: ana.pk });
    const cleo = makeMember('WayBackCleo', { invitedBy: ana.pk });
    const dev = makeMember('WayBackDev');

    // ── 1. wayBack and the safety card ─────────────────────────────────────────────────────────────────────────────
    console.log('── 1. wayBack by what the account has; the safety card by the 12-words door until D2/D3 ──');
    const b0 = await home(ben);
    assert(b0.status === 200, `setup: Ben (invited) reads Home (${b0.status})`);
    assert(b0.json?.me?.wayBack === 'words', `an invited member with no sign-in gets wayBack words (${b0.json?.me?.wayBack})`);
    // The card both apps draw today offers "Add a sign-in", which the node takes from a 12-words joiner alone
    // (routes/open-join.ts linkState: 404 invite_only on an invite-only community, 409 not_words_member where the door is
    // open). So, until slices D2 and D3, the card keeps that door's rule, the one /api/community/me's `rules` says
    // (review of #3110, round 2): an invited member gets none, whatever wayBack says.
    assert(b0.json?.cards?.safety === undefined, `but no safety card: an invited member's waits for D2/D3 (${JSON.stringify(b0.json?.cards?.safety)})`);
    const a0safety = await home(ana);
    assert(a0safety.json?.me?.wayBack === 'words' && a0safety.json?.cards?.safety === undefined,
        `a member nobody invited, with no 12-words row (the genesis owner's case): wayBack words, no card (${a0safety.json?.me?.wayBack}, ${JSON.stringify(a0safety.json?.cards?.safety)})`);
    // Joined with a sign-in, its copy not kept here (a community that keeps none, or a copy that failed to store): the
    // open-joins row names the sign-in, so the link route says already_linked. Words by wayBack, no card.
    const hal = makeMember('WayBackHal');
    db.prepare("INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at) VALUES (?, 'google', ?, ?)").run(hal.pk, `google:${crypto.randomUUID()}`, new Date().toISOString());
    const h0 = await home(hal);
    assert(h0.json?.me?.wayBack === 'words' && h0.json?.cards?.safety === undefined,
        `a sign-in joiner with no copy here: wayBack words, no card (${h0.json?.me?.wayBack}, ${JSON.stringify(h0.json?.cards?.safety)})`);
    linkSignIn(cleo.pk);
    const c0 = await home(cleo);
    assert(c0.json?.me?.wayBack === 'covered', `one with a sign-in's copy linked here gets wayBack covered (${c0.json?.me?.wayBack})`);
    assert(c0.json?.cards?.safety === undefined, `and no safety card (${JSON.stringify(c0.json?.cards?.safety)})`);
    // A copy of an older generation is no copy: a re-split dropped it (engine/recovery-shares.ts).
    linkSignIn(dev.pk, 1);
    db.prepare(`INSERT INTO recovery_shares (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag, generation)
                VALUES (?, 'hub', 'self', 2, 'x', 'x', 'x', 2)`).run(dev.pk);
    const d0 = await home(dev);
    assert(d0.json?.me?.wayBack === 'words' && d0.json?.cards?.safety === undefined,
        `a sign-in's copy of an older generation is no way back: words (no 12-words row, so no card yet) (${d0.json?.me?.wayBack})`);
    // A 12-words joiner: the card, and words, until they link a sign-in (the link moves the open-joins row to the
    // sign-in, engine/open-join.ts linkOpenJoin, and keeps its copy here); then covered, and no card.
    const eve = makeMember('WayBackEve', { invitedBy: ana.pk });
    wordsJoin(eve.pk);
    const e0 = await home(eve);
    db.prepare("UPDATE open_joins SET provider = 'google', join_hash = ? WHERE member_pubkey = ?").run(`google:${crypto.randomUUID()}`, eve.pk);
    linkSignIn(eve.pk);
    const e1 = await home(eve);
    assert(e0.json?.cards?.safety?.words === true && e0.json?.me?.wayBack === 'words' && e1.json?.cards?.safety === undefined && e1.json?.me?.wayBack === 'covered',
        `a 12-words joiner: the card until a sign-in is linked, then covered and none (${e0.json?.me?.wayBack} → ${e1.json?.me?.wayBack})`);
    // Home's word and /me's agree for every one of them (the web draws by Home's, and /me's arriving later never
    // pulled a card drawn at the first paint only because the two agree: review of #3110, round 1).
    const fay0 = makeMember('WayBackFayWords');
    wordsJoin(fay0.pk);
    for (const [who, id] of [['Ben (invited)', ben], ['Ana (nobody invited)', ana], ['Hal (sign-in, no copy)', hal], ['Cleo (covered)', cleo], ['Dev (old copy)', dev], ['Eve (linked)', eve], ['Fay (12 words)', fay0]] as const) {
        const h = await home(id);
        const me = await signed('GET', '/api/community/me', id);
        assert(me.status === 200 && (h.json?.cards?.safety?.words === true) === (me.json?.probation?.rules === 'words'),
            `${who}: Home's safety card and /me's rules agree (${JSON.stringify(h.json?.cards?.safety)} / ${me.json?.probation?.rules})`);
    }
    // With no cards= at all (an older app), wayBack is in `me` all the same.
    const bAll = await signed('GET', '/api/home', ben);
    assert(bAll.json?.me?.wayBack === 'words', `wayBack is in me with no cards= too (${bAll.json?.me?.wayBack})`);

    // ── 2. "I still have my 12 words", kept on the account ────────────────────────────────────────────────────────
    console.log('\n── 2. "I still have my 12 words" (and the recovery kit saved) kept on the account ──');
    const before = await home(ben, 'steps');
    assert(before.json?.cards?.steps?.words === false, `First steps' words line is open while the words are the only way back (${before.json?.cards?.steps?.words})`);
    const kept = await savePrefs(ben, { words_kept: true });
    assert(kept.status === 200, `saying "I still have my 12 words" is saved (${kept.status} ${kept.text.slice(0, 120)})`);
    const after = await home(ben);
    assert(after.json?.cards?.safety === undefined, `still no safety card (${JSON.stringify(after.json?.cards?.safety)})`);
    assert(after.json?.cards?.steps?.words === true, `First steps' words line is ticked (${after.json?.cards?.steps?.words})`);
    assert(after.json?.me?.wayBack === 'words', `wayBack stays what the node can see: words (${after.json?.me?.wayBack})`);
    const unkept = await savePrefs(ben, { words_kept: false });
    const still = await home(ben, 'steps');
    assert(unkept.status === 200 && still.json?.cards?.steps?.words === true, `a false never un-sets it: a done step never un-ticks (${still.json?.cards?.steps?.words})`);
    const own = await signed('GET', `/api/members/preferences?publicKey=${ben.pk}`, ben);
    assert(own.status === 200 && own.json?.words_kept === true, `the record is the member's own to read back (${own.status} ${own.text.slice(0, 160)})`);
    const other = await signed('GET', `/api/members/preferences?publicKey=${ben.pk}`, dev);
    assert(other.status === 403 && !other.text.includes('words_kept'), `and nobody else's: Dev asking for Ben's is refused (${other.status})`);
    // The kit saved writes the same record: the phone's half sends it (slice D2); here the record a kit save sends, by a
    // 12-words joiner, who has the card.
    const kit = makeMember('WayBackKit');
    wordsJoin(kit.pk);
    const k0 = await home(kit);
    await savePrefs(kit, { words_kept: true });
    const k1 = await home(kit);
    assert(k0.json?.cards?.safety?.words === true && k1.json?.cards?.safety === undefined && k1.json?.cards?.steps?.words === true,
        'the kit saved, sent as the same record: the card goes and the line is ticked');
    // Nobody else's write reaches it: Fay (12 words) keeps her card, and Dev his open line.
    const f1 = await home(fay0);
    assert(f1.json?.cards?.safety?.words === true, 'another member\'s record changes nothing of Fay\'s: her card stays');
    const d1 = await home(dev, 'steps');
    assert(d1.json?.cards?.steps?.words === false, `nor of Dev's: his words line is still open (${d1.json?.cards?.steps?.words})`);
    const c1 = await home(cleo, 'steps');
    assert(c1.json?.cards?.steps?.words === null, `the words line is not there for a covered account: null (${c1.json?.cards?.steps?.words})`);

    // ── 3. invitedBy, to the invitee alone ─────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. me.invitedBy: in the invitee\'s answer and no one else\'s ──');
    assert(JSON.stringify(b0.json?.me?.invitedBy) === JSON.stringify({ key: ana.pk, name: 'WayBackAna' }),
        `Ben's own answer names whoever's invite he used (${JSON.stringify(b0.json?.me?.invitedBy)})`);
    const a0 = await signed('GET', '/api/home', ana);
    assert(a0.status === 200 && a0.json?.me?.invitedBy === null, `Ana, invited by nobody, has none (${JSON.stringify(a0.json?.me?.invitedBy)})`);
    for (const [who, r] of [['Ana (the inviter)', a0], ['Dev', await signed('GET', '/api/home', dev)]] as const) {
        assert(!r.text.includes('"invitedBy":{'), `${who}'s answer carries nobody's invitedBy (${JSON.stringify(r.json?.me?.invitedBy)})`);
    }
    // The key in the query names nobody: the answer is the signer's own.
    const query = await signed('GET', `/api/home?publicKey=${ben.pk}`, dev);
    assert(query.json?.me?.invitedBy === null && !query.text.includes(ana.pk + '","name"'), 'a key in the query names nobody: Dev still gets his own me');
    // Gone: an inviter pruned since is not named, and the line is not drawn.
    const fay = makeMember('WayBackFay');
    const gil = makeMember('WayBackGil', { invitedBy: fay.pk });
    db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(fay.pk);
    const g0 = await home(gil);
    assert(g0.json?.me?.invitedBy === null, `an inviter who has gone is not named (${JSON.stringify(g0.json?.me?.invitedBy)})`);

    // ── 4. limits for an invited member unchanged ─────────────────────────────────────────────────────────────────
    console.log('\n── 4. the new-account limits keep their own rule ──');
    const lim = b0.json?.me?.probation;
    assert(probationRuleSet(ben.pk) === 'ordinary', 'setup: Ben came in by invite, the ordinary rule');
    assert(!!lim && lim.limits?.posts?.limit === PROBATION.posts && lim.limits?.new_dm_recipients?.limit === PROBATION.newDmRecipients
        && lim.limits?.photos?.limit === PROBATION.photos && lim.endsWhen?.hours === PROBATION.hours,
        `limits for an invited member are unchanged by wayBack words: posts ${lim?.limits?.posts?.limit}, new people ${lim?.limits?.new_dm_recipients?.limit}, ${lim?.endsWhen?.hours} h`);
    const b2 = await home(ben);
    assert(JSON.stringify(b2.json?.me?.probation?.limits) === JSON.stringify(lim?.limits), 'and the kept-words record changes none of them');

    // ── 5. First steps on a local community: 30 days, then gone ───────────────────────────────────────────────────
    console.log('\n── 5. First steps: a line left in the first 30 days ──');
    const day29 = makeMember('WayBackDay29', { invitedBy: ana.pk, joinedAt: new Date(Date.now() - 29 * DAY).toISOString() });
    const day31 = makeMember('WayBackDay31', { invitedBy: ana.pk, joinedAt: new Date(Date.now() - 31 * DAY).toISOString() });
    assert((await home(day29, 'steps')).json?.cards?.steps !== undefined, 'steps there on day 29 with a line left');
    assert((await home(day31, 'steps')).json?.cards?.steps === undefined, 'steps absent on day 31, lines left or not');
    // Every line done while young: the card leaves (only what is left is drawn, and nothing is).
    const done = makeMember('WayBackDone', { invitedBy: ana.pk });
    db.prepare(`INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey, active, status, origin_node)
                VALUES ('post-wayback-offer', 'offer', 'food', 'Bread', 'Fresh', 5, ?, 1, 'active', NULL),
                       ('post-wayback-need', 'need', 'food', 'Eggs', 'A dozen', 5, ?, 1, 'active', NULL)`).run(done.pk, done.pk);
    setMemberPhoto(db, done.pk, 'data:image/png;base64,iVBORw0KGgo=');
    setMemberPreferences(done.pk, { interests: ['food'] });
    db.prepare(`INSERT INTO invite_codes (code, created_by, created_at) VALUES ('code-wayback-done', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).run(done.pk);
    const notYet = await signed('GET', '/api/home?cards=steps&lands=first-need,words', done);
    assert(notYet.json?.cards?.steps?.words === false, 'setup: everything done but the words');
    await savePrefs(done, { words_kept: true });
    const allDone = await signed('GET', '/api/home?cards=steps&lands=first-need,words', done);
    assert(allDone.json?.cards?.steps === undefined, `every line done while young: First steps leaves (${JSON.stringify(allDone.json?.cards?.steps)})`);

    // ── 6. no zero figure on the community card ──────────────────────────────────────────────────────────────────
    console.log('\n── 6. the community card writes no zero ──');
    const com = (await home(ben, 'community')).json?.cards?.community ?? {};
    assert(typeof com.members === 'number' && com.members > 0, `setup: the community card is there (${JSON.stringify(com)})`);
    for (const key of ['tradesThisMonth', 'eventsSoon', 'commonsPot_c', 'communities']) {
        assert(com[key] !== 0, `no ${key} of 0 (${JSON.stringify(com[key])})`);
    }
    assert(com.tradesThisMonth === undefined && 'eventsSoon' in com && com.eventsSoon === null,
        `a fresh community has no trades or events this month: trades left out, events sent empty (${JSON.stringify(com)})`);
    assert(typeof com.joined7d === 'number' && com.joined7d > 0, `a figure that is not zero is still written: joined this week ${com.joined7d}`);
    // A quiet week (review of #3110): nobody joined, no event, no trade, a pot under a Bean. The phone's community card
    // (HomeCardBodies.tsx CommunityBody, every installed build) draws its rows, listings among them, only when one of
    // joined7d, eventsSoon or commonsPot_c is THERE, and writes each only when it is a number. So each is sent as null:
    // there, and not a zero. Left out, the card fell back to one line and "N listings" went.
    db.prepare('UPDATE members SET joined_at = ?').run(new Date(Date.now() - 30 * DAY).toISOString());
    const quiet = (await home(ben, 'community')).json?.cards?.community ?? {};
    assert(typeof quiet.listings === 'number' && ['tradesThisMonth', 'communities', 'joined7d', 'eventsSoon', 'commonsPot_c'].every(k => quiet[k] !== 0),
        `a quiet week: listings still counted, and no other figure of 0 (${JSON.stringify(quiet)})`);
    assert(['joined7d', 'eventsSoon'].every(k => k in quiet && quiet[k] === null) && quiet.tradesThisMonth === undefined,
        `a quiet week: who joined and events coming up are sent as null (present, not written), no trades (${JSON.stringify(quiet)})`);
    assert(!('commonsPot_c' in quiet) || quiet.commonsPot_c === null || (typeof quiet.commonsPot_c === 'number' && quiet.commonsPot_c > 0),
        `a quiet week: the Commons pot, where Beans are on, is a figure above zero or null (${JSON.stringify(quiet.commonsPot_c)})`);

    // ── 7. me.wordsKept: the account's say-so on its own, outliving First steps ───────────────────────────────────
    console.log('\n── 7. me.wordsKept on every answer of their own, after First steps has gone ──');
    const kim = makeMember('WayBackKim', { invitedBy: ana.pk });
    const kim0 = await home(kim, 'needs,community');
    assert(kim0.json?.me?.wordsKept === false && kim0.json?.me?.wayBack === 'words', `not said yet: wordsKept false (${kim0.json?.me?.wordsKept})`);
    await savePrefs(kim, { words_kept: true });
    const kim1 = await home(kim, 'needs,community');
    assert(kim1.json?.me?.wordsKept === true && kim1.json?.cards?.steps === undefined,
        `said: wordsKept true in me, with no steps asked (${kim1.json?.me?.wordsKept}, ${JSON.stringify(kim1.json?.cards?.steps)})`);
    // Every line of First steps done (the earlier member `done`): no steps at all, the say-so still in me.
    const doneMe = await signed('GET', '/api/home?cards=needs,safety,steps,community&lands=first-need,words', done);
    assert(doneMe.json?.cards?.steps === undefined && doneMe.json?.me?.wordsKept === true,
        `every First steps line done, so no steps: wordsKept still true in me (${JSON.stringify(doneMe.json?.cards?.steps)}, ${doneMe.json?.me?.wordsKept})`);
    // Past First steps' days (31 on a local community): no steps, and me says it either way.
    const old = makeMember('WayBackOld', { invitedBy: ana.pk, joinedAt: new Date(Date.now() - 31 * DAY).toISOString() });
    const old0 = await home(old);
    await savePrefs(old, { words_kept: true });
    const old1 = await home(old);
    assert(old0.json?.cards?.steps === undefined && old0.json?.me?.wordsKept === false && old1.json?.cards?.steps === undefined && old1.json?.me?.wordsKept === true,
        `past First steps' days: no steps, wordsKept false then true (${old0.json?.me?.wordsKept} → ${old1.json?.me?.wordsKept})`);
    // A covered account says it too (a say-so is not a way back: wayBack stays covered).
    await savePrefs(cleo, { words_kept: true });
    const cleo2 = await home(cleo);
    assert(cleo2.json?.me?.wayBack === 'covered' && cleo2.json?.me?.wordsKept === true, `a covered account's say-so: wayBack covered, wordsKept true (${cleo2.json?.me?.wayBack}, ${cleo2.json?.me?.wordsKept})`);
    // Nobody else's: Dev's answer says his own, not Kim's.
    const dev2 = await home(dev);
    assert(dev2.json?.me?.wordsKept === false, `another member's say-so is not in Dev's answer (${dev2.json?.me?.wordsKept})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Home way-back checks PASSED.');
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
