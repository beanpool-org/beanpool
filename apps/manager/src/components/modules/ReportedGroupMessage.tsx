import React, { useEffect, useState } from 'react';
import { fetchReportedMessage, type ReportedMessage } from '../../lib/node-client';

/**
 * The one group chat message a report names, as the key its reporter handed over opens it (server:
 * engine/group-chat-report.ts; group chat photos S6). A locked group chat is end-to-end encrypted, so without this the
 * moderators would have only the reporter's word: the key opens that one message's words and its photo, each checked
 * against the key that signed it, and nothing else of the chat ever comes here. In a moderator's Reports and the owners'
 * People & Safety, opened when the report is shown.
 */

const GONE_WORDS: Record<'author' | 'convenor' | 'none', string> = {
    author: 'Its author deleted this message after it was reported, so there is nothing left to open.',
    convenor: "A convenor removed this message from the group's chat, so there is nothing left to open.",
    none: 'This message is no longer on this server, so there is nothing left to open.',
};

function when(iso: string | null): string {
    if (!iso) return '';
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? '' : t.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function ReportVerdict({ ok, children }: { ok: boolean; children: React.ReactNode }) {
    return (
        <span className={`px-2 py-0.5 rounded text-xs font-bold border ${ok
            ? 'bg-bp-chip-ok-tint text-bp-chip-ok-ink border-emerald-500/30'
            : 'bg-bp-chip-danger-tint text-bp-chip-danger-ink border-rose-500/30'}`}>
            {children}
        </span>
    );
}

export function ReportedGroupMessage({ nodeUrl, reportId, groupName, adminPassword, tfaToken }: {
    nodeUrl: string;
    reportId: string;
    /** The chat's name as the Reports list has it, shown while the message opens. */
    groupName?: string | null;
    adminPassword?: string;
    tfaToken?: string;
}) {
    const [message, setMessage] = useState<ReportedMessage | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        setMessage(null);
        setError(null);
        fetchReportedMessage(nodeUrl, reportId, adminPassword, tfaToken)
            .then((m) => { if (live) setMessage(m); })
            .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : 'The node did not answer'); });
        return () => { live = false; };
    }, [nodeUrl, reportId, adminPassword, tfaToken]);

    const chat = message?.groupName ?? groupName ?? null;
    const author = message?.authorCallsign || (message?.authorPubkey ? `@${message.authorPubkey.slice(0, 8)}` : null);
    const { words, photo } = message ?? {};

    return (
        <div className="space-y-2" data-testid="reported-group-message">
            <p className="text-xs font-bold uppercase tracking-wider text-nature-500 m-0">
                {`Group chat message${chat ? ` · ${chat}` : ''}${author ? ` · from ${author}` : ''}`}
            </p>
            {error ? (
                <p role="alert" className="text-sm font-semibold text-red-300 m-0">{`Could not open the reported message: ${error}`}</p>
            ) : !message || !words ? (
                <p role="status" className="text-sm text-nature-400 m-0">Opening the reported message…</p>
            ) : words.state === 'gone' ? (
                <p className="text-sm text-nature-300 m-0">{GONE_WORDS[words.by ?? 'none']}</p>
            ) : words.state === 'unverified' ? (
                <div className="space-y-1">
                    <p className="m-0"><ReportVerdict ok={false}>Could not be verified</ReportVerdict></p>
                    <p className="text-sm text-nature-300 m-0">
                        The key that came with this report does not open this message as signed by the member who sent it, so
                        nothing here shows what they wrote. Weigh the report on the reporter's own words.
                    </p>
                </div>
            ) : (
                <div className="space-y-2">
                    <p className="m-0 flex flex-wrap items-center gap-2">
                        <ReportVerdict ok>Verified</ReportVerdict>
                        <span className="text-xs text-nature-400">
                            {`Signed by ${author ?? 'its author'}'s key${message.signer ? ` (${message.signer.slice(0, 8)}…)` : ''}`}
                            {message.sentAt ? ` · ${when(message.sentAt)}` : ''}
                            {message.editedAt ? ` · edited ${when(message.editedAt)}` : ''}
                        </span>
                    </p>
                    {photo?.state === 'verified' && (
                        <img src={photo.dataUri} alt="The reported photo" className="block max-w-full sm:max-w-xs h-auto rounded-xl border border-nature-800" />
                    )}
                    {photo?.state === 'unverified' && (
                        <p className="m-0 flex flex-wrap items-center gap-2 text-sm text-nature-300">
                            <ReportVerdict ok={false}>Photo could not be verified</ReportVerdict>
                            <span>It is not the photo its author sent with these words.</span>
                        </p>
                    )}
                    {photo?.state === 'unavailable' && (
                        <p className="text-sm text-nature-300 m-0">
                            Image unavailable. Photos in chats are not copied to a standby server, so a server that took over
                            from another has none of them. The message's words are still verified.
                        </p>
                    )}
                    {words.text ? (
                        <blockquote className="m-0 pl-3 border-l-2 border-nature-700 text-sm text-white whitespace-pre-line">{words.text}</blockquote>
                    ) : photo ? null : (
                        <p className="text-sm text-nature-400 m-0">No words.</p>
                    )}
                </div>
            )}
            <p className="text-xs text-nature-500 m-0">
                Only this one message was shared with the report. Nothing else in the chat can be read here.
            </p>
        </div>
    );
}
