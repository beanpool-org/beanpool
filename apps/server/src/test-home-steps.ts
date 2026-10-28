/**
 * Test Suite: The First Week card (L3 §3.2, §6) on the global node:
 *   1. Initial state: a fresh member sees the 7 global steps (name, area, photo, sawLedger, firstPost, saidHello, watch).
 *   2. Step facts and persistence: each step becomes true from node facts; each completed step is stamped into
 *      member_preferences ('step_<key>') so that a done step never un-ticks even if the underlying resource is removed.
 *   3. Standby guard: a backup/standby server (standbyWritesNothing) computes facts without writing 'step_*' to
 *      member_preferences and without bumping members.updated_at.
 *   4. End rule on global community: the card ends (returns undefined) after 14 days OR when every step is done
 *      (young && undone).
 *   5. End rule on local community: contrast with local profile where young || undone keeps the card for 14 days or until done.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-home-steps.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, setMemberPreferences } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { setMemberArea } from './engine/member-area.js';
import { setNodeRole, standbyWritesNothing } from './config/node-role.js';
import { setMemberPhoto } from '@beanpool/engine';

let PORT = 0;
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

interface Id {
    pubKeyHex: string;
    privateKey: crypto.KeyObject;
    callsign: string;
}

function makeMember(callsign: string, joinedAtIso?: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    const joinedAt = joinedAtIso ?? new Date().toISOString();
    db.prepare(
        `INSERT OR IGNORE INTO members (public_key, callsign, joined_at, status)
         VALUES (?, ?, ?, 'active')`
    ).run(pubKeyHex, callsign, joinedAt);
    return { pubKeyHex, privateKey, callsign };
}

async function signedFetch(method: 'GET' | 'POST', path: string, id: Id, body?: any) {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const signPath = path.split('?')[0];
    const canonical = `${method}\n${signPath}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
    let json: any;
    try { json = await res.json(); } catch { /* */ }
    return { status: res.status, headers: res.headers, json };
}

async function getHomeSteps(id: Id) {
    const res = await signedFetch('GET', '/api/home?cards=steps', id);
    assert(res.status === 200, `GET /api/home succeeded (${res.status}) for ${id.callsign}`);
    return res.json?.cards?.steps;
}

function hasStepPref(pubKeyHex: string, stepKey: string): boolean {
    const row = db.prepare(`SELECT 1 FROM member_preferences WHERE public_key = ? AND pref_key = ? AND pref_value = 'true'`).get(pubKeyHex, stepKey);
    return row !== undefined;
}

