/**
 * Unit/integration tests for event zone utilities (apps/server/src/engine/event-zone.ts).
 *
 * Tests zoneOfPin lookup, describeZone formatting, offsetZones generation, and acceptedZones caching.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-event-zone.ts
 */

import { zoneOfPin, describeZone, offsetZones, acceptedZones } from './engine/event-zone.js';

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        process.exitCode = 1;
    }
}

function main() {
    console.log('Running event-zone tests...\n');

    // 1. zoneOfPin tests
    // Valid coordinates
    assert(zoneOfPin(51.5074, -0.1278) === 'Europe/London', 'London coordinates resolve to Europe/London');
    assert(zoneOfPin(40.7128, -74.0060) === 'America/New_York', 'New York coordinates resolve to America/New_York');
    assert(zoneOfPin(35.6762, 139.6503) === 'Asia/Tokyo', 'Tokyo coordinates resolve to Asia/Tokyo');

    // Ocean locations
    const oceanGmt0 = zoneOfPin(0, 0);
    assert(oceanGmt0 === 'UTC', 'Ocean coordinates at prime meridian resolve to UTC');
    const oceanWest = zoneOfPin(0, -30);
    assert(typeof oceanWest === 'string' && oceanWest.startsWith('Etc/GMT'), 'Ocean coordinates further west resolve to an Etc/GMT zone');

    // Boundary conditions and invalid inputs
    assert(zoneOfPin(91, 0) === null, 'latitude > 90 returns null');
    assert(zoneOfPin(-91, 0) === null, 'latitude < -90 returns null');
    assert(zoneOfPin(0, 181) === null, 'longitude > 180 returns null');
    assert(zoneOfPin(0, -181) === null, 'longitude < -180 returns null');
    assert(zoneOfPin(NaN, 0) === null, 'NaN latitude returns null');
    assert(zoneOfPin(0, Infinity) === null, 'Infinity longitude returns null');
    assert(zoneOfPin('51.5074' as any, -0.1278) === null, 'string latitude returns null');
    assert(zoneOfPin(null, -0.1278) === null, 'null latitude returns null');
    assert(zoneOfPin(undefined, -0.1278) === null, 'undefined latitude returns null');

    // 2. describeZone tests
    const now = 1700000000000; // Fixed timestamp for deterministic testing
    const desc = describeZone('Europe/London', now);
    assert(desc.tz === 'Europe/London', 'describeZone returns correct tz');
    assert(typeof desc.label === 'string' && desc.label.length > 0, 'describeZone returns a non-empty label');
    assert(typeof desc.offsetMinutes === 'number', 'describeZone returns numeric offsetMinutes');

    // 3. offsetZones tests
    const offsets = offsetZones();
    assert(Array.isArray(offsets), 'offsetZones returns an array');
    assert(offsets.includes('UTC'), 'offsetZones includes UTC');
    assert(offsets.includes('Etc/GMT-14'), 'offsetZones includes Etc/GMT-14');
    assert(offsets.includes('Etc/GMT+12'), 'offsetZones includes Etc/GMT+12');
    assert(!offsets.includes('Etc/GMT0'), 'offsetZones excludes Etc/GMT0');
    assert(offsets.length === 27, 'offsetZones has exactly 27 zones (1 UTC + 14 negative + 12 positive)');

    // 4. acceptedZones tests and caching
    const time1 = 1700000000000;
    const res1 = acceptedZones(time1);
    assert(Array.isArray(res1.zones) && res1.zones.length > 0, 'acceptedZones returns a non-empty zones array');
    assert(typeof res1.etag === 'string' && res1.etag.startsWith('"zones-'), 'acceptedZones returns a properly formatted etag');
    assert(res1.zones.some(z => z.tz === 'UTC'), 'acceptedZones includes UTC');
    assert(res1.zones.some(z => z.tz === 'Europe/London'), 'acceptedZones includes Europe/London');

    // Caching check within 1 hour
    const res2 = acceptedZones(time1 + 1800 * 1000); // 30 minutes later
    assert(res1 === res2, 'acceptedZones caches result within 1 hour');

    // Cache invalidation check after 1 hour
    const res3 = acceptedZones(time1 + 3601 * 1000); // 1 hour 1 second later
    assert(res1 !== res3, 'acceptedZones recalculates result after 1 hour');

    console.log(`\n${passed}/${run} checks passed.`);
    process.exit(process.exitCode ?? 0);
}

main();
