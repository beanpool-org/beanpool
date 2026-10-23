/**
 * Unit tests for routes/shop-refusal.ts:
 *
 *   1. Non-ShopRefusal values (null, undefined, standard Error, primitives, plain objects) return false and leave ctx untouched.
 *   2. ShopRefusal instances set ctx.status and ctx.body = { error: e.message, code: e.code } and return true.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-shop-refusal.ts
 */
import { respondShopRefusal } from './routes/shop-refusal.js';
import { ShopRefusal, dealsOpenRefusal, SHOP_OFFERS_ONLY, SHOP_NOT_YOURS } from './engine/shops.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

function main(): void {
    console.log('=== Testing routes/shop-refusal.ts ===\n');

    // ── 1. Non-ShopRefusal values ──
    console.log('— 1. Non-ShopRefusal values —');
    const nonRefusals = [
        null,
        undefined,
        'plain string',
        123,
        true,
        { status: 400, message: 'fake error', code: 'fake' },
        new Error('standard Error'),
        new TypeError('type error'),
    ];

    for (const val of nonRefusals) {
        const ctx = { status: 200, body: undefined as unknown };
        const handled = respondShopRefusal(ctx, val);
        assert(!handled, `returns false for ${val === null ? 'null' : typeof val === 'object' ? val.constructor.name : typeof val}`);
        assert(ctx.status === 200 && ctx.body === undefined, 'ctx status and body remain untouched');
    }

    // ── 2. ShopRefusal instances ──
    console.log('\n— 2. ShopRefusal instances —');
    const refusalCases = [
        { err: new ShopRefusal(400, 'shop_offers_only', SHOP_OFFERS_ONLY), expectedStatus: 400, expectedCode: 'shop_offers_only', expectedMessage: SHOP_OFFERS_ONLY },
        { err: new ShopRefusal(403, 'shop_not_yours', SHOP_NOT_YOURS), expectedStatus: 403, expectedCode: 'shop_not_yours', expectedMessage: SHOP_NOT_YOURS },
        { err: dealsOpenRefusal(3), expectedStatus: 409, expectedCode: 'shop_deals_open', expectedMessage: "Finish or cancel the 3 open deals on this shop's things first." },
        { err: dealsOpenRefusal(1), expectedStatus: 409, expectedCode: 'shop_deals_open', expectedMessage: "Finish or cancel the 1 open deal on this shop's things first." },
    ];

    for (const c of refusalCases) {
        const ctx = { status: 200, body: undefined as unknown };
        const handled = respondShopRefusal(ctx, c.err);
        assert(handled, `returns true for ShopRefusal (${c.expectedCode})`);
        assert(ctx.status === c.expectedStatus, `sets ctx.status to ${c.expectedStatus}`);
        assert(
            typeof ctx.body === 'object' && ctx.body !== null &&
            (ctx.body as any).error === c.expectedMessage &&
            (ctx.body as any).code === c.expectedCode,
            `sets ctx.body with error and code (${c.expectedCode})`
        );
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
}

main();
