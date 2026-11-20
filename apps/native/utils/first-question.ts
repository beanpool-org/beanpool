/**
 * Which first screen the welcome home draws (app/welcome.tsx):
 *
 * - `waiting`: an account on this phone that is a member nowhere yet (utils/waiting-to-join.ts): its waiting mode, as before.
 * - `door`: anything else: the front door (components/welcome/FrontDoor.tsx; DESIGN-onboarding-home-landing-fable.md
 *   §3.1 A, Marty 21 Nov 2026). Its third button, "I've used BeanPool before", keeps the job of the 12 Nov question "Used
 *   BeanPool before?", so someone who lost a phone meets their way back on the very first screen, before any join.
 *
 * Nothing is stored, so there is nothing to carry over or convert.
 */
export type HomeView = 'waiting' | 'door';

export function homeView({ hasAccount, waiting }: { hasAccount: boolean; waiting: boolean }): HomeView {
    return hasAccount && waiting ? 'waiting' : 'door';
}

/** "Start a new account instead" belongs under the ways back only where there is no account on this phone to keep. */
export function offersStartNew(hasAccount: boolean): boolean {
    return !hasAccount;
}
