/**
 * Settings: whether a sign-in also brings this account back (G11-c). A browser member of the global community has the
 * sign-in they joined with; a phone may have connected others. Read from the node (`enrolledSso`), never assumed.
 * Nothing is drawn while the node has not answered, or when it could not be asked: a line that guessed would either
 * frighten a member who is covered or reassure one who is not.
 */
import { signInNames } from '../lib/join-recovery';

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
            </div>
        </div>
    );
}
