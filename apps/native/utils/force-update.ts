/**
 * The full-screen "Update required" (components/ForceUpdateBlock.tsx): when an app below its community's floor stops,
 * and only then.
 *
 * Until this build an app below the floor got a banner it could not dismiss (GlobalHeader, utils/app-version.ts) and kept
 * working. That banner stays, and stays the only thing shown while the app is in use. The block is only ever put up at a
 * SAFE MOMENT, so it never lands on a half-written message or a payment being confirmed:
 *   - a cold start (or, for an app the phone started in the background, the first time it comes to the front);
 *   - a return to the front after at least SAFE_RETURN_MS away.
 * At a safe moment the app asks its community (GET /api/community/health) and puts the block up only if the answer comes
 * within DECIDE_WITHIN_MS and the app is still in front: a slow answer waits for the next safe moment rather than
 * covering whatever the member has started since. Once up, every return to the front asks again, and an answer that no
 * longer blocks takes it down (an operator who lowered the floor, a phone back from the store).
 *
 * Whether to block is the node's answer (apps/server/src/app-store-versions.ts getAppFloors), checked again here, and
 * every doubt is "no": no community, no answer, an older node with no `appFloors`, a version that is not a version on
 * either side, a store version the node does not know, or one below the floor (nobody is held to a build they cannot
 * download). The grace date is the node's (`blocking`, on its clock): a phone's own clock is not trusted for it.
 */
import { normaliseVersion, isVersionOlder, pickStoreVersion, type AppStoreVersions } from './app-version';

/** How long away makes a return a safe moment. */
export const SAFE_RETURN_MS = 5 * 60 * 1000;
/** How long after a safe moment its answer may still put the block up. */
export const DECIDE_WITHIN_MS = 10_000;
/** The health request's own limit: inside DECIDE_WITHIN_MS. */
export const CHECK_TIMEOUT_MS = 8_000;

/** The header the app names itself with on every request to its own community (utils/node-request-signing.ts). */
export const APP_VERSION_HEADER = 'X-BeanPool-App';

/**
 * `<version> <platform>`, for the community's counts of who runs what (apps/server/src/app-version-counts.ts): only on a
 * phone, and only with a real version. Null otherwise (the web build sends nothing: a header there would make a browser
 * ask the node's permission first for every request).
 */
export function appVersionHeaderValue(version: unknown, platform: string): string | null {
    const v = normaliseVersion(version);
    if (!v || (platform !== 'ios' && platform !== 'android')) return null;
    return `${v} ${platform}`;
}

export type ForceUpdateDecision =
    /** No answer to go on: whatever is on screen stays as it is. */
    | { kind: 'unknown' }
    /** The community answered, and this app may carry on. */
    | { kind: 'clear' }
    /** The community answered, and this app is below its floor: `version` is the store's build to install. */
    | { kind: 'block'; version: string };

/** What a community's health answer means for this app (`localVersion` on `platform`). */
export function evaluateForceUpdate(localVersion: unknown, health: unknown, platform: string): ForceUpdateDecision {
    if (!health || typeof health !== 'object') return { kind: 'unknown' };
    const local = normaliseVersion(localVersion);
    if (!local || (platform !== 'ios' && platform !== 'android')) return { kind: 'clear' };
    const entry = (health as { appFloors?: Record<string, unknown> }).appFloors?.[platform] as { min?: unknown; blocking?: unknown } | undefined;
    // An older node, with no floors to enforce: it has answered, and it never blocks.
    if (!entry || typeof entry !== 'object') return { kind: 'clear' };
    const min = normaliseVersion(entry.min);
    if (!min || entry.blocking !== true) return { kind: 'clear' };
    const store = pickStoreVersion((health as { appVersions?: AppStoreVersions | null }).appVersions, platform);
    // The node enforces a floor only once the store has it; checked again here, so no node can hold anyone to a build
    // the store does not have, or that nobody knows it has.
    if (!store || isVersionOlder(store, min)) return { kind: 'clear' };
    if (!isVersionOlder(local, min)) return { kind: 'clear' };
    return { kind: 'block', version: store };
}

