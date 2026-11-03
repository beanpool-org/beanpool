/**
 * Home puts a pinned post first (scratch/fable-design/DESIGN-pinning-fable.md §2.2, slice 4), over REAL HTTP through the
 * signature middleware, on GET /api/home:
 *
 *  1. New in the Market: the live pinned Offers and Needs lead the card whatever their age, marked `pinned: true`, newest pin
 *     first, at most three, and the card keeps its four: the rest is the pool as it was. A pinned Offer is not shown twice.
 *  2. Coming up: a pinned event leads whatever its date (past the fortnight too), the soonest follow, three in all.
 *  3. Decide: the first open poll is the pinned one when there is one, else the soonest closing, as before.
 *  4. A pin that ran out by the clock is not pinned, before the node tidies its row; a pinned event that ended is not live.
 *  5. Reach as it was: a post hidden by reports, removed by a moderator, a group's, another community's or its author on
 *     holiday is never shown for being pinned.
 *  6. Nothing pinned: no row carries the field at all, so an older app sees the answer it always saw.
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-home-pinned)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { setMemberPhoto } from '@beanpool/engine';
import { initTls } from './services/tls.js';
import { initStateEngine, grantNodeRole } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { TEST_PHOTOS } from './post-test-helper.js';
import { localFetch } from './keepalive-test-fetch.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const DAY = 86_400_000;
const SYD = 'Australia/Sydney';

function makeIdentity(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, status, joined_at, updated_at)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
        .run(pubKeyHex, callsign);
    setMemberPhoto(db, pubKeyHex, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

async function signed(method: 'GET' | 'POST', pathAndQuery: string, body: unknown, id: Id) {
    resetGatewayRateLimit();
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${pathAndQuery.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts), 'X-Nonce': nonce,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await localFetch(`${BASE}${pathAndQuery}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text, error: json?.error as string | undefined };
}

const clearPins = () => db.prepare('UPDATE posts SET pinned_until = NULL, pinned_at = NULL WHERE pinned_until IS NOT NULL').run();
/** A pin as the node writes it, `ago` ms before now, to end `ms` from now. Directly, so a test can set an old or ended one. */
const stamp = (id: string, endsInMs: number, madeAgoMs = 0) =>
    db.prepare('UPDATE posts SET pinned_until = ?, pinned_at = ? WHERE id = ?')
        .run(new Date(Date.now() + endsInMs).toISOString(), new Date(Date.now() - madeAgoMs).toISOString(), id);

