/**
 * Automated Test Suite: Pulse Instagram thumbnail recovery and its persisted backoff.
 *
 * The failure this pins down, from the test node's logs of 2026-09-23: four Instagram items
 * repeating the same PAIR of failed outbound fetches every five minutes for an hour and a half.
 *
 *     [PulseThumbnail] Upstream refused for item item_0fdd...: HTTP 403
 *     [PulseThumbnail] Instagram embed recovery failed for item item_0fdd...: Response exceeded
 *                      maximum size limit of 524288 bytes
 *
 * Two bugs in one loop: the cached CDN URL had expired (403), and the #813 embed-page recovery
 * that should have replaced it could never finish, because the embed page had outgrown the
 * 512 KB cap the fetch was given. The only memory of the failure was a five-minute in-process
 * TTL that a restart wiped, so the node paid for both fetches again and again.
 *
 * Covers:
 * 1. Recovery succeeds on a large embed page, and the old 512 KB cap fails on the same page.
 * 2. A failed item is not fetched again inside its backoff window — including after a restart.
 * 3. The backoff escalates 1 h -> 6 h -> 24 h, caps there, and a success clears it.
 * 4. One failure log line per backoff step, not one per request.
 *
 * No network: the embed page is a committed fixture and every fetch is a mock that mirrors
 * ssrfSafeFetch's byte-limit behaviour. Nothing here contacts Instagram or any CDN.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-pulse-thumbnail-recovery.ts
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db } from './db/db.js';
import { initStateEngine } from './state-engine.js';
import { logger } from './logger.js';
import {
    PulseThumbnailService,
    PulseThumbnailBackoffStore,
    INSTAGRAM_EMBED_MAX_BYTES,
    THUMBNAIL_BACKOFF_STEPS_MS,
} from './engine/pulse-thumbnail.js';
import { PayloadTooLargeError, type SsrfSafeResponse } from './engine/pulse-resolver.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

// ── The embed page ───────────────────────────────────────────────────────────
/** What the embed fetch was capped at before this fix — the 524288 in the logged error. */
const OLD_EMBED_CAP_BYTES = 512 * 1024;
const FIXTURE_PATH = fileURLToPath(new URL('./__fixtures__/instagram-embed-page.html', import.meta.url));
const FILLER_MARKER = /\/\* PULSE_FIXTURE_FILLER[^*]*\*\//;

/**
 * The committed fixture with its filler expanded.
 *
 * The fixture holds the real page's SHAPE — the image tag after the whole inline bundle — and
 * a marker where the bundle's bulk goes. Expanding it here rather than committing 640 KB of
 * filler keeps the repository small while reproducing the exact failure: the EmbeddedMediaImage
 * tag sits well past 512 KB into the document.
 */
function buildLargeEmbedPage(): Buffer {
    const raw = fs.readFileSync(FIXTURE_PATH, 'utf-8');
    if (!FILLER_MARKER.test(raw)) {
        throw new Error('instagram-embed-page.html has lost its PULSE_FIXTURE_FILLER marker');
    }
    const bundleLine = `window.__bundle_chunk_push([${'0'.repeat(180)}]);\n`;
    const lines = Math.ceil((OLD_EMBED_CAP_BYTES + 128 * 1024) / bundleLine.length);
    return Buffer.from(raw.replace(FILLER_MARKER, bundleLine.repeat(lines)), 'utf-8');
}

/** The URL the fixture's EmbeddedMediaImage tag points at, once HTML-unescaped. */
const FRESH_CDN_URL = 'https://scontent-syd2-1.cdninstagram.com/v/t51.2885-15/fixture_thumbnail.jpg'
    + '?stp=dst-jpg_e35&_nc_ht=scontent-syd2-1.cdninstagram.com&oh=00fixture&oe=66FIXTURE';
/** The stale signed URL stored on the item. Deliberately not on a cdninstagram host, so the
 *  mock can tell the dead thumbnail apart from the fresh one the embed page yields. */
const STALE_THUMBNAIL_URL = 'https://images.example.org/expired-signed-thumbnail.jpg';

const sampleJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

// ── Mock upstream ────────────────────────────────────────────────────────────
interface FetchState {
    /** Every URL fetched, in order. */
    fetches: string[];
    /** maxBytes the engine asked for on the embed page fetch. */
    embedMaxBytesAsked: number;
    /** Set to 512 KB to hold the embed fetch to the pre-fix cap, whatever the engine asks for. */
    embedCeiling?: number;
    /** false makes the fresh CDN image fail too. */
    imageOk?: boolean;
}

