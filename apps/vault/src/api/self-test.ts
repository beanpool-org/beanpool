import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { openWithX25519, sealToX25519 } from '@beanpool/core';
import { BUILT_ROOT_KEYS } from '../shared/pinned.js';
import {
    addSignature,
    formatManifest,
    formatSignatures,
    imageHashOf,
    resolveChain,
    sha256Hex,
    signRelease,
    type ReleaseManifest,
    type ReleaseSignatures,
} from '../shared/release.js';

/**
 * `vault-api --self-test`: what the launcher runs before it lets a new API bundle take over (launcher.ts). It proves
 * the bundle loads on this machine's Node and that its own pieces work, touching nothing of the running vault: the
 * signatures, the ciphers, the database engine, the release check (a two-signed release is taken, a one-signed one
 * isn't). It reports the custodian keys it was built with and the hash of its own file, which the launcher compares
 * with its own keys and the file it was asked to run.
 */

const require = createRequire(import.meta.url);

export interface SelfTestResult {
    ok: boolean;
    failed: string[];
    rootKeys: readonly string[] | null;
    bundleSha256: string;
    node: string;
}

function nodeAtLeast(major: number, minor: number): boolean {
    const [ma, mi] = process.versions.node.split('.').map(Number);
    return ma > major || (ma === major && mi >= minor);
}

export async function selfTest(ownFile: string): Promise<SelfTestResult> {
    const failed: string[] = [];
    const check = async (name: string, fn: () => boolean | Promise<boolean>) => {
        try {
            if (!(await fn())) failed.push(name);
        } catch {
            failed.push(name);
        }
    };

    // --disable-sigusr1 (the keyholder's requirement) and node:sqlite arrived in 22.14 and 22.5.
    await check('node-version', () => nodeAtLeast(22, 14));
    await check('ed25519', () => {
        const seed = crypto.randomBytes(32);
        const msg = crypto.randomBytes(40);
        const sig = ed25519.sign(msg, seed);
        return ed25519.verify(sig, msg, ed25519.getPublicKey(seed)) && !ed25519.verify(sig, crypto.randomBytes(40), ed25519.getPublicKey(seed));
    });
    await check('xchacha20poly1305', () => {
        const key = crypto.randomBytes(32);
        const nonce = crypto.randomBytes(24);
        const plain = crypto.randomBytes(100);
        const ct = xchacha20poly1305(key, nonce, Buffer.from('aad')).encrypt(plain);
        return Buffer.from(xchacha20poly1305(key, nonce, Buffer.from('aad')).decrypt(ct)).equals(plain);
    });
    await check('x25519-box', () => {
        const secret = crypto.randomBytes(32);
        const plain = crypto.randomBytes(64);
        const box = sealToX25519(x25519.getPublicKey(secret), plain, 'self-test', Buffer.from('aad'));
        return Buffer.from(openWithX25519(secret, box, 'self-test', Buffer.from('aad'))).equals(plain);
    });
    await check('sqlite', () => {
        const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
        const db = new DatabaseSync(':memory:');
        db.exec('PRAGMA secure_delete = ON; CREATE TABLE t (b BLOB); INSERT INTO t VALUES (x\'00ff\');');
        const row = db.prepare('SELECT b FROM t').get() as { b: Uint8Array };
        db.close();
        return Buffer.from(row.b).equals(Buffer.from([0, 255]));
    });
    await check('release-check', () => {
        const keys = [0, 1, 2].map(() => {
            const seed = crypto.randomBytes(32);
            return { seed, publicKey: Buffer.from(ed25519.getPublicKey(seed)).toString('hex') };
        });
        const image = { ukiSha256: sha256Hex('uki'), roothash: sha256Hex('root') };
        const m: ReleaseManifest = {
            v: 1, version: '0.0.1', previous: null, imageHash: imageHashOf(image), image, apiBundleHash: sha256Hex('api'),
            custodianKeys: keys.map(k => k.publicKey), hostPolicy: { platform: 'none' },
        };
        const text = formatManifest(m);
        let sigs: ReleaseSignatures | null = null;
        sigs = addSignature(text, sigs, signRelease(text, keys[0].seed, keys[0].publicKey));
        const one = resolveChain([{ manifestText: text, signaturesText: formatSignatures(sigs) }], m.custodianKeys);
        sigs = addSignature(text, sigs, signRelease(text, keys[2].seed, keys[2].publicKey));
        const two = resolveChain([{ manifestText: text, signaturesText: formatSignatures(sigs) }], m.custodianKeys);
        return one.newest === null && two.newest?.manifest.version === '0.0.1';
    });

    return {
        ok: failed.length === 0 && BUILT_ROOT_KEYS !== null,
        failed: BUILT_ROOT_KEYS === null ? [...failed, 'no-pinned-keys'] : failed,
        rootKeys: BUILT_ROOT_KEYS,
        bundleSha256: sha256Hex(readFileSync(ownFile)),
        node: process.version,
    };
}
