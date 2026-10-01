import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { signV4 } from '../api/s3-store.js';

/**
 * Stand-ins on this machine for what the vault reaches off the box, so no test contacts a real store, mail server or
 * webhook: an S3-compatible store that checks every request's Signature Version 4 (with s3-store.ts's signer, which
 * s3-store.test.ts checks against AWS's own examples), a mail server that speaks STARTTLS or TLS from the first byte,
 * and a webhook. Each records everything it was sent, for the tests to look through.
 */

// ─── S3 ──────────────────────────────────────────────────────────────────────────────────────

export interface S3Request {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
}

export class StubS3 {
    readonly objects = new Map<string, Buffer>();
    readonly requests: S3Request[] = [];
    /** Answer every request with this status (a store that is down or refuses), when set. */
    failWith: number | null = null;
    /** Objects per listing page, to make the vault follow continuation tokens. */
    pageSize = 1000;
    private server: http.Server | null = null;
    endpoint = '';

    constructor(readonly bucket = 'vault-backups', readonly accessKeyId = 'AKIDSTUB', readonly secretAccessKey = 'stub-secret-key-0123456789') {}

    async start(): Promise<this> {
        this.server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', () => this.handle(req, Buffer.concat(chunks), res));
        });
        await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
        this.endpoint = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
        return this;
    }

    async stop(): Promise<void> {
        await new Promise<void>(resolve => {
            this.server?.closeAllConnections();
            this.server?.close(() => resolve());
        });
    }

    settings(prefix = 'vault/') {
        return { kind: 's3', endpoint: this.endpoint, region: 'auto', bucket: this.bucket, prefix, accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey };
    }

    private error(res: http.ServerResponse, status: number, code: string): void {
        res.writeHead(status, { 'Content-Type': 'application/xml' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>stub</Message></Error>`);
    }

    private handle(req: http.IncomingMessage, body: Buffer, res: http.ServerResponse): void {
        this.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        if (this.failWith) return this.error(res, this.failWith, 'InternalError');
        const url = new URL(req.url ?? '/', 'http://stub');
        const query: Record<string, string> = {};
        for (const [k, v] of url.searchParams) query[k] = v;
        const auth = String(req.headers.authorization ?? '');
        const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
        if (!m || m[1] !== this.accessKeyId) return this.error(res, 403, 'InvalidAccessKeyId');
        const signed: Record<string, string> = {};
        for (const h of m[4].split(';')) signed[h] = String(req.headers[h] ?? '');
        const payload = String(req.headers['x-amz-content-sha256'] ?? '');
        const expected = signV4({
            method: req.method ?? '', path: url.pathname, query, headers: signed, payloadSha256: payload, accessKeyId: this.accessKeyId,
            secretAccessKey: this.secretAccessKey, region: m[3], amzDate: String(req.headers['x-amz-date'] ?? ''),
        });
        if (!expected.authorization.endsWith(`Signature=${m[5]}`)) return this.error(res, 403, 'SignatureDoesNotMatch');
        if (req.method === 'PUT' && payload !== crypto.createHash('sha256').update(body).digest('hex')) return this.error(res, 400, 'XAmzContentSHA256Mismatch');

        const parts = url.pathname.split('/').slice(1).map(decodeURIComponent);
        if (parts[0] !== this.bucket) return this.error(res, 404, 'NoSuchBucket');
        const key = parts.slice(1).join('/');
        if (req.method === 'GET' && !key && query['list-type'] === '2') {
            const prefix = query.prefix ?? '';
            const all = [...this.objects.keys()].filter(k => k.startsWith(prefix)).sort();
            const start = query['continuation-token'] ? Number(query['continuation-token']) : 0;
            const page = all.slice(start, start + this.pageSize);
            const more = start + this.pageSize < all.length;
            const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
            res.writeHead(200, { 'Content-Type': 'application/xml' });
            res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${this.bucket}</Name><Prefix>${esc(prefix)}</Prefix>`
                + page.map(k => `<Contents><Key>${esc(k)}</Key><Size>${this.objects.get(k)!.length}</Size></Contents>`).join('')
                + `<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + this.pageSize}</NextContinuationToken>` : ''}</ListBucketResult>`);
            return;
        }
        if (req.method === 'PUT' && key) {
            this.objects.set(key, body);
            res.writeHead(200);
            res.end();
            return;
        }
        if (req.method === 'GET' && key) {
            const o = this.objects.get(key);
            if (!o) return this.error(res, 404, 'NoSuchKey');
            res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
            res.end(o);
            return;
        }
        if (req.method === 'DELETE' && key) {
            this.objects.delete(key);
            res.writeHead(204);
            res.end();
            return;
        }
        this.error(res, 400, 'NotImplemented');
    }
}

// ─── Mail ────────────────────────────────────────────────────────────────────────────────────

/** A throwaway certificate for 127.0.0.1 and localhost, made with openssl for this run (no key is kept in the repo). */
export function testCertificate(): { key: string; cert: string } {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bv-cert-'));
    try {
        const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
            '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost',
            '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`openssl could not make a test certificate: ${r.stderr}`);
        return { key: readFileSync(path.join(dir, 'k.pem'), 'utf8'), cert: readFileSync(path.join(dir, 'c.pem'), 'utf8') };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

export interface Mail {
    from: string;
    to: string[];
    data: string;
    authUser: string | null;
    tls: boolean;
}

/**
 * An SMTP server: `starttls` (offered, then required before AUTH), `tls` (TLS from the first byte), or `plain` (offers
 * no STARTTLS: the vault must refuse to go on). It takes AUTH PLAIN with one user, and records every message and every
 * line it was sent.
 */
export class StubSmtp {
    readonly mails: Mail[] = [];
    readonly transcript: string[] = [];
    /** Refuse every message with this code (a server that won't take it), when set. */
    failWith: number | null = null;
    port = 0;
    private server: net.Server | tls.Server | null = null;
    private readonly sockets = new Set<net.Socket>();

    constructor(readonly mode: 'starttls' | 'tls' | 'plain', readonly cert: { key: string; cert: string }, readonly user = 'vault', readonly pass = 'mail-password-xyz') {}

    async start(): Promise<this> {
        const onSocket = (s: net.Socket) => this.session(s, this.mode === 'tls');
        this.server = this.mode === 'tls' ? tls.createServer({ key: this.cert.key, cert: this.cert.cert }, onSocket) : net.createServer(onSocket);
        await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
        this.port = (this.server!.address() as AddressInfo).port;
        return this;
    }

    async stop(): Promise<void> {
        for (const s of this.sockets) s.destroy();
        await new Promise<void>(resolve => this.server?.close(() => resolve()));
    }

    channel(to = ['custodian-a@example.org', 'custodian-b@example.org']) {
        return {
            host: '127.0.0.1', port: this.port, security: this.mode === 'tls' ? 'tls' : 'starttls', username: this.user, password: this.pass,
            from: 'vault@example.org', to,
        };
    }

    private session(socket: net.Socket, secure: boolean): void {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('error', () => undefined);
        let s: net.Socket = socket;
        let isTls = secure;
        let buffer = '';
        let inData = false;
        let data: string[] = [];
        let from = '';
        let to: string[] = [];
        let authUser: string | null = null;
        const say = (line: string) => s.write(`${line}\r\n`);
        const onLine = (line: string) => {
            this.transcript.push(line);
            if (inData) {
                if (line === '.') {
                    inData = false;
                    if (this.failWith) return say(`${this.failWith} no`);
                    this.mails.push({ from, to, data: data.join('\n'), authUser, tls: isTls });
                    data = [];
                    return say('250 queued');
                }
                data.push(line.startsWith('..') ? line.slice(1) : line);
                return;
            }
            const cmd = line.split(' ')[0].toUpperCase();
            if (cmd === 'EHLO') {
                const caps = ['250-stub', ...(this.mode !== 'plain' && !isTls ? ['250-STARTTLS'] : []), ...(isTls || this.mode === 'plain' ? ['250-AUTH PLAIN LOGIN'] : []), '250 8BITMIME'];
                return s.write(`${caps.join('\r\n')}\r\n`);
            }
            if (cmd === 'STARTTLS' && !isTls && this.mode === 'starttls') {
                say('220 go ahead');
                s.removeAllListeners('data');
                const upgraded = new tls.TLSSocket(s, { isServer: true, key: this.cert.key, cert: this.cert.cert });
                upgraded.on('error', () => undefined);
                s = upgraded;
                isTls = true;
                buffer = '';
                upgraded.on('data', onData);
                return;
            }
            if (cmd === 'AUTH') {
                const [, method, arg] = line.split(' ');
                if (method?.toUpperCase() !== 'PLAIN' || !arg) return say('504 only PLAIN here');
                const [, user, pass] = Buffer.from(arg, 'base64').toString('utf8').split('\0');
                if (user !== this.user || pass !== this.pass) return say('535 no');
                authUser = user;
                return say('235 ok');
            }
            if (cmd === 'MAIL') {
                from = /<([^>]*)>/.exec(line)?.[1] ?? '';
                to = [];
                return say('250 ok');
            }
            if (cmd === 'RCPT') {
                to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
                return say('250 ok');
            }
            if (cmd === 'DATA') {
                inData = true;
                return say('354 go');
            }
            if (cmd === 'QUIT') {
                say('221 bye');
                s.end();
                return;
            }
            say('502 no');
        };
        const onData = (chunk: Buffer) => {
            buffer += chunk.toString('latin1');
            let at: number;
            while ((at = buffer.indexOf('\r\n')) !== -1) {
                const line = buffer.slice(0, at);
                buffer = buffer.slice(at + 2);
                onLine(line);
            }
        };
        s.on('data', onData);
        say('220 stub ESMTP');
    }
}

// ─── Webhook ─────────────────────────────────────────────────────────────────────────────────

export class StubWebhook {
    readonly posts: { headers: http.IncomingHttpHeaders; body: string }[] = [];
    failWith: number | null = null;
    url = '';
    private server: http.Server | null = null;

    async start(): Promise<this> {
        this.server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', () => {
                this.posts.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
                res.writeHead(this.failWith ?? 200);
                res.end();
            });
        });
        await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
        this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/hook/secret-topic-123`;
        return this;
    }

    async stop(): Promise<void> {
        await new Promise<void>(resolve => {
            this.server?.closeAllConnections();
            this.server?.close(() => resolve());
        });
    }
}
