/**
 * The avatar URL keys engine/avatar-keys.ts remembers (keyFor's memo, bounded at AVATAR_KEY_MEMO_MAX per secret):
 *
 *   - every key in a URL is byte for byte the documented HMAC, base64url(HMAC-SHA256(secret, id|version))[0..22],
 *     worked out here independently, the first time and every time after
 *   - asking again for the same face adds nothing to the memo
 *   - a new photo is a new version: a new key, the HMAC of the new version, and the old key no longer opens the face
 *   - a new secret (the node_config row replaced, then the boot install) gives every face a new key, the new secret's
 *     HMAC, and the memo starts empty
 *   - the memo never holds more than AVATAR_KEY_MEMO_MAX keys, and a key it let go is worked out again the same
 *
 * Run: through scripts/run-server-suites.mjs (test-avatar-key-memo).
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { initStateEngine } from './state-engine.js';
import { initTls } from './services/tls.js';
import {
    installAvatarKeysAtBoot, avatarKeyMatches, avatarKeyMemoSize, AVATAR_KEY_MEMO_MAX, AVATAR_KEY_SECRET_ROW,
} from './engine/avatar-keys.js';
import { avatarRefOf, avatarUrlOf, avatarVersionOfRef } from '@beanpool/core';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const secretBytes = () => Buffer.from(String((db.prepare('SELECT value FROM node_config WHERE key = ?').get(AVATAR_KEY_SECRET_ROW) as any).value), 'base64url');
const expected = (id: string, ref: string) =>
    crypto.createHmac('sha256', secretBytes()).update(`${id}|${avatarVersionOfRef(ref)}`, 'utf-8').digest('base64url').slice(0, 22);
const kOf = (url: string | null | undefined) => (url ? new URL(url, 'https://x').searchParams.get('k') : null);
const pk = () => crypto.randomBytes(32).toString('hex');
const ref = (seed: string) => avatarRefOf(`data:image/jpeg;base64,${crypto.createHash('sha256').update(seed).digest('base64')}`)!;

async function main(): Promise<void> {
    console.log('\n=== Avatar URL keys, remembered ===\n');
    await initTls();
    initStateEngine();
    assert(installAvatarKeysAtBoot() === true, 'faces are keyed on the global profile');

    const a = pk(), refA1 = ref('a1');
    const first = kOf(avatarUrlOf(a, refA1));
    assert(first === expected(a, refA1), `the first key is the documented HMAC (got ${first})`);
    const size = avatarKeyMemoSize();
    const again = Array.from({ length: 5 }, () => kOf(avatarUrlOf(a, refA1)));
    assert(again.every(k => k === first), 'asked 5 more times, the same key every time');
    assert(avatarKeyMemoSize() === size && size >= 1, `and the memo holds it once (size ${size} → ${avatarKeyMemoSize()})`);

    // Many faces: each is the HMAC, the first time and from the memo.
    const many = Array.from({ length: 200 }, (_, i) => ({ id: pk(), r: ref(`m${i}`) }));
    const firstPass = many.map(m => kOf(avatarUrlOf(m.id, m.r)));
    const secondPass = many.map(m => kOf(avatarUrlOf(m.id, m.r)));
    assert(many.every((m, i) => firstPass[i] === expected(m.id, m.r) && secondPass[i] === firstPass[i]),
        '200 faces: every key is the HMAC, and the same from the memo');

    // A new photo: a new version, a new key.
    const refA2 = ref('a2');
    const second = kOf(avatarUrlOf(a, refA2));
    assert(second !== first && second === expected(a, refA2), `a new photo has a new key, the HMAC of its version (got ${second})`);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status) VALUES (?, 'Ava', ?, 'x', 'TEST', 'active')`)
        .run(a, new Date().toISOString());
    db.prepare('UPDATE members SET avatar_ref = ? WHERE public_key = ?').run(refA2, a);
    assert(avatarKeyMatches(a, second) === true && avatarKeyMatches(a, first) === false,
        'the route opens the face for the new key and not for the old one');

    // A new secret: every key changes, and the memo starts again.
    db.prepare('UPDATE node_config SET value = ? WHERE key = ?').run(crypto.randomBytes(32).toString('base64url'), AVATAR_KEY_SECRET_ROW);
    installAvatarKeysAtBoot();
    assert(avatarKeyMemoSize() === 0, `a new secret starts an empty memo (got ${avatarKeyMemoSize()})`);
    const rotated = kOf(avatarUrlOf(a, refA2));
    assert(rotated !== second && rotated === expected(a, refA2), `and gives the face a new key, the new secret's HMAC (got ${rotated})`);
    assert(many.slice(0, 20).every(m => { const k = kOf(avatarUrlOf(m.id, m.r)); return k === expected(m.id, m.r) && k !== firstPass[many.indexOf(m)]; }),
        'every other face too');

    // The bound.
    const flood = Array.from({ length: AVATAR_KEY_MEMO_MAX + 50 }, (_, i) => ({ id: `f${i}`, r: refA1 }));
    for (const f of flood) avatarUrlOf(f.id, f.r);
    assert(avatarKeyMemoSize() === AVATAR_KEY_MEMO_MAX, `the memo stops at ${AVATAR_KEY_MEMO_MAX} (got ${avatarKeyMemoSize()})`);
    assert(kOf(avatarUrlOf(flood[0]!.id, refA1)) === expected(flood[0]!.id, refA1), 'a key it let go is worked out again, the same');

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) throw new Error(`${run - passed} failed`);
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
