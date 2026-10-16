/**
 * Test suite for avatar-keys engine (apps/server/src/engine/avatar-keys.ts)
 * and guestListingsOnly avatar route key protection.
 *
 * Covers:
 * 1. Default boot (local profile) -> faces keyed there too (public-routes audit SEC-PUB-02): installAvatarKeysAtBoot() is true.
 * 2. Boot when guestListingsOnly is true (NODE_PROFILE=global) -> secret generated, avatarKeysRequired() is true.
 * 3. Short secret error handling -> throws when avatarKeySecret in node_config is too short (<16 bytes).
 * 4. avatarKeyMatches helper logic:
 *    - false if key length is not 22
 *    - false if member does not exist
 *    - false if the member has no photo, or a shipped picture (bundled://, whose URL carries no key)
 *    - true if key matches HMAC for member's current photo
 *    - false if key is mismatched/tampered
 * 5. GET /api/avatar/:pubkey on a LOCAL node:
 *    - 404 without k query param or with invalid k; a photo-less member and a non-member get the same 404
 *    - the signed members list hands out the URL with k=, and it opens unsigned
 *    - 200 OK with valid k query param
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-avatar-keys.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { initStateEngine } from './state-engine.js';
import { initTls } from './services/tls.js';
import { startHttpsServer } from './https-server.js';
import {
    installAvatarKeysAtBoot,
    avatarKeysRequired,
    avatarKeyMatches,
    AVATAR_KEY_SECRET_ROW,
} from './engine/avatar-keys.js';
import { avatarRefOf, avatarUrlOf } from '@beanpool/core';
import { setMemberPhoto } from '@beanpool/engine';

let run = 0, passed = 0;
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

function createTestJpegBuffer(): Buffer {
    const header = Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
        0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
        0x00, ...Array(64).fill(0x08), 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02,
        0x00, 0x02, 0x00, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f,
        0x00, ...Array(28).fill(0x01), 0xff, 0xda, 0x00, 0x08, 0x01, 0x01,
        0x00, 0x00, 0x3f, 0x00,
    ]);
    const trailer = Buffer.from([0xff, 0xd9]);
    return Buffer.concat([header, Buffer.alloc(100, 0x01), trailer]);
}

async function main(): Promise<void> {
    console.log('=== Avatar Keys Engine Test Suite ===\n');

    // Initialize TLS and state engine
    await initTls();
    initStateEngine();

    // ── 1. Default boot: a local node keys faces too (public-routes audit SEC-PUB-02) ──────────────────────────
    console.log('--- 1. Default Boot (local profile: faces keyed on every node) ---');
    delete process.env.NODE_PROFILE;
    let installed = installAvatarKeysAtBoot();
    assert(installed === true, 'installAvatarKeysAtBoot() returns true on the local profile (it returned false before SEC-PUB-02)');
    assert(avatarKeysRequired() === true, 'avatarKeysRequired() is true on the local profile');

    // ── 2. Boot with guestListingsOnly (NODE_PROFILE=global) ───────────────
    console.log('\n--- 2. Boot with guestListingsOnly (NODE_PROFILE=global) ---');
    process.env.NODE_PROFILE = 'global';
    installed = installAvatarKeysAtBoot();
    assert(installed === true, 'installAvatarKeysAtBoot() returns true when guestListingsOnly is on');
    assert(avatarKeysRequired() === true, 'avatarKeysRequired() is true when guestListingsOnly is on');

    const secretRow = db.prepare('SELECT value FROM node_config WHERE key = ?').get(AVATAR_KEY_SECRET_ROW) as { value: string } | undefined;
    assert(!!secretRow && typeof secretRow.value === 'string' && secretRow.value.length > 0, 'avatarKeySecret is stored in node_config');

    // ── 3. Short secret error handling ──────────────────────────────────────
    console.log('\n--- 3. Short Secret Error Handling ---');
    db.prepare('UPDATE node_config SET value = ? WHERE key = ?').run('short', AVATAR_KEY_SECRET_ROW);
    let shortErrorThrown = false;
    try {
        installAvatarKeysAtBoot();
    } catch (e: any) {
        shortErrorThrown = /too short/i.test(e?.message || '');
    }
    assert(shortErrorThrown, 'installAvatarKeysAtBoot() throws error if avatarKeySecret is too short (< 16 bytes)');

    // Restore valid secret and re-install
    db.prepare('DELETE FROM node_config WHERE key = ?').run(AVATAR_KEY_SECRET_ROW);
    installAvatarKeysAtBoot();

    // ── 4. avatarKeyMatches Helper Logic ────────────────────────────────────
    console.log('\n--- 4. avatarKeyMatches Unit Checks ---');
    const pubkey = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleJpeg = createTestJpegBuffer();
    const photoDataUri = `data:image/jpeg;base64,${sampleJpeg.toString('base64')}`;

    // Seed member
    db.prepare(`
        INSERT OR REPLACE INTO members (public_key, callsign, joined_at, status)
        VALUES (?, 'TestMember', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active')
    `).run(pubkey);
    setMemberPhoto(db, pubkey, photoDataUri);

    // Compute expected avatar URL with key
    const emittedUrl = avatarUrlOf(pubkey, avatarRefOf(photoDataUri));
    assert(!!emittedUrl && emittedUrl.includes('&k='), `avatarUrlOf emits URL with &k= parameter (${emittedUrl})`);

    const keyMatch = emittedUrl!.match(/&k=([A-Za-z0-9_-]{22})/);
    assert(!!keyMatch, 'Extracted 22-char base64url key from avatarUrlOf output');
    const validKey = keyMatch![1];

    assert(avatarKeyMatches(pubkey, validKey) === true, 'avatarKeyMatches returns true for valid key and member photo');
    assert(avatarKeyMatches(pubkey, 'invalidKeyLength') === false, 'avatarKeyMatches returns false for key length != 22');
    assert(avatarKeyMatches(pubkey, 'A'.repeat(22)) === false, 'avatarKeyMatches returns false for mismatched 22-char key');

    const nonExistentPubkey = 'f'.repeat(64);
    assert(avatarKeyMatches(nonExistentPubkey, validKey) === false, 'avatarKeyMatches returns false for non-existent member');

    // A shipped picture (bundled://) returns false: its URL is its name, which carries no key
    const bundledPubkey = 'e'.repeat(64);
    db.prepare(`
        INSERT OR REPLACE INTO members (public_key, callsign, joined_at, status)
        VALUES (?, 'BundledMember', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active')
    `).run(bundledPubkey);
    setMemberPhoto(db, bundledPubkey, 'bundled://leaf');
    assert(avatarKeyMatches(bundledPubkey, validKey) === false, 'avatarKeyMatches returns false for a bundled:// avatar');

    // Back on the local profile, keys stay required, and the same key still opens the face.
    process.env.NODE_PROFILE = 'local';
    delete (process.env as any).NODE_PROFILE;
    db.prepare("DELETE FROM node_config WHERE key LIKE 'nodeProfile.%'").run();
    installAvatarKeysAtBoot();
    assert(avatarKeysRequired() === true, 'Keys still required after reinstall on the local profile');
    assert(avatarKeyMatches(pubkey, validKey) === true, 'avatarKeyMatches still true for the valid key on the local profile');

    // ── 5. HTTP Route Protection Integration, on a LOCAL node ───────────────
    console.log('\n--- 5. HTTP Route Protection (local profile) ---');
    assert(avatarKeysRequired() === true, 'Keys enabled for HTTP route test on the local profile');

    const port = await startHttpsServer(0);
    const baseUrl = `https://localhost:${port}`;

    // Without k parameter: refused, as a face that isn't there (200 image/jpeg before SEC-PUB-02).
    const noKeyRes = await fetch(`${baseUrl}/api/avatar/${pubkey}`);
    const noKeyText = await noKeyRes.text();
    assert(noKeyRes.status === 404, `GET /api/avatar/:pubkey without ?k= returns 404 Avatar not found on a local node (got ${noKeyRes.status})`);

    // With wrong k parameter
    const wrongKeyRes = await fetch(`${baseUrl}/api/avatar/${pubkey}?k=${'B'.repeat(22)}`);
    assert(wrongKeyRes.status === 404, 'GET /api/avatar/:pubkey with wrong ?k= returns 404 Avatar not found');

    // A member with no photo and a key that is no member: the same 404 and the same words, so it tells nobody which is which.
    const noPhotoPubkey = 'd'.repeat(64);
    db.prepare(`
        INSERT OR REPLACE INTO members (public_key, callsign, joined_at, status)
        VALUES (?, 'NoPhotoMember', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active')
    `).run(noPhotoPubkey);
    const noPhotoRes = await fetch(`${baseUrl}/api/avatar/${noPhotoPubkey}`);
    const nonMemberRes = await fetch(`${baseUrl}/api/avatar/${nonExistentPubkey}`);
    const noPhotoText = await noPhotoRes.text(), nonMemberText = await nonMemberRes.text();
    assert(noPhotoRes.status === 404 && nonMemberRes.status === 404 && noPhotoText === noKeyText && nonMemberText === noKeyText,
        `a member with a photo asked without its key, one with no photo, and no member at all: the same 404 (${noKeyRes.status} ${noPhotoRes.status} ${nonMemberRes.status}; ${noKeyText} | ${noPhotoText} | ${nonMemberText})`);

    // The URL a signed members list hands a member carries k=, and opens unsigned (as an <img> asks it).
    const viewerKeys = crypto.generateKeyPairSync('ed25519');
    const viewerPk = viewerKeys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`
        INSERT OR REPLACE INTO members (public_key, callsign, joined_at, status)
        VALUES (?, 'Viewer', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active')
    `).run(viewerPk);
    const listPath = '/api/members';
    const ts = Date.now(), nonce = crypto.randomBytes(16).toString('hex');
    const listRes = await fetch(`${baseUrl}${listPath}`, {
        headers: {
            'X-Public-Key': viewerPk,
            'X-Signature': crypto.sign(null, Buffer.from(`GET\n${listPath}\n${ts}\n${nonce}\n`), viewerKeys.privateKey).toString('base64'),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
    });
    const listBody: any = await listRes.json().catch(() => null);
    const rows: any[] = Array.isArray(listBody) ? listBody : Array.isArray(listBody?.members) ? listBody.members : [];
    const listed = rows.find((m) => m?.publicKey === pubkey);
    const listedUrl: string | undefined = listed?.avatarUrl ?? listed?.avatar;
    assert(listRes.status === 200 && typeof listedUrl === 'string' && /[?&]k=[A-Za-z0-9_-]{22}(&|$)/.test(listedUrl),
        `the signed members list hands out the face with its key (${listRes.status} ${listedUrl})`);
    const listedRes = listedUrl ? await fetch(`${baseUrl}${listedUrl}`) : null;
    assert(listedRes?.status === 200, `and that URL opens unsigned (got ${listedRes?.status})`);

    // With correct k parameter
    // With correct k parameter
    const validKeyRes = await fetch(`${baseUrl}/api/avatar/${pubkey}?k=${validKey}`);
    assert(validKeyRes.status === 200, `GET /api/avatar/:pubkey with valid ?k= returns 200 OK (got ${validKeyRes.status})`);
    const validKeyType = validKeyRes.headers.get('content-type');
    assert(validKeyType === 'image/jpeg', `Content-Type is image/jpeg (got ${validKeyType})`);

    console.log(`\n${passed}/${run} assertions passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} assertion(s) failed`);
    }
    console.log('⭐️ Avatar keys engine checks PASSED.');
}

main().then(() => {
    process.exit(process.exitCode ?? 0);
}).catch((err) => {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
});
