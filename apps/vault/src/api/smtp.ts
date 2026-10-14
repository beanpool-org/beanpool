import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import type { EmailChannel } from '../shared/settings.js';

/**
 * Just enough SMTP to send the vault's alerts (RFC 5321): over TLS from the first byte (port 465), or STARTTLS (587)
 * with the connection refused if the server won't upgrade. A password never goes over a connection that isn't TLS,
 * and the server's certificate is checked against its name. AUTH PLAIN, or LOGIN when that is all the server offers.
 *
 * The message is plain ASCII text (anything else becomes '?'): the alerts' words are the vault's own, with nothing of
 * any member in them. An error says the step and the server's reply code, never the reply's text (it goes into the
 * public report).
 */

const TIMEOUT_MS = 30_000;

export class SmtpError extends Error {
    constructor(readonly short: string) {
        super(short);
        this.name = 'SmtpError';
    }
}

export interface MailMessage {
    subject: string;
    text: string;
    date: number;
}

interface Reply {
    code: number;
    lines: string[];
}

/** Lines in, replies out: a reply ends at a line whose code is followed by a space. */
class Conversation {
    private buffer = '';
    private lines: string[] = [];
    private waiting: (() => void) | null = null;
    private closed: Error | null = null;

    constructor(public socket: net.Socket | tls.TLSSocket) {
        this.listen(socket);
    }

    listen(socket: net.Socket | tls.TLSSocket): void {
        this.socket = socket;
        this.buffer = '';
        this.lines = [];
        socket.setEncoding('latin1');
        socket.on('data', (chunk: string) => {
            this.buffer += chunk;
            if (this.buffer.length > 64 * 1024) {
                this.closed = new SmtpError('reply too long');
                socket.destroy();
            }
            let at: number;
            while ((at = this.buffer.indexOf('\n')) !== -1) {
                this.lines.push(this.buffer.slice(0, at).replace(/\r$/, ''));
                this.buffer = this.buffer.slice(at + 1);
            }
            this.wake();
        });
        socket.on('error', (err: Error) => {
            this.closed ??= err instanceof SmtpError ? err : new SmtpError('connection failed');
            this.wake();
        });
        socket.on('close', () => {
            this.closed ??= new SmtpError('connection closed');
            this.wake();
        });
    }

    /**
     * Stops listening on the plain socket before it is wrapped in TLS. Anything the server sent after its 220 and before
     * the handshake is not a reply over TLS (RFC 3207 section 4.2: "STARTTLS command injection"): a server that sent it
     * is refused, and nothing it said is ever read as an answer.
     */
    release(): net.Socket {
        if (this.buffer.length || this.lines.length) {
            this.socket.destroy();
            throw new SmtpError('STARTTLS: data after 220');
        }
        this.socket.removeAllListeners('data');
        this.socket.removeAllListeners('error');
        this.socket.removeAllListeners('close');
        return this.socket;
    }

    private wake(): void {
        const w = this.waiting;
        this.waiting = null;
        w?.();
    }

    async reply(step: string): Promise<Reply> {
        const got: string[] = [];
        for (;;) {
            while (this.lines.length) {
                const line = this.lines.shift() as string;
                got.push(line);
                const m = /^(\d{3})([ -])/.exec(line);
                if (!m) throw new SmtpError(`${step}: not SMTP`);
                if (m[2] === ' ') return { code: Number(m[1]), lines: got.map(l => l.slice(4)) };
                if (got.length > 100) throw new SmtpError(`${step}: reply too long`);
            }
            if (this.closed) throw new SmtpError(`${step}: ${this.closed.message}`);
            await new Promise<void>(resolve => { this.waiting = resolve; });
        }
    }

    async command(step: string, line: string, expect: number[]): Promise<Reply> {
        this.socket.write(`${line}\r\n`, 'latin1');
        const r = await this.reply(step);
        if (!expect.includes(r.code)) throw new SmtpError(`${step}: ${r.code}`);
        return r;
    }
}

function ascii(s: string): string {
    return s.replace(/[^\x20-\x7e\n]/g, '?');
}

