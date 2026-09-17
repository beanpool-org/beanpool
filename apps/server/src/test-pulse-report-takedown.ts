/**
 * Test Suite: reporting a Pulse item, and an operator removing it.
 *
 * Verifies:
 * 1. A member reports another member's Pulse item; the reported member is the item's owner.
 * 2. The report appears in the admin list with the item's title/platform/link.
 * 3. A member cannot report their own item (400).
 * 4. An unknown item, or an already-deleted one, is refused (404); a non-string id is 400.
 * 5. A non-admin cannot action the report (401).
 * 6. Actioning with removePulseItem tombstones the item exactly as the owner's delete does
 *    (url/title/thumbnail_url NULLed), evicts its cached thumbnail, drops it from GET /api/pulse/feed,
 *    and leaves the owner active when suspendUser is not set.
 * 7. The report replicates with its targetPulseItemId (sync export).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-pulse-report-takedown.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.ADMIN_PASSWORD = 'AdminPulseReportSecret123!';

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { initStateEngine, getMember, exportSyncState } from './state-engine.js';
import { initAdminPassword } from './config/local-config.js';
import { checkAdminAuth } from './admin-auth.js';
import { addChannel } from './engine/creator-channels.js';
import { getPulseThumbnailService } from './engine/pulse-thumbnail.js';
import { createAdminRoutes } from './routes/admin.js';
import { createCommunityRoutes } from './routes/community.js';
import { createPulseRoutes } from './routes/pulse.js';

const ADMIN_PW = 'AdminPulseReportSecret123!';

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
    opts: { actor?: string; headers?: Record<string, string>; body?: Record<string, unknown>; query?: Record<string, string> } = {}
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
        request: { headers, body: opts.body ?? {} },
        requestBody: opts.body ?? {},
        query: opts.query ?? {},
        params,
        state: opts.actor ? { actor: opts.actor } : {},
        status: 200,
        body: undefined,
    };

    await layer.stack[layer.stack.length - 1](ctx, async () => {});
    return { status: ctx.status, body: ctx.body };
}

function makeMember(callsign: string): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    db.prepare(
        `INSERT INTO members (public_key, callsign, status, joined_at, updated_at)
         VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(pubkey, callsign);
    return pubkey;
}

function insertItem(id: string, channelId: string, owner: string, title: string): void {
    const now = new Date().toISOString();
    db.prepare(
        `INSERT INTO pulse_items (id, channel_id, owner_pubkey, platform, external_id, url, title, thumbnail_url,
             published_at, category, source, muted, curated, created_at, updated_at)
         VALUES (?, ?, ?, 'youtube', ?, ?, ?, ?, ?, 'craft', 'manual', 0, 0, ?, ?)`
    ).run(id, channelId, owner, `ext_${id}`, `https://www.youtube.com/watch?v=${id}`, title,
        `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, now, now, now);
}

async function main(): Promise<void> {
    console.log('=== Pulse Report & Takedown Tests ===\n');

    initAdminPassword();
    initStateEngine();

    const deps: any = {
        checkAdminAuth,
        rateLimit: () => true,
        clampLimit: (_v: unknown, def = 20) => def,
        clampOffset: () => 0,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
        enforceReadAuth: false,
    };
    const community = createCommunityRoutes(deps);
    const admin = createAdminRoutes(deps);
    const pulse = createPulseRoutes(deps);
    const adminHeaders = { 'x-admin-password': ADMIN_PW };

    const owner = makeMember('Kayla');
    const reporter = makeMember('Reporter');
    const channel = addChannel({ ownerPubkey: owner, platform: 'youtube', raw: 'https://www.youtube.com/@kayla_crafts', category: 'craft' });
    insertItem('item_reported', channel.id, owner, 'Offensive clip');
    insertItem('item_gone', channel.id, owner, 'Already deleted');
    db.prepare(`UPDATE pulse_items SET deleted_at = ?, url = NULL, title = NULL, thumbnail_url = NULL WHERE id = 'item_gone'`)
        .run(new Date().toISOString());

    const feedBefore = await callRouter(pulse, 'GET', '/api/pulse/feed');
    assert(feedBefore.body.items.some((i: any) => i.id === 'item_reported'), 'Setup: the item is on the Pulse feed');

    // ── 1. Report another member's item ─────────────────────────────────────────
    console.log('\n--- 1. Report a Pulse item ---');
    const unsigned = await callRouter(community, 'POST', '/api/reports', {
        body: { targetPulseItemId: 'item_reported', reason: 'Spam' },
    });
    assert(unsigned.status === 401, 'An unsigned report is refused (401)');

    const spoofTarget = makeMember('Bystander');
    const reported = await callRouter(community, 'POST', '/api/reports', {
        actor: reporter,
        body: { targetPulseItemId: 'item_reported', targetPubkey: spoofTarget, reason: 'Hateful content' },
    });
    assert(reported.status === 200 && reported.body?.success === true, 'A member can report another member\'s Pulse item');
    const reportId: string = reported.body?.report?.id;
    assert(reported.body?.report?.targetPubkey === owner, 'The reported member is the item\'s owner, not the targetPubkey the client sent');
    assert(reported.body?.report?.targetPulseItemId === 'item_reported', 'The report records the Pulse item id');

    // ── 2. Admin list ───────────────────────────────────────────────────────────
    console.log('\n--- 2. Admin list ---');
    const list = await callRouter(admin, 'GET', '/api/local/admin/reports', { headers: adminHeaders, query: { status: 'pending' } });
    const listed = list.body?.reports?.find((r: any) => r.id === reportId);
    assert(list.status === 200 && Boolean(listed), 'The Pulse report appears in the admin list');
    assert(listed?.pulseItem?.title === 'Offensive clip' && listed?.pulseItem?.platform === 'youtube'
        && listed?.pulseItem?.url === 'https://www.youtube.com/watch?v=item_reported' && listed?.pulseItem?.removed === false,
        'The admin list carries the item\'s title, platform, link and live state');
    assert(listed?.targetCallsign === 'Kayla', 'The admin list names the owner as the reported member');

    // ── 3. Own item ─────────────────────────────────────────────────────────────
    console.log('\n--- 3. Own item ---');
    const own = await callRouter(community, 'POST', '/api/reports', {
        actor: owner,
        body: { targetPulseItemId: 'item_reported', reason: 'Testing' },
    });
    assert(own.status === 400, 'A member cannot report their own Pulse item (400)');

    // ── 4. Unknown / deleted / malformed ────────────────────────────────────────
    console.log('\n--- 4. Unknown, deleted and malformed items ---');
    const unknown = await callRouter(community, 'POST', '/api/reports', {
        actor: reporter, body: { targetPulseItemId: 'item_does_not_exist', reason: 'Spam' },
    });
    assert(unknown.status === 404, 'Reporting an unknown item is refused (404)');
    const gone = await callRouter(community, 'POST', '/api/reports', {
        actor: reporter, body: { targetPulseItemId: 'item_gone', reason: 'Spam' },
    });
    assert(gone.status === 404, 'Reporting an already-deleted item is refused (404)');
    const malformed = await callRouter(community, 'POST', '/api/reports', {
        actor: reporter, body: { targetPulseItemId: 42, reason: 'Spam' },
    });
    assert(malformed.status === 400, 'A non-string targetPulseItemId is refused (400)');
    const noReason = await callRouter(community, 'POST', '/api/reports', {
        actor: reporter, body: { targetPulseItemId: 'item_reported', reason: '   ' },
    });
    assert(noReason.status === 400, 'A Pulse report still needs a reason (400)');

    // ── 5. Non-admin ────────────────────────────────────────────────────────────
    console.log('\n--- 5. Non-admin cannot action ---');
    const denied = await callRouter(admin, 'POST', `/api/local/admin/reports/${reportId}/action`, {
        actor: reporter,
        headers: { 'x-admin-password': 'WrongPassword!' },
        body: { removePulseItem: true },
    });
    assert(denied.status === 401, 'Actioning a report without admin auth is refused (401)');
    const stillThere = db.prepare('SELECT deleted_at FROM pulse_items WHERE id = ?').get('item_reported') as any;
    assert(stillThere.deleted_at === null, 'The refused action left the item in place');

    // ── 6. Remove from the Pulse ────────────────────────────────────────────────
    console.log('\n--- 6. Remove from the Pulse ---');
    getPulseThumbnailService().cache.set('item_reported', Buffer.from('fake-png'), 'image/png');
    assert(getPulseThumbnailService().cache.get('item_reported') !== null, 'Setup: the item\'s thumbnail is cached');

    const actioned = await callRouter(admin, 'POST', `/api/local/admin/reports/${reportId}/action`, {
        headers: adminHeaders,
        body: { removePulseItem: true },
    });
    assert(actioned.status === 200 && actioned.body?.success === true, 'An admin can action the report with removePulseItem');

    const row = db.prepare('SELECT deleted_at, url, title, thumbnail_url FROM pulse_items WHERE id = ?').get('item_reported') as any;
    assert(row.deleted_at !== null && row.url === null && row.title === null && row.thumbnail_url === null,
        'The item is tombstoned with url/title/thumbnail_url scrubbed, as the owner delete does');
    assert(getPulseThumbnailService().cache.get('item_reported') === null, 'The cached thumbnail is evicted');

    const feedAfter = await callRouter(pulse, 'GET', '/api/pulse/feed');
    assert(!feedAfter.body.items.some((i: any) => i.id === 'item_reported'), 'The item is gone from GET /api/pulse/feed');
    assert(getMember(owner)?.status === 'active', 'The owner is not suspended when suspendUser is not ticked');

    const listAfter = await callRouter(admin, 'GET', '/api/local/admin/reports', { headers: adminHeaders, query: { status: 'actioned' } });
    const actionedRow = listAfter.body?.reports?.find((r: any) => r.id === reportId);
    assert(actionedRow?.status === 'actioned' && actionedRow?.pulseItem?.removed === true,
        'The report is actioned and shows the item as removed');

    // ── 7. Replication ──────────────────────────────────────────────────────────
    console.log('\n--- 7. Sync export ---');
    const payload: any = await exportSyncState('test-node');
    const exported = payload?.abuseReports?.find((r: any) => r.id === reportId);
    assert(exported?.targetPulseItemId === 'item_reported', 'The sync export carries targetPulseItemId');

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
