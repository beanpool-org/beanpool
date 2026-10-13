/**
 * Listing pushes by area through the sockets' index (ws-area-index.ts, #1791 item 5) against the full loop over every
 * socket that came before it: the same sockets get the same frames, push after push, while the world changes under them.
 *
 * In this process, on the global profile (listings sync by area), fake sockets in the real set (addWsClient), the real
 * broadcast, and every change through the code that makes it on a node:
 *   1. a seeded world: 3,000 members, areas anywhere, on and either side of the antimeridian and at and around both
 *      poles, a tenth with no area; 3,500+ sockets: a member's, two of one member's, keyless ones, ones mid-join
 *   2. 1,200 pushes of a listing (new_post with the post, post_updated and post_removed by id, some with parties of a
 *      removal), each sent once through the full loop and once through the index, the frames each socket got compared;
 *      between pushes, at random: a socket connects, disconnects, dies on a send; a member sets, moves or clears their
 *      area; an area changes under the map's refresh as an import's does; a member re-keys and connects with the new
 *      key; a member is removed; someone mid-join joins; rows change behind the map and it loads again whole.
 *      After every change and every push, the index's rules (WsClients.inspect): every open socket with a key is filed
 *      under exactly that key and nothing else is; with the cells built, they hold exactly the keys with an open socket
 *      and an area, each in its own cell. Then every socket closes, and the index is empty
 *      Members near a listing block its author and unblock them, its parties block it, and its author blocks members
 *      near it, between pushes too (#1812): every push is checked on its own, both ways, against who it must reach
 *      worked out from the rows: every party, blocked or not, and every member near it who did not block its author;
 *      nobody else, so not a near non-party who did (#1831). Each kind of block is also made once at a fixed point of
 *      every run, followed by pushes of its listing of every kind, so no radius leaves one to luck
 *   2b. no code writes a socket's key but the connect (before the socket is in the set) and wsClients.setKey: a key
 *      written any other way would leave the socket filed under the old one (#1809 review, NB-1)
 *   3. the cost at 3,500 and 10,000 sockets: a push near a dense spot (its author blocked by 300 members) and one
 *      in an empty ocean, the full loop against the index, interleaved, with the host's load (`uptime`) printed with each
 *
 * Run with a radius (NEARBY_LISTINGS_RADIUS_KM) other than the default by its variants in scripts/server-suites.mjs.
 * Seed: PUSH_INDEX_SEED (printed). Run: SERVER_SUITES_ONLY=test-ws-push-index-equivalence node scripts/run-server-suites.mjs
 */
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.NODE_ROLE;
delete process.env.NEARBY_LISTINGS_MAX;
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { haversineKm } from '@beanpool/engine';