/** The message as it goes after DATA: headers, a blank line, the text with every line ending CRLF and dots doubled. */
export function formatMail(e: EmailChannel, m: MailMessage, heloName: string): string {
    const id = `${crypto.randomBytes(12).toString('hex')}@${heloName}`;
    const headers = [
        `From: ${e.from}`,
        `To: ${e.to.join(', ')}`,
        `Subject: ${ascii(m.subject).replace(/\n/g, ' ').slice(0, 200)}`,
        `Date: ${new Date(m.date).toUTCString().replace('GMT', '+0000')}`,
        `Message-ID: <${id}>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=us-ascii',
        'Content-Transfer-Encoding: 7bit',
        'Auto-Submitted: auto-generated',
    ];
    const body = ascii(m.text).split('\n').map(l => (l.startsWith('.') ? `.${l}` : l)).join('\r\n');
    return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
}

/** The socket at once (so a timeout can destroy it while it connects), and when it is connected. */
function connect(host: string, port: number, secure: boolean, tlsOptions: tls.ConnectionOptions): { socket: net.Socket | tls.TLSSocket; ready: Promise<void> } {
    let done: () => void = () => undefined;
    let failed: (e: Error) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
        done = resolve;
        failed = reject;
    });
    const socket = secure
        ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, ...tlsOptions }, () => done())
        : net.connect({ host, port }, () => done());
    socket.once('error', (err: Error) => failed(err instanceof SmtpError ? err : new SmtpError(secure ? 'TLS connection failed' : 'unreachable')));
    return { socket, ready };
}

function upgrade(plain: net.Socket, host: string, tlsOptions: tls.ConnectionOptions): Promise<tls.TLSSocket> {
    return new Promise((resolve, reject) => {
        const s = tls.connect({ socket: plain, servername: net.isIP(host) ? undefined : host, ...tlsOptions }, () => resolve(s));
        s.once('error', () => reject(new SmtpError('STARTTLS: TLS failed')));
    });
}

/**
 * Sends `m` to every address in `e.to` through `e.host`. `heloName` is the vault's own name (EHLO and the message id).
 * `tlsOptions` only for tests (a test CA); the system's trusted certificates otherwise.
 */
export async function sendMail(e: EmailChannel, m: MailMessage, opts: { heloName: string; tlsOptions?: tls.ConnectionOptions; timeoutMs?: number }): Promise<void> {
    const tlsOptions = opts.tlsOptions ?? {};
    let socket: net.Socket | tls.TLSSocket | null = null;
    const timer = setTimeout(() => socket?.destroy(new SmtpError('timed out')), opts.timeoutMs ?? TIMEOUT_MS);
    try {
        const connecting = connect(e.host, e.port, e.security === 'tls', tlsOptions);
        socket = connecting.socket;
        await connecting.ready;
        const c = new Conversation(socket);
        const greeting = await c.reply('greeting');
        if (greeting.code !== 220) throw new SmtpError(`greeting: ${greeting.code}`);
        let ehlo = await c.command('EHLO', `EHLO ${opts.heloName}`, [250]);
        if (e.security === 'starttls') {
            if (!ehlo.lines.some(l => /^STARTTLS\b/i.test(l))) throw new SmtpError('STARTTLS: not offered');
            await c.command('STARTTLS', 'STARTTLS', [220]);
            socket = await upgrade(c.release() as net.Socket, e.host, tlsOptions);
            c.listen(socket);
            ehlo = await c.command('EHLO', `EHLO ${opts.heloName}`, [250]);
        }
        if (e.username !== null && e.password !== null) {
            const auth = ehlo.lines.find(l => /^AUTH\b/i.test(l))?.toUpperCase().split(/[\s=]+/) ?? [];
            if (auth.includes('PLAIN')) {
                await c.command('AUTH', `AUTH PLAIN ${Buffer.from(`\0${e.username}\0${e.password}`, 'utf8').toString('base64')}`, [235]);
            } else if (auth.includes('LOGIN')) {
                await c.command('AUTH', 'AUTH LOGIN', [334]);
                await c.command('AUTH', Buffer.from(e.username, 'utf8').toString('base64'), [334]);
                await c.command('AUTH', Buffer.from(e.password, 'utf8').toString('base64'), [235]);
            } else {
                throw new SmtpError('AUTH: no method this client knows');
            }
        }
        await c.command('MAIL', `MAIL FROM:<${e.from}>`, [250]);
        for (const to of e.to) await c.command('RCPT', `RCPT TO:<${to}>`, [250, 251]);
        await c.command('DATA', 'DATA', [354]);
        socket.write(formatMail(e, m, opts.heloName), 'latin1');
        await c.command('DATA', '.', [250]);
        await c.command('QUIT', 'QUIT', [221]).catch(() => undefined);
    } catch (err) {
        throw err instanceof SmtpError ? err : new SmtpError('failed');
    } finally {
        clearTimeout(timer);
        socket?.destroy();
    }
}
