/**
 * Pricing Aggregator Worker (#206).
 *
 * Automatically correlates active and recent marketplace listings with
 * community pricing guide items, aggregates community averages, applies outlier
 * filters, and updates confidence levels and 30-day price trends.
 */

import { db } from './db/db.js';
import { aggregateObservedPrice, normalizeCategory, type PricingTrend } from '@beanpool/core';
import { getPricingConfig } from './db/pricing-guide-db.js';

const STOP_WORDS = new Set(['per', 'the', 'and', 'for', 'with', 'set', 'lot', 'pack', 'free']);

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

    // Query active marketplace posts without loading heavy photo blobs into memory
    const postsQuery = config.dataSource === 'local'
        ? `SELECT p.id, p.title, p.description, p.credits, p.category, p.created_at,
                  (SELECT 1 FROM post_photos ph WHERE ph.post_id = p.id LIMIT 1) AS has_photo
           FROM posts p
           WHERE p.active = 1 AND p.origin_node IS NULL AND p.credits > 0`
        : `SELECT p.id, p.title, p.description, p.credits, p.category, p.created_at,
                  (SELECT 1 FROM post_photos ph WHERE ph.post_id = p.id LIMIT 1) AS has_photo
           FROM posts p
           WHERE p.active = 1 AND p.credits > 0`;

    const posts = db.prepare(postsQuery).all() as any[];

    // Pre-tokenize and normalize active posts once outside the item loop (O(posts) instead of O(items × posts))
    const parsedPosts = posts.map(p => ({
        id: p.id,
        category: p.category,
        credits: p.credits,
        hasPhoto: Boolean(p.has_photo),
        tokens: new Set(tokenize(`${p.title} ${p.description}`)),
        text: `${p.title} ${p.description}`.toLowerCase(),
    }));

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
            // [Perf Optimization] Use STOP_WORDS Set for O(1) filtering
            const nameTokens = tokenize(item.name).filter(t => !STOP_WORDS.has(t));
            const itemTokens = tokenize(`${item.name} ${item.description}`);
            if (!itemTokens.length) continue;

            const matchedPrices: number[] = [];
            let latestPhotoUrl: string | null = null;
            const nameLower = item.name.toLowerCase();

            for (const post of parsedPosts) {
                // Category match requirement or exact name substring / high token overlap
                const categoryMatch = !post.category || normalizeCategory(post.category) === normalizeCategory(item.category);

                // [Perf Optimization] Avoid array allocation in O(items x posts) inner loop by counting token overlaps directly
                let matchScore = 0;
                for (const t of itemTokens) {
                    if (post.tokens.has(t)) matchScore++;
                }

                const titleTokenMatch = categoryMatch && nameTokens.some(t => t.length >= 4 && post.tokens.has(t));

                if (post.text.includes(nameLower) || (categoryMatch && matchScore >= 2) || titleTokenMatch) {
                    matchedPrices.push(post.credits);
                    if (post.hasPhoto && !latestPhotoUrl) {
                        latestPhotoUrl = `/api/marketplace/posts/${post.id}/photos/0`;
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

            // Only execute SQLite UPDATE if values actually changed to avoid WAL write churn
            const photoChanged = latestPhotoUrl && latestPhotoUrl !== item.thumbnail_url;
            if (
                newPrice !== item.price_beans ||
                agg.count !== item.confidence_count ||
                trend !== item.trend ||
                photoChanged
            ) {
                updateStmt.run(
                    newPrice,
                    agg.count,
                    trend,
                    latestPhotoUrl || null,
                    item.id
                );
                updatedCount++;
            }
        }
    });

    updateTx();
    return { updatedCount, totalEvaluated: items.length };
}

let aggregatorInterval: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;

/**
 * Starts the hourly pricing aggregator worker.
 */
export function startPricingAggregatorWorker(intervalMs: number = 3600_000): void {
    if (aggregatorInterval || initialTimer) return;

    // Run initial cycle shortly after boot (unref to avoid hanging tests)
    initialTimer = setTimeout(() => {
        initialTimer = null;
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
    if (initialTimer) {
        clearTimeout(initialTimer);
        initialTimer = null;
    }
    if (aggregatorInterval) {
        clearInterval(aggregatorInterval);
        aggregatorInterval = null;
    }
}