// PUSH_INDEX_REPORT: a file each line below is also appended to (the runner keeps no log of a passing run).
const REPORT = process.env.PUSH_INDEX_REPORT;
const RADIUS_TAG = process.env.NEARBY_LISTINGS_RADIUS_KM || 'default';
function say(line: string, failed = false): void {
    if (failed) console.error(line); else console.log(line);
    if (REPORT) fs.appendFileSync(REPORT, `[radius ${RADIUS_TAG}] ${line}\n`);
}

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; say(`✓ ${msg}`); } else say(`✗ ${msg}`, true);
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// A seeded generator, so a failure is repeated by its seed.
const SEED = Number(process.env.PUSH_INDEX_SEED) || crypto.randomInt(1, 2 ** 31);
let state = SEED >>> 0;
function rand(): number {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
const round = (x: number) => Math.round(x * 10) / 10;
const HUBS = [{ lat: -28.5, lng: 153.5 }, { lat: 51.5, lng: -0.1 }, { lat: -17.8, lng: 178.4 }, { lat: 64.1, lng: -21.9 }];

/** A place on the Earth as areas and listings are stored: anywhere, at the antimeridian, at the poles, near a hub. */
function randomPoint(): { lat: number; lng: number } {
    const r = rand();
    if (r < 0.3) return { lat: round(-90 + rand() * 180), lng: round(-180 + rand() * 360) };
    if (r < 0.45) return { lat: round(-60 + rand() * 120), lng: rand() < 0.5 ? round(178 + rand() * 2) : round(-180 + rand() * 2) };
    if (r < 0.6) {
        const lat = rand() < 0.2 ? 90 : round(84 + rand() * 6);
        return { lat: rand() < 0.5 ? lat : -lat, lng: round(-180 + rand() * 360) };
    }
    const hub = pick(HUBS);
    let lng = round(hub.lng + (rand() - 0.5) * 8);
    if (lng > 180) lng = round(lng - 360);
    if (lng < -180) lng = round(lng + 360);
    return { lat: Math.max(-90, Math.min(90, round(hub.lat + (rand() - 0.5) * 6))), lng };
}

async function main(): Promise<void> {
    console.log(`\n=== Listing pushes by area: the index against the full loop (seed ${SEED}) ===\n`);
    const se = await import('./state-engine.js');
    const { db, initSchema } = await import('./db/db.js');
    const area = await import('./engine/member-area.js');
    const { getProfileSwitches, nearbyListingsLimits } = await import('./config/node-profile.js');
    const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
    const { addBlocks, removeBlock } = await import('./engine/member-blocks.js');
    initSchema();
    se.initStateEngine();
    assert(getProfileSwitches().nearbyListings === true, 'setup: listings sync by area');
    const radiusKm = nearbyListingsLimits().radiusKm;
    say(`   radius ${radiusKm} km, seed ${SEED}`);

    // ── 1. the world ────────────────────────────────────────────────────────────────────────────
    const members: string[] = [];
    const insertMember = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, area_lat, area_lng)
                                     VALUES (?, ?, ?, 'seed', 'seed', 'active', ?, ?)`);
    const newMember = (): string => {
        const pk = crypto.randomBytes(32).toString('hex');
        const p = rand() < 0.1 ? null : randomPoint();
        insertMember.run(pk, `Eq${members.length}`, '2020-01-01T00:00:00.000Z', p?.lat ?? null, p?.lng ?? null);
        members.push(pk);
        return pk;
    };
    db.transaction(() => { for (let i = 0; i < 3000; i++) newMember(); })();
    const posts: string[] = [];
    const insertPost = db.prepare(`INSERT INTO posts (id, type, category, title, description, author_pubkey, accepted_by, lat, lng)
                                   VALUES (?, 'offer', 'other', ?, 'equivalence', ?, ?, ?, ?)`);
    db.transaction(() => {
        for (let i = 0; i < 400; i++) {
            const id = crypto.randomUUID();
            const p = rand() < 0.1 ? null : randomPoint();
            insertPost.run(id, `Listing ${i}`, pick(members), rand() < 0.2 ? pick(members) : null, p?.lat ?? null, p?.lng ?? null);
            posts.push(id);
        }
    })();
    area.loadMemberAreas();
    // Members near a listing who blocked its author (member_blocks, as routes/blocks.ts writes them): a fifth of the
    // listings with a place, up to 4 near members each.
    const placeOf = (id: string) => db.prepare('SELECT author_pubkey, lat, lng FROM posts WHERE id = ?').get(id) as { author_pubkey: string; lat: number | null; lng: number | null };
    const nearMembers = (id: string): string[] => {
        const p = placeOf(id);
        if (p.lat == null || p.lng == null) return [];
        return members.filter(pk => { const a = area.memberAreaFor(pk); return !!a && pk !== p.author_pubkey && haversineKm(a.lat, a.lng, p.lat!, p.lng!) <= radiusKm; });
    };
    const blockNear = (id: string, n: number): number => {
        const author = placeOf(id).author_pubkey;
        const near = nearMembers(id);
        let made = 0;
        for (let k = 0; k < n && near.length > 0; k++) made += addBlocks(near.splice(Math.floor(rand() * near.length), 1)[0], [author]).length;
        return made;
    };
    // A party who blocked the author, whom every push of it still reaches: the member who took it, or one with an open
    // deal on it (asked for, or taken and not yet done), near it or not. Not the author, when they took their own listing:
    // nobody can block themselves (addBlocks throws, as seed 1 found).
    const blockParty = (id: string, chosen?: string): number => {
        const p = db.prepare('SELECT author_pubkey, accepted_by FROM posts WHERE id = ?').get(id) as { author_pubkey: string; accepted_by: string | null };
        let party = p.accepted_by;
        if (chosen || !party || party === p.author_pubkey || rand() < 0.5) {
            party = chosen ?? (rand() < 0.5 ? (pick(nearMembers(id)) ?? pick(members)) : pick(members));
            if (party === p.author_pubkey) return 0;
            db.prepare('INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status) VALUES (?, ?, ?, ?, 1, ?)')
                .run(crypto.randomUUID(), id, party, p.author_pubkey, rand() < 0.5 ? 'requested' : 'pending');
        }
        return addBlocks(party, [p.author_pubkey]).length;
    };
    // The other direction: a listing's author blocks a member near it. A member's set never reads the author's list, so
    // every push of it still reaches them.
    const authorBlocksNear = (id: string): number => {
        const near = nearMembers(id);
        return near.length > 0 ? addBlocks(placeOf(id).author_pubkey, [pick(near)]).length : 0;
    };
    let seededBlocks = 0, seededParties = 0, seededAuthors = 0;
    for (const id of posts) {
        if (rand() < 0.2) seededBlocks += blockNear(id, 4);
        if (rand() < 0.15) seededParties += blockParty(id);
        if (rand() < 0.15) seededAuthors += authorBlocksNear(id);
    }
    assert(seededBlocks > 0 && seededParties > 0 && seededAuthors > 0,
        `setup: ${seededBlocks} blocks by members near a listing of its author, ${seededParties} by its parties, ${seededAuthors} by authors of members near their listing`);
    // No enterprise among this world's members (the node's own treasury is no party of any listing): a listing's parties
    // are its author, its taker, its open deals' sides and a removal's, with no keepers, which the check below would
    // otherwise have to add.
    const treasury = db.prepare('SELECT 1 FROM members WHERE public_key = ? AND is_treasury = 1');
    assert(members.every(pk => !treasury.get(pk)), 'setup: no enterprise among the members, so no keepers');

    // Every frame any fake socket got, as `<socket>|<frame>`.
    let frames: string[] = [];
    const sockets: any[] = [];
    let nextId = 0;
    const connect = (memberKey: string | null, pending: string | null = null): any => {
        const id = nextId++;
        const ws: any = {
            id, readyState: 1, dies: false,
            _memberPubkey: memberKey, _visitor: false, _memberFeed: !!memberKey, _openFeed: false, _pendingMemberPubkey: pending,
            send(m: string) { if (this.dies) throw new Error('gone'); frames.push(`${id}|${m}`); },
        };
        se.addWsClient(ws);
        sockets.push(ws);
        return ws;
    };
    const live = () => sockets.filter(s => !s.closed);
    // The members with an open socket, for the picks below: a Set, so a pick is not members × sockets (NB-4).
    const liveMembers = () => { const keys = new Set(live().map(s => s._memberPubkey)); return members.filter(pk => keys.has(pk)); };
    // The index's rules, after every change and every push: what broke, and after what.
    let inspections = 0;
    const broken: Record<string, number> = {};
    const brokenExamples: string[] = [];
    const inspect = (after: string) => {
        inspections++;
        for (const problem of se.inspectWsClients().problems) {
            broken[after] = (broken[after] ?? 0) + 1;
            if (brokenExamples.length < 5) brokenExamples.push(`after "${after}": ${problem}`);
        }
    };
    for (const pk of members) connect(pk);
    for (let i = 0; i < 400; i++) connect(pick(members));          // a member's second (or third) device
    for (let i = 0; i < 80; i++) connect(null);                     // no member's key
    for (let i = 0; i < 40; i++) connect(null, newMemberLater());   // signed before their membership existed
    function newMemberLater(): string { return crypto.randomBytes(32).toString('hex'); }
    const pendingKeys = sockets.filter(s => s._pendingMemberPubkey).map(s => s._pendingMemberPubkey as string);
    assert(sockets.length >= 3500, `setup: ${sockets.length} sockets, ${members.length} members`);

    // ── 2. pushes, the two side by side, while the world changes ───────────────────────────────
    const changes: Record<string, number> = {};
    let lastChange = 'nothing';
    const did = (what: string) => { changes[what] = (changes[what] ?? 0) + 1; lastChange = what; };
    const close = (ws: any) => { ws.closed = true; se.removeWsClient(ws); };
    const change = () => {
        const r = rand();
        if (r < 0.12) { connect(rand() < 0.9 ? pick(members) : null); did('connect'); }
        else if (r < 0.22) { const ws = pick(live()); if (ws) { close(ws); did('disconnect'); } }
        else if (r < 0.27) {
            // A socket that dies on a send leaves the set from inside broadcast (wsClients.delete).
            const ws = pick(live().filter(s => s._memberPubkey));
            if (ws) { ws.dies = true; ws.closed = true; se.broadcast({ type: 'equivalence_probe' }, [ws._memberPubkey]); did('dies on a send'); }
        }
        else if (r < 0.45) { area.setMemberArea(pick(members), randomPoint()); did('area set or moved'); }
        else if (r < 0.52) { area.setMemberArea(pick(members), null); did('area cleared'); }
        else if (r < 0.6) {
            // As a standby's import writes it (engine/sync.ts): the row inside a transaction, the map after it commits.
            const pk = pick(members), p = rand() < 0.2 ? null : randomPoint();
            db.transaction(() => {
                db.prepare('UPDATE members SET area_lat = ?, area_lng = ? WHERE public_key = ?').run(p?.lat ?? null, p?.lng ?? null, pk);
                area.refreshMemberAreas([pk]);
            })();
            did('area imported');
        }
        else if (r < 0.7) {
            const old = pick(liveMembers());
            if (!old) return;
            const fresh = crypto.randomBytes(32).toString('hex');
            try {
                completeRekey(old, fresh, issueRekeyCode(old, 'owner:password').code, 'owner:password');
            } catch (e: any) { did(`re-key refused: ${e?.message}`); return; }
            members[members.indexOf(old)] = fresh;
            connect(fresh);
            did('re-key, the new phone connects');
        }
        else if (r < 0.76) {
            const pk = pick(liveMembers());
            if (!pk) return;
            se.adminPruneUser(pk, 'owner:password');
            members.splice(members.indexOf(pk), 1);
            did('member removed');
        }
        else if (r < 0.8) {
            const pk = pendingKeys.pop();
            if (!pk) return;
            const p = rand() < 0.2 ? null : randomPoint();
            insertMember.run(pk, `Joiner${pk.slice(0, 12)}`, new Date().toISOString(), p?.lat ?? null, p?.lng ?? null);
            members.push(pk);
            area.refreshMemberAreas([pk]);
            se.broadcast({ type: 'member_joined', member: { publicKey: pk } });
            did('mid-join socket joins');
        }
        else if (r < 0.84) {
            // Rows written behind the map (as a database is before a boot), then the map loaded again whole, as at boot.
            for (let k = 0; k < 20; k++) {
                const p = rand() < 0.3 ? null : randomPoint();
                db.prepare('UPDATE members SET area_lat = ?, area_lng = ? WHERE public_key = ?').run(p?.lat ?? null, p?.lng ?? null, pick(members));
            }
            area.loadMemberAreas();
            did('map loaded again whole');
        }
        else if (r < 0.88) {
            if (blockNear(pick(posts), 1) > 0) did('a member near a listing blocks its author');
        }
        else if (r < 0.9) {
            if (blockParty(pick(posts)) > 0) did("a listing's party blocks its author");
        }
        else if (r < 0.92) {
            if (authorBlocksNear(pick(posts)) > 0) did("a listing's author blocks a member near it");
        }
        else if (r < 0.97) {
            const row = db.prepare('SELECT owner_pubkey, blocked_pubkey FROM member_blocks ORDER BY owner_pubkey, blocked_pubkey LIMIT 1 OFFSET ?')
                .get(Math.floor(rand() * (db.prepare('SELECT COUNT(*) AS n FROM member_blocks').get() as { n: number }).n)) as { owner_pubkey: string; blocked_pubkey: string } | undefined;
            if (row && removeBlock(row.owner_pubkey, row.blocked_pubkey)) did('an unblock');
        }
        else { did('nothing'); }
    };

    // Each kind of block once more at a fixed point of every run, not only when a random change makes one: a member near a
    // listing blocks its author, a party of one blocks its author, and an author blocks a member near their listing, each
    // a member with an open socket and none of the listing's parties but the party, and each followed by pushes of that
    // listing of every kind (no other change between), which must not reach the first and must reach the other two. A
    // random block near a listing needs a listing with a member near it, and at a 20 km radius most have nobody: CI run
    // 38403194007 made no author's block of a near member at all, and its check that each kind happened failed.
    const blocks = (owner: string, blocked: string) => !!db.prepare('SELECT 1 FROM member_blocks WHERE owner_pubkey = ? AND blocked_pubkey = ?').get(owner, blocked);
    const partiesOf = (id: string): Set<string | null> => {
        const p = db.prepare('SELECT author_pubkey, accepted_by FROM posts WHERE id = ?').get(id) as { author_pubkey: string; accepted_by: string | null };
        const deals = db.prepare("SELECT buyer_pubkey, seller_pubkey FROM marketplace_transactions WHERE post_id = ? AND status IN ('requested', 'pending')").all(id) as { buyer_pubkey: string; seller_pubkey: string }[];
        return new Set([p.author_pubkey, p.accepted_by, ...deals.flatMap(d => [d.buyer_pubkey, d.seller_pubkey])]);
    };
    const shuffled = <T>(xs: T[]): T[] => {
        const a = [...xs];
        for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
        return a;
    };
    // A listing with a place and a member near it with an open socket, none of its parties, whom `ok` takes; the listings
    // in a seeded order. With no such pair anywhere (no radius rules that out), a member with an open socket sets their
    // area at a listing's place, and is the one.
    const nearPair = (ok: (author: string, pk: string) => boolean): { id: string; author: string; pk: string } => {
        const open = new Set(liveMembers());
        const placed = shuffled(posts).filter(id => placeOf(id).lat != null);
        for (const id of placed) {
            const author = placeOf(id).author_pubkey, parties = partiesOf(id);
            const pk = nearMembers(id).find(k => open.has(k) && !parties.has(k) && ok(author, k));
            if (pk) return { id, author, pk };
        }
        const id = placed[0], p = placeOf(id), parties = partiesOf(id);
        const pk = [...open].find(k => !parties.has(k) && ok(p.author_pubkey, k))!;
        area.setMemberArea(pk, { lat: p.lat!, lng: p.lng! });
        did('area set or moved');
        return { id, author: p.author_pubkey, pk };
    };
    const forcedBlocks: (() => string)[] = [
        () => {
            const { id, author, pk } = nearPair((author, k) => !blocks(k, author));
            if (addBlocks(pk, [author]).length > 0) did('a member near a listing blocks its author');
            return id;
        },
        () => {
            // A listing with a place, where a block of its near members applies and a party's must not.
            const id = pick(posts.filter(id => placeOf(id).lat != null)), author = placeOf(id).author_pubkey, parties = partiesOf(id);
            if (blockParty(id, pick(liveMembers().filter(k => !parties.has(k) && !blocks(k, author)))) > 0) did("a listing's party blocks its author");
            return id;
        },
        () => {
            const { id, author, pk } = nearPair((author, k) => !blocks(k, author) && !blocks(author, k));
            if (addBlocks(author, [pk]).length > 0) did("a listing's author blocks a member near it");
            return id;
        },
    ];

    // A push of a listing at random, or the one given (`forced`): of its kind, with no parties of a removal.
    const push = (forced?: { id: string; type: string }) => {
        const id = forced?.id ?? pick(posts);
        const kind = forced ? -1 : rand();
        const row = db.prepare('SELECT author_pubkey, lat, lng FROM posts WHERE id = ?').get(id) as { author_pubkey: string; lat: number | null; lng: number | null };
        const type = forced?.type ?? (kind < 0.4 ? 'new_post' : kind < 0.8 ? 'post_updated' : 'post_removed');
        const event = type === 'new_post' ? { type, post: { id, authorPublicKey: row.author_pubkey, title: 'x', lat: row.lat, lng: row.lng } } : { type, id };
        // A removal's parties (a deal it just closed), now and then one who blocked the author.
        const blocker = () => (db.prepare('SELECT owner_pubkey FROM member_blocks WHERE blocked_pubkey = ? LIMIT 1').get(row.author_pubkey) as { owner_pubkey: string } | undefined)?.owner_pubkey;
        const opts = !forced && rand() < 0.15 ? { listingParties: [pick(members), (rand() < 0.5 ? blocker() : undefined) ?? pick(members)] } : undefined;
        return { event, opts };
    };
    const through = (index: boolean, p: { event: any; opts?: any }) => {
        se.setListingPushIndex(index);
        frames = [];
        const sent = se.broadcast(p.event, undefined, p.opts);
        return { sent, frames: [...frames].sort() };
    };

    // On its own, beside the two oracles, which share the broadcast's rule and so can never disagree about a block: who
    // each push must reach, worked out from the rows without it, both ways. Every socket of a party (its author, the
    // member who took it, an open deal's sides, a removal's), blocked or not, and, for a listing with a place, every
    // socket whose member is near it and has not blocked its author (their own list, as their set reads it; never the
    // author's) gets the frame; no other socket does, so a near non-party who blocked the author gets nothing.
    const reach = { missed: 0, extra: 0, blockedNear: 0, blockedNearReached: 0, blockedParty: 0, blockedPartyReached: 0, authorBlockedNear: 0, authorBlockedNearReached: 0 };
    const reachExamples: string[] = [];
    const checkReach = (p: { event: any; opts?: any }, sentTo: Set<number>) => {
        const id = p.event.post?.id ?? p.event.id;
        const row = db.prepare('SELECT author_pubkey, accepted_by, lat, lng FROM posts WHERE id = ?').get(id) as { author_pubkey: string; accepted_by: string | null; lat: number | null; lng: number | null };
        const deals = db.prepare("SELECT buyer_pubkey, seller_pubkey FROM marketplace_transactions WHERE post_id = ? AND status IN ('requested', 'pending')").all(id) as { buyer_pubkey: string; seller_pubkey: string }[];
        const parties = new Set([row.author_pubkey, row.accepted_by, ...deals.flatMap(d => [d.buyer_pubkey, d.seller_pubkey]), ...(p.opts?.listingParties ?? [])]);
        const blocked = db.prepare('SELECT 1 FROM member_blocks WHERE owner_pubkey = ? AND blocked_pubkey = ?');
        const placed = row.lat != null && row.lng != null;
        for (const ws of live()) {
            const pk = ws._memberPubkey as string | null;
            const got = sentTo.has(ws.id);
            let want = false;
            if (pk && parties.has(pk)) {
                want = true;
                if (blocked.get(pk, row.author_pubkey)) { reach.blockedParty++; if (got) reach.blockedPartyReached++; }
            } else if (pk && placed) {
                const a = area.memberAreaFor(pk);
                const near = !!a && haversineKm(a.lat, a.lng, row.lat!, row.lng!) <= radiusKm;
                const theyBlocked = !!blocked.get(pk, row.author_pubkey);
                want = near && !theyBlocked;
                if (near && theyBlocked) { reach.blockedNear++; if (got) reach.blockedNearReached++; }
                if (near && !theyBlocked && blocked.get(row.author_pubkey, pk)) { reach.authorBlockedNear++; if (got) reach.authorBlockedNearReached++; }
            }
            if (want === got) continue;
            if (want) reach.missed++; else reach.extra++;
            if (reachExamples.length < 4) reachExamples.push(`${p.event.type} ${id}: socket ${ws.id} ${want ? 'missed' : 'reached and should not be'}`);
        }
    };

    const PUSHES = Number(process.env.PUSH_INDEX_PUSHES) || 1200;
    let differ = 0, reached = 0, emptyPushes = 0;
    const firstDiffs: string[] = [];
    inspect('setup');
    // The forced blocks at a quarter, half and three quarters of the way, each with its listing's pushes queued after it.
    const forcedAt = forcedBlocks.map((_, k) => Math.floor(PUSHES * (k + 1) / (forcedBlocks.length + 1)));
    const queued: { id: string; type: string }[] = [];
    let nextForced = 0;
    for (let i = 0; i < PUSHES; i++) {
        if (queued.length === 0 && nextForced < forcedBlocks.length && i >= forcedAt[nextForced]) {
            lastChange = 'nothing';
            const id = forcedBlocks[nextForced++]();
            inspect(lastChange);
            for (const type of ['new_post', 'post_updated', 'post_removed']) queued.push({ id, type });
        } else if (queued.length === 0 && rand() < 0.5) { lastChange = 'nothing'; change(); inspect(lastChange); }
        const p = push(queued.shift());
        const full = through(false, p), indexed = through(true, p);
        inspect(`a ${p.event.type} push`);
        reached += full.frames.length;
        if (full.frames.length === 0) emptyPushes++;
        checkReach(p, new Set(indexed.frames.map(f => Number(f.slice(0, f.indexOf('|'))))));
        if (full.sent !== indexed.sent || full.frames.join('\n') !== indexed.frames.join('\n')) {
            differ++;
            if (firstDiffs.length < 3) {
                const a = new Set(full.frames), b = new Set(indexed.frames);
                firstDiffs.push(`push ${i} ${p.event.type} ${p.event.id ?? p.event.post?.id}: full ${full.frames.length}, index ${indexed.frames.length}; ` +
                    `missed ${full.frames.filter(f => !b.has(f)).length}, extra ${indexed.frames.filter(f => !a.has(f)).length}`);
            }
        }
    }
    se.setListingPushIndex(true);
    say(`   changes between pushes: ${JSON.stringify(changes)}`);
    for (const d of firstDiffs) say(`   ${d}`, true);
    for (const what of ['connect', 'disconnect', 'dies on a send', 'area set or moved', 'area cleared', 'area imported',
        're-key, the new phone connects', 'member removed', 'mid-join socket joins', 'map loaded again whole',
        'a member near a listing blocks its author', "a listing's party blocks its author", "a listing's author blocks a member near it", 'an unblock']) {
        assert((changes[what] ?? 0) > 0, `the run made the change "${what}" (${changes[what] ?? 0} times)`);
    }
    assert(reached > PUSHES, `the pushes reached sockets: ${reached} frames over ${PUSHES} pushes (${emptyPushes} reached none)`);
    assert(differ === 0, `${PUSHES} pushes: the index and the full loop send the same frames to the same sockets (${differ} differ; seed ${SEED})`);
    for (const e of reachExamples) say(`   ${e}`, true);
    assert(reach.missed === 0 && reach.extra === 0,
        `${PUSHES} pushes reached exactly their parties and the members near them who did not block the author: ${reach.missed} sockets missed, ${reach.extra} reached and should not be (seed ${SEED})`);
    assert(reach.blockedNear > 0 && reach.blockedNearReached === 0,
        `no push reached a member near its listing who blocked its author and is none of its parties: ${reach.blockedNearReached} of ${reach.blockedNear} such sockets (seed ${SEED})`);
    assert(reach.blockedParty > 0 && reach.blockedPartyReached === reach.blockedParty,
        `every push reached its parties who blocked its author: ${reach.blockedPartyReached} of ${reach.blockedParty} such sockets (seed ${SEED})`);
    assert(reach.authorBlockedNear > 0 && reach.authorBlockedNearReached === reach.authorBlockedNear,
        `every push reached the members near it whom its author blocked (the author's list is not theirs): ${reach.authorBlockedNearReached} of ${reach.authorBlockedNear} such sockets (seed ${SEED})`);
    for (const e of brokenExamples) say(`   ${e}`, true);
    assert(Object.keys(broken).length === 0,
        `the index kept its rules after each of ${inspections} changes and pushes (broken after: ${JSON.stringify(broken)}; seed ${SEED})`);

    // Every socket closes: nothing stays filed. A push by area first, so the cells are built and hold keys.
    se.broadcast({ type: 'post_updated', id: posts.find(id => (db.prepare('SELECT lat FROM posts WHERE id = ?').get(id) as any).lat != null)! });
    const before = se.inspectWsClients();
    assert(before.filed > 0 && before.keys > 0, `before the close: ${before.sockets} sockets, ${before.keys} keys, ${before.filed} filed in ${before.bands} bands`);
    for (const ws of live()) close(ws);
    const after = se.inspectWsClients();
    assert(after.sockets === 0 && after.keys === 0 && after.filed === 0 && after.bands === 0 && after.problems.length === 0,
        `every socket closed: the index is empty (${after.sockets} sockets, ${after.keys} keys, ${after.filed} filed, ${after.bands} bands; ${after.problems.length} problems)`);

    // ── 2b. who writes a socket's key ───────────────────────────────────────────────────────────
    // Outside the tests, only the connect (https-server.ts, before addWsClient) and setKey (ws-area-index.ts) may.
    // A property set (.x = or ['x'] =, not a destructuring default), the key defineProperty names, an Object.assign onto
    // ws, or an Object.assign whose object has the key (not one that reads ws._memberPubkey into another key).
    const KEY_WRITE = /(?:\.\s*|\[\s*['"`])_memberPubkey(?:['"`]\s*\])?\s*(?:=(?!=)|\?\?=|\|\|=|&&=)|defineProperty\([^,]*,\s*['"`]_memberPubkey|Object\.assign\(\s*ws\b|Object\.assign\([^)]*[{,]\s*\[?\s*['"`]?_memberPubkey['"`]?\s*\]?\s*[:,}]/;
    // The scan is only as good as its pattern: every shape of write is caught, and no read is (#1809's check, N1: the
    // bracket forms and an Object.assign onto another name slipped past it; #1828's check, finding 2: a destructuring
    // default and a read inside another object's Object.assign were taken for writes).
    const writeShapes = [
        `ws._memberPubkey = k;`,
        `(ws as any)._memberPubkey = k;`,
        `ws._memberPubkey ??= k;`,
        `Object.assign(ws, { _memberPubkey: k });`,
        `ws['_memberPubkey'] = k;`,
        `(ws as any)['_memberPubkey'] = k;`,
        `Object.assign(sock, { _memberPubkey: k });`,
        `Object.assign(sock, { _memberPubkey });`,
        `Object.defineProperty(ws, '_memberPubkey', { value: k });`,
    ];
    const readShapes = [
        `if (ws._memberPubkey === k) return;`,
        `const k = (ws as any)['_memberPubkey'];`,
        `if (ws['_memberPubkey'] !== k) return;`,
        `const { _memberPubkey = null } = ws;`,
        `Object.assign(out, { pubkey: ws._memberPubkey });`,
        `Object.defineProperty(out, 'pubkey', { value: ws._memberPubkey });`,
    ];
    const missed = writeShapes.filter(l => !KEY_WRITE.test(l)), misread = readShapes.filter(l => KEY_WRITE.test(l));
    assert(missed.length === 0 && misread.length === 0,
        `the scan's pattern catches all ${writeShapes.length} shapes of write and none of ${readShapes.length} reads (missed: ${missed.join(' | ') || 'none'}; read as a write: ${misread.join(' | ') || 'none'})`);
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const writes: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full); continue; }
            if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts') || entry.name.startsWith('test-')) continue;
            fs.readFileSync(full, 'utf8').split('\n').forEach((line, n) => {
                if (KEY_WRITE.test(line)) {
                    writes.push(`${path.relative(srcDir, full)}:${n + 1}`);
                }
            });
        }
    };
    walk(srcDir);
    const allowed = writes.filter(w => /^(https-server|ws-area-index)\.ts:/.test(w));
    assert(writes.length === 2 && allowed.length === 2,
        `a socket's key is written only at the connect and by wsClients.setKey: ${writes.join(', ')}`);

    // ── 3. the cost ─────────────────────────────────────────────────────────────────────────────
    if (process.env.PUSH_INDEX_COST !== '0') {
        const hubPost = crypto.randomUUID(), oceanPost = crypto.randomUUID();
        insertPost.run(hubPost, 'At a dense spot', pick(members), null, HUBS[0].lat, HUBS[0].lng);
        insertPost.run(oceanPost, 'In the South Pacific', pick(members), null, -48.9, -123.4);
        // The dense spot's author blocked by 300 members anywhere, some near it: the read of their blockers is in every
        // push's cost, and the push still reaches the members near it who did not block them.
        const hubAuthor = placeOf(hubPost).author_pubkey;
        const hubNear = new Set(nearMembers(hubPost));
        let hubBlocks = 0, hubBlocksNear = 0;
        for (const pk of members.slice(0, 301)) {
            if (pk === hubAuthor || hubBlocks >= 300 || addBlocks(pk, [hubAuthor]).length === 0) continue;
            hubBlocks++;
            if (hubNear.has(pk)) hubBlocksNear++;
        }
        say(`   the dense spot's author is blocked by ${hubBlocks} members, ${hubBlocksNear} of the ${hubNear.size} near it`);
        const costAt = (n: number) => {
            while (live().length < n) connect(pick(members));
            while (live().length > n) close(live()[live().length - 1]);
            const uptime = execFileSync('uptime', { encoding: 'utf8' }).trim();
            for (const [what, id] of [['a dense spot', hubPost], ['an empty ocean', oceanPost]] as const) {
                const times: Record<'full' | 'index', number[]> = { full: [], index: [] };
                let sentFull = 0, sentIndex = 0;
                for (let i = 0; i < 41; i++) {
                    for (const index of i % 2 === 0 ? [false, true] : [true, false]) {
                        se.setListingPushIndex(index);
                        frames = [];
                        const t0 = process.hrtime.bigint();
                        const sent = se.broadcast({ type: 'post_updated', id });
                        (index ? times.index : times.full).push(Number(process.hrtime.bigint() - t0) / 1e6);
                        if (index) sentIndex = sent; else sentFull = sent;
                    }
                }
                se.setListingPushIndex(true);
                const full = median(times.full), idx = median(times.index);
                say(`   ${n.toLocaleString('en')} sockets, ${what}: full loop ${full.toFixed(3)} ms a push, index ${idx.toFixed(3)} ms (reached ${sentIndex}); medians of 41, interleaved; ${uptime}`);
                assert(sentFull === sentIndex, `${n} sockets, ${what}: both reach ${sentIndex}`);
            }
        };
        costAt(3500);
        costAt(10000);
    }

    say(`${passed}/${run} checks passed (seed ${SEED}).`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ listing pushes through the index equal the full loop: PASSED.');
}
main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
