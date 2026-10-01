/**
 * The 12-words door's work, kept ready for one joining key (two-doors design §3.4, slice S5): asked for as soon as the
 * key exists, solved while the person types their name, and replaced quietly before it runs out, so that at ordinary
 * levels nobody ever waits for it. The join takes it (`take`), waiting for it when it is still being made.
 *
 * Never a gate: a network's ceiling, the 12-words door shut here, or a browser that can't do the work each end in a
 * sentence beside the sign-in, which is always the other way in (WebJoin draws both).
 */

import { requestDoorWork, wordsWorkRefusal, DoorUnreachableError } from './web-join';
import { solveInWorker, WORK_CANT_RUN, type DoorWorkProgress, type DoorWorkRun, type DoorWorkSolution, type DoorWorkSolver } from './door-work';
import type { BeanPoolIdentity } from './identity';

export type WordsWorkState =
    /** Nothing asked yet, or the last solution was taken. */
    | { status: 'idle' }
    /** Asking the node for a challenge. */
    | { status: 'asking' }
    /** Solving at `level`; `progress` once a part is done or the speed is measured. */
    | { status: 'solving'; level: number; progress: DoorWorkProgress | null }
    /** A solution is ready for the join. */
    | { status: 'ready'; level: number }
    /** The node's ceiling for this network (or its door limiter): the sentence says when, and that a sign-in works now. */
    | { status: 'busy'; message: string }
    /** The node takes no 12-words joins now: the sign-in is the way in. */
    | { status: 'closed'; message: string }
    /** No answer, or this browser couldn't do the work: tapping again tries again. */
    | { status: 'failed'; message: string };

export type WordsWorkTake =
    | { ok: true; work: DoorWorkSolution }
    | { ok: false; state: Extract<WordsWorkState, { status: 'busy' | 'closed' | 'failed' }> };

/** A solution with less than this left is not sent: the join has to reach the node before the challenge runs out. */
export const SEND_MARGIN_MS = 60_000;
/** A solution nobody has taken is replaced this long before its challenge runs out. */
export const RENEW_MARGIN_MS = 90_000;
/** Replaced at most this many times without a join (about an hour), then made again only when the join asks. */
const MAX_QUIET_RENEWALS = 5;

const UNREACHABLE_WORK = "Can't reach the community right now. Try again in a minute, or sign in.";
const NO_WORDS_DOOR = "This community isn't taking 12-words accounts right now. Sign in to join.";

interface Options {
    solver?: DoorWorkSolver;
    onChange?: (state: WordsWorkState) => void;
    now?: () => number;
    request?: typeof requestDoorWork;
}

interface Ready extends DoorWorkSolution {
    expiresAt: number;
    level: number;
}

export class WordsWork {
    private state: WordsWorkState = { status: 'idle' };
    private ready: Ready | null = null;
    private job: Promise<WordsWorkTake> | null = null;
    private run: DoorWorkRun | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private renewals = 0;
    private disposed = false;

    constructor(readonly identity: BeanPoolIdentity, private readonly o: Options = {}) {}

    get current(): WordsWorkState {
        return this.state;
    }

    private now(): number {
        return (this.o.now ?? Date.now)();
    }

    private set(state: WordsWorkState): void {
        this.state = state;
        if (!this.disposed) this.o.onChange?.(state);
    }

    private clearTimer(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    private fresh(r: Ready, margin: number): boolean {
        return r.expiresAt - this.now() > margin;
    }

    /** Make work if none is ready or being made. Safe to call often. */
    start(): void {
        if (this.disposed || this.job) return;
        if (this.ready && this.fresh(this.ready, RENEW_MARGIN_MS)) return;
        this.job = this.make().finally(() => { this.job = null; });
    }

    private stopped(): WordsWorkTake {
        return { ok: false, state: { status: 'failed', message: WORK_CANT_RUN } };
    }

    private end(state: Extract<WordsWorkState, { status: 'busy' | 'closed' | 'failed' }>): WordsWorkTake {
        this.set(state);
        return { ok: false, state };
    }

    private async make(): Promise<WordsWorkTake> {
        this.ready = null;
        this.clearTimer();
        this.set({ status: 'asking' });
        let answer;
        try {
            answer = await (this.o.request ?? requestDoorWork)(this.identity, 'words', () => this.now());
        } catch (e) {
            if (!(e instanceof DoorUnreachableError)) console.error('[WordsWork] could not ask for work:', e);
            return this.end({ status: 'failed', message: e instanceof DoorUnreachableError ? UNREACHABLE_WORK : WORK_CANT_RUN });
        }
        if (this.disposed) return this.stopped();
        if (answer.kind === 'refused') {
            const r = wordsWorkRefusal(answer.answer);
            return this.end({ status: r.kind, message: r.message });
        }
        // The node always asks work of the 12-words door; one that asks none here takes no 12-words joins.
        if (answer.kind === 'none') return this.end({ status: 'closed', message: NO_WORDS_DOOR });
        const w = answer.work;
        this.set({ status: 'solving', level: w.level, progress: null });
        let counters: number[] | null;
        try {
            const run = (this.o.solver ?? solveInWorker)(w.challenge, {
                onProgress: (progress) => { if (this.run === run && !this.disposed) this.set({ status: 'solving', level: w.level, progress }); },
            });
            this.run = run;
            counters = await run.done;
        } catch (e) {
            console.warn('[WordsWork] the work could not be done here:', (e as Error)?.message || e);
            return this.end({ status: 'failed', message: WORK_CANT_RUN });
        } finally {
            this.run = null;
        }
        if (this.disposed || !counters) return this.stopped();
        const ready: Ready = { challenge: w.challenge, counters, expiresAt: w.expiresAt, level: w.level };
        this.ready = ready;
        this.set({ status: 'ready', level: w.level });
        if (this.renewals < MAX_QUIET_RENEWALS) {
            this.timer = setTimeout(() => {
                this.timer = null;
                this.renewals++;
                this.start();
            }, Math.max(0, w.expiresAt - RENEW_MARGIN_MS - this.now()));
        }
        return { ok: true, work: { challenge: ready.challenge, counters: ready.counters } };
    }

    /**
     * The work for a join, used up by taking it (the node spends a challenge once): a fresh solution, or the one being
     * made, waited for. A solution too close to its end is made again first. The next join asks for new work.
     */
    async take(): Promise<WordsWorkTake> {
        for (let attempt = 0; attempt < 3; attempt++) {
            if (this.disposed) return this.stopped();
            const ready = this.ready;
            if (ready && this.fresh(ready, SEND_MARGIN_MS)) {
                this.ready = null;
                this.clearTimer();
                this.renewals = 0;
                this.set({ status: 'idle' });
                return { ok: true, work: { challenge: ready.challenge, counters: ready.counters } };
            }
            if (ready) this.ready = null; // too close to its end to send
            if (!this.job) this.start();
            const out = await this.job;
            if (!out) return this.stopped();
            if (!out.ok) return out;
        }
        return this.stopped();
    }

    /** Stop: a solve under way is cancelled, and nothing more is asked. */
    dispose(): void {
        this.disposed = true;
        this.clearTimer();
        this.run?.cancel();
    }
}
