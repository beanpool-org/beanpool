/**
 * Home's "Asked near you" on the global node (scratch/fable-design/DESIGN-cold-start-trades-fable.md §2.3 "Global introduces,
 * never holds", §2.4, slice N1), over HTTP through the real middleware, on the global profile, where Beans are off and the
 * listings come nearest first:
 *
 *  1. "Near" means within 250 km of the reader's point: a Need in Sydney is asked of a Sydney member, one in Lagos is not, and
 *     one 300 km out is not; a Need with no place at all is not near anyone
 *  2. a reader with no point (no `lat`/`lng`, and no area of their own) is shown nothing, not the other side of the world
 *     under a name that says near
 *  3. Beans are off: a row carries no price (`price_c`, nor the old `credits`)
 *  4. a visitor (unsigned) is not given the card: the visitors' Home is the Market, Coming up and the community's counts
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-home-asked-card-global)
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
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 300);

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const SYDNEY = { lat: -33.8688, lng: 151.2093 };
const LAGOS = { lat: 6.5244, lng: 3.3792 };
const DAY = 86_400_000;

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
    return { status: res.status, body: json, text, error: json?.error as string | undefined };
}

async function main(): Promise<void> {
    console.log('\n=== Home: Asked near you, on the global node (N1) ===\n');
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

    const memberAt = (callsign: string, area: { lat: number; lng: number } | null): Id => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
        const joined = new Date(Date.now() - 60 * DAY).toISOString();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, area_lat, area_lng, area_updated_at)
                    VALUES (?, ?, 'active', ?, 'seed', ?, ?, ?, ?)`)
            .run(pubKeyHex, callsign, joined, `INV-${callsign.toUpperCase()}`, area?.lat ?? null, area?.lng ?? null, area ? joined : null);
        setMemberPhoto(db, pubKeyHex, AVATAR);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
        return { pubKeyHex, privateKey };
    };
    const sydneyReader = memberAt('SydReader', SYDNEY);
    const placeless = memberAt('NoPlaceNell', null);
    const sydneyAuthor = memberAt('SydAuthor', SYDNEY);
    const lagosAuthor = memberAt('LagosAuthor', LAGOS);
    const farAuthor = memberAt('FarAuthor', SYDNEY);
    const noPlaceAuthor = memberAt('NoPlaceAuthor', SYDNEY);

    let n = 0;
    const need = async (who: Id, place: { lat?: number; lng?: number }, title: string): Promise<string> => {
        n++;
        resetGatewayRateLimit();
        const r = await request('POST', '/api/marketplace/posts', {
            type: 'need', category: 'garden', title, description: 'Someone to dig a bed', price_c: 0, authorPublicKey: who.pubKeyHex, photos: TEST_PHOTOS, ...place,
        }, who);
        const id = r.body?.post?.id ?? r.body?.id;
        if (!id) throw new Error(`could not post a Need (${title}): ${r.status} ${r.error}`);
        return id as string;
    };
    const askedFor = async (who: Id | null, query: string) => {
        resetGatewayRateLimit();
        const r = await request('GET', `/api/home?cards=asked,market,community${query}`, null, who);
        return { r, asked: r.body?.cards?.asked };
    };
    const atSydney = `&lat=${SYDNEY.lat}&lng=${SYDNEY.lng}`;

    const here = await need(sydneyAuthor, { lat: SYDNEY.lat + 0.02, lng: SYDNEY.lng }, 'Dig a bed in Sydney');
    const lagos = await need(lagosAuthor, LAGOS, 'Dig a bed in Lagos');
    // About 300 km from Sydney: 2.7° of latitude north.
    const far = await need(farAuthor, { lat: SYDNEY.lat + 2.7, lng: SYDNEY.lng }, 'Dig a bed 300 km out');
    const noPlace = await need(noPlaceAuthor, {}, 'Dig a bed, no place');
    db.prepare('UPDATE posts SET lat = NULL, lng = NULL WHERE id = ?').run(noPlace);

    // 1 + 3. Within 250 km only; Beans are off.
    const sydney = await askedFor(sydneyReader, atSydney);
    const ids: string[] = (sydney.asked?.items ?? []).map((i: any) => i.id);
    assert(sydney.r.status === 200 && JSON.stringify(ids) === JSON.stringify([here]),
        `a Sydney member is asked for the Need in Sydney, not Lagos, not 300 km out, not one with no place (${show(ids)}; lagos ${lagos.slice(0, 6)}, far ${far.slice(0, 6)}, none ${noPlace.slice(0, 6)})`);
    // The price under its name since whole hundredths, `price_c`, and its old one: an absence checked by the old name alone
    // would pass whatever the row carries.
    assert(sydney.asked?.items?.[0] && !('price_c' in sydney.asked.items[0]) && !('credits' in sydney.asked.items[0]),
        `Beans are off here: a row has no price, price_c or credits (${show(sydney.asked?.items?.[0])})`);
    assert(sydney.asked?.items?.[0]?.title === 'Dig a bed in Sydney' && sydney.asked?.items?.[0]?.category === 'garden',
        `and says what the Need said (${show(sydney.asked?.items?.[0])})`);

    // The member's own area is their point when the request gives none.
    const byArea = await askedFor(sydneyReader, '');
    assert(JSON.stringify((byArea.asked?.items ?? []).map((i: any) => i.id)) === JSON.stringify([here]),
        `a member with an area of their own is near it without sending a point (${show(byArea.asked?.items?.map((i: any) => i.id))})`);

    // 2. No point at all: nothing, though three Needs are open.
    const lost = await askedFor(placeless, '');
    assert(lost.r.status === 200 && lost.asked === undefined, `no point and no area: no card, not a Need from the other side of the world (${lost.r.status} ${show(lost.asked)})`);
    // The same member given a point is asked as anyone is.
    const found = await askedFor(placeless, atSydney);
    assert(JSON.stringify((found.asked?.items ?? []).map((i: any) => i.id)) === JSON.stringify([here]), 'and given a point, they are asked as anyone is');

    // 4. A visitor: no card.
    const visitor = await askedFor(null, atSydney);
    assert(visitor.r.status === 200 && visitor.asked === undefined, `a visitor is given the visitors' Home, and no Asked near you (${visitor.r.status} ${show(visitor.asked)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
