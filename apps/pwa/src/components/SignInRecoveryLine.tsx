/**
 * Settings: whether a sign-in also brings this account back (G11-c). A browser member of the global community has the
 * sign-in they joined with; a phone may have connected others. Read from the node (`enrolledSso`), never assumed.
 * Nothing is drawn while the node has not answered, or when it could not be asked: a line that guessed would either
 * frighten a member who is covered or reassure one who is not.
 */
import { t, word } from '@beanpool/core';
import { signInNames } from '../lib/join-recovery';
import { BoldWords } from './BoldWords';
import { signInNamesWords, twoSentences } from './key-lines';

/** The line's sentences that are said in more than one place: marked here, translated where they are shown. */
const LINE_WORDS = {
    openers: word("The people who run your community's server can open the copy of your account kept for your sign-in, because their server checks your sign-in. A stolen copy of the server's database can't."),
    wordsOnly: word('If you would rather nobody but you could get in, use only your 12 words.'),
    noWords: word("Your 12 words aren't saved in this browser."),
} as const;

/**
 * Under a connected sign-in: who can open the copy it keeps (recovery seal S3; Marty, card sso-copy-lock, D-2 = a,
 * 2026-09-26). The server's operators can: their process holds data/recovery-seal.key and receives the sign-in's id on
 * every sign-in it checks. A copy of its database alone can't. Unlike the phone's line, no "once updated": this page is
 * served by the server it describes, and a server that serves it has the seal. The web app can't disconnect a sign-in
 * yet; the guide says the phone app can. The 12 words part is for a browser that has them, as on the phone: one restored
 * from a copy without words (or whose words did not re-derive the key) holds none, and "use only your 12 words" would
 * talk a member out of their only way back.
 */
export const SIGN_IN_COPY_OPENERS = LINE_WORDS.openers;
export const SIGN_IN_COPY_WORDS_ONLY = LINE_WORDS.wordsOnly;

/**
 * A browser that holds no 12 words (web-restore.ts openRestoredAccount kept the key alone: the copy carried none, or
 * they did not re-derive the key) is never told they are here, or that they are its way back. What is true instead:
 * written down, they still bring the account back; without them, the ways back are the ones the node lists. Settings
 * says it wherever the words were promised (this line, View Recovery Phrase, signing out).
 */
export const NO_WORDS_HERE = LINE_WORDS.noWords;

/** NO_WORDS_HERE in the member's language (NO_WORDS_HERE itself is the English, its key). */
export function noWordsHere(): string {
    return t(LINE_WORDS.noWords);
}

/**
 * For a browser without its 12 words: what brings the account back, as far as the node's list of sign-ins says
 * (`enrolled` as below). Not connected: only the phone app's link is left (the web app's third way back). Not known
 * (the node could not be asked): no sign-in is named or ruled out.
 */
export function waysBackWithoutWords(enrolled: string[] | null | undefined): string {
    const names = enrolled ? signInNames(enrolled) : null;
    if (names) return t("If you have them written down, they bring your account back. If you don't, signing in with {names} does.", { names: signInNamesWords(names) });
    if (enrolled) return t("If you have them written down, they bring your account back. If you don't, only a phone that has this account can.");
    return t('If you have them written down, they bring your account back, and so does any sign-in connected to it.');
}

interface Props {
    /** The node's list of sign-ins; undefined while asking, null when it could not be asked. */
    enrolled: string[] | null | undefined;
    /** Whether this browser holds the 12 words (`hasMnemonic`). */
    hasWords: boolean;
    /**
     * How to put this same account on a phone (lib/global-entry.ts phoneLaterLines, DESIGN-global-entry-fable.md §D),
     * under the rest. None: nothing more is drawn.
     */
    phoneLater?: string[];
}

export function SignInRecoveryLine({ enrolled, hasWords, phoneLater = [] }: Props) {
    if (!enrolled) return null;
    const english = signInNames(enrolled);
    const names = english ? signInNamesWords(english) : null;
    return (
        <div data-testid="signin-recovery" role="status"
            className="w-full p-4 rounded-2xl bg-white dark:bg-nature-900 text-nature-900 dark:text-white border border-nature-200 dark:border-nature-800 shadow-sm flex items-start gap-3">
            <span className="text-xl" aria-hidden="true">{names ? '✅' : '🔑'}</span>
            <div className="flex-1 min-w-0 break-words">
                <div className="text-[15px] font-bold">
                    {names ? t('Sign-in recovery: connected ({names})', { names }) : t('Sign-in recovery: not connected')}
                </div>
                {/* nature-600: 500 on white is 3.3:1 (measured by e2e/signin-recovery-check.mjs, as the line below). */}
                <div data-testid="signin-recovery-way-back" className="text-xs font-normal text-nature-600 dark:text-nature-400">
                    {names
                        ? hasWords
                            ? t('Signing in with {names} also brings this account back, as your 12 words do.', { names })
                            : t("Signing in with {names} brings this account back. Your 12 words aren't saved in this browser. If you have them written down, they do too.", { names })
                        : hasWords
                            ? t('Your 12 words are the way back to this account. Keep them safe.')
                            : twoSentences(noWordsHere(), waysBackWithoutWords(enrolled))}
                </div>
                {names && (
                    // nature-600: 500 on white is 3.3:1, too faint for a sentence this long (measured by
                    // e2e/signin-recovery-check.mjs; 600 is 4.9:1, and dark's 400 on nature-900 is 4.6:1).
                    <div data-testid="signin-recovery-openers" className="mt-1.5 text-xs font-normal text-nature-600 dark:text-nature-400">
                        {hasWords ? twoSentences(t(LINE_WORDS.openers), t(LINE_WORDS.wordsOnly)) : t(LINE_WORDS.openers)}
                    </div>
                )}
                {phoneLater.length > 0 && (
                    <div data-testid="signin-recovery-phone-later" className="mt-1.5 text-xs font-normal text-nature-600 dark:text-nature-400">
                        {phoneLater.map((line) => <p key={line} className="m-0 mt-1 first:mt-0"><BoldWords text={line} /></p>)}
                    </div>
                )}
            </div>
        </div>
    );
}