async function main() {
    console.log('=== Test Home Steps: First Week Card on Global Node ===\n');

    await initTls();
    initStateEngine();
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;

    // ── 1. Initial State for Fresh Member on Global Profile ─────────────────
    console.log('── 1. Initial State for Fresh Member ──');
    const alice = makeMember('AliceSteps');
    const steps0 = await getHomeSteps(alice);
    assert(steps0 !== undefined, 'steps card exists for a new member');
    assert(steps0.area === false, 'area is false initially');
    assert(steps0.photo === false, 'photo is false initially');
    assert(steps0.firstPost === false, 'firstPost is false initially');
    assert(steps0.saidHello === false, 'saidHello is false initially');
    assert(steps0.watch === false, 'watch is false initially');
    assert(steps0.sawLedger === false, 'sawLedger is false initially');
    assert(steps0.invited === null, 'invited is null on global profile (invites off)');

    // ── 2. Step Facts and Persistence ("a done step never un-ticks") ────────
    console.log('\n── 2. Step Facts and Persistence ──');

    // 2a. Area: set area -> true, persisted in step_area; clear area -> remains true
    setMemberArea(alice.pubKeyHex, { lat: -33.86, lng: 151.2 });
    const stepsArea = await getHomeSteps(alice);
    assert(stepsArea?.area === true, 'area is true after setting member area');
    assert(hasStepPref(alice.pubKeyHex, 'step_area'), 'step_area is persisted in member_preferences');
    setMemberArea(alice.pubKeyHex, null);
    const stepsAreaCleared = await getHomeSteps(alice);
    assert(stepsAreaCleared?.area === true, 'area remains true after clearing area (never un-ticks)');

    // 2b. Photo: set photo -> true, persisted in step_photo; clear photo -> remains true
    setMemberPhoto(db, alice.pubKeyHex, 'data:image/png;base64,iVBORw0KGgo=');
    const stepsPhoto = await getHomeSteps(alice);
    assert(stepsPhoto?.photo === true, 'photo is true after setting avatar');
    assert(hasStepPref(alice.pubKeyHex, 'step_photo'), 'step_photo is persisted in member_preferences');
    setMemberPhoto(db, alice.pubKeyHex, null);
    const stepsPhotoCleared = await getHomeSteps(alice);
    assert(stepsPhotoCleared?.photo === true, 'photo remains true after clearing avatar (never un-ticks)');

    // 2c. FirstPost: create offer post -> true, persisted in step_post; delete post -> remains true
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, active, status, origin_node)
                VALUES ('post-step-test', 'offer', 'food', 'Fresh basil', 'Grown at home', 5, ?, 1, 'active', NULL)`).run(alice.pubKeyHex);
    const stepsPost = await getHomeSteps(alice);
    assert(stepsPost?.firstPost === true, 'firstPost is true after creating post');
    assert(hasStepPref(alice.pubKeyHex, 'step_post'), 'step_post is persisted in member_preferences');
    db.prepare(`DELETE FROM posts WHERE id = 'post-step-test'`).run();
    const stepsPostDeleted = await getHomeSteps(alice);
    assert(stepsPostDeleted?.firstPost === true, 'firstPost remains true after deleting post (never un-ticks)');

    // 2d. SaidHello: test message -> true, persisted in step_hello; delete message -> remains true
    db.prepare(`INSERT OR IGNORE INTO conversations (id, type) VALUES ('conv-step-test', 'dm')`).run();
    db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce)
                VALUES ('msg-step-test', 'conv-step-test', ?, 'ciphertext', 'nonce')`).run(alice.pubKeyHex);
    const stepsHelloMsg = await getHomeSteps(alice);
    assert(stepsHelloMsg?.saidHello === true, 'saidHello is true after posting message');
    assert(hasStepPref(alice.pubKeyHex, 'step_hello'), 'step_hello is persisted in member_preferences');
    db.prepare(`DELETE FROM messages WHERE id = 'msg-step-test'`).run();
    const stepsHelloMsgDeleted = await getHomeSteps(alice);
    assert(stepsHelloMsgDeleted?.saidHello === true, 'saidHello remains true after deleting message (never un-ticks)');

    // SaidHello also true via dm_requests
    const bob = makeMember('BobDM');
    db.prepare(`INSERT INTO dm_requests (conversation_id, from_pubkey, to_pubkey, state, requested_at)
                VALUES ('conv-dm-req-test', ?, ?, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).run(bob.pubKeyHex, alice.pubKeyHex);
    const bobSteps = await getHomeSteps(bob);
    assert(bobSteps?.saidHello === true, 'saidHello is true from dm_requests');
    assert(hasStepPref(bob.pubKeyHex, 'step_hello'), 'step_hello persisted for DM requester');

    // 2e. Watch: insert place_watches -> true, persisted in step_watch; delete -> remains true
    db.prepare(`INSERT INTO place_watches (id, pubkey, lat, lng, radius_km)
                VALUES ('pw-step-test', ?, -33.86, 151.2, 25)`).run(alice.pubKeyHex);
    const stepsWatch = await getHomeSteps(alice);
    assert(stepsWatch?.watch === true, 'watch is true after adding place watch');
    assert(hasStepPref(alice.pubKeyHex, 'step_watch'), 'step_watch is persisted in member_preferences');
    db.prepare(`DELETE FROM place_watches WHERE id = 'pw-step-test'`).run();
    const stepsWatchDeleted = await getHomeSteps(alice);
    assert(stepsWatchDeleted?.watch === true, 'watch remains true after deleting place watch (never un-ticks)');

    // 2f. SawLedger: test via saw_ledger preference -> true, persisted in step_ledger
    setMemberPreferences(alice.pubKeyHex, { saw_ledger: true });
    // Note: Alice now has all 6 steps done! Once sawLedger is evaluated, all steps are done, so the card ends.
    // Let's verify sawLedger fact on a fresh member Carol first to inspect steps.sawLedger before completion.
    const carol = makeMember('CarolTour');
    setMemberPreferences(carol.pubKeyHex, { tour: { v: 1, state: 'done', at: new Date().toISOString() } });
    const carolSteps = await getHomeSteps(carol);
    assert(carolSteps?.sawLedger === true, 'sawLedger is true from completed tour record');
    assert(hasStepPref(carol.pubKeyHex, 'step_ledger'), 'step_ledger is persisted in member_preferences');

    // ── 3. Standby Guard (standbyWritesNothing) ─────────────────────────────
    console.log('\n── 3. Standby Guard (standbyWritesNothing) ──');
    const dave = makeMember('DaveStandby');
    setNodeRole('backup');
    assert(standbyWritesNothing() === true, 'standbyWritesNothing is true when node role is backup');

    // Give Dave an area while in backup mode
    setMemberArea(dave.pubKeyHex, { lat: 51.5, lng: -0.1 });
    const daveMemberBefore = db.prepare('SELECT updated_at FROM members WHERE public_key = ?').get(dave.pubKeyHex) as { updated_at: string };

    const daveStepsStandby = await getHomeSteps(dave);
    assert(daveStepsStandby?.area === true, 'standby still reports facts truthfully (area is true)');
    assert(!hasStepPref(dave.pubKeyHex, 'step_area'), 'standby wrote NO step_area preference');
    const daveMemberAfter = db.prepare('SELECT updated_at FROM members WHERE public_key = ?').get(dave.pubKeyHex) as { updated_at: string };
    assert(daveMemberAfter.updated_at === daveMemberBefore.updated_at, 'standby left members.updated_at untouched');

    // Switch back to primary role: now it writes and stamps
    setNodeRole('primary');
    assert(standbyWritesNothing() === false, 'standbyWritesNothing is false when node role is primary');
    const daveStepsPrimary = await getHomeSteps(dave);
    assert(daveStepsPrimary?.area === true, 'primary reports area true');
    assert(hasStepPref(dave.pubKeyHex, 'step_area'), 'primary persisted step_area preference');
    const daveMemberPrimary = db.prepare('SELECT updated_at FROM members WHERE public_key = ?').get(dave.pubKeyHex) as { updated_at: string };
    assert(daveMemberPrimary.updated_at >= daveMemberBefore.updated_at, 'primary bumped members.updated_at on step persist');

    // ── 4. End Rule on Global Community (young && undone) ───────────────────
    console.log('\n── 4. End Rule on Global Community (young && undone) ──');
    // 4a. Alice completed all 6 steps: area, photo, firstPost, saidHello, watch, sawLedger
    // Under young && undone, once all steps are done (undone === false), the card ends!
    const aliceStepsEnded = await getHomeSteps(alice);
    assert(aliceStepsEnded === undefined, 'global first-week card ends once every step is done');

    // 4b. Member older than 14 days with undone steps: card also ends
    const fourteenDaysAgo = new Date(Date.now() - 15 * 86400 * 1000).toISOString();
    const eve = makeMember('EveOldGlobal', fourteenDaysAgo);
    const eveSteps = await getHomeSteps(eve);
    assert(eveSteps === undefined, 'global first-week card ends after 14 days even if steps are undone');

    // 4c. Member younger than 14 days with undone steps: card is shown
    const frank = makeMember('FrankYoungGlobal');
    const frankSteps = await getHomeSteps(frank);
    assert(frankSteps !== undefined, 'global first-week card shows while young and steps undone');

    // ── 5. End Rule on Local Community (young || undone) ────────────────────
    console.log('\n── 5. End Rule on Local Community (young || undone) ──');
    process.env.NODE_PROFILE = 'local';

    // 5a. Young local member who completed all local steps: card stays while young (14 days)
    const grace = makeMember('GraceLocalYoung');
    // Complete local steps: firstOffer, photo, interests, invited
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, active, status, origin_node)
                VALUES ('post-grace-local', 'offer', 'food', 'Sourdough', 'Baked fresh', 5, ?, 1, 'active', NULL)`).run(grace.pubKeyHex);
    setMemberPhoto(db, grace.pubKeyHex, 'data:image/png;base64,iVBORw0KGgo=');
    setMemberPreferences(grace.pubKeyHex, { interests: ['food', 'garden'] });
    db.prepare(`INSERT INTO invite_codes (code, created_by, created_at) VALUES ('code-grace', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).run(grace.pubKeyHex);

    const graceSteps = await getHomeSteps(grace);
    assert(graceSteps !== undefined, 'local first-steps card stays while member is young even when all steps are done');

    // 5b. Older local member (>14 days) with undone steps: card stays while undone
    const heidi = makeMember('HeidiLocalOld', fourteenDaysAgo);
    const heidiStepsUndone = await getHomeSteps(heidi);
    assert(heidiStepsUndone !== undefined, 'local first-steps card stays after 14 days while steps are undone');

    // Once older member finishes all local steps: card ends
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, active, status, origin_node)
                VALUES ('post-heidi-local', 'offer', 'food', 'Jam', 'Sweet strawberry jam', 3, ?, 1, 'active', NULL)`).run(heidi.pubKeyHex);
    setMemberPhoto(db, heidi.pubKeyHex, 'data:image/png;base64,iVBORw0KGgo=');
    setMemberPreferences(heidi.pubKeyHex, { interests: ['food'] });
    db.prepare(`INSERT INTO invite_codes (code, created_by, created_at) VALUES ('code-heidi', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).run(heidi.pubKeyHex);

    const heidiStepsDone = await getHomeSteps(heidi);
    assert(heidiStepsDone === undefined, 'local first-steps card ends when older member has done every step');

    // Restore profile
    process.env.NODE_PROFILE = 'global';

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Home steps checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
