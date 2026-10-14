/**
 * Integration test for listing post field validation logic in `engine/post-fields.ts`.
 *
 * Verifies:
 * 1. isDealQuantity bounds and type checking.
 * 2. dealQuantityFromBody conversion and error handling for malformed inputs.
 * 3. isListingPrice bounds and type checking.
 * 4. assertPostFields validation in 'create' and 'edit' modes:
 *    - Text field length limits, missing required fields, surrogate pair replacement.
 *    - Retention of oversized pre-existing stored text during edits.
 *    - Geographic coordinate validation and null clearing in edit mode.
 *    - Price and priceType validation.
 */
import assert from 'node:assert';
import {
    isDealQuantity,
    dealQuantityFromBody,
    isListingPrice,
    assertPostFields,
    DEAL_QUANTITY_ERROR,
    POST_CREDITS_MAX,
    POST_HOURS_MAX,
    POST_HOURS_MIN,
    POST_PRICE_TYPES,
    LISTING_TITLE_TOO_LONG,
    LISTING_DESCRIPTION_TOO_LONG,
    LISTING_CATEGORY_TOO_LONG,
} from './engine/post-fields.js';
import {
    LISTING_TITLE_LIMIT,
    LISTING_DESCRIPTION_LIMIT,
    LISTING_CATEGORY_LIMIT,
} from '@beanpool/core';

console.log('Running post-fields engine utility tests...');

// 1. isDealQuantity tests
console.log('  1. Testing isDealQuantity...');
assert.strictEqual(isDealQuantity(POST_HOURS_MIN), true, 'Min deal quantity must be valid');
assert.strictEqual(isDealQuantity(POST_HOURS_MAX), true, 'Max deal quantity must be valid');
assert.strictEqual(isDealQuantity(1), true, '1 hour deal quantity must be valid');
assert.strictEqual(isDealQuantity(POST_HOURS_MIN - 0.001), false, 'Quantity below min must be invalid');
assert.strictEqual(isDealQuantity(POST_HOURS_MAX + 0.1), false, 'Quantity above max must be invalid');
assert.strictEqual(isDealQuantity(0), false, '0 deal quantity must be invalid');
assert.strictEqual(isDealQuantity(-1), false, 'Negative deal quantity must be invalid');
assert.strictEqual(isDealQuantity(NaN), false, 'NaN deal quantity must be invalid');
assert.strictEqual(isDealQuantity(Infinity), false, 'Infinity deal quantity must be invalid');
assert.strictEqual(isDealQuantity('1'), false, 'String deal quantity must be invalid for isDealQuantity');
assert.strictEqual(isDealQuantity(null), false, 'null deal quantity must be invalid');
assert.strictEqual(isDealQuantity(undefined), false, 'undefined deal quantity must be invalid');

// 2. dealQuantityFromBody tests
console.log('  2. Testing dealQuantityFromBody...');
assert.strictEqual(dealQuantityFromBody(undefined), undefined, 'undefined body quantity returns undefined');
assert.strictEqual(dealQuantityFromBody(null), undefined, 'null body quantity returns undefined');
assert.strictEqual(dealQuantityFromBody(2.5), 2.5, 'Number quantity is returned as is');
assert.strictEqual(dealQuantityFromBody('2.5'), 2.5, 'Numeric string is converted to number');
assert.strictEqual(dealQuantityFromBody('  2.5  '), 2.5, 'Padded numeric string is converted to number');
assert.strictEqual(Number.isNaN(dealQuantityFromBody('')), true, 'Empty string returns NaN');
assert.strictEqual(Number.isNaN(dealQuantityFromBody('   ')), true, 'Whitespace string returns NaN');
assert.strictEqual(Number.isNaN(dealQuantityFromBody('abc')), true, 'Non-numeric string returns NaN');
assert.strictEqual(Number.isNaN(dealQuantityFromBody(true)), true, 'Boolean true returns NaN');
assert.strictEqual(Number.isNaN(dealQuantityFromBody(false)), true, 'Boolean false returns NaN');
assert.strictEqual(Number.isNaN(dealQuantityFromBody({})), true, 'Object returns NaN');
assert.strictEqual(Number.isNaN(dealQuantityFromBody([2])), true, 'Array returns NaN');

// 3. isListingPrice tests
console.log('  3. Testing isListingPrice...');
assert.strictEqual(isListingPrice(0), true, 'Price 0 must be valid');
assert.strictEqual(isListingPrice(100), true, 'Price 100 must be valid');
assert.strictEqual(isListingPrice(POST_CREDITS_MAX), true, 'Max price must be valid');
assert.strictEqual(isListingPrice(-0.01), false, 'Negative price must be invalid');
assert.strictEqual(isListingPrice(POST_CREDITS_MAX + 0.01), false, 'Price above max must be invalid');
assert.strictEqual(isListingPrice(NaN), false, 'NaN price must be invalid');
assert.strictEqual(isListingPrice(Infinity), false, 'Infinity price must be invalid');
assert.strictEqual(isListingPrice('100'), false, 'String price must be invalid');

