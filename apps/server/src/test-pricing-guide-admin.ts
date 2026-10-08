/**
 * Test suite for Pricing Guide Admin routes (apps/server/src/routes/pricing-guide.ts).
 *
 * Covers:
 * 1. Admin authorization check on admin routes.
 * 2. POST /api/pricing-guide/admin/item (validation errors, photo checks, create & update item).
 * 3. DELETE /api/pricing-guide/admin/item/:id (404 on missing item, 200 on success).
 * 4. POST /api/pricing-guide/admin/pin (400 validation, 404 on missing item, 200 on success).
 * 5. POST /api/pricing-guide/admin/config (200 updating config).
 * 6. POST /api/pricing-guide/admin/reset (200 resetting catalog).
 * 7. POST /api/pricing-guide/admin/aggregate (200 triggering pricing aggregation cycle).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-pricing-guide-admin.ts
 */

import http from 'node:http';
import Koa from 'koa';
import { initSchema } from './db/db.js';
import { createPricingGuideRoutes } from './routes/pricing-guide.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        process.exitCode = 1;
    }
}

async function main() {
    console.log('🧪 Starting Pricing Guide Admin Routes Test Suite...\n');

    initSchema();

    let isAdmin = true;

    const app = new Koa();

    // Koa middleware to parse JSON request body into (ctx.request as any).body
    app.use(async (ctx, next) => {
        if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
            const chunks: Buffer[] = [];
            for await (const chunk of ctx.req) {
                chunks.push(chunk as Buffer);
            }
            const raw = Buffer.concat(chunks).toString('utf-8');
            try {
                (ctx.request as any).body = raw ? JSON.parse(raw) : {};
            } catch {
                (ctx.request as any).body = {};
            }
        }
        await next();
    });

    const deps: any = {
        checkAdminAuth: async (ctx: any) => {
            if (!isAdmin) {
                ctx.status = 401;
                ctx.body = { error: 'Unauthorized' };
                return false;
            }
            return true;
        },
        rateLimit: () => true,
    };

    const router = createPricingGuideRoutes(deps);
    app.use(router.routes()).use(router.allowedMethods());

    const server = http.createServer(app.callback()).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    async function req(method: string, path: string, body?: any) {
        const res = await fetch(`${baseUrl}${path}`, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
        });
        let json: any = {};
        try {
            json = await res.json();
        } catch {
            /* ignore JSON parse errors */
        }
        return { status: res.status, body: json };
    }

    try {
        // 1. Auth check rejection
        console.log('1. Admin Auth Check Rejection');
        isAdmin = false;
        const unauthRes = await req('POST', '/api/pricing-guide/admin/config', { dataSource: 'local' });
        assert(unauthRes.status === 401 && unauthRes.body.error === 'Unauthorized', 'Rejects request when checkAdminAuth fails');

        isAdmin = true;

        // 2. POST /api/pricing-guide/admin/item
        console.log('\n2. POST /api/pricing-guide/admin/item');
        // Missing required fields
        const missingFieldsRes = await req('POST', '/api/pricing-guide/admin/item', { name: 'Incomplete' });
        assert(missingFieldsRes.status === 400 && missingFieldsRes.body.error?.includes('Missing required item fields'),
            'Rejects item creation with missing required fields (400)');

        // Invalid photo value
        const invalidPhotoRes = await req('POST', '/api/pricing-guide/admin/item', {
            category: 'food',
            emoji: '🍎',
            name: 'Apple',
            priceBeans: 5,
            thumbnailUrl: 'invalid-photo-url-schema',
        });
        assert(invalidPhotoRes.status === 400 && !!invalidPhotoRes.body.error, 'Rejects item with unacceptable photo format (400)');

        // Valid item creation
        const createRes = await req('POST', '/api/pricing-guide/admin/item', {
            category: 'food',
            emoji: '🍎',
            name: 'Organic Honeycrisp Apple',
            description: 'Crisp and juicy',
            priceBeans: 4,
            unit: 'lb',
            isPinned: false,
        });
        assert(createRes.status === 200 && createRes.body.success === true && !!createRes.body.item?.id, 'Creates custom catalog item (200)');
        const newItemId = createRes.body.item.id;

        // Valid item update
        const updateRes = await req('POST', '/api/pricing-guide/admin/item', {
            id: newItemId,
            category: 'food',
            emoji: '🍎',
            name: 'Organic Honeycrisp Apple (Updated)',
            description: 'Crisp, juicy and sweet',
            priceBeans: 5,
            unit: 'lb',
            isPinned: true,
        });
        assert(updateRes.status === 200 && updateRes.body.item?.name === 'Organic Honeycrisp Apple (Updated)' && updateRes.body.item?.priceBeans === 5,
            'Updates existing catalog item (200)');

        // 3. POST /api/pricing-guide/admin/pin
        console.log('\n3. POST /api/pricing-guide/admin/pin');
        const invalidPinRes = await req('POST', '/api/pricing-guide/admin/pin', { id: newItemId });
        assert(invalidPinRes.status === 400, 'Rejects pin request missing isPinned boolean (400)');

        const pin404Res = await req('POST', '/api/pricing-guide/admin/pin', { id: 'non-existent-id', isPinned: true });
        assert(pin404Res.status === 404 && pin404Res.body.error === 'Item not found', 'Returns 404 when pinning non-existent item');

        const pin200Res = await req('POST', '/api/pricing-guide/admin/pin', { id: newItemId, isPinned: false });
        assert(pin200Res.status === 200 && pin200Res.body.success === true, 'Successfully unpins existing item (200)');

        // 4. DELETE /api/pricing-guide/admin/item/:id
        console.log('\n4. DELETE /api/pricing-guide/admin/item/:id');
        const delete404Res = await req('DELETE', '/api/pricing-guide/admin/item/non-existent-id');
        assert(delete404Res.status === 404 && delete404Res.body.error === 'Item not found', 'Returns 404 when deleting non-existent item');

        const delete200Res = await req('DELETE', `/api/pricing-guide/admin/item/${newItemId}`);
        assert(delete200Res.status === 200 && delete200Res.body.success === true, 'Successfully deletes item from catalog (200)');

        // 5. POST /api/pricing-guide/admin/config
        console.log('\n5. POST /api/pricing-guide/admin/config');
        const configRes = await req('POST', '/api/pricing-guide/admin/config', {
            dataSource: 'local',
            showSeasonality: true,
        });
        assert(configRes.status === 200 && configRes.body.success === true && configRes.body.config?.dataSource === 'local',
            'Updates pricing guide node config (200)');

        // 6. POST /api/pricing-guide/admin/reset
        console.log('\n6. POST /api/pricing-guide/admin/reset');
        const resetRes = await req('POST', '/api/pricing-guide/admin/reset');
        assert(resetRes.status === 200 && resetRes.body.success === true && resetRes.body.message === 'Catalog reset to defaults',
            'Resets pricing guide catalog to shipped defaults (200)');

        // 7. POST /api/pricing-guide/admin/aggregate
        console.log('\n7. POST /api/pricing-guide/admin/aggregate');
        const aggRes = await req('POST', '/api/pricing-guide/admin/aggregate');
        assert(aggRes.status === 200 && aggRes.body.success === true && typeof aggRes.body.updatedCount === 'number',
            'Triggers pricing aggregation cycle (200)');

    } finally {
        server.close();
    }

    console.log(`\n🎉 Pricing Guide Admin Routes Test Summary: ${passed}/${run} assertions passed.\n`);
    if (passed !== run) {
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
