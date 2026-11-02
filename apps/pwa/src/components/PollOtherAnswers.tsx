/**
 * A poll's typed answers, for its maker and the owners (apps/server engine/poll-other.ts, which decides: this only asks). On an
 * anonymous poll still open the node sends none, and the panel says when they come. Each line is the words and nothing else:
 * no name, no time, in no order of arrival. The maker can report a line to the owners; an owner can remove it.
 */

import { useState } from 'react';
import { pollOtherLines } from '@beanpool/core';
import { getPollOtherAnswers, removePollOtherAnswer, reportPollOtherAnswer, type PollOtherRead } from '../lib/api';

export function PollOtherAnswers({ postId }: { postId: string }) {
    const [read, setRead] = useState<PollOtherRead | null>(null);
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = async () => {
        setError(null);
        try {
            setRead(await getPollOtherAnswers(postId));
        } catch (err: any) {
            setError(err.message || pollOtherLines.wordsFailed());
        }
    };
    const toggle = () => {
        if (!open) void load();
        setOpen(v => !v);
    };
    const act = async (run: () => Promise<unknown>) => {
        setError(null);
        try {
            await run();
            await load();
        } catch (err: any) {
            setError(err.message || pollOtherLines.wordsFailed());
        }
    };

    return (
        <div className="mt-2" data-testid="poll-other-answers">
            <button
                type="button"
                onClick={toggle}
                aria-expanded={open}
                className="text-xs font-bold text-purple-600 dark:text-purple-400 hover:underline cursor-pointer py-2 px-2.5 rounded-lg hover:bg-purple-50 dark:hover:bg-purple-950/40 min-h-[44px] flex items-center text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
            >
                {pollOtherLines.readWords()}
            </button>
            {open && (
                <div className="mt-1 pt-2 border-t border-purple-100 dark:border-purple-900/40 space-y-1.5 text-xs">
                    <p className="text-[11px] text-nature-500 dark:text-nature-400 break-words">{pollOtherLines.wordsWho()}</p>
                    {error && <p className="text-red-600 dark:text-red-400 break-words" role="alert">{error}</p>}
                    {read?.state === 'held' && <p className="font-semibold text-nature-600 dark:text-nature-300 break-words" data-testid="poll-other-held">{pollOtherLines.wordsHeld()}</p>}
                    {read?.state === 'open' && read.answers.length === 0 && <p className="font-semibold text-nature-600 dark:text-nature-300 break-words">{pollOtherLines.wordsNone()}</p>}
                    {read?.answers.map(answer => (
                        <div key={answer.id} data-testid="poll-other-line" className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 py-1 px-2 rounded bg-nature-50 dark:bg-nature-900/40">
                            <span className="min-w-0 flex-1 basis-3/5 text-nature-900 dark:text-white break-words" style={{ overflowWrap: 'anywhere' }}>{answer.words}</span>
                            {answer.reported && <span className="text-[11px] font-semibold text-nature-500 dark:text-nature-400">{pollOtherLines.reported()}</span>}
                            {read.canRemove ? (
                                <button
                                    type="button"
                                    onClick={() => { if (window.confirm(pollOtherLines.removeConfirm())) void act(() => removePollOtherAnswer(postId, answer.id)); }}
                                    className="text-[11px] font-bold text-red-600 dark:text-red-400 min-h-[44px] px-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 rounded"
                                >
                                    {pollOtherLines.remove()}
                                </button>
                            ) : !answer.reported && (
                                <button
                                    type="button"
                                    onClick={() => void act(() => reportPollOtherAnswer(postId, answer.id))}
                                    className="text-[11px] font-bold text-nature-600 dark:text-nature-300 min-h-[44px] px-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 rounded"
                                >
                                    {pollOtherLines.report()}
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
