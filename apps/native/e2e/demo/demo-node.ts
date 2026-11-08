/**
 * A real node for the store and website pictures (DESIGN-app-screenshots-fable.md §2, lane L1): the invented community
 * "Riverbend", seeded from riverbend.json, on a throwaway local node. A copy-and-extend of apps/pwa/e2e/home-node-harness.ts
 * (same loopback guard, `FIXTURE_READY`, the stdin ops) that adds the whole town instead of three people, plus a plain-HTTP
 * listener (`startHttpServer(0)`) for a phone that reaches the node through `adb reverse`.
 *
 * Nothing leaves this machine: the socket guard refuses any connection that is not loopback (BLOCKED-CONNECT), and a fetch to
 * another host is refused and logged (BLOCKED-FETCH). Run it against a FRESH data dir; it is never pointed at a real node.
 *
 * Every Bean moves through the node's own engine calls (`acceptPost`, then `completePostTransaction`); only the clocks of
 * those trades are moved back afterwards, so the Ledger reads as three weeks of history. Nothing here writes a balance.
 *
 * Env: BEANPOOL_DATA_DIR (a fresh folder), FIXTURE_ROOT (a folder whose `public/` holds a web app build, optional: a node
 * with none still answers /api). The folder is the node's working directory.
 *
 * Says `FIXTURE_READY {"port":N,"httpPort":M,"sam":"<public key>"}` once seeded and listening. Takes one JSON request a
 * line on stdin and answers one `FIXTURE_ANSWER {"id":…,"ok":…,"result"|"error":…}` line:
 *   { op: 'sql', sql, params?, all? }   a statement on the node's database
 *   { op: 'resetLimits' }               the gateway and auth limiters start again
 *   { op: 'invite' }                    a fresh invite code, from the node's first member (join with beanpool://welcome?invite=…)
 *   { op: 'world' }                     who and what was seeded: ids by the keys riverbend.json gives them
 *
 * Run as: node --import tsx ../native/e2e/demo/demo-node.ts (cwd apps/server).
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.GOOGLE_CLIENT_IDS;
delete process.env.APPLE_CLIENT_IDS;
delete process.env.BEANPOOL_VAULT_TICKET_KEYS;

import readline from 'node:readline';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOOPBACK, installLoopbackGuard } from '../../../server/src/loopback-guard-test-harness.js';

installLoopbackGuard();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === 'https://api.github.com') {
        return new Response(JSON.stringify({ tag_name: 'v0.0.1', html_url: '', body: '', published_at: '' }), { status: 200 });
    }
    if (!LOOPBACK.has(url.hostname)) {
        console.error(`BLOCKED-FETCH ${url.origin}`);
        throw new Error(`demo-node: no requests leave this machine (${url.origin})`);
    }
    return realFetch(input, init);
}) as typeof fetch;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const say = (line: string) => process.stdout.write(`${line}\n`);
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

// ── riverbend.json ──────────────────────────────────────────────────────────────────────────────────────────────────
type At = { dLat: number; dLng: number };
interface Person { key: string; callsign: string; avatar: string; joinedDaysAgo: number; area: At; grantedCredit: number; genesis?: boolean }
interface Listing {
    id: string; author: string; type: 'offer' | 'need'; category: string; title: string; description: string; credits: number;
    priceType: 'fixed' | 'hourly' | 'daily'; photo: string; ageHours: number; repeatable?: boolean; lendable?: boolean;
    lendMaxDays?: number; lendTerms?: string; replacementValue?: string; at: At;
}
interface EventSeed {
    id: string; host: string; title: string; description: string; category: string; weekday: 'SU' | 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA';
    startHour: number; durationHours: number; weeksAhead?: number; place: string; hostNote: string; photo: string; ageHours: number;
    going: number; interested: number; samGoing?: boolean; at: At;
}
interface Riverbend {
    community: { name: string; centre: { lat: number; lng: number }; tz: string; hall: string };
    sam: { callsign: string; avatar: string; joinedDaysAgo: number; area: At; grantedCredit: number; words: string[] };
    people: Person[];
    otherMembers: string[];
    otherMembersJoinedDaysAgo: [number, number];
    listings: Listing[];
    pastOffers: { id: string; author: string; category: string; title: string; description: string; credits: number; photo: string; daysAgo: number }[];
    events: EventSeed[];
    poll: { id: string; author: string; title: string; description: string; options: { id: string; text: string; votes: number }[]; durationDays: number; closesInHours: number; ageHours: number; at: At };
    trades: { listing: string; buyer: string; hours?: number; daysAgo: number }[];
    openDeal: { listing: string; buyer: string; daysAgo: number };
    dm: { with: string; lines: { by: string; text: string; minutesAgo: number }[] };
    home: { cards: string[] };
}
const RIVERBEND: Riverbend = JSON.parse(fs.readFileSync(path.join(HERE, 'riverbend.json'), 'utf8'));

// ── keys: all invented, all derived, so a run is the same people every time ─────────────────────────────────────────────
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest();
/** An Ed25519 key from a 32-byte seed: the seed in hex (what the phone keeps) and the public key in hex (what the node keeps). */
function keyOfSeed(seed: Buffer): { seedHex: string; publicKey: string } {
    const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
    return { seedHex: seed.toString('hex'), publicKey: crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') };
}
/** Sam's key as the apps derive it from the 12 words (apps/native/utils/crypto.ts mnemonicToKeypair: SHA-256 twice over the phrase). */
const samKey = () => keyOfSeed(sha256(sha256(RIVERBEND.sam.words.join(' '))));
const memberKey = (name: string) => keyOfSeed(sha256(`riverbend demo community: ${name}`));

// ── time: "this Saturday at 10:00" in the community's own zone ──────────────────────────────────────────────────────────
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
/** The clock date (YYYY-MM-DD) of the next `weekday` after today in `tz`, `weeksAhead` weeks later still. */
function nextWeekdayDate(weekday: string, tz: string, weeksAhead = 0, now = new Date()): string {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
        .formatToParts(now).map((p) => [p.type, p.value]));
    const todayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
    let ahead = (WEEKDAYS.indexOf(weekday) - todayIdx + 7) % 7;
    if (ahead === 0) ahead = 7;
    const d = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + ahead + 7 * weeksAhead));
    return d.toISOString().slice(0, 10);
}
const pad = (n: number) => String(n).padStart(2, '0');

