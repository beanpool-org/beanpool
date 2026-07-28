// Cloudflare API client — the exact calls validated live in Phase 0 (scratchpad/cf-phase0.sh, 2026-07-27).
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
    if (!data.success) throw new Error(`CF ${method} ${path} → ${JSON.stringify(data.errors)}`);
    return data.result;
}

// --- Tunnel mode (Case A) ---
export const createTunnel = (env, name) =>
    cf(env, 'POST', `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel`, { name, config_src: 'cloudflare' });

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

export const routeHostname = (env, label, tunnelId) =>
    cf(env, 'POST', `/zones/${env.CF_ZONE_ID}/dns_records`, {
        type: 'CNAME', name: label, content: `${tunnelId}.cfargotunnel.com`, proxied: true,
    });

// cascade=true also tears down active connections/configs — a live tunnel won't delete otherwise.
export const deleteTunnel = (env, id) =>
    cf(env, 'DELETE', `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${id}?cascade=true`);

// --- Direct mode (Case B) ---
export const createARecord = (env, label, ip, proxied = true) =>
    cf(env, 'POST', `/zones/${env.CF_ZONE_ID}/dns_records`, { type: 'A', name: label, content: ip, proxied });

// --- Shared ---
export const deleteDnsRecord = (env, id) =>
    cf(env, 'DELETE', `/zones/${env.CF_ZONE_ID}/dns_records/${id}`);
