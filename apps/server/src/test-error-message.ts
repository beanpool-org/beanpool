/**
 * Unit test suite for apps/server/src/error-message.ts
 *
 * Verifies that errorMessage(e, fallback) safely extracts human-readable error messages
 * across all potential types of thrown or caught values without throwing secondary exceptions.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-error-message.ts
 */

import { errorMessage } from './error-message.js';

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

function main(): void {
    console.log('=== Testing error-message.ts ===\n');

    // 1. Standard Error instances and custom Error subclasses
    assert(errorMessage(new Error('Connection failed')) === 'Connection failed', 'extracts message from standard Error');
    assert(errorMessage(new TypeError('Invalid type')) === 'Invalid type', 'extracts message from TypeError');

    class CustomError extends Error {
        constructor(msg: string) {
            super(msg);
            this.name = 'CustomError';
        }
    }
    assert(errorMessage(new CustomError('Custom exception')) === 'Custom exception', 'extracts message from custom Error subclass');

    // 2. Plain objects with a .message property
    assert(errorMessage({ message: 'Object error message' }) === 'Object error message', 'extracts message from object with .message property');

    // 3. Bare strings and empty strings
    assert(errorMessage('Server timeout') === 'Server timeout', 'extracts bare string value');
    assert(errorMessage('') === 'Unknown error', 'falls back for empty string message');
    assert(errorMessage('', 'Custom fallback') === 'Custom fallback', 'uses custom fallback for empty string message');
    assert(errorMessage({ message: '' }) === 'Unknown error', 'falls back when .message is empty string');

    // 4. Primitive non-string values
    assert(errorMessage(404) === '404', 'converts number to string');
    assert(errorMessage(0) === '0', 'converts zero to string');
    assert(errorMessage(true) === 'true', 'converts boolean true to string');
    assert(errorMessage(false) === 'false', 'converts boolean false to string');
    assert(errorMessage(BigInt(9007199254740991)) === '9007199254740991', 'converts BigInt to string');

    // 5. Null, undefined, and objects with null/undefined message
    assert(errorMessage(null) === 'Unknown error', 'falls back for null input');
    assert(errorMessage(undefined) === 'Unknown error', 'falls back for undefined input');
    assert(errorMessage(null, 'Fallback msg') === 'Fallback msg', 'uses custom fallback for null input');
    assert(errorMessage(undefined, 'Fallback msg') === 'Fallback msg', 'uses custom fallback for undefined input');
    assert(errorMessage({ message: null }) === '[object Object]', 'converts object to string when .message is null');
    assert(errorMessage({ message: undefined }) === '[object Object]', 'converts object to string when .message is undefined');

    // 6. Objects with non-string .message properties
    assert(errorMessage({ message: 500 }) === '500', 'converts numeric .message to string');
    assert(errorMessage({ message: { inner: 'detail' } }) === '[object Object]', 'converts object .message via String()');

    // 7. Objects with throwing getters on .message
    const throwingGetterObj = {
        get message(): string {
            throw new Error('Getter error');
        },
    };
    assert(errorMessage(throwingGetterObj) === 'Unknown error', 'catches error thrown by .message getter and returns fallback');
    assert(errorMessage(throwingGetterObj, 'Safe fallback') === 'Safe fallback', 'catches getter error and returns custom fallback');

    // 8. Objects with throwing toString or Symbol.toPrimitive
    const throwingToStringObj = {
        toString(): string {
            throw new Error('toString error');
        },
    };
    assert(errorMessage(throwingToStringObj) === 'Unknown error', 'catches error thrown by toString() and returns fallback');

    const throwingToPrimitiveObj = {
        [Symbol.toPrimitive](): string {
            throw new Error('toPrimitive error');
        },
    };
    assert(errorMessage(throwingToPrimitiveObj) === 'Unknown error', 'catches error thrown by Symbol.toPrimitive and returns fallback');

    // 9. Null-prototype objects (Object.create(null))
    const nullProtoObj = Object.create(null);
    nullProtoObj.message = 'Null proto error';
    assert(errorMessage(nullProtoObj) === 'Null proto error', 'extracts message from null-prototype object with .message');

    const nullProtoNoMsgObj = Object.create(null);
    assert(errorMessage(nullProtoNoMsgObj) === 'Unknown error', 'safely handles null-prototype object without .message');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        console.error(`✗ ${run - passed} check(s) failed`);
        process.exit(1);
    }
    console.log('⭐️ error-message checks PASSED.');
    process.exit(0);
}

main();
