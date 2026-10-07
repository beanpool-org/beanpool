/**
 * Test coverage for engine/enterprise-text.ts (#1493):
 * Enforces text character limits on enterprise/crowdfund names and purposes.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm --filter @beanpool/server exec tsx src/test-enterprise-text.ts
 */

import { ENTERPRISE_NAME_LIMIT, ENTERPRISE_PURPOSE_LIMIT } from '@beanpool/core';
import {
    assertEnterpriseText,
    ENTERPRISE_NAME_TOO_LONG,
    ENTERPRISE_PURPOSE_TOO_LONG,
} from './engine/enterprise-text.js';

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

function testEnterpriseTextValidation(): void {
    console.log('\n— 1. Valid names and purposes —');

    // Valid inputs do not throw
    let threw = false;
    try {
        assertEnterpriseText('Acme Corp', 'A sustainable community coop.');
    } catch {
        threw = true;
    }
    assert(!threw, 'valid name and purpose are accepted');

    // Edge cases: exact boundary lengths
    const exactName = 'a'.repeat(ENTERPRISE_NAME_LIMIT.chars);
    const exactPurpose = 'b'.repeat(ENTERPRISE_PURPOSE_LIMIT.chars);
    threw = false;
    try {
        assertEnterpriseText(exactName, exactPurpose);
    } catch {
        threw = true;
    }
    assert(!threw, `exact boundary lengths (${ENTERPRISE_NAME_LIMIT.chars} and ${ENTERPRISE_PURPOSE_LIMIT.chars} chars) are accepted`);

    // Non-string or undefined inputs are ignored by assertEnterpriseText
    threw = false;
    try {
        assertEnterpriseText(null, undefined);
        assertEnterpriseText(123, true);
    } catch {
        threw = true;
    }
    assert(!threw, 'non-string inputs are safely ignored');

    console.log('\n— 2. Name over limit —');

    const longName = 'a'.repeat(ENTERPRISE_NAME_LIMIT.chars + 1);
    let errorMsg = '';
    try {
        assertEnterpriseText(longName, 'Valid purpose');
    } catch (err: any) {
        errorMsg = err.message;
    }
    assert(errorMsg === ENTERPRISE_NAME_TOO_LONG, 'throws ENTERPRISE_NAME_TOO_LONG when name exceeds limit');

    // Trimming whitespace before checking limit
    const paddedLongName = `  ${'a'.repeat(ENTERPRISE_NAME_LIMIT.chars + 1)}  `;
    errorMsg = '';
    try {
        assertEnterpriseText(paddedLongName, 'Valid purpose');
    } catch (err: any) {
        errorMsg = err.message;
    }
    assert(errorMsg === ENTERPRISE_NAME_TOO_LONG, 'trims name before checking character limit');

    console.log('\n— 3. Purpose over limit —');

    const longPurpose = 'b'.repeat(ENTERPRISE_PURPOSE_LIMIT.chars + 1);
    errorMsg = '';
    try {
        assertEnterpriseText('Valid Name', longPurpose);
    } catch (err: any) {
        errorMsg = err.message;
    }
    assert(errorMsg === ENTERPRISE_PURPOSE_TOO_LONG, 'throws ENTERPRISE_PURPOSE_TOO_LONG when purpose exceeds limit');

    console.log('\n— 4. Stored legacy/unchanged text —');

    // Unchanged stored text is accepted even if it exceeds current limits
    threw = false;
    try {
        assertEnterpriseText(longName, longPurpose, { name: longName, purpose: longPurpose });
    } catch {
        threw = true;
    }
    assert(!threw, 'unchanged stored name and purpose are exempt from new length limits');

    // If only purpose is stored/unchanged, a modified long name is still rejected
    errorMsg = '';
    try {
        assertEnterpriseText(longName, longPurpose, { purpose: longPurpose });
    } catch (err: any) {
        errorMsg = err.message;
    }
    assert(errorMsg === ENTERPRISE_NAME_TOO_LONG, 'modified long name is rejected even if purpose is unchanged stored text');
}

function main(): void {
    console.log('=== Testing engine/enterprise-text.ts ===');
    testEnterpriseTextValidation();

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
}

main();
