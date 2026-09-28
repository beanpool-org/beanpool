import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { encodeFrame, readFrames, type KeyholderRequest } from '../shared/protocol.js';
import { Keyholder, KeyholderError } from './keyholder.js';

/**
 * The keyholder on its Unix socket (key vault design §3). The socket file is 0600 in a 0700 directory: only the user
 * the keyholder and the API run as can connect (V3 puts them under their own users and a shared group, and nothing
 * else on the machine has an account).
 *
 * Every operation is one of the list in keyholder.ts; an unknown one is refused. An error answer carries a code and
 * a message, never a stack or any key material.
 */

type Handler = (kh: Keyholder, args: Record<string, unknown>, binary: Buffer) => unknown | Promise<unknown>;

/** Handlers that answer with a binary payload return `{ json, binary }`. */
interface BinaryAnswer {
    json: unknown;
    binary: Buffer;
}

const HANDLERS: Record<string, Handler> = {
    status: kh => kh.status(),
    hello: (kh, a) => kh.hello(a.custodianNonce),
    genesis: (kh, a) => kh.genesis({ custodian: a.custodian, sig: a.sig }),
    adoptState: (kh, a) => {
        kh.adoptState({ custodian: a.custodian, sig: a.sig, backupName: a.backupName, state: a.state });
        return { state: kh.status().state };
    },
    share: (kh, a) => kh.submitShare(a.submission),
    index: (kh, a) => ({ index: kh.index(a) }),
    depositWrap: (kh, a) => kh.depositWrap(a as Parameters<Keyholder['depositWrap']>[0]),
    readMeta: (kh, a) => kh.readMeta(a as Parameters<Keyholder['readMeta']>[0]),
    updateMeta: (kh, a) => kh.updateMeta(a as Parameters<Keyholder['updateMeta']>[0]),
    rewrap: (kh, a) => kh.rewrap(a as Parameters<Keyholder['rewrap']>[0]),
    release: (kh, a) => kh.release(a as Parameters<Keyholder['release']>[0]),
    signTicket: (kh, a) => kh.signTicket(a),
    signReport: (kh, a) => kh.signReport(a),
    sealBackup: (kh, a, bin): BinaryAnswer => ({ json: { ok: true }, binary: kh.sealBackup(a, bin) }),
    openBackup: (kh, _a, bin): BinaryAnswer => {
        const { header, deletions, body } = kh.openBackup(bin);
        return { json: { header, deletions }, binary: body };
    },
    openBackupDeletions: (kh, _a, bin) => kh.openBackupDeletions(bin),
    restoreDone: kh => {
        kh.restoreDone();
        return { ok: true };
    },
};

function isBinaryAnswer(v: unknown): v is BinaryAnswer {
    return !!v && typeof v === 'object' && Buffer.isBuffer((v as BinaryAnswer).binary) && 'json' in (v as object);
}

export interface KeyholderServer {
    close(): Promise<void>;
}

export async function listenKeyholder(kh: Keyholder, socketPath: string): Promise<KeyholderServer> {
    const dir = path.dirname(socketPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (existsSync(socketPath)) rmSync(socketPath);
    const sockets = new Set<net.Socket>();
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => socket.destroy());
        // One call at a time per connection, in order: the keyholder's state changes must not interleave.
        let queue: Promise<void> = Promise.resolve();
        readFrames(socket, (json, binary) => {
            queue = queue.then(async () => {
                const req = json as KeyholderRequest;
                const id = typeof req?.id === 'number' ? req.id : -1;
                try {
                    const handler = typeof req?.op === 'string' && Object.prototype.hasOwnProperty.call(HANDLERS, req.op) ? HANDLERS[req.op] : null;
                    if (!handler) throw new KeyholderError('bad_request', 'Not an operation this keyholder does.');
                    const args = req.args && typeof req.args === 'object' ? req.args : {};
                    const result = await handler(kh, args, binary);
                    if (!socket.destroyed) {
                        socket.write(isBinaryAnswer(result)
                            ? encodeFrame({ id, ok: true, result: result.json }, result.binary)
                            : encodeFrame({ id, ok: true, result }));
                    }
                } catch (e) {
                    const error = e instanceof KeyholderError
                        ? { code: e.code, message: e.message }
                        : { code: 'internal', message: 'The keyholder could not do that.' };
                    if (!socket.destroyed) socket.write(encodeFrame({ id, ok: false, error }));
                }
            });
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => resolve());
    });
    chmodSync(socketPath, 0o600);
    return {
        close: () => new Promise<void>(resolve => {
            for (const s of sockets) s.destroy();
            server.close(() => resolve());
        }),
    };
}
