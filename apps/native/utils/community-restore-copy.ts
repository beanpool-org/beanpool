/**
 * What the restore screen says when a sign-in restore at the member's community stops (welcome.tsx "Recover with …" in
 * a build without a key vault, and a vault build's fallback to the community).
 *
 * sso-recovery.ts `recoverAccountWithSso` refuses with a code and its data ({@link CommunityRestoreRefused}), never a
 * sentence: it turns a sign-in copy into the key and checks its 12 words, so nothing in it may reach the words layer
 * (packages/beanpool-core/src/__tests__/recovery-path-files.test.ts). The sentences are here, on the screen's side, in the
 * member's language, and they are the web's for the same answer (apps/pwa/src/lib/web-restore.ts `noAccountMessage`,
 * `findRefusalMessage`, `collectRefusalMessage`; recovery design §5): phone and web say the same.
 */
import { t } from '@beanpool/core';
import { CommunityRestoreRefused, type CommunityRestoreRefusal } from './sso-recovery';
import { SSO_PROVIDER_NAMES } from './sso-providers';

/**
 * The sentence for one refusal. `community`: the community the member chose, by the name the screen gives it
 * (restore-community-choices.ts `restoreCommunityName`).
 */
export function communityRestoreRefusalText(refusal: CommunityRestoreRefusal, community: string): string {
    switch (refusal.code) {
        case 'unreachable':
            return t("Can't reach the community right now. Try again in a minute.");
        case 'server_too_old':
            return t("{community}'s server is older than this app and can't find your account from a sign-in yet. Ask its admin to update, or use your 12 words.", { community });
        case 'no_account_here':
            return t('No account at {community} uses this {provider} account. Try another community, or your 12 words.', { community, provider: SSO_PROVIDER_NAMES[refusal.provider] });
        case 'refused':
            return refusedText(refusal);
        case 'not_that_account':
            return t("The account that came back isn't {name}, so nothing was saved on this phone. Try again, or use your 12 words.", { name: refusal.name });
    }
}

/** The community refused a step: the web's sentence for the same answer, and the community's own words where it gave some. */
function refusedText(refusal: Extract<CommunityRestoreRefusal, { code: 'refused' }>): string {
    const { status, said, provider } = refusal;
    // A 401 with no code is the signature check's stale time: this phone's clock (web-join.ts isWrongClock).
    if (status === 401 && !refusal.coded) {
        return t("The community couldn't accept this because this device's date and time look wrong. Check them in this device's settings (set them to automatic), then try again.");
    }
    if (status === 429) return said ?? t('Too many tries from this network. Please try again later.');
    if (refusal.step === 'find' && provider) {
        const name = SSO_PROVIDER_NAMES[provider];
        if (status === 401) return t("{provider} sign-in couldn't be checked or took too long. Try again.", { provider: name });
        if (status === 503) return said ?? t('{provider} sign-in could not be checked right now. Please try again in a minute.', { provider: name });
    }
    return said ?? t('The community could not bring the account back ({status}). Please try again.', { status: String(status) });
}

/**
 * What the screen shows for what a sign-in restore at the community threw: a refusal's sentence, or any other error's
 * own message. Undefined when there is neither, and the screen says so itself.
 */
export function restoreRefusalText(error: unknown, community: string): string | undefined {
    if (error instanceof CommunityRestoreRefused) return communityRestoreRefusalText(error.refusal, community);
    const message = (error as { message?: unknown } | null | undefined)?.message;
    return typeof message === 'string' && message ? message : undefined;
}