/**
 * A body read that refuses past the cap, exactly as the resolver's byte-limit transform does —
 * same error type, same wording, so the fixture reproduces the logged failure rather than an
 * approximation of it.
 */
function cappedResponse(url: string, body: Buffer, maxBytes: number, contentType: string): SsrfSafeResponse {
    const read = async (): Promise<Buffer> => {
        if (body.length > maxBytes) {
            throw new PayloadTooLargeError(`Response exceeded maximum size limit of ${maxBytes} bytes`);
        }
        return body;
    };
    return {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': contentType },
        url,
        buffer: read,
        text: async () => (await read()).toString('utf-8'),
        json: async () => ({}),
    };
}

function makeFetchFn(page: Buffer, state: FetchState) {
    return async (url: string, options?: any): Promise<SsrfSafeResponse> => {
        state.fetches.push(url);

        if (url.includes('/embed/')) {
            state.embedMaxBytesAsked = options?.maxBytes ?? 0;
            const cap = state.embedCeiling
                ? Math.min(state.embedMaxBytesAsked, state.embedCeiling)
                : state.embedMaxBytesAsked;
            return cappedResponse(url, page, cap, 'text/html; charset=utf-8');
        }

        if (url.includes('cdninstagram.com')) {
            if (state.imageOk === false) {
                return {
                    status: 403, statusText: 'Forbidden', headers: { 'content-type': 'text/plain' },
                    url, buffer: async () => Buffer.from('Forbidden'), text: async () => 'Forbidden',
                    json: async () => ({}),
                };
            }
            return cappedResponse(url, sampleJpeg, options?.maxBytes ?? sampleJpeg.length, 'image/jpeg');
        }

        // The stale signed URL on the item: expired, as it is on the live node.
        return {
            status: 403, statusText: 'Forbidden', headers: { 'content-type': 'text/plain' },
            url, buffer: async () => Buffer.from('Forbidden'), text: async () => 'Forbidden',
            json: async () => ({}),
        };
    };
}

function freshState(over: Partial<FetchState> = {}): FetchState {
    return { fetches: [], embedMaxBytesAsked: 0, ...over };
}

