/**
 * One tap, one ask (max re-check of #3340): while a screen's tap is still waiting on the phone's pop-up for
 * notifications, another tap there does nothing. Android shows its pop-ups one after another, so a fast double tap put
 * the last one ("Don't allow" for good) straight after the first, before the member had read a word. The join screen's
 * `answering` (app/welcome.tsx), for the screens with a tap of their own: First steps' "Hear when someone answers you" on
 * Home, and the tool screen's Allow. NotifyLine and the bell's line keep their own busy state.
 *
 * Each screen keeps one (`useRef(oneAskAtATime()).current`): the next tap asks again once the ask before has answered,
 * failed or thrown.
 */
export function oneAskAtATime(): <T>(ask: () => Promise<T>) => Promise<T | undefined> {
    let out = false;
    return async <T>(ask: () => Promise<T>): Promise<T | undefined> => {
        if (out) return undefined;
        out = true;
        try {
            return await ask();
        } finally {
            out = false;
        }
    };
}
