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
    /**
     * Whether App Lock's own unlock prompt is open now (LocalAuth.isAppLockPromptOpen). Leaving the front while it is open
     * is the prompt's doing, not the member's: see createForceUpdateGate. Absent: never.
     */
    appLockPromptOpen?(): boolean;
    /** Resolves once no App Lock prompt is open (LocalAuth.whenAppLockPromptsClose). Absent: at once. */
    whenAppLockPromptsClose?(): Promise<void>;
}

export interface ForceUpdateGate {
    /** At launch, with AppState.currentState. */
    start(appState: string | null | undefined): Promise<void>;
    /** Every AppState change. */
    appStateChanged(next: string): Promise<void>;
    /**
     * The phone moved to another community, or left its last one (utils/community-switch.ts). The block was the
     * community left's, so it comes down; and a switch bounces the app through Welcome, so it is a safe moment: the
     * community now in use is asked at once. Switching back to a community whose floor stops this app puts it up again.
     */
    communitySwitched(): Promise<void>;
}

/**
 * When the block goes up. Every safe moment asks the community, and a "block" answer goes up only if it came within
 * DECIDE_WITHIN_MS while the app was still in front.
 *
 * App Lock's own prompt is not the member leaving. It opens at the very safe moments the block waits for (at launch, and
 * on every return after 15 seconds), and while it is open the app is out of the front: iOS's Face ID and passcode make
 * it 'inactive', Android 8-10's PIN screen sends it to 'background'. Counted as a leave, the answer that landed during
 * the prompt was dropped and the 'active' after it looked like a return after a second, so a member with App Lock on was
 * almost never shown the block (#1415's deciding review). So a leave while App Lock's prompt is open keeps the app
 * counted as in front: an answer that lands meanwhile is held, and goes up as soon as the prompt has closed and the app
 * is back. The prompt closing while the app is still away (Android hands the answer over before the app is back; a
 * member who pressed home during it) starts an ordinary leave from that moment, so the next return is timed from it, and
 * a held answer still goes up on that return unless it was a safe moment of its own (then the community is asked anew).
 * A door's prompt (the member's words, a payment) is not App Lock's, and still counts as leaving: the block never lands
 * in the middle of what the member started.
 */
export function createForceUpdateGate(deps: ForceUpdateGateDeps): ForceUpdateGate {
    let blocked: { version: string } | null = null;
    /** In front, or out of it only while App Lock's prompt is open (promptAway). */
    let inFront = false;
    let beenInFront = false;
    /** The app left the front while App Lock's prompt was open, and has not come back yet. */
    let promptAway = false;
    let leftAt: number | null = null;
    let asks = 0;
    /** A block decided at a safe moment while App Lock's prompt was up: it goes up once the prompt has closed. */
    let held: { version: string } | null = null;

    const promptOpen = () => {
        try { return deps.appLockPromptOpen?.() === true; } catch { return false; }
    };

    const show = (next: { version: string } | null) => {
        held = null;
        if (next?.version === blocked?.version) return;
        blocked = next;
        deps.show(next);
    };

    /** Shows a held block if the app is in front with no App Lock prompt open now. */
    const showHeld = () => {
        if (held && inFront && !promptAway && !promptOpen()) show(held);
    };

    /** Once App Lock's prompts have closed: show what was held, or start the leave the prompt was covering. */
    function afterPrompt(): void {
        const wait = deps.whenAppLockPromptsClose ? deps.whenAppLockPromptsClose() : Promise.resolve();
        void wait.then(() => {
            // Another prompt opened at once (a cancelled launch prompt, then Unlock App): wait for that one too.
            if (promptOpen()) { afterPrompt(); return; }
            if (promptAway) {
                // Still out of the front with no prompt open: from now on that is the member away.
                promptAway = false;
                inFront = false;
                leftAt = deps.now();
                return;
            }
            showHeld();
        }, () => {});
    }

    async function safeMoment(): Promise<void> {
        const ask = ++asks;
        held = null;
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
        // Raised only at the safe moment itself: the app is still in front (App Lock's prompt aside) and the answer came
        // in time. NaN is not.
        const took = deps.now() - at;
        if (!inFront || !(took <= DECIDE_WITHIN_MS)) return;
        if (promptAway || promptOpen()) {
            held = { version: decision.version };
            afterPrompt();
            return;
        }
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
                if (promptAway) {
                    // Back from App Lock's prompt: not a return. What it held goes up once no prompt is open.
                    promptAway = false;
                    if (promptOpen()) afterPrompt();
                    else showHeld();
                    return;
                }
                if (inFront) return;
                inFront = true;
                const first = !beenInFront;
                beenInFront = true;
                const away = leftAt === null ? Number.NaN : deps.now() - leftAt;
                leftAt = null;
                // While the block is up, every return asks again: it can only take it down or keep it.
                if (first || blocked || away >= SAFE_RETURN_MS) { await safeMoment(); return; }
                // A block held through App Lock's prompt, whose answer came while the app was away only because of it.
                showHeld();
                return;
            }
            if (next === 'background' || next === 'inactive') {
                if (!inFront || promptAway) return;
                if (promptOpen()) {
                    promptAway = true;
                    afterPrompt();
                    return;
                }
                inFront = false;
                held = null;
                leftAt = deps.now();
            }
        },
        async communitySwitched() {
            asks++;
            show(null);
            if (inFront && !promptAway) await safeMoment();
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
