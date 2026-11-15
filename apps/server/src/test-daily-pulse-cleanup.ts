/**
 * CONVERSION CODE CC-daily-pulse-cleanup — expires: remove in the first node release after 1.4.3, with
 * engine/daily-pulse-cleanup.ts and its call in index.ts.
 *
 * The Daily Pulse is gone (Marty, 15 Nov 2026). A node that ran it holds its Pulse items, its channel and maybe a live 0-Bean
 * offer; one boot cleanup on the main server takes them away. This plants exactly what the removed daily-pulse.ts wrote and
 * checks:
 *   1. A node that never ran it: the cleanup finds nothing and writes nothing.
 *   2. Rows present → gone: today's item and the channel deleted as the Pulse deletes (deleted_at, words and links cleared),
 *      today's offer cancelled (active 0, status 'cancelled'); yesterday's, already retired, as it was.
 *   3. Nothing else: the Daily Pulse account's own row, a member's own post (even one whose id looks like a Daily Pulse's),
 *      a member's own channel and item, and BeanPool's curated videos, each byte for byte as before.
 *   4. What people see: no Daily Pulse item in the Pulse (the curated videos still there), no Daily Pulse post in the Market.
 *   5. A standby reaches the same tables: the delta a standby pulls from the cursor before the cleanup carries the item, the
 *      channel and the post as they are now, and nothing of the member's.
 *   6. Run twice → no change: the second run counts nothing and every table is as the first left it.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-daily-pulse-cleanup.ts (or through scripts/run-server-suites.mjs)
 */

import crypto from 'node:crypto';
import { initStateEngine, createPost as rawCreatePost, createTreasury, getPosts, exportSyncState } from './state-engine.js';
import { wrapCreatePost } from './post-test-helper.js';
import { db } from './db/db.js';
import { getPulseFeed } from './engine/pulse-resolver.js';
import { BEANPOOL_LEARN_CHANNEL_ID } from './engine/pulse-seed.js';
import { removeDailyPulse } from './engine/daily-pulse-cleanup.js';
import { setMemberPhoto } from '@beanpool/engine';

