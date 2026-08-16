/**
 * Pricing Guide Routes (#206).
 */

import Router from '@koa/router';
import type { RouteDeps } from './types.js';
import { PRICING_CATEGORIES } from '@beanpool/core';
import {
    getPricingGuideItems,
    getPricingGuideItem,
    savePricingGuideItem,
    deletePricingGuideItem,
    pinPricingGuideItem,
    submitPricingReport,
    getPricingReports,
    updatePricingReportStatus,
    getPricingConfig,
    updatePricingConfig,
    seedPricingGuideIfEmpty,
} from '../db/pricing-guide-db.js';
import { runPricingAggregationCycle } from '../pricing-aggregator.js';

export function createPricingGuideRoutes(deps: RouteDeps): Router {
    const router = new Router();

    /**
     * GET /api/pricing-guide
     * Public list of items, category taxonomy, and node pricing config.
     */
    router.get('/api/pricing-guide', async (ctx) => {
        if (!deps.rateLimit(ctx)) return;

        const category = ctx.query.category as string | undefined;
        const search = ctx.query.q as string | undefined;

        const items = getPricingGuideItems(category, search);
        const config = getPricingConfig();

        ctx.body = {
            items,
            config,
            categories: PRICING_CATEGORIES,
        };
    });

    /**
     * POST /api/pricing-guide/report
     * Public endpoint to submit price feedback (too high, too low, other).
     */
    router.post('/api/pricing-guide/report', async (ctx) => {
        if (!deps.rateLimit(ctx)) return;

        const { itemId, reportType, comment, reporterPubkey } = (ctx.request as any).body || {};

        if (!itemId || !reportType || !['too_high', 'too_low', 'other'].includes(reportType)) {
            ctx.status = 400;
            ctx.body = { error: 'Invalid report parameters. itemId and valid reportType required.' };
            return;
        }

        const reportId = submitPricingReport(itemId, reportType, comment, reporterPubkey);
        ctx.body = { success: true, reportId };
    });

    /**
     * GET /api/pricing-guide/reports
     * Moderator / Admin queue of submitted price reports.
     */
    router.get('/api/pricing-guide/reports', async (ctx) => {
        if (!(await deps.checkAdminAuth(ctx as any))) return;

        const status = (ctx.query.status as string) || 'pending';
        const reports = getPricingReports(status);
        ctx.body = { reports };
    });

    /**
     * POST /api/pricing-guide/reports/:id/status
     * Admin review action (accept or dismiss report).
     */
    router.post('/api/pricing-guide/reports/:id/status', async (ctx) => {
        if (!(await deps.checkAdminAuth(ctx as any))) return;

        const id = ctx.params.id;
        const { status } = (ctx.request as any).body || {};

        if (!['accepted', 'dismissed'].includes(status)) {
            ctx.status = 400;
            ctx.body = { error: 'Invalid status (must be accepted or dismissed)' };
            return;
        }

        const ok = updatePricingReportStatus(id, status);
        ctx.body = { success: ok };
    });

    /**
     * POST /api/pricing-guide/admin/item
     * Admin create or update catalog item.
     */
    router.post('/api/pricing-guide/admin/item', async (ctx) => {
        if (!(await deps.checkAdminAuth(ctx as any))) return;

        const body = (ctx.request as any).body || {};
        const { id, category, emoji, name, description, priceBeans, unit, isPinned, seasonalityHint, thumbnailUrl } = body;

        if (!category || !emoji || !name || typeof priceBeans !== 'number') {
            ctx.status = 400;
            ctx.body = { error: 'Missing required item fields (category, emoji, name, priceBeans)' };
            return;
        }

        const saved = savePricingGuideItem({
            id,
            category,
            emoji,
            name,
            description: description || '',
            priceBeans: Math.max(0, Math.round(priceBeans)),
            unit,
            isPinned: Boolean(isPinned),
            seasonalityHint,
            thumbnailUrl,
        });

        ctx.body = { success: true, item: saved };
    });

    /**
     * DELETE /api/pricing-guide/admin/item/:id
     * Admin delete item from catalog.
     */
    router.delete('/api/pricing-guide/admin/item/:id', async (ctx) => {
        if (!(await deps.checkAdminAuth(ctx as any))) return;

        const id = ctx.params.id;
        const ok = deletePricingGuideItem(id);
        ctx.body = { success: ok };
    });

    /**
     * POST /api/pricing-guide/admin/pin
     * Admin lock/pin an item price to prevent auto-adjustment.
     */
    router.post('/api/pricing-guide/admin/pin', async (ctx) => {
        if (!(await deps.checkAdminAuth(ctx as any))) return;

        const { id, isPinned } = (ctx.request as any).body || {};
        if (!id || typeof isPinned !== 'boolean') {
            ctx.status = 400;
            ctx.body = { error: 'Missing id or boolean isPinned' };
            return;
        }

        const ok = pinPricingGuideItem(id, isPinned);
        ctx.body = { success: ok };
    });

    /**
     * POST /api/pricing-guide/admin/config
     * Admin update node pricing multiplier, data source, seasonality toggle.
     */
    router.post('/api/pricing-guide/admin/config', async (ctx) => {
        if (!(await deps.checkAdminAuth(ctx as any))) return;

        const body = (ctx.request as any).body || {};
        const config = updatePricingConfig(body);
        ctx.body = { success: true, config };
    });

    /**
     * POST /api/pricing-guide/admin/reset
     * Admin restore catalog to default shipped catalog.
     */
    router.post('/api/pricing-guide/admin/reset', async (ctx) => {
        if (!(await deps.checkAdminAuth(ctx as any))) return;

        seedPricingGuideIfEmpty(true);
        ctx.body = { success: true, message: 'Catalog reset to defaults' };
    });

    /**
     * POST /api/pricing-guide/admin/aggregate
     * Manually trigger auto-pricing aggregation cycle.
     */
    router.post('/api/pricing-guide/admin/aggregate', async (ctx) => {
        if (!(await deps.checkAdminAuth(ctx as any))) return;

        const result = runPricingAggregationCycle();
        ctx.body = { success: true, ...result };
    });

    return router;
}
