// Beanpool node-address registrar — Cloudflare Worker.
//   fetch:     claim / status / offline (signed by node key) + admin approve/revoke + switchboard
//   scheduled: attestation sweep — every live name must keep proving it's the registered node, else revoke.
// Design: docs/node-dns-registrar.md. CF calls validated live 2026-07-27 (scratchpad/cf-phase0.sh).

import * as cf from './cf.js';
import * as db from './db.js';
import { verifySignedRequest, verifyEd25519 } from './sign.js';
import { ADMIN_HTML } from './admin-html.js';

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/; // 3–32, no leading/trailing hyphen
const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const nowS = () => Math.floor(Date.now() / 1000);

// --- Provision / deprovision Cloudflare resources for an allocation ---
async function provision(env, alloc) {
    if (alloc.mode === 'tunnel') {
        const tunnel = await cf.createTunnel(env, `bp-${alloc.name}`);
        await cf.setTunnelIngress(env, tunnel.id, alloc.hostname, alloc.origin || 'http://beanpool-node:8080');
        const rec = await cf.routeHostname(env, alloc.name, tunnel.id);
        return { tunnel_id: tunnel.id, dns_record_id: rec.id };
    }
    if (alloc.mode === 'direct') {
        if (!alloc.public_ip) throw new Error('direct mode needs public_ip');
        const rec = await cf.createARecord(env, alloc.name, alloc.public_ip, true);
        return { tunnel_id: null, dns_record_id: rec.id };
    }
    throw new Error(`unknown mode ${alloc.mode}`);
}

async function deprovision(env, alloc) {
    if (alloc.dns_record_id) { try { await cf.deleteDnsRecord(env, alloc.dns_record_id); } catch { /* already gone */ } }
    if (alloc.tunnel_id) { try { await cf.deleteTunnel(env, alloc.tunnel_id); } catch { /* already gone */ } }
}

// --- Node-facing (signed) ---
async function handleAvailable(url, env) {
    const name = String(url.searchParams.get('name') || '').toLowerCase();
    if (!NAME_RE.test(name)) return json({ available: false, reason: 'invalid' });
    const tier = await db.policyTier(env, name);
    if (tier === 'blocked') return json({ available: false, reason: 'reserved' });
    const existing = await db.getAllocation(env, name);
    const taken = existing && existing.status !== 'revoked';
    return json({ available: !taken, reason: taken ? 'taken' : (tier === 'gated' ? 'needs-approval' : 'free'), tier });
}

async function handleClaim(request, env, bodyText) {
    const pubkey = await verifySignedRequest(request, bodyText);
    if (!pubkey) return json({ error: 'bad signature' }, 401);
    let b; try { b = JSON.parse(bodyText || '{}'); } catch { return json({ error: 'bad json' }, 400); }

    const name = String(b.name || '').toLowerCase();
    const mode = b.mode === 'direct' ? 'direct' : 'tunnel';
    if (!NAME_RE.test(name)) return json({ error: 'invalid name (3–32; a–z 0–9 -; no leading/trailing hyphen)' }, 400);
    const tier = await db.policyTier(env, name);
    if (tier === 'blocked') return json({ error: 'name reserved' }, 403);

    const existing = await db.getAllocation(env, name);
    if (existing && existing.status !== 'revoked' && existing.node_pubkey !== pubkey)
        return json({ error: 'name taken' }, 409);
    // Re-claim (same node re-registering, or a revoked name being re-taken): tear down any old CF
    // resources first, else provision() orphans them and collides on the duplicate tunnel name.
    if (existing && (existing.tunnel_id || existing.dns_record_id)) await deprovision(env, existing);

    const now = nowS();
    const hostname = `${name}.${env.BASE_DOMAIN}`;
    const fields = {
        node_pubkey: pubkey, hostname, mode, status: 'pending',
        community_name: b.community_name || b.communityName || null,
        origin: b.origin || null, public_ip: b.public_ip || null, contact: b.contact || null,
        tunnel_id: null, dns_record_id: null, attest_fails: 0, requested_at: now, decided_at: null, decided_by: null,
    };
    try {
        if (existing) await db.updateAllocation(env, name, fields);
        else await db.insertAllocation(env, { name, ...fields });
    } catch {
        return json({ error: 'name taken' }, 409); // UNIQUE race
    }

    if (tier === 'auto') {
        try {
            const ids = await provision(env, { name, ...fields });
            await db.updateAllocation(env, name, { ...ids, status: 'live', decided_at: now, decided_by: 'auto' });
            const out = { status: 'live', hostname, community_name: fields.community_name, contact: fields.contact };
            if (mode === 'tunnel') out.tunnelToken = await cf.getTunnelToken(env, ids.tunnel_id);
            return json(out);
        } catch (e) {
            console.error('[PROVISION_FAIL]', e.stack || e.message || e);
            await db.updateAllocation(env, name, { status: 'pending' });
            return json({ error: 'provisioning failed', detail: String(e.message || e) }, 502);
        }
    }
    return json({ status: 'pending', hostname, note: 'awaiting approval' });
}

