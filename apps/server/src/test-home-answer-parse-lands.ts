/**
 * Unit integration test for parseLands helper in routes/home-answer.ts.
 * Verifies parsing of query parameters for Home landings (lands=).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-home-answer-parse-lands.ts
 */

import { parseLands } from './routes/home-answer.js';

let count = 0;
function assert(cond: boolean, msg: string): void {
    count++;
    if (cond) {
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        process.exit(1);
    }
}

function setToArray(set: ReadonlySet<string>): string[] {
    return Array.from(set).sort();
}

function main() {
    console.log('=== parseLands helper tests ===');

    // 1. undefined / null / non-string inputs return empty set
    assert(setToArray(parseLands(undefined)).length === 0, 'undefined returns empty set');
    assert(setToArray(parseLands(null)).length === 0, 'null returns empty set');
    assert(setToArray(parseLands(123)).length === 0, 'number returns empty set');
    assert(setToArray(parseLands({})).length === 0, 'object returns empty set');

    // 2. valid single land string
    const singleEnterprise = parseLands('enterprise');
    assert(singleEnterprise.has('enterprise') && singleEnterprise.size === 1, 'single valid landing "enterprise" parsed');

    const singleGroup = parseLands('group');
    assert(singleGroup.has('group') && singleGroup.size === 1, 'single valid landing "group" parsed');

    // 3. comma-separated string
    const commaSeparated = parseLands('enterprise, group');
    assert(
        commaSeparated.has('enterprise') && commaSeparated.has('group') && commaSeparated.size === 2,
        'comma-separated landing list with whitespace parsed correctly'
    );

    // 4. array input (e.g. repeated query parameter ?lands=enterprise&lands=group)
    const arrayInput = parseLands(['enterprise', 'group']);
    assert(
        arrayInput.has('enterprise') && arrayInput.has('group') && arrayInput.size === 2,
        'array input parsed correctly'
    );

    // 5. unknown landings dropped
    const unknownInput = parseLands('enterprise, unknown_landing, invalid, group');
    assert(
        unknownInput.has('enterprise') && unknownInput.has('group') && unknownInput.size === 2,
        'unknown landings are silently dropped'
    );

    // 6. duplicate landings deduped
    const duplicates = parseLands(['enterprise, enterprise', 'group', 'group']);
    assert(
        duplicates.has('enterprise') && duplicates.has('group') && duplicates.size === 2,
        'duplicate landings are deduplicated'
    );

    console.log(`\nAll ${count} parseLands checks passed successfully.`);
    process.exit(0);
}

main();
