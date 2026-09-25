/**
 * What to do on GitHub, said at the top of the code panel: the Account Protection sheet (components/SsoEnrolSheet.tsx)
 * and the GitHub recovery screen (app/welcome.tsx), both through components/GithubCodeSteps.tsx.
 *
 * 1. Paste. GitHub draws eight separate boxes, and the clipboard chip above the keyboard fills only one; press and
 *    hold the first box and choose Paste instead. The long-standing trap, so it is the first line.
 * 2. Come back. On Android BeanPool cannot close the tab, and while the tab is in front the app's wait for GitHub
 *    does not run (utils/sso-signin.ts `sleep`), so nothing can bring BeanPool back on its own: the member taps ✕,
 *    and the app asks the node the moment it is in front. Marty's phone, 2026-09-25: GitHub said "Congratulations,
 *    you're all set!" and the tab stayed, with nothing saying what to do. On iOS the page closes itself
 *    (`returnToApp` → `dismissBrowser`), so it says that instead.
 */

export const GITHUB_CODE_STEPS = {
    paste: 'On GitHub, press and hold the first box, then choose Paste.',
    pasteWhy: 'Tapping the clipboard chip above the keyboard fills only one box. Typing the 8 characters works too.',
    comeBackAndroid: "When GitHub says you're all set, tap ✕ at the top left to come back.",
    comeBackIos: "When GitHub says you're all set, BeanPool comes back by itself.",
} as const;

/** The second step, for this platform. */
export function githubComeBackStep(os: string): string {
    return os === 'ios' ? GITHUB_CODE_STEPS.comeBackIos : GITHUB_CODE_STEPS.comeBackAndroid;
}
