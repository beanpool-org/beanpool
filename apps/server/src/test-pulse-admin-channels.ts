/**
 * Test Suite: Pulse Admin Curated Channels Management.
 *
 * Verifies:
 * 1. Wrong admin password is refused (401).
 * 2. Adding a channel-shaped YouTube URL yields supports_autolist = 1 and BeanPool ownership.
 * 3. Adding a bare video URL (youtube.com/watch?v=...) yields supports_autolist = 0, and the response says so.
 * 4. The seeded channel cannot be removed through the route (refused by id).
 * 5. A removed channel's items are scrubbed (deleted_at set, url/title/thumbnail NULLed).
 * 6. Re-resolving the seeded channel does NOT duplicate its items (idx_pulse_items_dedupe conflict path).
 * 7. GET /api/local/admin/pulse/channels returns curated channels with item counts and autolist status.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-pulse-admin-channels.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.ADMIN_PASSWORD = 'AdminPulseTestSecret123!';

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { db } from './db/db.js';
import { addChannel } from './engine/creator-channels.js';
import { initStateEngine } from './state-engine.js';
import { initAdminPassword } from './config/local-config.js';
import { checkAdminAuth } from './admin-auth.js';
import { createAdminRoutes } from './routes/admin.js';
import {
    ensureBeanPoolIdentity,
    BEANPOOL_LEARN_CHANNEL_ID,
    BEANPOOL_LEARN_CHANNEL_URL,
    CURATED_LEARN_ITEMS,
    seedPulseCurated,
} from './engine/pulse-seed.js';
import { PULSE_KEEP_PER_CHANNEL } from './engine/pulse-resolver.js';

const ADMIN_PW = 'AdminPulseTestSecret123!';

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

async function callRouter(
    router: any,
    method: string,
    path: string,
    opts: { headers?: Record<string, string>; body?: Record<string, unknown>; query?: Record<string, string> } = {}
): Promise<{ status: number; body: any }> {
    const layer = (router as any).stack.find((l: any) =>
        (l.path === path || l.regexp.test(path)) && l.methods.includes(method.toUpperCase())
    );
    if (!layer) throw new Error(`${method} ${path} is not mounted in router`);

    const headers = opts.headers || {};
    const params: Record<string, string> = {};
    if (layer.paramNames && layer.paramNames.length > 0) {
        const match = layer.regexp.exec(path);
        if (match) {
            layer.paramNames.forEach((param: any, idx: number) => {
                if (match[idx + 1] !== undefined) params[param.name] = match[idx + 1];
            });
        }
    }

    const ctx: any = {
        headers,
        get: (h: string) => headers[h.toLowerCase()],
        request: {
            headers,
            body: opts.body ?? {},
        },
        requestBody: opts.body ?? {},
        query: opts.query ?? {},
        params,
        status: 200,
        body: undefined,
    };

    await layer.stack[layer.stack.length - 1](ctx, async () => {});
    return { status: ctx.status, body: ctx.body };
}

async function main(): Promise<void> {
    console.log('=== Pulse Admin Curated Channels Tests ===\n');

    initAdminPassword();
    initStateEngine();

    const adminRouter = createAdminRoutes({
        checkAdminAuth,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
    } as any);

    const bpOwner = ensureBeanPoolIdentity();

    // ── 1. Wrong admin password is refused (401) ────────────────────────────────
    console.log('--- 1. Auth Protection (401 on wrong password) ---');
    {
        const addBadAuth = await callRouter(adminRouter, 'POST', '/api/local/admin/pulse/channels', {
            headers: { 'x-admin-password': 'WrongPassword!' },
            body: { url: 'https://www.youtube.com/channel/UC1234567890123456789012' },
        });
        assert(addBadAuth.status === 401, 'POST /api/local/admin/pulse/channels rejects wrong password with 401');

        const listBadAuth = await callRouter(adminRouter, 'GET', '/api/local/admin/pulse/channels', {
            headers: { 'x-admin-password': 'WrongPassword!' },
        });
        assert(listBadAuth.status === 401, 'GET /api/local/admin/pulse/channels rejects wrong password with 401');

        const removeBadAuth = await callRouter(adminRouter, 'POST', '/api/local/admin/pulse/channels/remove', {
            headers: { 'x-admin-password': 'WrongPassword!' },
            body: { id: 'chan_xyz' },
        });
        assert(removeBadAuth.status === 401, 'POST /api/local/admin/pulse/channels/remove rejects wrong password with 401');

        const noAuth = await callRouter(adminRouter, 'POST', '/api/local/admin/pulse/channels', {
            body: { url: 'https://www.youtube.com/channel/UC1234567890123456789012' },
        });
        assert(noAuth.status === 401, 'POST /api/local/admin/pulse/channels rejects missing auth with 401');
    }

    const authHeaders = { 'x-admin-password': ADMIN_PW };

    // ── 2. Adding a channel-shaped YouTube URL yields autolist = 1 & BeanPool ownership
    console.log('\n--- 2. Add Channel-Shaped YouTube URL ---');
    let addedChannelId = '';
    {
        const channelUrl = 'https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw';
        const res = await callRouter(adminRouter, 'POST', '/api/local/admin/pulse/channels', {
            headers: authHeaders,
            body: { url: channelUrl, category: 'craft' },
        });

        assert(res.status === 200, 'Adding channel-shaped YouTube URL returns 200');
        assert(res.body.success === true, 'Response body indicates success');
        assert(Boolean(res.body.channel), 'Response contains channel object');
        assert(res.body.channel.supportsAutolist === true, 'Channel supportsAutolist is true');
        assert(res.body.supports_autolist === 1, 'Response supports_autolist is 1');
        assert(res.body.channel.ownerPubkey === bpOwner, 'Channel is owned by BeanPool system identity, NOT personal admin account');
        assert(res.body.channel.category === 'craft', 'Channel category is preserved as specified');
        assert(res.body.channel.platform === 'youtube', 'Platform was detected/set as youtube');

        addedChannelId = res.body.channel.id;

        // Verify row in database
        const dbRow = db.prepare('SELECT * FROM creator_channels WHERE id = ?').get(addedChannelId) as any;
        assert(dbRow !== undefined, 'Channel row exists in database');
        assert(dbRow.owner_pubkey === bpOwner, 'Database row owner is BeanPool system identity');
        assert(dbRow.supports_autolist === 1, 'Database row supports_autolist is 1');
        assert(dbRow.syndicate_to_node === 1, 'Database row syndicate_to_node is 1');
        assert(dbRow.deleted_at === null, 'Database row deleted_at is null');
    }

    // Default category to 'learn'
    {
        const defaultCatUrl = 'https://www.youtube.com/channel/UC9999999999999999999999';
        const res = await callRouter(adminRouter, 'POST', '/api/local/admin/pulse/channels', {
            headers: authHeaders,
            body: { url: defaultCatUrl },
        });
        assert(res.status === 200, 'Adding channel with no category specified returns 200');
        assert(res.body.channel.category === 'learn', 'Category defaults to learn');
    }

    // ── 3. Adding a bare video URL yields supports_autolist = 0 and response says so ──
    console.log('\n--- 3. Add Bare Video URL (supports_autolist = 0) ---');
    let bareVideoChanId = '';
    {
        const videoUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
        const res = await callRouter(adminRouter, 'POST', '/api/local/admin/pulse/channels', {
            headers: authHeaders,
            body: { url: videoUrl, category: 'art' },
        });

        assert(res.status === 200, 'Adding bare video URL returns 200');
        assert(res.body.channel.supportsAutolist === false, 'Bare video channel has supportsAutolist = false');
        assert(res.body.supports_autolist === 0, 'Response indicates supports_autolist = 0');
        assert(res.body.channel.ownerPubkey === bpOwner, 'Bare video channel is owned by BeanPool identity');
        assert(
            typeof res.body.message === 'string' &&
            (res.body.message.toLowerCase().includes('not support') || res.body.message.toLowerCase().includes('manual')),
            `Response message honestly explains that URL does not autolist (got: "${res.body.message}")`
        );

        bareVideoChanId = res.body.channel.id;
        const dbRow = db.prepare('SELECT supports_autolist FROM creator_channels WHERE id = ?').get(bareVideoChanId) as any;
        assert(dbRow.supports_autolist === 0, 'Database row has supports_autolist = 0');
    }

    // ── 4. The seeded channel cannot be removed through the route ───────────────
    console.log('\n--- 4. Seeded Channel Cannot Be Removed ---');
    {
        const res = await callRouter(adminRouter, 'POST', '/api/local/admin/pulse/channels/remove', {
            headers: authHeaders,
            body: { id: BEANPOOL_LEARN_CHANNEL_ID },
        });

        assert(res.status === 400, 'Removing seeded channel returns 400');
        assert(
            typeof res.body.error === 'string' && res.body.error.toLowerCase().includes('seeded'),
            `Refusal message clearly explains the seeded channel cannot be removed (got: "${res.body.error}")`
        );

        // Verify seeded channel remains intact
        const seededChan = db.prepare('SELECT deleted_at FROM creator_channels WHERE id = ?').get(BEANPOOL_LEARN_CHANNEL_ID) as any;
        assert(seededChan !== undefined && seededChan.deleted_at === null, 'Seeded channel was NOT soft-deleted');

        const seededItems = db.prepare('SELECT COUNT(*) as c FROM pulse_items WHERE channel_id = ? AND deleted_at IS NULL').get(BEANPOOL_LEARN_CHANNEL_ID) as any;
        assert(seededItems.c === 5, 'Seeded channel still has all 5 items intact');
    }

    // ── 5. A removed channel's items are scrubbed ────────────────────────────────
    console.log('\n--- 5. Removed Channel Items Are Scrubbed ---');
    {
        // Insert items for addedChannelId
        const now = new Date().toISOString();
        const ins = db.prepare(
            `INSERT INTO pulse_items
                (id, channel_id, owner_pubkey, platform, external_id, url,
                 title, thumbnail_url, published_at, category, source, muted,
                 curated, created_at, updated_at)
             VALUES (?, ?, ?, 'youtube', ?, ?, ?, ?, ?, 'craft', 'autolist', 0, 0, ?, ?)`
        );
        ins.run('item_test_scrub_1', addedChannelId, bpOwner, 'ext_vid_1', 'https://youtube.com/watch?v=ext_vid_1', 'Video 1', 'https://img.com/1.jpg', now, now, now);
        ins.run('item_test_scrub_2', addedChannelId, bpOwner, 'ext_vid_2', 'https://youtube.com/watch?v=ext_vid_2', 'Video 2', 'https://img.com/2.jpg', now, now, now);

        const beforeLiveItems = (db.prepare('SELECT COUNT(*) as c FROM pulse_items WHERE channel_id = ? AND deleted_at IS NULL').get(addedChannelId) as any).c;
        assert(beforeLiveItems >= 2, `Channel has live pulse items before removal (got ${beforeLiveItems})`);

        // Remove channel
        const removeRes = await callRouter(adminRouter, 'POST', '/api/local/admin/pulse/channels/remove', {
            headers: authHeaders,
            body: { id: addedChannelId },
        });
        assert(removeRes.status === 200, 'POST /api/local/admin/pulse/channels/remove returns 200');
        assert(removeRes.body.success === true, 'Removal reports success');

        // Verify channel is soft deleted and scrubbed
        const chanAfter = db.prepare('SELECT deleted_at, url, handle FROM creator_channels WHERE id = ?').get(addedChannelId) as any;
        assert(chanAfter.deleted_at !== null, 'Channel deleted_at is set');
        assert(chanAfter.url === null, 'Channel url is NULLed on tombstone');
        assert(chanAfter.handle === null, 'Channel handle is NULLed on tombstone');

        // Verify pulse items are scrubbed
        const afterLiveItems = (db.prepare('SELECT COUNT(*) as c FROM pulse_items WHERE channel_id = ? AND deleted_at IS NULL').get(addedChannelId) as any).c;
        assert(afterLiveItems === 0, 'No live pulse items remain for removed channel');

        const scrubbedRows = db.prepare('SELECT id, deleted_at, url, title, thumbnail_url FROM pulse_items WHERE channel_id = ?').all(addedChannelId) as any[];
        assert(scrubbedRows.length === beforeLiveItems, `All ${beforeLiveItems} items remain as tombstones for replication`);
        assert(scrubbedRows.every(r => r.deleted_at !== null), 'Every item has deleted_at timestamp set');
        assert(scrubbedRows.every(r => r.url === null), 'Every item has url NULLed');
        assert(scrubbedRows.every(r => r.title === null), 'Every item has title NULLed');
        assert(scrubbedRows.every(r => r.thumbnail_url === null), 'Every item has thumbnail_url NULLed');
    }

    // ── 6. Re-resolving the seeded channel does NOT duplicate its items ─────────
    console.log('\n--- 6. Re-resolving Seeded Channel Does NOT Duplicate Items ---');
    {
        const seededChanRow = db.prepare('SELECT * FROM creator_channels WHERE id = ?').get(BEANPOOL_LEARN_CHANNEL_ID) as any;
        assert(seededChanRow.supports_autolist === 1, 'Seeded channel supports_autolist is 1');

        const initialCount = (db.prepare('SELECT COUNT(*) as c FROM pulse_items WHERE channel_id = ? AND deleted_at IS NULL').get(BEANPOOL_LEARN_CHANNEL_ID) as any).c;
        assert(initialCount === 5, 'Seeded channel has 5 items before simulated re-resolve');

        // Simulate resolver inserting items with matching channel_id and external_id
        // (the exact statement from resolveChannel in pulse-resolver.ts)
        // Test the INVARIANT the resolver depends on, not a copy of the resolver.
        //
        // The previous version of this test pasted resolveChannel's INSERT ... ON CONFLICT
        // into the test body and ran that. It passed, and proved nothing: it asserted that
        // SQL written in the test behaves as written. If the resolver's own statement ever
        // lost its ON CONFLICT clause, that test would still have gone green.
        //
        // What actually protects the seeded items is idx_pulse_items_dedupe — UNIQUE on
        // (channel_id, external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL.
        // So assert the index itself: a second LIVE row for the same pair must be REFUSED
        // by SQLite. A plain INSERT with no conflict clause is the only way to observe that.
        const plainInsert = db.prepare(
            `INSERT INTO pulse_items
                (id, channel_id, owner_pubkey, platform, external_id, url, title,
                 thumbnail_url, published_at, category, source, muted, curated,
                 created_at, updated_at)
             VALUES (?, ?, ?, 'youtube', ?, ?, ?, ?, ?, 'learn', 'autolist', 0, 0, ?, ?)`
        );
        const dupTarget = CURATED_LEARN_ITEMS[0];
        const nowIso = new Date().toISOString();
        let refused = false;
        try {
            plainInsert.run(
                'item_should_not_exist', BEANPOOL_LEARN_CHANNEL_ID, bpOwner,
                dupTarget.externalId, 'https://example.com/dup', 'Duplicate attempt',
                null, dupTarget.publishedAt, nowIso, nowIso,
            );
        } catch (e: any) {
            refused = /UNIQUE|constraint/i.test(String(e?.message || e));
        }
        assert(refused, 'the dedupe index REFUSES a second live row for the same (channel_id, external_id)');

        const stillFive = (db.prepare(
            `SELECT COUNT(*) c FROM pulse_items WHERE channel_id = ? AND deleted_at IS NULL`
        ).get(BEANPOOL_LEARN_CHANNEL_ID) as any).c;
        assert(stillFive === 5, `the seeded channel still has exactly 5 live items (got ${stillFive})`);

        // And the resolver's statement really does carry the conflict clause that relies on
        // that index — checked against the source, because the alternative is a network call
        // to YouTube from a unit test.
        const resolverSrc = readFileSync(new URL('./engine/pulse-resolver.ts', import.meta.url), 'utf-8');
        assert(
            /ON CONFLICT\(channel_id, external_id\)[\s\S]{0,120}DO UPDATE SET/.test(resolverSrc),
            'resolveChannel still inserts with ON CONFLICT(channel_id, external_id) DO UPDATE'
        );

        const totalItemsAfterResolve = (db.prepare('SELECT COUNT(*) as c FROM pulse_items WHERE channel_id = ?').get(BEANPOOL_LEARN_CHANNEL_ID) as any).c;
        assert(totalItemsAfterResolve === 5, `Total rows remains 5 (not 10) — re-resolve did not duplicate items (got ${totalItemsAfterResolve})`);

        const liveItemsAfterResolve = (db.prepare('SELECT COUNT(*) as c FROM pulse_items WHERE channel_id = ? AND deleted_at IS NULL').get(BEANPOOL_LEARN_CHANNEL_ID) as any).c;
        assert(liveItemsAfterResolve === 5, 'Live item count remains exactly 5');

        // The seeded row keeps its deterministic id, so a re-seed or a resolve updates it in
        // place rather than leaving a second copy behind under a random id.
        const sampleRow = db.prepare('SELECT title, id FROM pulse_items WHERE external_id = ? AND channel_id = ?').get(CURATED_LEARN_ITEMS[0].externalId, BEANPOOL_LEARN_CHANNEL_ID) as any;
        assert(sampleRow.id === `item_curated_${CURATED_LEARN_ITEMS[0].externalId}`, 'the seeded item keeps its deterministic id');
        assert(sampleRow.title === CURATED_LEARN_ITEMS[0].title, 'the seeded title is the canonical one');

        // Re-running seedPulseCurated also does not duplicate
        seedPulseCurated();
        const countAfterSeedRerun = (db.prepare('SELECT COUNT(*) as c FROM pulse_items WHERE channel_id = ? AND deleted_at IS NULL').get(BEANPOOL_LEARN_CHANNEL_ID) as any).c;
        assert(countAfterSeedRerun === 5, 'Running seedPulseCurated again preserves exact 5 items');
    }

    // ── 7. GET /api/local/admin/pulse/channels lists channels with item counts ──
    console.log('\n--- 7. GET List Pulse Channels ---');
    {
        const listRes = await callRouter(adminRouter, 'GET', '/api/local/admin/pulse/channels', {
            headers: authHeaders,
        });
        assert(listRes.status === 200, 'GET /api/local/admin/pulse/channels returns 200');
        assert(Array.isArray(listRes.body.channels), 'Response includes channels array');
        assert(listRes.body.channels.length >= 2, 'List includes seeded channel and bare video channel');

        const seededEntry = listRes.body.channels.find((c: any) => c.id === BEANPOOL_LEARN_CHANNEL_ID);
        assert(seededEntry !== undefined, 'Seeded channel is in the listing');
        assert(seededEntry.isSeeded === true, 'Seeded channel has isSeeded = true');
        assert(seededEntry.itemCount === 5, 'Seeded channel reports itemCount = 5');
        assert(seededEntry.supportsAutolist === true, 'Seeded channel reports supportsAutolist = true');
        assert(seededEntry.category === 'learn', 'Seeded channel category is learn');

        const bareEntry = listRes.body.channels.find((c: any) => c.id === bareVideoChanId);
        assert(bareEntry !== undefined, 'Bare video channel is in the listing');
        assert(bareEntry.supportsAutolist === false, 'Bare video channel reports supportsAutolist = false');
        assert(bareEntry.isSeeded === false, 'Bare video channel has isSeeded = false');
    }


    // ── The panel renders operator input into innerHTML ──────────────────────────
    // Every interpolation in loadPulseChannels() goes through esc(), which stops attribute
    // breakout — but esc() cannot stop a javascript: scheme reaching an href. The node
    // settings page is where the admin password lives, so a stored javascript: URL there
    // would be the highest-value XSS target on the node. addChannel must refuse it before
    // it can ever be stored.
    for (const hostile of [
        'javascript:alert(document.cookie)',
        'data:text/html,<script>alert(1)</script>',
        'http://localhost:8443/api/local/admin/data',
        'http://169.254.169.254/latest/meta-data/',
    ]) {
        let rejected = false;
        try {
            addChannel({ ownerPubkey: bpOwner, platform: 'website', raw: hostile, category: 'learn' });
        } catch {
            rejected = true;
        }
        assert(rejected, `addChannel refuses ${hostile.slice(0, 34)}`);
    }
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        console.error('❌ Pulse admin channels checks FAILED.');
        process.exit(1);
    }
    console.log('⭐️ Pulse admin channels checks PASSED.');
    process.exit(0);
}

main().catch(err => {
    console.error('Unhandled error in test-pulse-admin-channels:', err);
    process.exit(1);
});
