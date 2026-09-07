/**
 * The BeanPool learn channel — curated instructional content, seeded on every node.
 *
 * Runs on every boot, not only at genesis: a genesis-only seed reaches new nodes and never
 * touches the communities already running, which are exactly the ones with an empty Pulse.
 * Re-running is a no-op.
 *
 * Follows the Daily Pulse system-identity pattern (see daily-pulse.ts `ensurePulseTreasury`)
 * rather than inventing one:
 *
 *   - the owner is a TREASURY, created by `createTreasury(..., { systemCreated: true })`. That
 *     gives it a real keypair, and `is_treasury = 1` keeps it out of the People directory,
 *     which filters on exactly that flag. A plain member row would list "BeanPool" among the
 *     neighbours.
 *   - a fixed string like 'BEANPOOL' is NOT a usable public key here. Routes validate
 *     `/^[0-9a-f]{64}$/` — GET /api/members/:publicKey/channels among them — so a synthetic
 *     id would 400 on the very endpoint the profile chips use.
 *   - a real member holding the reserved callsign is RENAMED, never reactivated. Flipping
 *     someone back to 'active' to claim a name would undo an admin suspension silently, on
 *     every restart.
 */
import { db } from '../db/db.js';
import { createTreasury } from '../state-engine.js';
import { logger } from '../logger.js';

export const BEANPOOL_CALLSIGN = 'BeanPool';
export const BEANPOOL_LEARN_CHANNEL_ID = 'chan_beanpool_learn';
export const BEANPOOL_LEARN_CHANNEL_URL = 'https://www.youtube.com/channel/UC-b27mPemXxYje4VkKF7hgw';

export interface CuratedItemDef {
    externalId: string;
    publishedAt: string;
    title: string;
}

/** The instructional videos. `externalId` is the YouTube id and the idempotency key. */
export const CURATED_LEARN_ITEMS: readonly CuratedItemDef[] = [
    { externalId: 'tgsN2LiUVa0', publishedAt: '2026-08-04T00:00:00Z', title: 'The BeanPool Economy' },
    { externalId: 'ul4AXLQ5wFw', publishedAt: '2026-08-04T00:00:00Z', title: 'Federation Connector' },
    { externalId: 'qHmPYTzw0JA', publishedAt: '2026-08-04T00:00:00Z', title: 'BeanPool UX Redesign' },
    { externalId: 'vNW7nL89iWI', publishedAt: '2026-08-01T00:00:00Z', title: 'BeanPool — The Neighborhood Economy' },
    { externalId: 'zFFc_81kPzk', publishedAt: '2026-08-01T00:00:00Z', title: 'The BeanPool Blueprint' },
] as const;

/** The BeanPool treasury's public key, creating it if this node has none yet. */
function ensureBeanPoolIdentity(): string {
    const existing = db.prepare(
        `SELECT public_key, is_treasury FROM members
          WHERE lower(callsign) = lower(?) AND status NOT IN ('migrated', 'pruned')`
    ).get(BEANPOOL_CALLSIGN) as { public_key: string; is_treasury: number } | undefined;

    if (existing?.public_key) {
        if (existing.is_treasury === 1) return existing.public_key;
        // A person holds the reserved name. Rename them — same remedy Daily Pulse uses — and
        // leave their status entirely alone.
        db.prepare(`UPDATE members SET callsign = ? WHERE public_key = ?`)
            .run(`${BEANPOOL_CALLSIGN} ${existing.public_key.substring(0, 6)}`, existing.public_key);
    }
    return createTreasury(BEANPOOL_CALLSIGN, 'bundled://sprout', 0, { systemCreated: true }).publicKey;
}

/**
 * Seed (or re-seed) the curated learn channel. Idempotent.
 *
 * Returns the number of curated items inserted this run — 0 on every boot after the first.
 * Failures are logged rather than thrown: a node must still start if this cannot run.
 */
