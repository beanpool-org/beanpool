/**
 * A listing photo's focus point: the part of each photo its cards keep (Marty, 26 Nov 2026: "she wanted to be able to select
 * the area of the photo being displayed in the cropped view on the card"). @beanpool/core photo-focus.ts, posts.photo_focus.
 *
 * Over real HTTP through the real signature middleware:
 *  1. Create: a valid focus per photo is stored and read back beside `photos`; a bad entry is that photo's none; entries past
 *     the last photo are dropped; absent, not a list, or all bad stores NULL and the post reads with no `photoFocus` at all.
 *  2. Edit: `photoFocus` alone sets it (no photo re-stored); photos reordered without it carry each photo's focus with the
 *     photo; a new photo has none; `photoFocus: null` clears it; an edit naming neither leaves it.
 *  3. The other doors: an event, and an enterprise's Offer by its keeper; a poll keeps none.
 *  4. The standby copy: the main server's export carries it, and a standby's import writes it (insert and update), plain
 *     assignment so a cleared focus clears.
 *  5. Federation: a linked community's listing carries no photos at all (federation-listings.ts), so no focus.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-photo-focus.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, createTreasury, adminAssignTreasuryOperator, exportSyncState, importRemoteState, setNodeRole } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { startP2P } from './p2p.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';
import { pinMainServerForTests, unpinMainServerForTests } from './standby-pin-test-helper.js';

let BASE = '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
const HOUR = 60 * 60 * 1000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };

function makeIdentity(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, status, joined_at, updated_at)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .run(pubKeyHex, callsign);
    setMemberPhoto(db, pubKeyHex, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

async function signedFetch(path: string, body: unknown, id: Id) {
    const bodyString = JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': signRequest(id.privateKey, { method: 'POST', path, timestamp: ts, nonce, body: bodyString }),
        [SIGNED_FOR_HEADER]: signedForHost(),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: bodyString });
    let json: any;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body: json, error: json?.error as string | undefined };
}

const stored = (id: string) => (db.prepare('SELECT photo_focus FROM posts WHERE id = ?').get(id) as { photo_focus: string | null } | undefined)?.photo_focus;
const photoStamps = (id: string) => JSON.stringify(db.prepare('SELECT order_num, updated_at FROM post_photos WHERE post_id = ? ORDER BY order_num').all(id));

async function main(): Promise<void> {
    console.log('\nPhoto focus points: stored, read, edited, copied (real HTTP)\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const alice = makeIdentity('AliceMember');
    const keeper = makeIdentity('KeeperDan');
    const { publicKey: enterprise } = createTreasury('Riverside Orchard', AVATAR, 0, { leadKeeperPubkey: keeper.pubKeyHex });
    adminAssignTreasuryOperator(enterprise, keeper.pubKeyHex, 'admin');

    const offer = (title: string, extra: Record<string, unknown>) => signedFetch('/api/marketplace/posts', {
        type: 'offer', authorPublicKey: alice.pubKeyHex, title, category: 'food', price_c: 500, description: 'Fresh',
        lat: -28.55, lng: 153.5, ...extra,
    }, alice);

    // ── 1. Create ─────────────────────────────────────────────────────────────
    console.log('── 1. Create: valid, invalid, absent ──');
    const CREATE: Array<[string, Record<string, unknown>, string | null, unknown]> = [
        ['one focus per photo', { photos: [JPEG, PNG], photoFocus: [{ x: 0.2, y: 0.8 }, { x: 1, y: 0 }] },
            '[{"x":0.2,"y":0.8},{"x":1,"y":0}]', [{ x: 0.2, y: 0.8 }, { x: 1, y: 0 }]],
        ['a bad entry is that photo\'s none', { photos: [JPEG, PNG], photoFocus: [{ x: 2, y: 0.5 }, { x: 0.4, y: 0.6 }] },
            '[null,{"x":0.4,"y":0.6}]', [null, { x: 0.4, y: 0.6 }]],
        ['past the last photo dropped', { photos: [JPEG], photoFocus: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }] },
            '[{"x":0.1,"y":0.1}]', [{ x: 0.1, y: 0.1 }]],
        ['rounded to three places', { photos: [JPEG], photoFocus: [{ x: 0.123456, y: 0.5 }] }, '[{"x":0.123,"y":0.5}]', [{ x: 0.123, y: 0.5 }]],
        ['absent', { photos: [JPEG] }, null, undefined],
        ['not a list', { photos: [JPEG], photoFocus: { x: 0.5, y: 0.5 } }, null, undefined],
        ['a string', { photos: [JPEG], photoFocus: '[{"x":0.5,"y":0.5}]' }, null, undefined],
        ['all bad', { photos: [JPEG], photoFocus: [{ x: '0.5', y: 0.5 }] }, null, undefined],
        ['null', { photos: [JPEG], photoFocus: null }, null, undefined],
    ];
    let firstId = '';
    for (const [name, extra, wantStored, wantRead] of CREATE) {
        const res = await offer(`Loaf ${name}`, extra);
        assert(res.status === 200 && res.body?.success === true, `${name}: created (got ${res.status} ${res.error ?? ''})`);
        const id = res.body?.post?.id as string;
        if (!firstId) firstId = id;
        assert(stored(id) === wantStored, `${name}: stored ${wantStored} (got ${stored(id)})`);
        assert(same(res.body?.post?.photoFocus, wantRead), `${name}: read back ${JSON.stringify(wantRead)} (got ${JSON.stringify(res.body?.post?.photoFocus)})`);
        if (wantRead === undefined) assert(!('photoFocus' in (res.body?.post ?? {})), `${name}: the post reads with no photoFocus at all, as before`);
    }

    // ── 2. Edit ───────────────────────────────────────────────────────────────
    console.log('── 2. Edit ──');
    const edit = (updates: Record<string, unknown>) => signedFetch('/api/marketplace/posts/update', { id: firstId, authorPublicKey: alice.pubKeyHex, ...updates }, alice);
    const stampsBefore = photoStamps(firstId);
    const onlyFocus = await edit({ photoFocus: [{ x: 0.3, y: 0.3 }, { x: 0.7, y: 0.7 }] });
    assert(onlyFocus.status === 200, `focus-only edit accepted (got ${onlyFocus.status} ${onlyFocus.error ?? ''})`);
    assert(stored(firstId) === '[{"x":0.3,"y":0.3},{"x":0.7,"y":0.7}]', `focus-only edit stored (got ${stored(firstId)})`);
    assert(same(onlyFocus.body?.post?.photoFocus, [{ x: 0.3, y: 0.3 }, { x: 0.7, y: 0.7 }]), 'focus-only edit read back');
    assert(photoStamps(firstId) === stampsBefore, 'a focus-only edit re-stores no photo (their URLs stay the same)');

    const titleOnly = await edit({ title: 'Loaf renamed' });
    assert(titleOnly.status === 200 && stored(firstId) === '[{"x":0.3,"y":0.3},{"x":0.7,"y":0.7}]', 'an edit naming neither photos nor focus leaves it');

    const [url0, url1] = onlyFocus.body.post.photos as string[];
    const swapped = await edit({ photos: [url1, url0] });
    assert(swapped.status === 200, `photos swapped without focus accepted (got ${swapped.status} ${swapped.error ?? ''})`);
    assert(stored(firstId) === '[{"x":0.7,"y":0.7},{"x":0.3,"y":0.3}]', `each photo keeps its focus when the order changes (got ${stored(firstId)})`);

    const [s0] = swapped.body.post.photos as string[];
    const replaced = await edit({ photos: [s0, JPEG] });
    assert(replaced.status === 200, `a photo replaced without focus accepted (got ${replaced.status} ${replaced.error ?? ''})`);
    assert(stored(firstId) === '[{"x":0.7,"y":0.7}]', `the kept photo keeps its focus, the new one has none (got ${stored(firstId)})`);

    const both = await edit({ photos: replaced.body.post.photos, photoFocus: [null, { x: 0.05, y: 0.95 }] });
    assert(both.status === 200 && stored(firstId) === '[null,{"x":0.05,"y":0.95}]', `photos and focus sent together: the focus sent wins (got ${stored(firstId)})`);

    const bad = await edit({ photoFocus: [{ x: -1, y: 0 }] });
    assert(bad.status === 200 && stored(firstId) === null, `an edit whose focus is all bad clears it, never a 400 (got ${bad.status}, ${stored(firstId)})`);

    await edit({ photoFocus: [{ x: 0.5, y: 0.1 }] });
    const cleared = await edit({ photoFocus: null });
    assert(cleared.status === 200 && stored(firstId) === null && !('photoFocus' in cleared.body.post), 'photoFocus null clears it, and the post reads as before');

    // ── 3. The other doors ────────────────────────────────────────────────────
    console.log('── 3. Event, enterprise Offer, poll ──');
    const event = await signedFetch('/api/marketplace/posts', {
        type: 'event', authorPublicKey: alice.pubKeyHex, title: 'Harvest day', description: 'At the orchard', lat: -28.55, lng: 153.5,
        eventStartAt: inHours(24), photos: [JPEG], photoFocus: [{ x: 0.5, y: 0.9 }],
    }, alice);
    assert(event.status === 200 && stored(event.body?.post?.id) === '[{"x":0.5,"y":0.9}]', `an event keeps its focus (got ${event.status} ${event.error ?? ''})`);
    const entOffer = await signedFetch(`/api/treasury/${enterprise}/offer`, {
        title: 'Orchard apples', category: 'food', price_c: 300, description: 'Crisp', lat: -28.55, lng: 153.5,
        photos: [JPEG], photoFocus: [{ x: 0.25, y: 0.25 }],
    }, keeper);
    const entId = entOffer.body?.post?.id ?? entOffer.body?.id;
    assert(entOffer.status === 200 && stored(entId) === '[{"x":0.25,"y":0.25}]', `an enterprise's Offer by its keeper keeps its focus (got ${entOffer.status} ${entOffer.error ?? ''})`);
    const poll = await signedFetch('/api/marketplace/posts', {
        type: 'poll', authorPublicKey: alice.pubKeyHex, title: 'Market day?', description: '',
        pollOptions: [{ id: 'a', text: 'Saturday' }, { id: 'b', text: 'Sunday' }], photos: [JPEG], photoFocus: [{ x: 0.5, y: 0.5 }],
    }, alice);
    if (poll.status === 200) assert(stored(poll.body?.post?.id) === null, 'a poll keeps no photo, so no focus');
    else assert(true, `poll not made here (${poll.status}): nothing to check`);

    // ── 4. Standby copy ───────────────────────────────────────────────────────
    console.log('── 4. Standby copy ──');
    const kept = await offer('Jam jars', { photos: [JPEG, PNG], photoFocus: [{ x: 0.6, y: 0.2 }] });
    const keptId = kept.body.post.id as string;
    const gone = await offer('Honey', { photos: [JPEG], photoFocus: [{ x: 0.1, y: 0.9 }] });
    const goneId = gone.body.post.id as string;
    const p2p = await startP2P(0, 0);
    const nodeId = p2p.peerId.toString();
    const snapshot = await exportSyncState(nodeId);
    const exported = (snapshot as any).posts?.find((p: any) => p.id === keptId);
    assert(same(exported?.photoFocus, [{ x: 0.6, y: 0.2 }]), `the main server's copy carries the focus (got ${JSON.stringify(exported?.photoFocus)})`);
    const noFocus = (snapshot as any).posts?.find((p: any) => p.id === firstId);
    assert(noFocus && !('photoFocus' in noFocus), 'a post with none carries none');

    // As a standby that holds an older row of one, a row cleared of another's focus, and none of the third.
    db.prepare(`UPDATE posts SET photo_focus = NULL, updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(keptId);
    db.prepare(`UPDATE posts SET photo_focus = '[{"x":0.9,"y":0.9}]', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(firstId);
    db.prepare('DELETE FROM post_photos WHERE post_id = ?').run(goneId);
    db.prepare('DELETE FROM posts WHERE id = ?').run(goneId);
    pinMainServerForTests(nodeId);
    setNodeRole('backup');
    try {
        await importRemoteState(snapshot);
        assert(stored(keptId) === '[{"x":0.6,"y":0.2}]', `the standby's update writes the focus (got ${stored(keptId)})`);
        assert(stored(goneId) === '[{"x":0.1,"y":0.9}]', `the standby's insert writes the focus (got ${stored(goneId)})`);
        assert(stored(firstId) === null, `a focus cleared on the main server is cleared on the standby (got ${stored(firstId)})`);
    } finally {
        setNodeRole('primary');
        unpinMainServerForTests();
    }

    console.log(`\nAll done: ${passed}/${run} assertions passed.\n`);
    process.exit(passed < run ? 1 : 0);
}

main().catch(err => {
    console.error('Test failed with unhandled error:', err);
    process.exit(1);
});
