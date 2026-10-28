// The directory-register Edge Function's pure decisions (supabase/functions/directory-register/rules.ts, v6, front doors
// S13): a push from one of our own test servers is refused with the 403 sentence, an unlist is told apart from a push and
// needs only nodeId and timestamp, and the 5-minute window holds. The Edge Function itself (index.ts) imports npm:
// modules that do not run under node, so its decisions live in rules.ts and are tested here.
//
// Run: node --import tsx --test scripts/directory-register-rules.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
// rules.ts has no package.json of its own that says "module" (and must not: the Edge Function deploys from that folder),
// so tsx loads it as CommonJS and its exports arrive on the default import.
import * as loaded from '../supabase/functions/directory-register/rules.ts';

const rules = loaded.default?.checkBeforeSignature ? loaded.default : loaded;
const {
    DENIED_HOST_MESSAGE, DEFAULT_DENY_HOSTS, TIMESTAMP_WINDOW_MS, checkBeforeSignature, decideAfterSignature, hostDenied,
    hostOfPublicUrl, isUnlistPayload, parseDenyHosts, requiredFields,
} = rules;

const NOW = Date.UTC(2026, 9, 27, 8, 0, 0);
// The list the director sets at deploy (DIRECTORY_DENY_HOSTS), and the one used when the secret is not set.
const DENY = parseDenyHosts('review.beanpool.org,test.beanpool.org,*.test.beanpool.org');
const push = (publicUrl, extra = {}) => ({ nodeId: '12D3KooWnode', callsign: 'Riverbend', timestamp: NOW, publicUrl, ...extra });

test('a push from a denied exact host is refused with the 403 sentence', () => {
    const d = decideAfterSignature(push('https://test.beanpool.org'), DENY);
    assert.deepEqual(d, { action: 'refuse', status: 403, error: DENIED_HOST_MESSAGE });
    assert.equal(DENIED_HOST_MESSAGE, "This address is one of BeanPool's own test servers and is never listed.");
});

test('a push from a *.test.beanpool.org host is refused with the 403 sentence, at any depth, in any case', () => {
    for (const url of ['https://lane-7.test.beanpool.org', 'https://a.b.test.beanpool.org/', 'HTTPS://PR-12.TEST.BEANPOOL.ORG:8443', 'pr-9.test.beanpool.org']) {
        assert.deepEqual(decideAfterSignature(push(url), DENY), { action: 'refuse', status: 403, error: DENIED_HOST_MESSAGE }, url);
    }
});

test('review.beanpool.org is denied by the default list (the secret not set)', () => {
    const defaults = parseDenyHosts(undefined);
    assert.deepEqual(defaults, parseDenyHosts(DEFAULT_DENY_HOSTS));
    assert.ok(defaults.includes('review.beanpool.org'));
    assert.deepEqual(decideAfterSignature(push('https://review.beanpool.org'), defaults), { action: 'refuse', status: 403, error: DENIED_HOST_MESSAGE });
    assert.equal(hostDenied('review.beanpool.org', defaults), true);
    // Set, even to nothing, the secret replaces the default.
    assert.deepEqual(parseDenyHosts(''), []);
    assert.equal(decideAfterSignature(push('https://review.beanpool.org'), parseDenyHosts('')).action, 'upsert');
});

test('other hosts pass: a real community, a look-alike, the suffix itself only when listed, and no address at all', () => {
    for (const url of ['https://mullum.beanpool.org', 'https://castlemaine.example.org', 'https://nottest.beanpool.org',
        'https://test.beanpool.org.evil.example', 'https://reviewbeanpool.org', 'https://beanpool.org', null, undefined, '', 42]) {
        assert.deepEqual(decideAfterSignature(push(url), DENY), { action: 'upsert' }, String(url));
    }
    // `*.test.beanpool.org` alone does not cover test.beanpool.org (the default list names it on its own).
    assert.equal(hostDenied('test.beanpool.org', parseDenyHosts('*.test.beanpool.org')), false);
    assert.equal(hostDenied('x.test.beanpool.org', parseDenyHosts('*.test.beanpool.org')), true);
});

