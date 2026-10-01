/**
 * Door work on the phone: the small piece of work the global community's door asks for before it makes someone a
 * member (two-doors design §3, scratch/global-node/DESIGN-global-two-doors-fable.md; the puzzle itself is
 * @beanpool/core door-work.ts, which the node checks).
 *
 * ## The solver
 *
 * `expo-crypto`'s `digest` over one reused 64 KB buffer: on a phone it is ONE synchronous native SHA-256 call a try
 * (expo-crypto 55's `ExpoCrypto.digest`, wrapped in a promise), which is what makes this bearable on Hermes, whose
 * JavaScript is far too slow for a JavaScript hash. No new dependency, nothing of ours or anyone's is asked: the
 * challenge comes from the node being joined, and the answer goes back to it (memory `no-domain-lock-in`).
 *
 * The tries run on the app's JavaScript thread, so they run in short batches ({@link DOOR_WORK_SLICE_MS}) and let the
 * screen breathe between them (a zero-delay timer): typing a name stays smooth while the work runs.
 *
 * ## Started when the door opens, so nobody waits at ordinary levels
 *
 * {@link startDoorWork} fetches a challenge (`POST /api/join/work`, signed by the joining key) and solves it while the
 * member reads the door and types their name. At levels 0 to 2 that is done long before Join. A challenge is good for
 * ten minutes: one about to run out is replaced by a new one, quietly, and so is one the node refuses as spent,
 * expired or not its own (a restart): the member never sees an error for that unless it happens twice.
 *
 * ## The estimate (from level 3)
 *
 * The phone times its own first part: the time per try, from at least {@link ESTIMATE_MIN_TRIES} tries, times the tries
 * a whole solve takes on average at that level. That is what the busy-level sentence says ({@link busyLevelSentence}).
 *
 * ## Never a hard gate
 *
 * A phone that can't run the solver (no native hash) is told so in a sentence, with the sign-in door beside it
 * ({@link DOOR_WORK_MESSAGES}.solverUnavailable). Nothing here is ever a reason the app won't start.
 */

import * as Crypto from 'expo-crypto';
import {
    DOOR_WORK_PARTS,
    doorWorkExpectedTries,
    parseDoorWorkChallenge,
    solveDoorWork,
    type DoorWorkDigest,
    type DoorWorkDoor,
} from '@beanpool/core';
import { signedPost } from './node-post';
import type { BeanPoolIdentity } from './identity';
import { readDoorAnswer, retryAfterSeconds, DOOR_MESSAGES, JOIN_TIMEOUT_MS, type DoorAnswer } from './global-join';

export const DOOR_WORK_PATH = '/api/join/work';

/** Hash for about this long, then let the screen breathe. */
export const DOOR_WORK_SLICE_MS = 8;

/** The fewest tries the estimate is timed over: one part can be lucky and take a handful. */
export const ESTIMATE_MIN_TRIES = 32;

/** A challenge with less than this left is replaced before it is used: the join has to reach the node in time. */
export const DOOR_WORK_EXPIRY_MARGIN_MS = 60_000;

/** How many times a challenge that ran out while nobody tapped Join is replaced by itself: an hour's worth. */
export const DOOR_WORK_MAX_REFRESHES = 6;

/** From this level on the door says joining is busy, with this phone's own estimate (design §3.5). */
export const BUSY_LEVEL = 3;

export const DOOR_WORK_MESSAGES = {
    /** The solver can't run on this phone at all (design §3.4). */
    solverUnavailable: 'This phone can\'t finish setting up a 12-words account right now. Try again, or sign in.',
    /** Under the joining spinner while the work finishes. */
    settingUp: 'Setting up your account…',
} as const;

/** `expo-crypto`'s native SHA-256 (one call over the whole buffer). Read when called, never at import. */
export const phoneSha256: DoorWorkDigest = (bytes) => Crypto.digest('SHA-256' as Crypto.CryptoDigestAlgorithm, bytes as Uint8Array<ArrayBuffer>);

/** What the node issued (`POST /api/join/work`'s `work`). */
export interface IssuedDoorWork {
    challenge: string;
    level: number;
    parts: number;
    bits: number;
    size: number;
    expiresInSeconds: number;
}

/** What the work route said. `none`: no work is needed at this door now (the sign-in door at ordinary rates). */
export type DoorWorkFetch =
    | { kind: 'work'; work: IssuedDoorWork; receivedAt: number }
    | { kind: 'none' }
    | { kind: 'refused'; answer: DoorAnswer };

