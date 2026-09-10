/**
 * Version resolution test suite (#version-resolution)
 *
 * Tests apps/server/src/version.ts getVersion() logic:
 * - Default resolution from workspace root package.json
 * - Caching behavior across multiple invocations
 * - Environment variable override (APP_VERSION)
 *
 * Run with:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-version-resolution.ts
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getVersion } from './version.js';

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
    console.log('Running version resolution test suite...\n');

    // 1. Default resolution (no APP_VERSION set)
    delete process.env.APP_VERSION;
    const version1 = getVersion();
    assert(typeof version1 === 'string' && version1.length > 0, `1a. getVersion() returns a non-empty string ("${version1}")`);
    assert(/^\d+\.\d+\.\d+/.test(version1), `1b. getVersion() returns a valid semver version string ("${version1}")`);

    // 2. Caching behavior - subsequent calls return the exact same cached value
    const version2 = getVersion();
    assert(version1 === version2, `2. Subsequent call returns cached version ("${version2}")`);

    // 3. Environment variable override via child process execution
    const serverDir = path.dirname(fileURLToPath(import.meta.url));
    const versionPath = path.join(serverDir, 'version.ts');
    const code = `import { getVersion } from '${versionPath}'; console.log(getVersion());`;
    const envOutput = execSync(`pnpm exec tsx --eval "${code}"`, {
        cwd: serverDir,
        env: { ...process.env, APP_VERSION: '9.9.9-test' },
        encoding: 'utf-8',
    }).trim();

    assert(envOutput === '9.9.9-test', `3. APP_VERSION environment variable takes precedence ("${envOutput}")`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    console.log('⭐️ Version resolution test suite completed successfully.');
}

main().catch((e) => {
    console.error('\n❌ Test failed:', e);
    process.exit(1);
});
