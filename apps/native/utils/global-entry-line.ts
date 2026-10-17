import { t } from '@beanpool/core';
import type { GlobalEntryState } from './global-entry';

/**
 * The second line of the global community's row, for each state of the one rule (utils/global-entry.ts): the BeanPool
 * sheet's row and the not-recognised screen's draw the same words (DESIGN-global-entry-fable.md §B.3, §E).
 *
 * `host` is a member's line: the community's address, as any community's row shows it. `wordsDoor`: the open door has
 * the 12-words way beside a sign-in. `saved`: the row is the phone's saved row, whose tap switches to the community, so
 * no answer reads only "can't reach it", never a try again the tap doesn't do. Null for `noAccount`: no row is drawn
 * for it (the first screen's door is a phone with no account's, components/WelcomeDoors.tsx).
 */
export function globalEntryLine(state: GlobalEntryState, opts: { host: string; wordsDoor: boolean; saved?: boolean }): string | null {
    switch (state) {
        case 'member': return opts.host;
        case 'join': return opts.wordsDoor ? t('Join with this account: 12 words or a sign-in') : t('Join with this account: a sign-in');
        case 'checking': return t('Checking…');
        case 'unreachable': return opts.saved ? t("Can't reach it right now") : t("Can't reach it right now. Tap to try again.");
        case 'closed': return t('Not taking new members right now.');
        case 'preview': return t('This community is in a private preview. Ask its owner for an invite.');
        case 'closedAccount': return t('Your account there was closed.');
        default: return null;
    }
}
