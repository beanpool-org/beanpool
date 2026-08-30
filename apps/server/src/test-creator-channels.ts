/**
 * Creator channel tests (The Pulse, Phase 1).
 *
 * Three properties matter enough to pin down, because getting any of them wrong is not a cosmetic
 * bug:
 *
 *   1. NORMALISATION — a member pastes `@handle`, a bare domain, or a share-sheet URL with an
 *      `?igsh=` tail. All three are the same channel. If they are not collapsed, the duplicate
 *      check never fires and the same person appears twice on their own feed.
 *
 *   2. OWNERSHIP — only the signer may touch their channels. Without it anyone can attach a
 *      neighbour's handle to their own profile, and the feed shows cards attributed to someone who
 *      never consented.
 *
 *   3. DELETION DOES NOT PRESERVE THE LINK — the tombstone must replicate (or a backup restores
 *      the channel) while the URL must not (or a member's removed Instagram handle survives on a
 *      mirror forever).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-creator-channels.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { db } from './db/db.js';
import {
    addChannel, listChannels, listPublicChannels, updateChannel, deleteChannel,
    normaliseChannelInput, otherVideoChannels, ChannelError,
} from './engine/creator-channels.js';
import { exportSyncState, importRemoteState, setNodeRole, initStateEngine, signSyncPayload } from './state-engine.js';
import { startP2P } from './p2p.js';
import { addConnector } from './connector-manager.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function assertThrows(fn: () => unknown, code: string, msg: string): void {
    run++;
    try {
        fn();
        console.error(`✗ ${msg} (expected ${code}, nothing thrown)`);
    } catch (e: any) {
        if (e instanceof ChannelError && e.code === code) { passed++; console.log(`✓ ${msg}`); }
        else console.error(`✗ ${msg} (expected ${code}, got ${e?.code ?? e?.message})`);
    }
}

function makeMember(callsign: string): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(
        `INSERT OR IGNORE INTO members (public_key, callsign, joined_at, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(pub, callsign);
    return pub;
}

async function main(): Promise<void> {
    // The sync round-trip below needs a signed payload, and signing needs the node's peer
    // identity — so p2p comes up, exactly as test-backup-topology does it.
    initStateEngine();
    const p2pNode = await startP2P(4032, 4033);
    // Import also requires the signer to be a trusted peer, so the node trusts itself for the
    // round-trip — the same shape test-backup-topology uses.
    const nodeId = p2pNode.peerId.toString();
    addConnector(`/ip4/127.0.0.1/tcp/4033/p2p/${nodeId}`, 'mirror', 'self-test-peer');

    const kayla = makeMember('Kayla');
    const marty = makeMember('Marty');

    // ── 1. Normalisation ────────────────────────────────────────────────────────────────────
    const bare = normaliseChannelInput('instagram', '@mullum_ceramics');
    const full = normaliseChannelInput('instagram', 'https://www.instagram.com/mullum_ceramics/');
    const tracked = normaliseChannelInput('instagram', 'https://www.instagram.com/mullum_ceramics/?igsh=abc123&utm_source=x');
    assert(bare.url === full.url && full.url === tracked.url,
        'handle, URL and tracking-param URL all normalise to one canonical URL');
    assert(bare.handle === '@mullum_ceramics', 'handle is extracted for display');
    assert(!tracked.url.includes('igsh'), 'tracking parameters are stripped');

    assert(normaliseChannelInput('tiktok', '@nicholasisbarefoot').url === 'https://www.tiktok.com/@nicholasisbarefoot',
        'tiktok bare handle expands to a profile URL');
    assert(normaliseChannelInput('website', 'barefootbotanicals.com.au').url.startsWith('https://'),
        'a bare domain is upgraded to https');

    // A URL claiming to be one platform must actually be that platform, or the resolver would
    // later fetch a YouTube page believing it holds an Instagram profile.
    assertThrows(() => normaliseChannelInput('instagram', 'https://www.youtube.com/@someone'),
        'WRONG_HOST', 'a YouTube URL is rejected for the instagram platform');
    // `new URL` accepts these happily, and they end up as tappable links in the UI.
    assertThrows(() => normaliseChannelInput('website', 'javascript:alert(1)'),
        'BAD_SCHEME', 'javascript: URLs are rejected');
    assertThrows(() => normaliseChannelInput('website', 'data:text/html,<script>'),
        'BAD_SCHEME', 'data: URLs are rejected');
    assertThrows(() => normaliseChannelInput('instagram', ''),
        'EMPTY', 'an empty input is rejected');

    // Regressions from review, all of which produced a broken link or a missed duplicate:
    assert(normaliseChannelInput('instagram', '@Mullum_Ceramics').url === bare.url,
        'handles are case-folded, so @Mullum_Ceramics collides with @mullum_ceramics');
    assert(normaliseChannelInput('youtube', 'https://youtu.be/dQw4w9WgXcQ').url === 'https://youtu.be/dQw4w9WgXcQ',
        'youtu.be short links keep their host (rewriting it 404s)');
    assert(normaliseChannelInput('tiktok', 'https://vm.tiktok.com/ZSabc123/').url.includes('vm.tiktok.com'),
        'vm.tiktok.com short links keep their host');
    assert(normaliseChannelInput('facebook', 'https://www.facebook.com/profile.php?id=100064123').url
            === 'https://www.facebook.com/profile.php?id=100064123',
        'facebook profile.php keeps its id — it is the only address such a page has');
    assert(normaliseChannelInput('facebook', 'https://www.facebook.com/mypage/posts/123').url
            === normaliseChannelInput('facebook', '@mypage').url,
        'facebook paths canonicalise to the page, so one page is one channel');
    assertThrows(() => normaliseChannelInput('instagram', 'instagram.com'),
        'NO_HANDLE', 'a bare platform domain is rejected — it points at no account');

    // Feed URLs carry their identity in the query string — dropping it stored the homepage as the
    // feed, and made two distinct feeds on one blog collide as duplicates.
    assert(normaliseChannelInput('rss', 'https://www.youtube.com/feeds/videos.xml?channel_id=UC123').url
            .includes('channel_id=UC123'),
        'an RSS feed keeps its query string — it is the feed identity');
    assert(normaliseChannelInput('rss', 'https://example.com/?feed=rss2').url
            !== normaliseChannelInput('rss', 'https://example.com/?feed=atom').url,
        'two feeds on one blog stay distinct');
    assert(!normaliseChannelInput('website', 'https://example.com/?utm_source=x&page=2').url.includes('utm_source'),
        'tracking parameters still go, even on a website');

    // YouTube's non-@ forms, one of which is the only path to the channel RSS feed.
    assert(normaliseChannelInput('youtube', 'https://www.youtube.com/channel/UCabc123').handle === 'UCabc123',
        'youtube /channel/UC… is accepted — it is what the autolist feed is built from');
    assert(normaliseChannelInput('youtube', 'https://www.youtube.com/c/SomeName').handle === '@somename',
        'youtube /c/Name is accepted, case-folded like an @handle');

    // These become server-side fetch targets in Phase 2; they must never reach the database.
    for (const [addr, label] of [
        ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
        ['http://localhost:8080/admin', 'localhost'],
        ['http://192.168.1.1/', 'a private LAN address'],
        ['http://10.0.0.5/', 'a private 10.x address'],
        ['http://127.0.0.1:3000/', 'loopback'],
    ] as const) {
        assertThrows(() => normaliseChannelInput('website', addr),
            'PRIVATE_HOST', `${label} is refused as a website`);
    }
    assertThrows(() => normaliseChannelInput('website', 'notadomain'),
        'BAD_URL', 'a bare machine name is refused as a website');

    // Round-three regressions.
    assert(normaliseChannelInput('facebook', 'https://www.facebook.com/groups/123456789').url
            !== normaliseChannelInput('facebook', 'https://www.facebook.com/groups/987654321').url,
        'two facebook groups stay distinct');
    assert(normaliseChannelInput('facebook', 'https://www.facebook.com/people/Some-Name/61553').handle
            === 'people/Some-Name/61553',
        'a modern facebook profile URL keeps its id');
    assert(normaliseChannelInput('website', 'https://www.example.com/feed').url.includes('www.example.com'),
        'www. is kept on a website — some hosts only serve on it');
    assertThrows(() => normaliseChannelInput('website', 'https://user:pass@example.com/feed'),
        'HAS_CREDENTIALS', 'a URL carrying credentials is refused');
    assert(normaliseChannelInput('youtube', 'https://www.youtube.com/c/Foo').url
            === normaliseChannelInput('youtube', 'https://www.youtube.com/c/foo').url,
        'youtube /c/ names are case-folded');
    assert(normaliseChannelInput('youtube', 'https://www.youtube.com/channel/UCabc123').url.includes('UCabc123'),
        'a youtube channel ID keeps its case — it is case-sensitive');
    assertThrows(() => normaliseChannelInput('instagram', 'https://www.instagram.com/stories/someone/123'),
        'NO_HANDLE', 'an instagram story link is not an account');

    // ── 2. Add, duplicate, cap ──────────────────────────────────────────────────────────────
    const ig = addChannel({ ownerPubkey: kayla, platform: 'instagram', raw: '@mullum_ceramics', category: 'craft' });
    assert(ig.url === 'https://www.instagram.com/mullum_ceramics/', 'channel stores the canonical URL');
    assert(ig.supportsAutolist === false, 'instagram cannot be auto-listed');
    assert(ig.isPrimaryVideo === true, 'the first video channel becomes the primary by default');

    // The same channel via a different paste must collide — that is what normalisation buys.
    assertThrows(
        () => addChannel({ ownerPubkey: kayla, platform: 'instagram', raw: 'instagram.com/mullum_ceramics/?igsh=zzz', category: 'craft' }),
        'DUPLICATE', 'the same channel pasted differently is caught as a duplicate');

    const yt = addChannel({ ownerPubkey: kayla, platform: 'youtube', raw: '@mullumceramics', category: 'craft' });
    assert(yt.supportsAutolist === true, 'youtube can be auto-listed');
    assert(otherVideoChannels(kayla, yt.id).length === 1, 'the cross-post warning sees the other video channel');

    assertThrows(() => addChannel({ ownerPubkey: kayla, platform: 'nope' as any, raw: '@x', category: 'craft' }),
        'BAD_PLATFORM', 'an unknown platform is rejected');
    assertThrows(() => addChannel({ ownerPubkey: kayla, platform: 'instagram', raw: '@y', category: 'nope' as any }),
        'BAD_CATEGORY', 'an unknown category is rejected');

    // ── 3. Primary switching ────────────────────────────────────────────────────────────────
    updateChannel(kayla, yt.id, { isPrimaryVideo: true });
    const afterSwitch = listChannels(kayla);
    assert(afterSwitch.filter(c => c.isPrimaryVideo).length === 1, 'exactly one primary video channel survives a switch');
    assert(afterSwitch.find(c => c.id === yt.id)?.isPrimaryVideo === true, 'the newly chosen channel is the primary');

    // A website cannot be the video primary — allowing it demoted every real video channel and
    // left the feed with no cross-post winner.
    const site = addChannel({ ownerPubkey: kayla, platform: 'website', raw: 'mullumceramics.com.au', category: 'craft' });
    assert(site.isPrimaryVideo === false, 'a non-video channel is never marked primary on add');
    assertThrows(() => updateChannel(kayla, site.id, { isPrimaryVideo: true }),
        'NOT_VIDEO', 'a website cannot be made the main video channel');
    assert(listChannels(kayla).filter(c => c.isPrimaryVideo).length === 1,
        'the video primary survives an attempt to move it to a website');

    // Demoting the primary must hand it on, just as deleting it does.
    const ytPrimary = listChannels(kayla).find(c => c.isPrimaryVideo)!;
    updateChannel(kayla, ytPrimary.id, { isPrimaryVideo: false });
    assert(listChannels(kayla).filter(c => c.isPrimaryVideo).length === 1,
        'demoting the primary promotes an heir rather than leaving none');
    updateChannel(kayla, ytPrimary.id, { isPrimaryVideo: true });

    // ── 4. Ownership ────────────────────────────────────────────────────────────────────────
    assertThrows(() => updateChannel(marty, ig.id, { category: 'food' }),
        'NOT_YOURS', 'another member cannot update your channel');
    assertThrows(() => deleteChannel(marty, ig.id),
        'NOT_YOURS', 'another member cannot delete your channel');
    assert(listChannels(marty).length === 0, "another member's channels do not leak into your list");

    // ── 5. Syndication toggle ───────────────────────────────────────────────────────────────
    updateChannel(kayla, ig.id, { syndicateToNode: false });
    assert(listChannels(kayla).length === 3, 'a switched-off channel still shows in your own management view');
    assert(listPublicChannels(kayla).length === 2, 'a switched-off channel is hidden from the public profile');
    updateChannel(kayla, ig.id, { syndicateToNode: true });

    // ── 6. Deletion keeps the tombstone, discards the link ──────────────────────────────────
    const removed = deleteChannel(kayla, ig.id);
    assert(removed, 'delete reports success');
    assert(listChannels(kayla).length === 2, 'a deleted channel leaves the list');

    // Deleting the primary must hand the flag on, or the member keeps video channels with no
    // cross-post winner — the state the primary exists to prevent.
    assert(listChannels(kayla).some(c => c.isPrimaryVideo),
        'deleting a channel leaves a video primary behind');

    const tomb = db.prepare(`SELECT * FROM creator_channels WHERE id = ?`).get(ig.id) as any;
    assert(!!tomb && !!tomb.deleted_at, 'the row survives as a tombstone so the deletion can replicate');
    assert(tomb.url === null && tomb.handle === null,
        'the deleted link and handle are NULLed — a removed Instagram handle must not survive on a mirror');

    // ── 7. Sync export carries the tombstone ────────────────────────────────────────────────
    const payload = await exportSyncState(nodeId);
    assert(!!payload.signature && !!payload.publicKey, 'the exported payload is signed');
    const exported = payload.creatorChannels ?? [];
    assert(exported.length >= 2, 'creator channels appear in the sync payload at all');
    const exportedTomb = exported.find(c => c.id === ig.id);
    assert(!!exportedTomb?.deletedAt, 'the deletion is exported, so a backup learns about it');
    assert(exportedTomb?.url === null, 'the exported tombstone carries no URL');

    // ── 8. Import converges, and never resurrects a deleted link ────────────────────────────
    // Wipe locally, then import the payload back as a backup node would.
    db.prepare(`DELETE FROM creator_channels`).run();
    assert(listChannels(kayla).length === 0, 'local channels cleared before the import test');

    setNodeRole('backup');
    await importRemoteState(payload as any);

    const reimported = listChannels(kayla);
    assert(reimported.length === 2, 'the live channels are restored by the import');
    const reimportedTomb = db.prepare(`SELECT * FROM creator_channels WHERE id = ?`).get(ig.id) as any;
    assert(!!reimportedTomb?.deleted_at, 'the deleted channel imports as a tombstone, not as a live channel');
    assert(reimportedTomb?.url === null, 'the deleted URL is NOT resurrected by a restore');

    // A stale copy of the row must lose to the newer local one, or a lagging backup could revive
    // a channel the member deleted after the snapshot was taken.
    // Rebuilt without the previous signature and re-signed: the import verifies over the payload
    // minus signature/publicKey, so a mutated copy has to be signed afresh.
    const { signature: _sig, publicKey: _pk, ...unsigned } = payload as any;
    const stale = await signSyncPayload({
        ...unsigned,
        creatorChannels: [{
            ...exportedTomb!,
            url: 'https://www.instagram.com/mullum_ceramics/',
            handle: '@mullum_ceramics',
            deletedAt: null,
            updatedAt: '2000-01-01T00:00:00.000Z',
        }],
    } as any);
    await importRemoteState(stale as any);
    const afterStale = db.prepare(`SELECT * FROM creator_channels WHERE id = ?`).get(ig.id) as any;
    assert(!!afterStale?.deleted_at && afterStale?.url === null,
        'an older payload cannot undo a newer deletion (last-write-wins on updated_at)');

    setNodeRole('primary');

    await p2pNode.stop();

    console.log(`\n${passed}/${run} passed`);
    // Explicit exit, as test-backup-topology does: p2p leaves handles open, so without this the
    // process idles after the last assertion and test-all.sh records a TIMEOUT on a green suite.
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