/** The work the join carries. */
export interface DoorWorkSolution {
    challenge: string;
    counters: number[];
}

/** Read the work route's answer: a challenge this app can solve, none, or null when it is neither. */
export function readIssuedWork(body: unknown): IssuedDoorWork | 'none' | null {
    const work = (body as { work?: unknown } | null)?.work;
    if (work === null) return 'none';
    if (!work || typeof work !== 'object') return null;
    const w = work as Record<string, unknown>;
    const parsed = parseDoorWorkChallenge(w.challenge);
    if (!parsed) return null;
    const seconds = typeof w.expiresInSeconds === 'number' && w.expiresInSeconds > 0 ? w.expiresInSeconds : 600;
    return {
        challenge: w.challenge as string,
        // The challenge's own level is what the node checks: never another number beside it.
        level: parsed.level,
        parts: DOOR_WORK_PARTS,
        bits: typeof w.bits === 'number' ? w.bits : 7 + parsed.level,
        size: typeof w.size === 'number' ? w.size : 65_536,
        expiresInSeconds: seconds,
    };
}

/**
 * Ask the door for work at `door`, signed by the joining key. Never throws: no answer is `refused` with `unreachable`,
 * and every refusal is a {@link DoorAnswer} the screens already know how to say.
 */
export async function fetchDoorWork(
    url: string, identity: BeanPoolIdentity, door: DoorWorkDoor, options: { timeoutMs?: number; now?: () => number } = {},
): Promise<DoorWorkFetch> {
    const now = options.now ?? Date.now;
    let res: Response | null;
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), options.timeoutMs ?? JOIN_TIMEOUT_MS);
    try {
        res = await signedPost(url, DOOR_WORK_PATH, { door }, identity, stop.signal);
    } catch {
        res = null;
    } finally {
        clearTimeout(timer);
    }
    if (!res) return { kind: 'refused', answer: { kind: 'unreachable', message: DOOR_MESSAGES.unreachable } };
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { kind: 'refused', answer: readDoorAnswer(res.status, body, retryAfterSeconds(res)) };
    const work = readIssuedWork(body);
    if (work === 'none') return { kind: 'none' };
    if (!work) return { kind: 'refused', answer: { kind: 'try_again', message: DOOR_MESSAGES.tryAgain } };
    return { kind: 'work', work, receivedAt: now() };
}

export interface PhoneSolve {
    counters: number[];
    /** Tries made in all, and how long the whole solve took on this phone. */
    tries: number;
    ms: number;
}

export interface PhoneSolveOptions {
    /** The platform's SHA-256; the phone's own unless a test passes another. */
    digest?: DoorWorkDigest;
    sliceMs?: number;
    onPart?: (done: number, of: number) => void;
    /**
     * Once the first part has been timed over at least {@link ESTIMATE_MIN_TRIES} tries: about how long the whole solve
     * takes on this phone, from its start, in milliseconds.
     */
    onEstimate?: (totalMs: number) => void;
    cancelled?: () => boolean;
    now?: () => number;
}

/**
 * Solve one challenge on the phone, in short batches (core's `solveDoorWork`, which reuses one 64 KB message for every
 * try), counting the tries so the first part can be timed. Null when cancelled.
 */
export async function solveOnPhone(challenge: string, o: PhoneSolveOptions = {}): Promise<PhoneSolve | null> {
    const parsed = parseDoorWorkChallenge(challenge);
    if (!parsed) throw new Error('door work: not a challenge');
    const digest = o.digest ?? phoneSha256;
    const now = o.now ?? Date.now;
    const started = now();
    let tries = 0;
    let estimated = false;
    const counted: DoorWorkDigest = (bytes) => { tries++; return digest(bytes); };
    const counters = await solveDoorWork(challenge, {
        digest: counted,
        sliceMs: o.sliceMs ?? DOOR_WORK_SLICE_MS,
        cancelled: o.cancelled,
        onPart: (done, of) => {
            if (!estimated && tries >= ESTIMATE_MIN_TRIES) {
                estimated = true;
                const perTry = (now() - started) / tries;
                o.onEstimate?.(Math.round(perTry * doorWorkExpectedTries(parsed.level)));
            }
            o.onPart?.(done, of);
        },
    });
    if (!counters) return null;
    return { counters, tries, ms: now() - started };
}

