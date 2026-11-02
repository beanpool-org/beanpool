/**
 * What stands under a member's copy of an Offer or a Need when a member of the global community opens it (slice G1′;
 * @beanpool/core eventCopyOf): the line, the door and Report; for its author, that it is theirs. Nothing of a deal or a person,
 * unless its member takes questions (slice GD, @beanpool/core copyAsk): then their name and one way to write, which is a request.
 * Its author can stop from here too: a browser with no pair for it has no tick to untick.
 * Its own file, so the Market page holds no second Report: its inline form has its own state, and a copy has no use for it.
 */
import { useState } from 'react';
import { askButton, askLine, copyAsk, copyPriceLine, t, type EventCopy } from '@beanpool/core';
import { createConversationApi, stopTakingQuestions } from '../lib/api';
import { EventCopyDoor } from './EventCopyDoor';
import { ReportModal } from './ReportModal';

interface Props {
    post: { id: string; title: string; authorPublicKey: string; authorCallsign?: string };
    copy: EventCopy;
    /** The reader's key; absent for no one signed in, who gets the door and no report. */
    reader?: string;
    /** Opens a chat this member started. */
    onOpenChat?: (conversationId: string) => void;
}

export function ListingCopyFooter({ post, copy, reader, onOpenChat }: Props) {
    const [reporting, setReporting] = useState(false);
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState<string | null>(null);
    const [closedHere, setClosedHere] = useState(false);
    const failure = failed && <p role="alert" className="m-0 mt-2 text-sm text-red-700 dark:text-red-300 break-words">{failed}</p>;
    const run = async (step: () => Promise<void>) => {
        setBusy(true);
        setFailed(null);
        try {
            await step();
        } catch (e: any) {
            setFailed(e?.message || t('Failed to start conversation'));
        } finally {
            setBusy(false);
        }
    };
    if (post.authorPublicKey === reader) {
        return (
            <>
                <p data-testid="listing-copy-own" className="m-0 text-sm font-semibold text-nature-700 dark:text-nature-300 break-words">{t('This is your copy. Change it in your own community and it follows.')}</p>
                {copy.takesQuestions && !closedHere && (
                    <button type="button" data-testid="listing-copy-stop-questions" disabled={busy} onClick={() => void run(async () => { await stopTakingQuestions(post.id); setClosedHere(true); })}
                        className="min-h-[44px] mt-1 p-0 bg-transparent border-0 text-sm font-bold text-nature-800 dark:text-oat-50 underline break-words cursor-pointer">
                        {t('Stop taking questions')}
                    </button>
                )}
                {failure}
            </>
        );
    }
    const ask = reader ? copyAsk(copy, post.authorCallsign, post.authorPublicKey) : null;
    return (
        <>
            <EventCopyDoor copy={copy} line={copyPriceLine(copy)} />
            {ask && reader && (
                <div data-testid="listing-copy-ask" className="mt-3 min-w-0">
                    <p className="m-0 text-sm font-semibold text-nature-800 dark:text-oat-50 break-words">{askLine(ask.name)}</p>
                    <button type="button" data-testid="listing-copy-ask-button" disabled={busy}
                        onClick={() => void run(async () => onOpenChat?.((await createConversationApi('dm', [reader, ask.key], reader)).conversation.id))}
                        className="w-full min-h-[48px] mt-2 rounded-xl bg-nature-600 text-white hover:bg-nature-700 font-semibold text-sm cursor-pointer break-words">
                        {askButton()}
                    </button>
                    {failure}
                </div>
            )}
            {reader && (
                <>
                    <button
                        data-testid="listing-copy-report"
                        onClick={() => setReporting(true)}
                        className="w-full min-h-[48px] mt-3 rounded-xl border border-nature-200 dark:border-nature-700 bg-transparent text-nature-500 dark:text-nature-300 font-semibold text-sm cursor-pointer break-words"
                    >
                        {t('🚩 Report')}
                    </button>
                    <ReportModal
                        isOpen={reporting}
                        onClose={() => setReporting(false)}
                        reporterPubkey={reader}
                        targetPubkey={post.authorPublicKey}
                        targetName={post.title}
                        targetPostId={post.id}
                    />
                </>
            )}
        </>
    );
}
