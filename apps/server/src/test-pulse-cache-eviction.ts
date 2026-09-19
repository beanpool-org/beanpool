/**
 * Test Suite: every Pulse deletion path evicts the cached thumbnail at once.
 *
 * Before, only POST /api/member/pulse/items/:id/delete (and the operator takedown route) called
 * thumbnailService.delete. The other paths tombstoned the row and left the image in memory and on
 * disk until it was next requested or the 100 MB disk limit pushed it out.
 *
 * Verifies, for the default thumbnail service (memory and disk):
 * 1. prunePulseItems — the pruned item's bytes are gone; the kept item's are not.
 * 2. deleteChannel — every item on the channel is evicted.
 * 3. purgeMemberSelf — every item the member owned is evicted.
 * 4. adminPruneUser (inactivity prune) — every item the member owned is evicted.
 * 5. Another member's cached item is untouched throughout.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-pulse-cache-eviction.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import fs from 'node:fs';
import { db } from './db/db.js';
import { initStateEngine, purgeMemberSelf, adminPruneUser } from './state-engine.js';
import { addChannel, deleteChannel } from './engine/creator-channels.js';
import { prunePulseItems } from './engine/pulse-resolver.js';
import { getPulseThumbnailService } from './engine/pulse-thumbnail.js';

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
    const pubkey = crypto.randomBytes(32).toString('hex');
    db.prepare(
        `INSERT INTO members (public_key, callsign, status, joined_at, updated_at)
         VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(pubkey, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubkey);
    return pubkey;
}

function insertItem(id: string, channelId: string, owner: string, publishedAt: string): void {
    const now = new Date().toISOString();
    db.prepare(
        `INSERT INTO pulse_items (id, channel_id, owner_pubkey, platform, external_id, url, title, thumbnail_url,
             published_at, category, source, muted, curated, created_at, updated_at)
         VALUES (?, ?, ?, 'youtube', ?, ?, ?, ?, ?, 'craft', 'manual', 0, 0, ?, ?)`
    ).run(id, channelId, owner, `ext_${id}`, `https://www.youtube.com/watch?v=${id}`, `Clip ${id}`,
        `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, publishedAt, now, now);
}

const service = getPulseThumbnailService();
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

async function cacheImage(itemId: string): Promise<void> {
    service.cache.set(itemId, jpeg, 'image/jpeg');
    await service.diskStore!.set(itemId, jpeg, 'image/jpeg');
}

/** Disk deletes are fire-and-forget; give the unlinks a moment to land. */
const settle = () => new Promise(r => setTimeout(r, 100));

function filesFor(itemId: string): string[] {
    return fs.readdirSync(service.diskStore!.diskDir).filter(f => f.includes(itemId));
}

async function isCached(itemId: string): Promise<{ memory: boolean; disk: boolean }> {
    return {
        memory: service.cache.get(itemId) !== null,
        disk: (await service.diskStore!.get(itemId)) !== null || filesFor(itemId).length > 0,
    };
}

async function expectEvicted(itemId: string, label: string): Promise<void> {
    const c = await isCached(itemId);
    assert(!c.memory, `${label}: not in the memory cache`);
    assert(!c.disk, `${label}: no file left on disk`);
}

async function main(): Promise<void> {
    console.log('=== Pulse Cache Eviction Tests ===\n');
    initStateEngine();
    assert(service.diskStore !== null, 'Setup: the default service has a disk store');

    const bystander = makeMember('Bystander');
    const bystanderChannel = addChannel({ ownerPubkey: bystander, platform: 'youtube', raw: 'https://www.youtube.com/@bystander', category: 'craft' });
    insertItem('item_bystander', bystanderChannel.id, bystander, new Date().toISOString());
    await cacheImage('item_bystander');
    const seeded = await isCached('item_bystander');
    assert(seeded.memory && seeded.disk, 'Setup: a cached image is in memory and on disk');

    // ── 1. Retention prune ──────────────────────────────────────────────────────
    console.log('\n--- 1. prunePulseItems ---');
    const pruneOwner = makeMember('PruneOwner');
    const pruneChannel = addChannel({ ownerPubkey: pruneOwner, platform: 'youtube', raw: 'https://www.youtube.com/@pruneowner', category: 'craft' });
    insertItem('item_old', pruneChannel.id, pruneOwner, '2020-01-01T00:00:00.000Z');
    insertItem('item_new', pruneChannel.id, pruneOwner, '2026-01-01T00:00:00.000Z');
    await cacheImage('item_old');
    await cacheImage('item_new');
    const pruned = prunePulseItems(1);
    await settle();
    assert(pruned >= 1, 'The older item is pruned');
    await expectEvicted('item_old', 'Pruned item');
    const kept = await isCached('item_new');
    assert(kept.memory && kept.disk, 'The kept item is still cached');

    // ── 2. Channel delete ───────────────────────────────────────────────────────
    console.log('\n--- 2. deleteChannel ---');
    const channelOwner = makeMember('ChannelOwner');
    const channel = addChannel({ ownerPubkey: channelOwner, platform: 'youtube', raw: 'https://www.youtube.com/@channelowner', category: 'craft' });
    insertItem('item_ch_1', channel.id, channelOwner, new Date().toISOString());
    insertItem('item_ch_2', channel.id, channelOwner, new Date().toISOString());
    await cacheImage('item_ch_1');
    await cacheImage('item_ch_2');
    assert(deleteChannel(channelOwner, channel.id), 'The channel is deleted');
    await settle();
    await expectEvicted('item_ch_1', 'Channel item 1');
    await expectEvicted('item_ch_2', 'Channel item 2');

    // ── 3. Self-purge ───────────────────────────────────────────────────────────
    console.log('\n--- 3. purgeMemberSelf ---');
    const leaver = makeMember('Leaver');
    const leaverChannel = addChannel({ ownerPubkey: leaver, platform: 'youtube', raw: 'https://www.youtube.com/@leaver', category: 'craft' });
    insertItem('item_leaver', leaverChannel.id, leaver, new Date().toISOString());
    await cacheImage('item_leaver');
    assert(purgeMemberSelf(leaver).ok, 'The member erases their account');
    await settle();
    await expectEvicted('item_leaver', "Erased member's item");

    // ── 4. Inactivity prune ─────────────────────────────────────────────────────
    console.log('\n--- 4. adminPruneUser ---');
    const inactive = makeMember('Inactive');
    const inactiveChannel = addChannel({ ownerPubkey: inactive, platform: 'youtube', raw: 'https://www.youtube.com/@inactive', category: 'craft' });
    insertItem('item_inactive', inactiveChannel.id, inactive, new Date().toISOString());
    await cacheImage('item_inactive');
    adminPruneUser(inactive, 'owner:password');
    await settle();
    await expectEvicted('item_inactive', "Pruned member's item");

    // ── 5. Bystander ────────────────────────────────────────────────────────────
    console.log('\n--- 5. Unrelated items ---');
    const still = await isCached('item_bystander');
    assert(still.memory && still.disk, "Another member's cached image is untouched");

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
