import React, { useCallback, useEffect, useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { getAlertsStatus, saveAlertsChannel, sendTestAlert, getTfaSessionToken, type AlertsStatus } from '../../lib/node-client';
import { nodeCredential } from '../../lib/profiles';

/**
 * This server's alerts (apps/server services/alerts.ts): what is wrong now, what was told, and where alerts go besides
 * the owners' phones — an ntfy topic or a JSON webhook the owner chooses, never BeanPool's. An owner's card: the node
 * answers anyone else 403, and the card then says so in one line. The address and token are typed in and never shown
 * again: the server sends back the host only.
 */
export interface AlertsPanelProps {
    activeNode: NodeProfile;
}

const TOO_OLD = "This server's BeanPool is older than alerts: update it to use them.";

function when(t: number | null | undefined): string {
    if (!t) return 'never';
    return new Date(t).toLocaleString();
}

const PRIORITY_LABEL: Record<number, { text: string; className: string }> = {
    5: { text: 'Urgent', className: 'bg-red-500/20 text-red-300 border border-red-500/30' },
    4: { text: 'High', className: 'bg-amber-500/20 text-amber-300 border border-amber-500/30' },
    3: { text: 'Warning', className: 'bg-amber-500/20 text-amber-300 border border-amber-500/30' },
    2: { text: 'Low', className: 'bg-nature-800 text-nature-300' },
    1: { text: 'Info', className: 'bg-nature-800 text-nature-300' },
};

export function AlertsPanel({ activeNode }: AlertsPanelProps) {
    const [status, setStatus] = useState<AlertsStatus | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);
    const [form, setForm] = useState<{ url: string; format: 'ntfy' | 'json'; token: string } | null>(null);
    const [busy, setBusy] = useState(false);

    const creds = useCallback(() => [nodeCredential(activeNode), getTfaSessionToken(activeNode.id)] as const, [activeNode.id, nodeCredential(activeNode)]);

    const load = useCallback(async () => {
        try {
            const s = await getAlertsStatus(activeNode.url, ...creds());
            if (!s || typeof s !== 'object' || !Array.isArray(s.active)) throw new Error(TOO_OLD);
            setStatus(s);
            setLoadError(null);
        } catch (e: unknown) {
            setStatus(null);
            setLoadError((e as { status?: number })?.status === 404 ? TOO_OLD : e instanceof Error ? e.message : String(e));
        }
    }, [activeNode.url, creds]);

    useEffect(() => { void load(); }, [load]);

    const run = async (work: () => Promise<{ status: AlertsStatus }>, done: string | ((r: any) => string)) => {
        setBusy(true);
        setMessage(null);
        try {
            const r = await work();
            setStatus(r.status);
            setMessage({ text: typeof done === 'string' ? done : done(r), isError: false });
            return true;
        } catch (e: unknown) {
            setMessage({ text: e instanceof Error ? e.message : String(e), isError: true });
            return false;
        } finally {
            setBusy(false);
        }
    };

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!form) return;
        const ok = await run(() => saveAlertsChannel(activeNode.url, { url: form.url.trim(), format: form.format, token: form.token.trim() || undefined }, ...creds()),
            'Saved. Send a test to check it arrives.');
        if (ok) setForm(null);
    };

    const test = () => run(() => sendTestAlert(activeNode.url, ...creds()),
        (r: { ok: boolean; error?: string }) => (r.ok ? 'Test sent: check your phone or channel.' : `The test did not go: ${r.error}.`));

    const remove = () => run(() => saveAlertsChannel(activeNode.url, { remove: true }, ...creds()), 'Channel removed. Owners still get a push and the banner.');

    return (
        <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4" data-testid="server-alerts">
            <div className="border-b border-nature-800 pb-3 min-w-0">
                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                    <span>🔔</span>
                    <span>Alerts</span>
                </h3>
                <p className="text-xs text-nature-400 m-0 mt-0.5">
                    When the disk fills, backups fail, the server restarts or its standby needs you, the owners get a push and a
                    banner here. Optionally, alerts also go to a channel you choose: an ntfy topic or any webhook. Yours, never
                    BeanPool's. Alerts carry counts and your community's name, never a member's name or words.
                </p>
            </div>

            {loadError && <p className="text-xs text-nature-300 m-0 break-words">{loadError}</p>}

            {status && (
                <>
                    <div className="space-y-2">
                        <h4 className="text-xs font-bold text-nature-300 m-0">Now</h4>
                        {status.active.length === 0 ? (
                            <p className="text-xs text-nature-400 m-0">Nothing needs you.</p>
                        ) : status.active.map((a) => (
                            <div key={a.key} className="flex flex-wrap items-start gap-2 min-w-0">
                                <span className={`px-2 py-0.5 rounded-lg text-[11px] font-bold shrink-0 ${PRIORITY_LABEL[a.priority]?.className ?? ''}`}>
                                    {PRIORITY_LABEL[a.priority]?.text ?? a.priority}
                                </span>
                                <span className="text-xs text-white min-w-0 flex-1 break-words">{a.detail} <span className="text-nature-500">Since {when(a.since)}.</span></span>
                            </div>
                        ))}
                    </div>

                    <div className="space-y-2">
                        <h4 className="text-xs font-bold text-nature-300 m-0">Channel</h4>
                        {status.channelProblem && <p className="text-xs text-red-300 m-0 break-words">{status.channelProblem}</p>}
                        {status.channel ? (
                            <div className="text-xs text-nature-300 space-y-1 min-w-0">
                                <p className="m-0 break-words">
                                    {status.channel.format === 'ntfy' ? 'ntfy topic' : 'JSON webhook'} at {status.channel.where}
                                    {status.channel.tokenSet ? ', with a token' : ''}{status.channel.source === 'env' ? ' (set in .env)' : ''}.
                                </p>
                                <p className="m-0">
                                    Last delivered: {when(status.lastOkAt)}.
                                    {status.error ? ` Last try failed: ${status.error}.` : ''}
                                    {status.waiting ? ` ${status.waiting} waiting${status.nextTryAt ? `, next try ${when(status.nextTryAt)}` : ''}.` : ''}
                                </p>
                            </div>
                        ) : (
                            <p className="text-xs text-nature-400 m-0">No channel: alerts reach the owners in the app only.</p>
                        )}
                        <div className="flex flex-wrap gap-2">
                            {status.channel && (
                                <button type="button" disabled={busy} onClick={() => void test()}
                                    className="px-4 py-2.5 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white disabled:opacity-50">
                                    Send a test
                                </button>
                            )}
                            {status.channel?.source !== 'env' && !form && (
                                <button type="button" disabled={busy} onClick={() => setForm({ url: '', format: 'ntfy', token: '' })}
                                    className="px-4 py-2.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white disabled:opacity-50">
                                    {status.channel ? 'Change channel' : 'Add a channel'}
                                </button>
                            )}
                            {status.channel?.source === 'settings' && !form && (
                                <button type="button" disabled={busy} onClick={() => void remove()}
                                    className="px-4 py-2.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white disabled:opacity-50">
                                    Remove
                                </button>
                            )}
                        </div>
                    </div>

                    {form && (
                        <form onSubmit={(e) => void submit(e)} className="space-y-3">
                            <label className="block min-w-0">
                                <span className="block text-xs font-bold text-nature-300 mb-1">Address</span>
                                <input type="url" value={form.url} placeholder="https://ntfy.sh/your-secret-topic" autoComplete="off" spellCheck={false}
                                    onChange={(e) => setForm((f) => (f ? { ...f, url: e.target.value } : f))}
                                    className="w-full min-w-0 bg-nature-950 border border-nature-700 rounded-xl px-3 py-2.5 text-xs text-white" />
                                <span className="block text-[11px] text-nature-500 mt-1">An ntfy topic's name is its password: pick a long one nobody can guess.</span>
                            </label>
                            <label className="block min-w-0">
                                <span className="block text-xs font-bold text-nature-300 mb-1">Kind</span>
                                <select value={form.format} onChange={(e) => setForm((f) => (f ? { ...f, format: e.target.value as 'ntfy' | 'json' } : f))}
                                    className="w-full min-w-0 bg-nature-950 border border-nature-700 rounded-xl px-3 py-2.5 text-xs text-white">
                                    <option value="ntfy">ntfy topic</option>
                                    <option value="json">JSON webhook</option>
                                </select>
                            </label>
                            <label className="block min-w-0">
                                <span className="block text-xs font-bold text-nature-300 mb-1">Token (optional)</span>
                                <input type="password" value={form.token} autoComplete="off"
                                    onChange={(e) => setForm((f) => (f ? { ...f, token: e.target.value } : f))}
                                    className="w-full min-w-0 bg-nature-950 border border-nature-700 rounded-xl px-3 py-2.5 text-xs text-white" />
                                <span className="block text-[11px] text-nature-500 mt-1">Sent as "Authorization: Bearer". Never shown again.</span>
                            </label>
                            <div className="flex flex-wrap gap-2">
                                <button type="submit" disabled={busy} className="px-4 py-2.5 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white disabled:opacity-50">Save</button>
                                <button type="button" disabled={busy} onClick={() => setForm(null)} className="px-4 py-2.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white disabled:opacity-50">Cancel</button>
                            </div>
                        </form>
                    )}

                    {message && <p className={`text-xs m-0 break-words ${message.isError ? 'text-red-300' : 'text-emerald-400'}`}>{message.text}</p>}

                    {status.history.length > 0 && (
                        <details className="text-xs text-nature-300">
                            <summary className="cursor-pointer font-bold">Last {status.history.length} alerts</summary>
                            <ul className="m-0 mt-2 pl-4 space-y-1">
                                {status.history.map((h, i) => (
                                    <li key={`${h.key}-${h.at}-${i}`} className="break-words">
                                        {when(h.at)}: {h.kind === 'cleared' ? 'resolved' : h.kind === 'still' ? 'still' : 'raised'} — {h.detail}
                                    </li>
                                ))}
                            </ul>
                        </details>
                    )}
                </>
            )}
        </div>
    );
}
