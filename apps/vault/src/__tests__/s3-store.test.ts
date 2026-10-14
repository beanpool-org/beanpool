import crypto from 'node:crypto';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { OffsiteError, OffsiteNotFound, S3Store, signV4, uriEncode } from '../api/s3-store.js';
import { parseSettings } from '../shared/settings.js';
import { StubS3 } from './stubs.js';

/**
 * The off-box store's client (s3-store.ts): its Signature Version 4 against the examples AWS publishes for S3 (so the
 * stub that checks every request in the other suites checks against a signer known to be right), and the four calls
 * against that stub, listing included across pages.
 */

const AWS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', amzDate: '20130524T000000Z' };
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const HOST = 'examplebucket.s3.amazonaws.com';

const stubs: StubS3[] = [];
afterEach(async () => {
    while (stubs.length) await stubs.pop()!.stop();
});

describe('Signature Version 4: AWS\'s own S3 examples', () => {
    it('GET Object (a Range header)', () => {
        const r = signV4({ ...AWS, method: 'GET', path: '/test.txt', payloadSha256: EMPTY, headers: { host: HOST, range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY, 'x-amz-date': AWS.amzDate } });
        expect(r.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
            + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    });

    it('PUT Object (a name that needs encoding, a payload)', () => {
        const payload = crypto.createHash('sha256').update('Welcome to Amazon S3.').digest('hex');
        expect(payload).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
        const r = signV4({
            ...AWS, method: 'PUT', path: `/${uriEncode('test$file.text', true)}`, payloadSha256: payload, headers: {
                date: 'Fri, 24 May 2013 00:00:00 GMT', host: HOST, 'x-amz-content-sha256': payload, 'x-amz-date': AWS.amzDate, 'x-amz-storage-class': 'REDUCED_REDUNDANCY',
            },
        });
        expect(r.authorization).toMatch(/SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd$/);
    });

    it('GET Bucket lifecycle (a parameter with no value) and List Objects (parameters sorted)', () => {
        const headers = { host: HOST, 'x-amz-content-sha256': EMPTY, 'x-amz-date': AWS.amzDate };
        expect(signV4({ ...AWS, method: 'GET', path: '/', query: { lifecycle: '' }, payloadSha256: EMPTY, headers }).authorization)
            .toMatch(/Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543$/);
        expect(signV4({ ...AWS, method: 'GET', path: '/', query: { prefix: 'J', 'max-keys': '2' }, payloadSha256: EMPTY, headers }).authorization)
            .toMatch(/Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/);
    });
});

describe('the store', () => {
    async function store(pageSize = 1000) {
        const stub = await new StubS3().start();
        stub.pageSize = pageSize;
        stubs.push(stub);
        const settings = parseSettings({ v: 1, offsite: stub.settings('a/b/') });
        return { stub, s3: new S3Store(settings.offsite!) };
    }

    it('puts, gets, lists across pages (only backup names under its prefix, oldest first) and deletes', async () => {
        const { stub, s3 } = await store(2);
        const names = ['bv-20261001T120000Z.bin', 'bv-20261001T110000Z-1.bin', 'bv-20261001T110000Z.bin', 'bv-20260930T120000Z.bin', 'bv-20261002T000000Z.bin'];
        for (const [i, n] of names.entries()) await s3.put(n, Buffer.from(`backup ${i}`));
        stub.objects.set('a/b/notes.txt', Buffer.from('someone else\'s'));
        stub.objects.set('other/bv-20261001T130000Z.bin', Buffer.from('another prefix'));
        expect(await s3.list()).toEqual(['bv-20260930T120000Z.bin', 'bv-20261001T110000Z.bin', 'bv-20261001T110000Z-1.bin', 'bv-20261001T120000Z.bin', 'bv-20261002T000000Z.bin']);
        expect(stub.requests.filter(r => r.url.includes('list-type=2')).length).toBe(3);
        expect((await s3.get('bv-20261001T120000Z.bin')).toString()).toBe('backup 0');
        await s3.delete('bv-20261001T120000Z.bin');
        await expect(s3.get('bv-20261001T120000Z.bin')).rejects.toBeInstanceOf(OffsiteNotFound);
        expect([...stub.objects.keys()].sort()).toContain('a/b/notes.txt');
        // Every object is the backup's name under the prefix, with nothing of its own: no metadata header on any request.
        for (const r of stub.requests) expect(Object.keys(r.headers).filter(h => h.startsWith('x-amz-meta-'))).toEqual([]);
    });

    it('a wrong secret, a store that is down, and nothing listening: a short error, never a body, key or address', async () => {
        const { stub } = await store();
        const wrong = new S3Store(parseSettings({ v: 1, offsite: { ...stub.settings(), secretAccessKey: 'not-the-secret' } }).offsite!);
        await expect(wrong.put('bv-20261001T120000Z.bin', Buffer.from('x'))).rejects.toMatchObject({ short: 'HTTP 403 SignatureDoesNotMatch' });
        stub.failWith = 500;
        const s3 = new S3Store(parseSettings({ v: 1, offsite: stub.settings() }).offsite!);
        await expect(s3.list()).rejects.toMatchObject({ short: 'HTTP 500 InternalError' });
        // A redirect is not followed: the signed request goes to the store set, or nowhere.
        stub.failWith = 307;
        const before = stub.requests.length;
        await expect(s3.put('bv-20261001T120000Z.bin', Buffer.from('x'))).rejects.toMatchObject({ short: 'HTTP 307 InternalError' });
        expect(stub.requests.length).toBe(before + 1);
        await stub.stop();
        stubs.length = 0;
        // The store just went down: fetch may try its pooled keep-alive socket (reset) or a new connection (refused).
        const e = await s3.put('bv-20261001T120000Z.bin', Buffer.from('x')).catch(err => err as OffsiteError);
        expect(e).toBeInstanceOf(OffsiteError);
        expect((e as OffsiteError).short).toMatch(/^unreachable \((ECONNREFUSED|ECONNRESET|UND_ERR_SOCKET)\)$/);
        expect((e as OffsiteError).message).not.toMatch(/127\.0\.0\.1|stub-secret|AKID/);
        // Nothing has ever listened on this port, so there is no pooled socket: always refused.
        const unused = net.createServer();
        await new Promise<void>(resolve => unused.listen(0, '127.0.0.1', resolve));
        const port = (unused.address() as AddressInfo).port;
        await new Promise<void>(resolve => unused.close(() => resolve()));
        const nowhere = new S3Store(parseSettings({ v: 1, offsite: { ...stub.settings(), endpoint: `http://127.0.0.1:${port}` } }).offsite!);
        const refused = await nowhere.put('bv-20261001T120000Z.bin', Buffer.from('x')).catch(err => err as OffsiteError);
        expect(refused).toBeInstanceOf(OffsiteError);
        expect((refused as OffsiteError).short).toBe('unreachable (ECONNREFUSED)');
        expect((refused as OffsiteError).message).not.toMatch(/127\.0\.0\.1|stub-secret|AKID/);
        expect((refused as OffsiteError).message).not.toContain(`:${port}`);
    });

    it('a connection that fails says its code (ECONNRESET), never its message; a code that is not a plain word is left out', async () => {
        const { stub } = await store();
        const settings = parseSettings({ v: 1, offsite: stub.settings() }).offsite!;
        const failing = (cause: unknown) => new S3Store(settings, { fetch: async () => { throw Object.assign(new TypeError('fetch failed'), { cause }); } });
        const reset = Object.assign(new Error(`read ECONNRESET ${stub.endpoint}`), { code: 'ECONNRESET' });
        await expect(failing(reset).put('bv-20261001T120000Z.bin', Buffer.from('x'))).rejects.toMatchObject({ short: 'unreachable (ECONNRESET)' });
        await expect(failing({ code: 'UND_ERR_SOCKET' }).list()).rejects.toMatchObject({ short: 'unreachable (UND_ERR_SOCKET)' });
        await expect(failing({ code: `ENOTFOUND ${stub.endpoint}` }).delete('bv-20261001T120000Z.bin')).rejects.toMatchObject({ short: 'unreachable' });
        await expect(failing(undefined).get('bv-20261001T120000Z.bin')).rejects.toMatchObject({ short: 'unreachable' });
    });

    it('takes only backup names', async () => {
        const { s3 } = await store();
        await expect(s3.put('../escape.bin', Buffer.from('x'))).rejects.toMatchObject({ short: 'not a backup name' });
    });
});
