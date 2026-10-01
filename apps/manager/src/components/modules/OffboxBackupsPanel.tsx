import React, { useCallback, useEffect, useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import {
    getOffboxStatus,
    saveOffboxSettings,
    runOffboxBackupNow,
    listOffboxBackups,
    downloadOffboxBackup,
    getTfaSessionToken,
    type OffboxStatus,
    type OffboxDestinationStatus,
    type OffboxDestinationInput,
    type OffboxListedBackup,
} from '../../lib/node-client';

/**
 * Off-box backups (apps/server services/offbox-backups.ts): where the main server sends its locked backups, how often
 * and for how long, and each destination's last upload. An owner's card: the node answers anyone else 403, and the
 * card then says so in one line. A secret is typed in and never shown again.
 */
export interface OffboxBackupsPanelProps {
    activeNode: NodeProfile;
}

const EMPTY_FORM: OffboxDestinationInput = {
    name: '', endpoint: '', bucket: '', region: 'auto', prefix: '', accessKeyId: '', secretAccessKey: '',
};

/** A server older than off-box backups answers 404, or something that is not a status: say so, never crash. */
const TOO_OLD = "This server's BeanPool is older than backups off the server: update it to use them.";
function checked(s: OffboxStatus | null | undefined): OffboxStatus {
    if (!s || typeof s !== 'object' || !Array.isArray(s.destinations) || typeof s.message !== 'string') throw new Error(TOO_OLD);
    return s;
}

function when(t: number | null): string {
    if (!t) return 'never';
    return new Date(t).toLocaleString();
}

/** Where a destination points, as the card shows it: bucket, store and folder. */
function placeOf(d: OffboxDestinationStatus): string {
    let host = d.endpoint ?? '';
    try { host = new URL(host).host; } catch { /* shown as given */ }
    return `bucket ${d.bucket ?? ''} at ${host}${d.prefix ? `, folder ${d.prefix}` : ''}`;
}

function size(bytes: number | null): string {
    if (bytes === null) return '';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const HEALTH_LABEL: Record<OffboxDestinationStatus['health'], { text: string; className: string }> = {
    ok: { text: 'Working', className: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' },
    waiting: { text: 'First one soon', className: 'bg-nature-800 text-nature-300' },
    failing: { text: 'Failing', className: 'bg-red-500/20 text-red-300 border border-red-500/30' },
    stale: { text: 'Late', className: 'bg-amber-500/20 text-amber-300 border border-amber-500/30' },
    broken: { text: "Can't be used", className: 'bg-red-500/20 text-red-300 border border-red-500/30' },
};

export function OffboxBackupsPanel({ activeNode }: OffboxBackupsPanelProps) {
    const [status, setStatus] = useState<OffboxStatus | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);
    const [form, setForm] = useState<OffboxDestinationInput | null>(null);
    const [saving, setSaving] = useState(false);
    const [listing, setListing] = useState<{ id: string; backups: OffboxListedBackup[] } | null>(null);

    const creds = useCallback(() => [activeNode.adminPassword, getTfaSessionToken(activeNode.id)] as const, [activeNode.id, activeNode.adminPassword]);

    const load = useCallback(async () => {
        try {
            setStatus(checked(await getOffboxStatus(activeNode.url, ...creds())));
            setLoadError(null);
        } catch (e: unknown) {
            setStatus(null);
            // The status route itself missing (404) is a server from before it.
            setLoadError((e as { status?: number })?.status === 404 ? TOO_OLD : e instanceof Error ? e.message : String(e));
        }
    }, [activeNode.url, creds]);

    useEffect(() => { void load(); }, [load]);

    // While a backup is on its way, look again every few seconds until it is done.
    useEffect(() => {
        if (!status?.running) return;
        const t = setTimeout(() => { void load(); }, 3000);
        return () => clearTimeout(t);
    }, [status, load]);

    const save = async (update: Parameters<typeof saveOffboxSettings>[1], done: string | ((saved: OffboxStatus) => string)) => {
        setSaving(true);
        setMessage(null);
        try {
            const res = await saveOffboxSettings(activeNode.url, update, ...creds());
            const saved = checked(res.status);
            setStatus(saved);
            setMessage({ text: typeof done === 'string' ? done : done(saved), isError: false });
            return true;
        } catch (e: unknown) {
            setMessage({ text: e instanceof Error ? e.message : String(e), isError: true });
            return false;
        } finally {
            setSaving(false);
        }
    };

    const submitForm = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!form) return;
        if (!form.id) {
            if (await save({ destination: form }, 'Destination added. The first backup goes there within a few minutes.')) setForm(null);
            return;
        }
        // The server looks after the backups only where a destination points now. A change of endpoint, bucket or folder
        // leaves the ones already sent where they were, and nobody removes them on time unless the owner does.
        const before = status?.destinations.find((d) => d.id === form.id) ?? null;
        const saidMoved = (saved: OffboxStatus) => {
            const after = saved.destinations.find((d) => d.id === form.id);
            if (!before || !after || (before.endpoint === after.endpoint && before.bucket === after.bucket && before.prefix === after.prefix)) {
                return 'Destination saved.';
            }
            return `Destination saved. The backups already sent to its old place (${placeOf(before)}) stay there, and this server `
                + `no longer removes them after ${saved.retentionDays} days: delete them in that store, or give that bucket a `
                + `lifecycle rule that deletes files older than ${saved.maxRetentionDays} days.`;
        };
        if (await save({ destination: form }, saidMoved)) setForm(null);
    };

    const remove = async (d: OffboxDestinationStatus) => {
        if (!confirm(`Stop sending backups to "${d.name}"? The backups already there stay there, and this server no longer removes them: `
            + 'delete them in that store, or give the bucket a lifecycle rule that deletes old files.')) return;
        await save({ removeId: d.id }, 'Destination removed. What it holds stays there.');
    };

    const sendNow = async () => {
        setMessage(null);
        try {
            const res = await runOffboxBackupNow(activeNode.url, ...creds());
            setStatus({ ...checked(res.status), running: true });
            setMessage({ text: 'Sending a backup to every destination now.', isError: false });
        } catch (e: unknown) {
            setMessage({ text: e instanceof Error ? e.message : String(e), isError: true });
        }
    };

    const showBackups = async (d: OffboxDestinationStatus) => {
        if (listing?.id === d.id) { setListing(null); return; }
        setMessage(null);
        try {
            const res = await listOffboxBackups(activeNode.url, d.id, ...creds());
            setListing({ id: d.id, backups: Array.isArray(res?.backups) ? res.backups : [] });
        } catch (e: unknown) {
            setMessage({ text: e instanceof Error ? e.message : String(e), isError: true });
        }
    };

    const download = async (d: OffboxDestinationStatus, b: OffboxListedBackup) => {
        try {
            await downloadOffboxBackup(activeNode.url, d.id, b, ...creds());
        } catch (e: unknown) {
            setMessage({ text: `Download failed: ${e instanceof Error ? e.message : String(e)}`, isError: true });
        }
    };

    const field = (key: keyof OffboxDestinationInput, label: string, opts: { placeholder?: string; type?: string; hint?: string } = {}) => (
        <label className="block min-w-0">
            <span className="block text-xs font-bold text-nature-300 mb-1">{label}</span>
            <input
                type={opts.type ?? 'text'}
                value={form?.[key] ?? ''}
                placeholder={opts.placeholder}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setForm((f) => (f ? { ...f, [key]: e.target.value } : f))}
                className="w-full min-w-0 bg-nature-950 border border-nature-700 rounded-xl px-3 py-2.5 text-xs text-white"
            />
            {opts.hint && <span className="block text-[11px] text-nature-500 mt-1">{opts.hint}</span>}
        </label>
    );

    const sending = status?.state === 'sending';
    const warn = status && (status.state === 'not-locked' || status.state === 'replaced');

    return (
        <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4" data-testid="offbox-backups">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-nature-800 pb-3">
                <div className="min-w-0">
                    <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                        <span>🛟</span>
                        <span>Backups off the server</span>
                    </h3>
                    <p className="text-xs text-nature-400 m-0 mt-0.5">
                        Locked backups sent on a schedule to storage you choose (any S3-compatible store), so a lost disk or server
                        does not take the community with it. Optional: nothing is sent anywhere until you add a destination.
                    </p>
                </div>
                {sending && (
                    <button
                        type="button"
                        onClick={sendNow}
                        disabled={status?.running}
                        className="px-4 py-2.5 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all disabled:opacity-50 shrink-0"
                    >
                        {status?.running ? 'Sending…' : 'Send one now'}
                    </button>
                )}
            </div>

            {loadError && <p className="text-xs text-nature-400 m-0">{loadError}</p>}

            {status && (
                <p className={`text-xs m-0 p-3 rounded-xl border ${warn ? 'bg-amber-500/10 border-amber-500/30 text-amber-200' : 'bg-nature-950 border-nature-800 text-nature-300'}`} data-testid="offbox-message">
                    {status.message}
                </p>
            )}

            {message && (
                <p className={`text-xs m-0 p-3 rounded-xl bg-nature-950 border border-nature-800 ${message.isError ? 'text-red-300' : 'text-emerald-300'}`} role={message.isError ? 'alert' : 'status'}>
                    {message.text}
                </p>
            )}

            {status && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <label className="block min-w-0">
                        <span className="block text-xs font-bold text-nature-300 mb-1">How often</span>
                        <select
                            value={status.intervalHours}
                            disabled={saving}
                            onChange={(e) => save({ intervalHours: Number(e.target.value) }, 'Schedule saved.')}
                            className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3 py-2.5 text-xs text-white"
                        >
                            {[...new Set([6, 12, 24, 48, 168, status.intervalHours])].sort((a, b) => a - b).map((h) => (
                                <option key={h} value={h}>{h === 24 ? 'Every 24 hours (nightly)' : h === 168 ? 'Every week' : `Every ${h} hours`}</option>
                            ))}
                        </select>
                    </label>
                    <label className="block min-w-0">
                        <span className="block text-xs font-bold text-nature-300 mb-1">Keep each backup</span>
                        <select
                            value={status.retentionDays}
                            disabled={saving}
                            onChange={(e) => save({ retentionDays: Number(e.target.value) }, 'Retention saved. Older backups go at the next check.')}
                            className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3 py-2.5 text-xs text-white"
                        >
                            {[...new Set([7, 14, 30, status.retentionDays])].sort((a, b) => a - b).map((d) => (
                                <option key={d} value={d}>{d === status.maxRetentionDays ? `${d} days (the most)` : `${d} days`}</option>
                            ))}
                        </select>
                        <span className="block text-[11px] text-nature-500 mt-1">
                            Never more than {status.maxRetentionDays} days: a member who deletes their account is in every backup made before.
                        </span>
                    </label>
                </div>
            )}

            {status && status.destinations.length > 0 && (
                <ul className="space-y-3 m-0 p-0 list-none">
                    {status.destinations.map((d) => (
                        <li key={d.id} className="p-3 rounded-xl bg-nature-950 border border-nature-800 space-y-1.5" data-testid={`offbox-destination-${d.id}`}>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="text-sm font-bold text-white break-words min-w-0">{d.name}</span>
                                <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${HEALTH_LABEL[d.health].className}`}>{HEALTH_LABEL[d.health].text}</span>
                            </div>
                            {d.health === 'broken' ? (
                                <p className="text-xs text-red-300 m-0 break-words">{d.problems.join('; ')}</p>
                            ) : (
                                <>
                                    <p className="text-xs text-nature-400 m-0 break-all">
                                        {d.bucket} at {d.endpoint ? new URL(d.endpoint).host : ''}{d.prefix ? `, folder ${d.prefix}` : ''} · key {d.accessKeyId}
                                        {d.source === 'env' ? ' · set in .env' : ''}
                                    </p>
                                    <p className="text-xs text-nature-300 m-0">
                                        Last arrived: {when(d.lastSuccessAt)}{d.lastSuccessBytes !== null ? ` (${size(d.lastSuccessBytes)})` : ''}
                                        {sending && d.nextAttemptAt ? ` · next: ${when(d.nextAttemptAt)}` : ''}
                                    </p>
                                    {d.lastError && <p className="text-xs text-red-300 m-0 break-words">{d.lastError}</p>}
                                    {d.lastPruneError && <p className="text-xs text-amber-300 m-0 break-words">Old backups could not be removed: {d.lastPruneError}</p>}
                                </>
                            )}
                            <div className="flex flex-wrap gap-2 pt-1">
                                {d.health !== 'broken' && (
                                    <button type="button" onClick={() => showBackups(d)} className="px-3 py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs text-white">
                                        {listing?.id === d.id ? 'Hide backups' : 'Show backups'}
                                    </button>
                                )}
                                {d.source === 'settings' && d.health !== 'broken' && (
                                    <button
                                        type="button"
                                        onClick={() => setForm({ id: d.id, name: d.name, endpoint: d.endpoint ?? '', bucket: d.bucket ?? '', region: d.region ?? '', prefix: d.prefix ?? '', accessKeyId: '', secretAccessKey: '' })}
                                        className="px-3 py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs text-white"
                                    >
                                        Change
                                    </button>
                                )}
                                {d.source === 'settings' && (
                                    <button type="button" onClick={() => remove(d)} className="px-3 py-1.5 rounded-lg bg-nature-800 hover:bg-red-900 text-xs text-red-200">
                                        Remove
                                    </button>
                                )}
                            </div>
                            {listing?.id === d.id && (
                                listing.backups.length === 0 ? (
                                    <p className="text-xs text-nature-400 m-0">No backups there yet.</p>
                                ) : (
                                    <ul className="space-y-1 m-0 p-0 list-none" data-testid="offbox-backup-list">
                                        {listing.backups.map((b) => (
                                            <li key={b.key} className="flex flex-wrap items-center justify-between gap-2 text-xs text-nature-300">
                                                <span className="min-w-0 break-all">
                                                    {new Date(b.madeAt).toLocaleString()} · {size(b.bytes)}{b.ours ? '' : ` · another community (${b.community})`}
                                                </span>
                                                <button type="button" onClick={() => download(d, b)} className="px-2.5 py-1 rounded-lg bg-nature-800 hover:bg-nature-700 text-white">
                                                    Download
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                )
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {status && !form && (
                <button
                    type="button"
                    onClick={() => setForm({ ...EMPTY_FORM })}
                    className="px-4 py-2.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white"
                >
                    Add a destination
                </button>
            )}

            {form && (
                <form onSubmit={submitForm} className="space-y-3 p-3 rounded-xl bg-nature-950 border border-nature-800" data-testid="offbox-form">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {field('name', 'Name', { placeholder: 'e.g. Cloudflare R2' })}
                        {field('endpoint', 'Endpoint', { placeholder: 'https://…', hint: 'The store’s S3 address, https only, no bucket in it.' })}
                        {field('bucket', 'Bucket')}
                        {field('region', 'Region', { hint: '"auto" for Cloudflare R2; your region elsewhere.' })}
                        {field('prefix', 'Folder (optional)', { placeholder: 'e.g. beanpool' })}
                        {field('accessKeyId', 'Access key id', { placeholder: form.id ? 'type it again to change it' : '' })}
                        {field('secretAccessKey', 'Secret access key', { type: 'password', placeholder: form.id ? 'leave empty to keep the one set' : '', hint: 'Never shown again.' })}
                    </div>
                    <p className="text-[11px] text-nature-500 m-0">
                        The key needs to read, write, list and delete in this bucket. Use a bucket for backups alone.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <button type="submit" disabled={saving} className="px-4 py-2.5 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white disabled:opacity-50">
                            {saving ? 'Saving…' : form.id ? 'Save' : 'Add'}
                        </button>
                        <button type="button" onClick={() => setForm(null)} className="px-4 py-2.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs text-white">
                            Cancel
                        </button>
                    </div>
                </form>
            )}
        </div>
    );
}
