/**
 * Home's "Asked near you" card and the First steps fact behind "Ask for one thing you'd pay a neighbour for"
 * (scratch/fable-design/DESIGN-cold-start-trades-fable.md §2.4, slice N1; Marty, 4 Nov 2026: "All Fable's picks").
 * Over REAL HTTPS through the real signature middleware, on a local node as it ships.
 *
 *   1. no card while nothing is asked (never an empty box), and a Need only the reader wrote is nothing to them
 *   2. the rows: other members' open Needs only, the Market card's fields and no more, the reader's stars first, the newest
 *      first within each, five at most; an Offer, a Need already answered, a finished one, a group's Need the reader is not
 *      in and a copy from another community are none of them there
 *   3. built only when asked (counted), and from the member's version-2 layout when `cards=` is not sent; a suspended
 *      member gets no community card
 *   4. `steps.firstNeed`: false until the signer posts a Need (any status), their own and never another's; the card is kept
 *      up for the line only for an app that says `lands=first-need`, only after the first Offer, and only until the Need
 *   5. the answer holds nothing a lock screen should not: no author, no description and no place on a row
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-home-asked-card)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_READ_AUTH;

import crypto from 'node:crypto';
import { setMemberPhoto } from '@beanpool/engine';
import { TEST_PHOTOS } from './post-test-helper.js';
import { localFetch } from './keepalive-test-fetch.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 400);
const HOUR = 3_600_000;
const DAY = 86_400_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };

async function main(): Promise<void> {
    console.log('\n=== Home: Asked near you (N1) ===\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    // A tree without the card (origin/main) runs every step anyway, so each fails as an assertion rather than an abort.
    const answer: any = await import('./routes/home-answer.js' as string).catch(() => ({}));
    const homeCardBuilds: Record<string, number> = answer.homeCardBuilds ?? {};

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    function makeIdentity(callsign: string, days = 60): Id {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
        db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, status, joined_at, updated_at)
                    VALUES (?, ?, 'active', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
            .run(pubKeyHex, callsign, new Date(Date.now() - days * DAY).toISOString());
        setMemberPhoto(db, pubKeyHex, AVATAR);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
        return { pubKeyHex, privateKey };
    }
    async function signed(method: 'GET' | 'POST', pathAndQuery: string, body: unknown, id: Id) {
        resetGatewayRateLimit();
        const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = { method, path: pathAndQuery.split('?')[0], timestamp: ts, nonce, body: bodyString };
        const headers: Record<string, string> = {
            'X-Public-Key': id.pubKeyHex,
            'X-Signature': signRequest(id.privateKey, canonical),
            [SIGNED_FOR_HEADER]: signedForHost(),
            'X-Timestamp': String(ts), 'X-Nonce': nonce,
        };
        if (method === 'POST') headers['Content-Type'] = 'application/json';
        const res = await localFetch(`${BASE}${pathAndQuery}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
        const text = await res.text();
        let json: any;
        try { json = JSON.parse(text); } catch { /* empty (304) */ }
        return { status: res.status, body: json, text, error: json?.error as string | undefined };
    }
    const home = (id: Id, query = 'cards=needs,asked,steps,community', lands = '') =>
        signed('GET', `/api/home?${query}${lands ? `&lands=${lands}` : ''}`, undefined, id);
    const askedOf = async (id: Id, query?: string) => (await home(id, query)).body?.cards?.asked;
    const setInterests = (id: Id, stars: string[]) => db.prepare(
        'INSERT INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, ?, ?) ON CONFLICT(public_key, pref_key) DO UPDATE SET pref_value = excluded.pref_value',
    ).run(id.pubKeyHex, 'interests', JSON.stringify(stars));
    const setLayout = (id: Id, cards: { id: string; type: string }[]) => db.prepare(
        'INSERT INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, ?, ?) ON CONFLICT(public_key, pref_key) DO UPDATE SET pref_value = excluded.pref_value',
    ).run(id.pubKeyHex, 'home.layout', JSON.stringify({ v: 2, cards, dismissed: {}, updatedAt: new Date().toISOString() }));

    // A member's Offer first (a Need needs a listed Offer where Beans are on), then what they ask for.
    const offered = new Set<string>();
    let n = 0;
    const post = async (who: Id, type: 'offer' | 'need', body: Record<string, unknown> = {}): Promise<string> => {
        n++;
        const r = await signed('POST', '/api/marketplace/posts', {
            type, category: 'garden', title: `${type} ${n}`, description: 'Private description words', price_c: 2000, priceType: 'fixed',
            authorPublicKey: who.pubKeyHex, photos: TEST_PHOTOS, lat: -28.6, lng: 153.5, ...body,
        }, who);
        const id = r.body?.post?.id ?? r.body?.id;
        if (!id) throw new Error(`could not post a ${type}: ${r.status} ${r.error}`);
        return id as string;
    };
    const need = async (who: Id, body: Record<string, unknown> = {}): Promise<string> => {
        if (!offered.has(who.pubKeyHex)) { await post(who, 'offer', { title: `Offer by ${who.pubKeyHex.slice(0, 6)}` }); offered.add(who.pubKeyHex); }
        return post(who, 'need', body);
    };
    /** When the Need was made, in the node's own columns: the card reads the newest made, not the last changed. */
    const madeAgo = (id: string, ms: number, updatedAgo = ms) => db.prepare('UPDATE posts SET created_at = ?, updated_at = ? WHERE id = ?')
        .run(new Date(Date.now() - ms).toISOString(), new Date(Date.now() - updatedAgo).toISOString(), id);

    const ana = makeIdentity('AskAna');   // the reader
    const ben = makeIdentity('AskBen');
    const cy = makeIdentity('AskCy');
    const dee = makeIdentity('AskDee');
    const eve = makeIdentity('AskEve');
    const sam = makeIdentity('AskSam');   // suspended later
    se.reconcileLedgerFromDb();

    // ── 1. Nothing asked: no card ────────────────────────────────────────────────────────────────────────────────────
    const none = await home(ana);
    assert(none.status === 200 && none.body?.cards?.asked === undefined && !('asked' in (none.body?.cards ?? {})),
        `with no Need on the node there is no card at all, not an empty one (${none.status} ${show(none.body?.cards?.asked)})`);

    const own = await need(ana, { title: 'Ana asks for a hand', category: 'labour' });
    assert((await askedOf(ana)) === undefined, `a Need only the reader wrote is nothing to show them (${show(await askedOf(ana))})`);

    // ── 2. The rows ──────────────────────────────────────────────────────────────────────────────────────────────────
    const n1 = await need(ben, { title: 'Ben wants a trailer', category: 'tools', price_c: 3000, priceType: 'hourly' });
    const n2 = await need(cy, { title: 'Cy needs a bed dug', category: 'garden', price_c: 4000 });
    const n3 = await need(dee, { title: 'Dee wants a lift', category: 'transport', price_c: 0, priceType: 'fixed' });
    const n4 = await need(eve, { title: 'Eve seeks seedlings', category: 'garden', price_c: 500, priceType: 'fixed' });
    madeAgo(own, 5 * HOUR); madeAgo(n1, 4 * HOUR); madeAgo(n2, 3 * HOUR); madeAgo(n3, 2 * HOUR); madeAgo(n4, 1 * HOUR);

    const offerOnly = await post(ben, 'offer', { title: 'Ben offers eggs', category: 'food' });
    madeAgo(offerOnly, 30 * 60_000);

    const plain = await askedOf(ana);
    const ids = (plain?.items ?? []).map((i: any) => i.id);
    assert(JSON.stringify(ids) === JSON.stringify([n4, n3, n2, n1]),
        `with no stars: other members' open Needs, the newest made first; not her own, not an Offer (${show(ids)})`);
    const keys = Object.keys(plain?.items?.[0] ?? {}).sort();
    assert(JSON.stringify(keys) === JSON.stringify(['category', 'createdAt', 'id', 'photoUrl', 'priceType', 'price_c', 'title']),
        `a row carries the Market card's fields and no more: id, title, category, price_c (whole hundredths), priceType, createdAt, photoUrl (${show(keys)})`);
    const row1 = plain?.items?.find((i: any) => i.id === n1);
    assert(row1?.title === 'Ben wants a trailer' && row1?.category === 'tools' && row1?.price_c === 3000 && row1?.priceType === 'hourly'
        && typeof row1?.createdAt === 'string' && Math.abs(Date.parse(row1.createdAt) - (Date.now() - 4 * HOUR)) < 60_000 && typeof row1?.photoUrl === 'string',
        `a row says what the Need said: title, category, 30 Beans an hour, when it was made, its photo (${show(row1)})`);

    setInterests(ana, ['tools', 'transport']);
    const starred = (await askedOf(ana))?.items?.map((i: any) => i.id);
    assert(JSON.stringify(starred) === JSON.stringify([n3, n1, n4, n2]),
        `her stars (tools, transport) come first and the newest first within them, then the rest newest first (${show(starred)})`);
    setInterests(ana, []);

    // The newest MADE, not the last changed: an old Need edited just now does not climb over a newer one.
    madeAgo(n1, 4 * HOUR, 1_000);
    const afterEdit = (await askedOf(ana))?.items?.map((i: any) => i.id);
    assert(JSON.stringify(afterEdit) === JSON.stringify([n4, n3, n2, n1]), `an old Need changed just now keeps its place by when it was made (${show(afterEdit)})`);

    // Five rows at most.
    const extra: string[] = [];
    for (const who of [ben, cy, dee]) { const id = await need(who, { title: `More from ${who.pubKeyHex.slice(0, 4)}`, category: 'food' }); extra.push(id); }
    extra.forEach((id, i) => madeAgo(id, (30 + i) * 60_000));
    const five = (await askedOf(ana))?.items;
    assert(five?.length === 5 && five[0].id === extra[0] && !five.some((i: any) => i.id === own),
        `five rows at most, the newest first (${five?.length}: ${show(five?.map((i: any) => i.title))})`);
    db.prepare('UPDATE posts SET status = ? WHERE id IN (?, ?, ?)').run('cancelled', ...extra);

    // Not open: answered (pending), finished, called off; a copy from another community; a group's Need she is not in.
    const baseline = (await askedOf(ana))?.items?.map((i: any) => i.id);
    assert(JSON.stringify(baseline) === JSON.stringify([n4, n3, n2, n1]), `back to the four after the extras are called off (${show(baseline)})`);
    db.prepare("UPDATE posts SET status = 'pending' WHERE id = ?").run(n4);
    db.prepare("UPDATE posts SET status = 'completed' WHERE id = ?").run(n3);
    const open = (await askedOf(ana))?.items?.map((i: any) => i.id);
    assert(JSON.stringify(open) === JSON.stringify([n2, n1]), `a Need already answered or finished is not asked any more (${show(open)})`);
    db.prepare("UPDATE posts SET status = 'active' WHERE id IN (?, ?)").run(n4, n3);

    db.prepare("UPDATE posts SET origin_node = 'peer-elsewhere' WHERE id = ?").run(n3);
    const noCopy = (await askedOf(ana))?.items?.map((i: any) => i.id);
    assert(!noCopy?.includes(n3) && noCopy?.includes(n4), `a Need that came from another community is not a neighbour's (${show(noCopy)})`);
    db.prepare('UPDATE posts SET origin_node = NULL WHERE id = ?').run(n3);

    // A member's copy of a Need from their own community (engine/event-copy.ts) is a pointer to it, not a neighbour's Need
    // here: it can't be answered or traded.
    db.prepare("UPDATE posts SET shown_from_host = 'home.example.org', shown_from_post_id = 'p-1' WHERE id = ?").run(n3);
    const noShown = (await askedOf(ana))?.items?.map((i: any) => i.id);
    assert(!noShown?.includes(n3) && noShown?.includes(n4), `a member's copy of a Need from their own community is not asked here (${show(noShown)})`);
    db.prepare('UPDATE posts SET shown_from_host = NULL, shown_from_post_id = NULL WHERE id = ?').run(n3);

    db.prepare("UPDATE posts SET audience_scope = 'group', target_group_id = 'a-group-ana-is-not-in' WHERE id = ?").run(n2);
    const noGroup = (await askedOf(ana))?.items?.map((i: any) => i.id);
    assert(!noGroup?.includes(n2) && noGroup?.includes(n1), `a group's Need she is not in is not there, as the Market reads it (${show(noGroup)})`);
    db.prepare("UPDATE posts SET audience_scope = 'public', target_group_id = NULL WHERE id = ?").run(n2);

    // ── 3. Built only when asked; the layout; who is answered ───────────────────────────────────────────────────────────
    const b0 = homeCardBuilds.asked ?? 0;
    await home(ana, 'cards=needs,community');
    assert((homeCardBuilds.asked ?? 0) === b0, `not asked for, not built (${b0} → ${homeCardBuilds.asked ?? 0})`);
    await home(ana, 'cards=needs,asked,community');
    assert((homeCardBuilds.asked ?? 0) === b0 + 1, `asked for, built once (${b0} → ${homeCardBuilds.asked ?? 0})`);

    setLayout(ana, [{ id: 'steps', type: 'steps' }, { id: 'asked', type: 'asked' }]);
    const b1 = homeCardBuilds.asked ?? 0;
    const fromLayout = await signed('GET', '/api/home', undefined, ana);
    assert(Array.isArray(fromLayout.body?.cards?.asked?.items) && (homeCardBuilds.asked ?? 0) === b1 + 1,
        `with no cards= it is built from a layout that holds it (${show(fromLayout.body?.cards?.asked?.items?.length)})`);
    setLayout(ana, [{ id: 'steps', type: 'steps' }]);
    const b2 = homeCardBuilds.asked ?? 0;
    const hidden = await signed('GET', '/api/home', undefined, ana);
    assert(hidden.body?.cards?.asked === undefined && (homeCardBuilds.asked ?? 0) === b2, `and not from one that leaves it out (${show(hidden.body?.cards?.asked)})`);

    db.prepare("UPDATE members SET status = 'suspended' WHERE public_key = ?").run(sam.pubKeyHex);
    const suspended = await home(sam, 'cards=needs,asked,steps,community');
    assert(suspended.status === 200 && suspended.body?.cards?.asked === undefined, `a suspended member gets no community card (${suspended.status} ${show(suspended.body?.cards?.asked)})`);

    // ── 4. steps.firstNeed ─────────────────────────────────────────────────────────────────────────────────────────────
    // First steps ends 30 days after joining (DESIGN-home-default-fable.md §2.4): Fay and Gus are 20 days in.
    const fresh = makeIdentity('AskFay', 20);
    const stepsOf = async (id: Id, lands = '') => (await home(id, 'cards=needs,steps,community', lands)).body?.cards?.steps;
    const s0 = await stepsOf(fresh);
    assert(s0?.firstOffer === false && s0?.firstNeed === false, `a new member: no Offer, no Need yet (${show(s0)})`);

    await post(fresh, 'offer', { title: 'Fay offers jam', category: 'food' });
    const s1 = await stepsOf(fresh);
    assert(s1?.firstOffer === true && s1?.firstNeed === false, `after her first Offer: still no Need (${show(s1)})`);

    // Another member's Need is not hers. Ben is read inside his 30 days too, so he has a card to read it from.
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(new Date(Date.now() - 20 * DAY).toISOString(), ben.pubKeyHex);
    assert((await stepsOf(fresh))?.firstNeed === false && (await stepsOf(ben))?.firstNeed === true, `Ben's Need is Ben's, not Fay's (${show((await stepsOf(fresh))?.firstNeed)})`);

    // The card is kept up for the line only for an app that says it draws it. Fay is inside her 30 days, so only a line
    // left keeps it (the 12-words line too only for an app that says `lands=words`, which neither read here does).
    setInterests(fresh, ['food']);
    db.prepare("INSERT OR REPLACE INTO invite_codes (code, created_by, created_at) VALUES ('INV-FAY-1', ?, ?)").run(fresh.pubKeyHex, new Date().toISOString());
    const oldApp = await home(fresh, 'cards=needs,steps,community');
    const newApp = await home(fresh, 'cards=needs,steps,community', 'first-need');
    const done = (s: any) => s && s.firstOffer && s.photo && s.interests && s.invited === true;
    assert(done(newApp.body?.cards?.steps) && oldApp.body?.cards?.steps === undefined,
        `every line an older app draws is done: it is given no card; an app that says lands=first-need still is, for the Need line (old ${show(oldApp.body?.cards?.steps)}; new ${show(newApp.body?.cards?.steps)})`);
    assert(newApp.body?.cards?.steps?.firstNeed === false, `and that card says the Need line is not done (${show(newApp.body?.cards?.steps?.firstNeed)})`);

    await need(fresh, { title: 'Fay asks for a lift', category: 'transport' });
    const afterNeed = await home(fresh, 'cards=needs,steps,community', 'first-need');
    assert(afterNeed.body?.cards?.steps === undefined, `once she has asked for one thing the card goes (${show(afterNeed.body?.cards?.steps)})`);
    // Called off or finished, it still counts: a step never un-ticks.
    db.prepare("UPDATE posts SET status = 'cancelled' WHERE author_pubkey = ? AND type = 'need'").run(fresh.pubKeyHex);
    assert((await home(fresh, 'cards=needs,steps,community', 'first-need')).body?.cards?.steps === undefined, 'and it stays gone when that Need is called off');

    // Only after the first Offer: a member with a Need and no Offer is not asked for one more; a new member without an Offer is asked for the Offer first.
    const early = makeIdentity('AskGus', 20);
    assert((await stepsOf(early, 'first-need'))?.firstOffer === false, 'a member with no Offer is still on the Offer line, not asked for a Need');

    // ── 5. Nothing private on a row ──────────────────────────────────────────────────────────────────────────────────────
    const text = JSON.stringify((await askedOf(ana))?.items ?? []);
    assert(text.length > 10 && !/Private description words|AskBen|AskCy|AskDee|AskEve|authorPublicKey|authorCallsign|lat"|lng"|description/.test(text),
        `a row names no author, gives no description and no place (${text.slice(0, 200)})`);
    assert(se.getMember(ana.pubKeyHex) !== undefined, 'setup sanity: the reader is a member');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
