import { SsoProviderUnavailableError, SsoVerificationError } from './errors.js';
import { oidcConfig, providerConfig, type SsoProvider } from './providers.js';

/** A provider's published signing key, as its JWKS endpoint lists it. */
export interface Jwk {
    kid: string;
    kty: string;
    alg?: string;
    use?: string;
    n: string;
    e: string;
}

/** One provider's key set and when it goes stale. */
export interface JwksEntry {
    keys: Jwk[];
    expiresAt: number;
}

/** Where fetched key sets are kept, one entry per provider. A `Map` is one. */
export interface JwksStore {
    get(provider: SsoProvider): JwksEntry | undefined;
    set(provider: SsoProvider, entry: JwksEntry): void;
    delete(provider: SsoProvider): void;
    clear(): void;
}

/** The part of `fetch` this package uses. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JwksCacheOptions {
    /** Defaults to the global `fetch`, looked up at each request (so a test that swaps it is seen). */
    fetch?: FetchLike;
    /** Milliseconds since the epoch. Defaults to `Date.now()`. */
    now?: () => number;
    /** Defaults to a fresh in-memory Map. */
    store?: JwksStore;
}

export interface JwksCache {
    /** The key `kid` from `provider`'s published set, fetching (or refetching once) as needed. */
    getSigningKey(provider: SsoProvider, kid: string): Promise<Jwk>;
    /**
     * Tests need a deterministic starting point. Omit `provider` to clear every entry; otherwise that
     * provider's entry is replaced by `seed`, or removed when there is none.
     */
    reset(provider?: SsoProvider, seed?: JwksEntry | null): void;
}

/** Per request to a provider's JWKS endpoint. */
const JWKS_TIMEOUT_MS = 10_000;

// ─── JWKS cache ───────────────────────────────────────────────────────────────────────────────
//
// Both providers rotate signing keys and publish a Cache-Control max-age. Honouring it matters in
// both directions: fetching per verification would make the provider a hard dependency of every
// recovery attempt, and caching forever would break the day they rotate.
//
// KEYED BY PROVIDER, and that is not tidiness. A single shared cache was the obvious way to
// generalise #218's module-level variable, and it is wrong: whichever provider fetched last owns
// the cache, so every token from the other provider misses on its kid, triggers the
// refetch-once path, clobbers the cache in turn, and the two providers evict each other on every
// single verification. Worse, a kid collision across providers would select the wrong issuer's
// key. Separate entries make cross-provider key confusion unrepresentable rather than unlikely.
//
// The refetch-once-on-unknown-kid path below is the important one. A rotation that lands between
// our cache being populated and expiring would otherwise fail every verification for the rest of
// the TTL, and the user's symptom would be "recovery is broken" with nothing in the logs to say why.

export function parseMaxAge(cacheControl: string | null): number {
    const m = cacheControl?.match(/max-age=(\d+)/);
    const seconds = m ? parseInt(m[1], 10) : NaN;
    // Clamp: a hostile or broken header must not pin us to a key set for a week, nor cause a
    // fetch storm. 5 minutes to 24 hours.
    if (!Number.isFinite(seconds)) return 3600_000;
    return Math.min(Math.max(seconds, 300), 86_400) * 1000;
}

/** A key cache. A process makes one and keeps it: a new one starts cold and fetches again. */
export function createJwksCache(options: JwksCacheOptions = {}): JwksCache {
    const fetchFn: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const now = options.now ?? (() => Date.now());
    const jwksCache: JwksStore = options.store ?? new Map<SsoProvider, JwksEntry>();
    const inFlight = new Map<SsoProvider, Promise<Jwk[]>>();

    async function fetchJwks(provider: SsoProvider): Promise<Jwk[]> {
        // Coalesce concurrent misses into one request, so a node restarting under load does not open
        // a connection per in-flight verification. Per provider, for the same reason the cache is.
        const pending = inFlight.get(provider);
        if (pending) return pending;

        const config = oidcConfig(provider);
        const request = (async () => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), JWKS_TIMEOUT_MS);
            // Every way of not getting keys is the provider failing, not the member: these messages reach
            // the member (on a node, routes/keepers.ts signInFailure), so they say what happened and to try again.
            const unusable = `${config.label} sent sign-in keys this node could not use, so the sign-in could not be `
                + 'checked. Please try again in a minute.';
            try {
                let res: Response;
                try {
                    res = await fetchFn(config.jwksUri, { signal: controller.signal });
                } catch {
                    // Unreachable, or the 10 s timeout above.
                    throw new SsoProviderUnavailableError(
                        `${config.label} could not be reached to check the sign-in. Please try again in a minute.`);
                }
                if (!res.ok) {
                    throw new SsoProviderUnavailableError(`${config.label} is not answering right now (HTTP ${res.status}), so `
                        + 'the sign-in could not be checked. Please try again in a minute.');
                }
                let body: { keys?: unknown } | null;
                try {
                    body = await res.json() as { keys?: unknown } | null;
                } catch {
                    throw new SsoProviderUnavailableError(unusable);
                }
                const listed: unknown = body?.keys;
                const keys = (Array.isArray(listed) ? listed as Jwk[] : []).filter(k => k && k.kty === 'RSA' && k.n && k.e && k.kid);
                if (!keys.length) throw new SsoProviderUnavailableError(unusable);
                jwksCache.set(provider, {
                    keys,
                    expiresAt: now() + parseMaxAge(res.headers.get('cache-control')),
                });
                return keys;
            } finally {
                clearTimeout(timeout);
                inFlight.delete(provider);
            }
        })();

        inFlight.set(provider, request);
        return request;
    }

    async function getSigningKey(provider: SsoProvider, kid: string): Promise<Jwk> {
        // `refetched` is what makes "refetch once" true (CR finding on #218). Without it an expired
        // cache fetched here, missed on the kid, and then fetched AGAIN immediately — two round trips
        // for identical data, and exactly the provider-hammering the comment below claims to prevent.
        // A garbage kid arriving against a cold cache was the cheapest way to trigger it.
        let refetched = false;
        const cached = jwksCache.get(provider);
        if (!cached || cached.expiresAt <= now()) {
            await fetchJwks(provider);
            refetched = true;
        }
        let key = jwksCache.get(provider)?.keys.find(k => k.kid === kid);
        if (!key && !refetched) {
            // Unknown kid against a cache we believe is fresh means the provider rotated early.
            // Refetch once rather than fail — but only once, so a token with a garbage kid cannot be
            // used to make this node hammer the provider.
            await fetchJwks(provider);
            key = jwksCache.get(provider)?.keys.find(k => k.kid === kid);
        }
        if (!key) {
            throw new SsoVerificationError(
                `${providerConfig(provider).label} token signed by unknown key (kid=${kid})`,
            );
        }
        return key;
    }

    function reset(provider?: SsoProvider, seed?: JwksEntry | null): void {
        if (!provider) {
            jwksCache.clear();
            inFlight.clear();
            return;
        }
        if (seed) jwksCache.set(provider, seed); else jwksCache.delete(provider);
        inFlight.delete(provider);
    }

    return { getSigningKey, reset };
}
