import type { Socket } from 'node:net';

/**
 * The keyholder's Unix socket protocol. One frame each way per call:
 *
 *   u32 BE  total length of what follows
 *   u32 BE  JSON length
 *   JSON    {id, op, args} (request) or {id, ok, result | error} (answer)
 *   bytes   an optional binary payload (a database snapshot going into or out of a backup)
 *
 * A frame larger than {@link MAX_FRAME_BYTES} closes the connection: nothing the API sends is that big.
 */

export const MAX_FRAME_BYTES = 1024 * 1024 * 1024;

export interface KeyholderRequest {
    id: number;
    op: string;
    args?: Record<string, unknown>;
}

export interface KeyholderAnswer {
    id: number;
    ok: boolean;
    result?: unknown;
    error?: { code: string; message: string };
}

export function encodeFrame(json: unknown, binary?: Uint8Array): Buffer {
    const body = Buffer.from(JSON.stringify(json), 'utf8');
    const bin = binary ? Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength) : Buffer.alloc(0);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(4 + body.length + bin.length, 0);
    head.writeUInt32BE(body.length, 4);
    return Buffer.concat([head, body, bin]);
}

/**
 * Calls `onFrame` for every whole frame arriving on `socket`; destroys the socket on a malformed one. Chunks are
 * joined once, when a frame is complete, so a large snapshot costs one copy rather than one per chunk.
 */
export function readFrames(socket: Socket, onFrame: (json: unknown, binary: Buffer) => void): void {
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let frameTotal = -1;
    socket.on('data', (chunk: Buffer) => {
        pending.push(chunk);
        pendingBytes += chunk.length;
        while (pendingBytes >= 8) {
            if (frameTotal < 0) {
                const head = pending[0].length >= 4 ? pending[0] : Buffer.concat(pending);
                frameTotal = head.readUInt32BE(0);
                if (frameTotal < 4 || frameTotal > MAX_FRAME_BYTES) {
                    socket.destroy();
                    return;
                }
            }
            if (pendingBytes < 4 + frameTotal) return;
            const all = pending.length === 1 ? pending[0] : Buffer.concat(pending);
            const total = frameTotal;
            frameTotal = -1;
            const jsonLength = all.readUInt32BE(4);
            if (jsonLength > total - 4) {
                socket.destroy();
                return;
            }
            let json: unknown;
            try {
                json = JSON.parse(all.subarray(8, 8 + jsonLength).toString('utf8'));
            } catch {
                socket.destroy();
                return;
            }
            const binary = Buffer.from(all.subarray(8 + jsonLength, 4 + total));
            const rest = all.subarray(4 + total);
            pending = rest.length ? [rest] : [];
            pendingBytes = rest.length;
            onFrame(json, binary);
        }
    });
}