/** Where a door's work stands, for the screen. */
export interface DoorWorkState {
    phase: 'fetching' | 'solving' | 'ready' | 'none' | 'refused' | 'failed' | 'cancelled';
    /** The level of the challenge in hand, once there is one. */
    level: number | null;
    partsDone: number;
    parts: number;
    /** This phone's estimate for the whole solve in hand (ms), once its first part is timed. */
    estimateMs: number | null;
    /** When the solve in hand started (the phone's clock), for "about N seconds" left. */
    startedAt: number | null;
    /** Why, for `refused` (the door's answer) and `failed` (the solver could not run). */
    answer?: DoorAnswer;
}

/** What a join gets from the work: the solution, none needed, or why there is none. */
export type DoorWorkOutcome =
    | { kind: 'solved'; work: DoorWorkSolution }
    | { kind: 'none' }
    | { kind: 'refused'; answer: DoorAnswer }
    | { kind: 'cancelled' };

export interface DoorWorkRun {
    readonly publicKey: string;
    readonly door: DoorWorkDoor;
    state(): DoorWorkState;
    /**
     * The work for the join: waits for the solve in hand, or fetches and solves a new challenge when the one in hand is
     * about to run out (or there is none yet because the first ask got no answer). Never rejects.
     */
    solution(): Promise<DoorWorkOutcome>;
    /** The node refused the work it was sent (`work_*`): a new challenge, solved, quietly. Never rejects. */
    again(): Promise<DoorWorkOutcome>;
    /** Stop: nothing more is fetched or hashed. */
    cancel(): void;
}

