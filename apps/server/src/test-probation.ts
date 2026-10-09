/**
 * Unit/integration tests for probation limits and state helpers in `src/engine/probation.ts`.
 *
 * Verifies:
 * 1. probationRuleSet logic for 12-words vs ordinary sign-ins.
 * 2. probationState calculations, role exemptions, age and kept post thresholds.
 * 3. assertMayPost enforcement for post counts and photo allowances.
 * 4. assertMayMessage enforcement for messaging new recipients in 24h rolling window.
 * 5. probationSummary response formatting and limits calculation.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) NODE_PROFILE=global pnpm exec tsx src/test-probation.ts
 */

process.env.NODE_PROFILE = 'global';

import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import {
    probationRuleSet,
    probationState,
    assertMayPost,
    assertMayMessage,
    probationSummary,
    ProbationLimitError,
    PROBATION,
    WORDS_PROBATION,
} from './engine/probation.js';

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ FAIL: ${msg}`);
    }
}

function insertMember(pubkey: string, callsign: string, joinedAtIso: string): void {
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, updated_at) VALUES (?, ?, 'active', ?, ?)`).run(
        pubkey,
        callsign,
        joinedAtIso,
        joinedAtIso
    );
}

function main(): void {
    console.log('Running probation engine tests...\n');
    initStateEngine();

    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    // ── 1. probationRuleSet ───────────────────────────────────────────────────
    const pubkeyWords = 'pubkey_words_1234567890123456789012';
    const pubkeyOrdinary = 'pubkey_ordinary_123456789012345678';

    insertMember(pubkeyWords, 'WordsUser', nowIso);
    insertMember(pubkeyOrdinary, 'OrdinaryUser', nowIso);

    db.prepare(`INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at) VALUES (?, 'words', 'hash_words', ?)`).run(pubkeyWords, nowIso);
    db.prepare(`INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at) VALUES (?, 'github', 'hash_github', ?)`).run(pubkeyOrdinary, nowIso);

    assert(probationRuleSet(pubkeyWords) === 'words', '1. probationRuleSet identifies words provider as "words"');
    assert(probationRuleSet(pubkeyOrdinary) === 'ordinary', '1. probationRuleSet identifies github provider as "ordinary"');

    // ── 2. probationState ─────────────────────────────────────────────────────
    const stateNew = probationState(pubkeyOrdinary, now);
    assert(
        stateNew.onProbation === true &&
            stateNew.exemptBecause === null &&
            stateNew.rules === 'ordinary' &&
            stateNew.keptPosts === 0 &&
            stateNew.keptPostsNeeded === PROBATION.keptPosts,
        '2. New member is on probation'
    );

    // Node role exemption
    const pubkeyAdmin = 'pubkey_admin_1234567890123456789012';
    insertMember(pubkeyAdmin, 'AdminUser', nowIso);
    db.prepare(`INSERT INTO node_roles (member_pubkey, role, granted_at) VALUES (?, 'admin', ?)`).run(pubkeyAdmin, nowIso);

    const stateAdmin = probationState(pubkeyAdmin, now);
    assert(
        stateAdmin.onProbation === false && stateAdmin.exemptBecause === 'role',
        '2. Member with node role is exempt from probation'
    );

    // Old account with enough kept posts vs insufficient kept posts
    const tenDaysAgoIso = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
    const pubkeyOldFull = 'pubkey_old_full_123456789012345678';
    const pubkeyOldFew = 'pubkey_old_few_1234567890123456789';

    insertMember(pubkeyOldFull, 'OldFullUser', tenDaysAgoIso);
    insertMember(pubkeyOldFew, 'OldFewUser', tenDaysAgoIso);

    for (let i = 0; i < 3; i++) {
        db.prepare(
            `INSERT INTO posts (id, type, category, title, description, author_pubkey, created_at, updated_at) VALUES (?, 'offer', 'goods', 'Title', 'Description', ?, ?, ?)`
        ).run(`post_full_${i}`, pubkeyOldFull, tenDaysAgoIso, tenDaysAgoIso);
    }

    assert(probationState(pubkeyOldFull, now).onProbation === false, '2. 10-day old member with 3 kept posts is off probation');
    assert(probationState(pubkeyOldFew, now).onProbation === true, '2. 10-day old member with 0 kept posts is still on probation');

    // ── 3. assertMayPost & photo limits ──────────────────────────────────────
    const pubkeyPoster = 'pubkey_poster_1234567890123456789';
    insertMember(pubkeyPoster, 'PosterUser', nowIso);

    // Poster should be able to post 3 times
    for (let i = 0; i < PROBATION.posts; i++) {
        assertMayPost(pubkeyPoster, 0, now);
        db.prepare(
            `INSERT INTO posts (id, type, category, title, description, author_pubkey, created_at, updated_at) VALUES (?, 'offer', 'goods', 'Post', 'Description', ?, ?, ?)`
        ).run(`poster_post_${i}`, pubkeyPoster, nowIso, nowIso);
    }

    // 4th post should throw ProbationLimitError
    let threwPostError = false;
    try {
        assertMayPost(pubkeyPoster, 0, now);
    } catch (err) {
        if (err instanceof ProbationLimitError && err.limit === 'posts') {
            threwPostError = true;
        }
    }
    assert(threwPostError, '3. assertMayPost throws ProbationLimitError when post limit is reached');

    // Photo allowance assertion
    const pubkeyPhotos = 'pubkey_photos_1234567890123456789';
    insertMember(pubkeyPhotos, 'PhotoUser', nowIso);

    let threwPhotoError = false;
    try {
        assertMayPost(pubkeyPhotos, PROBATION.photos + 1, now);
    } catch (err) {
        if (err instanceof ProbationLimitError && err.limit === 'photos') {
            threwPhotoError = true;
        }
    }
    assert(threwPhotoError, '3. assertMayPost throws ProbationLimitError when photo limit is exceeded');

    // ── 4. assertMayMessage ──────────────────────────────────────────────────
    const pubkeySender = 'pubkey_sender_1234567890123456789';
    insertMember(pubkeySender, 'SenderUser', nowIso);

    for (let i = 0; i < WORDS_PROBATION.newDmRecipients; i++) {
        const recipientKey = `recipient_${i}_12345678901234567890`;
        insertMember(recipientKey, `Recipient${i}`, nowIso);
        assertMayMessage(pubkeyWords, recipientKey, now);

        const convId = `conv_${i}`;
        db.prepare(
            `INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, 'dm', ?, ?)`
        ).run(convId, pubkeyWords, nowIso);
        db.prepare(`INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)`).run(convId, pubkeyWords);
        db.prepare(`INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)`).run(convId, recipientKey);
    }

    let threwDmError = false;
    try {
        const extraRecipient = 'recipient_extra_1234567890123456';
        insertMember(extraRecipient, 'ExtraRecipient', nowIso);
        assertMayMessage(pubkeyWords, extraRecipient, now);
    } catch (err) {
        if (err instanceof ProbationLimitError && err.limit === 'new_dm_recipients') {
            threwDmError = true;
        }
    }
    assert(threwDmError, '4. assertMayMessage throws ProbationLimitError when new recipient limit is reached for 12-words user');

    // ── 5. probationSummary ──────────────────────────────────────────────────
    const summary = probationSummary(pubkeyOrdinary, now);
    assert(summary.onProbation === true, '5. probationSummary returns onProbation: true for new user');
    assert(summary.limits.posts.limit === PROBATION.posts, '5. probationSummary includes correct post limit allowance');
    assert(summary.limits.photos.limit === PROBATION.photos, '5. probationSummary includes correct photo limit allowance');
    assert(summary.limits.new_dm_recipients.limit === PROBATION.newDmRecipients, '5. probationSummary includes correct DM limit allowance');
    assert(summary.endsWhen.hours === PROBATION.hours, '5. probationSummary includes endsWhen hours threshold');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    console.log('⭐️ Probation test suite PASSED.');
    process.exit(0);
}

main();
