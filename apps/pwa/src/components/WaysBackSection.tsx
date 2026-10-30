/**
 * Settings → "Where your account can be brought back from" (vault rethink VR1, DESIGN-vault-rethink-fable.md §5.1), the
 * web app's rows: what this browser can ask, and the honest line about what it can't.
 *
 * - **Your 12 words**: in this browser, or not.
 * - **This community's server**: the copies it keeps for sign-ins, from its own list (`enrolled`, the same answer the
 *   sign-in line reads), each with **Remove** (the signed delete the phone sends). Not asked yet, or no answer: said, and
 *   nothing is listed as kept or as gone. And the copy it keeps for its admins to bring the member back from ("Your
 *   community's admins", vault rethink VR3; `adminsCopy`, Settings reads it), since when, with **Remove**.
 * - "Copies in BeanPool's key vault are managed in the phone app.": the web app has no key vault client, so it never
 *   asks the vault, and says so instead of listing nothing there.
 *
 * Removing the server's last copy asks about the 12 words first, as the phone does (utils/ways-back.ts `beforeRemoving`):
 * this browser can't see the vault, so a copy there is never counted on. With the words in the browser: "Show my 12
 * words first?"; without: what is then left, plainly. It never refuses. Removed is said only on the server's own answer.
 */
import { useState } from 'react';
import { formatDate, t, word } from '@beanpool/core';
import { removeSignInCopy } from '../lib/api';
import { webRemoveCommunityCopy } from '../lib/community-copy';
import { isJoinProvider, type JoinProvider } from '../lib/identity';
import { providerLabel } from '../lib/web-join';

/** The section's sentences said in more than one place, or pinned by its test: marked here, t() where shown. */
export const WAYS_BACK_WEB = {
    title: word('Where your account can be brought back from'),
    intro: word('Every place a copy of your account is kept, as far as this browser can ask.'),
    words: word('Your 12 words'),
    wordsHere: word('In this browser.'),
    wordsNotHere: word("Not saved in this browser."),
    server: word("This community's server"),
    keepsNone: word('Keeps no copy of your account.'),
    notAsked: word("Didn't answer, so what it keeps can't be listed here."),
    vaultInApp: word("Copies in BeanPool's key vault are managed in the phone app."),
    remove: word('Remove'),
    // The copy this server keeps for its admins to bring the member back from (vault rethink VR3).
    admins: word("Your community's admins"),
    adminsLine: word('A locked copy an admin can bring your account back from, when they see you in person.'),
    // One this server keeps but can't open now (its key gone, or another): listed and removable, never a way back.
    adminsCantOpen: word("This server can't open this copy now, so it can't bring your account back. Your community's admins, below, says what can be done. Your 12 words still work."),
} as const;

interface Props {
    /** This server's list of sign-ins it keeps a copy for; undefined while asking, null when it couldn't be asked. */
    enrolled: string[] | null | undefined;
    /** The copy this server keeps for its admins to bring the member back from (VR3), since when; null or absent: none known. */
    adminsCopy?: { since: string | null } | null;
    /** One it keeps for them but can't open now, since when: listed and removable, never counted as a way back. */
    adminsCopyUnopenable?: { since: string | null } | null;
    /** Whether this browser holds the 12 words. */
    hasWords: boolean;
    /** Show the 12 words (Settings' View Recovery Phrase). */
    onShowWords: () => void;
    /** After a removal: read the server's list again. */
    onChanged: () => void;
}

const CARD = 'w-full p-4 rounded-2xl bg-white dark:bg-nature-900 text-nature-900 dark:text-white border border-nature-200 dark:border-nature-800 shadow-sm';
// nature-600 on white is 4.9:1 and 400 on nature-900 is 4.6:1 (e2e/signin-recovery-check.mjs measured the same pair).
const SMALL = 'text-xs font-normal text-nature-600 dark:text-nature-400';
const BUTTON = 'min-h-[44px] px-4 py-2 rounded-xl text-xs font-bold border cursor-pointer transition-colors';
const DANGER = `${BUTTON} bg-white dark:bg-nature-900 text-red-700 dark:text-red-300 border-red-300 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-950/40`;
const PLAIN = `${BUTTON} bg-white dark:bg-nature-900 text-nature-900 dark:text-white border-nature-300 dark:border-nature-700 hover:bg-nature-50 dark:hover:bg-nature-800`;

