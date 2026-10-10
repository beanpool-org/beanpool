/**
 * One shared answer for the whole member directory (docs/global-heavy-lists.md §5(d), slice 2).
 *
 * The full `GET /api/members` is the same for every reader the route lets in: it carries no viewer's own data (no
 * contact details, no friends, no per-reader distance). So it is built once per members version, kept as one Buffer,
 * and every reader is sent those same bytes. A burst of readers costs one build, and each reader in flight holds only
 * its socket and a window of the body, not a copy of it.
 *   - The snapshot is keyed by everything that changes the answer: the members version and the node's face-key setting
 *     (avatarUrlOf). Nothing about the viewer is in the key because nothing about the viewer is in the answer; the
 *     forms that are per reader (`lat`/`lng`) or per cursor (`updatedAfter`) never come here.
 *   - It is served only for the members version it was built for: a write that moves the version is in the very next
 *     answer (a directory change shows at once: test-profile-fanout, test-member-photos-out-of-rows). Readers of one
 *     version share its one build, also those who waited under the cap while it was built. An earlier 5 s floor served
 *     the last snapshot for a while after a write, and with the digest ETag below a phone holding it got 304: stale.
 *   - It is also rebuilt at least every MAX_AGE_MS while it is read, so a write that forgot to move the version (a
 *     missed bump, engine/versions.ts) is stale for a minute at most, for a new reader as for one holding an ETag.
 *   - Its ETag is a digest of its bytes and nothing else, and a 304 is given only against the current version's
 *     snapshot, so a 304 is never wrong, also across a 60 s rebuild, and a write that moves the version but changes
 *     nothing in the answer (a member's area, holiday mode, a mute) still gets 304 once rebuilt, not the whole
 *     directory again. "snapshot" keeps it apart from the route's version-only ETag.
 *   - The gzip copy is made once, on the first reader that accepts gzip, and shared the same way.
 *
 *   - The bytes are sent SEND_CHUNK at a time, each when the socket has taken the last. Sent whole, each reader's socket
 *     held one encrypted copy of the answer in native memory (off the heap) until its reader had read it all: readers
 *     who stopped reading added 11 MB of RSS each plain and 2 MB gzip, and 48 of them 445 MB (the deciding review of
 *     #1523). Now one holds about a window.
 *
 * The read gate and the route's own checks run before any of this. The build itself runs under the heavy-read cap
 * (heavy-reads.ts), as the unshared build did, and so does every send of a ready snapshot, weighed SNAPSHOT_SEND_WEIGHT
 * and under the cap's deadline: the number of them in flight is bounded, and one that stops reading is cut off.
 *   - Each send holds the whole body it sends (its chunks are views of it) until its last byte leaves. So the cap counts
 *     each body that sends in flight hold once, at its full size (holdSharedBody), as well as each send's window: the
 *     current snapshot once however many read it, and a snapshot a newer version has replaced for as long as a reader who
 *     stopped reading still holds it. Weighed only at the window, readers who stopped reading, one per version, held
 *     +300 MB of RSS with the cap counting 6 MB (the deciding review of #1526).
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import type Koa from 'koa';
import { holdSharedBody, sharedBodyCost } from './heavy-reads.js';

export interface MembersSnapshot {
    /** What it was built from: the members version and every other input that changes the answer. */
    key: string;
    builtAt: number;
    body: Buffer;
    etag: string;
    gzip: Buffer | null;
}

/** How much of the body is handed to a reader's socket at once. */
const SEND_CHUNK = 64 * 1024;
/**
 * What one send of a ready snapshot holds in flight, as the heavy-read cap weighs it: a window of the body on its
 * socket, plaintext and encrypted, and its TLS connection (test-heavy-read-cap §1b, §1d). Weighed at 128 KB, readers who
 * stopped reading at the bound (30,000 members, a 256 MB heap) grew RSS by about 0.19 MB a send plain and 0.16 MB gzip:
 * +58 MB plain with the cap counting 48 MB (#1524). At 192 KB the budget is the real ceiling.
 */
