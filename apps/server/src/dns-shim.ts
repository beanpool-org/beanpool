/**
 * DNS Shim — Captive Portal Resolution
 *
 * A lightweight DNS responder that resolves `beanpool.local`
 * to the BeanPool node's own IP address.
 *
 * The Wi-Fi router should be configured to point its
 * "Primary DNS" to the BeanPool node's LAN IP so that
 * phones hitting `beanpool.local` land here.
 *
 * All other queries are forwarded to a real upstream DNS (8.8.8.8).
 */

import dgram from 'node:dgram';
import os from 'node:os';

const DNS_PORT = 53;
const UPSTREAM_DNS = '8.8.8.8';
const LOCAL_DOMAIN = 'beanpool.local';
const UPSTREAM_TIMEOUT_MS = 5000;

/**
 * A2-24: only LAN/loopback clients may use this resolver/forwarder. The shim is a
 * captive-portal helper for the local network; left open to the public internet it
 * is an open recursive forwarder (DNS amplification/reflection). Restrict by source
 * address (RFC-1918 + link-local + loopback).
 */
function isPrivateSource(addr: string): boolean {
    const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr; // unwrap IPv4-mapped IPv6
    if (a === '127.0.0.1' || a === '::1' || a === 'localhost') return true;
    if (a.startsWith('10.') || a.startsWith('192.168.')) return true;
    if (a.startsWith('169.254.')) return true; // link-local
    const m = a.match(/^172\.(\d+)\./); // 172.16.0.0 – 172.31.255.255
    if (m) { const o = Number(m[1]); if (o >= 16 && o <= 31) return true; }
    if (a.startsWith('fe80:') || a.startsWith('fc') || a.startsWith('fd')) return true; // IPv6 link-local / ULA
    return false;
}

/** Test-only export of the A2-24 source-address policy. */
export const __test_isPrivateSource = isPrivateSource;

/**
 * Get the first non-internal IPv4 address of this machine.
 */
function getLocalIp(): string {
    const interfaces = os.networkInterfaces();
    for (const ifaces of Object.values(interfaces)) {
        if (!ifaces) continue;
        for (const iface of ifaces) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

/**
 * Parse a DNS question name from a buffer.
 * DNS names are encoded as length-prefixed labels.
 */
function parseDnsName(buf: Buffer, offset: number): { name: string; nextOffset: number } {
    const labels: string[] = [];
    let i = offset;
    while (i < buf.length) {
        const len = buf[i];
        if (len === 0) { i++; break; }
        i++;
        labels.push(buf.subarray(i, i + len).toString('ascii'));
        i += len;
    }
    return { name: labels.join('.'), nextOffset: i };
}

/**
 * Build a minimal DNS A-record response.
 */
function buildResponse(query: Buffer, ip: string): Buffer {
    const ipParts = ip.split('.').map(Number);

    // Copy the query header and flip flags
    const response = Buffer.alloc(query.length + 16);
    query.copy(response, 0, 0, query.length);

    // Set QR (response) flag and recursion available
    response[2] = 0x81; // QR=1, Opcode=0, AA=0, TC=0, RD=1
    response[3] = 0x80; // RA=1, Z=0, RCODE=0

    // Answer count = 1
    response[6] = 0x00;
    response[7] = 0x01;

    // Append the answer section after the query
    let offset = query.length;

    // Name pointer to the question
    response[offset++] = 0xc0;
    response[offset++] = 0x0c;

    // Type A (1)
    response[offset++] = 0x00;
    response[offset++] = 0x01;

    // Class IN (1)
    response[offset++] = 0x00;
    response[offset++] = 0x01;

    // TTL = 60 seconds
    response[offset++] = 0x00;
    response[offset++] = 0x00;
    response[offset++] = 0x00;
    response[offset++] = 0x3c;

    // RDLENGTH = 4
    response[offset++] = 0x00;
    response[offset++] = 0x04;

    // RDATA (IP address)
    for (const part of ipParts) {
        response[offset++] = part;
    }

    return response.subarray(0, offset);
}

export function startDnsShim(): void {
    const localIp = getLocalIp();
    const server = dgram.createSocket('udp4');

    server.on('message', (msg, rinfo) => {
        // A2-24: ignore queries from non-LAN sources so the node can't be abused as
        // an open recursive forwarder (amplification/reflection) if :53 is exposed.
        if (!isPrivateSource(rinfo.address)) return;

        // Parse the queried domain name (starts at byte 12)
        const { name } = parseDnsName(msg, 12);

        if (name.toLowerCase() === LOCAL_DOMAIN) {
            // Respond with our own IP
            const response = buildResponse(msg, localIp);
            server.send(response, rinfo.port, rinfo.address);
            return;
        }

        // Forward everything else to upstream DNS. A2-24: register the reply
        // handler BEFORE sending and bound the socket with a timeout, so a query
        // that never gets an upstream reply can't leak a socket + listener per query.
        const upstream = dgram.createSocket('udp4');
        let settled = false;
        const cleanup = () => { if (settled) return; settled = true; clearTimeout(t); try { upstream.close(); } catch { /* */ } };
        const t = setTimeout(cleanup, UPSTREAM_TIMEOUT_MS);
        upstream.on('message', (reply) => { server.send(reply, rinfo.port, rinfo.address); cleanup(); });
        upstream.on('error', cleanup);
        upstream.send(msg, 53, UPSTREAM_DNS, (err) => { if (err) cleanup(); });
    });

    server.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'EACCES') {
            console.warn('⚠️  DNS shim requires port 53 (privileged). Use: sudo iptables -t nat -A PREROUTING -p udp --dport 53 -j REDIRECT --to-port 5353');
            console.warn('   Falling back to port 5353...');
            server.bind(5353, '0.0.0.0');
            return;
        }
        console.error('DNS shim error:', err);
    });

    try {
        server.bind(DNS_PORT, '0.0.0.0', () => {
            console.log(`📡 DNS shim listening on :${DNS_PORT} → ${LOCAL_DOMAIN} → ${localIp}`);
        });
    } catch {
        server.bind(5353, '0.0.0.0', () => {
            console.log(`📡 DNS shim listening on :5353 (fallback) → ${LOCAL_DOMAIN} → ${localIp}`);
        });
    }
}
