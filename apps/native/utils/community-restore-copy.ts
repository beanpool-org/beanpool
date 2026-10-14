/**
 * What the restore screen says when a sign-in restore at the member's community stops (welcome.tsx "Recover with …" in
 * a build without a key vault).
 *
 * sso-recovery.ts `recoverAccountWithSso` refuses with a code and the name the member typed
 * ({@link CommunityRestoreRefused}), never a sentence: it turns a sign-in copy into the key and checks its 12 words, so
 * nothing in it may reach the words layer (packages/beanpool-core/src/__tests__/recovery-path-files.test.ts). The
 * sentences are here, on the screen's side, in the member's language.
 */
import { t } from '@beanpool/core';
import { CommunityRestoreRefused, type CommunityRestoreRefusal } from './sso-recovery';

/** The sentence for one refusal. */
export function communityRestoreRefusalText(refusal: CommunityRestoreRefusal): string {
    switch (refusal.code) {
        case 'lookup_unreachable':
            return t("Can't reach the community right now. Try again in a minute.");
        case 'no_restorable_account':
            return t("No account called {name} here can come back with a sign-in. Check you've typed your whole name, or use your 12 words.", { name: refusal.name });
        case 'not_that_account':
            return t("The account that came back isn't {name}, so nothing was saved on this phone. Try again, or use your 12 words.", { name: refusal.name });
    }
}

/**
 * What the screen shows for what a sign-in restore at the community threw: a refusal's sentence, or any other error's
 * own message. Undefined when there is neither, and the screen says so itself.
 */
export function restoreRefusalText(error: unknown): string | undefined {
    if (error instanceof CommunityRestoreRefused) return communityRestoreRefusalText(error.refusal);
    const message = (error as { message?: unknown } | null | undefined)?.message;
    return typeof message === 'string' && message ? message : undefined;
}