// ── DB helpers ───────────────────────────────────────────────────────────────
function makeMember(callsign: string): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    db.prepare(
        `INSERT INTO members (public_key, callsign, status, joined_at, updated_at)
         VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(pubkey, callsign);
    return pubkey;
}

function makeChannel(ownerPubkey: string): string {
    const id = 'chan_' + crypto.randomBytes(8).toString('hex');
    db.prepare(
        `INSERT INTO creator_channels (id, owner_pubkey, platform, url, category, created_at, updated_at)
         VALUES (?, ?, 'instagram', 'https://www.instagram.com/a_maker/', 'art', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(id, ownerPubkey);
    return id;
}

function makeInstagramItem(channelId: string, ownerPubkey: string, externalId: string): string {
    const id = 'item_' + crypto.randomBytes(12).toString('hex');
    db.prepare(
        `INSERT INTO pulse_items (id, channel_id, owner_pubkey, platform, url, external_id, title, thumbnail_url, category, source, created_at, updated_at)
         VALUES (?, ?, ?, 'instagram', ?, ?, 'A post', ?, 'art', 'autolist', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(id, channelId, ownerPubkey, `https://www.instagram.com/p/${externalId}/`, externalId, STALE_THUMBNAIL_URL);
    return id;
}

function storedThumbnailUrl(itemId: string): string | null {
    const row = db.prepare(`SELECT thumbnail_url FROM pulse_items WHERE id = ?`).get(itemId) as { thumbnail_url: string | null } | undefined;
    return row?.thumbnail_url ?? null;
}

function backoffRowCount(itemId: string): number {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM pulse_thumbnail_backoff WHERE item_id = ?`).get(itemId) as { n: number };
    return row.n;
}

const HOUR_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
    console.log('=== Pulse Thumbnail Recovery & Backoff Test Suite ===\n');
    initStateEngine();

    const alice = makeMember('Alice');
    const chan = makeChannel(alice);
    const page = buildLargeEmbedPage();

    assert(
        page.length > OLD_EMBED_CAP_BYTES,
        `The fixture embed page is larger than the old 512 KB cap (${page.length} bytes)`
    );
    assert(
        page.length < INSTAGRAM_EMBED_MAX_BYTES,
        `The fixture embed page fits inside the embed cap of ${INSTAGRAM_EMBED_MAX_BYTES} bytes`
    );

    // ──────────────────────────────────────────────────────────────────────────
    // 1. Recovery succeeds on a large embed page
    // ──────────────────────────────────────────────────────────────────────────
    const okState = freshState();
    const okItem = makeInstagramItem(chan, alice, 'FIXTUREPOST');
    const okService = new PulseThumbnailService({
        diskStore: null,
        fetchFn: makeFetchFn(page, okState) as any,
    });

    const recovered = await okService.getThumbnail(okItem);
    assert(recovered.status === 200, 'A 403 on the stale URL recovers through the large embed page (200)');
    assert(Boolean(recovered.buffer?.equals(sampleJpeg)), 'The recovered bytes are the image the embed page pointed at');
    assert(
        okState.embedMaxBytesAsked === INSTAGRAM_EMBED_MAX_BYTES,
        `The embed page is read under the embed cap, not the image cap (asked for ${okState.embedMaxBytesAsked})`
    );
    assert(storedThumbnailUrl(okItem) === FRESH_CDN_URL, 'The fresh CDN URL is written back to the item');
    assert(backoffRowCount(okItem) === 0, 'A successful recovery leaves no backoff behind');

    // ──────────────────────────────────────────────────────────────────────────
    // 2. The old 512 KB cap fails on the SAME page
    // ──────────────────────────────────────────────────────────────────────────
    const cappedState = freshState({ embedCeiling: OLD_EMBED_CAP_BYTES });
    const cappedItem = makeInstagramItem(chan, alice, 'CAPPEDPOST');
    const cappedWarnings: string[] = [];
    const realWarn = logger.warn;
    (logger as any).warn = (_c: string, message: string) => { cappedWarnings.push(message); };

    const cappedService = new PulseThumbnailService({
        diskStore: null,
        fetchFn: makeFetchFn(page, cappedState) as any,
    });
    const capped = await cappedService.getThumbnail(cappedItem);
    (logger as any).warn = realWarn;

    assert(capped.status === 403, 'Held to the old 512 KB cap, the same page recovers nothing (403)');
    assert(
        cappedWarnings.some(m => m.includes(`Instagram embed recovery failed for item ${cappedItem}`)
            && m.includes('Response exceeded maximum size limit of 524288 bytes')),
        'The old cap reproduces the exact failure from the test node logs'
    );
    assert(storedThumbnailUrl(cappedItem) === STALE_THUMBNAIL_URL, 'The stale URL is left alone when recovery fails');

    // ──────────────────────────────────────────────────────────────────────────
    // 3. A failed item is not fetched again inside its backoff window
    // ──────────────────────────────────────────────────────────────────────────
    const fetchesAfterFirstAttempt = cappedState.fetches.length;
    assert(fetchesAfterFirstAttempt === 2, 'One failed attempt costs exactly two outbound fetches');
    assert(backoffRowCount(cappedItem) === 1, 'The failure is remembered in the database, not only in memory');

    // Clearing the in-memory layer is what a restart does to it, and is also what the five
    // minute TTL did on its own. Only the persisted backoff can hold the line here.
    cappedService.cache.clear();
    const secondAttempt = await cappedService.getThumbnail(cappedItem);
    assert(secondAttempt.status === 403, 'The backed-off item still refuses, so the card keeps its no-thumbnail fallback');
    assert(
        cappedState.fetches.length === fetchesAfterFirstAttempt,
        'No further outbound fetch is spent inside the backoff window'
    );

    // A genuine restart: a brand new service and a brand new backoff store over the same DB.
    const restartState = freshState({ embedCeiling: OLD_EMBED_CAP_BYTES });
    const restartedService = new PulseThumbnailService({
        diskStore: null,
        fetchFn: makeFetchFn(page, restartState) as any,
        backoffStore: new PulseThumbnailBackoffStore(),
    });
    const afterRestart = await restartedService.getThumbnail(cappedItem);
    assert(afterRestart.status === 403, 'After a restart the item is still refused');
    assert(restartState.fetches.length === 0, 'A restart does not reset the backoff — zero fetches');

    // ──────────────────────────────────────────────────────────────────────────
    // 4. The backoff escalates, caps, and a success clears it
    // ──────────────────────────────────────────────────────────────────────────
    let nowMs = Date.parse('2026-09-23T15:11:00Z');
    const clockStore = new PulseThumbnailBackoffStore({ now: () => nowMs });
    const stepState = freshState({ embedCeiling: OLD_EMBED_CAP_BYTES });
    const stepItem = makeInstagramItem(chan, alice, 'STEPPOST');
    const stepService = new PulseThumbnailService({
        diskStore: null,
        fetchFn: makeFetchFn(page, stepState) as any,
        backoffStore: clockStore,
    });

    const observedSteps: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
        const res = await stepService.getThumbnail(stepItem);
        if (res.status !== 403) {
            assert(false, `Attempt ${attempt + 1} should have failed while the old cap is in force`);
            break;
        }
        const entry = clockStore.getActive(stepItem, STALE_THUMBNAIL_URL);
        observedSteps.push(entry ? entry.retryAfterMs - nowMs : -1);
        // Walk past this step's window, and drop the in-memory layer so only the backoff decides.
        nowMs += (entry ? entry.retryAfterMs - nowMs : 0) + 1;
        stepService.cache.clear();
    }

    assert(
        observedSteps.length === 4 &&
        observedSteps[0] === THUMBNAIL_BACKOFF_STEPS_MS[0] &&
        observedSteps[1] === THUMBNAIL_BACKOFF_STEPS_MS[1] &&
        observedSteps[2] === THUMBNAIL_BACKOFF_STEPS_MS[2],
        `The backoff escalates 1 h -> 6 h -> 24 h (saw ${observedSteps.map(ms => ms / HOUR_MS).join(', ')} hours)`
    );
    assert(
        observedSteps[3] === THUMBNAIL_BACKOFF_STEPS_MS[THUMBNAIL_BACKOFF_STEPS_MS.length - 1],
        'The backoff caps at 24 hours rather than growing without bound'
    );
    assert(stepState.fetches.length === 8, 'Four attempts across four windows, two fetches each — not one per request');

    // The page stops being over the cap (the fix, or Instagram trimming its page): the next
    // attempt after the window succeeds and the item owes nothing.
    stepState.embedCeiling = undefined;
    const healed = await stepService.getThumbnail(stepItem);
    assert(healed.status === 200, 'Once recovery can complete, the item serves its thumbnail again');
    assert(backoffRowCount(stepItem) === 0, 'A success clears the backoff');
    assert(storedThumbnailUrl(stepItem) === FRESH_CDN_URL, 'The recovered URL replaces the stale one');

    // ──────────────────────────────────────────────────────────────────────────
    // 5. One log line per backoff step, not one per request
    // ──────────────────────────────────────────────────────────────────────────
    let logNowMs = Date.parse('2026-09-23T15:11:00Z');
    const logStore = new PulseThumbnailBackoffStore({ now: () => logNowMs });
    const logState = freshState({ embedCeiling: OLD_EMBED_CAP_BYTES });
    const logItem = makeInstagramItem(chan, alice, 'LOGPOST');
    const logService = new PulseThumbnailService({
        diskStore: null,
        fetchFn: makeFetchFn(page, logState) as any,
        backoffStore: logStore,
    });

    const lines: string[] = [];
    (logger as any).warn = (_c: string, message: string) => { lines.push(message); };
    try {
        // Twelve feed requests over the first hour — the shape that filled the log.
        for (let i = 0; i < 12; i++) {
            await logService.getThumbnail(logItem);
            logService.cache.clear();
        }
        const firstStepLines = lines.filter(m => m.includes(`for item ${logItem}`));
        assert(
            firstStepLines.filter(m => m.includes('Upstream refused')).length === 1,
            `Twelve requests inside one backoff step log ONE "Upstream refused" line (saw ${firstStepLines.filter(m => m.includes('Upstream refused')).length})`
        );
        assert(
            firstStepLines.filter(m => m.includes('Instagram embed recovery failed')).length === 1,
            'And ONE "Instagram embed recovery failed" line'
        );
        assert(logState.fetches.length === 2, 'Twelve requests cost two outbound fetches, not twenty-four');

        // Step two: one more line, once the window has passed.
        logNowMs += THUMBNAIL_BACKOFF_STEPS_MS[0] + 1;
        logService.cache.clear();
        await logService.getThumbnail(logItem);
        const afterStep = lines.filter(m => m.includes(`for item ${logItem}`) && m.includes('Upstream refused'));
        assert(afterStep.length === 2, 'The next backoff step logs exactly one more line');
    } finally {
        (logger as any).warn = realWarn;
    }

    console.log(`\nResults: ${passed}/${run} assertions passed.`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((err) => {
    console.error('Test suite failed with unhandled error:', err);
    process.exit(1);
});
