/**
 * Home's listing card kept per place and listings version (routes/home-listings.ts; load rehearsal 7 Nov 2026, §8 fixes 1
 * and 6), over HTTP through the real middleware, on the global profile (where anyone can join in a minute, places are read
 * to their neighbourhood and "Near you" comes nearest first):
 *
 *  1. The same answer, kept or not: a second member at the same place is given the first one's kept read (counted), and
 *     their whole Home is byte for byte what a fresh build gives them; the same for a visitor, and for a point the
 *     request gives.
 *  2. A member never sees another's private card: a group's listing reaches its group's member and no one else, read in
 *     either order; a direct listing reaches the one it is for; an author's listing hidden by reports reaches its author
 *     alone; the author's own listing carries its exact place to them (whole km to anyone else); a keeper and anyone with
 *     something of their own are read for themselves (nothing kept is given them, nothing of theirs is kept).
 *  3. A 304 that would be wrong is a 200: an unchanged Home is still a 304 (from the kept read); then a new listing, an
 *     author going on holiday and coming back, a member joining a group with a listing, a member's starred categories, and
 *     a new event each answer 200 with the change in it.
 *  4. The author's trust: the board gives a listing the badge it always did (the value worked out from the author's own
 *     profile, above Newcomer here: `authorEnergyCycled`), and Home's reads work none out (PostFilter.withoutTier gives 0,
 *     nothing else differs).
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-home-kept-listings)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setMemberPhoto } from '@beanpool/engine';
import { tierForCredit } from '@beanpool/core';
import { TEST_PHOTOS } from './post-test-helper.js';
import { localFetch } from './keepalive-test-fetch.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const SYDNEY = { lat: -33.8688, lng: 151.2093 };
const DAY = 86_400_000;
const SYD = 'Australia/Sydney';
const ASK = '/api/home?cards=market,events,needs,groups&lands=enterprise,group,invite,people,asks,first-need';

async function request(method: 'GET' | 'POST', pathAndQuery: string, body: unknown, id: Id | null, inm?: string) {
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = `${method}\n${pathAndQuery.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
        Object.assign(headers, {
            'X-Public-Key': id.pubKeyHex, 'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
            'X-Timestamp': String(ts), 'X-Nonce': nonce,
        });
    }
    if (inm) headers['If-None-Match'] = inm;
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await localFetch(`${BASE}${pathAndQuery}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text, error: json?.error as string | undefined, etag: res.headers.get('etag') };
}

async function main(): Promise<void> {
    console.log('\nHome: the listing card kept per place and listings version, on the global node\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { homeListingReads, forgetHomeListings } = await import('./routes/home-listings.js');
    const { bumpPostsVersion } = await import('./engine/versions.js');
    const engine = await import('@beanpool/engine');
    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const { stopPricingAggregatorWorker } = await import('./pricing-aggregator.js');
    stopPricingAggregatorWorker();

    const memberAt = (callsign: string, area: { lat: number; lng: number }): Id => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
        const joined = new Date(Date.now() - 60 * DAY).toISOString();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, area_lat, area_lng, area_updated_at)
                    VALUES (?, ?, 'active', ?, 'seed', ?, ?, ?, ?)`)
            .run(pubKeyHex, callsign, joined, `INV-${callsign.toUpperCase()}`, area.lat, area.lng, joined);
        setMemberPhoto(db, pubKeyHex, AVATAR);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
        return { pubKeyHex, privateKey };
    };

    let n = 0;
    const post = async (who: Id, place: { lat: number; lng: number }, body: Record<string, unknown> = {}): Promise<string> => {
        n++;
        resetGatewayRateLimit();
        const r = await request('POST', '/api/marketplace/posts', {
            type: 'offer', category: 'Food', title: `Listing ${n}`, description: 'Plenty', credits: 0, authorPublicKey: who.pubKeyHex, photos: TEST_PHOTOS, ...place, ...body,
        }, who);
        const id = r.body?.post?.id ?? r.body?.id;
        if (!id) throw new Error(`could not post: ${r.status} ${r.error}`);
        return id;
    };
    const home = async (who: Id | null, inm?: string, path = ASK) => {
        resetGatewayRateLimit();
        const r = await request('GET', path, null, who, inm);
        if (r.status !== 200 && r.status !== 304) throw new Error(`home answered ${r.status} ${r.error}`);
        const market = (r.body?.cards?.market?.items ?? []) as any[];
        return { ...r, market, ids: market.map(m => m.id as string) };
    };
    /** A build with nothing kept: what today's code gives. */
    const fresh = async (who: Id | null, path = ASK) => { forgetHomeListings(); return home(who, undefined, path); };
    const strip = (body: any) => { const { generatedAt: _at, ...rest } = body ?? {}; return rest; };
    const counts = () => ({ ...homeListingReads });
    const delta = (before: { made: number; kept: number }) => ({ made: homeListingReads.made - before.made, kept: homeListingReads.kept - before.kept });

    // The neighbourhood: authors of plain listings, and readers with nothing of their own.
    const authorS = memberAt('SydneySi', SYDNEY);
    const authorT = memberAt('TrustyTe', SYDNEY);
    const plainA = memberAt('PlainAy', SYDNEY);
    const plainB = memberAt('PlainBe', SYDNEY);
    const plainC = memberAt('PlainCe', { lat: -33.9, lng: 151.25 });
    for (let i = 0; i < 6; i++) await post(i % 2 ? authorS : authorT, { lat: SYDNEY.lat + i * 0.0013, lng: SYDNEY.lng + i * 0.0007 });

    console.log('── 1. The same answer, kept or not ──');
    {
        forgetHomeListings();
        let before = counts();
        const a = await home(plainA);
        assert(a.status === 200 && a.market.length === 4 && isDeepStrictEqual(delta(before), { made: 1, kept: 0 }), `a member's Home makes the listing read once (${JSON.stringify(delta(before))})`);
        before = counts();
        const b = await home(plainB);
        assert(isDeepStrictEqual(delta(before), { made: 0, kept: 1 }), `a second member at the same place is given the kept read (${JSON.stringify(delta(before))})`);
        const bFresh = await fresh(plainB);
        assert(isDeepStrictEqual(strip(b.body), strip(bFresh.body)) && b.etag === bFresh.etag, 'and their whole Home, and its tag, are what a fresh build gives them');
        assert(isDeepStrictEqual(b.market, a.market), 'the same rows as the first member, the same distances');

        forgetHomeListings();
        before = counts();
        const v1 = await home(null);
        const v2 = await home(null);
        assert(isDeepStrictEqual(delta(before), { made: 1, kept: 1 }) && v1.market.length === 3, `a visitor's read is kept for the next visitor (${JSON.stringify(delta(before))})`);
        const vFresh = await fresh(null);
        assert(isDeepStrictEqual(strip(v2.body), strip(vFresh.body)) && v2.etag === vFresh.etag, "and the visitor's whole Home is what a fresh build gives");
        assert(!v2.text.includes(authorS.pubKeyHex) && !v2.text.includes('SydneySi'), "nobody is named in a visitor's answer");

        // A point the request gives: two members whose own areas differ read from it alike.
        const at = `${ASK}&lat=${SYDNEY.lat}&lng=${SYDNEY.lng}`;
        forgetHomeListings();
        await home(plainA, undefined, at);
        before = counts();
        const c = await home(plainC, undefined, at);
        const cFresh = await fresh(plainC, at);
        assert(delta(before).kept === 1 && isDeepStrictEqual(strip(c.body), strip(cFresh.body)), 'a point the request gives is shared by everyone who gives it, and the answer is the fresh one');
        const cOwn = await fresh(plainC);
        assert(!isDeepStrictEqual(cOwn.market, c.market) || cOwn.market.every((r: any, i: number) => r.distanceKm === c.market[i].distanceKm),
            'and a member\'s own area is a read of its own');
    }

    console.log('── 2. A member never sees another\'s private card ──');
    // A group with a listing near, and one member in it.
    const groupAuthor = memberAt('GroupGo', SYDNEY);
    const groupMember = memberAt('GroupGa', SYDNEY);
    const groupId = crypto.randomUUID();
    db.prepare(`INSERT INTO groups (id, name, slug, created_by) VALUES (?, 'Garden club', 'garden-club', ?)`).run(groupId, groupAuthor.pubKeyHex);
    for (const m of [groupAuthor, groupMember]) db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status) VALUES (?, ?, 'member', 'active')`).run(groupId, m.pubKeyHex);
    const groupOnly = await post(groupAuthor, SYDNEY, { title: 'Club only', audienceScope: 'group', targetGroupId: groupId });
    {
        forgetHomeListings();
        const first = await home(plainA);
        const before = counts();
        const g = await home(groupMember);
        assert(g.ids.includes(groupOnly), "the group's member reads the group's listing in Near you");
        assert(isDeepStrictEqual(delta(before), { made: 0, kept: 0 }), `and is read for themselves: nothing kept is given them, nothing of theirs is kept (${JSON.stringify(delta(before))})`);
        const after = await home(plainB);
        assert(!first.ids.includes(groupOnly) && !after.ids.includes(groupOnly) && !after.text.includes('Club only'), 'a member outside the group never reads it, before or after');
        forgetHomeListings();
        await home(groupMember);
        const next = await home(plainA);
        assert(!next.ids.includes(groupOnly) && !next.text.includes('Club only'), "nor when the group's member read Home first");
        const gFresh = await fresh(groupMember);
        assert(isDeepStrictEqual(strip(g.body), strip(gFresh.body)), "the group member's Home is the fresh one");
    }
    // A direct listing for one member.
    const directFor = memberAt('DirectDi', SYDNEY);
    const directOnly = await post(authorS, SYDNEY, { title: 'Just for you', audienceScope: 'direct', targetPubkey: directFor.pubKeyHex });
    {
        forgetHomeListings();
        await home(plainA);
        const d = await home(directFor);
        const a = await home(plainA);
        assert(d.ids.includes(directOnly) && !a.ids.includes(directOnly) && !a.text.includes('Just for you'), 'a direct listing reaches the member it is for, and no one else');
        forgetHomeListings();
        await home(directFor);
        const a2 = await home(plainB);
        assert(!a2.ids.includes(directOnly), 'in either order');
    }
    // A listing hidden by reports: its author still reads it, nobody else does.
    const hiddenAuthor = memberAt('HiddenHa', SYDNEY);
    const hidden = await post(hiddenAuthor, SYDNEY, { title: 'Reported one' });
    db.prepare(`UPDATE posts SET hidden_by_reports_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(hidden);
    bumpPostsVersion(); // as every hiding path does (engine/auto-moderation.ts, agent-takedowns.ts, burst-cleanup.ts)
    {
        forgetHomeListings();
        await home(plainA);
        const h = await home(hiddenAuthor);
        const a = await home(plainB);
        assert(h.ids.includes(hidden) && !a.ids.includes(hidden) && !a.text.includes('Reported one'), 'a listing hidden by reports reaches its author alone');
    }
    // The author's own listing: its exact place to them, its neighbourhood to anyone else.
    {
        const mine = await post(plainC, SYDNEY, { title: 'Mine exactly' });
        const at = `${ASK}&lat=${SYDNEY.lat + 0.004}&lng=${SYDNEY.lng + 0.003}`;
        forgetHomeListings();
        const other = await home(plainA, undefined, at);
        const own = await home(plainC, undefined, at);
        const otherRow = other.market.find(r => r.id === mine);
        const ownRow = own.market.find(r => r.id === mine);
        assert(!!ownRow && !!otherRow && Number.isInteger(otherRow.distanceKm) && ownRow.distanceKm !== otherRow.distanceKm,
            `the author reads their own listing's exact distance (${ownRow?.distanceKm} km), another member its neighbourhood's (${otherRow?.distanceKm} km)`);
        const ownFresh = await fresh(plainC, at);
        assert(isDeepStrictEqual(strip(own.body), strip(ownFresh.body)), "the author's Home is the fresh one");
    }
    // A keeper of an enterprise is read for themselves.
    {
        const keeper = memberAt('KeeperKa', SYDNEY);
        db.prepare(`INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)`).run(authorT.pubKeyHex, keeper.pubKeyHex);
        forgetHomeListings();
        await home(plainA);
        const before = counts();
        const k = await home(keeper);
        assert(isDeepStrictEqual(delta(before), { made: 0, kept: 0 }) && k.market.length === 4, `a keeper is read for themselves (${JSON.stringify(delta(before))})`);
        db.prepare('DELETE FROM treasury_operators WHERE member_pubkey = ?').run(keeper.pubKeyHex);
    }

    console.log('── 3. A 304 that would be wrong is a 200 ──');
    {
        forgetHomeListings();
        const first = await home(plainA);
        const before = counts();
        const same = await home(plainA, first.etag!);
        assert(same.status === 304 && delta(before).kept === 1, `an unchanged Home is still a 304, from the kept read (got ${same.status})`);

        // A new listing, near.
        const fresher = await post(authorS, { lat: SYDNEY.lat + 0.0002, lng: SYDNEY.lng }, { title: 'Fresh bread' });
        const afterPost = await home(plainA, first.etag!);
        assert(afterPost.status === 200 && afterPost.body.cards.market.total14d === first.body.cards.market.total14d + 1,
            `a new listing near: 200, counted (${first.body.cards.market.total14d} → ${afterPost.body?.cards?.market?.total14d})`);
        assert(isDeepStrictEqual(strip(afterPost.body), strip((await fresh(plainA)).body)), 'and the answer is the fresh one');
        void fresher;

        // The author on holiday, then back.
        await home(plainA);
        resetGatewayRateLimit();
        const away = await request('POST', '/api/members/holiday', { enabled: true }, authorS);
        assert(away.status === 200, `an author goes on holiday (${away.status} ${away.error ?? ''})`);
        const onHoliday = await home(plainA, afterPost.etag!);
        const sIds = new Set((db.prepare('SELECT id FROM posts WHERE author_pubkey = ?').all(authorS.pubKeyHex) as { id: string }[]).map(r => r.id));
        assert(onHoliday.status === 200 && !onHoliday.ids.some(id => sIds.has(id)), "their listings leave Near you at once: 200");
        resetGatewayRateLimit();
        await request('POST', '/api/members/holiday', { enabled: false }, authorS);
        const back = await home(plainA, onHoliday.etag!);
        assert(back.status === 200 && back.ids.some(id => sIds.has(id)), 'and come back when they do: 200');

        // A membership: plainB joins the group with the listing.
        const bBefore = await home(plainB);
        assert(!bBefore.ids.includes(groupOnly), 'before joining, the group\'s listing is not in their Home');
        db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status) VALUES (?, ?, 'member', 'active')`).run(groupId, plainB.pubKeyHex);
        const joined = await home(plainB, bBefore.etag!);
        assert(joined.status === 200 && joined.ids.includes(groupOnly), "a member who joins the group: 200, with the group's listing");
        db.prepare('DELETE FROM group_members WHERE group_id = ? AND member_pubkey = ?').run(groupId, plainB.pubKeyHex);
        const left = await home(plainB, joined.etag!);
        assert(left.status === 200 && !left.ids.includes(groupOnly), 'and who leaves it: 200, without it');

        // A setting: the member's starred categories (the card puts them first).
        const tools = await post(authorT, { lat: SYDNEY.lat + 0.003, lng: SYDNEY.lng }, { title: 'Spare spanner', category: 'tools' });
        const beforeStar = await home(plainA);
        resetGatewayRateLimit();
        const starred = await request('POST', '/api/members/preferences', { publicKey: plainA.pubKeyHex, preferences: { interests: ['tools'] } }, plainA);
        assert(starred.status === 200, `the member stars a category (${starred.status} ${starred.error ?? ''})`);
        const afterStar = await home(plainA, beforeStar.etag!);
        assert(afterStar.status === 200 && afterStar.ids[0] === tools, `a setting: 200, the starred listing first (got ${afterStar.ids[0] === tools ? 'it' : afterStar.ids[0]})`);
        const otherStill = await home(plainB);
        assert(otherStill.ids[0] !== tools || beforeStar.ids[0] === tools, "and another member's order is their own (their stars, none)");

        // A card: a new event near.
        const clockIn = (days: number) => new Intl.DateTimeFormat('en-CA', { timeZone: SYD, year: 'numeric', month: '2-digit', day: '2-digit' })
            .format(new Date(Date.now() + days * DAY)) + 'T10:00';
        const beforeEvent = await home(plainA);
        const event = await post(authorT, SYDNEY, { type: 'event', title: 'Sydney swap', description: 'Bring things', eventStartLocal: clockIn(2), eventTz: SYD, eventPlaceName: 'The hall' });
        const afterEvent = await home(plainA, beforeEvent.etag!);
        assert(afterEvent.status === 200 && (afterEvent.body.cards.events?.items ?? []).some((e: any) => e.id === event), 'a new event near: 200, in Coming up');
    }

    console.log('── 4. The author\'s trust ──');
    {
        db.prepare('UPDATE members SET earned_credit = 400 WHERE public_key = ?').run(authorT.pubKeyHex);
        bumpPostsVersion();
        const expected = tierForCredit(se.getMemberTrustProfile(authorT.pubKeyHex).tierCredit).minCredit;
        resetGatewayRateLimit();
        const board = await request('GET', '/api/marketplace/posts', null, plainA);
        const tRows = (board.body?.posts ?? board.body ?? []).filter((p: any) => p.authorPublicKey === authorT.pubKeyHex);
        assert(expected > 0 && tRows.length > 0 && tRows.every((p: any) => p.authorEnergyCycled === expected),
            `the board gives each of the author's listings the badge worked out from their own profile (${expected}; got ${[...new Set(tRows.map((p: any) => p.authorEnergyCycled))].join(',')})`);
        const withTier = engine.getPosts(db, { types: ['offer', 'need'], viewerPubkey: plainA.pubKeyHex, limit: 100 });
        const without = engine.getPosts(db, { types: ['offer', 'need'], viewerPubkey: plainA.pubKeyHex, limit: 100, withoutTier: true });
        assert(withTier.filter(p => p.authorPublicKey === authorT.pubKeyHex).every(p => p.authorEnergyCycled === expected), 'a read with the badge has the same value');
        assert(without.every(p => p.authorEnergyCycled === 0), 'a read without it (Home\'s) works none out: 0');
        const blank = (ps: typeof withTier) => ps.map(p => ({ ...p, authorEnergyCycled: 0 }));
        assert(isDeepStrictEqual(blank(withTier), blank(without)), 'and nothing else in the read differs');
        const homeText = (await fresh(plainA)).text;
        assert(!homeText.includes('authorEnergyCycled'), 'no Home card carries a badge');
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
