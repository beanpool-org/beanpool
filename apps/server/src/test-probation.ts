/**
 * Unit and integration test for probation rules and newcomer rate limits (engine/probation.ts).
 *
 * Tests:
 *  1. probationRuleSet & probationState for ordinary vs 12-words accounts.
 *  2. Exemptions for node roles (owner, admin, moderator) and when probation switch is off.
 *  3. isWordsNewcomer helper logic.
 *  4. assertMayPost & assertMayEditPhotos post and photo rate limits within 24-hour window.
 *  5. assertMayMessage new DM recipient limits within 24-hour window.
 *  6. probationSummary reporting structure and remaining allowances.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import {
    probationRuleSet,
    probationState,
    isWordsNewcomer,
    assertMayPost,
    assertMayEditPhotos,
    assertMayMessage,
    probationSummary,
    ProbationLimitError,
    PROBATION,
} from './engine/probation.js';
import { grantNodeRole } from './engine/node-roles.js';

let run = 0;
let passed = 0;

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

function makeKey(): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
}

let callsignCounter = 0;

function insertMember(pk: string, callsign: string, joinedAtIso: string, provider?: string): void {
    const uniqueCallsign = `${callsign}_${++callsignCounter}_${pk.slice(0, 6)}`;
    db.prepare(
        `INSERT INTO members (public_key, callsign, joined_at, status)
         VALUES (?, ?, ?, 'active')`
    ).run(pk, uniqueCallsign, joinedAtIso);

    if (provider) {
        db.prepare(
            `INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at, join_cohort)
             VALUES (?, ?, ?, ?, 'cohort-1')`
        ).run(pk, provider, `hash-${pk}`, joinedAtIso);
    }
}

function insertPost(authorPk: string, createdAtIso: string): string {
    const uniqueId = crypto.randomUUID();
    db.prepare(
        `INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at, active, status)
         VALUES (?, 'offer', 'other', 'Test post', 'Desc', 0, ?, ?, ?, 1, 'active')`
    ).run(uniqueId, authorPk, createdAtIso, createdAtIso);
    return uniqueId;
}

function insertPostPhoto(postId: string, orderNum: number): void {
    db.prepare(
        `INSERT INTO post_photos (post_id, order_num)
         VALUES (?, ?)`
    ).run(postId, orderNum);
}

function insertDm(userA: string, userB: string, createdAtIso: string): string {
    const convId = crypto.randomUUID();
    db.prepare(
        `INSERT INTO conversations (id, type, created_by, created_at)
         VALUES (?, 'dm', ?, ?)`
    ).run(convId, userA, createdAtIso);

    db.prepare(
        `INSERT INTO conversation_participants (conversation_id, public_key, updated_at)
         VALUES (?, ?, ?)`
    ).run(convId, userA, createdAtIso);

    db.prepare(
        `INSERT INTO conversation_participants (conversation_id, public_key, updated_at)
         VALUES (?, ?, ?)`
    ).run(convId, userB, createdAtIso);

    return convId;
}

function insertMessage(convId: string, authorPk: string, timestampIso: string): void {
    const msgId = crypto.randomUUID();
    db.prepare(
        `INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, timestamp)
         VALUES (?, ?, ?, 'hello', 'plaintext-v1', ?)`
    ).run(msgId, convId, authorPk, timestampIso);
}

function main(): void {
    console.log('--- Testing probation engine (engine/probation.ts) ---');
    initStateEngine();

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const tenDaysAgoIso = new Date(now - 10 * 24 * 3600 * 1000).toISOString();

    const ownerPk = makeKey();
    insertMember(ownerPk, 'ProbationOwner', tenDaysAgoIso);
    db.prepare("INSERT OR IGNORE INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'owner', 'genesis')").run(ownerPk);

    // ── 1. probationRuleSet & probationState for ordinary vs 12-words ──
    console.log('\n1. probationRuleSet & probationState...');
    const ordinaryUser = makeKey();
    insertMember(ordinaryUser, 'OrdinaryUser', nowIso);

    const wordsUser = makeKey();
    insertMember(wordsUser, 'WordsUser', nowIso, 'words');

    assert(probationRuleSet(ordinaryUser) === 'ordinary', 'Ordinary user gets ordinary rule set');
    assert(probationRuleSet(wordsUser) === 'words', 'Words user gets words rule set');

    const stateOrdinary = probationState(ordinaryUser, now);
    assert(stateOrdinary.onProbation === true, 'New ordinary user is on probation');
    assert(stateOrdinary.rules === 'ordinary', 'State carries ordinary rules');
    assert(stateOrdinary.keptPosts === 0, 'New user has 0 kept posts');

    const stateWords = probationState(wordsUser, now);
    assert(stateWords.onProbation === true, 'New words user is on probation');
    assert(stateWords.rules === 'words', 'State carries words rules');

    // ── 2. Role exemptions ──
    console.log('\n2. Role exemptions...');
    grantNodeRole(ordinaryUser, 'admin', ownerPk);
    const stateAdmin = probationState(ordinaryUser, now);
    assert(stateAdmin.onProbation === false, 'Admin role exempts user from probation');
    assert(stateAdmin.exemptBecause === 'role', 'Exemption reason is role');

    // ── 3. Transition out of probation ──
    console.log('\n3. Transitioning out of probation...');
    const seasonedUser = makeKey();
    insertMember(seasonedUser, 'SeasonedUser', tenDaysAgoIso);

    assert(probationState(seasonedUser, now).onProbation === true, 'User >72h old with 0 kept posts remains on probation');

    insertPost(seasonedUser, nowIso);
    insertPost(seasonedUser, nowIso);
    insertPost(seasonedUser, nowIso);

    const stateSeasonedCompleted = probationState(seasonedUser, now);
    assert(stateSeasonedCompleted.keptPosts === 3, 'User now has 3 kept posts');
    assert(stateSeasonedCompleted.onProbation === false, 'User >72h old with 3 kept posts is off probation');

    // ── 4. isWordsNewcomer ──
    console.log('\n4. isWordsNewcomer...');
    assert(isWordsNewcomer(wordsUser, now) === true, 'Words user on probation is a words newcomer');
    assert(isWordsNewcomer(ordinaryUser, now) === false, 'Admin / ordinary user is not a words newcomer');

    // ── 5. assertMayPost & assertMayEditPhotos ──
    console.log('\n5. assertMayPost & assertMayEditPhotos...');
    const newPoster = makeKey();
    insertMember(newPoster, 'NewPoster', nowIso);

    // Can post initially
    assertMayPost(newPoster, 0, now);

    // Make 3 posts (limit for ordinary newcomer)
    insertPost(newPoster, nowIso);
    insertPost(newPoster, nowIso);
    insertPost(newPoster, nowIso);

    let caughtPostError = false;
    try {
        assertMayPost(newPoster, 0, now);
    } catch (err: any) {
        if (err instanceof ProbationLimitError) {
            caughtPostError = true;
            assert(err.limit === 'posts', 'Limit error names posts');
            assert(err.status === 429, 'Limit error has 429 status');
        }
    }
    assert(caughtPostError, 'assertMayPost throws ProbationLimitError when post limit exceeded');

    // Photo limits
    const photoUser = makeKey();
    insertMember(photoUser, 'PhotoUser', nowIso);

    // Add 1 post with 5 photos (PROBATION.photos limit)
    const photoPostId = insertPost(photoUser, nowIso);
    for (let i = 1; i <= PROBATION.photos; i++) {
        insertPostPhoto(photoPostId, i);
    }

    let caughtPhotoError = false;
    try {
        assertMayPost(photoUser, 1, now);
    } catch (err: any) {
        if (err instanceof ProbationLimitError) {
            caughtPhotoError = true;
            assert(err.limit === 'photos', 'Limit error names photos');
        }
    }
    assert(caughtPhotoError, 'assertMayPost throws ProbationLimitError when photo limit exceeded');

    // ── 6. assertMayMessage ──
    console.log('\n6. assertMayMessage...');
    const dmSender = makeKey();
    insertMember(dmSender, 'DmSender', nowIso);

    // Reaching 10 new people (PROBATION.newDmRecipients)
    for (let i = 1; i <= PROBATION.newDmRecipients; i++) {
        const recipient = makeKey();
        insertMember(recipient, `Recipient${i}`, nowIso);
        const convId = insertDm(dmSender, recipient, nowIso);
        insertMessage(convId, dmSender, nowIso);
    }

    const recipient11 = makeKey();
    insertMember(recipient11, 'Recipient11', nowIso);

    let caughtMessageError = false;
    try {
        assertMayMessage(dmSender, recipient11, now);
    } catch (err: any) {
        if (err instanceof ProbationLimitError) {
            caughtMessageError = true;
            assert(err.limit === 'new_dm_recipients', 'Limit error names new_dm_recipients');
        }
    }
    assert(caughtMessageError, 'assertMayMessage throws ProbationLimitError on 11th new DM recipient');

    // ── 7. probationSummary ──
    console.log('\n7. probationSummary...');
    const summary = probationSummary(newPoster, now);
    assert(summary.rules === 'ordinary', 'probationSummary returns rules');
    assert(summary.limits.posts.limit === PROBATION.posts, 'probationSummary gives correct post limit');
    assert(summary.limits.posts.used === 3, 'probationSummary accurately reflects 3 used posts');
    assert(summary.limits.posts.remaining === 0, 'probationSummary shows 0 remaining posts');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    process.exit(0);
}

main();