const photoDataUrl = (name: string) => `data:image/jpeg;base64,${fs.readFileSync(path.join(HERE, 'photos', `${name}.jpg`)).toString('base64')}`;

async function main(): Promise<void> {
    const root = process.env.FIXTURE_ROOT;
    if (!root) throw new Error('FIXTURE_ROOT is not set');
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('BEANPOOL_DATA_DIR is not set (a fresh folder, never a real node\'s)');
    process.chdir(root);

    const { initTls } = await import('../../../server/src/services/tls.js');
    const se = await import('../../../server/src/state-engine.js');
    const { startHttpsServer } = await import('../../../server/src/https-server.js');
    const { startHttpServer } = await import('../../../server/src/http-server.js');
    const { db } = await import('../../../server/src/db/db.js');
    const { pruneAuthAttempts } = await import('../../../server/src/auth-rate-limit.js');
    const { resetGatewayRateLimit } = await import('../../../server/src/gateway-rate-limit.js');
    const { setMemberPhoto } = await import('../../../../packages/beanpool-engine/dist/index.js');
    const { AVATAR_PRESETS, sealDmLine, newDmMessageId } = await import('@beanpool/core');

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    const httpPort = await startHttpServer(0);

    const R = RIVERBEND;
    const { centre } = R.community;
    const at = (a: At) => ({ lat: centre.lat + a.dLat, lng: centre.lng + a.dLng });
    const world = {
        members: {} as Record<string, string>,
        posts: {} as Record<string, string>,
        events: {} as Record<string, string>,
        poll: '' as string,
        trades: [] as string[],
        openDeal: { transactionId: '', postId: '' },
        dm: '' as string,
        sam: '',
    };
    const keys: Record<string, { seedHex: string; publicKey: string }> = {};

    // ── members: the first one from genesis, the rest as the harness inserts them ──
    const insertMember = (pk: string, callsign: string, joinedDaysAgo: number, area: At, avatar: string, owner: string, granted = 0) => {
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, area_lat, area_lng)
                    VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`)
            .run(pk, callsign, ago(joinedDaysAgo), owner, `INV-${callsign.toUpperCase().replace(/[^A-Z]/g, '')}${pk.slice(0, 4)}`, at(area).lat, at(area).lng);
        // Granted credit (members.earned_credit) is a credit-limit input: it moves no Beans, it lets a first trade through.
        db.prepare('UPDATE members SET earned_credit = ? WHERE public_key = ?').run(granted, pk);
        setMemberPhoto(db, pk, `bundled://${avatar}`);
        db.prepare('INSERT OR REPLACE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(pk);
    };
    const first = R.people.find((p) => p.genesis);
    if (!first) throw new Error('riverbend.json names no first member (genesis)');
    keys[first.key] = memberKey(first.key);
    se.seedGenesisMember(keys[first.key].publicKey, first.callsign);
    db.prepare('UPDATE members SET joined_at = ?, area_lat = ?, area_lng = ?, earned_credit = ? WHERE public_key = ?')
        .run(ago(first.joinedDaysAgo), at(first.area).lat, at(first.area).lng, first.grantedCredit, keys[first.key].publicKey);
    setMemberPhoto(db, keys[first.key].publicKey, `bundled://${first.avatar}`);
    db.prepare('INSERT OR REPLACE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(keys[first.key].publicKey);
    const owner = keys[first.key].publicKey;
    world.members[first.key] = owner;

    keys.sam = samKey();
    insertMember(keys.sam.publicKey, R.sam.callsign, R.sam.joinedDaysAgo, R.sam.area, R.sam.avatar, owner, R.sam.grantedCredit);
    world.members.sam = keys.sam.publicKey;
    world.sam = keys.sam.publicKey;
    for (const p of R.people.filter((x) => !x.genesis)) {
        keys[p.key] = memberKey(p.key);
        insertMember(keys[p.key].publicKey, p.callsign, p.joinedDaysAgo, p.area, p.avatar, owner, p.grantedCredit);
        world.members[p.key] = keys[p.key].publicKey;
    }
    // The rest of the town: names only, with a ready-made picture each, spread over the weeks and the hinterland.
    const [from, to] = R.otherMembersJoinedDaysAgo;
    R.otherMembers.forEach((name, i) => {
        const k = memberKey(name);
        const n = R.otherMembers.length;
        const angle = (i / n) * 2 * Math.PI;
        const radius = 0.012 + ((i * 7) % n) / n * 0.04;
        insertMember(k.publicKey, name, Math.round(from + ((i * 11) % n) / n * (to - from)), { dLat: Math.sin(angle) * radius, dLng: Math.cos(angle) * radius },
            AVATAR_PRESETS[(i * 5 + 2) % AVATAR_PRESETS.length].id, owner);
        keys[`other:${name}`] = k;
        world.members[`other:${name}`] = k.publicKey;
    });
    se.reconcileLedgerFromDb();
    const pk = (key: string): string => {
        const v = world.members[key];
        if (!v) throw new Error(`riverbend.json names a member that is not seeded: ${key}`);
        return v;
    };

    // ── listings, oldest first, then their clocks set to their age ──
    const createdAt = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    // A first Offer before a Need (the node's rule), for the two who only ask: finished long ago, so never on the board.
    for (const o of R.pastOffers) {
        const where = at(R.people.find((p) => p.key === o.author)!.area);
        const post = se.createPost('offer', o.category, o.title, o.description, o.credits, 'fixed', pk(o.author), where.lat, where.lng, [photoDataUrl(o.photo)], false, undefined, false, {} as any);
        if (!post) throw new Error(`the node would not list ${o.id}`);
        const when = ago(o.daysAgo);
        db.prepare("UPDATE posts SET status = 'completed', active = 0, created_at = ?, updated_at = ?, completed_at = ? WHERE id = ?").run(when, when, when, post.id);
    }
    const listingOrder = [...R.listings].sort((a, b) => b.ageHours - a.ageHours);
    for (const l of listingOrder) {
        const where = at(l.at);
        const post = se.createPost(l.type, l.category, l.title, l.description, l.credits, l.priceType, pk(l.author), where.lat, where.lng,
            [photoDataUrl(l.photo)], l.repeatable === true, undefined, false,
            l.lendable ? ({ lendable: true, lendMaxDays: l.lendMaxDays, lendTerms: l.lendTerms, replacementValue: l.replacementValue } as any) : ({} as any));
        if (!post) throw new Error(`the node would not list ${l.id}`);
        world.posts[l.id] = post.id;
        db.prepare('UPDATE posts SET created_at = ?, updated_at = ? WHERE id = ?').run(createdAt(l.ageHours), createdAt(l.ageHours), post.id);
    }

    // ── events (host's clock in the community's zone), the poll ──
    for (const e of R.events) {
        const date = nextWeekdayDate(e.weekday, R.community.tz, e.weeksAhead ?? 0);
        const endHour = e.startHour + e.durationHours;
        const where = at(e.at);
        const post = se.createPost('event', e.category, e.title, e.description, 0, 'fixed', pk(e.host), where.lat, where.lng, [photoDataUrl(e.photo)], false, undefined, false, {
            eventStartLocal: `${date}T${pad(e.startHour)}:00`, eventEndLocal: `${date}T${pad(endHour)}:00`, eventTz: R.community.tz,
            eventPlaceName: e.place, eventPrivateNote: e.hostNote,
        } as any);
        if (!post) throw new Error(`the node would not list ${e.id}`);
        world.events[e.id] = post.id;
        db.prepare('UPDATE posts SET created_at = ?, updated_at = ? WHERE id = ?').run(createdAt(e.ageHours), createdAt(e.ageHours), post.id);
    }
    {
        const p = R.poll;
        const where = at(p.at);
        const post = se.createPost('poll', 'general', p.title, p.description, 0, 'fixed', pk(p.author), where.lat, where.lng, undefined, false, undefined, false,
            { pollOptions: p.options.map((o) => ({ id: o.id, text: o.text })), durationDays: p.durationDays } as any);
        if (!post) throw new Error('the node would not list the poll');
        world.poll = post.id;
        // The node offers 3, 7 or 14 days; this one closes tomorrow, as the design's Home reads "Poll closes tomorrow".
        db.prepare('UPDATE posts SET created_at = ?, updated_at = ?, poll_closes_at = ? WHERE id = ?')
            .run(createdAt(p.ageHours), createdAt(p.ageHours), new Date(Date.now() + p.closesInHours * 3_600_000).toISOString(), post.id);
    }

    // ── Beans: the engine's own accept and release; the clocks of each trade then moved back ──
    const maxRow = (table: string) => (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${table}`).get() as { m: number }).m;
    const trade = (listing: string, buyer: string, hours: number | undefined, daysAgo: number, release: boolean): string => {
        const marks = { transactions: maxRow('transactions'), messages: maxRow('messages') };
        const postId = world.posts[listing];
        if (!postId) throw new Error(`a trade names a listing that is not seeded: ${listing}`);
        const tx = se.acceptPost(postId, pk(buyer), hours);
        if (release) {
            const done = se.completePostTransaction(tx.id, pk(buyer), hours);
            if (!done) throw new Error(`the node would not release ${listing} to its seller`);
        }
        const then = ago(daysAgo);
        const doneAt = ago(Math.max(0, daysAgo - 0.05));
        db.prepare('UPDATE transactions SET timestamp = ? WHERE rowid > ?').run(then, marks.transactions);
        db.prepare('UPDATE messages SET timestamp = ? WHERE rowid > ?').run(then, marks.messages);
        db.prepare('UPDATE marketplace_transactions SET created_at = ?, completed_at = ?, updated_at = ? WHERE id = ?')
            .run(then, release ? doneAt : null, release ? doneAt : then, tx.id);
        return tx.id;
    };
    for (const t of R.trades) world.trades.push(trade(t.listing, t.buyer, t.hours, t.daysAgo, true));
    world.openDeal = { transactionId: trade(R.openDeal.listing, R.openDeal.buyer, undefined, R.openDeal.daysAgo, false), postId: world.posts[R.openDeal.listing] };

    // ── RSVPs and votes: the host's guests are the town's names-only members, and Sam where riverbend.json says ──
    const guests = R.otherMembers.map((n) => pk(`other:${n}`));
    const named = R.people.filter((p) => p.key !== 'sam').map((p) => pk(p.key));
    for (const e of R.events) {
        const id = world.events[e.id];
        const host = pk(e.host);
        const pool = [...named.filter((x) => x !== host), ...guests];
        const goingFirst = e.samGoing ? [pk('sam')] : [];
        const goingRest = pool.slice(0, e.going - goingFirst.length);
        for (const m of [...goingFirst, ...goingRest]) se.rsvpEvent(id, m, 'going');
        for (const m of pool.slice(goingRest.length, goingRest.length + e.interested)) se.rsvpEvent(id, m, 'interested');
    }
    {
        let voter = 0;
        for (const o of R.poll.options) for (let i = 0; i < o.votes; i++) se.votePoll(world.poll, guests[voter++], o.id);
    }

    // ── the chat: the pair's one DM, which the open deal opened; each line sealed by the one who wrote it ──
    const dmWith = pk(R.dm.with);
    const dmId = se.ensureTransactionConversation(world.openDeal.postId, pk('sam'), dmWith);
    world.dm = dmId;
    for (const line of R.dm.lines) {
        const by = keys[line.by];
        const peer = line.by === 'sam' ? keys[R.dm.with] : keys.sam;
        const messageId = newDmMessageId();
        const sealed = sealDmLine(line.text, { myEdPrivHex: by.seedHex, peerEdPubHex: peer.publicKey, conversationId: dmId }, { senderPubHex: by.publicKey, messageId });
        const stored = se.sendMessage(dmId, by.publicKey, sealed.ciphertext, sealed.nonce, 'text', undefined, undefined, messageId);
        if (!stored) throw new Error('the node would not store a line of the chat');
        db.prepare('UPDATE messages SET timestamp = ? WHERE id = ?').run(new Date(Date.now() - line.minutesAgo * 60_000).toISOString(), messageId);
    }
    // Sam has read it: the lines are his and Amara's last two, not an unread badge.
    se.markConversationRead(pk('sam'), dmId);

    // ── Sam's Home: his own order of cards between the fixed two (core home-frame: a v2 layout) ──
    const cards = R.home.cards.map((id) => (id === 'chat'
        ? { id: 'chat-demo', type: 'chat', settings: { conversationId: dmId, kind: 'dm', name: R.dm.with.replace(/^./, (c) => c.toUpperCase()) } }
        : { id, type: id }));
    const layout = { v: 2, cards, dismissed: {}, updatedAt: new Date().toISOString() };
    db.prepare("INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'home.layout', ?)").run(pk('sam'), JSON.stringify(layout));

    se.reconcileLedgerFromDb();

    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
        let id: unknown = null;
        try {
            const req = JSON.parse(line);
            id = req.id;
            let result: unknown = null;
            switch (req.op) {
                case 'sql': {
                    const stmt = db.prepare(String(req.sql));
                    const params = Array.isArray(req.params) ? req.params : [];
                    result = req.all ? stmt.all(...params) : stmt.run(...params);
                    break;
                }
                case 'resetLimits':
                    resetGatewayRateLimit();
                    pruneAuthAttempts(Date.now() + 3600_000);
                    break;
                case 'invite': {
                    const invite = se.adminGenerateInvite(owner, 'standard');
                    result = { code: invite?.code ?? null };
                    break;
                }
                case 'world':
                    result = world;
                    break;
                default:
                    throw new Error(`no op ${String(req.op)}`);
            }
            say(`FIXTURE_ANSWER ${JSON.stringify({ id, ok: true, result })}`);
        } catch (e) {
            say(`FIXTURE_ANSWER ${JSON.stringify({ id, ok: false, error: (e as Error)?.message || String(e) })}`);
        }
    });
    say(`FIXTURE_READY ${JSON.stringify({ port, httpPort, sam: world.sam })}`);
}

main().catch((e) => {
    console.error('demo-node failed to start:', e);
    process.exit(1);
});
