/**
 * A name server that answers for Google's map servers and for nothing else (DESIGN-app-screenshots-fable.md §3: the Map shot
 * needs real map tiles, and a phone with no DNS draws a grey page). The capture driver starts the emulator with this as its
 * DNS (`-dns-server 127.0.0.1`), so the one thing the phone can name is Google's tile servers; BeanPool's own names (beanpool.org,
 * every <name>.beanpool.org, the registrar, the global node, GitHub) get NXDOMAIN and the app cannot reach any live node.
 * The demo node and Metro reach the phone by `adb reverse`, which needs no name at all.
 *
 * Port 53 on all interfaces: macOS lets an ordinary user bind that (not 127.0.0.1:53 alone). If it is taken the driver says so
 * and runs with no DNS, and the Map is then drawn without tiles.
 */
import dgram from 'node:dgram';
import fs from 'node:fs';

/** Names the phone may resolve: these suffixes, and any name under them. */
export const ALLOWED_SUFFIXES = ['googleapis.com', 'gstatic.com', 'google.com', 'googleusercontent.com', 'ggpht.com', 'gvt1.com', 'gvt2.com'];

/** The name a DNS query asks for ("tile.googleapis.com"), lower case; null for a packet that is not a one-question query. */
export function questionName(packet) {
    if (packet.length < 17 || packet.readUInt16BE(4) !== 1) return null;
    const labels = [];
    let at = 12;
    for (;;) {
        const len = packet[at];
        if (len === undefined) return null;
        if (len === 0) break;
        if (len & 0xc0) return null; // a compressed name has no place in a question
        if (at + 1 + len > packet.length) return null;
        labels.push(packet.toString('latin1', at + 1, at + 1 + len));
        at += 1 + len;
    }
    return labels.join('.').toLowerCase();
}

export const isAllowed = (name) => !!name && ALLOWED_SUFFIXES.some((s) => name === s || name.endsWith(`.${s}`));

/** The answer "no such name": the query's own id and question, QR and RA set, RCODE 3, no records. */
export function nxdomain(packet) {
    let end = 12;
    while (packet[end] !== 0) end += 1 + packet[end];
    end += 5; // the root label, then QTYPE and QCLASS
    const reply = Buffer.from(packet.subarray(0, end));
    const rd = packet.readUInt16BE(2) & 0x0100;
    reply.writeUInt16BE(0x8000 | rd | 0x0080 | 3, 2);
    reply.writeUInt16BE(1, 4);
    reply.writeUInt16BE(0, 6);
    reply.writeUInt16BE(0, 8);
    reply.writeUInt16BE(0, 10);
    return reply;
}

/** The first name server in /etc/resolv.conf, else Google's. */
export function systemResolver() {
    try {
        const m = fs.readFileSync('/etc/resolv.conf', 'utf8').match(/^nameserver\s+(\d+\.\d+\.\d+\.\d+)/m);
        if (m) return m[1];
    } catch { /* none */ }
    return '8.8.8.8';
}

/**
 * Listen and answer. `upstream` is { host, port } (default: the system's resolver on 53). Answers { port, asked, close } where
 * `asked` is [{ name, allowed }] for every question so far, the evidence of what the phone tried to reach.
 */
export async function startDnsFilter({ port = 53, upstream = { host: systemResolver(), port: 53 } } = {}) {
    const server = dgram.createSocket('udp4');
    const asked = [];
    server.on('message', (packet, from) => {
        const name = questionName(packet);
        const allowed = isAllowed(name);
        asked.push({ name: name ?? '(unreadable)', allowed });
        if (!allowed) {
            if (name) server.send(nxdomain(packet), from.port, from.address);
            return;
        }
        const out = dgram.createSocket('udp4');
        const timer = setTimeout(() => out.close(), 5000);
        out.on('message', (answer) => { server.send(answer, from.port, from.address); clearTimeout(timer); out.close(); });
        out.on('error', () => { clearTimeout(timer); out.close(); });
        out.send(packet, upstream.port, upstream.host);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.bind(port, resolve); });
    server.on('error', () => { /* a stray packet is not a reason to stop the run */ });
    return { port: server.address().port, asked, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