export interface StartDoorWork {
    url: string;
    identity: BeanPoolIdentity;
    door: DoorWorkDoor;
    onChange?: (state: DoorWorkState) => void;
    /** For tests: the work route and the solver. */
    fetchWork?: typeof fetchDoorWork;
    solve?: typeof solveOnPhone;
    digest?: DoorWorkDigest;
    now?: () => number;
    /** For tests: schedule the quiet replacement of a challenge that is about to run out. */
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

/**
 * Start the door's work for `identity` at `door` now (the door's screen opens), and keep it current until a join takes
 * it or the screen stops it. One run per key and door: the challenge names both.
 */
export function startDoorWork(o: StartDoorWork): DoorWorkRun {
    const fetchWork = o.fetchWork ?? fetchDoorWork;
    const solve = o.solve ?? solveOnPhone;
    const now = o.now ?? Date.now;
    const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearTimer = o.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

    let cancelled = false;
    let refreshes = 0;
    let refreshTimer: unknown = null;
    let state: DoorWorkState = { phase: 'fetching', level: null, partsDone: 0, parts: DOOR_WORK_PARTS, estimateMs: null, startedAt: null };
    /** The round in hand: fetch then solve, settling with what a join gets. */
    let round: Promise<DoorWorkOutcome> = Promise.resolve({ kind: 'cancelled' });
    let roundExpiresAt: number | null = null;
    /** Moved on by every new round, so a round that was replaced never writes over its successor's state. */
    let generation = 0;

    const set = (gen: number, next: Partial<DoorWorkState>) => {
        if (gen !== generation || cancelled) return;
        state = { ...state, ...next };
        o.onChange?.(state);
    };

    const scheduleRefresh = (gen: number, expiresAt: number) => {
        if (refreshTimer !== null) clearTimer(refreshTimer);
        refreshTimer = null;
        if (refreshes >= DOOR_WORK_MAX_REFRESHES) return;
        const wait = Math.max(0, expiresAt - DOOR_WORK_EXPIRY_MARGIN_MS - now());
        refreshTimer = setTimer(() => {
            refreshTimer = null;
            if (cancelled || gen !== generation) return;
            refreshes++;
            begin();
        }, wait);
    };

    function begin(): Promise<DoorWorkOutcome> {
        const gen = ++generation;
        roundExpiresAt = null;
        set(gen, { phase: 'fetching', level: null, partsDone: 0, estimateMs: null, startedAt: null, answer: undefined });
        const r = (async (): Promise<DoorWorkOutcome> => {
            const fetched = await fetchWork(o.url, o.identity, o.door);
            if (cancelled) return { kind: 'cancelled' };
            if (fetched.kind === 'none') {
                set(gen, { phase: 'none' });
                return { kind: 'none' };
            }
            if (fetched.kind === 'refused') {
                set(gen, { phase: 'refused', answer: fetched.answer });
                return { kind: 'refused', answer: fetched.answer };
            }
            const { work, receivedAt } = fetched;
            // The phone's clock from when it heard, never the node's: a phone set wrong still gets its ten minutes.
            const expiresAt = receivedAt + work.expiresInSeconds * 1000;
            if (gen === generation) roundExpiresAt = expiresAt;
            const startedAt = now();
            set(gen, { phase: 'solving', level: work.level, partsDone: 0, estimateMs: null, startedAt });
            let solved: PhoneSolve | null;
            try {
                solved = await solve(work.challenge, {
                    ...(o.digest ? { digest: o.digest } : {}),
                    now,
                    cancelled: () => cancelled || gen !== generation,
                    onPart: (done) => set(gen, { partsDone: done }),
                    onEstimate: (ms) => set(gen, { estimateMs: ms }),
                });
            } catch (e) {
                console.log(`[DOOR WORK] the solver could not run: ${(e as Error)?.message ?? e}`);
                const answer: DoorAnswer = { kind: 'try_again', message: DOOR_WORK_MESSAGES.solverUnavailable };
                set(gen, { phase: 'failed', answer });
                return { kind: 'refused', answer };
            }
            if (!solved) return { kind: 'cancelled' };
            console.log(`[DOOR WORK] level ${work.level}: ${solved.tries} tries in ${solved.ms} ms`);
            set(gen, { phase: 'ready', partsDone: DOOR_WORK_PARTS });
            if (gen === generation) scheduleRefresh(gen, expiresAt);
            return { kind: 'solved', work: { challenge: work.challenge, counters: solved.counters } };
        })();
        round = r;
        return r;
    }

    begin();

    async function solution(): Promise<DoorWorkOutcome> {
        let askedAgain = false;
        for (;;) {
            if (cancelled) return { kind: 'cancelled' };
            const waitingOn = round;
            const outcome = await waitingOn;
            if (cancelled) return { kind: 'cancelled' };
            // Replaced while it was awaited (a challenge about to run out was renewed): the new one is the one.
            if (waitingOn !== round) continue;
            // No answer the first time: ask again now the member is waiting on it. A refusal the door made stands.
            const unreachable = outcome.kind === 'refused' && outcome.answer.kind === 'unreachable';
            const stale = outcome.kind === 'solved' && roundExpiresAt !== null && roundExpiresAt - now() < DOOR_WORK_EXPIRY_MARGIN_MS;
            if ((unreachable && !askedAgain) || stale) {
                askedAgain = askedAgain || unreachable;
                begin();
                continue;
            }
            return outcome;
        }
    }

    return {
        publicKey: o.identity.publicKey,
        door: o.door,
        state: () => state,
        solution,
        async again() {
            if (cancelled) return { kind: 'cancelled' };
            begin();
            return solution();
        },
        cancel() {
            cancelled = true;
            generation++;
            if (refreshTimer !== null) clearTimer(refreshTimer);
            refreshTimer = null;
            state = { ...state, phase: 'cancelled' };
        },
    };
}

/** "about 15 seconds", "about 2 minutes": an estimate, never more precise than it is. */
export function aboutHowLong(ms: number): string {
    const seconds = Math.max(1, ms / 1000);
    if (seconds < 55) {
        const s = seconds < 10 ? Math.ceil(seconds) : Math.round(seconds / 5) * 5;
        return s === 1 ? 'about a second' : `about ${s} seconds`;
    }
    const minutes = Math.max(1, Math.round(seconds / 60));
    return minutes === 1 ? 'about a minute' : `about ${minutes} minutes`;
}

/**
 * From level 3 (design §3.5): the door is busy, and how long the 12-words way takes on THIS phone, from its own timing
 * of the first part, with the sign-in door beside it. Null below the busy level, and before the first part is timed.
 * Never a refusal.
 */
export function busyLevelSentence(state: Pick<DoorWorkState, 'level' | 'estimateMs' | 'startedAt' | 'phase'>, now: number = Date.now()): string | null {
    if (state.level === null || state.level < BUSY_LEVEL || state.estimateMs === null) return null;
    if (state.phase !== 'solving' && state.phase !== 'ready') return null;
    const left = state.phase === 'ready' ? 0 : Math.max(0, state.estimateMs - (now - (state.startedAt ?? now)));
    if (left <= 0) return null;
    return `Lots of people are joining right now. Setting up a 12-words account will take ${aboutHowLong(left)} on this phone. Or sign in to join now.`;
}
