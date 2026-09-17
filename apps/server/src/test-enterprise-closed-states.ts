/**
 * Enterprise closed states: thread paging, thread posting, map + list visibility, location route status codes.
 * Docs: docs/the-commons.md §2.2, §9 (Slice 6) and the PR #839 review notes.
 *
 * Verifies:
 *  1. GET .../thread clamps paging params the way every other paged route does (clampLimit / clampOffset):
 *     a decimal, negative, huge or non-number `limit` / `offset` is a 200, never a 500.
 *  2. The discussion thread follows the enterprise's own visibility:
 *     - pruned / deleted: the enterprise detail is a 404, so the thread is too (read and post).
 *     - suspended / disabled / completed: the enterprise is still shown, so the thread reads with
 *       readOnly = true and a post is refused with 400 and a "read-only" error. The paused case stays open.
 *  3. GET /api/enterprises/map never pins a suspended, disabled or pruned enterprise.
 *     GET /api/treasuries hides a suspended or disabled enterprise from the public, but still lists it to a
 *     signed keeper of that enterprise (and to a node admin), so a keeper can reach it from the Commons list.
 *  4. Location routes: a permission refusal is 403, a bad body is 400 — including the Settings-app route
 *     on a wound-up enterprise, which used to answer 400 while the signed route answered 403.
 *  5. finaliseWindUp on an enterprise that never had a location does not stamp a location signer.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-enterprise-closed-states.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, createTreasury, adminAssignTreasuryOperator, pauseEnterprise,
    postEnterpriseThreadMessage, finaliseWindUp,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { hashPassword, saveLocalConfig, getLocalConfig } from './config/local-config.js';

const PORT = 8643;
const BASE = `https://localhost:${PORT}`;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const ADMIN_PASSWORD = 'correct-horse-battery-staple-1234';

// Every assertion runs and failures are reported together, so one broken finding does not hide the others.
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); }
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };

function makeIdentity(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, avatar_url, joined_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pubKeyHex, callsign, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

async function signedFetch(method: 'GET' | 'POST' | 'DELETE', path: string, id: Id, body?: any) {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    // The server signs over ctx.path, which excludes the query string.
    const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : bodyString });
    let json: any;
    try { json = await res.json(); } catch { /* */ }
    return { status: res.status, body: json, error: json?.error as string | undefined };
}

async function publicGet(path: string) {
    const res = await fetch(`${BASE}${path}`);
    let json: any;
    try { json = await res.json(); } catch { /* */ }
    return { status: res.status, body: json };
}