const createPost = wrapCreatePost(rawCreatePost);

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const rowsOf = (sql: string, ...args: unknown[]) => JSON.stringify(db.prepare(sql).all(...args));
/** Every table the cleanup could touch, whole. */
const snapshot = () => [
    rowsOf('SELECT * FROM posts ORDER BY id'),
    rowsOf('SELECT * FROM pulse_items ORDER BY id'),
    rowsOf('SELECT * FROM creator_channels ORDER BY id'),
    rowsOf('SELECT * FROM members ORDER BY public_key'),
    rowsOf('SELECT * FROM tombstones ORDER BY table_name, row_key'),
].join('\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
    console.log('🧪 CC-daily-pulse-cleanup\n');
    initStateEngine();

    // ── 1. A node that never ran the Daily Pulse ──
    console.log('── 1. nothing to take ──');
    const clean = snapshot();
    const none = removeDailyPulse();
    assert(none.items === 0 && none.channel === 0 && none.posts === 0, `1. a node that never ran it: nothing counted (${JSON.stringify(none)})`);
    assert(snapshot() === clean, '1. and nothing written');

    // What the removed daily-pulse.ts wrote: its account (ensurePulseTreasury), its channel (ensureDailyPulseChannel),
    // yesterday's item retired and today's live (rotateDailyPulse), yesterday's offer cancelled and today's live.
    const pulse = createTreasury('Daily Pulse', 'bundled://sprout', 0, { systemCreated: true }).publicKey;
    const nowIso = new Date().toISOString();
    db.prepare(`INSERT INTO creator_channels (id, owner_pubkey, platform, url, handle, category, is_primary_video,
                    supports_autolist, syndicate_to_node, created_at, updated_at)
                VALUES ('chan_daily_pulse', ?, 'website', NULL, '@DailyPulse', 'learn', 0, 0, 1, ?, ?)`).run(pulse, nowIso, nowIso);
    const item = (id: string, channel: string, owner: string, title: string | null, deletedAt: string | null) => db.prepare(
        `INSERT INTO pulse_items (id, channel_id, owner_pubkey, platform, external_id, url, title, thumbnail_url, published_at, category,
             source, muted, curated, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, 'website', ?, NULL, ?, NULL, ?, 'learn', 'curated', 0, 1, ?, ?, ?)`,
    ).run(id, channel, owner, `ext_${id}`, title, `${nowIso.slice(0, 10)}T05:00:00.000Z`, nowIso, nowIso, deletedAt);
    item('item_pulse_2026-11-14', 'chan_daily_pulse', pulse, null, nowIso);
    item('item_pulse_2026-11-15', 'chan_daily_pulse', pulse, 'Mutual aid is a daily habit', null);
    rawCreatePost('offer', 'skills', 'Yesterday\'s thought', 'Words.', 0, 'fixed', pulse, undefined, undefined, undefined, false,
        'pulse_2026-11-14', false, { reach: 'local', allowNoPhoto: true });
    db.prepare("UPDATE posts SET active = 0, status = 'cancelled' WHERE id = 'pulse_2026-11-14'").run();
    rawCreatePost('offer', 'skills', 'Mutual aid is a daily habit', 'Words.', 0, 'fixed', pulse, undefined, undefined, undefined, false,
        'pulse_2026-11-15', false, { reach: 'local', allowNoPhoto: true });

    // A member's own: a listing, one whose id they chose to look like a Daily Pulse's, a channel and its item.
    const rae = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, 'Riverside Rae', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'inv-test')`).run(rae);
    db.prepare('INSERT INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(rae);
    setMemberPhoto(db, rae, 'https://riverside.example/rae.jpg');
    const raesPost = createPost('offer', 'food', 'Sourdough starter', 'Words.', 2, 'fixed', rae, -28.55, 153.5)!.id;
    const raesLookalike = createPost('offer', 'food', 'Rye loaves', 'Words.', 2, 'fixed', rae, -28.55, 153.5, undefined, false, 'pulse_2026-11-13')!.id;
    db.prepare(`INSERT INTO creator_channels (id, owner_pubkey, platform, url, handle, category, is_primary_video,
                    supports_autolist, syndicate_to_node, created_at, updated_at)
                VALUES ('chan_rae', ?, 'website', 'https://riverside.example/rae', '@rae', 'learn', 0, 0, 1, ?, ?)`).run(rae, nowIso, nowIso);
    item('item_rae_1', 'chan_rae', rae, 'Rae on starters', null);

    const row = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as Record<string, any> | undefined;
    const untouched = () => [
        rowsOf('SELECT * FROM members WHERE public_key IN (?, ?) ORDER BY public_key', pulse, rae),
        rowsOf('SELECT * FROM posts WHERE author_pubkey = ? ORDER BY id', rae),
        rowsOf("SELECT * FROM creator_channels WHERE id IN ('chan_rae', ?) ORDER BY id", BEANPOOL_LEARN_CHANNEL_ID),
        rowsOf("SELECT * FROM pulse_items WHERE channel_id IN ('chan_rae', ?) ORDER BY id", BEANPOOL_LEARN_CHANNEL_ID),
        rowsOf("SELECT * FROM posts WHERE id = 'pulse_2026-11-14'"),
        rowsOf("SELECT * FROM pulse_items WHERE id = 'item_pulse_2026-11-14'"),
    ].join('\n');
    const before = untouched();
    const curatedBefore = (db.prepare('SELECT COUNT(*) FROM pulse_items WHERE channel_id = ? AND deleted_at IS NULL').pluck().get(BEANPOOL_LEARN_CHANNEL_ID) as number);
    assert(curatedBefore > 0, `set up: BeanPool's curated videos are seeded (${curatedBefore})`);
    assert(getPosts({}).some((p: any) => p.id === 'pulse_2026-11-15') && getPulseFeed({}).items.some((i) => i.id === 'item_pulse_2026-11-15'),
        "set up: today's Daily Pulse is in the Market and in the Pulse, as a node that ran it has them");

    const cursor = new Date().toISOString();
    await sleep(5);

    // ── 2. Rows present → gone ──
    console.log('── 2. rows present → gone ──');
    const first = removeDailyPulse();
    assert(first.items === 1 && first.channel === 1 && first.posts === 1, `2. one item, the channel and one offer taken (${JSON.stringify(first)})`);
    const today = row("SELECT * FROM pulse_items WHERE id = 'item_pulse_2026-11-15'")!;
    assert(!!today.deleted_at && today.title === null && today.url === null && today.thumbnail_url === null && today.updated_at > cursor,
        `2. today's item is deleted as the Pulse deletes: stamped, its words and links cleared (${JSON.stringify([today.deleted_at, today.title])})`);
    const channel = row("SELECT * FROM creator_channels WHERE id = 'chan_daily_pulse'")!;
    assert(!!channel.deleted_at && channel.updated_at > cursor, `2. the channel is deleted (${channel.deleted_at})`);
    const offer = row("SELECT active, status, updated_at FROM posts WHERE id = 'pulse_2026-11-15'")!;
    assert(offer.active === 0 && offer.status === 'cancelled' && offer.updated_at > cursor, `2. today's offer is cancelled (${JSON.stringify(offer)})`);

    // ── 3. Nothing else ──
    console.log('── 3. nothing else ──');
    assert(untouched() === before,
        "3. the Daily Pulse account's row, Rae's listings (her pulse_ lookalike too), her channel and item, BeanPool's videos and yesterday's retired rows: as they were");
    assert(row('SELECT active, status FROM posts WHERE id = ?', raesLookalike)?.active === 1 && row('SELECT active FROM posts WHERE id = ?', raesPost)?.active === 1,
        "3. both of Rae's listings are still up");

    // ── 4. What people see ──
    console.log('── 4. what people see ──');
    const feed = getPulseFeed({ limit: 50 }).items;
    assert(!feed.some((i) => i.id.startsWith('item_pulse_')) && feed.some((i) => i.ownerPubkey !== rae && i.id !== 'item_rae_1'),
        `4. the Pulse has no Daily Pulse item, and still BeanPool's videos (${feed.length} item(s))`);
    assert(feed.some((i) => i.id === 'item_rae_1'), "4. and Rae's own item");
    const market = getPosts({}) as any[];
    assert(!market.some((p) => p.authorPublicKey === pulse || p.author_pubkey === pulse) && market.some((p) => p.id === raesPost),
        `4. the Market has no Daily Pulse post, and still Rae's (${market.length} listing(s))`);

    // ── 5. A standby reaches the same tables ──
    console.log('── 5. a standby reaches the same tables ──');
    const delta = await exportSyncState('node-a', cursor) as any;
    const deltaItem = (delta.pulseItems ?? []).find((i: any) => i.id === 'item_pulse_2026-11-15');
    const deltaChannel = (delta.creatorChannels ?? []).find((c: any) => c.id === 'chan_daily_pulse');
    const deltaPost = (delta.posts ?? []).find((p: any) => p.id === 'pulse_2026-11-15');
    assert(!!deltaItem && !!(deltaItem.deleted_at ?? deltaItem.deletedAt) && (deltaItem.title ?? null) === null,
        `5. the delta from the cursor carries today's item, deleted (${JSON.stringify(deltaItem ? [deltaItem.deleted_at ?? deltaItem.deletedAt, deltaItem.title] : null)})`);
    assert(!!deltaChannel && !!(deltaChannel.deleted_at ?? deltaChannel.deletedAt), `5. and the channel, deleted (${JSON.stringify(deltaChannel?.deleted_at ?? deltaChannel?.deletedAt ?? null)})`);
    assert(!!deltaPost && (deltaPost.active === 0 || deltaPost.active === false) && deltaPost.status === 'cancelled',
        `5. and the offer, cancelled (${JSON.stringify(deltaPost ? [deltaPost.active, deltaPost.status] : null)})`);
    assert(!(delta.posts ?? []).some((p: any) => p.id === raesPost || p.id === raesLookalike) && !(delta.pulseItems ?? []).some((i: any) => i.id === 'item_rae_1'),
        "5. and nothing of Rae's: the cleanup moved none of her rows");

    // ── 6. Run twice → no change ──
    console.log('── 6. run twice → no change ──');
    const after = snapshot();
    await sleep(5);
    const second = removeDailyPulse();
    assert(second.items === 0 && second.channel === 0 && second.posts === 0, `6. a second run counts nothing (${JSON.stringify(second)})`);
    assert(snapshot() === after, '6. and changes nothing, not even a stamp');

    console.log(`\nCC-daily-pulse-cleanup: ${passed}/${run} assertions passed.`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((err) => {
    console.error('Fatal error in the CC-daily-pulse-cleanup suite:', err);
    process.exit(1);
});