async function handleStatus(request, env) {
    const pubkey = await verifySignedRequest(request, '');
    if (!pubkey) return json({ error: 'bad signature' }, 401);
    const a = await db.getAllocationByPubkey(env, pubkey);
    if (!a) return json({ status: 'none' });
    const out = { status: a.status, name: a.name, hostname: a.hostname, mode: a.mode, community_name: a.community_name, contact: a.contact };
    if (a.status === 'live' && a.mode === 'tunnel' && a.tunnel_id) {
        try { out.tunnelToken = await cf.getTunnelToken(env, a.tunnel_id); } catch { /* transient */ }
    }
    return json(out);
}

async function handleUpdate(request, env, bodyText) {
    const pubkey = await verifySignedRequest(request, bodyText);
    if (!pubkey) return json({ error: 'bad signature' }, 401);
    const a = await db.getAllocationByPubkey(env, pubkey);
    if (!a) return json({ error: 'allocation not found' }, 404);
    let b; try { b = JSON.parse(bodyText || '{}'); } catch { return json({ error: 'bad json' }, 400); }
    const updates = {};
    const commVal = b.community_name !== undefined ? b.community_name : b.communityName;
    if (commVal !== undefined) {
        updates.community_name = typeof commVal === 'string' && commVal.trim() ? commVal.trim() : null;
    }
    if (b.contact !== undefined) {
        updates.contact = typeof b.contact === 'string' && b.contact.trim() ? b.contact.trim() : null;
    }
    if (Object.keys(updates).length > 0) {
        await db.updateAllocation(env, a.name, updates);
    }
    return json({ status: 'ok', name: a.name, ...updates });
}

async function handleOffline(request, env, bodyText) {
    const pubkey = await verifySignedRequest(request, bodyText);
    if (!pubkey) return json({ error: 'bad signature' }, 401);
    const a = await db.getAllocationByPubkey(env, pubkey);
    if (!a) return json({ status: 'none' });
    await deprovision(env, a);
    await db.updateAllocation(env, a.name, { status: 'revoked' });
    return json({ status: 'revoked', name: a.name });
}

// --- Admin (shared secret) ---
export async function timingSafeEqualString(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const encoder = new TextEncoder();
    const bufA = await crypto.subtle.digest('SHA-256', encoder.encode(a));
    const bufB = await crypto.subtle.digest('SHA-256', encoder.encode(b));
    const viewA = new Uint8Array(bufA);
    const viewB = new Uint8Array(bufB);
    let diff = 0;
    for (let i = 0; i < viewA.length; i++) {
        diff |= viewA[i] ^ viewB[i];
    }
    return diff === 0 && a.length === b.length;
}

const checkAdmin = async (request, env) => {
    if (!env.ADMIN_SECRET) return false;
    const authHeader = request.headers.get('authorization') || '';
    const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    const secret = request.headers.get('x-admin-secret') ||
                   request.headers.get('x-admin-password') ||
                   bearerToken;
    if (!secret) return false;
    return await timingSafeEqualString(secret, env.ADMIN_SECRET);
};

