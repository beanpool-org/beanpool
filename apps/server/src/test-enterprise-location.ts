/**
 * Enterprise Location Tests (docs/the-commons.md §2.2, Slice 6)
 *
 * Verifies:
 *  1. Only keepers or an admin can set or clear enterprise location.
 *     Non-keepers/strangers are rejected (403 / error).
 *  2. Range CHECK is enforced on lat [-90, 90] and lng [-180, 180] both at API/engine level
 *     and directly via SQLite database CHECK constraint.
 *  3. Recorded with auth_signer on the members row (auth_signer / location_auth_signer).
 *  4. Approximate rounding (approximateLocation / roundToRoughly100m) rounds to roughly 100m (3 decimal places).
 *  5. Map endpoint (/api/enterprises/map):
 *     - Includes active enterprises with location.
 *     - Includes paused enterprises with location, marking paused: true.
 *     - Excludes completed (wound-up) enterprises even if they had a location.
 *     - Excludes enterprises without a location.
 *  6. Additive, idempotent migration: existing enterprises have no location (null) and are unaffected.
 *  7. PR #839 Blocker A — a wound-up enterprise's location is removed and never served:
 *     - finaliseWindUp clears lat/lng and records the finalising actor as the location signer.
 *     - /api/treasuries, /api/enterprises and the detail endpoints omit coordinates for completed enterprises.
 *     - A node admin can still clear a completed enterprise's location (signed member route and Settings app route);
 *       a stranger cannot.
 *     - The boot migration clears coordinates already stored on completed enterprises and leaves active ones alone.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-enterprise-location.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, createTreasury,
    adminAssignTreasuryOperator, setEnterpriseLocation,
    clearEnterpriseLocation, pauseEnterprise, finaliseWindUp,
} from './state-engine.js';
import { approximateLocation, roundToRoughly100m } from '@beanpool/core';
import { startHttpsServer } from './https-server.js';
import { db, initSchema } from './db/db.js';
import { hashPassword, saveLocalConfig, getLocalConfig } from './config/local-config.js';

const PORT = 8631;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

function makeIdentity(callsign: string) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, avatar_url, joined_at) VALUES (?, ?, 'data:image/png;base64,iVBORw0KGgo=', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pubKeyHex, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

async function signedFetch(method: 'GET' | 'POST' | 'DELETE', path: string, id: { pubKeyHex: string; privateKey: crypto.KeyObject }, body?: any) {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : bodyString,
    });
}

async function main() {
    console.log('Running enterprise location tests (docs/the-commons.md §2.2)...\n');
    await initTls();
    initStateEngine();
    const srv = await startHttpsServer(PORT);

    try {
        const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

        // ── 1. Approximate rounding helper ──
        const rawLat = -28.549521;
        const rawLng = 153.500543;
        const approx = approximateLocation(rawLat, rawLng);
        assert(approx.lat === -28.55, `approximateLocation rounds lat -28.549521 to -28.55 (got ${approx.lat})`);
        assert(approx.lng === 153.501, `approximateLocation rounds lng 153.500543 to 153.501 (got ${approx.lng})`);

        const aliasApprox = roundToRoughly100m(rawLat, rawLng);
        assert(aliasApprox.lat === -28.55 && aliasApprox.lng === 153.501, 'roundToRoughly100m produces identical output to approximateLocation');

        // ── 2. Create enterprise & identities ──
        const { publicKey: shed } = createTreasury('MullumToolShed', AVATAR, 0);
        const { publicKey: flock } = createTreasury('CommunityEggs', AVATAR, 0);

        const aliceKeeper = makeIdentity('AliceKeeper');
        const bobStranger = makeIdentity('BobStranger');
        const adminId = makeIdentity('NodeAdmin');

        // Seed admin role in node_roles
        db.prepare("INSERT OR IGNORE INTO node_roles (member_pubkey, role, granted_at, granted_by) VALUES (?, 'admin', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis')").run(adminId.pubKeyHex);

        // Appoint Alice as keeper of shed
        adminAssignTreasuryOperator(shed, aliceKeeper.pubKeyHex, 'admin', 100);

        // Check additive, idempotent migration: existing enterprises have no location
        const initialShedRow = db.prepare('SELECT lat, lng, location_auth_signer FROM members WHERE public_key = ?').get(shed) as any;
        assert(initialShedRow.lat === null && initialShedRow.lng === null, 'Existing enterprise has no initial location (null)');
        assert(initialShedRow.location_auth_signer === null, 'Existing enterprise has no initial location_auth_signer (null)');

        // Enterprise created without location has null location_auth_signer even when leadKeeperPubkey is provided
        const { publicKey: unlocatedWithKeeper } = createTreasury('UnlocatedCoop', AVATAR, 0, {
            leadKeeperPubkey: aliceKeeper.pubKeyHex,
        });
        const unlocatedRow = db.prepare('SELECT lat, lng, location_auth_signer, auth_signer FROM members WHERE public_key = ?').get(unlocatedWithKeeper) as any;
        assert(unlocatedRow.location_auth_signer === null, 'Enterprise created without location has null location_auth_signer even with lead keeper');
        assert(unlocatedRow.auth_signer === null, 'Enterprise created without location has null auth_signer even with lead keeper');

        // ── 3. Auth checks: stranger vs keeper vs admin ──
        // Bob (stranger) attempts to set location -> rejected 403
        const strangerRes = await signedFetch('POST', `/api/enterprise/${shed}/location`, bobStranger, {
            lat: -28.55,
            lng: 153.50,
        });
        assert(strangerRes.status === 403, `Stranger setting location rejected with 403 (got ${strangerRes.status})`);

        // Seed updated_at in past to verify location update touches updated_at for delta sync
        db.prepare("UPDATE members SET updated_at = '2020-01-01T00:00:00.000Z' WHERE public_key = ?").run(shed);

        // Alice (keeper) sets location on shed -> succeeds 200
        const keeperRes = await signedFetch('POST', `/api/enterprise/${shed}/location`, aliceKeeper, {
            lat: -28.5495,
            lng: 153.5005,
        });
        assert(keeperRes.ok, `Keeper successfully sets enterprise location (status ${keeperRes.status})`);
        const keeperData = await keeperRes.json();
        assert(keeperData.success === true, 'Response body indicates success: true');
        assert(keeperData.lat === -28.5495, `Response lat matches -28.5495 (got ${keeperData.lat})`);
        assert(keeperData.lng === 153.5005, `Response lng matches 153.5005 (got ${keeperData.lng})`);

        // Check database row for auth_signer and coordinates
        const shedRow = db.prepare('SELECT lat, lng, auth_signer, location_auth_signer, updated_at FROM members WHERE public_key = ?').get(shed) as any;
        assert(shedRow.lat === -28.5495, 'Database lat recorded correctly');
        assert(shedRow.lng === 153.5005, 'Database lng recorded correctly');
        assert(shedRow.location_auth_signer === aliceKeeper.pubKeyHex, `Database location_auth_signer records Alice (got ${shedRow.location_auth_signer})`);
        assert(shedRow.auth_signer === aliceKeeper.pubKeyHex, `Database auth_signer records Alice (got ${shedRow.auth_signer})`);
        assert(shedRow.updated_at > '2020-01-01T00:00:00.000Z', 'setEnterpriseLocation updates updated_at for delta sync');

        // Verify members_touch_updated_at trigger fires on direct column updates (lat, lng, location_updated_at)
        db.prepare("UPDATE members SET updated_at = '2020-01-01T00:00:00.000Z' WHERE public_key = ?").run(shed);
        db.prepare("UPDATE members SET lat = -28.5490 WHERE public_key = ?").run(shed);
        const triggerTouchRow = db.prepare("SELECT updated_at FROM members WHERE public_key = ?").get(shed) as any;
        assert(triggerTouchRow.updated_at > '2020-01-01T00:00:00.000Z', 'Direct UPDATE of lat fires members_touch_updated_at trigger');

        // Admin can also set location via signed ed25519 member role
        const adminRes = await signedFetch('POST', `/api/enterprise/${flock}/location`, adminId, {
            lat: -28.552,
            lng: 153.504,
        });
        assert(adminRes.ok, `Admin successfully sets enterprise location (status ${adminRes.status})`);
        const flockRow = db.prepare('SELECT lat, lng, location_auth_signer FROM members WHERE public_key = ?').get(flock) as any;
        assert(flockRow.lat === -28.552 && flockRow.lng === 153.504, 'Flock location saved by admin');
        assert(flockRow.location_auth_signer === adminId.pubKeyHex, 'Flock location_auth_signer recorded as admin');

        // Admin can also set location via Settings app endpoint (/api/local/admin/treasury/:treasury/location)
        const { hash: adminHash, salt } = hashPassword('correct-horse-battery-staple-1234');
        saveLocalConfig({
            ...getLocalConfig(),
            adminHash,
            salt,
        });
        const adminHttpRes = await fetch(`${BASE}/api/local/admin/treasury/${flock}/location`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-password': 'correct-horse-battery-staple-1234',
            },
            body: JSON.stringify({ lat: -28.5525, lng: 153.5045 }),
        });
        assert(adminHttpRes.ok, `Admin password endpoint successfully updates location (${adminHttpRes.status})`);
        const flockAdminRow = db.prepare('SELECT lat, lng, location_auth_signer FROM members WHERE public_key = ?').get(flock) as any;
        assert(flockAdminRow.lat === -28.5525 && flockAdminRow.lng === 153.5045, 'Flock location updated via admin endpoint');

        // ── 4. Clearing location ──
        // Stranger cannot clear location
        const strangerClear = await signedFetch('DELETE', `/api/enterprise/${shed}/location`, bobStranger);
        assert(strangerClear.status === 403, `Stranger clearing location rejected with 403 (got ${strangerClear.status})`);

        // Keeper can clear location
        const keeperClear = await signedFetch('DELETE', `/api/enterprise/${shed}/location`, aliceKeeper);
        assert(keeperClear.ok, `Keeper successfully clears enterprise location (status ${keeperClear.status})`);
        const clearedRow = db.prepare('SELECT lat, lng, location_auth_signer FROM members WHERE public_key = ?').get(shed) as any;
        assert(clearedRow.lat === null && clearedRow.lng === null, 'Enterprise location cleared to null');

        // Setting location again via POST with approximate coordinates
        const setApproxRes = await signedFetch('POST', `/api/enterprise/${shed}/location`, aliceKeeper, {
            lat: approx.lat,
            lng: approx.lng,
        });
        assert(setApproxRes.ok, 'Setting approximate location succeeded');

        // ── 5. Range CHECK enforcement ──
        // API level: invalid latitude > 90
        const outOfBoundsLat = await signedFetch('POST', `/api/enterprise/${shed}/location`, aliceKeeper, {
            lat: 91.0,
            lng: 153.50,
        });
        assert(outOfBoundsLat.status === 400, `Lat > 90 rejected by API with 400 (got ${outOfBoundsLat.status})`);

        // API level: invalid latitude < -90
        const outOfBoundsLatNeg = await signedFetch('POST', `/api/enterprise/${shed}/location`, aliceKeeper, {
            lat: -90.5,
            lng: 153.50,
        });
        assert(outOfBoundsLatNeg.status === 400, `Lat < -90 rejected by API with 400 (got ${outOfBoundsLatNeg.status})`);

        // API level: invalid longitude > 180
        const outOfBoundsLng = await signedFetch('POST', `/api/enterprise/${shed}/location`, aliceKeeper, {
            lat: -28.55,
            lng: 180.5,
        });
        assert(outOfBoundsLng.status === 400, `Lng > 180 rejected by API with 400 (got ${outOfBoundsLng.status})`);

        // API level: invalid longitude < -180
        const outOfBoundsLngNeg = await signedFetch('POST', `/api/enterprise/${shed}/location`, aliceKeeper, {
            lat: -28.55,
            lng: -180.1,
        });
        assert(outOfBoundsLngNeg.status === 400, `Lng < -180 rejected by API with 400 (got ${outOfBoundsLngNeg.status})`);

        // Database level: SQLite CHECK constraint enforcement
        let directDbCheckFailed = false;
        try {
            db.prepare('UPDATE members SET lat = 95 WHERE public_key = ?').run(shed);
        } catch (err: any) {
            directDbCheckFailed = /CHECK constraint failed/.test(err.message);
        }
        assert(directDbCheckFailed, 'Direct SQLite UPDATE with lat=95 fails CHECK constraint');

        let directDbCheckLngFailed = false;
        try {
            db.prepare('UPDATE members SET lng = 200 WHERE public_key = ?').run(shed);
        } catch (err: any) {
            directDbCheckLngFailed = /CHECK constraint failed/.test(err.message);
        }
        assert(directDbCheckLngFailed, 'Direct SQLite UPDATE with lng=200 fails CHECK constraint');

        // ── 6. Map Endpoint (/api/enterprises/map) ──
        // Check current map pins: both shed and flock have location set
        let mapRes = await fetch(`${BASE}/api/enterprises/map`);
        assert(mapRes.ok, `GET /api/enterprises/map succeeds (status ${mapRes.status})`);
        let mapData = await mapRes.json();
        const pins = mapData.enterprises as any[];
        assert(pins.some(p => p.publicKey === shed), 'Active enterprise with location appears in map endpoint');
        assert(pins.some(p => p.publicKey === flock), 'Flock appears in map endpoint');

        // Paused enterprise in map endpoint: pause the flock
        pauseEnterprise(flock, adminId.pubKeyHex);
        mapRes = await fetch(`${BASE}/api/enterprises/map`);
        mapData = await mapRes.json();
        const pausedFlockPin = mapData.enterprises.find((p: any) => p.publicKey === flock);
        assert(pausedFlockPin !== undefined, 'Paused enterprise is included in map endpoint');
        assert(pausedFlockPin.paused === true, 'Paused enterprise has paused: true on map pin');
        assert(pausedFlockPin.status === 'paused' || pausedFlockPin.status === 'active', 'Paused enterprise status returned');

        // Wound-up (completed) enterprise is EXCLUDED from map endpoint
        // Create another enterprise with location, then mark it completed
        const { publicKey: shadeHouse } = createTreasury('ShadeHouse', AVATAR, 0, {
            lat: -28.54,
            lng: 153.51,
            locationAuthSigner: adminId.pubKeyHex,
        });
        mapRes = await fetch(`${BASE}/api/enterprises/map`);
        mapData = await mapRes.json();
        assert(mapData.enterprises.some((p: any) => p.publicKey === shadeHouse), 'ShadeHouse with location initially appears in map endpoint');

        // Wind up / complete ShadeHouse
        db.prepare("UPDATE members SET status = 'completed', wind_up_finalised_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?").run(shadeHouse);

        mapRes = await fetch(`${BASE}/api/enterprises/map`);
        mapData = await mapRes.json();
        assert(!mapData.enterprises.some((p: any) => p.publicKey === shadeHouse), 'Completed enterprise is EXCLUDED from map endpoint');

        // An enterprise with no location is also excluded
        const { publicKey: noLocCoop } = createTreasury('NoLocationCoop', AVATAR, 0);
        mapRes = await fetch(`${BASE}/api/enterprises/map`);
        mapData = await mapRes.json();
        assert(!mapData.enterprises.some((p: any) => p.publicKey === noLocCoop), 'Enterprise without location is excluded from map endpoint');

        // Legacy/unspecified enterprise with NULL status and location set IS INCLUDED in map endpoint
        db.prepare("UPDATE members SET status = NULL WHERE public_key = ?").run(shed);
        mapRes = await fetch(`${BASE}/api/enterprises/map`);
        mapData = await mapRes.json();
        const nullStatusPin = mapData.enterprises.find((p: any) => p.publicKey === shed);
        assert(nullStatusPin !== undefined, 'Enterprise with NULL status and location appears in map endpoint');
        assert(nullStatusPin.status === 'active', 'Enterprise with NULL status defaults to active in map pin response');
        db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(shed);

        // ── 7. Public read transparency endpoints include location ──
        const treasuriesRes = await fetch(`${BASE}/api/treasuries`);
        assert(treasuriesRes.ok, 'GET /api/treasuries succeeds');
        const treasuriesData = await treasuriesRes.json();
        const shedInTreasuries = treasuriesData.treasuries.find((t: any) => t.publicKey === shed);
        assert(shedInTreasuries.lat === approx.lat, 'GET /api/treasuries includes lat');
        assert(shedInTreasuries.lng === approx.lng, 'GET /api/treasuries includes lng');
        assert(shedInTreasuries.locationAuthSigner === aliceKeeper.pubKeyHex, 'GET /api/treasuries includes locationAuthSigner');

        const detailRes = await fetch(`${BASE}/api/enterprise/${shed}`);
        assert(detailRes.ok, 'GET /api/enterprise/:id succeeds');
        const detailData = await detailRes.json();
        assert(detailData.lat === approx.lat, 'GET /api/enterprise/:id includes lat');
        assert(detailData.lng === approx.lng, 'GET /api/enterprise/:id includes lng');
        assert(detailData.locationAuthSigner === aliceKeeper.pubKeyHex, 'GET /api/enterprise/:id includes locationAuthSigner');

        // ── 8. PR #839 Blocker A: a wound-up enterprise's location is removed and never served ──
        const completedWithCoords = (callsign: string, lat: number, lng: number) => {
            const { publicKey } = createTreasury(callsign, AVATAR, 0, { lat, lng, locationAuthSigner: adminId.pubKeyHex });
            // A row as it exists on a live node today: wound up before this fix, coordinates still stored.
            db.prepare("UPDATE members SET status = 'completed', wind_up_finalised_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE public_key = ?").run(publicKey);
            return publicKey;
        };

        // 8a. finaliseWindUp clears the location and records the finalising actor as signer
        const { publicKey: eggs } = createTreasury('HouseEggs', AVATAR, 0, {
            lat: -28.5412,
            lng: 153.5123,
            locationAuthSigner: aliceKeeper.pubKeyHex,
        });
        const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
        db.prepare("UPDATE members SET status = 'winding_up', wind_up_initiated_at = ?, wind_up_initiated_by = ? WHERE public_key = ?")
            .run(eightDaysAgo, adminId.pubKeyHex, eggs);
        const windUp = finaliseWindUp(eggs, adminId.pubKeyHex);
        assert(windUp.status === 'completed', 'Eggs enterprise wound up');
        const eggsRow = db.prepare('SELECT lat, lng, location_auth_signer, auth_signer, location_updated_at FROM members WHERE public_key = ?').get(eggs) as any;
        assert(eggsRow.lat === null && eggsRow.lng === null, `finaliseWindUp clears lat/lng (got ${eggsRow.lat}, ${eggsRow.lng})`);
        assert(eggsRow.location_auth_signer === adminId.pubKeyHex, `finaliseWindUp records the finalising actor as location_auth_signer (got ${eggsRow.location_auth_signer})`);
        assert(eggsRow.auth_signer === adminId.pubKeyHex, `finaliseWindUp records the finalising actor as auth_signer (got ${eggsRow.auth_signer})`);
        assert(eggsRow.location_updated_at === windUp.finalisedAt, `finaliseWindUp stamps location_updated_at with the finalise time (got ${eggsRow.location_updated_at})`);

        // 8b. List and detail endpoints never return coordinates for a completed enterprise
        const servedCompleted = completedWithCoords('ServedWoundUp', -28.531, 153.521);
        for (const listPath of ['/api/treasuries', '/api/enterprises']) {
            const listRes = await fetch(`${BASE}${listPath}`);
            assert(listRes.ok, `GET ${listPath} succeeds`);
            const listData = await listRes.json();
            const rows = (listData.treasuries ?? listData.enterprises) as any[];
            const completedRow = rows.find((t: any) => t.publicKey === servedCompleted);
            assert(completedRow !== undefined, `GET ${listPath} still lists the completed enterprise`);
            assert(completedRow.lat === null && completedRow.lng === null, `GET ${listPath} omits coordinates for a completed enterprise (got ${completedRow.lat}, ${completedRow.lng})`);
            const activeRow = rows.find((t: any) => t.publicKey === shed);
            assert(activeRow.lat === approx.lat && activeRow.lng === approx.lng, `GET ${listPath} still returns coordinates for an active enterprise`);
        }
        for (const detailPath of [`/api/enterprise/${servedCompleted}`, `/api/treasury/${servedCompleted}`]) {
            const res = await fetch(`${BASE}${detailPath}`);
            assert(res.ok, `GET ${detailPath} succeeds (status ${res.status})`);
            const data = await res.json();
            assert(data.lat === null && data.lng === null, `GET ${detailPath} omits coordinates for a completed enterprise (got ${data.lat}, ${data.lng})`);
        }

        // 8c. A node admin can clear a completed enterprise's location; a stranger cannot
        const adminClearTarget = completedWithCoords('AdminClearWoundUp', -28.532, 153.522);
        const strangerClearCompleted = await signedFetch('DELETE', `/api/enterprise/${adminClearTarget}/location`, bobStranger);
        assert(strangerClearCompleted.status === 403, `Stranger clearing a completed enterprise's location rejected with 403 (got ${strangerClearCompleted.status})`);
        const strangerUntouched = db.prepare('SELECT lat, lng FROM members WHERE public_key = ?').get(adminClearTarget) as any;
        assert(strangerUntouched.lat === -28.532, 'Stranger attempt left the completed row unchanged');

        const adminClearCompleted = await signedFetch('DELETE', `/api/enterprise/${adminClearTarget}/location`, adminId);
        assert(adminClearCompleted.ok, `Admin clears a completed enterprise's location via the signed route (status ${adminClearCompleted.status})`);
        const adminClearedRow = db.prepare('SELECT lat, lng, location_auth_signer FROM members WHERE public_key = ?').get(adminClearTarget) as any;
        assert(adminClearedRow.lat === null && adminClearedRow.lng === null, 'Completed enterprise location cleared by admin (signed route)');
        assert(adminClearedRow.location_auth_signer === adminId.pubKeyHex, 'Admin recorded as signer of the completed-enterprise clear');

        const adminAppClearTarget = completedWithCoords('SettingsClearWoundUp', -28.533, 153.523);
        const adminAppClear = await fetch(`${BASE}/api/local/admin/treasury/${adminAppClearTarget}/location`, {
            method: 'DELETE',
            headers: { 'x-admin-password': 'correct-horse-battery-staple-1234' },
        });
        assert(adminAppClear.ok, `Admin clears a completed enterprise's location via the Settings app route (status ${adminAppClear.status})`);
        const adminAppClearedRow = db.prepare('SELECT lat, lng FROM members WHERE public_key = ?').get(adminAppClearTarget) as any;
        assert(adminAppClearedRow.lat === null && adminAppClearedRow.lng === null, 'Completed enterprise location cleared by admin (Settings app route)');

        // Setting (not clearing) a location on a completed enterprise stays refused, even for an admin
        const adminSetCompleted = await signedFetch('POST', `/api/enterprise/${adminClearTarget}/location`, adminId, { lat: -28.5, lng: 153.5 });
        assert(adminSetCompleted.status === 403 || adminSetCompleted.status === 400, `Admin cannot SET a location on a completed enterprise (got ${adminSetCompleted.status})`);

        // 8d. Migration clears coordinates already stored on completed enterprises; active ones untouched
        const migrateTarget = completedWithCoords('MigrateWoundUp', -28.534, 153.524);
        const activeBefore = db.prepare('SELECT lat, lng, location_auth_signer, location_updated_at FROM members WHERE public_key = ?').get(shed) as any;
        assert(activeBefore.lat !== null, 'Active enterprise has coordinates before the migration');
        initSchema();
        const migratedRow = db.prepare('SELECT lat, lng FROM members WHERE public_key = ?').get(migrateTarget) as any;
        assert(migratedRow.lat === null && migratedRow.lng === null, `Migration clears coordinates on a pre-existing completed enterprise (got ${migratedRow.lat}, ${migratedRow.lng})`);
        const activeAfter = db.prepare('SELECT lat, lng, location_auth_signer, location_updated_at FROM members WHERE public_key = ?').get(shed) as any;
        assert(JSON.stringify(activeAfter) === JSON.stringify(activeBefore), 'Migration leaves an active enterprise’s location untouched');
        initSchema();
        const migratedTwice = db.prepare('SELECT lat, lng FROM members WHERE public_key = ?').get(migrateTarget) as any;
        assert(migratedTwice.lat === null && migratedTwice.lng === null, 'Migration is idempotent (second boot is a no-op)');

        console.log(`\nAll ${passed}/${run} enterprise location tests passed!`);
    } finally {
        // done
    }
}

main().then(() => {
    process.exit(0);
}).catch((err) => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
