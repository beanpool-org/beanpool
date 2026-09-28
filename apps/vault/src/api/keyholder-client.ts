import net from 'node:net';
import { encodeFrame, readFrames, type KeyholderAnswer } from '../shared/protocol.js';

/** The keyholder refused, with its code (keyholder.ts `KeyholderError`). */
export class KeyholderCallError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
        this.name = 'KeyholderCallError';
    }
}

/**
 * The keyholder could not be reached or did not answer: to the outside, the vault is locked (design §3). `dropped`:
 * the connection closed under the call, which a keyholder does only by going away (a restart, a crash).
 */
export class KeyholderUnavailable extends Error {
    constructor(message = 'The keyholder is not answering.', readonly dropped = false) {
        super(message);
        this.name = 'KeyholderUnavailable';
    }
}

interface Pending {
    resolve: (v: { result: unknown; binary: Buffer }) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
}

/** One connection to the keyholder, opened on first use and again after it drops. */
export class KeyholderClient {
    private socket: net.Socket | null = null;
    private connecting: Promise<net.Socket> | null = null;
    private readonly pending = new Map<number, Pending>();
    private nextId = 1;

    constructor(private readonly socketPath: string, private readonly timeoutMs = 30_000) {}

    private connect(): Promise<net.Socket> {
        if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
        if (this.connecting) return this.connecting;
        this.connecting = new Promise<net.Socket>((resolve, reject) => {
            const socket = net.createConnection(this.socketPath);
            const onError = () => {
                this.connecting = null;
                reject(new KeyholderUnavailable());
            };
            socket.once('error', onError);
            socket.once('connect', () => {
                socket.off('error', onError);
                socket.on('error', () => socket.destroy());
                // The keyholder ended the connection: no new call goes on it, even before it is fully closed.
                socket.on('end', () => {
                    if (this.socket === socket) this.socket = null;
                });
                socket.on('close', () => {
                    if (this.socket === socket) this.socket = null;
                    for (const [id, p] of this.pending) {
                        clearTimeout(p.timer);
                        p.reject(new KeyholderUnavailable('The keyholder went away mid-call.', true));
                        this.pending.delete(id);
                    }
                });
                readFrames(socket, (json, binary) => this.onAnswer(json as KeyholderAnswer, binary));
                this.socket = socket;
                this.connecting = null;
                resolve(socket);
            });
        });
        return this.connecting;
    }

    private onAnswer(answer: KeyholderAnswer, binary: Buffer): void {
        const p = this.pending.get(answer?.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(answer.id);
        if (answer.ok) p.resolve({ result: answer.result, binary });
        else p.reject(new KeyholderCallError(answer.error?.code ?? 'internal', answer.error?.message ?? 'The keyholder refused.'));
    }

    /**
     * Calls `op`; a binary payload goes along with `binary` and comes back in the answer's `binary`.
     *
     * A call made on a connection opened earlier that closes under it is made once more on a new one. That is the
     * first call after a keyholder restart, sent before this side had seen the old connection close; the keyholder that
     * would have answered it is gone, so nothing was done twice.
     */
    async call<T = unknown>(op: string, args: Record<string, unknown> = {}, binary?: Uint8Array, timeoutMs = this.timeoutMs): Promise<{ result: T; binary: Buffer }> {
        const reused = !!this.socket && !this.socket.destroyed;
        try {
            return await this.send<T>(op, args, binary, timeoutMs);
        } catch (e) {
            if (!reused || !(e instanceof KeyholderUnavailable) || !e.dropped) throw e;
            return this.send<T>(op, args, binary, timeoutMs);
        }
    }

    private async send<T>(op: string, args: Record<string, unknown>, binary: Uint8Array | undefined, timeoutMs: number): Promise<{ result: T; binary: Buffer }> {
        const socket = await this.connect();
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new KeyholderUnavailable('The keyholder did not answer in time.'));
            }, timeoutMs);
            this.pending.set(id, { resolve: resolve as Pending['resolve'], reject, timer });
            socket.write(encodeFrame({ id, op, args }, binary));
        });
    }

    close(): void {
        this.socket?.destroy();
        this.socket = null;
    }
}