test('the host is read from a URL or a bare host, lower case, without port or trailing dot', () => {
    assert.equal(hostOfPublicUrl('https://Review.BeanPool.org:443/path?q=1'), 'review.beanpool.org');
    assert.equal(hostOfPublicUrl('review.beanpool.org.'), 'review.beanpool.org');
    assert.equal(hostOfPublicUrl('   '), null);
    assert.equal(hostOfPublicUrl({}), null);
    assert.deepEqual(parseDenyHosts(' Review.BeanPool.org , ,*.Test.BeanPool.org. '), ['review.beanpool.org', '*.test.beanpool.org']);
});

test('an unlist is detected, needs only nodeId and timestamp, and is allowed from a denied host', () => {
    const unlist = { nodeId: '12D3KooWnode', timestamp: NOW, unlist: true };
    assert.equal(isUnlistPayload(unlist), true);
    assert.deepEqual([...requiredFields(unlist)], ['nodeId', 'timestamp']);
    assert.equal(checkBeforeSignature(unlist, NOW), null, 'no callsign needed for an unlist');
    assert.deepEqual(decideAfterSignature(unlist, DENY), { action: 'unlist' });
    assert.deepEqual(decideAfterSignature({ ...unlist, publicUrl: 'https://review.beanpool.org' }, DENY), { action: 'unlist' });
    // Only `true` is an unlist: anything else is a push, with a push's fields.
    for (const v of ['true', 1, 'yes', false, null]) {
        const p = { nodeId: '12D3KooWnode', timestamp: NOW, unlist: v };
        assert.equal(isUnlistPayload(p), false, String(v));
        assert.deepEqual(checkBeforeSignature(p, NOW), { status: 400, error: 'Missing required fields' }, `unlist: ${String(v)} without a callsign`);
    }
    assert.deepEqual(checkBeforeSignature({ timestamp: NOW, unlist: true }, NOW), { status: 400, error: 'Missing required fields' });
    assert.deepEqual(checkBeforeSignature({ nodeId: '12D3KooWnode', unlist: true }, NOW), { status: 400, error: 'Missing required fields' });
});

test('a push keeps today\'s required fields and the 5-minute window, either way', () => {
    assert.deepEqual([...requiredFields(push('https://x.example.org'))], ['nodeId', 'callsign', 'timestamp']);
    assert.equal(checkBeforeSignature(push('https://x.example.org'), NOW), null);
    assert.deepEqual(checkBeforeSignature({ nodeId: 'n', timestamp: NOW }, NOW), { status: 400, error: 'Missing required fields' });
    assert.equal(checkBeforeSignature(push(null, { timestamp: NOW - TIMESTAMP_WINDOW_MS }), NOW), null, 'exactly 5 minutes old');
    assert.deepEqual(checkBeforeSignature(push(null, { timestamp: NOW - TIMESTAMP_WINDOW_MS - 1 }), NOW), { status: 401, error: 'Timestamp Expired' });
    assert.deepEqual(checkBeforeSignature(push(null, { timestamp: NOW + TIMESTAMP_WINDOW_MS + 1 }), NOW), { status: 401, error: 'Timestamp Expired' });
    assert.deepEqual(checkBeforeSignature({ nodeId: 'n', timestamp: NOW - TIMESTAMP_WINDOW_MS - 1, unlist: true }, NOW), { status: 401, error: 'Timestamp Expired' }, 'an unlist has the same window');
    // A timestamp that is not a number is not fresh (v5 let NaN through the comparison).
    assert.deepEqual(checkBeforeSignature(push(null, { timestamp: 'soon' }), NOW), { status: 401, error: 'Timestamp Expired' });
    // A body that is not an object is a 400, not a crash.
    for (const body of [null, [], 'x', 7]) assert.deepEqual(checkBeforeSignature(body, NOW), { status: 400, error: 'Missing required fields' });
});
