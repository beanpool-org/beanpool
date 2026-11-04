/**
 * Tests only (not a suite): a small APK signed with APK Signature Scheme v2 by a throwaway certificate, and a fake GitHub
 * releases endpoint serving it, for test-apk-on-node.ts. The APK is a real ZIP with one stored entry and a real v2 block
 * (source.android.com/docs/security/features/apksigning/v2), so services/apk-release.ts verifies it as it verifies
 * BeanPool's; a test points the pinned certificate at this one with _setApkSigningCertForTests.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import selfsigned from 'selfsigned';

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const P = (b: Buffer) => Buffer.concat([u32(b.length), b]);
const seq = (items: Buffer[]) => P(Buffer.concat(items.map(P)));

export interface Signer { certPem: string; keyPem: string; certDer: Buffer; certSha256: string }

/** A throwaway RSA signer with a self-signed certificate. */
export function makeSigner(cn: string): Signer {
    const pems = selfsigned.generate([{ name: 'commonName', value: cn }], { keySize: 2048, days: 2, algorithm: 'sha256' });
    const certDer = Buffer.from(new crypto.X509Certificate(pems.cert).raw);
    return { certPem: pems.cert, keyPem: pems.private, certDer, certSha256: crypto.createHash('sha256').update(certDer).digest('hex') };
}

function chunkedSha256(sections: Buffer[]): Buffer {
    const digests: Buffer[] = [];
    for (const s of sections) {
        for (let at = 0; at < s.length; at += 1024 * 1024) {
            const c = s.subarray(at, Math.min(at + 1024 * 1024, s.length));
            digests.push(crypto.createHash('sha256').update(Buffer.from([0xa5])).update(u32(c.length)).update(c).digest());
        }
    }
    return crypto.createHash('sha256').update(Buffer.from([0x5a])).update(u32(digests.length)).update(Buffer.concat(digests)).digest();
}

/** A v2-signed APK of about `bytes` bytes, signed by `signer`. */
export function buildFixtureApk(signer: Signer, bytes = 4096, seed = 'beanpool'): Buffer {
    const name = Buffer.from('AndroidManifest.xml');
    const data = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i++) data[i] = (i * 31 + seed.charCodeAt(i % seed.length)) & 0xff;
    const lfh = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0), u32(bytes), u32(bytes), u16(name.length), u16(0), name]);
    const entries = Buffer.concat([lfh, data]);
    const cd = Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0), u32(bytes), u32(bytes),
        u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(0), name]);
    const eocdWith = (cdOffset: number) => Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(cd.length), u32(cdOffset), u16(0)]);
    const digest = chunkedSha256([entries, cd, eocdWith(entries.length)]);
    const signedData = Buffer.concat([seq([Buffer.concat([u32(0x0103), P(digest)])]), seq([signer.certDer]), seq([])]);
    const signature = crypto.sign('sha256', signedData, signer.keyPem);
    const spki = crypto.createPublicKey(signer.keyPem).export({ type: 'spki', format: 'der' });
    const signerBytes = Buffer.concat([P(signedData), seq([Buffer.concat([u32(0x0103), P(signature)])]), P(spki)]);
    const v2 = seq([signerBytes]);
    const pairs = Buffer.concat([u64(4 + v2.length), u32(0x7109871a), v2]);
    const blockSize = pairs.length + 8 + 16;
    const block = Buffer.concat([u64(blockSize), pairs, u64(blockSize), Buffer.from('APK Sig Block 42', 'latin1')]);
    return Buffer.concat([entries, block, cd, eocdWith(entries.length + block.length)]);
}

export const sha256Hex = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** One release the fake endpoint lists: android-v<version> with the APK `apk`, its notes giving `notesSha256`. */
export interface FakeRelease { version: string; code: number; apk: Buffer; notesSha256?: string; draft?: boolean; prerelease?: boolean }

/** A fake GitHub releases endpoint on loopback: GET /releases, and each asset at /download/<tag>/<file> by way of a redirect. */
export async function fakeGitHub(): Promise<{
    base: string; releases: FakeRelease[]; requests: string[]; redirectTo: string | null; close(): Promise<void>;
    source(): { releasesUrl: string; assetUrlOk(url: string, tag: string, file: string): boolean; hopOk(url: string): boolean };
}> {
    const state = { releases: [] as FakeRelease[], requests: [] as string[], redirectTo: null as string | null };
    const server = http.createServer((req, res) => {
        state.requests.push(req.url ?? '');
        if (req.url === '/releases') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(state.releases.map((r) => ({
                tag_name: `android-v${r.version}`, draft: !!r.draft, prerelease: !!r.prerelease,
                body: `| File | \`BeanPool-${r.version}-${r.code}.apk\` |\n| File SHA-256 | \`${r.notesSha256 ?? sha256Hex(r.apk)}\` |\n`,
                assets: [{ name: `BeanPool-${r.version}-${r.code}.apk`, size: r.apk.length,
                    browser_download_url: `${base}/download/android-v${r.version}/BeanPool-${r.version}-${r.code}.apk` }],
            }))));
            return;
        }
        const dl = /^\/download\/android-v([\d.]+)\/BeanPool-[\d.]+-(\d+)\.apk$/.exec(req.url ?? '');
        if (dl) {
            res.statusCode = 302;
            res.setHeader('Location', state.redirectTo ?? `/blob/${dl[1]}/${dl[2]}`);
            res.end();
            return;
        }
        const blob = /^\/blob\/([\d.]+)\/(\d+)$/.exec(req.url ?? '');
        const r = blob && state.releases.find((x) => x.version === blob[1] && String(x.code) === blob[2]);
        if (r) { res.setHeader('Content-Length', String(r.apk.length)); res.end(r.apk); return; }
        res.statusCode = 404;
        res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
        base,
        get releases() { return state.releases; },
        set releases(v) { state.releases = v; },
        get requests() { return state.requests; },
        get redirectTo() { return state.redirectTo; },
        set redirectTo(v) { state.redirectTo = v; },
        close: () => new Promise<void>((r) => server.close(() => r())),
        source: () => ({
            releasesUrl: `${base}/releases`,
            assetUrlOk: (url: string, tag: string, file: string) => url === `${base}/download/${tag}/${file}`,
            hopOk: (url: string) => url.startsWith(`${base}/`),
        }),
    };
}
