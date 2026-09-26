/**
 * Settings: whether a sign-in also brings this account back (G11-c). A browser member of the global community has the
 * sign-in they joined with; a phone may have connected others. Read from the node (`enrolledSso`), never assumed.
 * Nothing is drawn while the node has not answered, or when it could not be asked: a line that guessed would either
 * frighten a member who is covered or reassure one who is not.
 */
import { signInNames } from '../lib/join-recovery';

/**
 * Under a connected sign-in: who can open the copy it keeps (recovery seal S3; Marty, card sso-copy-lock, D-2 = a,
 * 2026-09-26). The server's operators can: their process holds data/recovery-seal.key and receives the sign-in's id on
 * every sign-in it checks. A copy of its database alone can't. Unlike the phone's line, no "once updated": this page is
 * served by the server it describes, and a server that serves it has the seal. The web app can't disconnect a sign-in
 * yet; the guide says the phone app can.
 */
export const SIGN_IN_COPY_OPENERS =
    "The people who run your community's server can open the copy of your account kept for your sign-in, because their server checks your sign-in. A stolen copy of the server's database can't. If you would rather nobody but you could get in, use only your 12 words.";

interface Props {
    /** The node's list of sign-ins; undefined while asking, null when it could not be asked. */
    enrolled: string[] | null | undefined;
}

export function SignInRecoveryLine({ enrolled }: Props) {
    if (!enrolled) return null;
    const names = signInNames(enrolled);
    return (
        <div data-testid="signin-recovery" role="status"
            className="w-full p-4 rounded-2xl bg-white dark:bg-nature-900 text-nature-900 dark:text-white border border-nature-200 dark:border-nature-800 shadow-sm flex items-start gap-3">
            <span className="text-xl" aria-hidden="true">{names ? '✅' : '🔑'}</span>
            <div className="flex-1 min-w-0 break-words">
                <div className="text-[15px] font-bold">
                    {names ? `Sign-in recovery: connected (${names})` : 'Sign-in recovery: not connected'}
                </div>
                <div className="text-xs font-normal text-nature-500 dark:text-nature-400">
                    {names
                        ? `Signing in with ${names} also brings this account back, as your 12 words do.`
                        : 'Your 12 words are the way back to this account. Keep them safe.'}
                </div>
                {names && (
                    // nature-600, not the 500 above: 500 on white is 3.3:1, too faint for a sentence this long (measured
                    // by e2e/signin-recovery-check.mjs; 600 is 4.9:1, and dark's 400 on nature-900 is 4.6:1).
                    <div data-testid="signin-recovery-openers" className="mt-1.5 text-xs font-normal text-nature-600 dark:text-nature-400">
                        {SIGN_IN_COPY_OPENERS}
                    </div>
                )}
            </div>
        </div>
    );
}