async function main(): Promise<void> {
    console.log('\nHome: a pinned post first\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const owner = makeIdentity('OwnerOl');
    const author = makeIdentity('AuthorAl');
    const reader = makeIdentity('ReaderRo');
    const traveller = makeIdentity('TravellerTy');
    grantNodeRole(owner.pubKeyHex, 'owner', 'owner:password');

    let n = 0;
    const post = async (who: Id, body: Record<string, unknown> = {}): Promise<string> => {
        n++;
        const r = await signed('POST', '/api/marketplace/posts', {
            type: 'offer', category: 'Food', title: `Listing ${n}`, description: 'Plenty', credits: 5, authorPublicKey: who.pubKeyHex,
            photos: TEST_PHOTOS, lat: -33.8688, lng: 151.2093, ...body,
        }, who);
        const id = r.body?.post?.id ?? r.body?.id;
        if (!id) throw new Error(`could not post: ${r.status} ${r.error}`);
        return id;
    };
    const clockIn = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 11) + '10:00';
    // A member holds five upcoming events at most: each event has its own host.
    const eventIn = (days: number, title: string) => post(makeIdentity(`Host${++n}`), {
        type: 'event', title, description: 'Bring gloves', eventStartLocal: clockIn(days), eventTz: SYD, eventPlaceName: 'The hall',
    });
    // A member has one open poll at a time: each poll has its own asker.
    const askers: Record<string, Id> = {};
    const pollOf = (title: string, days: number) => post(askers[title] ??= makeIdentity(`Asker${Object.keys(askers).length}`), { type: 'poll', title, description: 'Vote', pollOptions: ['Yes', 'No'], durationDays: days });
    const home = async (who: Id = reader) => {
        const r = await signed('GET', '/api/home?cards=market,events,decide', null, who);
        if (r.status !== 200) throw new Error(`home answered ${r.status} ${r.error}`);
        const cards = r.body?.cards ?? r.body ?? {};
        return {
            text: r.text,
            market: (cards.market?.items ?? []) as any[],
            events: (cards.events?.items ?? []) as any[],
            decide: cards.decide as any,
        };
    };
    const ids = (rows: any[]) => rows.map(r => r.id as string);

    // ── 6 first: nothing pinned ─────────────────────────────────────────────────────────────────
    console.log('── Nothing pinned ──');
    const fresh = [] as string[];
    for (let i = 0; i < 6; i++) fresh.push(await post(author));
    const aged = await post(author, { title: 'Aged offer' });
    db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 40 * DAY).toISOString(), aged);
    const need = await post(author, { type: 'need', title: 'Wanted: a ladder' });
    const ev1 = await eventIn(2, 'Bee two');
    const ev2 = await eventIn(3, 'Bee three');
    const ev3 = await eventIn(4, 'Bee four');
    const evFar = await eventIn(30, 'Fair, a month away');
    const pollSoon = await pollOf('Soon poll', 3);
    const pollLate = await pollOf('Late poll', 14);

    const plain = await home();
    assert(plain.market.length === 4 && plain.events.length === 3 && !!plain.decide?.poll, `setup: the three cards answer (${plain.market.length}, ${plain.events.length})`);
    assert(!/"pinned"/.test(plain.text), 'nothing pinned: no row carries the field, so an older app reads the answer it always read');
    assert(!plain.market.some(r => r.id === aged) && !plain.events.some(r => r.id === evFar) && plain.decide.poll.id === pollSoon,
        `and the card is as it was: no aged Offer, no far event, the soonest poll (${plain.decide.poll.id === pollSoon})`);

    // ── 1. New in the Market ────────────────────────────────────────────────────────────────────
    console.log('\n── 1. New in the Market ──');
    stamp(aged, DAY, 2000);
    stamp(need, DAY, 1000);
    let h = await home();
    assert(ids(h.market).slice(0, 2).join() === [need, aged].join(), `pinned Offer and Need lead, newest pin first, whatever their age (got ${ids(h.market).slice(0, 2).map(i => i === need ? 'need' : i === aged ? 'aged' : 'other').join()})`);
    assert(h.market.length === 4, `the card keeps its four (got ${h.market.length})`);
    assert(h.market[0].pinned === true && h.market[1].pinned === true && h.market.slice(2).every(r => r.pinned === undefined), 'the pinned rows say so, the rest do not');
    assert(new Set(ids(h.market)).size === 4, 'no row twice');

    // A pinned Offer already among the newest is not drawn twice, and still leads.
    stamp(fresh[0], DAY, 500);
    h = await home();
    assert(h.market[0].id === fresh[0] && h.market.length === 4 && new Set(ids(h.market)).size === 4 && h.market.filter(r => r.pinned).length === 3,
        `a pinned new Offer leads once, three pinned in all (got ${h.market.filter(r => r.pinned).length})`);
    clearPins();

    // Three at most: three pinned Offers and the one left for the pool.
    stamp(aged, DAY, 3000);
    stamp(fresh[1], DAY, 2000);
    stamp(fresh[2], DAY, 1000);
    h = await home();
    assert(ids(h.market).slice(0, 3).join() === [fresh[2], fresh[1], aged].join() && h.market.length === 4 && !h.market[3].pinned,
        `three pins lead the four, in pin order, one place left to the pool (got ${h.market.length})`);
    clearPins();

    // ── 4. By the clock ─────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. A pin that ran out ──');
    stamp(aged, -1000, DAY);
    h = await home();
    assert(!ids(h.market).includes(aged) && !/"pinned"/.test(h.text), `a pin that ran out by the clock is not pinned, though the row still holds its stamp (aged shown: ${ids(h.market).includes(aged)})`);
    clearPins();

    // ── 5. Reach as it was ──────────────────────────────────────────────────────────────────────
    console.log('\n── 5. Reach as it was ──');
    const hidden = await post(author, { title: 'Hidden by reports' });
    const removed = await post(author, { title: 'Taken down' });
    const groupId = crypto.randomUUID();
    db.prepare(`INSERT INTO groups (id, name, slug, created_by) VALUES (?, 'Garden club', 'garden-club', ?)`).run(groupId, author.pubKeyHex);
    db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status) VALUES (?, ?, 'member', 'active')`).run(groupId, author.pubKeyHex);
    const groupOnly = await post(author, { title: 'Club only', audienceScope: 'group', targetGroupId: groupId });
    const linked = await post(author, { title: 'Another community' });
    db.prepare('UPDATE posts SET origin_node = ? WHERE id = ?').run('https://other.example', linked);
    const away = await post(traveller, { title: 'Author on holiday' });
    db.prepare("INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'holiday_mode', 'true')").run(traveller.pubKeyHex);
    db.prepare('UPDATE posts SET hidden_by_reports_at = ? WHERE id = ?').run(new Date().toISOString(), hidden);
    db.prepare('UPDATE posts SET removed_by_moderator_at = ? WHERE id = ?').run(new Date().toISOString(), removed);
    // The card before any stamp: whatever else it holds (a copy of another community's shows as it always did), a stamp adds nothing.
    const unstamped = await home();
    for (const id of [hidden, removed, groupOnly, linked, away]) stamp(id, DAY);
    h = await home();
    assert(ids(unstamped.market).length === 4 && !ids(unstamped.market).includes(hidden) && !ids(unstamped.market).includes(groupOnly) && !ids(unstamped.market).includes(away),
        'setup: a post hidden by reports, a group\'s and an absent author\'s are not in the card to begin with');
    // (A stamp on a post off the board is taken off at once by the node's own trigger, which moves that row's last change: the
    // same four rows, perhaps in another order among themselves, none marked.)
    assert([...ids(h.market)].sort().join() === [...ids(unstamped.market)].sort().join() && !/"pinned"/.test(h.text),
        'and stamping a post hidden by reports, removed, a group\'s, another community\'s or an absent author\'s changes nothing: none leads, none is marked');
    clearPins();
    db.prepare("DELETE FROM member_preferences WHERE public_key = ? AND pref_key = 'holiday_mode'").run(traveller.pubKeyHex);

    // ── 2. Coming up ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. Coming up ──');
    stamp(evFar, DAY);
    h = await home();
    assert(h.events[0]?.id === evFar && h.events[0].pinned === true && h.events.length === 3, `a pinned event a month away leads, three in all (got ${h.events.length})`);
    assert(ids(h.events).slice(1).join() === [ev1, ev2].join() && h.events.slice(1).every(r => r.pinned === undefined), 'the soonest follow in start order, unpinned');
    clearPins();

    const sooner = await eventIn(1, 'Tomorrow');
    stamp(ev3, DAY, 100);
    h = await home();
    assert(ids(h.events).join() === [ev3, sooner, ev1].join(), `a pinned event leads a sooner one (got ${ids(h.events).map(i => [ev3, sooner, ev1, ev2, evFar].indexOf(i)).join()})`);
    clearPins();

    const endedEv = await eventIn(5, 'Over already');
    db.prepare('UPDATE posts SET event_start_at = ?, event_end_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * 3_600_000).toISOString(), new Date(Date.now() - 1000).toISOString(), endedEv);
    stamp(endedEv, DAY);
    h = await home();
    assert(!ids(h.events).includes(endedEv) && !/"pinned"/.test(h.text), 'a pinned event that has ended is not live: not shown, not pinned');
    clearPins();

    // ── 3. Decide ───────────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. Decide ──');
    stamp(pollLate, DAY);
    h = await home();
    assert(h.decide.poll.id === pollLate && h.decide.poll.pinned === true, `the first open poll is the pinned one (got ${h.decide.poll.id === pollLate})`);
    clearPins();
    h = await home();
    assert(h.decide.poll.id === pollSoon && h.decide.poll.pinned === undefined, 'with none pinned it is the soonest closing, unmarked');
    const closed = await pollOf('Closed poll', 7);
    await signed('POST', `/api/marketplace/posts/${closed}/close`, {}, askers['Closed poll']);
    stamp(closed, DAY);
    h = await home();
    assert(h.decide.poll.id === pollSoon && !/"pinned"/.test(h.text), 'a pinned poll that has closed is not the first open poll');
    clearPins();

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
