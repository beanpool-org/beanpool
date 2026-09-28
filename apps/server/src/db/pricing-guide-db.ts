/**
 * Pricing Guide DB Access & Operations (#206).
 *
 * The guide and its members' reports are copied to a standby verbatim (plain tables, design G4): the main server alone
 * writes them, every writer here refuses on a standby first (config/node-role.ts assertPlainTablesWritable), and a delete
 * writes a tombstone so a standby drops the row too. A report without a member's key stays on this server
 * (engine/replication-manifest.ts MEMBERS_REPORTS), and its delete writes none.
 */

import { db, deletePlainRows } from './db.js';
import { admitByAddress } from './writes-by-address.js';
import { travellingRows } from '../engine/replication-manifest.js';
import { assertPlainTablesWritable } from '../config/node-role.js';
import { stripImageValue } from '../storage/image-metadata.js';
import {
    DEFAULT_PRICING_CATALOG,
    DEFAULT_PRICING_CONFIG,
    type PricingGuideItem,
    type PricingCategory,
    type PricingReport,
    type PricingConfig,
} from '@beanpool/core';
import crypto from 'node:crypto';

/**
 * Seeds the default catalog if the pricing_guide_items table is empty (db.ts, on a main server's boot).
 * If forceReset is true, clears all existing items and re-seeds defaults: every report and every item that isn't a
 * default goes, with a tombstone for each that travelled (a report without a member's key writes none), and each default
 * item is written back over its row, which moves its stamp. A default
 * item deleted and written in again could share the millisecond with its tombstone, and a standby applying that
 * tombstone after the row would lose the item.
 */
export function seedPricingGuideIfEmpty(forceReset: boolean = false, dbHandle?: import('better-sqlite3').Database): void {
    const activeDb = dbHandle || db;
    if (forceReset) {
        assertPlainTablesWritable();
        // Delete child reports before parent items to preserve FK constraints
        deletePlainRows('pricing_reports', '1 = 1');
        deletePlainRows('pricing_guide_items', 'id NOT IN (SELECT value FROM json_each(?))',
            JSON.stringify(DEFAULT_PRICING_CATALOG.map((item) => item.id)));
    }

    const insert = activeDb.prepare(`
        INSERT OR ${forceReset ? 'REPLACE' : 'IGNORE'} INTO pricing_guide_items (
            id, category, emoji, name, description, price_beans, unit,
            is_pinned, confidence_count, trend, seasonality_hint, thumbnail_url, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `);

    const seedTx = activeDb.transaction(() => {
        for (const item of DEFAULT_PRICING_CATALOG) {
            insert.run(
                item.id,
                item.category,
                item.emoji,
                item.name,
                item.description,
                item.priceBeans,
                item.unit || null,
                item.isPinned ? 1 : 0,
                item.confidenceCount || 0,
                item.trend || 'stable',
                item.seasonalityHint || null,
                item.thumbnailUrl || null
            );
        }
    });

    seedTx();
}

export function getPricingGuideItems(category?: string, query?: string): PricingGuideItem[] {
    let sql = 'SELECT * FROM pricing_guide_items WHERE 1=1';
    const params: any[] = [];

    if (category && category !== 'all') {
        sql += ' AND category = ?';
        params.push(category);
    }

    if (query && query.trim()) {
        sql += ' AND (name LIKE ? OR description LIKE ?)';
        const q = `%${query.trim()}%`;
        params.push(q, q);
    }

    sql += ' ORDER BY category ASC, name ASC';

    const rows = db.prepare(sql).all(...params) as any[];
    return rows.map(r => ({
        id: r.id,
        category: r.category as PricingCategory,
        emoji: r.emoji,
        name: r.name,
        description: r.description,
        priceBeans: r.price_beans,
        unit: r.unit || undefined,
        isPinned: Boolean(r.is_pinned),
        confidenceCount: r.confidence_count,
        trend: r.trend,
        seasonalityHint: r.seasonality_hint || undefined,
        thumbnailUrl: r.thumbnail_url || undefined,
        updatedAt: r.updated_at,
    }));
}

