/**
 * #143 driver — seeds members, wires connectors, and runs real cross-node trades between gippsland and
 * eastgippy over the SSH port-forwards.
 *
 * An OPERATOR HARNESS for a live test, not a unit suite. In the repo (rather than a scratchpad) only because a
 * handover needs to be able to point at it — see docs/federation-half-b-handover.md.
 */

/*
 * TLS VERIFICATION IS OFF, and this was raised in review as exposing ADMIN_PASSWORD to interception. Declined,
 * with the reasoning recorded here so it does not have to be re-litigated:
 *
 *   • Every request goes to `https://localhost:<port>` — an SSH port-forward to the node. The only way to sit
 *     between this process and that socket is to already be root on this machine, at which point the password
 *     in `.env` is readable directly.
 *   • The nodes present SELF-SIGNED certificates by design (`initTls` falls back to them without
 *     CF_RECORD_NAME). There is no CA to validate against, so verification cannot succeed — it can only be
 *     bypassed, and the question is whether the bypass is scoped or global.
 *   • The suggested scoping (a custom undici dispatcher per call) is the better shape in a long-lived service.
 *     Here it would thread an agent through every fetch in a throwaway operator script to remove a risk that
 *     is already nil, and the added surface is its own hazard.
 *
 * If this file ever grows a request to a host that is NOT a localhost forward, revisit it — that is the change
 * that would make the global flag genuinely wrong.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not `.pathname` (review finding): `.pathname` yields "/C:/..." on Windows and leaves %20 in
// any path containing a space, so it silently reads and writes the wrong file rather than failing.
const STATE_PATH = fileURLToPath(new URL('./fed-state.json', import.meta.url));

export const NODES = {
    gippsland: { port: 18448, callsign: 'Gippsland Beanpool', containerIp: '172.18.0.3', publicUrl: 'https://gippsland.beanpool.org:8448' },
    eastgippy: { port: 18450, callsign: 'East Gippsland Beanp', containerIp: '172.18.0.4', publicUrl: 'https://eastgippy.beanpool.org:8450' },
};

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD must be set in the environment');

export function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch { return {}; }
}
// 0600 (review finding, accepted). This file holds the TEST identities' Ed25519 private keys; the default
// umask leaves it world-readable, and "they are only test keys" is the sentence that precedes every leak of a
// key that turned out to matter. They also sign real ledger writes on the live pair.
export function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), { mode: 0o600 }); }

const base = (node) => `https://localhost:${NODES[node].port}`;

/** Raw 32-byte public key as hex — the form the server reconstructs into SPKI. */
function pubHex(publicKey) {
    return publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
}

export function newIdentity(callsign) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        callsign,
        publicKey: pubHex(publicKey),
        privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
}

/** Plain request — for the /api/local/ and /api/invite/ paths, which bypass the signature middleware. */
export async function plain(node, method, path, body) {
    const res = await fetch(`${base(node)}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-json */ }
    return { status: res.status, json };
}

/**
 * Signed request — the replay-proof scheme the middleware requires on every mutating /api/ call:
 * signature covers METHOD\npath\ntimestamp\nnonce\nbody, with a single-use nonce.
 */
export async function signed(node, identity, method, path, body) {
    // A GET signs over an EMPTY body and must not carry one — the server canonicalises `rawBody ?? ''`, and
    // fetch throws outright if a GET has a body. Signing '{}' on a GET produced a 403 that looks exactly like
    // a wrong key.
    const isGet = method === 'GET' || method === 'HEAD';
    const bodyString = isGet ? '' : JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
    const privateKey = crypto.createPrivateKey(identity.privateKeyPem);
    const signature = crypto.sign(null, Buffer.from(canonical), privateKey).toString('base64');

    const res = await fetch(`${base(node)}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'X-Public-Key': identity.publicKey,
            'X-Signature': signature,
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
        ...(isGet ? {} : { body: bodyString }),
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-json */ }
    return { status: res.status, json };
}

export const admin = (node, path, body) => plain(node, 'POST', path, { password: ADMIN_PASSWORD, ...body });

export async function balanceOf(node, publicKey) {
    const r = await plain(node, 'GET', `/api/ledger/balance/${publicKey}`);
    return r.json;
}

/** Seed one Elder member on a node and return the identity (idempotent via the state file). */
export async function seedElder(node, callsign) {
    const state = loadState();
    if (state[node]?.identity) {
        console.log(`  ${node}: reusing ${state[node].identity.callsign} (${state[node].identity.publicKey.slice(0, 12)}…)`);
        return state[node].identity;
    }

    const invite = await admin(node, '/api/admin/seed-invite', { type: 'elder' });
    if (invite.status !== 200 || !invite.json?.code) {
        throw new Error(`${node}: seed-invite failed ${invite.status} ${JSON.stringify(invite.json)}`);
    }
    console.log(`  ${node}: elder invite ${invite.json.code} (${invite.json.type})`);

    const identity = newIdentity(callsign);
    const redeemed = await plain(node, 'POST', '/api/invite/redeem', {
        code: invite.json.code, publicKey: identity.publicKey, callsign,
    });
    if (redeemed.status !== 200) {
        throw new Error(`${node}: redeem failed ${redeemed.status} ${JSON.stringify(redeemed.json)}`);
    }
    console.log(`  ${node}: redeemed as ${callsign} (${identity.publicKey.slice(0, 12)}…)`);

    state[node] = { ...(state[node] || {}), identity };
    saveState(state);
    return identity;
}

/**
 * The marketplace refuses a listing from a member with no profile photo ("Please set a profile photo before
 * using the marketplace"), so this is a prerequisite of posting an offer, which is in turn a prerequisite of
 * having any spending room at all. A 1x1 PNG is enough to satisfy it.
 */
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';

export async function setAvatar(node, identity) {
    const r = await signed(node, identity, 'POST', '/api/profile/update', { avatar: TINY_PNG });
    if (r.status !== 200) throw new Error(`${node}: avatar failed ${r.status} ${JSON.stringify(r.json)}`);
    console.log(`  ${node}: profile photo set for ${identity.callsign}`);
}

/** Post one live offer, which is what unlocks the first -200 band of an earned floor. */
export async function postOffer(node, identity, title, credits, opts = {}) {
    const r = await signed(node, identity, 'POST', '/api/marketplace/posts', {
        type: 'offer', category: 'other', title, description: 'Cross-node federation test listing',
        credits, priceType: 'fixed', authorPublicKey: identity.publicKey,
        ...(opts.reach !== undefined ? { reach: opts.reach } : {}),
        ...(opts.reachPeers !== undefined ? { reachPeers: opts.reachPeers } : {}),
    });
    if (r.status !== 200) throw new Error(`${node}: post offer failed ${r.status} ${JSON.stringify(r.json)}`);
    console.log(`  ${node}: offer "${title}" posted (${r.json?.post?.id})`);
    return r.json.post;
}