/** Which copy the confirm is for: a sign-in's, or the admins' (VR3). */
type Asking = JoinProvider | 'admins';

export function WaysBackSection({ enrolled, adminsCopy = null, adminsCopyUnopenable = null, hasWords, onShowWords, onChanged }: Props) {
    const [open, setOpen] = useState(false);
    const [asking, setAsking] = useState<Asking | null>(null);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<string | null>(null);
    const copies = enrolled ? [...new Set(enrolled.filter(isJoinProvider))] : [];
    const admins = enrolled ? adminsCopy : null;
    const adminsSince = admins?.since ? new Date(admins.since) : null;
    const cantOpen = enrolled && !admins ? adminsCopyUnopenable : null;
    const cantOpenSince = cantOpen?.since ? new Date(cantOpen.since) : null;

    const remove = async (which: Asking) => {
        setBusy(true);
        const gone = which === 'admins'
            ? await webRemoveCommunityCopy().then(() => true, () => false)
            : await removeSignInCopy(which);
        setBusy(false);
        setAsking(null);
        setResult(gone
            ? t("Removed from this community's server.")
            : t("Not removed: this community's server didn't answer. Try again."));
        onChanged();
    };

    const confirmBox = (which: Asking) => {
        // The admins' copy this server can't open is no way back: removing it takes none away, and the ask says so.
        const noWayBack = which === 'admins' && !admins;
        const title = noWayBack ? t('Remove this copy?')
            : which === 'admins' ? t('Remove this way back?') : t('Remove your {provider} copy?', { provider: providerLabel(which) });
        // This browser can't see the vault: the server's only copy is the last way back it knows of.
        const last = !noWayBack && copies.length + (admins ? 1 : 0) === 1;
        return (
            <div data-testid="ways-back-confirm" role="alertdialog" aria-label={title}
                className="mt-2 p-3 rounded-xl bg-nature-50 dark:bg-nature-800 border border-nature-200 dark:border-nature-700">
                <p className="m-0 text-sm font-bold">{title}</p>
                {/* nature-300 in dark: SMALL's 400 is 3.8:1 on this box's nature-800 (e2e/signin-recovery-check.mjs). */}
                <p className="m-0 mt-1 text-xs font-normal text-nature-600 dark:text-nature-300">
                    {noWayBack
                        ? t("This community's server deletes the copy it can't open. Your 12 words still work.")
                        : which === 'admins'
                            ? t("This community's server deletes its copy of your account. Your admins can no longer bring you back; your 12 words still work.")
                            : t("This community's server deletes it. Copies already in that server's backups stay there.")}
                </p>
                {last && (
                    <p data-testid="ways-back-words-first" className="m-0 mt-1 text-xs font-bold text-nature-900 dark:text-white">
                        {hasWords
                            ? t('After this, nothing this browser can see brings your account back but your 12 words. Show them first, and write them down.')
                            : t('This browser has no 12 words. Unless you have them written down, or a phone with this account, losing this browser could lose your account: an admin can only move your Beans and name to a new key.')}
                    </p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                    {last && hasWords && (
                        <button type="button" className={PLAIN} onClick={() => { setAsking(null); onShowWords(); }}>{t('Show my 12 words')}</button>
                    )}
                    <button type="button" className={DANGER} disabled={busy} onClick={() => void remove(which)}>
                        {last ? t('Remove anyway') : t(WAYS_BACK_WEB.remove)}
                    </button>
                    <button type="button" className={PLAIN} onClick={() => setAsking(null)}>{last && !hasWords ? t('Keep it') : t('Cancel')}</button>
                </div>
            </div>
        );
    };

    return (
        <div className="space-y-2">
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
                className="w-full p-4 rounded-2xl bg-white dark:bg-nature-900 text-nature-900 dark:text-white font-bold border border-nature-200 dark:border-nature-800 shadow-sm hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors text-left flex items-center gap-3 cursor-pointer"
            >
                <span className="text-xl" aria-hidden="true">🗂️</span>
                <span className="flex-1 min-w-0 break-words text-[15px] font-bold">{t(WAYS_BACK_WEB.title)}</span>
                <span className="text-nature-500 dark:text-nature-300" aria-hidden="true">{open ? '˅' : '→'}</span>
            </button>
            {open && (
                <div data-testid="ways-back" className={`${CARD} space-y-3 break-words`}>
                    <p className={`m-0 ${SMALL}`}>{t(WAYS_BACK_WEB.intro)}</p>
                    <div>
                        <p className="m-0 text-sm font-bold">{t(WAYS_BACK_WEB.words)}</p>
                        <p className={`m-0 ${SMALL}`}>{hasWords ? t(WAYS_BACK_WEB.wordsHere) : t(WAYS_BACK_WEB.wordsNotHere)}</p>
                    </div>
                    <div data-testid="ways-back-server">
                        <p className="m-0 text-sm font-bold">{t(WAYS_BACK_WEB.server)}</p>
                        {enrolled === undefined ? (
                            <p className={`m-0 ${SMALL}`}>{t('Checking…')}</p>
                        ) : enrolled === null ? (
                            <p className={`m-0 ${SMALL}`}>{t(WAYS_BACK_WEB.notAsked)}</p>
                        ) : copies.length === 0 && !admins && !cantOpen ? (
                            <p className={`m-0 ${SMALL}`}>{t(WAYS_BACK_WEB.keepsNone)}</p>
                        ) : copies.map(p => (
                            <div key={p} className="mt-2 p-3 rounded-xl border border-nature-200 dark:border-nature-700">
                                <p className="m-0 text-sm font-semibold">{providerLabel(p)}</p>
                                {asking === p ? confirmBox(p) : (
                                    <button type="button" className={`mt-1 ${DANGER}`} disabled={busy} onClick={() => { setResult(null); setAsking(p); }}
                                        aria-label={t("Remove the {provider} copy at this community's server", { provider: providerLabel(p) })}>
                                        {t(WAYS_BACK_WEB.remove)}
                                    </button>
                                )}
                            </div>
                        ))}
                        {admins && (
                            <div data-testid="ways-back-admins-copy" className="mt-2 p-3 rounded-xl border border-nature-200 dark:border-nature-700">
                                <p className="m-0 text-sm font-semibold">{t(WAYS_BACK_WEB.admins)}</p>
                                <p className={`m-0 ${SMALL}`}>{t(WAYS_BACK_WEB.adminsLine)}</p>
                                {adminsSince && Number.isFinite(adminsSince.getTime()) && (
                                    <p className={`m-0 ${SMALL}`}>{t('Kept since {date}', { date: formatDate(adminsSince, 'day-month-year') })}</p>
                                )}
                                {asking === 'admins' ? confirmBox('admins') : (
                                    <button type="button" className={`mt-1 ${DANGER}`} disabled={busy} onClick={() => { setResult(null); setAsking('admins'); }}
                                        aria-label={t("Remove the copy at this community's server that its admins can bring you back from")}>
                                        {t(WAYS_BACK_WEB.remove)}
                                    </button>
                                )}
                            </div>
                        )}
                        {cantOpen && (
                            <div data-testid="ways-back-admins-cant-open" className="mt-2 p-3 rounded-xl border border-nature-200 dark:border-nature-700">
                                <p className="m-0 text-sm font-semibold">{t(WAYS_BACK_WEB.admins)}</p>
                                {cantOpenSince && Number.isFinite(cantOpenSince.getTime()) && (
                                    <p className={`m-0 ${SMALL}`}>{t('Kept since {date}', { date: formatDate(cantOpenSince, 'day-month-year') })}</p>
                                )}
                                <p className={`m-0 ${SMALL}`}>{t(WAYS_BACK_WEB.adminsCantOpen)}</p>
                                {asking === 'admins' ? confirmBox('admins') : (
                                    <button type="button" className={`mt-1 ${DANGER}`} disabled={busy} onClick={() => { setResult(null); setAsking('admins'); }}
                                        aria-label={t("Remove the copy at this community's server that it can't open")}>
                                        {t(WAYS_BACK_WEB.remove)}
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                    {result && <p data-testid="ways-back-result" role="status" className="m-0 text-sm">{result}</p>}
                    <p data-testid="ways-back-vault" className={`m-0 ${SMALL}`}>{t(WAYS_BACK_WEB.vaultInApp)}</p>
                </div>
            )}
        </div>
    );
}
