/**
 * Test Suite: the default Home's node half (scratch/fable-design/DESIGN-home-default-fable.md §2.4, §2.5, §2.7, §5.3, slice D1;
 * Marty's picks of 13 Nov 2026), over REAL HTTPS through the real signature middleware, on a local community:
 *   1. `me.wayBack` and the safety card: an invited member with no sign-in gets `wayBack: 'words'` and the card (asked for
 *      by `cards=safety`, as the default list asks); one with a sign-in's copy linked here gets `covered` and no card,
 *      however they joined. A sign-in's copy of an older generation is no way back.
 *   2. "I still have my 12 words" kept on the account (`words_kept`, one way: a false never un-sets it), and the recovery
 *      kit saved writing the same record: the safety card goes, First steps' `words` line is ticked, `wayBack` stays what
 *      the node can see.
 *   3. `me.invitedBy`: the name and key of whoever's invite they used, in the invitee's own answer and no one else's; none
 *      for a member nobody invited, nor once the inviter has gone.
 *   4. The new-account limits for an invited member are unchanged: their own rule (ordinary), not `wayBack`.
 *   5. First steps on a local community: there on day 29 with a line left, absent on day 31, absent once every line is done;
 *      its `words` line: null when the account is covered, false while the words are the only way back, true once kept.
 *   6. The community card writes no zero figure: no trades, events or Commons pot of 0.
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
    console.log('── 1. wayBack and the safety card, by what the account has, not how it joined ──');
    const b0 = await home(ben);
    assert(b0.status === 200, `setup: Ben (invited) reads Home (${b0.status})`);
    assert(b0.json?.me?.wayBack === 'words', `an invited member with no sign-in gets wayBack words (${b0.json?.me?.wayBack})`);
    assert(b0.json?.cards?.safety?.words === true, `and the safety card (${JSON.stringify(b0.json?.cards?.safety)})`);
    linkSignIn(cleo.pk);
    const c0 = await home(cleo);
    assert(c0.json?.me?.wayBack === 'covered', `one with a sign-in's copy linked here gets wayBack covered (${c0.json?.me?.wayBack})`);
    assert(c0.json?.cards?.safety === undefined, `and no safety card (${JSON.stringify(c0.json?.cards?.safety)})`);
    // A copy of an older generation is no copy: a re-split dropped it (engine/recovery-shares.ts).
    linkSignIn(dev.pk, 1);
    db.prepare(`INSERT INTO recovery_shares (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag, generation)
                VALUES (?, 'hub', 'self', 2, 'x', 'x', 'x', 2)`).run(dev.pk);
    const d0 = await home(dev);
    assert(d0.json?.me?.wayBack === 'words' && d0.json?.cards?.safety?.words === true,
        `a sign-in's copy of an older generation is no way back: words, and the card (${d0.json?.me?.wayBack})`);
    // An open-door words member is covered by the same rule (two-doors §2.5): words until a sign-in, then covered.
    const eve = makeMember('WayBackEve', { invitedBy: ana.pk });
    db.prepare("INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at) VALUES (?, 'words', ?, ?)").run(eve.pk, `words:${crypto.randomUUID()}`, new Date().toISOString());
    const e0 = await home(eve);
    linkSignIn(eve.pk);
    const e1 = await home(eve);
    assert(e0.json?.cards?.safety?.words === true && e1.json?.cards?.safety === undefined && e1.json?.me?.wayBack === 'covered',
        `a 12-words joiner: the card until a sign-in is linked, then covered and none (${e0.json?.me?.wayBack} → ${e1.json?.me?.wayBack})`);
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
    assert(after.json?.cards?.safety === undefined, `the safety card goes once the words are kept (${JSON.stringify(after.json?.cards?.safety)})`);
    assert(after.json?.cards?.steps?.words === true, `First steps' words line is ticked (${after.json?.cards?.steps?.words})`);
    assert(after.json?.me?.wayBack === 'words', `wayBack stays what the node can see: words (${after.json?.me?.wayBack})`);
    const unkept = await savePrefs(ben, { words_kept: false });
    const still = await home(ben, 'steps');
    assert(unkept.status === 200 && still.json?.cards?.steps?.words === true, `a false never un-sets it: a done step never un-ticks (${still.json?.cards?.steps?.words})`);
    const own = await signed('GET', `/api/members/preferences?publicKey=${ben.pk}`, ben);
    assert(own.status === 200 && own.json?.words_kept === true, `the record is the member's own to read back (${own.status} ${own.text.slice(0, 160)})`);
    const other = await signed('GET', `/api/members/preferences?publicKey=${ben.pk}`, dev);
    assert(other.status === 403 && !other.text.includes('words_kept'), `and nobody else's: Dev asking for Ben's is refused (${other.status})`);
    // The kit saved writes the same record: the phone's half sends it (slice D2); here the record a kit save sends.
    const kit = makeMember('WayBackKit', { invitedBy: ana.pk });
    const k0 = await home(kit);
    await savePrefs(kit, { words_kept: true });
    const k1 = await home(kit);
    assert(k0.json?.cards?.safety?.words === true && k1.json?.cards?.safety === undefined && k1.json?.cards?.steps?.words === true,
        'the kit saved, sent as the same record: the card goes and the line is ticked');
    // Nobody else's write reaches it: Dev keeps his card.
    const d1 = await home(dev);
    assert(d1.json?.cards?.safety?.words === true, 'another member\'s record changes nothing of Dev\'s');
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
    assert(com.tradesThisMonth === undefined && com.eventsSoon === undefined, `a fresh community has no trades or events this month: left out (${JSON.stringify(com)})`);
    assert(typeof com.joined7d === 'number' && com.joined7d > 0, `a figure that is not zero is still written: joined this week ${com.joined7d}`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Home way-back checks PASSED.');
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
