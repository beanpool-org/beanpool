import React, { useEffect, useState } from 'react';
import { fetchReportedDirectMessage, type ReportedDirectLine } from '../../lib/node-client';
import { ReportVerdict } from './ReportedGroupMessage';

/**
 * The one direct message line a report names (server: engine/dm-line-report.ts; R0). A direct message stays sealed: no key
 * came with the report, so what a moderator can check is who wrote the sealed line to the reporter, by its sender's
 * signature, and never what it says. The words are the reporter's own and read as that. In a moderator's Reports and the
 * owners' People & Safety, opened when the report is shown.
 */

const LINE_NOW: Record<ReportedDirectLine['line'], string | null> = {
    same: null,
    changed: 'Its sender changed this message after the reporter read it. This report keeps the one they were sent.',
    gone: 'This message is no longer in the chat. This report keeps the one the reporter was sent.',
};

function when(iso: string | null): string {
    if (!iso) return '';
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? '' : t.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function ReportedDirectMessage({ nodeUrl, reportId, adminPassword, tfaToken }: {
    nodeUrl: string;
    reportId: string;
    adminPassword?: string;
    tfaToken?: string;
}) {
    const [message, setMessage] = useState<ReportedDirectLine | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        setMessage(null);
        setError(null);
        fetchReportedDirectMessage(nodeUrl, reportId, adminPassword, tfaToken)
            .then((m) => { if (live) setMessage(m); })
            .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : 'The node did not answer'); });
        return () => { live = false; };
    }, [nodeUrl, reportId, adminPassword, tfaToken]);

    const author = message?.authorCallsign || (message?.authorPubkey ? `@${message.authorPubkey.slice(0, 8)}` : null);
    const lineNow = message ? LINE_NOW[message.line] : null;

    return (
        <div className="space-y-2" data-testid="reported-direct-message">
            <p className="text-xs font-bold uppercase tracking-wider text-nature-500 m-0">
                {`Direct message${author ? ` · from ${author}` : ''}`}
            </p>
            {error ? (
                <p role="alert" className="text-sm font-semibold text-red-300 m-0">{`Could not open the reported message: ${error}`}</p>
            ) : !message ? (
                <p role="status" className="text-sm text-nature-400 m-0">Opening the reported message…</p>
            ) : (
                <div className="space-y-2">
                    {message.signature === 'verified' ? (
                        <p className="m-0 flex flex-wrap items-center gap-2">
                            <ReportVerdict ok>Signature verified</ReportVerdict>
                            <span className="text-xs text-nature-400">
                                {`${author ?? 'Its sender'} signed this sealed message to the reporter${message.signer ? ` (${message.signer.slice(0, 8)}…)` : ''}`}
                                {message.signedAt ? ` · ${when(message.signedAt)}` : ''}
                            </span>
                        </p>
                    ) : message.signature === 'unverified' ? (
                        <p className="m-0 flex flex-wrap items-center gap-2 text-sm text-nature-300">
                            <ReportVerdict ok={false}>Could not be verified</ReportVerdict>
                            <span>The signature on this message does not match it, so nothing here shows who wrote it.</span>
                        </p>
                    ) : (
                        <p className="m-0 flex flex-wrap items-center gap-2 text-sm text-nature-300">
                            <ReportVerdict ok={false}>No signature</ReportVerdict>
                            <span>It came from an older app, which doesn't sign its messages. Only the server's records say who sent it.</span>
                        </p>
                    )}
                    {message.words.text ? (
                        <>
                            <p className="text-xs font-bold text-nature-400 m-0">What the reporter says it says</p>
                            <blockquote className="m-0 pl-3 border-l-2 border-nature-700 text-sm text-white whitespace-pre-line">{message.words.text}</blockquote>
                        </>
                    ) : (
                        <p className="text-sm text-nature-400 m-0">The reporter gave no words for it.</p>
                    )}
                    <p className="text-xs text-nature-400 m-0">
                        These are the reporter's own words. The signature can't prove them: the message stays sealed, and only its
                        two people can read it.
                    </p>
                    {message.photo && <p className="text-xs text-nature-400 m-0">It had a photo, which stays sealed.</p>}
                    {lineNow && <p className="text-xs text-nature-400 m-0">{lineNow}</p>}
                </div>
            )}
            <p className="text-xs text-nature-500 m-0">
                Only this one message was shared with the report. Nothing else in the chat can be read here.
            </p>
        </div>
    );
}
