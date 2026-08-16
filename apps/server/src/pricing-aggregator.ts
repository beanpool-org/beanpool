/**
 * Pricing Aggregator Worker (#206).
 *
 * Automatically correlates active and recent marketplace listings with
 * community pricing guide items, aggregates community averages, applies outlier
 * filters, and updates confidence levels and 30-day price trends.
 */

import { db } from './db/db.js';
import { aggregateObservedPrice, type PricingTrend } from '@beanpool/core';
import { getPricingConfig } from './db/pricing-guide-db.js';

/**
 * Normalizes text to tokens for keyword matching.
 */
function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2);
}

/**
 * Runs one cycle of the auto-pricing feedback loop.
 */
export function runPricingAggregationCycle(): {
    updatedCount: number;
    totalEvaluated: number;
} {
    const config = getPricingConfig();
    const items = db.prepare('SELECT * FROM pricing_guide_items').all() as any[];
    if (!items.length) return { updatedCount: 0, totalEvaluated: 0 };

    // Query active marketplace posts (and recent completed transactions within 90 days)
    const postsQuery = config.dataSource === 'local'
        ? `SELECT p.id, p.title, p.description, p.credits, p.category, p.created_at, ph.photo_data
           FROM posts p
           LEFT JOIN post_photos ph ON p.id = ph.post_id AND ph.order_num = 0
           WHERE p.active = 1 AND p.origin_node IS NULL AND p.credits > 0`
        : `SELECT p.id, p.title, p.description, p.credits, p.category, p.created_at, ph.photo_data
           FROM posts p
           LEFT JOIN post_photos ph ON p.id = ph.post_id AND ph.order_num = 0
           WHERE p.active = 1 AND p.credits > 0`;

    const posts = db.prepare(postsQuery).all() as any[];

    let updatedCount = 0;

    const updateStmt = db.prepare(`
        UPDATE pricing_guide_items SET
            price_beans = ?,
            confidence_count = ?,
            trend = ?,
            thumbnail_url = COALESCE(?, thumbnail_url),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
    `);

    const updateTx = db.transaction(() => {
        for (const item of items) {
            const nameTokens = tokenize(item.name).filter(t => !['per', 'the', 'and', 'for', 'with', 'set', 'lot', 'pack'].includes(t));
            const itemTokens = tokenize(`${item.name} ${item.description}`);
            if (!itemTokens.length) continue;

            const matchedPrices: number[] = [];
            let latestPhoto: string | null = null;

            for (const post of posts) {
                const postTokens = new Set(tokenize(`${post.title} ${post.description}`));
                const matchScore = itemTokens.filter(t => postTokens.has(t)).length;

                // Match if key title token matches, or matchScore >= 2, or exact name substring
                const postText = `${post.title} ${post.description}`.toLowerCase();
                const nameLower = item.name.toLowerCase();
                const titleTokenMatch = nameTokens.some(t => t.length >= 4 && postTokens.has(t));

                if (titleTokenMatch || matchScore >= 2 || postText.includes(nameLower)) {
                    matchedPrices.push(post.credits);
                    if (post.photo_data && !latestPhoto) {
                        latestPhoto = post.photo_data;
                    }
                }
            }

            const agg = aggregateObservedPrice(matchedPrices, item.price_beans);

            // Determine trend (up, down, stable)
            let trend: PricingTrend = item.trend || 'stable';
            if (agg.count >= 2) {
                if (agg.price > item.price_beans) {
                    trend = 'up';
                } else if (agg.price < item.price_beans) {
                    trend = 'down';
                } else {
                    trend = 'stable';
                }
            }

            // Do not override price on pinned items, but update confidence and photo
            const newPrice = item.is_pinned ? item.price_beans : agg.price;

            updateStmt.run(
                newPrice,
                agg.count,
                trend,
                latestPhoto || null,
                item.id
            );

            updatedCount++;
        }
    });

    updateTx();
    return { updatedCount, totalEvaluated: items.length };
}

let aggregatorInterval: NodeJS.Timeout | null = null;

/**
 * Starts the hourly pricing aggregator worker.
 */
export function startPricingAggregatorWorker(intervalMs: number = 3600_000): void {
    if (aggregatorInterval) return;

    // Run initial cycle shortly after boot (unref to avoid hanging tests)
    const initialTimer = setTimeout(() => {
        try {
            runPricingAggregationCycle();
        } catch (e) {
            console.error('[PricingAggregator] Error during initial cycle:', e);
        }
    }, 5000);
    if (initialTimer.unref) initialTimer.unref();

    aggregatorInterval = setInterval(() => {
        try {
            runPricingAggregationCycle();
        } catch (e) {
            console.error('[PricingAggregator] Error during cycle:', e);
        }
    }, intervalMs);

    if (aggregatorInterval.unref) aggregatorInterval.unref();
}

/**
 * Stops the aggregator worker (for testing / server shutdown).
 */
export function stopPricingAggregatorWorker(): void {
    if (aggregatorInterval) {
        clearInterval(aggregatorInterval);
        aggregatorInterval = null;
    }
}