async function handleAdminApprove(env, name) {
    const a = await db.getAllocation(env, name);
    if (!a || a.status !== 'pending') return json({ error: 'not pending' }, 400);
    try {
        const ids = await provision(env, a);
        await db.updateAllocation(env, name, { ...ids, status: 'live', decided_at: nowS(), decided_by: 'admin' });
        return json({ status: 'live', name });
    } catch (e) { return json({ error: 'provisioning failed', detail: String(e.message || e) }, 502); }
}

async function handleAdminRevoke(env, name) {
    const a = await db.getAllocation(env, name);
    if (!a) return json({ error: 'unknown name' }, 404);
    await deprovision(env, a);
    await db.updateAllocation(env, name, { status: 'revoked' });
    return json({ status: 'revoked', name });
}

// --- Switchboard (Invite resolution / trampoline) ---
async function resolveNodeHostname(env, code, queryN) {
    if (queryN) {
        const cleanN = queryN.trim().toLowerCase();
        if (cleanN) {
            return cleanN.includes('.') ? cleanN : `${cleanN}.${env.BASE_DOMAIN || 'beanpool.org'}`;
        }
    }
    if (!code) return null;

    if (env.DB) {
        try {
            const invite = await db.getInvite(env, code);
            if (invite && invite.node_name) {
                const alloc = await db.getAllocation(env, invite.node_name);
                if (alloc && alloc.status !== 'revoked') {
                    if (alloc.hostname) return alloc.hostname;
                    return `${invite.node_name}.${env.BASE_DOMAIN || 'beanpool.org'}`;
                }
            }
        } catch { /* ignore */ }

        try {
            const alloc = await db.getAllocation(env, code.toLowerCase());
            if (alloc && alloc.status !== 'revoked' && alloc.hostname) {
                return alloc.hostname;
            }
        } catch { /* ignore */ }
    }
    return null;
}

