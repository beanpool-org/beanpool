/**
 * Two small leaks that confirmed a hidden (invite-only) group exists, found in the review of #970.
 *
 * 1. Slugs. POST /api/groups with a name a hidden group already had came back "quiet-circle-2" where a fresh name
 *    came back bare, so a suffix on a name the caller could not see in the list meant a hidden group had it. Every
 *    new slug now carries a random suffix: a taken name and a fresh one come back in the same form.
 * 2. Trade routes. POST /api/marketplace/posts/request and /accept told a non-member holding a group post's id
 *    "Must be an active member of the group", where an unknown id got "Post not found". A caller who cannot see
 *    the post (getPosts: its author and the group's active members only) now gets exactly the unknown-id answer.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import {
    initStateEngine, createGroup, inviteGroupMember, joinGroup, removeGroupMember, createPost,
} from './state-engine.js';
import { createGroupRoutes } from './routes/groups.js';
import { createMarketplaceRoutes } from './routes/marketplace.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

function makeMember(callsign: string): string {
    const pub = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, earned_credit, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', 50, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
        .run(pub, `${callsign}_${crypto.randomBytes(3).toString('hex')}`, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    // An offer on the books, so posting (the covenant) is never what refuses them.
    createPost('offer', 'other', `${callsign}'s offer`, 'covenant', 10, 'fixed', pub, undefined, undefined, [], false);
    return pub;
}

const deps: any = {
    checkAdminAuth: async () => true,
    rateLimit: () => true,
    clampLimit: (n: any) => Number(n) || 50,
    clampOffset: (n: any) => Number(n) || 0,
    activeConnections: new Map(),
    calculateAnalytics: () => ({}),
    enforceReadAuth: false,
};

async function call(router: any, method: string, path: string, actor: string | undefined, body?: any, query: any = {}) {
    const ctx: any = {
        method, path, url: path, request: {}, query, querystring: '',
        state: actor ? { actor } : {},
        requestBody: body,
        headers: {},
        set: () => {},
        get: () => '',
    };
    await router.routes()(ctx, async () => {});
    return ctx;
}

async function main() {
    console.log('🧪 Hidden groups are not confirmed by slugs or trade routes\n');
    await initStateEngine();
    const groups = createGroupRoutes(deps);
    const market = createMarketplaceRoutes(deps);

    const convenor = makeMember('Convenor');
    const member = makeMember('Member');
    const removed = makeMember('Removed');
    const invitee = makeMember('Invitee');
    const outsider = makeMember('Outsider');

    const hidden = createGroup({ name: 'Quiet Circle', description: 'Nobody outside knows', joinPolicy: 'invite_only', createdBy: convenor });
    inviteGroupMember(hidden.id, convenor, member, 'member');
    joinGroup(hidden.id, member);
    inviteGroupMember(hidden.id, convenor, removed, 'member');
    joinGroup(hidden.id, removed);
    removeGroupMember(hidden.id, convenor, removed);
    inviteGroupMember(hidden.id, convenor, invitee, 'member');

    // --- 1. Slugs ---
    const SLUG = /^([a-z0-9-]+)-([a-z2-7]{6})$/;
    {
        const m = SLUG.exec(hidden.slug);
        assert(!!m && m[1] === 'quiet-circle', `slug: a new group's slug is its name plus a random suffix (${hidden.slug})`);

        const listed = ((await call(groups, 'GET', '/api/groups', outsider)).body as any[]);
        assert(!listed.some(x => x.id === hidden.id), 'setup: the outsider is not shown the hidden group');

        const clash = await call(groups, 'POST', '/api/groups', outsider, { name: 'Quiet Circle' });
        const fresh = await call(groups, 'POST', '/api/groups', outsider, { name: 'Loud Circle' });
        assert(clash.status === 201 && fresh.status === 201, 'slug: both creates succeed');
        const cm = SLUG.exec(clash.body.slug), fm = SLUG.exec(fresh.body.slug);
        assert(!!cm && cm[1] === 'quiet-circle', `slug: the hidden group's name comes back as name + suffix (${clash.body.slug})`);
        assert(!!fm && fm[1] === 'loud-circle', `slug: a fresh name comes back in the same form (${fresh.body.slug})`);
        assert(clash.body.slug !== hidden.slug, 'slug: the clash still gets its own slug');
        assert(!/-\d+$/.test(clash.body.slug), 'slug: no counter that would count the hidden group');

        // An explicit slug asking for the hidden group's slug gets the same treatment as any other.
        const asked = await call(groups, 'POST', '/api/groups', outsider, { name: 'Copycat', slug: hidden.slug });
        assert(asked.status === 201 && asked.body.slug !== hidden.slug && SLUG.test(asked.body.slug),
            `slug: asking for a taken slug outright gets a fresh suffixed one (${asked.body.slug})`);

        // Slugs still resolve, and a long name stays inside the 50 characters.
        const bySlug = await call(groups, 'GET', `/api/groups/${fresh.body.slug}`, undefined);
        assert(bySlug.status === 200 && bySlug.body?.id === fresh.body.id, 'slug: GET /api/groups/:slug still finds the group');
        const long = await call(groups, 'POST', '/api/groups', outsider, { name: 'x'.repeat(100) });
        assert(long.status === 201 && long.body.slug.length <= 50 && SLUG.test(long.body.slug), `slug: a long name's slug is at most 50 characters (${long.body.slug.length})`);

        // A slug made before this change (no suffix) still resolves.
        const legacyId = crypto.randomUUID();
        db.prepare(`INSERT INTO groups (id, name, slug, created_by) VALUES (?, 'Old Garden', 'old-garden', ?)`).run(legacyId, convenor);
        const legacy = await call(groups, 'GET', '/api/groups/old-garden', undefined);
        assert(legacy.status === 200 && legacy.body?.id === legacyId, 'slug: an existing unsuffixed slug is unchanged and still resolves');
    }

    // --- 2. Trade routes ---
    const offer = createPost('offer', 'other', 'Circle-only offer', 'for the circle', 5, 'fixed', convenor,
        undefined, undefined, [], false, undefined, false, { audienceScope: 'group', targetGroupId: hidden.id });
    const second = createPost('offer', 'other', 'Circle-only second offer', 'for the circle', 5, 'fixed', convenor,
        undefined, undefined, [], false, undefined, false, { audienceScope: 'group', targetGroupId: hidden.id });
    assert(!!offer && !!second, 'setup: two group offers exist (one to request, one to accept)');

    const ghost = crypto.randomUUID();
    const trade = (route: 'request' | 'accept', postId: string, pk: string) =>
        call(market, 'POST', `/api/marketplace/posts/${route}`, pk, { postId, buyerPublicKey: pk });
    const same = (a: any, b: any) => a.status === b.status && JSON.stringify(a.body) === JSON.stringify(b.body);

    for (const [route, postId] of [['request', offer!.id], ['accept', second!.id]] as const) {
        const control = await trade(route, ghost, outsider);
        assert(control.status === 400 && /^Post not found/.test(control.body?.error ?? ''),
            `${route}: control — an unknown post id answers ${control.status} "${control.body?.error}"`);
        for (const [who, pk] of [['an outsider', outsider], ['a removed member', removed], ['an invitee', invitee]] as const) {
            const res = await trade(route, postId, pk);
            assert(same(res, control), `${route}: ${who} holding the group post's id gets exactly the unknown-id answer (got ${res.status} "${res.body?.error}")`);
        }
    }

    // Members still trade normally.
    {
        const req = await trade('request', offer!.id, member);
        assert(req.body?.success === true && !!req.body?.transaction, `request: an active member can request the group offer (${req.status} ${req.body?.error ?? ''})`);
        const acc = await trade('accept', second!.id, member);
        assert(acc.body?.success === true && !!acc.body?.transaction, `accept: an active member can accept the group offer (${acc.status} ${acc.body?.error ?? ''})`);
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
    process.exit(0);
}

main().catch(err => {
    console.error('✗ FAIL: suite crashed', err);
    process.exit(1);
});
