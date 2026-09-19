import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { resolveNodeApiUrl, buildAdminHeaders, getTfaSessionToken } from '../../lib/node-client';
import { ModalBackdrop } from '../common/ModalBackdrop';

/**
 * "Take over as the main server" — on a standby, with the printed recovery code (sealed-keys.md §5.3–§5.5, slice 5).
 *
 * Two confirms: a plain explanation of what happens and what will be missing, then the code, then what the keys hold
 * (same PeerId, owners, links, web address, whether the main server still answers) and "Take over now". The server
 * then runs a journaled promotion and restarts. This screen follows it with the progress token the confirm returned
 * (the standby's own admin password stops working part-way), and says "restarting" while the server does not answer
 * rather than claiming anything. On a server that has taken over, it shows the result and the used-code notice.
 */

export interface TakeoverStepView {
    step: string;
    label: string;
    done: boolean;
    at: string | null;
    detail: string | null;
}

export interface TakeoverProgressData {
    role: 'primary' | 'backup';
    state: 'none' | 'running' | 'restarting' | 'complete' | 'failed';
    startedAt: string | null;
    completedAt: string | null;
    authorisedBy: string | null;
    peerId: string | null;
    sealedAt: string | null;
    steps: TakeoverStepView[];
    error: { step: string; label: string; message: string } | null;
    result: {
        roles?: { written: number; owners: string[]; skipped: string[] };
        connectors?: number;
        publicAddress?: string | null;
        tunnel?: { source: string; message: string } | null;
        audit?: { ok: boolean; drift: number; strandedEscrows: number } | null;
        announcement?: string | null;
        reseal?: string | null;
    } | null;
    missing: string[];
    afterwards: string[];
    codeUsed: { codeId: number; at: string; message: string } | null;
    /** Split-brain guard (slice 8): another server took over this one's identity; it is read-only. Absent on older servers. */
    replaced?: { epoch: number; ownEpoch: number; since: string | null; detectedAt: string; url: string; message: string } | null;
}

export interface TakeoverPreview {
    sessionId: string;
    expiresAt: number;
    envelope: { envelopeId: string; sealedAt: string; codeId: number; newerCopiesSkipped: number };
    communityId: string;
    peerId: string;
    owners: string[];
    admins: number;
    connectors: number;
    publicAddress: string | null;
    tunnel: { source: string; message: string };
    mainServer: { url: string | null; answers: boolean | null; lastCopyAt: number | null; warning: string | null };
    missing: string[];
    afterwards: string[];
}

export interface TakeoverPanelProps {
    activeNode: NodeProfile;
    /** From backup-status: 'backup' on a standby. */
    isStandby: boolean;
    /** Poll interval while a take-over is under way (tests shorten it). */
    pollMs?: number;
}

const PROGRESS_KEY_PREFIX = 'bp-takeover-progress:';

/** The server's list (services/takeover.ts WHAT_WILL_BE_MISSING), for when it has not answered yet. */
const MISSING_FALLBACK = [
    'Decisions and their votes',
    'enterprise pledges and keeper changes',
    'invites',
    "members' notification settings",
    'settings the main server keeps in its database other than its web address (for example what it lists in the directory)',
    'anything that changed on the main server after this standby last copied it',
];

function readStoredToken(nodeId: string): string | null {
    try { return sessionStorage.getItem(PROGRESS_KEY_PREFIX + nodeId); } catch { return null; }
}
function storeToken(nodeId: string, token: string | null): void {
    try {
        if (token) sessionStorage.setItem(PROGRESS_KEY_PREFIX + nodeId, token);
        else sessionStorage.removeItem(PROGRESS_KEY_PREFIX + nodeId);
    } catch { /* private mode: the screen still follows it until reload */ }
}

