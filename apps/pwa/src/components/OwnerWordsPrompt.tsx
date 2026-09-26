/**
 * The gentle prompt: "Your 12 words aren't checked … [Check now] [Later]" (sealed-keys.md §7). Owners only, and only
 * on the design's cadence: on first becoming an owner, then 12 months after the last check. "Later" puts it away
 * for that round (only the round's name is kept, in this browser). Settings always has the card. Nothing waits on it.
 */
import { useEffect, useState } from 'react';
import {
    OWNER_WORDS_COPY as COPY, cachedOwnerWordsStatus, readLaterRound, rememberLater, shouldPromptOwner,
    type OwnerWordsStatus,
} from '../lib/owner-words';
import { runLockOpenCheck } from '../lib/takeover-unlock';

export function OwnerWordsPrompt({ publicKey, onCheckNow, identity }: {
    publicKey: string | null | undefined;
    onCheckNow: () => void;
    /** For the silent open check (slice 6): an owner's app confirms, once in a while, that it still opens the lock. */
    identity?: { publicKey: string; privateKey: string } | null;
}) {
    const [status, setStatus] = useState<OwnerWordsStatus | null>(null);
    const [show, setShow] = useState(false);

    useEffect(() => {
        if (!publicKey) return;
        let cancelled = false;
        cachedOwnerWordsStatus().then((s) => {
            if (s?.owner && identity?.privateKey) void runLockOpenCheck(identity);
            if (cancelled) return;
            setStatus(s);
            setShow(shouldPromptOwner(s, readLaterRound(publicKey)));
        });
        return () => { cancelled = true; };
    }, [publicKey]);

    if (!show || !status || !publicKey) return null;
    const renew = !!status.wordsCheckedAt;

    return (
        <div role="region" aria-label={COPY.title} className="mb-3 p-4 rounded-2xl border border-amber-300 bg-amber-50 dark:bg-amber-950 dark:border-amber-800">
            <div className="font-bold text-[15px] text-amber-900 dark:text-amber-200 break-words">
                {renew ? COPY.promptTitleRenew : COPY.promptTitleNever}
            </div>
            <p className="mt-1 text-sm leading-relaxed text-nature-800 dark:text-nature-100">
                {renew ? COPY.promptBodyRenew : COPY.promptBodyNever}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
                <button
                    type="button"
                    onClick={() => { setShow(false); onCheckNow(); }}
                    className="flex-grow basis-[120px] min-h-[48px] px-4 py-3 rounded-xl bg-emerald-700 text-white font-bold text-[15px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2"
                >
                    {COPY.checkNow}
                </button>
                <button
                    type="button"
                    onClick={() => { setShow(false); rememberLater(publicKey, status); }}
                    className="flex-grow basis-[120px] min-h-[48px] px-4 py-3 rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900 text-nature-800 dark:text-nature-100 font-semibold text-[15px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2"
                >
                    {COPY.later}
                </button>
            </div>
        </div>
    );
}
