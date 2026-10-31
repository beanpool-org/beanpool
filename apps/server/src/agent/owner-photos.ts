/**
 * An owner's assistant's photos other than base64 in the call (design §2.4, slice S4; Marty, 31 Oct: "URL + upload"). A
 * hosted assistant (claude.ai, ChatGPT) writes a tool's arguments as its own output, and a photo as base64 is 30,000 to
 * 80,000 characters of it (beanpool-d5's seeding test), so a whole run of posts with photos could only be made from a
 * program. Two more ways in, both ending in the base64 photo's own steps (owner-posts.ts storableImage: sniffed, at most
 * 2,048 px a side, made 800 px with no metadata, one resize at a time; a PNG is stored as a JPEG):
 *
 * - `photo_urls`: public http(s) addresses this server fetches itself, through the Pulse resolver's ssrfSafeFetch
 *   (engine/pulse-resolver.ts): the name's every address checked and the connection pinned to the one checked; loopback,
 *   private, link-local and the other reserved ranges refused, after each redirect too (at most 5); a JPEG, WebP or PNG by
 *   its Content-Type and by its bytes; at most 5 MB; the whole fetch, redirects included, in 8 seconds. One fetch at a
 *   time on this server. The photo's host sees this server's address and a BeanPool user agent, as a Pulse link's does.
 * - `photo_ids`: a photo uploaded first, one image as the body of POST /mcp/photos (agent/photo-upload-route.ts) with the
 *   bearer the door takes. Kept here, already made what the apps send, as a file of its own under the data folder for at
 *   most 24 hours: an id is the grant's that uploaded it and no other's, it is used once, and it and its file are gone
 *   when a post is made with it, when its 24 hours are up (each upload and each use sweeps, and an hourly timer), or when
 *   the grant is revoked (every revoke path calls dropUploadedPhotosOf). Nothing lists the uploads or reads one back.
 * - One budget for both: AGENT_PHOTOS_PER_DAY (200) a grant a UTC day (limits.ts), each fetch or upload tried counted.
 * - Refused in words, never the server's own error: "not an image", "too big", "a private address", "timed out". No answer
 *   carries an address the server resolved, a path or file name on this server, or another grant's anything.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    __ssrfSafeFetchWithResolverForTests, PayloadTooLargeError, ProhibitedContentTypeError, RequestTimeoutError, ssrfSafeFetch,
    SsrfSecurityError, type HostResolver, type SsrfSafeFetchOptions, type SsrfSafeResponse,
} from '../engine/pulse-resolver.js';
import { logger } from '../logger.js';
import { admitAgentPhoto, agentPhotosToday, AGENT_PHOTOS_PER_DAY } from './limits.js';

/** The most a fetched or uploaded photo may be, before it is made 800 px. */
export const PHOTO_SOURCE_MAX_BYTES = 5 * 1024 * 1024;
export const PHOTO_FETCH_TIMEOUT_MS = 8_000;
export const PHOTO_FETCH_MAX_REDIRECTS = 5;
export const PHOTO_URL_MAX_CHARS = 2048;
/** What a fetch's Content-Type and an upload's may say; the bytes are sniffed whatever it said. */
export const PHOTO_SOURCE_TYPES = ['image/jpeg', 'image/webp', 'image/png'] as const;
/** How long an uploaded photo waits for a post. */
export const PHOTO_UPLOAD_KEEP_MS = 24 * 60 * 60 * 1000;
/** Where an upload goes, beside /mcp (agent/photo-upload-route.ts); an assistant joins it to the address in its welcome. */
export const PHOTO_UPLOAD_PATH = '/mcp/photos';

const MB = 1024 * 1024;
const MAX_WORDS = `${PHOTO_SOURCE_MAX_BYTES / MB} MB`;

/** The two ways besides base64, in words, for connection_info and the welcome. */
export const PHOTO_WAYS = `photo_urls: public addresses of images this server fetches itself (a JPEG, WebP or PNG, at most ${MAX_WORDS}); or `
    + `photo_ids: POST one image as the whole body to ${PHOTO_UPLOAD_PATH} on this server, with its Content-Type and the same Authorization `
    + `header, and give the photoId it answers, once, within ${PHOTO_UPLOAD_KEEP_MS / 3_600_000} hours`;

