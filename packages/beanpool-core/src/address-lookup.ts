/**
 * Address lookup against OpenStreetMap's Nominatim, shared by the settings app's node location search and the
 * event forms on the web and phone apps.
 *
 * The request goes straight from the device to nominatim.openstreetmap.org, so the typed text and the device's
 * IP reach OpenStreetMap. Nominatim's usage policy (operations.osmfoundation.org/policies/nominatim) asks for:
 * at most one request a second, an HTTP Referer or User-Agent that names the app, and cached results. This
 * module keeps all three — the 1 s debounce, a hard 1 s floor between requests, one request in flight, and a
 * small per-lookup cache — so no screen can get them wrong on its own.
 */

export const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
export const ADDRESS_LOOKUP_MIN_CHARS = 3;
export const ADDRESS_LOOKUP_DEBOUNCE_MS = 1000;
/** Nominatim's absolute maximum is one request per second. */
export const ADDRESS_LOOKUP_MIN_INTERVAL_MS = 1000;
export const ADDRESS_LOOKUP_LIMIT = 5;
const CACHE_MAX = 20;

export interface AddressResult {
    /** Nominatim's full display name, e.g. "Byron Bay, Byron Shire Council, New South Wales, Australia". */
    displayName: string;
    /** A short name for a place-name field, e.g. "Byron Bay" or "12 Main Street". */
    shortName: string;
    /** Rounded to 6 decimal places (~10 cm), as the settings app always did. */
    lat: number;
    lng: number;
    /** Nominatim's feature type, e.g. "town", "house". */
    type: string;
}

export function buildNominatimSearchUrl(query: string, limit = ADDRESS_LOOKUP_LIMIT): string {
    return `${NOMINATIM_SEARCH_URL}?format=json&q=${encodeURIComponent(query)}&limit=${limit}`;
}

/** The short name of a result: Nominatim's own `name`, else the first part of the display name, keeping a
 *  house number with its street ("12, Main Street, …" → "12 Main Street"). */
export function shortAddressName(item: { name?: unknown; display_name?: unknown }): string {
    if (typeof item.name === 'string' && item.name.trim()) return item.name.trim();
    const parts = typeof item.display_name === 'string'
        ? item.display_name.split(',').map(p => p.trim()).filter(Boolean)
        : [];
    if (parts.length === 0) return '';
    if (parts.length > 1 && /^\d+[a-z]?(?:[-/]\d+[a-z]?)?$/i.test(parts[0])) return `${parts[0]} ${parts[1]}`;
    return parts[0];
}

function round6(n: number): number {
    return parseFloat(n.toFixed(6));
}

/** Turn a Nominatim /search JSON body into results; anything malformed is dropped rather than thrown. */
export function parseNominatimResults(data: unknown, limit = ADDRESS_LOOKUP_LIMIT): AddressResult[] {
    if (!Array.isArray(data)) return [];
    const out: AddressResult[] = [];
    for (const item of data) {
        if (!item || typeof item !== 'object') continue;
        const lat = parseFloat((item as any).lat);
        const lng = parseFloat((item as any).lon);
        const displayName = (item as any).display_name;
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || typeof displayName !== 'string') continue;
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
        out.push({
            displayName,
            shortName: shortAddressName(item as any),
            lat: round6(lat),
            lng: round6(lng),
            type: typeof (item as any).type === 'string' ? (item as any).type : '',
        });
        if (out.length >= limit) break;
    }
    return out;
}

/** Drop results whose display name repeats an earlier one — OpenStreetMap returns each segment of a street as
 *  its own "Dalley Street, Mullumbimby, …", which reads as the same row twice. */
