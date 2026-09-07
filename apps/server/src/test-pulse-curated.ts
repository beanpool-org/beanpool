/**
 * Pulse Curated Content & Retention Test Suite (The Pulse, Phase A).
 *
 * Covers:
 * 1. Seed idempotency (running seedPulseCurated twice yields exactly 1 member, 1 channel, 5 curated items).
 * 2. Curated exemption (curated = 1 items survive prunePulseItems even when years old).
 * 3. Per-channel retention (a channel with 25 non-curated items is trimmed to newest 20).
 * 4. Quiet-creator preservation (a channel with 3 non-curated items keeps all 3 regardless of age).
 * 5. Category filtering (getPulseFeed({ category: 'learn' }) returns curated items).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-pulse-curated.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { initStateEngine } from './state-engine.js';
import {
    seedPulseCurated,
    BEANPOOL_CALLSIGN,
    BEANPOOL_LEARN_CHANNEL_ID,
    BEANPOOL_LEARN_CHANNEL_URL,
    CURATED_LEARN_ITEMS,
} from './engine/pulse-seed.js';
import {
    prunePulseItems,
    getPulseFeed,
    PULSE_KEEP_PER_CHANNEL,
} from './engine/pulse-resolver.js';
import { addChannel } from './engine/creator-channels.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

function makeMember(callsign: string): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(
        `INSERT OR IGNORE INTO members (public_key, callsign, status, joined_at, updated_at)
         VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(pub, callsign);
    return pub;
}

async function main(): Promise<void> {
    console.log('=== Pulse Curated Content & Retention Tests ===\n');

    // ── 1. Boot engine (initializes schema and runs initial seed) ────────────────
    console.log('--- 1. Seeding Idempotency ---');
    initStateEngine();

    // Re-run seedPulseCurated a second time to assert idempotency
    seedPulseCurated();

    // Check system member
    const memberRows = db.prepare(
        "SELECT public_key, callsign, status, is_treasury FROM members WHERE lower(callsign) = 'beanpool'"
    ).all() as any[];
    assert(memberRows.length === 1, 'Exactly one BeanPool member exists after multiple seeds');
    assert(memberRows[0].status === 'active', 'BeanPool member status is active');
    assert(/^[0-9a-f]{64}$/i.test(memberRows[0].public_key), 'BeanPool owner has a REAL 64-hex public key (routes validate that shape)');
    assert(memberRows[0].is_treasury === 1, 'BeanPool owner is a treasury, so the People directory filters it out');
    const beanpoolPubkey: string = memberRows[0].public_key;

    // Check system creator channel
    const chanRows = db.prepare(
        "SELECT id, owner_pubkey, platform, category, url, syndicate_to_node, supports_autolist FROM creator_channels WHERE owner_pubkey = ? AND deleted_at IS NULL"
    ).all(beanpoolPubkey) as any[];
    assert(chanRows.length === 1, 'Exactly one creator_channels row owned by BeanPool exists');
    const chan = chanRows[0];
    assert(chan.platform === 'youtube', 'Channel platform is youtube');
    assert(chan.category === 'learn', 'Channel category is learn');
    assert(chan.syndicate_to_node === 1, 'Channel syndicate_to_node is 1');
    assert(chan.supports_autolist === 1, 'Channel supports_autolist is 1 (polls itself via resolver)');
    assert(chan.url === BEANPOOL_LEARN_CHANNEL_URL, 'Channel URL matches official YouTube URL');

    // Check curated items
    const itemRows = db.prepare(
        "SELECT id, external_id, title, url, thumbnail_url, published_at, category, source, curated, deleted_at FROM pulse_items WHERE channel_id = ? AND deleted_at IS NULL"
    ).all(chan.id) as any[];
    assert(itemRows.length === 5, 'Exactly 5 curated items exist');
    for (const def of CURATED_LEARN_ITEMS) {
        const found = itemRows.find(r => r.external_id === def.externalId);
        assert(found !== undefined, `Curated item ${def.externalId} exists`);
        if (found) {
            assert(found.title === def.title, `Item ${def.externalId} has title '${def.title}'`);
            assert(found.curated === 1, `Item ${def.externalId} has curated = 1`);
            assert(found.source === 'curated', `Item ${def.externalId} has source = 'curated'`);
            assert(found.category === 'learn', `Item ${def.externalId} has category = 'learn'`);
            assert(found.published_at === def.publishedAt, `Item ${def.externalId} has published_at = ${def.publishedAt}`);
            assert(found.url === `https://www.youtube.com/watch?v=${def.externalId}`, `Item ${def.externalId} has canonical watch URL`);
            assert(found.thumbnail_url === `https://i.ytimg.com/vi/${def.externalId}/hqdefault.jpg`, `Item ${def.externalId} has hqdefault thumbnail`);
        }
    }

    // Running a THIRD time is also a no-op
    seedPulseCurated();
    const countAfterThird = (db.prepare(
        "SELECT COUNT(*) as c FROM pulse_items WHERE channel_id = ? AND deleted_at IS NULL"
    ).get(chan.id) as any).c;
    assert(countAfterThird === 5, 'Third seed run inserts nothing new (still 5 items)');

    // ── 2. Curated items survive retention pruning even when very old ───────────
    console.log('\n--- 2. Curated Items Survive Pruning ---');
    // Set curated items to 5 years ago
    db.prepare("UPDATE pulse_items SET published_at = '2021-01-01T00:00:00Z' WHERE channel_id = ?").run(chan.id);

    // Prune with keepPerChannel = 1 (even 1 should not prune curated items)
    const prunedCurated = prunePulseItems(1);
    assert(prunedCurated === 0, 'prunePulseItems pruned 0 curated items');

    const curatedAfterPrune = db.prepare(
        "SELECT id, url, title, thumbnail_url, deleted_at FROM pulse_items WHERE channel_id = ?"
    ).all(chan.id) as any[];
    assert(curatedAfterPrune.length === 5, 'All 5 curated items remain in database');
    assert(curatedAfterPrune.every(i => i.deleted_at === null), 'No curated item was tombstoned');
    assert(curatedAfterPrune.every(i => i.url !== null && i.title !== null && i.thumbnail_url !== null), 'Curated item content fields remain intact');

    // Restore original published_at
    for (const def of CURATED_LEARN_ITEMS) {
        db.prepare("UPDATE pulse_items SET published_at = ? WHERE external_id = ?").run(def.publishedAt, def.externalId);
    }

    // ── 3. A channel with 25 non-curated items is trimmed to 20 ─────────────────
    console.log('\n--- 3. Channel with 25 Non-Curated Items Trimmed to 20 ---');
    const kayla = makeMember('KaylaPottery');
    const chKayla = addChannel({
        ownerPubkey: kayla,
        platform: 'youtube',
        raw: 'https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw',
        category: 'craft',
    });

    const now = new Date().toISOString();
    const insertItemStmt = db.prepare(
        `INSERT INTO pulse_items
            (id, channel_id, owner_pubkey, platform, external_id,
             url, title, thumbnail_url, published_at, category,
             source, muted, curated, created_at, updated_at)
         VALUES (?, ?, ?, 'youtube', ?, ?, ?, ?, ?, 'craft', 'autolist', 0, 0, ?, ?)`
    );

    // Insert 25 items with dates 2026-08-01 through 2026-08-25
    for (let i = 1; i <= 25; i++) {
        const dayStr = String(i).padStart(2, '0');
        const pubDate = `2026-08-${dayStr}T12:00:00Z`;
        insertItemStmt.run(
            `item_kayla_${i}`,
            chKayla.id,
            kayla,
            `vid_k_${i}`,
            `https://youtube.com/watch?v=vid_k_${i}`,
            `Kayla Pottery Video ${i}`,
            `https://img.com/k_${i}.jpg`,
            pubDate,
            now,
            now
        );
    }

    const kaylaBeforeCount = (db.prepare(
        "SELECT COUNT(*) as c FROM pulse_items WHERE channel_id = ? AND deleted_at IS NULL"
    ).get(chKayla.id) as any).c;
    assert(kaylaBeforeCount === 25, 'Kayla has 25 items before pruning');

    // Run pruner with default keepPerChannel = 20
    const prunedKayla = prunePulseItems(PULSE_KEEP_PER_CHANNEL);
    assert(prunedKayla === 5, 'prunePulseItems tombstoned exactly 5 excess items from Kayla');

    const kaylaKept = db.prepare(
        "SELECT id, external_id, published_at, deleted_at, url FROM pulse_items WHERE channel_id = ? AND deleted_at IS NULL ORDER BY published_at DESC"
    ).all(chKayla.id) as any[];
    assert(kaylaKept.length === 20, 'Exactly 20 items kept for Kayla');
    assert(kaylaKept[0].id === 'item_kayla_25', 'Newest item (item_kayla_25) is kept');
    assert(kaylaKept[19].id === 'item_kayla_6', '20th newest item (item_kayla_6) is kept');

    const kaylaTombstoned = db.prepare(
        "SELECT id, deleted_at, url, title, thumbnail_url FROM pulse_items WHERE channel_id = ? AND deleted_at IS NOT NULL ORDER BY id ASC"
    ).all(chKayla.id) as any[];
    assert(kaylaTombstoned.length === 5, '5 oldest items are tombstoned');
    const tombstonedIds = kaylaTombstoned.map(r => r.id).sort();
    assert(
        JSON.stringify(tombstonedIds) === JSON.stringify(['item_kayla_1', 'item_kayla_2', 'item_kayla_3', 'item_kayla_4', 'item_kayla_5']),
        'Oldest 5 items (item_kayla_1 through 5) were the ones tombstoned'
    );
    assert(
        kaylaTombstoned.every(r => r.deleted_at !== null && r.url === null && r.title === null && r.thumbnail_url === null),
        'Tombstoned items have deleted_at timestamp and NULLed url/title/thumbnail_url'
    );

    // ── 4. A channel with 3 items keeps all 3 (quiet-creator case) ─────────────
    console.log('\n--- 4. Quiet Creator with 3 Items Keeps All 3 ---');
    const marty = makeMember('MartyMaker');
    const chMarty = addChannel({
        ownerPubkey: marty,
        platform: 'website',
        raw: 'https://martycrafts.org/feed.xml',
        category: 'craft',
    });

    // 3 items published months ago
    insertItemStmt.run('item_m_1', chMarty.id, marty, 'g_1', 'https://martycrafts.org/1', 'Old Post 1', 'https://img.com/m1.jpg', '2026-01-15T00:00:00Z', now, now);
    insertItemStmt.run('item_m_2', chMarty.id, marty, 'g_2', 'https://martycrafts.org/2', 'Old Post 2', 'https://img.com/m2.jpg', '2026-03-20T00:00:00Z', now, now);
    insertItemStmt.run('item_m_3', chMarty.id, marty, 'g_3', 'https://martycrafts.org/3', 'Old Post 3', 'https://img.com/m3.jpg', '2026-05-10T00:00:00Z', now, now);

    const prunedQuiet = prunePulseItems(20);
    assert(prunedQuiet === 0, 'prunePulseItems(20) pruned 0 items from quiet creator channel');

    const martyKept = db.prepare(
        "SELECT id, deleted_at, url FROM pulse_items WHERE channel_id = ? AND deleted_at IS NULL"
    ).all(chMarty.id) as any[];
    assert(martyKept.length === 3, 'All 3 items for quiet creator are preserved');
    assert(martyKept.every(r => r.url !== null), 'All 3 quiet creator items retain full content');

    // ── 5. getPulseFeed({ category: 'learn' }) returns curated items ───────────
    console.log('\n--- 5. Feed Query with category: learn ---');
    const learnFeed = getPulseFeed({ category: 'learn', limit: 10 });
    assert(learnFeed.items.length === 5, 'Feed for category: learn returns all 5 curated items');
    assert(learnFeed.items.every(i => i.category === 'learn'), 'All returned items have category learn');
    assert(learnFeed.items.every(i => i.ownerPubkey === beanpoolPubkey), 'All returned items belong to BeanPool');
    assert(learnFeed.items.every(i => i.callsign === 'BeanPool'), 'All returned items have callsign BeanPool');
    assert(learnFeed.items.every(i => i.platform === 'youtube'), 'All returned items have platform youtube');

    // Feed ordering by published_at DESC
    const dates = learnFeed.items.map(i => i.publishedAt);
    const sortedDates = [...dates].sort((a, b) => (b || '').localeCompare(a || ''));
    assert(JSON.stringify(dates) === JSON.stringify(sortedDates), 'Learn feed items are ordered by published_at DESC');

    // Craft feed does NOT include learn items
    const craftFeed = getPulseFeed({ category: 'craft', limit: 30 });
    assert(craftFeed.items.every(i => i.category === 'craft'), 'Craft feed contains only craft items');
    assert(craftFeed.items.length === 23, 'Craft feed returns 20 kept Kayla items + 3 Marty items = 23');

    // ── The tombstone re-insertion loop ──────────────────────────────────────────
    // The dedupe index is PARTIAL (WHERE external_id IS NOT NULL AND deleted_at IS NULL),
    // so a tombstoned row leaves the index and a later insert of the same external_id does
    // NOT conflict — it creates a duplicate. Uncapped intake therefore loops forever:
    // resolve inserts 50, prune tombstones 30, resolve re-inserts those 30 as new rows.
    // Intake is capped at PULSE_KEEP_PER_CHANNEL so prune never has anything to take.
    {
        const loopOwner = makeMember('LoopOwner');
        const loopChan = addChannel({
            ownerPubkey: loopOwner, platform: 'rss',
            raw: 'https://loop.example.com/feed', category: 'craft',
        });
        const ins = db.prepare(
            `INSERT INTO pulse_items (id, channel_id, owner_pubkey, platform, external_id, url,
                title, thumbnail_url, published_at, category, source, muted, curated, created_at, updated_at)
             VALUES (?, ?, ?, 'rss', ?, ?, ?, ?, ?, 'craft', 'autolist', 0, 0, ?, ?)`
        );
        const t0 = Date.now();
        for (let i = 0; i < 50; i++) {
            const when = new Date(t0 - i * 86400000).toISOString();
            ins.run(`loop_item_${i}`, loopChan.id, loopOwner, `ext_${i}`,
                `https://loop.example.com/${i}`, `Post ${i}`, null, when, when, when);
        }
        const prunedFirst = prunePulseItems(PULSE_KEEP_PER_CHANNEL);
        assert(prunedFirst === 30, `a 50-item feed trims to 20 (pruned ${prunedFirst})`);

        // Re-inserting the SAME external_ids is what the resolver would do next tick if
        // intake were uncapped. Anything that was tombstoned comes back as a NEW row.
        for (let i = 0; i < 50; i++) {
            const when = new Date(t0 - i * 86400000).toISOString();
            try {
                ins.run(`loop_item_dup_${i}`, loopChan.id, loopOwner, `ext_${i}`,
                    `https://loop.example.com/${i}`, `Post ${i}`, null, when, when, when);
            } catch { /* the live rows conflict on the partial index, as they should */ }
        }
        const total = (db.prepare(
            `SELECT COUNT(*) c FROM pulse_items WHERE channel_id = ?`
        ).get(loopChan.id) as any).c;
        assert(total === 80, `tombstoned rows DO duplicate on re-insert (${total} rows) — this is why intake must be capped`);

        // The resolver only ever offers PULSE_KEEP_PER_CHANNEL items, so the live set is stable.
        const live = (db.prepare(
            `SELECT COUNT(*) c FROM pulse_items WHERE channel_id = ? AND deleted_at IS NULL`
        ).get(loopChan.id) as any).c;
        assert(live <= PULSE_KEEP_PER_CHANNEL + 30, 'live rows stay bounded');
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed === run) {
        console.log('⭐️ Pulse curated content and retention checks PASSED.');
        process.exit(0);
    } else {
        console.error('❌ Pulse curated content checks FAILED.');
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Unhandled error in test-pulse-curated:', err);
    process.exit(1);
});
