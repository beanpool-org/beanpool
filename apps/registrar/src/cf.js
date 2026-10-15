// Cloudflare API client. createTunnel / getTunnelToken / setTunnelIngress / POST dns_records / the two DELETEs
// are the calls validated live in Phase 0 (scratchpad/cf-phase0.sh, 2026-07-27). getTunnel, findDnsRecord and
// patchDnsRecord (idempotent `ensure`, 2026-09-25) and listTunnelsNamed (registrar PR 1b) follow the documented v4
// shapes but were NOT exercised live when written — validate them with a scratch name before relying on them
// (design §10). So is the code a duplicate tunnel name is refused with (1013, tunnelNameTaken).
// Auth: a scoped token (Account·Cloudflare Tunnel·Edit + Zone·DNS·Edit) as env.CF_API_TOKEN.

const API = 'https://api.cloudflare.com/client/v4';

async function cf(env, method, path, body) {
    const headers = (env.CF_EMAIL && env.CF_API_KEY)
        ? { 'X-Auth-Email': env.CF_EMAIL, 'X-Auth-Key': env.CF_API_KEY, 'Content-Type': 'application/json' }
        : { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' };
    const res = await fetch(`${API}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
    let data;
    try { data = await res.json(); } catch { data = { success: false, errors: [`non-JSON ${res.status}`] }; }
    if (!data.success) {
        const err = new Error(`CF ${method} ${path} → ${JSON.stringify(data.errors)}`);
        err.status = res.status;
        err.codes = (Array.isArray(data.errors) ? data.errors : []).map((x) => x?.code).filter((c) => c !== undefined);
        throw err;
    }
    return data.result;
}

// --- Tunnel mode (Case A) ---
export const createTunnel = (env, name) =>
    cf(env, 'POST', `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel`, { name, config_src: 'cloudflare' });

// Cloudflare refused createTunnel because a live tunnel already has that name.
export const tunnelNameTaken = (e) => !!e && (e.codes?.includes(1013) || e.status === 409);

// The live (not deleted) tunnels named `name`: { id, name, created_at, … }.
export async function listTunnelsNamed(env, name) {
    const list = await cf(env, 'GET', `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`);
    return (Array.isArray(list) ? list : []).filter((t) => t && t.name === name && !t.deleted_at);
}

// The tunnel, or null if Cloudflare no longer has it (404, or deleted — a deleted tunnel is still listed with
// `deleted_at`). Any other failure throws: "can't tell" must never read as "gone" and mint a second tunnel.
export async function getTunnel(env, id) {
    try {
        const t = await cf(env, 'GET', `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${id}`);
        return t && !t.deleted_at ? t : null;
    } catch (e) {
        if (e.status === 404) return null;
        throw e;
    }
}

// Returns the connector token STRING (result is the token itself).
export const getTunnelToken = (env, id) =>
    cf(env, 'GET', `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${id}/token`);

export const setTunnelIngress = (env, id, hostname, origin) =>
    cf(env, 'PUT', `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${id}/configurations`, {
        config: {
            ingress: [
                // noTLSVerify: nodes serve HTTPS with a self-signed/internal cert on the loopback;
                // Cloudflare terminates TLS at the edge, so the origin hop needn't verify.
                { hostname, service: origin, originRequest: { noTLSVerify: true } },
                { service: 'http_status:404' },
            ],
        },
    });

// cascade=true also tears down active connections/configs — a live tunnel won't delete otherwise.
export const deleteTunnel = (env, id) =>
    cf(env, 'DELETE', `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${id}?cascade=true`);

// --- DNS (both modes) ---
// `rec` = { type: 'CNAME' | 'A', content, proxied }. POST takes the label; Cloudflare appends the zone.
export const createDnsRecord = (env, label, rec) =>
    cf(env, 'POST', `/zones/${env.CF_ZONE_ID}/dns_records`, { type: rec.type, name: label, content: rec.content, proxied: rec.proxied });

// The routing record at `fqdn` (CNAME, A or AAAA), or null.
export async function findDnsRecord(env, fqdn) {
    const list = await cf(env, 'GET', `/zones/${env.CF_ZONE_ID}/dns_records?name=${encodeURIComponent(fqdn)}`);
    return (Array.isArray(list) ? list : []).find((r) => ['CNAME', 'A', 'AAAA'].includes(r.type)) || null;
}

// Content and proxied only; ensure() replaces a record whose type must change (Cloudflare won't PATCH a type).
export const patchDnsRecord = (env, id, rec) =>
    cf(env, 'PATCH', `/zones/${env.CF_ZONE_ID}/dns_records/${id}`, { type: rec.type, content: rec.content, proxied: rec.proxied });

export const deleteDnsRecord = (env, id) =>
    cf(env, 'DELETE', `/zones/${env.CF_ZONE_ID}/dns_records/${id}`);