export const SNAPSHOT_SEND_WEIGHT = 192 * 1024;
const MAX_AGE_MS = 60_000;

let settings = { maxAgeMs: MAX_AGE_MS };
let current: MembersSnapshot | null = null;
let builds = 0;

/** The ready snapshot for `key`, or null when it must be (re)built: one built for any other key is never served. */
export function usableMembersSnapshot(key: string, now = Date.now()): MembersSnapshot | null {
    if (!current || current.key !== key) return null;
    const age = now - current.builtAt;
    return age < 0 || age >= settings.maxAgeMs ? null : current;
}

/** The snapshot key: the members version and the face-key setting. */
export function membersSnapshotKey(version: number, avatarKeys: boolean): string {
    return `${version}:${avatarKeys ? 'k' : 'o'}`;
}

/** Keep `bodyStr` as the snapshot for `key`, replacing any other. */
export function storeMembersSnapshot(key: string, bodyStr: string, now = Date.now()): MembersSnapshot {
    const body = Buffer.from(bodyStr, 'utf8');
    const digest = createHash('sha256').update(body).digest('base64url').slice(0, 12);
    current = { key, builtAt: now, body, etag: `W/"members-snapshot-${digest}"`, gzip: null };
    builds++;
    return current;
}

/** `body` a SEND_CHUNK at a time, each a view of it (no copy), read only as the socket takes them. */
function chunked(body: Buffer): Readable {
    let at = 0;
    return new Readable({
        highWaterMark: SEND_CHUNK,
        read() {
            if (at >= body.length) { this.push(null); return; }
            const end = Math.min(at + SEND_CHUNK, body.length);
            this.push(body.subarray(at, end));
            at = end;
        },
    });
}

function acceptsGzip(ctx: Koa.Context): boolean {
    const header = typeof ctx.get === 'function' ? ctx.get('Accept-Encoding') : '';
    return /(^|,)\s*gzip\s*(;\s*q=(?!0(\.0*)?\s*($|,))[0-9.]+)?\s*($|,)/i.test(header);
}

/**
 * What a send of `snap` on `ctx` adds to the heavy-read cap's bytes in flight now: its `window`, and the body it will
 * send unless another send in flight holds that already. A gzip copy not yet made is weighed as the plain body, which
 * it is smaller than; its own size is counted once it is made.
 */
export function snapshotSendWeight(ctx: Koa.Context, snap: MembersSnapshot, window = SNAPSHOT_SEND_WEIGHT): number {
    const body = acceptsGzip(ctx) ? snap.gzip : snap.body;
    return window + (body ? sharedBodyCost(body) : snap.body.length);
}

/**
 * Send `snap` on `ctx`: the gzip copy to a reader that accepts it, the plain bytes to any other. Under the heavy-read cap,
 * the body sent is held from now until this answer is out, counted once with every other send of it, and `window` as
 * this send's own.
 */
export function sendMembersSnapshot(ctx: Koa.Context, snap: MembersSnapshot, window = SNAPSHOT_SEND_WEIGHT): void {
    ctx.status = 200;
    ctx.type = 'application/json';
    // A route dispatched by a suite with a bare context has no vary(); a real one appends to any Vary already set.
    if (typeof ctx.vary === 'function') ctx.vary('Accept-Encoding');
    let bytes = snap.body;
    if (acceptsGzip(ctx)) {
        bytes = snap.gzip ??= gzipSync(snap.body);
        ctx.set('Content-Encoding', 'gzip');
    }
    holdSharedBody(ctx, bytes, window);
    ctx.body = chunked(bytes);
    ctx.length = bytes.length;
}

/** How many snapshots were built since the server started (tests). */
export function membersSnapshotBuilds(): number {
    return builds;
}

/** Tests only: another ceiling, and no snapshot kept. `undefined` puts the default back. */
export function setMembersSnapshotForTests(overrides: Partial<typeof settings> | undefined): void {
    settings = { maxAgeMs: MAX_AGE_MS, ...(overrides ?? {}) };
    current = null;
    builds = 0;
}
