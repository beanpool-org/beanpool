/**
 * Home's pinned rows on the global node (scratch/fable-design/DESIGN-pinning-fable.md §2.2, §2.10; slice 4), over HTTP through the real
 * middleware, on the global profile, where "Near you" and "Coming up · within 50 km" come nearest first:
 *
 *  1. A pin comes from anywhere, as it does in the Market: a pinned Offer in Lagos leads a Sydney member's Near you and a
 *     visitor's, marked `pinned`, with the member's distance to it measured as any row's is. The nearer ones follow, and the
 *     card keeps its limit (four for a member, three for a visitor).
 *  2. A pinned event a month away and far outside 50 km leads Coming up, with the event 50 km away's soonest after it.
 *  3. A visitor reads what a visitor reads: the pinned row has no place but its area and no author's name, and a pin that is
 *     a group's post leaks nothing.
 *  4. A pin that ended by the clock is not pinned for either reader.
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-home-pinned-global)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import { setMemberPhoto } from '@beanpool/engine';
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
const LAGOS = { lat: 6.5244, lng: 3.3792 };
const SYDNEY = { lat: -33.8688, lng: 151.2093 };
const DAY = 86_400_000;
const SYD = 'Australia/Sydney';

async function request(method: 'GET' | 'POST', pathAndQuery: string, body: unknown, id: Id | null) {
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
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await localFetch(`${BASE}${pathAndQuery}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text, error: json?.error as string | undefined, view: res.headers.get('x-beanpool-view') };
}

async function main(): Promise<void> {
    console.log('\nHome: a pinned row first, on the global node\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
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
    const owner = memberAt('OwnerOl', LAGOS);
    se.grantNodeRole(owner.pubKeyHex, 'owner', 'owner:password');
    const lagosAuthor = memberAt('LagosLu', LAGOS);
    const sydneyAuthor = memberAt('SydneySi', SYDNEY);
    const reader = memberAt('ReaderRo', SYDNEY);

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
    // The day is Sydney's, not UTC's: the event is at 10:00 Sydney time, and from 23:00 to 24:00 UTC the UTC date of
    // 'tomorrow' is already today in Sydney, so a one-day event started in the past and was refused.
    const clockIn = (days: number) => new Intl.DateTimeFormat('en-CA', { timeZone: SYD, year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(new Date(Date.now() + days * DAY)) + 'T10:00';
    const eventAt = (who: Id, place: { lat: number; lng: number }, days: number, title: string) =>
        post(who, place, { type: 'event', title, description: 'Bring gloves', eventStartLocal: clockIn(days), eventTz: SYD, eventPlaceName: 'The hall' });
    const pin = (id: string) => request('POST', `/api/marketplace/posts/${id}/pin`, { days: 3 }, owner);
    const clearPins = () => db.prepare('UPDATE posts SET pinned_until = NULL, pinned_at = NULL WHERE pinned_until IS NOT NULL').run();
    const home = async (who: Id | null) => {
        resetGatewayRateLimit();
        const r = await request('GET', `/api/home?cards=market,events&lat=${SYDNEY.lat}&lng=${SYDNEY.lng}`, null, who);
        if (r.status !== 200) throw new Error(`home answered ${r.status} ${r.error}`);
        const cards = r.body?.cards ?? {};
        return { ...r, market: (cards.market?.items ?? []) as any[], events: (cards.events?.items ?? []) as any[] };
    };
    const ids = (rows: any[]) => rows.map(r => r.id as string);

    const farOffer = await post(lagosAuthor, LAGOS);
    const near: string[] = [];
    for (let i = 0; i < 6; i++) near.push(await post(sydneyAuthor, { lat: SYDNEY.lat + i * 0.001, lng: SYDNEY.lng }));
    const farEvent = await eventAt(lagosAuthor, LAGOS, 30, 'Lagos fair');
    const nearEvents = [await eventAt(sydneyAuthor, SYDNEY, 2, 'Sydney bee'), await eventAt(memberAt('HostH', SYDNEY), SYDNEY, 3, 'Sydney swap')];

    const plain = await home(reader);
    assert(plain.view !== 'guest' && plain.market.length === 4 && !ids(plain.market).includes(farOffer) && !ids(plain.events).includes(farEvent),
        'setup: Near you is the four nearest, Coming up the events within 50 km, and the far ones are in neither');
    assert(!/"pinned"/.test(plain.text), 'and no row says pinned');

    console.log('── 1. Near you ──');
    const pinned = await pin(farOffer);
    assert(pinned.status === 200, `an owner pins the Offer in Lagos (got ${pinned.status} ${pinned.error ?? ''})`);
    const member = await home(reader);
    assert(member.market[0]?.id === farOffer && member.market[0].pinned === true && member.market.length === 4,
        `a member in Sydney reads the Lagos pin first, four in all (got ${member.market.length})`);
    assert(typeof member.market[0].distanceKm === 'number' && member.market[0].distanceKm > 1000, `with its distance measured (${member.market[0]?.distanceKm} km)`);
    assert(ids(member.market).slice(1).join() === ids(plain.market).slice(0, 3).join() && member.market.slice(1).every(r => r.pinned === undefined),
        'the nearest follow, as they were, unmarked');
    const visitor = await home(null);
    assert(visitor.view === 'guest' && visitor.market[0]?.id === farOffer && visitor.market[0].pinned === true && visitor.market.length === 3,
        `a visitor reads it first too, and keeps their three (got ${visitor.market.length}, view ${visitor.view})`);
    assert(!visitor.text.includes(lagosAuthor.pubKeyHex) && !visitor.text.includes('LagosLu'), "and the author's name and key are not in a visitor's answer");

    console.log('── 2. Coming up ──');
    clearPins();
    await pin(farEvent);
    const events = await home(reader);
    assert(events.events[0]?.id === farEvent && events.events[0].pinned === true && ids(events.events).slice(1).every(id => nearEvents.includes(id)),
        `a pinned event in Lagos, a month away, leads Coming up; the events near follow (got ${events.events.length})`);
    assert(events.events.length === 3, `three in all (got ${events.events.length})`);
    const visitorEvents = await home(null);
    assert(visitorEvents.events[0]?.id === farEvent && visitorEvents.events[0].pinned === true && visitorEvents.events[0].place === null,
        "a visitor reads it first, with no place named (a visitor's rule)");

    console.log('── 3. A group\'s post ──');
    clearPins();
    const groupId = crypto.randomUUID();
    db.prepare(`INSERT INTO groups (id, name, slug, created_by) VALUES (?, 'Garden club', 'garden-club', ?)`).run(groupId, lagosAuthor.pubKeyHex);
    db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status) VALUES (?, ?, 'member', 'active')`).run(groupId, lagosAuthor.pubKeyHex);
    const groupOnly = await post(lagosAuthor, LAGOS, { title: 'Club only', audienceScope: 'group', targetGroupId: groupId });
    db.prepare('UPDATE posts SET pinned_until = ?, pinned_at = ? WHERE id = ?').run(new Date(Date.now() + DAY).toISOString(), new Date().toISOString(), groupOnly);
    const leak = await home(reader);
    const leakV = await home(null);
    assert(!leak.text.includes(groupOnly) && !leakV.text.includes(groupOnly) && !/"pinned"/.test(leak.text + leakV.text), "a stamp on a group's post shows it to no reader outside the group, and marks nothing");

    console.log('── 4. By the clock ──');
    clearPins();
    db.prepare('UPDATE posts SET pinned_until = ?, pinned_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), new Date(Date.now() - DAY).toISOString(), farOffer);
    const ended = await home(reader);
    const endedV = await home(null);
    assert(!ids(ended.market).includes(farOffer) && !ids(endedV.market).includes(farOffer) && !/"pinned"/.test(ended.text + endedV.text), 'a pin that ran out by the clock is not pinned, for a member or a visitor');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
