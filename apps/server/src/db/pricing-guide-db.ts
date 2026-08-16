/**
 * Pricing Guide DB Access & Operations (#206).
 */

import { db } from './db.js';
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
 * Seeds the default catalog if the pricing_guide_items table is empty.
 * If forceReset is true, clears all existing items and re-seeds defaults.
 */
export function seedPricingGuideIfEmpty(forceReset: boolean = false, dbHandle?: import('better-sqlite3').Database): void {
    const activeDb = dbHandle || db;
    if (forceReset) {
        // Delete child reports before parent items to preserve FK constraints
        activeDb.prepare('DELETE FROM pricing_reports').run();
        activeDb.prepare('DELETE FROM pricing_guide_items').run();
    }

    const insert = activeDb.prepare(`
        INSERT OR IGNORE INTO pricing_guide_items (
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
    const id = item.id || `custom-${crypto.randomBytes(6).toString('hex')}`;
    const existing = getPricingGuideItem(id);

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
            item.thumbnailUrl || null,
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
            item.thumbnailUrl || null
        );
    }

    return getPricingGuideItem(id)!;
}

export function deletePricingGuideItem(id: string): boolean {
    const tx = db.transaction(() => {
        db.prepare('DELETE FROM pricing_reports WHERE item_id = ?').run(id);
        const res = db.prepare('DELETE FROM pricing_guide_items WHERE id = ?').run(id);
        return res.changes > 0;
    });
    return tx();
}

export function pinPricingGuideItem(id: string, isPinned: boolean): boolean {
    const res = db.prepare(`
        UPDATE pricing_guide_items
        SET is_pinned = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
    `).run(isPinned ? 1 : 0, id);
    return res.changes > 0;
}

export function submitPricingReport(
    itemId: string,
    reportType: 'too_high' | 'too_low' | 'other',
    comment?: string,
    reporterPubkey?: string
): string {
    const id = `rep-${crypto.randomBytes(8).toString('hex')}`;
    db.prepare(`
        INSERT INTO pricing_reports (id, item_id, reporter_pubkey, report_type, comment, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(id, itemId, reporterPubkey || null, reportType, comment || null);
    return id;
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