export interface ForceUpdateGateDeps {
    /** Milliseconds on a clock that keeps counting while the phone sleeps. NaN (unreadable) never makes a safe moment. */
    now(): number;
    /** Ask the community. Never throws for it to matter: a throw is 'unknown'. */
    check(): Promise<ForceUpdateDecision>;
    /** Put the block up, naming the build to install, or take it down (null). */
    show(block: { version: string } | null): void;
}

export interface ForceUpdateGate {
    /** At launch, with AppState.currentState. */
    start(appState: string | null | undefined): Promise<void>;
    /** Every AppState change. */
    appStateChanged(next: string): Promise<void>;
}

export function createForceUpdateGate(deps: ForceUpdateGateDeps): ForceUpdateGate {
    let blocked: { version: string } | null = null;
    let inFront = false;
    let beenInFront = false;
    let leftAt: number | null = null;
    let asks = 0;

    const show = (next: { version: string } | null) => {
        if (next?.version === blocked?.version) return;
        blocked = next;
        deps.show(next);
    };

    async function safeMoment(): Promise<void> {
        const ask = ++asks;
        const at = deps.now();
        let decision: ForceUpdateDecision;
        try { decision = await deps.check(); } catch { decision = { kind: 'unknown' }; }
        // A later ask has the newer answer.
        if (ask !== asks || decision.kind === 'unknown') return;
        if (blocked) {
            // Already covering the app: the answer applies whatever it is.
            show(decision.kind === 'block' ? { version: decision.version } : null);
            return;
        }
        if (decision.kind !== 'block') return;
        // Raised only at the safe moment itself: the app is still in front and the answer came in time. NaN is not.
        const took = deps.now() - at;
        if (!inFront || !(took <= DECIDE_WITHIN_MS)) return;
        show({ version: decision.version });
    }

    return {
        async start(appState) {
            if (appState === 'active') {
                inFront = true;
                beenInFront = true;
                await safeMoment();
            }
        },
        async appStateChanged(next) {
            if (next === 'active') {
                if (inFront) return;
                inFront = true;
                const first = !beenInFront;
                beenInFront = true;
                const away = leftAt === null ? Number.NaN : deps.now() - leftAt;
                leftAt = null;
                // While the block is up, every return asks again: it can only take it down or keep it.
                if (first || blocked || away >= SAFE_RETURN_MS) await safeMoment();
                return;
            }
            if (next === 'background' || next === 'inactive') {
                if (!inFront) return;
                inFront = false;
                leftAt = deps.now();
            }
        },
    };
}

/** Where the Update button goes: the store app, then the store's web page if the phone has no store app. */
export const STORE_URLS = {
    ios: { app: 'itms-apps://itunes.apple.com/app/id6761870086', web: 'https://apps.apple.com/us/app/bean-pool/id6761870086' },
    android: { app: 'market://details?id=org.beanpool.pillar', web: 'https://play.google.com/store/apps/details?id=org.beanpool.pillar' },
} as const;

/** The community's answer, as the gate asks for it: the active community's health, within CHECK_TIMEOUT_MS. */
export async function checkCommunityForUpdate(opts: {
    anchorUrl: () => Promise<string | null>;
    fetchJson: (url: string, timeoutMs: number) => Promise<unknown>;
    localVersion: string;
    platform: string;
}): Promise<ForceUpdateDecision> {
    let anchor: string | null;
    try { anchor = await opts.anchorUrl(); } catch { return { kind: 'unknown' }; }
    if (!anchor) return { kind: 'unknown' };
    let health: unknown;
    try { health = await opts.fetchJson(`${anchor}/api/community/health`, CHECK_TIMEOUT_MS); } catch { return { kind: 'unknown' }; }
    // The answer is about the community asked: one the member switched away from meanwhile says nothing.
    try { if ((await opts.anchorUrl()) !== anchor) return { kind: 'unknown' }; } catch { return { kind: 'unknown' }; }
    return evaluateForceUpdate(opts.localVersion, health, opts.platform);
}