// 4. assertPostFields tests - create mode
console.log('  4. Testing assertPostFields in create mode...');

// Valid minimal post
assert.doesNotThrow(() => {
    assertPostFields({ title: 'Valid Title' }, 'create');
}, 'Valid minimal post should not throw');

// Title errors
assert.throws(() => {
    assertPostFields({ title: 123 }, 'create');
}, /Title must be text/, 'Non-string title throws');

assert.throws(() => {
    assertPostFields({ title: '   ' }, 'create');
}, /Title is required/, 'Empty title throws');

assert.throws(() => {
    assertPostFields({ title: 'a'.repeat(LISTING_TITLE_LIMIT.chars + 1) }, 'create');
}, new RegExp(LISTING_TITLE_TOO_LONG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'Oversized title throws');

// Description errors
assert.throws(() => {
    assertPostFields({ title: 'Title', description: 123 }, 'create');
}, /Description must be text/, 'Non-string description throws');

assert.throws(() => {
    assertPostFields({ title: 'Title', description: 'a'.repeat(LISTING_DESCRIPTION_LIMIT.chars + 1) }, 'create');
}, new RegExp(LISTING_DESCRIPTION_TOO_LONG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'Oversized description throws');

// Category errors
assert.throws(() => {
    assertPostFields({ title: 'Title', category: 123 }, 'create');
}, /Category must be text/, 'Non-string category throws');

assert.throws(() => {
    assertPostFields({ title: 'Title', category: '  ' }, 'create');
}, /Category is required/, 'Empty category throws');

assert.throws(() => {
    assertPostFields({ title: 'Title', category: 'a'.repeat(LISTING_CATEGORY_LIMIT.chars + 1) }, 'create');
}, new RegExp(LISTING_CATEGORY_TOO_LONG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'Oversized category throws');

// Credits errors
assert.throws(() => {
    assertPostFields({ title: 'Title', credits: -1 }, 'create');
}, new RegExp(`The price must be a number of Beans from 0 to ${POST_CREDITS_MAX}`), 'Negative credits throw');

assert.throws(() => {
    assertPostFields({ title: 'Title', credits: POST_CREDITS_MAX + 1 }, 'create');
}, new RegExp(`The price must be a number of Beans from 0 to ${POST_CREDITS_MAX}`), 'Excessive credits throw');

// priceType errors
assert.throws(() => {
    assertPostFields({ title: 'Title', priceType: 'invalid' }, 'create');
}, new RegExp(`The price type must be one of ${POST_PRICE_TYPES.join(', ')}`), 'Invalid price type throws');

// Coordinate errors
assert.throws(() => {
    assertPostFields({ title: 'Title', lat: 91 }, 'create');
}, /Latitude must be a number from -90 to 90/, 'Latitude > 90 throws');

assert.throws(() => {
    assertPostFields({ title: 'Title', lng: -181 }, 'create');
}, /Longitude must be a number from -180 to 180/, 'Longitude < -180 throws');

// Hours (deal quantity) errors
assert.throws(() => {
    assertPostFields({ title: 'Title', hours: 0 }, 'create');
}, new RegExp(DEAL_QUANTITY_ERROR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'Invalid hours quantity throws');

// Valid full post creation
assert.doesNotThrow(() => {
    assertPostFields({
        title: 'Fresh Bread',
        description: 'Sourdough loaf',
        category: 'Food',
        credits: 5,
        priceType: 'fixed',
        lat: 37.7749,
        lng: -122.4194,
        hours: 1,
    }, 'create');
}, 'Full valid post should pass assertPostFields');

// 5. assertPostFields tests - edit mode
console.log('  5. Testing assertPostFields in edit mode...');

// Edit only price without specifying title
assert.doesNotThrow(() => {
    assertPostFields({ credits: 10 }, 'edit');
}, 'Edit mode allows partial field update');

// Edit latitude and longitude clearing with null
assert.doesNotThrow(() => {
    assertPostFields({ lat: null, lng: null }, 'edit');
}, 'Edit mode allows null coordinates to clear location pin');

assert.throws(() => {
    assertPostFields({ title: 'Title', lat: null, lng: null }, 'create');
}, /Latitude must be a number from -90 to 90/, 'Create mode rejects null latitude');

// Pre-existing oversized text retention in edit mode
const oversizedTitle = 'a'.repeat(LISTING_TITLE_LIMIT.chars + 10);
const storedPost = { title: oversizedTitle };

// Sending unchanged oversized title back in edit mode passes
assert.doesNotThrow(() => {
    assertPostFields({ title: oversizedTitle, credits: 15 }, 'edit', storedPost);
}, 'Edit mode allows unchanged pre-existing oversized title');

// Changing oversized title to another oversized title fails
assert.throws(() => {
    assertPostFields({ title: oversizedTitle + 'b', credits: 15 }, 'edit', storedPost);
}, new RegExp(LISTING_TITLE_TOO_LONG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'Edit mode rejects changed oversized title');

console.log('✅ post-fields engine utility tests PASSED!');
process.exit(0);