export function getPricingGuideItem(id: string): PricingGuideItem | null {
    const r = db.prepare('SELECT * FROM pricing_guide_items WHERE id = ?').get(id) as any;
    if (!r) return null;
    return {
        id: r.id,
        category: r.category as PricingCategory,
        emoji: r.emoji,
        name: r.name,
        description: r.description,
        priceBeans: r.price_beans,
        unit: r.unit || undefined,
        isPinned: Boolean(r.is_pinned),
        confidenceCount: r.confidence_count,
        trend: r.trend,
        seasonalityHint: r.seasonality_hint || undefined,
        thumbnailUrl: r.thumbnail_url || undefined,
        updatedAt: r.updated_at,
    };
}

export function savePricingGuideItem(item: {
    id?: string;
    category: PricingCategory;
    emoji: string;
    name: string;
    description: string;
    priceBeans: number;
    unit?: string;
    isPinned?: boolean;
    seasonalityHint?: string;
    thumbnailUrl?: string;
}): PricingGuideItem {
    assertPlainTablesWritable();
    const id = item.id || `custom-${crypto.randomBytes(6).toString('hex')}`;
    const existing = getPricingGuideItem(id);
    // An operator's thumbnail is any string, a photo's data URL included, and the guide is read by every member:
    // stored without its metadata like every other photo on the node (G9a-3). A link comes back as given.
    const thumbnailUrl = stripImageValue(item.thumbnailUrl) || null;

    if (existing) {
        db.prepare(`
            UPDATE pricing_guide_items SET
                category = ?,
                emoji = ?,
                name = ?,
                description = ?,
                price_beans = ?,
                unit = ?,
                is_pinned = ?,
                seasonality_hint = ?,
                thumbnail_url = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?
        `).run(
            item.category,
            item.emoji,
            item.name,
            item.description,
            item.priceBeans,
            item.unit || null,
            item.isPinned !== undefined ? (item.isPinned ? 1 : 0) : (existing.isPinned ? 1 : 0),
            item.seasonalityHint || null,
            thumbnailUrl,
            id
        );
    } else {
        db.prepare(`
            INSERT INTO pricing_guide_items (
                id, category, emoji, name, description, price_beans, unit,
                is_pinned, confidence_count, trend, seasonality_hint, thumbnail_url, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'stable', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        `).run(
            id,
            item.category,
            item.emoji,
            item.name,
            item.description,
            item.priceBeans,
            item.unit || null,
            item.isPinned ? 1 : 0,
            item.seasonalityHint || null,
            thumbnailUrl
        );
    }

    return getPricingGuideItem(id)!;
}

export function deletePricingGuideItem(id: string): boolean {
    assertPlainTablesWritable();
    const tx = db.transaction(() => {
        deletePlainRows('pricing_reports', 'item_id = ?', id);
        return deletePlainRows('pricing_guide_items', 'id = ?', id) > 0;
    });
    return tx();
}

export function pinPricingGuideItem(id: string, isPinned: boolean): boolean {
    assertPlainTablesWritable();
    const res = db.prepare(`
        UPDATE pricing_guide_items
        SET is_pinned = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
    `).run(isPinned ? 1 : 0, id);
    return res.changes > 0;
}

/**
 * What price reports may add in a day (#1295 review 4126894855; design scratch/global-node/DESIGN-replica-flood-bounds-
 * opus.md §6.1). A member's go into every standby's copy (engine/replication-manifest.ts MEMBERS_REPORTS); the rest (no
 * key, or the key of someone who isn't a member here) can be sent by anyone, with no key at all, and stay on this server.
 */
export const PRICE_REPORT_RULES = {
    /** A member's reports in any 24 hours, counted from the table. A careful member reports a handful. */
    memberPerDay: 20,
    /**
     * Reports without a member's key from one address in any 24 hours. The design's 5 would bite: the phone app sends
     * every report unsigned (apps/native components/PricingGuideModal.tsx), and a mobile network shares one address
     * among many people, so members on one carrier count together here.
     */
    otherPerAddressPerDay: 20,
    /**
     * Reports without a member's key on this node in any 24 hours, from every address together ('busy'): far past any
     * real guide's use. A flood can block only these for the day, never a member's signed reports.
     */
    otherPerNodePerDay: 200,
    /** Reports without a member's key are pruned this many days after they were sent, with no tombstone: none travelled. */
    otherKeptDays: 30,
} as const;

/** A report the rules above took, or why not: past the member's day, past the address's, or past the node's. */
export type PricingReportResult = { id: string } | { refused: 'member_rate_limited' | 'rate_limited' | 'busy' };