type Fetcher = (url: string, options: SsrfSafeFetchOptions) => Promise<SsrfSafeResponse>;
let fetcher: Fetcher = ssrfSafeFetch;
let fetchTimeoutMs = PHOTO_FETCH_TIMEOUT_MS;

/**
 * For the suites: fetch through ssrfSafeFetch's own test hook with `resolve` (a local server stands in for a public host),
 * and give up sooner than 8 seconds. The hook refuses to run unless the process sets BEANPOOL_SSRF_TEST_HOOK=1, which
 * nothing in production does, so a call here outside a suite makes every fetch fail; the deadline can only be shortened.
 */
export function __usePhotoFetchResolverForTests(resolve: HostResolver | null, timeoutMs = PHOTO_FETCH_TIMEOUT_MS): void {
    fetcher = resolve ? (url, options) => __ssrfSafeFetchWithResolverForTests(url, options, resolve) : ssrfSafeFetch;
    fetchTimeoutMs = Math.min(timeoutMs, PHOTO_FETCH_TIMEOUT_MS);
}

/** The fetches waiting their turn: one at a time on this server, each at most 5 MB in memory. */
let fetchQueue: Promise<unknown> = Promise.resolve();
function oneFetchAtATime<T>(work: () => Promise<T>): Promise<T> {
    const run = fetchQueue.then(work, work);
    fetchQueue = run.catch(() => undefined);
    return run;
}

/** A value an assistant sent as a photo's address, when it is an http(s) URL with no user or password in it. */
function httpUrl(value: unknown): URL | null {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s || s.length > PHOTO_URL_MAX_CHARS) return null;
    let u: URL;
    try { u = new URL(s); } catch { return null; }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null;
    return u;
}

const notAnImage = (which: string, why: string): string => `${which} is not an image (${why}): the address must give a JPEG, WebP or PNG.`;

/** Why a fetch failed, in words: never the resolver's own message, which can name an address it resolved. */
function fetchRefusal(e: unknown, which: string): { error: string; kind: string } {
    if (e instanceof PayloadTooLargeError) return { kind: 'too big', error: `${which} is too big: at most ${MAX_WORDS}. Give the address of a smaller copy.` };
    if (e instanceof RequestTimeoutError) {
        return { kind: 'timed out', error: `${which} timed out: the whole image did not arrive within ${PHOTO_FETCH_TIMEOUT_MS / 1000} seconds.` };
    }
    if (e instanceof ProhibitedContentTypeError) return { kind: 'not an image', error: notAnImage(which, 'its address answered something else') };
    if (e instanceof SsrfSecurityError) {
        if (/DNS resolution/.test(e.message)) return { kind: 'not found', error: `${which} could not be found: check the address.` };
        if (/redirect/i.test(e.message)) {
            return { kind: 'redirects', error: `${which} redirects more than ${PHOTO_FETCH_MAX_REDIRECTS} times, or nowhere: give the image's own address.` };
        }
        return { kind: 'a private address', error: `${which} is a private address, or leads to one: this server fetches only public addresses.` };
    }
    return { kind: 'unreachable', error: `${which} could not be fetched: check the address, or try again later.` };
}

export type Fetched = { ok: true; bytes: Buffer } | { ok: false; error: string };

/**
 * The photo at `value` (the assistant's photo_urls item `n`), fetched by this server, or why not in words. Counted against
 * the grant's day once it is a URL worth trying (refused before anything is fetched when the day is used up), one at a
 * time on this server. The bytes still have to pass storableImage.
 */