export function seedPulseCurated(): number {
    try {
        // Early boot on a node whose schema predates the Pulse: nothing to do, and say so
        // rather than failing silently forever.
        const cols = (db.prepare(`PRAGMA table_info(pulse_items)`).all() as { name: string }[]).map(c => c.name);
        if (cols.length === 0 || !cols.includes('curated')) {
            logger.warn('SYS', '[PulseSeed] pulse_items missing or has no `curated` column — curated content not seeded');
            return 0;
        }

        return db.transaction(() => {
            const owner = ensureBeanPoolIdentity();
            const now = new Date().toISOString();

            db.prepare(
                `INSERT INTO creator_channels
                    (id, owner_pubkey, platform, url, handle, category, is_primary_video,
                     supports_autolist, syndicate_to_node, created_at, updated_at)
                 VALUES (?, ?, 'youtube', ?, '@BeanPool', 'learn', 1, 0, 1, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                     owner_pubkey     = excluded.owner_pubkey,
                     url              = excluded.url,
                     category         = 'learn',
                     supports_autolist = 0,
                     syndicate_to_node = 1,
                     deleted_at       = NULL,
                     updated_at       = excluded.updated_at`
            ).run(BEANPOOL_LEARN_CHANNEL_ID, owner, BEANPOOL_LEARN_CHANNEL_URL, now, now);

            let inserted = 0;
            for (const item of CURATED_LEARN_ITEMS) {
                const already = db.prepare(
                    `SELECT id FROM pulse_items WHERE channel_id = ? AND external_id = ?`
                ).get(BEANPOOL_LEARN_CHANNEL_ID, item.externalId) as { id: string } | undefined;

                if (already) {
                    // Restore the CONTENT as well as clearing the tombstone. A tombstone is
                    // scrubbed — scrubPulseItems NULLs url/title/thumbnail — so setting
                    // deleted_at = NULL alone would put an item back on the feed with no
                    // title and no link: a broken card that renders worse than nothing.
                    // These are system-managed rows, so the canonical values always win.
                    db.prepare(
                        `UPDATE pulse_items
                            SET curated = 1, source = 'curated', category = 'learn',
                                owner_pubkey = ?, url = ?, title = ?, thumbnail_url = ?,
                                published_at = ?, deleted_at = NULL, updated_at = ?
                          WHERE id = ?`
                    ).run(
                        owner,
                        `https://www.youtube.com/watch?v=${item.externalId}`,
                        item.title,
                        `https://i.ytimg.com/vi/${item.externalId}/hqdefault.jpg`,
                        item.publishedAt,
                        now,
                        already.id,
                    );
                    continue;
                }

                db.prepare(
                    `INSERT INTO pulse_items
                        (id, channel_id, owner_pubkey, platform, external_id, url, title,
                         thumbnail_url, published_at, category, source, muted, curated,
                         created_at, updated_at)
                     VALUES (?, ?, ?, 'youtube', ?, ?, ?, ?, ?, 'learn', 'curated', 0, 1, ?, ?)`
                ).run(
                    `item_curated_${item.externalId}`,
                    BEANPOOL_LEARN_CHANNEL_ID,
                    owner,
                    item.externalId,
                    `https://www.youtube.com/watch?v=${item.externalId}`,
                    item.title,
                    `https://i.ytimg.com/vi/${item.externalId}/hqdefault.jpg`,
                    item.publishedAt,
                    now,
                    now,
                );
                inserted++;
            }
            if (inserted > 0) logger.info('SYS', `[PulseSeed] seeded ${inserted} curated learn item(s)`);
            return inserted;
        })();
    } catch (e: any) {
        // Never block boot. But this must be loud: a silent skip here is how the Pulse ends up
        // permanently empty on a node with nobody the wiser.
        logger.error('SYS', `[PulseSeed] failed to seed curated content: ${e?.message || e}`);
        return 0;
    }
}