/** The condition on reports that travel (engine/replication-manifest.ts MEMBERS_REPORTS): a member's. Never NULL. */
const MEMBERS_REPORT = travellingRows('pricing_reports') ?? '1';

/**
 * A price report, as PRICE_REPORT_RULES allow. `reporterPubkey`: the request's verified signer, if any. `addressHash`:
 * the request's address as writes_by_address keys it (engine/open-join.ts writeAddressHash), worked out only for a
 * report without a member's key, the only one it counts; null (this server's own code) counts toward the node's day
 * only. A report without a member's key first prunes the month-old ones, with no tombstone.
 */
export function submitPricingReport(
    itemId: string,
    reportType: 'too_high' | 'too_low' | 'other',
    comment?: string,
    reporterPubkey?: string,
    addressHash: (() => string) | null = null,
): PricingReportResult {
    assertPlainTablesWritable();
    return db.transaction((): PricingReportResult => {
        const reporter = reporterPubkey || null;
        const isMember = reporter !== null
            && !!db.prepare('SELECT 1 FROM members WHERE public_key = ? AND is_visitor = 0').get(reporter);
        if (isMember) {
            const today = (db.prepare(`SELECT COUNT(*) AS n FROM pricing_reports WHERE reporter_pubkey = ?
                AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')`).get(reporter) as { n: number }).n;
            if (today >= PRICE_REPORT_RULES.memberPerDay) return { refused: 'member_rate_limited' };
        } else {
            // No tombstones: these never travelled (db.ts deletePlainRows follows the manifest's RowRule).
            deletePlainRows('pricing_reports', `created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) AND NOT (${MEMBERS_REPORT})`,
                `-${PRICE_REPORT_RULES.otherKeptDays} days`);
            const refused = admitByAddress('price_report', addressHash ? addressHash() : null, {
                perAddressPerDay: PRICE_REPORT_RULES.otherPerAddressPerDay, perNodePerDay: PRICE_REPORT_RULES.otherPerNodePerDay,
            });
            if (refused) return { refused };
        }
        const id = `rep-${crypto.randomBytes(8).toString('hex')}`;
        db.prepare(`
            INSERT INTO pricing_reports (id, item_id, reporter_pubkey, report_type, comment, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        `).run(id, itemId, reporter, reportType, comment || null);
        return { id };
    })();
}

export function getPricingReports(status: string = 'pending'): (PricingReport & { itemName?: string; currentPrice?: number })[] {
    const sql = `
        SELECT r.*, i.name as item_name, i.price_beans as current_price
        FROM pricing_reports r
        LEFT JOIN pricing_guide_items i ON r.item_id = i.id
        WHERE r.status = ?
        ORDER BY r.created_at DESC
    `;
    const rows = db.prepare(sql).all(status) as any[];
    return rows.map(r => ({
        id: r.id,
        itemId: r.item_id,
        reporterPubkey: r.reporter_pubkey || undefined,
        reportType: r.report_type,
        comment: r.comment || undefined,
        status: r.status,
        createdAt: r.created_at,
        itemName: r.item_name || undefined,
        currentPrice: r.current_price !== null ? r.current_price : undefined,
    }));
}

export function updatePricingReportStatus(id: string, status: 'accepted' | 'dismissed'): boolean {
    assertPlainTablesWritable();
    const res = db.prepare('UPDATE pricing_reports SET status = ? WHERE id = ?').run(status, id);
    return res.changes > 0;
}

export function getPricingConfig(): PricingConfig {
    const rows = db.prepare("SELECT key, value FROM node_config WHERE key LIKE 'pricing_%'").all() as any[];
    const map = new Map(rows.map(r => [r.key, r.value]));

    const dataSource = (map.get('pricing_data_source') || 'local') as PricingConfig['dataSource'];
    const showSeasonality = map.get('pricing_show_seasonality') !== 'false';

    return {
        dataSource: ['local', 'federation', 'all'].includes(dataSource) ? dataSource : 'local',
        showSeasonality,
    };
}

export function updatePricingConfig(config: Partial<PricingConfig>): PricingConfig {
    const tx = db.transaction(() => {
        if (config.dataSource !== undefined) {
            db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)').run('pricing_data_source', config.dataSource);
        }
        if (config.showSeasonality !== undefined) {
            db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)').run('pricing_show_seasonality', String(config.showSeasonality));
        }
    });

    tx();
    return getPricingConfig();
}
