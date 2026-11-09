/**
 * The Google-only name server the Map's capture run gives the emulator (e2e/demo/dns-filter.mjs): it answers for Google's map
 * servers and gives NXDOMAIN to every other name, BeanPool's included, so the phone can reach no live node. No emulator, no
 * network: the upstream is a fake name server on loopback, and the test fails if BeanPool's names ever reach it.
 */
import { describe, it, expect } from 'vitest';
import dgram from 'node:dgram';
import { ALLOWED_SUFFIXES, isAllowed, nxdomain, questionName, startDnsFilter } from '../dns-filter.mjs';

/** A DNS query for `name` (type A, class IN, recursion wanted), id 0x1234. */
function query(name: string, id = 0x1234): Buffer {
    const labels = name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'latin1')]));
    const head = Buffer.alloc(12);
    head.writeUInt16BE(id, 0);
    head.writeUInt16BE(0x0100, 2);
    head.writeUInt16BE(1, 4);
    return Buffer.concat([head, ...labels, Buffer.from([0, 0, 1, 0, 1])]);
}

/** Send one packet to a UDP port on loopback and wait for the answer (null if none comes in 1.5 s). */
function ask(port: number, packet: Buffer): Promise<Buffer | null> {
    return new Promise((resolve) => {
        const s = dgram.createSocket('udp4');
        const timer = setTimeout(() => { s.close(); resolve(null); }, 1500);
        s.on('message', (m) => { clearTimeout(timer); s.close(); resolve(m); });
        s.send(packet, port, '127.0.0.1');
    });
}

describe('dns-filter: which names', () => {
    it("allows Google's map servers and anything under the allowed suffixes", () => {
        for (const n of ['tile.googleapis.com', 'mobilemaps-pa-gz.googleapis.com', 'www.gstatic.com', 'maps.google.com', 'googleapis.com', 'lh3.googleusercontent.com']) expect(isAllowed(n)).toBe(true);
    });

    it("refuses BeanPool's names, a look-alike, and nothing", () => {
        for (const n of ['beanpool.org', 'global.beanpool.org', 'mullum.beanpool.org', 'api.github.com', 'evilgoogleapis.com', 'googleapis.com.beanpool.org', 'www.youtube.com', '', null]) {
            expect(isAllowed(n as string)).toBe(false);
        }
        expect(ALLOWED_SUFFIXES.some((s: string) => /beanpool/i.test(s))).toBe(false);
    });

    it('reads the name out of a query, lower case, and refuses a packet that is not one', () => {
        expect(questionName(query('Tile.GoogleAPIs.com'))).toBe('tile.googleapis.com');
        expect(questionName(Buffer.alloc(5))).toBeNull();
        const twoQuestions = query('a.com');
        twoQuestions.writeUInt16BE(2, 4);
        expect(questionName(twoQuestions)).toBeNull();
    });
});

describe('dns-filter: the answer "no such name"', () => {
    it('keeps the id and the question, says response + no error-free + NXDOMAIN, and holds no record', () => {
        const q = query('global.beanpool.org', 0xbeef);
        const a: Buffer = nxdomain(q);
        expect(a.readUInt16BE(0)).toBe(0xbeef);
        const flags = a.readUInt16BE(2);
        expect(flags & 0x8000).toBe(0x8000); // QR: a response
        expect(flags & 0x000f).toBe(3); // RCODE: NXDOMAIN
        expect(flags & 0x0100).toBe(0x0100); // RD copied
        expect([a.readUInt16BE(4), a.readUInt16BE(6), a.readUInt16BE(8), a.readUInt16BE(10)]).toEqual([1, 0, 0, 0]);
        expect(a.subarray(12).equals(q.subarray(12))).toBe(true);
    });
});

describe('dns-filter: over UDP', () => {
    it("forwards an allowed name to the upstream and refuses BeanPool's without asking it", async () => {
        const seen: (string | null)[] = [];
        const upstream = dgram.createSocket('udp4');
        upstream.on('message', (m, from) => {
            seen.push(questionName(m));
            const canned = Buffer.from(m);
            canned.writeUInt16BE(0x8180, 2); // a response, no error
            canned.writeUInt16BE(0, 6);
            upstream.send(Buffer.concat([canned, Buffer.from('CANNED')]), from.port, from.address);
        });
        await new Promise<void>((r) => upstream.bind(0, '127.0.0.1', () => r()));
        const filter = await startDnsFilter({ port: 0, upstream: { host: '127.0.0.1', port: upstream.address().port } });
        try {
            const ok: Buffer | null = await ask(filter.port, query('tile.googleapis.com', 7));
            expect(ok).not.toBeNull();
            expect(ok!.readUInt16BE(0)).toBe(7);
            expect(ok!.toString('latin1').endsWith('CANNED')).toBe(true);

            for (const name of ['global.beanpool.org', 'beanpool.org', 'mullum.beanpool.org']) {
                const no: Buffer | null = await ask(filter.port, query(name, 9));
                expect(no).not.toBeNull();
                expect(no!.readUInt16BE(2) & 0x000f).toBe(3);
            }
            // What the phone asked for is on record, with whether it was let through.
            expect(filter.asked.filter((q: { allowed: boolean }) => !q.allowed).map((q: { name: string }) => q.name).sort()).toEqual(['beanpool.org', 'global.beanpool.org', 'mullum.beanpool.org']);
            // And the upstream heard only the Google name: no BeanPool name left the filter.
            expect(seen).toEqual(['tile.googleapis.com']);
        } finally {
            await filter.close();
            upstream.close();
        }
    });
});
