/**
 * Integration & unit test coverage for engine/member-area.ts.
 */
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import {
    isPoint,
    readMemberArea,
    setMemberArea,
    nearestPeople,
    withAreaDistances,
    importedArea,
    memberAreaFor,
    refreshMemberAreas,
} from './engine/member-area.js';

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

async function main() {
    console.log('Running member-area tests...\n');

    // 1. Unit test: isPoint
    assert(isPoint(0, 0), 'isPoint(0, 0) is true');
    assert(isPoint(-90, 180), 'isPoint(-90, 180) is true');
    assert(isPoint(90, -180), 'isPoint(90, -180) is true');
    assert(!isPoint(90.1, 0), 'isPoint(90.1, 0) is false (lat out of bounds)');
    assert(!isPoint(0, 180.1), 'isPoint(0, 180.1) is false (lng out of bounds)');
    assert(!isPoint('0', 0), 'isPoint with string lat is false');
    assert(!isPoint(NaN, 0), 'isPoint with NaN is false');

    // 2. Unit test: importedArea
    assert(
        JSON.stringify(importedArea({ areaLat: 12.34, areaLng: 56.78, areaUpdatedAt: '2026-01-01T00:00:00Z' })) ===
            JSON.stringify([12.3, 56.8, '2026-01-01T00:00:00Z']),
        'importedArea rounds lat and lng to 0.1° and keeps ISO timestamp'
    );
    assert(
        JSON.stringify(importedArea({ areaLat: 'invalid', areaLng: 56.78 })) === JSON.stringify([null, null, null]),
        'importedArea returns nulls for invalid input'
    );

    // 3. Integration setup with isolated DB
    initStateEngine();

    const aliceKey = '1111111111111111111111111111111111111111111111111111111111111111';
    const bobKey = '2222222222222222222222222222222222222222222222222222222222222222';
    const charlieKey = '3333333333333333333333333333333333333333333333333333333333333333';

    seedGenesisMember(aliceKey, 'Alice');
    seedGenesisMember(bobKey, 'Bob');
    seedGenesisMember(charlieKey, 'Charlie');

    // Initially none of them have an area set
    assert(readMemberArea(aliceKey) === null, 'Alice has no initial area');

    // 4. setMemberArea & readMemberArea
    const aliceArea1 = setMemberArea(aliceKey, { lat: 37.7749, lng: -122.4194 });
    assert(aliceArea1 !== null && aliceArea1.lat === 37.8 && aliceArea1.lng === -122.4, 'setMemberArea rounds coordinates to 0.1°');

    const aliceRead = readMemberArea(aliceKey);
    assert(aliceRead !== null && aliceRead.lat === 37.8 && aliceRead.lng === -122.4, 'readMemberArea reads back set area');

    // Setting same area again is idempotent
    const aliceArea2 = setMemberArea(aliceKey, { lat: 37.78, lng: -122.42 }); // rounds to same 37.8, -122.4
    assert(aliceArea2?.updatedAt === aliceArea1?.updatedAt, 'Setting same area again does not update updatedAt');

    // Set Bob's area further away from Alice
    setMemberArea(bobKey, { lat: 37.85, lng: -122.45 }); // rounds to 37.9, -122.5

    // Charlie has no area set

    // 5. memberAreaFor & refreshMemberAreas
    assert(memberAreaFor(aliceKey)?.lat === 37.8, 'memberAreaFor returns cached Alice area');
    assert(memberAreaFor(charlieKey) === undefined, 'memberAreaFor returns undefined for member with no area');

    // 6. withAreaDistances
    const people = [
        { publicKey: charlieKey, name: 'Charlie' },
        { publicKey: bobKey, name: 'Bob' },
        { publicKey: aliceKey, name: 'Alice' },
    ];

    // Reference point near Alice (37.8, -122.4)
    const withDistances = withAreaDistances(people, 37.8, -122.4);
    assert(withDistances[0].publicKey === aliceKey && withDistances[0].distanceKm === 0, 'Alice is nearest (0 km)');
    assert(withDistances[1].publicKey === bobKey && typeof withDistances[1].distanceKm === 'number' && withDistances[1].distanceKm > 0, 'Bob is second nearest');
    assert(withDistances[2].publicKey === charlieKey && withDistances[2].distanceKm === null, 'Charlie has no area and is listed last');

    // 7. nearestPeople
    const nearest2 = nearestPeople(37.8, -122.4, 2);
    assert(nearest2.length === 2, 'nearestPeople returns requested count');
    assert(nearest2[0].publicKey === aliceKey && nearest2[0].distanceKm === 0, 'nearestPeople finds Alice as closest');
    assert(nearest2[1].publicKey === bobKey && typeof nearest2[1].distanceKm === 'number', 'nearestPeople finds Bob as second');

    const nearest4 = nearestPeople(37.8, -122.4, 4);
    assert(nearest4.length === 4, 'nearestPeople returns requested count including unplaced members');
    assert(nearest4.some(p => p.publicKey === charlieKey && p.distanceKm === null), 'nearestPeople includes unplaced member Charlie');

    // 8. Clearing area
    const aliceCleared = setMemberArea(aliceKey, null);
    assert(aliceCleared === null, 'setMemberArea(null) returns null');
    assert(readMemberArea(aliceKey) === null, 'readMemberArea returns null after clear');
    assert(memberAreaFor(aliceKey) === undefined, 'memberAreaFor updated after clear');

    // Manual refresh check
    refreshMemberAreas([aliceKey]);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    console.log('COUNT_LINE: ' + `${passed}/${run} checks passed.`);
    console.log('⭐️ member-area tests PASSED.');
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error('❌ Test failed:', e);
        process.exit(1);
    });