export function dedupeAddressResults(results: AddressResult[]): AddressResult[] {
    const seen = new Set<string>();
    return results.filter(r => {
        const key = r.displayName.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export type AddressLookupState =
    /** Nothing to show: under the minimum length, or cleared. */
    | { status: 'idle'; query: string; results: [] }
    /** Waiting out the debounce or the request itself. */
    | { status: 'searching'; query: string; results: [] }
    /** The answer for `query` (possibly empty — "no matches"). */
    | { status: 'done'; query: string; results: AddressResult[] }
    /** The request failed (offline, HTTP error, bad body). */
    | { status: 'error'; query: string; results: [] };

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
    ok: boolean;
    status?: number;
    json(): Promise<unknown>;
}>;

export interface AddressLookupOptions {
    onState: (state: AddressLookupState) => void;
    /** Defaults to the global fetch. */
    fetch?: FetchLike;
    /** Extra request headers. React Native sets `User-Agent` here to name the app; browsers send a Referer. */
    headers?: Record<string, string>;
    debounceMs?: number;
    minChars?: number;
    limit?: number;
    /** Show one row per display name (see dedupeAddressResults). Off by default, as the settings app has it. */
    dedupe?: boolean;
    /** Injected for tests. */
    now?: () => number;
}

export interface AddressLookup {
    /** Call on every change of the text box. Searches once the text has settled for the debounce time. */
    input(value: string): void;
    /** Search now (the keyboard's Search key), still never sooner than 1 s after the last request. */
    submit(value: string): void;
    /** Drop any pending or in-flight search and go idle. */
    cancel(): void;
    /** Cancel and never report again (unmount). */
    dispose(): void;
}

export function createAddressLookup(opts: AddressLookupOptions): AddressLookup {
    const debounceMs = opts.debounceMs ?? ADDRESS_LOOKUP_DEBOUNCE_MS;
    const minChars = opts.minChars ?? ADDRESS_LOOKUP_MIN_CHARS;
    const limit = opts.limit ?? ADDRESS_LOOKUP_LIMIT;
    const now = opts.now ?? (() => Date.now());
    const doFetch: FetchLike = opts.fetch ?? ((url, init) => (globalThis as any).fetch(url, init));

    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let lastRequestAt = -Infinity;
    let disposed = false;
    const cache = new Map<string, AddressResult[]>();

    const emit = (state: AddressLookupState) => { if (!disposed) opts.onState(state); };

    const stop = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (controller) { controller.abort(); controller = null; }
    };

    const run = async (q: string) => {
        timer = null;
        const key = q.toLowerCase();
        const cached = cache.get(key);
        if (cached) { emit({ status: 'done', query: q, results: cached }); return; }
        const mine = new AbortController();
        controller = mine;
        lastRequestAt = now();
        try {
            const res = await doFetch(buildNominatimSearchUrl(q, limit), {
                signal: mine.signal,
                ...(opts.headers ? { headers: opts.headers } : {}),
            });
            if (mine.signal.aborted) return;
            if (!res.ok) throw new Error(`Nominatim answered ${res.status ?? 'an error'}`);
            const parsed = parseNominatimResults(await res.json(), limit);
            const results = opts.dedupe ? dedupeAddressResults(parsed) : parsed;
            if (mine.signal.aborted) return;
            cache.set(key, results);
            if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
            emit({ status: 'done', query: q, results });
        } catch (err: unknown) {
            if (mine.signal.aborted || (err as Error)?.name === 'AbortError') return;
            emit({ status: 'error', query: q, results: [] });
        } finally {
            if (controller === mine) controller = null;
        }
    };

    const schedule = (value: string, wait: number) => {
        stop();
        const q = value.trim();
        if (q.length < minChars) { emit({ status: 'idle', query: q, results: [] }); return; }
        const cached = cache.get(q.toLowerCase());
        if (cached) { emit({ status: 'done', query: q, results: cached }); return; }
        emit({ status: 'searching', query: q, results: [] });
        const floor = Math.max(0, lastRequestAt + ADDRESS_LOOKUP_MIN_INTERVAL_MS - now());
        timer = setTimeout(() => { void run(q); }, Math.max(wait, floor));
    };

    return {
        input: (value) => { if (!disposed) schedule(value, debounceMs); },
        submit: (value) => { if (!disposed) schedule(value, 0); },
        cancel: () => { stop(); emit({ status: 'idle', query: '', results: [] }); },
        dispose: () => { stop(); disposed = true; },
    };
}