export async function fetchPhoto(grantId: string, value: unknown, n: number): Promise<Fetched> {
    const which = `photo_urls #${n}`;
    const url = httpUrl(value);
    if (!url) return { ok: false, error: `${which} must be a public http or https address of an image, at most ${PHOTO_URL_MAX_CHARS.toLocaleString('en')} characters, with no user or password in it.` };
    if (!admitAgentPhoto(grantId)) return { ok: false, error: photoDayFull(grantId) };
    const host = url.hostname.slice(0, 100);
    return oneFetchAtATime(async () => {
        let res: SsrfSafeResponse;
        let bytes: Buffer;
        try {
            res = await fetcher(url.toString(), {
                method: 'GET', timeoutMs: fetchTimeoutMs, maxBytes: PHOTO_SOURCE_MAX_BYTES, maxRedirects: PHOTO_FETCH_MAX_REDIRECTS,
                allowedContentTypes: [...PHOTO_SOURCE_TYPES],
                headers: { 'User-Agent': 'BeanPool-Photos/1.0 (+https://beanpool.org)', Accept: PHOTO_SOURCE_TYPES.join(', ') },
            });
            const mime = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
            // A body left unread is ended by the fetch's own deadline (pulse-resolver.ts): nothing waits on it here.
            if (res.status < 200 || res.status > 299) return refused(grantId, host, 'not an image', notAnImage(which, `its address answered ${res.status}`));
            if (!(PHOTO_SOURCE_TYPES as readonly string[]).includes(mime)) return refused(grantId, host, 'not an image', notAnImage(which, 'its address did not say it is one'));
            bytes = await res.buffer();
        } catch (e) {
            const r = fetchRefusal(e, which);
            return refused(grantId, host, r.kind, r.error);
        }
        logger.info('AGENT', 'Assistant photo fetched', { grant: grantId, host, bytes: bytes.length });
        return { ok: true as const, bytes };
    });
}

/** A fetch refused: its line in the log (the host only, never the path; a private address as a warning), and the words. */
function refused(grantId: string, host: string, kind: string, error: string): Fetched {
    const line = { grant: grantId, host, refused: kind };
    if (kind === 'a private address') logger.warn('AGENT', 'Assistant photo fetch refused', line);
    else logger.info('AGENT', 'Assistant photo fetch refused', line);
    return { ok: false, error };
}

/** Said when the grant's photos for the day are used up. */
export function photoDayFull(grantId: string): string {
    return `This assistant has had ${agentPhotosToday(grantId).toLocaleString('en')} photos fetched or uploaded today, and ${AGENT_PHOTOS_PER_DAY} a day `
        + 'is the most: try again tomorrow (UTC).';
}

// ── Uploaded photos ─────────────────────────────────────────────────────────────────────────

const PHOTO_ID = /^ph_([0-9a-f]{32})$/;
/** A grant's id as agent tokens (12 hex) and OAuth grants (oa + 10 hex) make them: a folder name, never a path. */
const GRANT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const EXT = { jpeg: 'jpg', webp: 'webp' } as const;

