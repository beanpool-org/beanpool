/**
 * A phone on a virtual clock, for the full-screen "Update required"'s gate (utils/force-update.ts): the community
 * answers when the test says, and AppState changes and switches of community arrive when the test says. Used by
 * force-update-escape.test.ts. Not a test file itself.
 */
import { createForceUpdateGate, type ForceUpdateDecision } from '../force-update';

export const BLOCK: ForceUpdateDecision = { kind: 'block', version: '1.2.61' };
export const CLEAR: ForceUpdateDecision = { kind: 'clear' };

/** Lets every promise that can settle now settle. */
export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A phone on a virtual clock: the community answers `answerMs` after it is asked, App Lock's prompt opens and closes
 * when the test says, and AppState changes arrive when the test says. Events at the same time run in the order given.
 */
export function phone(opts: { answer?: ForceUpdateDecision; answerMs?: number } = {}) {
    let t = 0;
    let answer = opts.answer ?? BLOCK;
    let answerMs = opts.answerMs ?? 600;
    let seq = 0;
    const events: Array<{ at: number; seq: number; run: () => void }> = [];
    const schedule = (at: number, run: () => void) => { events.push({ at, seq: seq++, run }); };
    const shown: Array<{ at: number; block: { version: string } | null }> = [];
    let asked = 0;

    const gate = createForceUpdateGate({
        now: () => t,
        check: () => {
            asked++;
            const reply = answer;
            return new Promise<ForceUpdateDecision>((resolve) => schedule(t + answerMs, () => resolve(reply)));
        },
        show: (block) => shown.push({ at: t, block }),
    });

    return {
        gate,
        shown,
        get asked() { return asked; },
        set answer(a: ForceUpdateDecision) { answer = a; },
        set answerMs(ms: number) { answerMs = ms; },
        /** The block on screen now. */
        get current() { return shown.length ? shown[shown.length - 1].block : null; },
        start(at: number, state = 'active') { schedule(at, () => { void gate.start(state); }); },
        appState(at: number, state: string) { schedule(at, () => { void gate.appStateChanged(state); }); },
        switched(at: number) { schedule(at, () => { void gate.communitySwitched(); }); },
        /** The community's answer from `at` on. */
        answerFrom(at: number, a: ForceUpdateDecision) { schedule(at, () => { answer = a; }); },
        /** Runs every event up to `until`, in time order. */
        async run(until: number) {
            await settle();
            for (;;) {
                events.sort((a, b) => a.at - b.at || a.seq - b.seq);
                const next = events[0];
                if (!next || next.at > until) break;
                events.shift();
                t = next.at;
                next.run();
                await settle();
                await settle();
            }
            t = until;
        },
        /** When the block first went up, or null. */
        firstShownAt(): number | null {
            const first = shown.find((s) => s.block !== null);
            return first ? first.at : null;
        },
    };
}

export type Phone = ReturnType<typeof phone>;