async function main() {
    console.log('Running enterprise closed-state tests...\n');
    await initTls();
    initStateEngine();
    const { hash, salt } = hashPassword(ADMIN_PASSWORD);
    saveLocalConfig({ ...getLocalConfig(), adminHash: hash, salt });
    await startHttpsServer(PORT);

    const keeper = makeIdentity('KeeperKim');
    const member = makeIdentity('MemberMo');
    const stranger = makeIdentity('StrangerSam');
    const adminId = makeIdentity('NodeAdmin');
    db.prepare("INSERT OR IGNORE INTO node_roles (member_pubkey, role, granted_at, granted_by) VALUES (?, 'admin', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis')").run(adminId.pubKeyHex);

    const mk = (name: string, withLocation = true) => {
        const { publicKey } = createTreasury(name, AVATAR, 0, withLocation
            ? { leadKeeperPubkey: keeper.pubKeyHex, lat: -28.55, lng: 153.5, locationAuthSigner: keeper.pubKeyHex }
            : { leadKeeperPubkey: keeper.pubKeyHex });
        adminAssignTreasuryOperator(publicKey, keeper.pubKeyHex, 'admin', 0);
        return publicKey;
    };
    const setStatus = (pk: string, status: string) =>
        db.prepare('UPDATE members SET status = ? WHERE public_key = ?').run(status, pk);

    // ── 1. Thread paging params ──
    console.log('── 1. Thread paging ──');
    const paged = mk('PagedBakery');
    for (let i = 0; i < 5; i++) postEnterpriseThreadMessage(paged, member.pubKeyHex, `message ${i}`);
    const pagingCases: Array<[string, number]> = [
        ['offset=1.5', 4],
        ['offset=-3', 5],
        ['offset=1e300', 0],
        ['offset=99999999999999999999', 0],
        ['offset=abc', 5],
        ['limit=2.7', 2],
        ['limit=-1', 5],
        ['limit=1e300', 5],
        ['limit=abc', 5],
        ['limit=2.5&offset=0.5', 2],
    ];
    for (const [qs, expected] of pagingCases) {
        const res = await publicGet(`/api/enterprises/${paged}/thread?${qs}`);
        assert(res.status === 200, `GET thread?${qs} is 200, not a 500 (got ${res.status}${res.body?.error ? `: ${res.body.error}` : ''})`);
        assert(Array.isArray(res.body?.messages) && res.body.messages.length === expected,
            `GET thread?${qs} returns ${expected} messages (got ${res.body?.messages?.length})`);
    }

    // ── 2. Thread in each end state ──
    console.log('\n── 2. Thread lifecycle states ──');
    const paused = mk('PausedPantry');
    pauseEnterprise(paused, keeper.pubKeyHex);
    const pausedGet = await signedFetch('GET', `/api/enterprises/${paused}/thread`, member);
    assert(pausedGet.status === 200 && pausedGet.body.readOnly === false, 'Paused enterprise thread stays open (readOnly false)');
    const pausedPost = await signedFetch('POST', `/api/enterprises/${paused}/thread/message`, member, { text: 'still talking' });
    assert(pausedPost.status === 201, `Posting to a paused enterprise thread still works (got ${pausedPost.status})`);

    for (const state of ['suspended', 'disabled', 'completed']) {
        const ent = mk(`ReadOnly_${state}`);
        postEnterpriseThreadMessage(ent, member.pubKeyHex, 'before closing');
        setStatus(ent, state);

        const detail = await publicGet(`/api/enterprise/${ent}`);
        assert(detail.status === 200, `A ${state} enterprise's detail is still shown (got ${detail.status})`);

        const get = await signedFetch('GET', `/api/enterprises/${ent}/thread`, member);
        assert(get.status === 200, `GET thread of a ${state} enterprise is 200 (got ${get.status})`);
        assert(get.body.readOnly === true, `GET thread of a ${state} enterprise is readOnly (got ${get.body.readOnly})`);
        assert(get.body.messages.length === 1, `GET thread of a ${state} enterprise still shows its history`);

        for (const poster of [member, keeper]) {
            const post = await signedFetch('POST', `/api/enterprises/${ent}/thread/message`, poster, { text: 'after closing' });
            assert(post.status === 400, `POST to a ${state} enterprise thread is refused with 400 (got ${post.status})`);
            assert(/read-only/.test(post.error || ''), `POST refusal on a ${state} enterprise says read-only (got "${post.error}")`);
        }
        let engineThrew = false;
        try { postEnterpriseThreadMessage(ent, member.pubKeyHex, 'engine direct'); } catch (e: any) { engineThrew = /read-only/.test(e.message); }
        assert(engineThrew, `Engine refuses a post to a ${state} enterprise thread`);
        const count = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(ent) as any).n;
        assert(count === 1, `No message was written to the ${state} enterprise thread (count ${count})`);
    }

    for (const state of ['pruned', 'deleted']) {
        const ent = mk(`Gone_${state}`);
        postEnterpriseThreadMessage(ent, member.pubKeyHex, 'before removal');
        setStatus(ent, state);

        const detail = await publicGet(`/api/enterprise/${ent}`);
        assert(detail.status === 404, `A ${state} enterprise's detail is hidden (got ${detail.status})`);
        const get = await signedFetch('GET', `/api/enterprises/${ent}/thread`, member);
        assert(get.status === 404, `GET thread of a ${state} enterprise is 404 like its detail (got ${get.status})`);
        const anon = await publicGet(`/api/treasury/${ent}/thread`);
        assert(anon.status === 404, `Unsigned GET thread of a ${state} enterprise is 404 (got ${anon.status})`);
        const post = await signedFetch('POST', `/api/enterprises/${ent}/thread/message`, member, { text: 'after removal' });
        assert(post.status === 404, `POST to a ${state} enterprise thread is 404 (got ${post.status})`);
        let engineThrew = false;
        try { postEnterpriseThreadMessage(ent, member.pubKeyHex, 'engine direct'); } catch { engineThrew = true; }
        assert(engineThrew, `Engine refuses a post to a ${state} enterprise thread`);
        const count = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(ent) as any).n;
        assert(count === 1, `No message was written to the ${state} enterprise thread (count ${count})`);
    }

    // ── 3. Map and list visibility ──
    console.log('\n── 3. Map and list ──');
    const activePin = mk('ActivePin');
    const byState: Record<string, string> = {};
    for (const state of ['suspended', 'disabled', 'pruned']) {
        byState[state] = mk(`Pin_${state}`);
        setStatus(byState[state], state);
    }
    for (const mapPath of ['/api/enterprises/map', '/api/map/enterprises', '/api/treasuries/map']) {
        const map = await publicGet(mapPath);
        const keys = new Set((map.body.enterprises as any[]).map(e => e.publicKey));
        assert(keys.has(activePin), `${mapPath} pins an active enterprise`);
        for (const [state, pk] of Object.entries(byState)) {
            assert(!keys.has(pk), `${mapPath} does not pin a ${state} enterprise`);
        }
    }

    const listKeys = (body: any) => new Set((body.treasuries as any[]).map(t => t.publicKey));
    for (const listPath of ['/api/treasuries', '/api/enterprises']) {
        const anon = listKeys((await publicGet(listPath)).body);
        assert(anon.has(activePin), `${listPath} lists an active enterprise`);
        for (const [state, pk] of Object.entries(byState)) {
            assert(!anon.has(pk), `${listPath} (public) hides a ${state} enterprise`);
        }
        const asStranger = listKeys((await signedFetch('GET', listPath, stranger)).body);
        assert(!asStranger.has(byState.suspended) && !asStranger.has(byState.disabled),
            `${listPath} signed by a non-keeper still hides suspended/disabled enterprises`);
        const asKeeper = await signedFetch('GET', listPath, keeper);
        const keeperKeys = listKeys(asKeeper.body);
        assert(keeperKeys.has(byState.suspended) && keeperKeys.has(byState.disabled),
            `${listPath} signed by the keeper still lists their own suspended/disabled enterprise`);
        assert(!keeperKeys.has(byState.pruned), `${listPath} never lists a pruned enterprise, even to its keeper`);
        const row = (asKeeper.body.treasuries as any[]).find(t => t.publicKey === byState.suspended);
        assert(row?.status === 'suspended', `The keeper's own row carries status "suspended" (got ${row?.status})`);
        const asAdmin = listKeys((await signedFetch('GET', listPath, adminId)).body);
        assert(asAdmin.has(byState.suspended) && asAdmin.has(byState.disabled), `${listPath} signed by a node admin lists suspended/disabled enterprises`);
    }
    // The lightweight statuses read keeps suspended/disabled rows: clients use it to mark enterprises inactive.
    const statuses = await publicGet('/api/enterprises/statuses');
    const statusRow = (statuses.body.enterprises as any[]).find(e => e.publicKey === byState.suspended);
    assert(statusRow?.status === 'suspended', 'GET /api/enterprises/statuses still reports a suspended enterprise as suspended');

    // ── 4. Location routes: 403 for permission, 400 for a bad body ──
    console.log('\n── 4. Location status codes ──');
    const shed = mk('LocShed');
    const strangerSet = await signedFetch('POST', `/api/enterprise/${shed}/location`, stranger, { lat: -28.5, lng: 153.5 });
    assert(strangerSet.status === 403, `Stranger setting a location is 403 (got ${strangerSet.status})`);
    const strangerBadBody = await signedFetch('POST', `/api/enterprise/${shed}/location`, stranger, { lat: 'abc', lng: 153.5 });
    assert(strangerBadBody.status === 403, `Stranger with a bad body is still 403, permission first (got ${strangerBadBody.status})`);
    for (const [label, body] of [
        ['non-numeric lat', { lat: 'abc', lng: 153.5 }],
        ['lat only', { lat: -28.5 }],
        ['out of range', { lat: 91, lng: 153.5 }],
    ] as Array<[string, any]>) {
        const res = await signedFetch('POST', `/api/enterprise/${shed}/location`, keeper, body);
        assert(res.status === 400, `Keeper with a bad body (${label}) is 400 (got ${res.status})`);
    }
    const suspendedShed = mk('LocSuspended');
    setStatus(suspendedShed, 'suspended');
    const keeperOnSuspended = await signedFetch('POST', `/api/enterprise/${suspendedShed}/location`, keeper, { lat: -28.5, lng: 153.5 });
    assert(keeperOnSuspended.status === 403, `Keeper setting a pin on a suspended enterprise is 403 (got ${keeperOnSuspended.status})`);

    const woundUp = mk('LocWoundUp');
    setStatus(woundUp, 'completed');
    const signedAdminSet = await signedFetch('POST', `/api/enterprise/${woundUp}/location`, adminId, { lat: -28.5, lng: 153.5 });
    assert(signedAdminSet.status === 403, `Admin SET on a wound-up enterprise via the signed route is 403 (got ${signedAdminSet.status})`);
    const settingsAdminSet = await fetch(`${BASE}/api/local/admin/treasury/${woundUp}/location`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': ADMIN_PASSWORD },
        body: JSON.stringify({ lat: -28.5, lng: 153.5 }),
    });
    assert(settingsAdminSet.status === 403, `Admin SET on a wound-up enterprise via the Settings route is 403 like the signed route (got ${settingsAdminSet.status})`);
    const settingsBadBody = await fetch(`${BASE}/api/local/admin/treasury/${shed}/location`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': ADMIN_PASSWORD },
        body: JSON.stringify({ lat: 'abc', lng: 153.5 }),
    });
    assert(settingsBadBody.status === 400, `Admin Settings route with a bad body is 400 (got ${settingsBadBody.status})`);

    // ── 5. Wind-up without a location stamps no location signer ──
    console.log('\n── 5. Wind-up signer ──');
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const startWindUp = (pk: string) => db.prepare("UPDATE members SET status = 'winding_up', wind_up_initiated_at = ?, wind_up_initiated_by = ? WHERE public_key = ?")
        .run(eightDaysAgo, keeper.pubKeyHex, pk);

    const unpinned = mk('UnpinnedCoop', false);
    const before = db.prepare('SELECT location_auth_signer, auth_signer, location_updated_at FROM members WHERE public_key = ?').get(unpinned) as any;
    startWindUp(unpinned);
    finaliseWindUp(unpinned, adminId.pubKeyHex);
    const after = db.prepare('SELECT status, lat, lng, location_auth_signer, auth_signer, location_updated_at FROM members WHERE public_key = ?').get(unpinned) as any;
    assert(after.status === 'completed', 'Unpinned enterprise wound up');
    assert(after.location_auth_signer === before.location_auth_signer, `Wind-up without a location leaves location_auth_signer unchanged (was ${before.location_auth_signer}, got ${after.location_auth_signer})`);
    assert(after.auth_signer === before.auth_signer, `Wind-up without a location leaves auth_signer unchanged (was ${before.auth_signer}, got ${after.auth_signer})`);
    assert(after.location_updated_at === before.location_updated_at, `Wind-up without a location leaves location_updated_at unchanged (got ${after.location_updated_at})`);

    const pinned = mk('PinnedCoop');
    startWindUp(pinned);
    const res = finaliseWindUp(pinned, adminId.pubKeyHex);
    const pinnedAfter = db.prepare('SELECT lat, lng, location_auth_signer, location_updated_at FROM members WHERE public_key = ?').get(pinned) as any;
    assert(pinnedAfter.lat === null && pinnedAfter.lng === null, 'Wind-up with a location clears it');
    assert(pinnedAfter.location_auth_signer === adminId.pubKeyHex && pinnedAfter.location_updated_at === res.finalisedAt,
        'Wind-up with a location records the finalising actor as the signer of the clear');

    if (passed !== run) {
        console.error(`\n${run - passed} of ${run} enterprise closed-state assertions FAILED`);
        process.exit(1);
    }
    console.log(`\nAll ${passed}/${run} enterprise closed-state tests passed!`);
    process.exit(0);
}

main().catch((err) => {
    console.error('Fatal error in enterprise closed-state test:', err);
    process.exit(1);
});
