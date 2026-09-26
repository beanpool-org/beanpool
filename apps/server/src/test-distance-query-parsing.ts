/**
 * Unit/integration tests for distance query parsing (parsePoint & parseDistanceQuery).
 *
 * Ensures proper validation and error messages for lat, lng, radiusKm, and sort
 * query parameters according to the G4 global listings spec.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-distance-query-parsing.ts
 */
import { parsePoint, parseDistanceQuery } from './routes/distance-query.js';
import { MAX_RADIUS_KM } from '@beanpool/engine';

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

function main() {
    console.log('Running distance query parsing tests...\n');

    // ── 1. parsePoint tests ──────────────────────────────────────────────────

    // Valid coordinates
    const pValid = parsePoint({ lat: '37.7749', lng: '-122.4194' });
    assert(pValid.ok && pValid.value?.lat === 37.7749 && pValid.value?.lng === -122.4194, 'parsePoint accepts valid lat/lng decimal strings');

    // Scientific notation / exponent notation
    const pExponent = parsePoint({ lat: '1e-7', lng: '-2.5e1' });
    assert(pExponent.ok && pExponent.value?.lat === 1e-7 && pExponent.value?.lng === -25, 'parsePoint accepts exponent formatting');

    // Absence of point parameters
    const pEmpty = parsePoint({});
    assert(pEmpty.ok && pEmpty.value === null, 'parsePoint returns null when both lat and lng are absent');

    // Missing one coordinate
    const pMissingLng = parsePoint({ lat: '37.7749' });
    assert(!pMissingLng.ok && pMissingLng.error === 'lat and lng go together: give both, or neither.', 'parsePoint fails when lng is missing');

    const pMissingLat = parsePoint({ lng: '-122.4194' });
    assert(!pMissingLat.ok && pMissingLat.error === 'lat and lng go together: give both, or neither.', 'parsePoint fails when lat is missing');

    // Out of bounds coordinates
    const pLatHigh = parsePoint({ lat: '90.0001', lng: '0' });
    assert(!pLatHigh.ok && pLatHigh.error === 'lat must be between -90 and 90.', 'parsePoint rejects lat > 90');

    const pLatLow = parsePoint({ lat: '-90.1', lng: '0' });
    assert(!pLatLow.ok && pLatLow.error === 'lat must be between -90 and 90.', 'parsePoint rejects lat < -90');

    const pLngHigh = parsePoint({ lat: '0', lng: '180.0001' });
    assert(!pLngHigh.ok && pLngHigh.error === 'lng must be between -180 and 180.', 'parsePoint rejects lng > 180');

    const pLngLow = parsePoint({ lat: '0', lng: '-180.1' });
    assert(!pLngLow.ok && pLngLow.error === 'lng must be between -180 and 180.', 'parsePoint rejects lng < -180');

    // Invalid non-numeric or malformed numbers
    const pNaN = parsePoint({ lat: 'NaN', lng: '0' });
    assert(!pNaN.ok && pNaN.error.includes('lat must be a number'), 'parsePoint rejects NaN string');

    const pHex = parsePoint({ lat: '0x10', lng: '0' });
    assert(!pHex.ok && pHex.error.includes('lat must be a number'), 'parsePoint rejects hex format');

    const pDuplicate = parsePoint({ lat: ['10', '20'] as any, lng: '0' });
    assert(!pDuplicate.ok && pDuplicate.error === 'lat is given more than once.', 'parsePoint rejects duplicate lat parameter array');

    // ── 2. parseDistanceQuery tests ──────────────────────────────────────────

    // Valid distance query with point, radius, and sort
    const dqValid = parseDistanceQuery({ lat: '51.5074', lng: '-0.1278', radiusKm: '25', sort: 'distance' });
    assert(
        dqValid.ok &&
        dqValid.value.point?.lat === 51.5074 &&
        dqValid.value.point?.lng === -0.1278 &&
        dqValid.value.radiusKm === 25 &&
        dqValid.value.sort === 'distance',
        'parseDistanceQuery accepts valid point, radiusKm, and sort'
    );

    // sort=recent with point
    const dqRecent = parseDistanceQuery({ lat: '10', lng: '10', sort: 'recent' });
    assert(dqRecent.ok && dqRecent.value.sort === 'recent', 'parseDistanceQuery accepts sort=recent with point');

    // sort=recent without point
    const dqRecentNoPoint = parseDistanceQuery({ sort: 'recent' });
    assert(dqRecentNoPoint.ok && dqRecentNoPoint.value.sort === 'recent' && dqRecentNoPoint.value.point === null, 'parseDistanceQuery accepts sort=recent without point');

    // sort=distance without point
    const dqDistanceNoPoint = parseDistanceQuery({ sort: 'distance' });
    assert(!dqDistanceNoPoint.ok && dqDistanceNoPoint.error === 'sort=distance needs a point to measure from: give lat and lng too.', 'parseDistanceQuery rejects sort=distance without point');

    // Invalid sort value
    const dqBadSort = parseDistanceQuery({ sort: 'popular' });
    assert(!dqBadSort.ok && dqBadSort.error === 'sort must be distance or recent.', 'parseDistanceQuery rejects invalid sort value');

    // radiusKm without point
    const dqRadiusNoPoint = parseDistanceQuery({ radiusKm: '50' });
    assert(!dqRadiusNoPoint.ok && dqRadiusNoPoint.error === 'radiusKm needs a point to measure from: give lat and lng too.', 'parseDistanceQuery rejects radiusKm without point');

    // radiusKm invalid bounds
    const dqRadiusZero = parseDistanceQuery({ lat: '0', lng: '0', radiusKm: '0' });
    assert(!dqRadiusZero.ok && dqRadiusZero.error.includes('radiusKm must be more than 0'), 'parseDistanceQuery rejects radiusKm <= 0');

    const dqRadiusHuge = parseDistanceQuery({ lat: '0', lng: '0', radiusKm: String(MAX_RADIUS_KM + 1) });
    assert(!dqRadiusHuge.ok && dqRadiusHuge.error.includes(`at most ${MAX_RADIUS_KM}`), 'parseDistanceQuery rejects radiusKm > MAX_RADIUS_KM');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main();
