import { providerConfig, type SsoProvider } from './providers.js';

// ─── which client IDs a sign-in may be issued to ─────────────────────────────────────────────
//
// Nothing here reads the environment. A node passes its operator's settings in (apps/server/src/sso.ts
// reads them from its env); the key vault passes none, so it accepts BeanPool's own ids and nothing else.

/**
 * BeanPool's own Google client IDs, one per platform.
 *
 * Baked in rather than required config, because the alternative is that every node operator has
 * to obtain a Google client ID and an Apple developer account before the official app can hand
 * their members a keeper fragment — and the app's token carries OUR audience regardless of which
 * node it is talking to.
 *
 * These are public values. A client ID identifies an application; it authorises nothing on its
 * own, which is the whole reason Google and Apple survived D11 while Facebook did not.
 *
 * Android note: the ANDROID client IDs are listed for completeness but the app sends the WEB one
 * as its serverClientId, so in practice `aud` comes back as the web ID on both platforms. They are
 * accepted anyway because which ID lands in `aud` depends on SDK and configuration, and a node
 * that refuses a legitimate token from the official app is a worse failure than one that accepts
 * a token from our own Android client.
 *
 * The web client comes first: a browser signs in with the first Google audience (webClientId).
 */
export const BEANPOOL_GOOGLE_CLIENT_IDS: readonly string[] = [
    '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com', // Web / serverClientId
    '653933790375-do6obrlc7h7qjvanb896mc33vvsvndth.apps.googleusercontent.com', // iOS
    '653933790375-1j7k7rg0rhsiedpb0rqqqipv14k90vic.apps.googleusercontent.com', // Android, EAS build key
    '653933790375-ts3j6m5s3b27q95tfhlttuucacvakr4l.apps.googleusercontent.com', // Android, Play signing key
];

/**
 * Apple has no `apps.googleusercontent.com`-style client ID. The audience is the identifier of
 * whichever Apple client issued the token:
 *
 *   native  the App ID / bundle identifier   — apps/native/app.json `ios.bundleIdentifier`
 *   web     the Services ID                  — also apps/server's apple-probe.ts APPLE_SERVICES_ID
 *
 * Both are accepted because the same member may deposit from the phone and recover from a
 * browser. That is the cross-platform case the whole design exists for, and it only works if
 * Apple returns the SAME `sub` on both — which requires the Services ID to be grouped under the
 * primary App ID, and is what #213's probe measures. Accepting both audiences is necessary for
 * that to work; it is not sufficient, and the probe is still owed.
 */
export const BEANPOOL_APPLE_BUNDLE_ID = 'org.beanpool.pillar';
export const BEANPOOL_APPLE_SERVICES_ID = 'org.beanpool.web';

/** BeanPool's Meta app (the member sign-in app, never the Pulse one). The same id on every platform. */
export const BEANPOOL_FACEBOOK_APP_ID = '818892721251369';

/**
 * A caller's own additions and replacements. On a node these come from its env, under the names in
 * brackets; the key vault passes none.
 */
export interface AudienceSettings {
    /** One more Facebook app id, accepted beside BeanPool's [FACEBOOK_APP_ID]. */
    facebookAppId?: string;
    /** The Apple Services ID a browser signs in with, in place of BeanPool's [APPLE_SERVICES_ID]. */
    appleServicesId?: string;
    /**
     * Per provider, a comma-separated list that REPLACES the defaults for that provider
     * [GOOGLE_CLIENT_IDS, APPLE_CLIENT_IDS, FACEBOOK_CLIENT_IDS]. Blank means the defaults.
     */
    replace?: Partial<Record<SsoProvider, string | undefined>>;
}

/** The Apple client a browser signs in with: the caller's Services ID, else BeanPool's. */
export function appleServicesId(settings: AudienceSettings = {}): string {
    return settings.appleServicesId?.trim() || BEANPOOL_APPLE_SERVICES_ID;
}

/** BeanPool's ids for a provider, plus the caller's one extra Facebook id. */
export function defaultAudiences(provider: SsoProvider, settings: AudienceSettings = {}): string[] {
    if (provider === 'google') return [...BEANPOOL_GOOGLE_CLIENT_IDS];
    if (provider === 'apple') {
        return [...new Set([BEANPOOL_APPLE_BUNDLE_ID, appleServicesId(settings)])];
    }
    if (provider === 'facebook') return [BEANPOOL_FACEBOOK_APP_ID, settings.facebookAppId?.trim() || ''].filter(Boolean);
    return [];
}

/**
 * The audiences a caller will accept for a provider, newest config winning.
 *
 * A replacement list (a node's `GOOGLE_CLIENT_IDS` / `APPLE_CLIENT_IDS`, comma separated) REPLACES the
 * defaults rather than adding to them. An operator who sets one is saying "only my application may
 * deposit keeper fragments here", and silently continuing to accept BeanPool's would defeat that. An
 * operator who wants both lists theirs alongside ours explicitly.
 *
 * Self-hosted web sign-in needs this: Google has no wildcard for JavaScript origins, so a node on
 * its own domain cannot use our Web client from a browser and needs its own. Apple is the same
 * story with a Services ID and its Return URLs. The native app is unaffected by either — its
 * clients are keyed on package/bundle ID, not domain, which is why native is the path we build
 * first for both providers.
 */
export function configuredAudiences(provider: SsoProvider, settings: AudienceSettings = {}): string[] {
    providerConfig(provider);
    const raw = settings.replace && Object.prototype.hasOwnProperty.call(settings.replace, provider)
        ? settings.replace[provider]
        : undefined;
    if (typeof raw !== 'string' || !raw.trim()) return defaultAudiences(provider, settings);
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/** The providers a browser signs in with by leaving the page for the provider's own (design G11 §3). */
export type WebSignInProvider = 'google' | 'apple' | 'facebook';

/**
 * The client id a BROWSER puts in its sign-in request to `provider`, or null when the caller accepts none a browser
 * can use. A node answers it beside every sign-in nonce (`clientIds`), so the web app learns it from the node it is
 * on, not from its build: a self-hosted node with its own ids serves web sign-in with the same web app.
 *
 *   google    the first audience accepted. BeanPool's list starts with its Web client; an operator who
 *             replaces the list with GOOGLE_CLIENT_IDS lists their web client first.
 *   apple     the Services ID (appleServicesId), only while it is accepted: an APPLE_CLIENT_IDS that leaves
 *             it out gets null, never an id whose tokens the node would then refuse.
 *   facebook  the first app id accepted.
 */
export function webClientId(provider: WebSignInProvider, settings: AudienceSettings = {}): string | null {
    const accepted = configuredAudiences(provider, settings);
    if (provider === 'apple') {
        const servicesId = appleServicesId(settings);
        return accepted.includes(servicesId) ? servicesId : null;
    }
    return accepted[0] ?? null;
}

/** `webClientId` for each provider a browser redirects to, as the nonce answers carry it. */
export function webClientIds(settings: AudienceSettings = {}): Record<WebSignInProvider, string | null> {
    return {
        google: webClientId('google', settings),
        apple: webClientId('apple', settings),
        facebook: webClientId('facebook', settings),
    };
}
