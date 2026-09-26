/**
 * Shared by the recovery seal S2 suites (not a suite itself): a member's sign-in recovery copy deposited, and later
 * recovered by a device that has nothing but the sign-in, over real HTTPS through the real signature middleware, with
 * a stand-in Google (a local RSA key in the JWKS cache, as test-sso-recovery-roundtrip.ts and test-recovery-seal.ts do).
 *
 * It runs inside the node's own process (a take-over harness child, a restored server): the requests go out over the
 * network stack to that process's own HTTPS server, so they pass every middleware a node runs. No provider, registrar
 * or BeanPool node is contacted.
 */

import crypto from 'node:crypto';
import { sealSeedToSso, openSeedFromSso } from '@beanpool/core';

const GOOGLE_KID = 'test-recovery-seal-s2-google-kid';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
/** The fixture sign-in (test-sso-recovery-roundtrip.ts). */
export const GOOGLE_SUB = '110169484474386276334';

/** A test phrase, not an account, turned round by `n` so each member has their own. seed = SHA256(SHA256(words)). */
export function fixtureWords(n: number): { words: string[]; seedHex: string } {
    const base = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
    const words = [...base.slice(n % base.length), ...base.slice(0, n % base.length)];
    if (n >= base.length) words.reverse();
    const seed = crypto.createHash('sha256').update(crypto.createHash('sha256').update(words.join(' ')).digest()).digest();
    return { words, seedHex: seed.toString('hex') };
}

interface Id { pk: string; priv: crypto.KeyObject }
function idFromSeed(seed: Buffer): Id {
    const priv = crypto.createPrivateKey({
        key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8',
    });
    const pk = (crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { pk, priv };
}

export interface RecoveryHttps {
    base: string;
    /** Add a member with this seed (its public key) and callsign, then deposit their sign-in copy over HTTPS. */
    deposit(args: { seedHex: string; words: string[]; callsign: string; addMember: boolean }):
        Promise<{ status: number; body: any; pk: string; sealed: { encryptedShare: string; shareIv: string; shareTag: string; kdfParams: string } }>;
    /** A new device with only the sign-in: open a collection for the callsign, release the Google copy, fetch it, open it. */
    recover(args: { callsign: string; sub?: string }): Promise<{
        opened: number; released: { status: number; body: any }; fragments: { status: number; body: any };
        seedHex: string | null; words: string[] | null; error: string | null;
    }>;
}

let started: RecoveryHttps | null = null;

/** Start this process's real HTTPS server (once) with the stand-in Google, and return the two member journeys. */
export async function startRecoveryHttps(): Promise<RecoveryHttps> {
    if (started) return started;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the node's own self-signed certificate
    delete process.env.CF_RECORD_NAME; // LAN mode: a self-signed certificate, no registrar
    const { initTls } = await import('./services/tls.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { _resetJwksCacheForTests, _clearNoncesForTests } = await import('./sso.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { db } = await import('./db/db.js');

    await initTls();
    const port = await startHttpsServer(0);
    const base = `https://localhost:${port}`;
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    _resetJwksCacheForTests();
    _resetJwksCacheForTests('google', {
        keys: [{ ...publicKey.export({ format: 'jwk' }), kid: GOOGLE_KID, alg: 'RS256', use: 'sig' } as any],
        expiresAt: Date.now() + 3600_000,
    });
    _clearNoncesForTests();

    const googleToken = (sub: string, nonce: string): string => {
        const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const now = Math.floor(Date.now() / 1000);
        const header = b64({ alg: 'RS256', kid: GOOGLE_KID, typ: 'JWT' });
        const payload = b64({
            iss: 'https://accounts.google.com', aud: GOOGLE_AUD, sub, email: 'seal-s2@example.com', email_verified: true,
            iat: now, exp: now + 3600, nonce,
        });
        return `${header}.${payload}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
    };

    /** Signed exactly as the real middleware requires: method, path, timestamp, nonce and body. */
    const call = async (id: Id, p: string, body: unknown): Promise<{ status: number; body: any }> => {
        resetGatewayRateLimit();
        pruneAuthAttempts(Date.now() + 120_000);
        const bodyString = JSON.stringify(body ?? {});
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const res = await fetch(`${base}${p}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Public-Key': id.pk,
                'X-Signature': crypto.sign(null, Buffer.from(`POST\n${p}\n${ts}\n${nonce}\n${bodyString}`), id.priv).toString('base64'),
                'X-Timestamp': String(ts),
                'X-Nonce': nonce,
            },
            body: bodyString,
        });
        let parsed: any;
        try { parsed = await res.json(); } catch { parsed = undefined; }
        return { status: res.status, body: parsed };
    };

    started = {
        base,
        async deposit({ seedHex, words, callsign, addMember }) {
            const seed = Buffer.from(seedHex, 'hex');
            const id = idFromSeed(seed);
            if (addMember) {
                db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                            VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'recovery-seal-test', 'TEST')`).run(id.pk, callsign);
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
            }
            const sealed = await sealSeedToSso(new Uint8Array(seed), 'google', GOOGLE_SUB, { words }) as
                { encryptedShare: string; shareIv: string; shareTag: string; kdfParams: string };
            const n = (await call(id, '/api/recovery/sso-nonce', {})).body?.nonce;
            const res = await call(id, '/api/recovery/shares/sso', {
                provider: 'google', idToken: googleToken(GOOGLE_SUB, n), nonce: n,
                shares: [{ holderType: 'sso', holderRef: 'google', shareIndex: 1, ...sealed }],
            });
            return { ...res, pk: id.pk, sealed };
        },
        async recover({ callsign, sub = GOOGLE_SUB }) {
            const eph = idFromSeed(crypto.randomBytes(32));
            const opened = await call(eph, '/api/recovery/collect', { callsign });
            const collectionId = opened.body?.collectionId;
            const n = (await call(eph, '/api/recovery/collect/sso-nonce', { collectionId })).body?.nonce;
            const released = await call(eph, '/api/recovery/collect/sso', { collectionId, provider: 'google', idToken: googleToken(sub, n), nonce: n });
            const fragments = await call(eph, '/api/recovery/collect/fragments', { collectionId });
            const f = fragments.body?.fragments?.[0];
            let seedHex: string | null = null, words: string[] | null = null, error: string | null = null;
            if (f) {
                try {
                    const o = await openSeedFromSso({ encryptedShare: f.payload, shareIv: f.payloadIv, shareTag: f.payloadTag, kdfParams: f.kdfParams }, 'google', sub);
                    seedHex = Buffer.from(o.seed).toString('hex');
                    words = o.words ?? null;
                } catch (e) { error = (e as Error)?.message || String(e); }
            } else {
                error = 'no fragment came back';
            }
            return { opened: opened.status, released, fragments, seedHex, words, error };
        },
    };
    return started;
}
