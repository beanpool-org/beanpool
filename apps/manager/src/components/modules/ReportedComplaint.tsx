import React, { useEffect, useState } from 'react';
import { fetchReportedComplaint, type ReportedComplaint as Complaint } from '../../lib/node-client';

/**
 * A complaint another community's server sent about a member here (server: engine/relay-complaint.ts, messages across
 * communities X5). It names that community, never who reported: the words are what their reporter says the member's message
 * said, and nothing here proves them. Opened when the report is shown, as a direct message's line is.
 */
export function ReportedComplaint({ nodeUrl, reportId, credential }: { nodeUrl: string; reportId: string; credential?: string }) {
    const [complaint, setComplaint] = useState<Complaint | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        setComplaint(null);
        setError(null);
        fetchReportedComplaint(nodeUrl, reportId, credential)
            .then((c) => { if (live) setComplaint(c); })
            .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : 'The node did not answer'); });
        return () => { live = false; };
    }, [nodeUrl, reportId, credential]);

    return (
        <div className="space-y-1" data-testid="report-from-another-community">
            {error ? (
                <p role="alert" className="text-sm font-semibold text-red-300 m-0">{`Could not open the complaint: ${error}`}</p>
            ) : !complaint ? (
                <p role="status" className="text-sm text-nature-400 m-0">Opening the complaint…</p>
            ) : (
                <>
                    <p className="text-xs font-bold uppercase tracking-wider text-nature-400 m-0">
                        {`A message ${complaint.authorCallsign || 'this member'} sent to ${complaint.from}`}
                        {complaint.signedAt ? ` · ${new Date(complaint.signedAt).toLocaleDateString()}` : ''}
                    </p>
                    {complaint.words && <blockquote className="m-0 pl-3 border-l-2 border-nature-700 text-sm text-white whitespace-pre-line">{complaint.words}</blockquote>}
                    <p className="text-xs text-nature-400 m-0">
                        Who reported it isn't shown. The words are what their reporter says it said; the message stays sealed.
                    </p>
                </>
            )}
        </div>
    );
}
