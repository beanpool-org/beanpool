/**
 * Daily Pulse — Auto-generated daily inspirational offer test suite.
 * Verifies:
 * 1. Entry decompression and date-based indexing modulo 300.
 * 2. Treasury auto-provisioning for "Daily Pulse" and callsign collision safety.
 * 3. Daily rotation: atomic soft-deletion of previous pulse offer and creation of today's 0-bean offer.
 * 4. Pinned marketplace post attributes (credits=0, reach='local', status='active', deterministic ID).
 * 5. Re-rotation idempotency: exactly one active Pulse post remains at any time.
 * 6. Zero notification / DM generation.
 * 7. Escrow API rejection for inspirational posts.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-daily-pulse.ts
 */

import { initStateEngine, getPosts, requestPost, acceptPost } from './state-engine.js';
import { db } from './db/db.js';
import { getPulseEntry, getTodaysPulseEntry, getAllPulseEntries } from './daily-pulse-entries.js';
import { ensurePulseTreasury, rotateDailyPulse, getActivePulsePost, PULSE_CALLSIGN } from './daily-pulse.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function main() {
    console.log('🧪 Starting Daily Pulse Test Suite...\n');

    // 1. Test Entry Decompression & Array Integrity
    const allEntries = getAllPulseEntries();
    assert(allEntries.length === 300, `Decompressed entry count is 300 (got ${allEntries.length})`);

    const entry0 = getPulseEntry(0);
    assert(!!entry0.headline && entry0.headline.length > 5, `Entry 0 has headline: "${entry0.headline}"`);
    assert(!!entry0.body && entry0.body.length > 20, `Entry 0 has body (${entry0.body.length} chars)`);
    assert(!!entry0.category, `Entry 0 has category: ${entry0.category}`);

    const entry299 = getPulseEntry(299);
    assert(!!entry299.headline && entry299.headline !== entry0.headline, `Entry 299 is unique: "${entry299.headline}"`);

    // Modulo wrapping
    const entry300 = getPulseEntry(300);
    assert(entry300.headline === entry0.headline, 'Day index 300 wraps correctly to Day 0');

    const entryNeg = getPulseEntry(-1);
    assert(entryNeg.headline === entry299.headline, 'Day index -1 wraps correctly to Day 299');

    // Date determinism
    const fixedDate = new Date('2026-06-15T12:00:00Z');
    const pulseFixed1 = getTodaysPulseEntry(fixedDate);
    const pulseFixed2 = getTodaysPulseEntry(fixedDate);
    assert(pulseFixed1.headline === pulseFixed2.headline, `Deterministic lookup for date: "${pulseFixed1.headline}"`);

    // 2. Initialize State Engine & Database
    initStateEngine();

    // 3. Test Treasury Provisioning
    const pulsePubkey = ensurePulseTreasury();
    assert(!!pulsePubkey && pulsePubkey.length > 10, `Treasury pubkey created/retrieved: ${pulsePubkey.slice(0, 12)}...`);

    const treasuryRow = db.prepare("SELECT * FROM members WHERE public_key = ?").get(pulsePubkey) as any;
    assert(treasuryRow?.callsign === PULSE_CALLSIGN, `Treasury member callsign is "${PULSE_CALLSIGN}"`);
    assert(treasuryRow?.is_treasury === 1, 'Member record is flagged as is_treasury=1');

    // Re-calling ensurePulseTreasury returns the exact same pubkey
    const pulsePubkey2 = ensurePulseTreasury();
    assert(pulsePubkey2 === pulsePubkey, 'ensurePulseTreasury() is idempotent');

    // 4. Test Daily Pulse Rotation
    const dateDay1 = new Date('2026-08-16T05:00:00Z');
    const { post: postDay1, entry: entryDay1 } = rotateDailyPulse(dateDay1);
    assert(postDay1.id === 'pulse_2026-08-16', `Pulse post ID is deterministic: "${postDay1.id}"`);
    assert(postDay1.credits === 0, `Pulse post is 0 Beans (got ${postDay1.credits})`);
    assert(postDay1.title === entryDay1.headline, `Pulse post title matches headline: "${postDay1.title}"`);
    assert(postDay1.description === entryDay1.body, 'Pulse post description matches body');
    assert(postDay1.authorPublicKey === pulsePubkey, 'Pulse post author is the Daily Pulse Treasury');
    assert(postDay1.reach === 'local', 'Pulse post reach is "local"');

    // Check active pulse in marketplace
    const activePostsDay1 = getPosts({ type: 'offer' });
    const pulseFoundDay1 = activePostsDay1.filter(p => p.authorPublicKey === pulsePubkey);
    assert(pulseFoundDay1.length === 1, `Exactly 1 active Pulse post found in marketplace (got ${pulseFoundDay1.length})`);
    assert(pulseFoundDay1[0].id === postDay1.id, 'Active pulse post matches Day 1 ID');

    // 5. Test Rotation to Day 2 (Yesterday's post should be soft-deleted)
    const dateDay2 = new Date('2026-08-17T05:00:00Z');
    const { post: postDay2, entry: entryDay2 } = rotateDailyPulse(dateDay2);
    assert(postDay2.id === 'pulse_2026-08-17', `Day 2 post ID (${postDay2.id}) matches deterministic format`);
    assert(postDay2.id !== postDay1.id, `Day 2 post ID is distinct from Day 1`);

    // Verify Day 1 post was marked inactive
    const day1Row = db.prepare("SELECT active, status FROM posts WHERE id = ?").get(postDay1.id) as any;
    assert(day1Row?.active === 0 && day1Row?.status === 'cancelled', `Day 1 post is soft-deleted (active=${day1Row?.active}, status=${day1Row?.status})`);

    // Verify only 1 active Pulse post exists
    const activePostsDay2 = getPosts({ type: 'offer' });
    const pulseFoundDay2 = activePostsDay2.filter(p => p.authorPublicKey === pulsePubkey);
    assert(pulseFoundDay2.length === 1, `Marketplace has exactly 1 active Pulse post on Day 2 (got ${pulseFoundDay2.length})`);
    assert(pulseFoundDay2[0].id === postDay2.id, `Active pulse post is Day 2 post: "${postDay2.title}"`);

    // 6. Test Idempotent Re-Rotation on the Same Day
    const { post: postDay2Recheck } = rotateDailyPulse(dateDay2);
    assert(postDay2Recheck.id === postDay2.id, `Re-rotation on Day 2 returns exact same post ID`);
    const activePostsDay2Recheck = getPosts({ type: 'offer' }).filter(p => p.authorPublicKey === pulsePubkey);
    assert(activePostsDay2Recheck.length === 1, `Still exactly 1 active Pulse post after re-rotation`);

    // 7. Verify Escrow Protection Against Transacting on Pulse Posts
    const peerPubkey = 'peer_test_pubkey_1234567890123456';
    db.prepare(`INSERT INTO members (public_key, callsign, avatar_url, status, joined_at, invited_by, invite_code) VALUES (?, ?, 'https://example.com/avatar.jpg', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(peerPubkey, 'PeerTrader');
    db.prepare("INSERT OR REPLACE INTO accounts (public_key, balance) VALUES (?, ?)").run(peerPubkey, 50);

    let requestBlocked = false;
    try {
        requestPost(postDay2.id, peerPubkey);
    } catch (e: any) {
        requestBlocked = e.message.includes('Daily Pulse inspirational posts cannot be requested');
    }
    assert(requestBlocked, 'requestPost on Daily Pulse post is blocked by escrow engine');

    let acceptBlocked = false;
    try {
        acceptPost(postDay2.id, peerPubkey);
    } catch (e: any) {
        acceptBlocked = e.message.includes('Daily Pulse inspirational posts cannot be requested');
    }
    assert(acceptBlocked, 'acceptPost on Daily Pulse post is blocked by escrow engine');

    // 8. Verify Zero Inbound Notifications or Chats Spawned
    const conversations = db.prepare("SELECT COUNT(*) as c FROM conversations WHERE post_id = ?").get(postDay2.id) as any;
    assert((conversations?.c || 0) === 0, 'No conversations/DMs spawned');

    const messages = db.prepare("SELECT COUNT(*) as c FROM messages WHERE author_pubkey = ?").get(pulsePubkey) as any;
    assert((messages?.c || 0) === 0, 'No outbound direct messages sent by Daily Pulse author');

    // 9. Test Callsign Collision with Regular Member
    // Remove treasury first to simulate a scenario where a regular member took 'Daily Pulse'
    db.prepare("DELETE FROM members WHERE public_key = ?").run(pulsePubkey);
    const collideePubkey = 'collidee_pubkey_1234567890123456';
    db.prepare(`INSERT INTO members (public_key, callsign, avatar_url, status, joined_at, is_treasury) VALUES (?, 'Daily Pulse', 'https://example.com/avatar.jpg', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0)`).run(collideePubkey);

    const newPulsePubkey = ensurePulseTreasury();
    assert(newPulsePubkey !== collideePubkey, 'Treasury creation does not hijack regular member account');
    const collideeAfter = db.prepare("SELECT callsign, is_treasury FROM members WHERE public_key = ?").get(collideePubkey) as any;
    assert(collideeAfter.is_treasury === 0, 'Colliding member was not escalated to is_treasury=1');
    assert(collideeAfter.callsign.startsWith('Daily Pulse '), `Colliding member callsign safely renamed: "${collideeAfter.callsign}"`);

    console.log(`\nDaily Pulse Test Summary: ${passed}/${run} assertions passed.`);
    if (passed < run) {
        process.exit(1);
    }
    process.exit(0);
}

main().catch((err) => {
    console.error('Fatal error in Daily Pulse test suite:', err);
    process.exit(1);
});
