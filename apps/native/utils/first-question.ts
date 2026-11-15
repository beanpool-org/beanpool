/**
 * Which first screen the welcome home draws (app/welcome.tsx; Marty, 12 Nov idea 2, yes on 15 Nov):
 *
 * - `waiting`: an account on this phone that is a member nowhere yet (utils/waiting-to-join.ts): its waiting mode, as before.
 * - `question`: no account on this phone and no answer yet: "Used BeanPool before?" (components/welcome/UsedBefore.tsx),
 *   so someone who lost a phone brings their account back instead of making a second one.
 * - `doors`: "I'm New Here" was chosen (or "Start a new account instead" from the ways back), or an account is on this
 *   phone already (one identity per device: the question would offer nothing it doesn't have): today's join.
 *
 * The answer lives in the screen's memory only: a new start of the app asks again. Nothing is stored, so there is
 * nothing to carry over or convert.
 */
export type FirstAnswer = 'new' | null;
export type HomeView = 'waiting' | 'question' | 'doors';

export function homeView({ hasAccount, waiting, answer }: { hasAccount: boolean; waiting: boolean; answer: FirstAnswer }): HomeView {
    if (hasAccount) return waiting ? 'waiting' : 'doors';
    return answer === 'new' ? 'doors' : 'question';
}

/** "Start a new account instead" belongs under the ways back only where there is no account on this phone to keep. */
export function offersStartNew(hasAccount: boolean): boolean {
    return !hasAccount;
}