function when(iso: string | number | null | undefined): string {
    if (iso === null || iso === undefined || iso === '') return 'never';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

const BTN = 'min-h-[48px] px-4 py-2 rounded-xl text-sm font-bold transition-all disabled:opacity-50';
const WRAP: React.CSSProperties = { overflowWrap: 'anywhere' };

type Stage = 'closed' | 'explain' | 'code' | 'preview';

export function TakeoverPanel({ activeNode, isStandby, pollMs = 2000 }: TakeoverPanelProps) {
    const [progress, setProgress] = useState<TakeoverProgressData | null>(null);
    const [progressToken, setProgressToken] = useState<string | null>(() => readStoredToken(activeNode.id));
    const [unreachable, setUnreachable] = useState(false);
    const [stage, setStage] = useState<Stage>('closed');
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [preview, setPreview] = useState<TakeoverPreview | null>(null);
    const [mainGone, setMainGone] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const adminHeaders = useCallback(
        () => buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
        [activeNode.adminPassword, activeNode.id],
    );

    const loadProgress = useCallback(async (): Promise<TakeoverProgressData | null> => {
        const headers: Record<string, string> = progressToken
            ? { 'Content-Type': 'application/json', 'X-Takeover-Progress': progressToken }
            : adminHeaders();
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/takeover/progress'), {
                method: 'POST', headers, body: JSON.stringify({ password: progressToken ? undefined : activeNode.adminPassword }),
            });
            if (!res.ok) {
                // With a progress token, a refusal means the server that answers is not the one that started it.
                setUnreachable(!!progressToken && res.status >= 500);
                return null;
            }
            const data = await res.json() as TakeoverProgressData;
            setUnreachable(false);
            setProgress(data);
            return data;
        } catch {
            setUnreachable(true);
            return null;
        }
    }, [activeNode.url, activeNode.adminPassword, progressToken, adminHeaders]);

    // While a take-over this screen started is under way, follow it (through the restart).
    useEffect(() => {
        let cancelled = false;
        const tick = async () => {
            const data = await loadProgress();
            if (cancelled) return;
            const underWay = !!progressToken && (!data || (data.state !== 'complete' && data.state !== 'failed'));
            if (underWay) timer.current = setTimeout(tick, pollMs);
        };
        void tick();
        return () => {
            cancelled = true;
            if (timer.current) clearTimeout(timer.current);
        };
    }, [loadProgress, progressToken, pollMs]);

    const close = () => {
        if (busy) return;
        if (stage === 'preview') {
            void fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/takeover/cancel'), {
                method: 'POST', headers: adminHeaders(), body: JSON.stringify({ password: activeNode.adminPassword }),
            }).catch(() => {});
        }
        setStage('closed');
        setCode('');
        setError(null);
        setPreview(null);
        setMainGone(false);
    };

    const submitCode = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/takeover/open'), {
                method: 'POST', headers: adminHeaders(), body: JSON.stringify({ password: activeNode.adminPassword, code }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.preview) {
                setPreview(data.preview as TakeoverPreview);
                setStage('preview');
                setCode('');
            } else {
                setError(typeof data.error === 'string' ? data.error : `The standby answered HTTP ${res.status}.`);
            }
        } catch (err: unknown) {
            setError(`The standby did not answer: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setBusy(false);
        }
    };

    const confirm = async () => {
        if (!preview) return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, '/api/local/admin/takeover/confirm'), {
                method: 'POST', headers: adminHeaders(),
                body: JSON.stringify({ password: activeNode.adminPassword, sessionId: preview.sessionId, confirm: true }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && typeof data.progressToken === 'string') {
                storeToken(activeNode.id, data.progressToken);
                setProgressToken(data.progressToken);
                if (data.progress) setProgress(data.progress as TakeoverProgressData);
                setStage('closed');
                setPreview(null);
            } else {
                setError(typeof data.error === 'string' ? data.error : `The standby answered HTTP ${res.status}.`);
                if (data.sessionGone) { setPreview(null); setStage('code'); }
            }
        } catch (err: unknown) {
            setError(`The standby did not answer: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setBusy(false);
        }
    };

    const state = progress?.state ?? 'none';
    const followingOne = !!progressToken || (state !== 'none');
    // Nothing to show on a main server that never took over and has no used code.
    if (!isStandby && !followingOne && !progress?.codeUsed && !progress?.replaced) return null;

    const missing = preview?.missing ?? (progress?.missing?.length ? progress.missing : MISSING_FALLBACK);

    return (
        <div id="takeover-panel" className="p-4 sm:p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4 font-sans min-w-0">
            <div className="border-b border-nature-800 pb-3">
                <h3 className="text-base font-bold text-white m-0">Take over as the main server</h3>
                <p className="text-xs text-nature-400 m-0 mt-1" style={WRAP}>
                    If the main server is gone for good, this standby can become the community&apos;s main server, keeping the
                    community as it is: the same identity, owners, links with other communities and web address.
                </p>
            </div>

            {progress?.replaced && (
                <div role="alert" id="takeover-replaced" className="p-3 rounded-xl border bg-red-950/70 border-red-800 text-red-200 text-sm space-y-1" style={WRAP}>
                    <p className="m-0 font-bold">🛑 {progress.replaced.message}</p>
                    <p className="m-0">
                        Another server took over this community (identity epoch {progress.replaced.epoch}; this server is at {progress.replaced.ownEpoch}),
                        and this server&apos;s web address now leads there. Members&apos; changes are refused here. Don&apos;t run this server as the
                        main server again: to use this machine, set it up from scratch as a standby of the new main server.
                    </p>
                    <p className="m-0 text-xs text-red-300">Seen {when(progress.replaced.detectedAt)} at {progress.replaced.url}</p>
                </div>
            )}

            {progress?.codeUsed && (
                <div role="alert" id="takeover-code-used" className="p-3 rounded-xl border bg-amber-950/70 border-amber-800 text-amber-200 text-sm" style={WRAP}>
                    ⚠️ {progress.codeUsed.message}
                </div>
            )}

            {/* Under way, or finished: the steps as the server records them. */}
            {followingOne && state !== 'none' && progress && (
                <div id="takeover-progress" className="space-y-3">
                    <p className="text-sm font-bold m-0" style={WRAP}>
                        {state === 'complete' && <span className="text-emerald-300">✅ This server is now the community&apos;s main server.</span>}
                        {state === 'failed' && <span className="text-red-300">The take-over stopped. It is tried again from the same step when the server restarts.</span>}
                        {(state === 'running' || state === 'restarting') && !unreachable && <span className="text-amber-200">Taking over…</span>}
                        {(state === 'running' || state === 'restarting') && unreachable && (
                            <span className="text-amber-200">The server is restarting. This page checks again every few seconds.</span>
                        )}
                    </p>
                    {progress.authorisedBy && (
                        <p className="text-xs text-nature-300 m-0" style={WRAP}>
                            Authorised by {progress.authorisedBy}{progress.startedAt ? `, started ${when(progress.startedAt)}` : ''}.
                            {progress.peerId ? ` Identity kept: ${progress.peerId}.` : ''}
                        </p>
                    )}
                    <ol className="m-0 p-0 list-none space-y-1">
                        {progress.steps.map((s) => (
                            <li key={s.step} className="text-xs flex gap-2 min-w-0" data-step={s.step} data-done={s.done ? 'yes' : 'no'}>
                                <span aria-hidden className="shrink-0 w-4">{s.done ? '✓' : progress.error?.step === s.step ? '✗' : '·'}</span>
                                <span className={`min-w-0 ${s.done ? 'text-nature-200' : 'text-nature-500'}`} style={WRAP}>
                                    {s.label}{s.done && s.detail ? ` — ${s.detail}` : ''}
                                </span>
                            </li>
                        ))}
                    </ol>
                    {progress.error && (
                        <div role="alert" className="p-3 rounded-xl border bg-red-950 border-red-800 text-red-200 text-xs" style={WRAP}>
                            Stopped at “{progress.error.label}”: {progress.error.message}
                        </div>
                    )}
                    {state === 'complete' && progress.result && (
                        <div className="space-y-2 text-xs text-nature-200" style={WRAP}>
                            {progress.result.audit && (
                                <p className={`m-0 ${progress.result.audit.ok ? '' : 'text-red-300 font-bold'}`}>
                                    {progress.result.audit.ok
                                        ? 'The ledger adds up.'
                                        : `The ledger does NOT add up (difference ${progress.result.audit.drift}). Check it before members trade.`}
                                </p>
                            )}
                            {progress.result.tunnel && <p className="m-0">{progress.result.tunnel.message}</p>}
                            {progress.result.roles && progress.result.roles.skipped.length > 0 && (
                                <p className="m-0 text-amber-200">Not brought back: {progress.result.roles.skipped.join('; ')}.</p>
                            )}
                            <p className="m-0 font-bold text-white">Next:</p>
                            <ul className="m-0 pl-5 space-y-1">
                                {progress.afterwards.map((a) => <li key={a}>{a}</li>)}
                            </ul>
                        </div>
                    )}
                    {(state === 'complete' || state === 'failed') && progressToken && (
                        <button type="button" className={`${BTN} bg-nature-800 hover:bg-nature-700 text-white`}
                            onClick={() => { storeToken(activeNode.id, null); setProgressToken(null); }}>
                            Done
                        </button>
                    )}
                </div>
            )}

            {isStandby && state === 'none' && (
                <button type="button" id="takeover-start-btn" className={`${BTN} bg-red-900/70 hover:bg-red-800 border border-red-700 text-red-100 w-full sm:w-auto`}
                    onClick={() => { setError(null); setStage('explain'); }}>
                    Take over as the main server
                </button>
            )}

            {stage !== 'closed' && (
                <ModalBackdrop
                    onClose={close}
                    dismissable={!busy}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="takeover-dialog-title"
                    className="fixed inset-0 overflow-y-auto z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in"
                >
                    <div className="m-auto bg-nature-900 border border-red-800 rounded-2xl p-5 sm:p-6 max-w-lg w-full shadow-2xl space-y-4 font-sans text-white min-w-0">
                        <div className="flex items-start justify-between gap-3 border-b border-nature-800 pb-3">
                            <h3 id="takeover-dialog-title" className="text-base font-bold text-red-200 m-0 min-w-0 flex-1" style={WRAP}>
                                {stage === 'explain' && 'Take over as the main server?'}
                                {stage === 'code' && 'Type the recovery code'}
                                {stage === 'preview' && 'Take over now?'}
                            </h3>
                            <button type="button" onClick={close} disabled={busy} aria-label="Close take-over"
                                className="shrink-0 text-nature-400 hover:text-white text-sm min-h-[48px] min-w-[48px] flex items-center justify-center disabled:opacity-50">
                                ✕
                            </button>
                        </div>

                        {error && (
                            <div role="alert" className="p-3 rounded-xl bg-red-950/80 border border-red-800 text-sm text-red-200" style={WRAP}>
                                {error}
                            </div>
                        )}

                        {stage === 'explain' && (
                            <div className="space-y-3 text-sm text-nature-200" style={WRAP}>
                                <p className="m-0">Do this only if the main server is really gone. This server then becomes the main server:</p>
                                <ul className="m-0 pl-5 space-y-1">
                                    <li>it opens the main server&apos;s locked keys with your printed recovery code;</li>
                                    <li>it takes the main server&apos;s identity, owners and admins, links with other communities, admin password and web address;</li>
                                    <li>it stops copying, restarts, checks the ledger adds up, and posts a notice for members;</li>
                                    <li>after it, sign in with the community&apos;s admin password or an owner&apos;s key: this standby&apos;s own password stops working.</li>
                                </ul>
                                <p className="m-0 font-bold text-white">What it will not have (a standby does not copy these):</p>
                                <ul className="m-0 pl-5 space-y-1" id="takeover-missing">
                                    {missing.map((m) => <li key={m}>{m}</li>)}
                                </ul>
                                <div className="flex flex-col sm:flex-row gap-3 justify-end pt-2">
                                    <button type="button" className={`${BTN} bg-nature-800 hover:bg-nature-700 text-white`} onClick={close}>Cancel</button>
                                    <button type="button" id="takeover-continue-btn" className={`${BTN} bg-red-800 hover:bg-red-700 text-white`}
                                        onClick={() => { setError(null); setStage('code'); }}>
                                        I understand, continue
                                    </button>
                                </div>
                            </div>
                        )}

                        {stage === 'code' && (
                            <form onSubmit={submitCode} className="space-y-3">
                                <label htmlFor="takeover-code" className="block text-sm text-nature-200" style={WRAP}>
                                    The recovery code on the paper, starting BPRC and its number.
                                </label>
                                <input
                                    id="takeover-code"
                                    type="text"
                                    value={code}
                                    onChange={(e) => setCode(e.target.value)}
                                    placeholder="BPRC-1  XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                                    autoComplete="off"
                                    autoCapitalize="characters"
                                    spellCheck={false}
                                    className="w-full min-w-0 bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-red-500 min-h-[48px]"
                                />
                                <div className="flex flex-col sm:flex-row gap-3 justify-end">
                                    <button type="button" className={`${BTN} bg-nature-800 hover:bg-nature-700 text-white`} onClick={close} disabled={busy}>Cancel</button>
                                    <button type="submit" id="takeover-open-btn" className={`${BTN} bg-red-800 hover:bg-red-700 text-white`} disabled={busy || !code.trim()}>
                                        {busy ? 'Opening…' : 'Open the keys'}
                                    </button>
                                </div>
                            </form>
                        )}

                        {stage === 'preview' && preview && (
                            <div className="space-y-3 text-sm text-nature-200" style={WRAP} id="takeover-preview">
                                {preview.mainServer.warning && (
                                    <div role="alert" className="p-3 rounded-xl bg-amber-950/80 border border-amber-800 text-amber-200">
                                        ⚠️ {preview.mainServer.warning}
                                    </div>
                                )}
                                <ul className="m-0 pl-5 space-y-1">
                                    <li>Keys locked {when(preview.envelope.sealedAt)}, opened with recovery code #{preview.envelope.codeId}.</li>
                                    <li>Identity kept: <span className="font-mono text-xs">{preview.peerId}</span></li>
                                    <li>Owners: {preview.owners.length ? preview.owners.join(', ') : 'none'}; admins: {preview.admins}.</li>
                                    <li>Links with other communities: {preview.connectors}.</li>
                                    <li>Web address: {preview.publicAddress ?? 'none'}. {preview.tunnel.message}</li>
                                    <li>
                                        The main server {preview.mainServer.answers === false ? 'does not answer' : preview.mainServer.answers ? 'still answers' : 'is not known to this standby'}.
                                        {' '}Last copied from it: {when(preview.mainServer.lastCopyAt)}.
                                    </li>
                                </ul>
                                <p className="m-0 font-bold text-white">It will not have:</p>
                                <ul className="m-0 pl-5 space-y-1">
                                    {preview.missing.map((m) => <li key={m}>{m}</li>)}
                                </ul>
                                <label className="flex items-start gap-3 min-h-[48px] cursor-pointer select-none">
                                    <input type="checkbox" id="takeover-main-gone" checked={mainGone} onChange={(e) => setMainGone(e.target.checked)}
                                        className="mt-1 h-5 w-5 shrink-0" />
                                    <span>The main server is gone, and nobody will start it again.</span>
                                </label>
                                <div className="flex flex-col sm:flex-row gap-3 justify-end">
                                    <button type="button" className={`${BTN} bg-nature-800 hover:bg-nature-700 text-white`} onClick={close} disabled={busy}>Cancel</button>
                                    <button type="button" id="takeover-confirm-btn" className={`${BTN} bg-red-700 hover:bg-red-600 text-white border border-red-500`}
                                        onClick={confirm} disabled={busy || !mainGone}>
                                        {busy ? 'Taking over…' : 'Take over now'}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </ModalBackdrop>
            )}
        </div>
    );
}
