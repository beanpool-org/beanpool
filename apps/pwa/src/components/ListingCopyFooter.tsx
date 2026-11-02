/**
 * What stands under a member's copy of an Offer or a Need when a member of the global community opens it (slice G1′;
 * @beanpool/core eventCopyOf): the line, the door and Report; for its author, that it is theirs. Nothing of a deal or a person.
 * Its own file, so the Market page holds no second Report: its inline form has its own state, and a copy has no use for it.
 */
import { useState } from 'react';
import { copyPriceLine, t, type EventCopy } from '@beanpool/core';
import { EventCopyDoor } from './EventCopyDoor';
import { ReportModal } from './ReportModal';

interface Props {
    post: { id: string; title: string; authorPublicKey: string };
    copy: EventCopy;
    /** The reader's key; absent for no one signed in, who gets the door and no report. */
    reader?: string;
}

export function ListingCopyFooter({ post, copy, reader }: Props) {
    const [reporting, setReporting] = useState(false);
    if (post.authorPublicKey === reader) {
        return <p data-testid="listing-copy-own" className="m-0 text-sm font-semibold text-nature-700 dark:text-nature-300 break-words">{t('This is your copy. Change it in your own community and it follows.')}</p>;
    }
    return (
        <>
            <EventCopyDoor copy={copy} line={copyPriceLine(copy)} />
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
