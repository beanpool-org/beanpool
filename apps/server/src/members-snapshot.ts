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
 *   - It is rebuilt when the version has moved, but at most every MIN_REBUILD_MS, and at least every MAX_AGE_MS even
 *     if the version hasn't moved, so a write that forgot to move the version is stale for a minute at most.
 *   - Its ETag is its own version and a digest of its bytes, so a 304 is never wrong, also across a 60 s rebuild.
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
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import type Koa from 'koa';

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
 * socket, plaintext and encrypted (measured in test-heavy-read-cap §1b).
 */
export const SNAPSHOT_SEND_WEIGHT = 128 * 1024;
const MIN_REBUILD_MS = 5_000;
const MAX_AGE_MS = 60_000;

let settings = { minRebuildMs: MIN_REBUILD_MS, maxAgeMs: MAX_AGE_MS };
let current: MembersSnapshot | null = null;
let builds = 0;

/** The ready snapshot for `key`, or null when it must be (re)built. */
export function usableMembersSnapshot(key: string, now = Date.now()): MembersSnapshot | null {
    if (!current) return null;
    const age = now - current.builtAt;
    if (age < 0 || age >= settings.maxAgeMs) return null;
    if (current.key === key) return current;
    // The version moved: the last snapshot stands until the floor has passed, so a run of writes costs one build.
    // Only a version change waits: a change of the face-key setting changes every URL, and never waits.
    return age < settings.minRebuildMs && sameSetting(current.key, key) ? current : null;
}

function sameSetting(a: string, b: string): boolean {
    return a.slice(a.indexOf(':')) === b.slice(b.indexOf(':'));
}

/** The snapshot key: the members version and the face-key setting. */
export function membersSnapshotKey(version: number, avatarKeys: boolean): string {
    return `${version}:${avatarKeys ? 'k' : 'o'}`;
}

/** Keep `bodyStr` as the snapshot for `key`, replacing any other. */
export function storeMembersSnapshot(key: string, bodyStr: string, now = Date.now()): MembersSnapshot {
    const body = Buffer.from(bodyStr, 'utf8');
    const digest = createHash('sha256').update(body).digest('base64url').slice(0, 12);
    current = { key, builtAt: now, body, etag: `W/"members-${key.split(':')[0]}-${digest}"`, gzip: null };
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

/** Send `snap` on `ctx`: the gzip copy to a reader that accepts it, the plain bytes to any other. */
export function sendMembersSnapshot(ctx: Koa.Context, snap: MembersSnapshot): void {
    ctx.status = 200;
    ctx.type = 'application/json';
    // A route dispatched by a suite with a bare context has no vary(); a real one appends to any Vary already set.
    if (typeof ctx.vary === 'function') ctx.vary('Accept-Encoding');
    let bytes = snap.body;
    if (acceptsGzip(ctx)) {
        bytes = snap.gzip ??= gzipSync(snap.body);
        ctx.set('Content-Encoding', 'gzip');
    }
    ctx.body = chunked(bytes);
    ctx.length = bytes.length;
}

/** How many snapshots were built since the server started (tests). */
export function membersSnapshotBuilds(): number {
    return builds;
}

/** Tests only: other floors, and no snapshot kept. `undefined` puts the defaults back. */
export function setMembersSnapshotForTests(overrides: Partial<typeof settings> | undefined): void {
    settings = { minRebuildMs: MIN_REBUILD_MS, maxAgeMs: MAX_AGE_MS, ...(overrides ?? {}) };
    current = null;
    builds = 0;
}