function uploadsRoot(): string {
    return path.join(process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data'), 'assistant-photos');
}

function grantFolder(grantId: string): string | null {
    return GRANT_ID.test(grantId) ? path.join(uploadsRoot(), grantId) : null;
}

/** `<grant id>/<photo hex>` of the uploads a post being made holds now, so a second call can't take them too. */
const held = new Set<string>();

/**
 * Keep a photo an upload gave (a data URL storableImage made: a JPEG or WebP, at most 800 px, no metadata) for this grant,
 * for at most 24 hours. Its id, and when it goes.
 */
export function keepUploadedPhoto(grantId: string, dataUrl: string, now = Date.now()): { photoId: string; expiresAt: string } {
    const m = /^data:image\/(jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    const folder = grantFolder(grantId);
    if (!m || !folder) throw new Error('Not a photo this server keeps');
    sweepUploadedPhotos(now);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const hex = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(folder, `${hex}.${EXT[m[1] as 'jpeg' | 'webp']}`), Buffer.from(m[2], 'base64'), { mode: 0o600, flag: 'wx' });
    return { photoId: `ph_${hex}`, expiresAt: new Date(now + PHOTO_UPLOAD_KEEP_MS).toISOString() };
}

/** The upload `hex` of this grant, if it is here and not yet 24 hours old. */
function uploadedFile(folder: string, hex: string, now: number): { file: string; type: 'jpeg' | 'webp' } | null {
    for (const type of ['jpeg', 'webp'] as const) {
        const file = path.join(folder, `${hex}.${EXT[type]}`);
        try {
            const st = fs.lstatSync(file);
            if (st.isFile() && now - st.mtimeMs < PHOTO_UPLOAD_KEEP_MS) return { file, type };
        } catch { /* not this one */ }
    }
    return null;
}

export type Claimed = { ok: true; photos: string[]; settle: (used: boolean) => void } | { ok: false; error: string };

/**
 * The photos `ids` name, each one this grant uploaded, not yet used and not yet 24 hours old, held for the post being made
 * now; why not, in words that are the same for an id that never was, another grant's, one used, and one too old. `settle`
 * once the post is made (used: each id and its file are gone) or refused (each can be used again).
 */
export function claimUploadedPhotos(grantId: string, ids: readonly unknown[], now = Date.now()): Claimed {
    if (ids.length) sweepUploadedPhotos(now);
    const folder = grantFolder(grantId);
    const keys: string[] = [];
    const files: string[] = [];
    const photos: string[] = [];
    const fail = (error: string): Claimed => {
        for (const k of keys) held.delete(k);
        return { ok: false, error };
    };
    for (let i = 0; i < ids.length; i++) {
        const which = `photo_ids #${i + 1}`;
        const m = typeof ids[i] === 'string' ? PHOTO_ID.exec((ids[i] as string).trim()) : null;
        if (!m) return fail(`${which} is not a photo id: an id is what POST /mcp/photos answered (ph_ and 32 letters and digits).`);
        const key = `${grantId}/${m[1]}`;
        const found = folder && !held.has(key) ? uploadedFile(folder, m[1], now) : null;
        if (!found) {
            return fail(`${which} is not a photo this assistant uploaded and has not used yet: an id is used once, by the assistant that uploaded it, `
                + `within ${PHOTO_UPLOAD_KEEP_MS / 3_600_000} hours. Upload it again.`);
        }
        let bytes: Buffer;
        try { bytes = fs.readFileSync(found.file); } catch { return fail(`${which} could not be read: upload it again.`); }
        held.add(key);
        keys.push(key);
        files.push(found.file);
        photos.push(`data:image/${found.type};base64,${bytes.toString('base64')}`);
    }
    let settled = false;
    return {
        ok: true, photos,
        settle: (used) => {
            if (settled) return;
            settled = true;
            for (const k of keys) held.delete(k);
            if (used) for (const f of files) fs.rmSync(f, { force: true });
        },
    };
}

/** Delete every upload 24 hours old or more, and a grant's folder once it is empty. How many photos went. */
export function sweepUploadedPhotos(now = Date.now()): number {
    const root = uploadsRoot();
    let grants: string[];
    try { grants = fs.readdirSync(root); } catch { return 0; }
    let removed = 0;
    for (const g of grants) {
        const folder = path.join(root, g);
        let names: string[];
        try { names = fs.readdirSync(folder); } catch { continue; }
        for (const name of names) {
            const file = path.join(folder, name);
            try {
                if (now - fs.lstatSync(file).mtimeMs >= PHOTO_UPLOAD_KEEP_MS) {
                    fs.rmSync(file, { force: true });
                    removed++;
                }
            } catch { /* gone already */ }
        }
        try { if (!fs.readdirSync(folder).length) fs.rmdirSync(folder); } catch { /* not empty, or gone */ }
    }
    return removed;
}

/** A revoked grant's uploads, used or not, go with it (agent/grants-route.ts, agent/oauth-route.ts, routes/automation-tokens.ts). */
export function dropUploadedPhotosOf(grantId: string): void {
    const folder = grantFolder(grantId);
    if (folder) fs.rmSync(folder, { recursive: true, force: true });
    for (const k of held) if (k.startsWith(`${grantId}/`)) held.delete(k);
}

/** How many photos a grant has waiting (for the suites, and nothing that answers an assistant). */
export function uploadedPhotosWaiting(grantId: string): number {
    const folder = grantFolder(grantId);
    try { return folder ? fs.readdirSync(folder).length : 0; } catch { return 0; }
}

const SWEEP_EVERY_MS = 60 * 60 * 1000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** At start and hourly: an upload no call comes back for still goes after 24 hours. */
export function startSweepingUploadedPhotos(): void {
    if (sweepTimer) return;
    try { sweepUploadedPhotos(); } catch { /* the next hour's */ }
    sweepTimer = setInterval(() => { try { sweepUploadedPhotos(); } catch { /* the next hour's */ } }, SWEEP_EVERY_MS);
    sweepTimer.unref?.();
}