async function handleSwitchboard(url, env) {
    const code = decodeURIComponent(url.pathname.replace(/^\/i\//, '')).trim();
    const queryN = (url.searchParams.get('n') || '').replace(/[^a-z0-9.\-]/gi, '');

    const hostname = await resolveNodeHostname(env, code, queryN);
    if (!hostname) {
        const errHtml = `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>Invite Not Found</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1.25rem;text-align:center;color:#1f2937}
.card{background:#f9fafb;border:1px solid #e5e7eb;border-radius:.75rem;padding:2rem;margin-top:2rem}
h1{font-size:1.5rem;color:#dc2626}</style></head><body>
<h1>🫘 Invite code not found</h1>
<div class=card>
<p>The invite code you followed is invalid, expired, or unmapped.</p>
<p>Please check your link or ask the node operator for a fresh invite.</p>
</div>
</body></html>`;
        return new Response(errHtml, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    const scheme = `beanpool://join?node=${encodeURIComponent(hostname)}&code=${encodeURIComponent(code)}`;
    const html = `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>Join on beanpool</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1.25rem;text-align:center;color:#1f2937}
.btn{display:block;margin:.75rem 0;padding:.9rem;border-radius:.75rem;background:#10b981;color:#fff;text-decoration:none;font-weight:700}
.muted{color:#6b7280;font-size:.9rem}</style></head><body>
<h1>🫘 You're invited</h1>
<p>Open the invite in the beanpool app.</p>
<a class=btn href="${scheme}">Open in beanpool</a>
<a class=btn href="https://apps.apple.com/app/beanpool">Get it on the App Store</a>
<a class=btn href="https://play.google.com/store/apps/details?id=org.beanpool">Get it on Google Play</a>
<p class=muted>${hostname ? 'Community node: ' + hostname : ''}</p>
</body></html>`;
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// --- Attestation ---
// Three outcomes, because "offline" and "swapped to other content" must be treated very differently
// (a solar/off-grid node that sleeps overnight must NOT lose its address):
//   'ok'         — valid signed attest from the registered node.
//   'mismatch'   — the origin answered (2xx) but it isn't our node (wrong key / not JSON / stale) →
//                  someone swapped the origin → ABUSE → revoke fast.
//   'unverified' — unreachable / non-2xx / CF has no connector → node is just DOWN → benign, never revoke.
export async function attestOne(env, a) {
    const nonce = crypto.randomUUID();
    let res;
    try {
        res = await fetch(`https://${a.hostname}/api/attest?nonce=${encodeURIComponent(nonce)}`, {
            cf: { cacheTtl: 0 }, headers: { 'user-agent': 'beanpool-registrar-attest' },
        });
    } catch { return 'unverified'; }                 // connection error → offline
    if (!res.ok) return 'unverified';                // 5xx / 404 / CF "no connector" → offline or ambiguous
    try {                                            // got a 2xx: must be a valid attest, else non-beanpool content
        const j = await res.json();
        const ts = parseInt(j.timestamp, 10);
        if ((j.pubkey || '').toLowerCase() === a.node_pubkey && j.nonce === nonce &&
            ts && Math.abs(nowS() - ts) <= 120 &&
            await verifyEd25519(a.node_pubkey, `${nonce}\n${j.timestamp}`, j.signature || '')) {
            return 'ok';
        }
    } catch { /* not JSON → serving something else */ }
    return 'mismatch';
}

async function handleAttest(env, a, limit) {
    const r = await attestOne(env, a);
    if (r === 'ok') {
        await db.updateAllocation(env, a.name, { attest_fails: 0, last_attest_at: nowS() });
    } else if (r === 'mismatch') {
        const fails = (a.attest_fails || 0) + 1;
        if (fails >= limit) {
            await deprovision(env, a);
            await db.updateAllocation(env, a.name, { status: 'revoked', attest_fails: fails });
        } else {
            await db.updateAllocation(env, a.name, { attest_fails: fails });
        }
    }
    // 'unverified' (offline/ambiguous): do nothing — never auto-revoke a node just for being down.
    // last_attest_at stays old, which the admin console surfaces as "unverified since …" for review.
}

export async function attestSweep(env) {
    const limit = parseInt(env.ATTEST_FAIL_LIMIT || '2', 10);   // consecutive MISMATCHES before revoke
    const live = await db.listByStatus(env, 'live');
    const BATCH = 10;                                           // bounded concurrency — don't hit the cron's wall-clock/subrequest limits at scale
    for (let i = 0; i < live.length; i += BATCH) {
        await Promise.all(live.slice(i, i + BATCH).map((a) => handleAttest(env, a, limit)));
    }
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const p = url.pathname;
        const method = request.method;
        try {
            if (method === 'GET' && p === '/api/registrar/health') return json({ status: 'ok' });
            if (method === 'GET' && p === '/api/registrar/available') return await handleAvailable(url, env);
            if (method === 'POST' && p === '/api/registrar/claim') return await handleClaim(request, env, await request.text());
            if (method === 'GET' && p === '/api/registrar/status') return await handleStatus(request, env);
            if (method === 'POST' && p === '/api/registrar/update') return await handleUpdate(request, env, await request.text());
            if (method === 'POST' && p === '/api/registrar/offline') return await handleOffline(request, env, await request.text());

            if (method === 'GET' && p === '/api/local/admin/registrar/pending') {
                if (!await checkAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
                return json({ allocations: await db.listActive(env) });
            }
            const m = p.match(/^\/api\/local\/admin\/registrar\/([a-z0-9-]{3,32})\/(approve|revoke)$/);
            if (m && method === 'POST') {
                if (!await checkAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
                return m[2] === 'approve' ? await handleAdminApprove(env, m[1]) : await handleAdminRevoke(env, m[1]);
            }

            if (method === 'GET' && (p === '/admin' || p === '/admin/' || p === '/admin.html')) {
                return new Response(ADMIN_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
            }

            if (method === 'GET' && p.startsWith('/i/')) return await handleSwitchboard(url, env);

            return json({ error: 'not found' }, 404);
        } catch (e) {
            return json({ error: 'internal', detail: String(e.message || e) }, 500);
        }
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(attestSweep(env));
    },
};
