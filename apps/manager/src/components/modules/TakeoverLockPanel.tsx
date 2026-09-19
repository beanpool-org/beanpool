import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import {
    fetchTakeoverStatus,
    fetchBackupLock,
    makeRecoveryCode,
    checkRecoveryCodeApi,
    getTfaSessionToken,
    TakeoverRequestError,
    type TakeoverStatus,
    type BackupLockStatus,
    type MadeRecoveryCode,
} from '../../lib/node-client';
import { ModalBackdrop } from '../common/ModalBackdrop';
import type { RolesViewer } from './NodeRolesPanel';

/**
 * "Who can unlock this community" — the take-over lock and the printed recovery code (sealed-keys.md §2.6, §3, §4,
 * §7, §9; slice 2b). Everyone signed in sees who the take-over keys are locked to and whether backups are locked;
 * owners (and the admin password, which is owner level) can make, replace and check the recovery code.
 *
 * The code is shown ONCE. It lives in this component's state and nowhere else — never localStorage, sessionStorage,
 * IndexedDB, a log or another request — and is dropped the moment its card closes, or the node changes.
 *
 * Operator manual text for this card: packages/beanpool-guide/operators/server/backups-and-replicas.md — keep them in step.
 */

export interface TakeoverLockPanelProps {
    activeNode: NodeProfile;
    viewer?: RolesViewer;
    /** For the printed page. */
    communityName?: string;
}

function formatDay(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatWhen(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${formatDay(iso)}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

/** `BPRC-3  XXXX-XXXX-…` → the number part and the groups, for large type that wraps between groups only. */
export function splitRecoveryCode(code: string): { prefix: string; groups: string[] } {
    const parts = code.trim().split(/\s+/);
    if (parts.length >= 2 && /^BPRC-\d+$/i.test(parts[0])) {
        return { prefix: parts[0], groups: parts.slice(1).join('').split('-').filter(Boolean) };
    }
    return { prefix: '', groups: code.trim().split(/[\s-]+/).filter(Boolean) };
}

function CodeBlock({ code, light = false }: { code: string; light?: boolean }) {
    const { prefix, groups } = splitRecoveryCode(code);
    return (
        <div data-testid="recovery-code" className={`font-mono font-bold tracking-wider text-center select-all ${light ? 'text-black' : 'text-white'}`}>
            {prefix && <div className={`text-lg ${light ? 'text-gray-700' : 'text-amber-300'}`}>{prefix}</div>}
            <div className="flex flex-wrap justify-center gap-y-1 text-2xl leading-snug">
                {groups.map((g, i) => (
                    <span key={i} className="whitespace-nowrap">{g}{i < groups.length - 1 ? '-' : ''}</span>
                ))}
            </div>
        </div>
    );
}

/** What the printed page says (design §2.6: community, code number, date, what it is for, where to type it). */
export function printInstructions(codeId: number, madeOn: string): string[] {
    return [
        `This is recovery code #${codeId} for your community's BeanPool server. This paper unlocks the server's take-over keys and its locked backups. They are locked to the community's owners too.`,
        "Keep it even while every owner still has their phone. When this code was made, this paper was the only way to open a locked backup; opening one with an owner's phone comes in a later update.",
        'Type it where the server asks for "the recovery code". Capitals or small letters both work, and the dashes are optional.',
        'To check this paper later: Settings → Appliance & Data → Backups & Restore → Check a code.',
        `Keep it somewhere safe that is not next to the server. Anyone holding it can open your backups. If a new code is made, keep this one until every backup made before then is destroyed: those still open with code #${codeId}, made ${madeOn}.`,
    ];
}

// `visibility: hidden` keeps the rest of Settings' height, and Chromium prints a `position: fixed` element (the modal
// overlay) on every page, so the page is held to one sheet of paper: a tall page printed the code three times (#979).
// Clipping html and body works wherever the modal sits in the page (it is not portalled; it lives inside <main>).
const PRINT_CSS = `
@media print {
  html, body { height: 100% !important; overflow: hidden !important; background: #fff !important; }
  body * { visibility: hidden !important; }
  [data-print-sheet], [data-print-sheet] * { visibility: visible !important; }
  [data-print-sheet] { position: absolute !important; left: 0; top: 0; width: 100%; box-shadow: none !important; border: none !important; }
  [data-print-hide] { display: none !important; }
}`;

export function TakeoverLockPanel({ activeNode, viewer = { kind: 'password' }, communityName }: TakeoverLockPanelProps) {
    const isOwner = viewer.kind === 'password' || viewer.role === 'owner';

    const [status, setStatus] = useState<TakeoverStatus | null>(null);
    const [statusError, setStatusError] = useState<string | null>(null);
    const [backupLock, setBackupLock] = useState<BackupLockStatus | null | 'unknown'>(null);
    const [loading, setLoading] = useState(false);

    const [actionError, setActionError] = useState<string | null>(null);
    const [making, setMaking] = useState(false);
    const [confirmReplace, setConfirmReplace] = useState(false);

    // The one place the code exists in the browser. Cleared by closeCode().
    const [shown, setShown] = useState<MadeRecoveryCode | null>(null);
    const [writtenDown, setWrittenDown] = useState(false);
    const [printOpen, setPrintOpen] = useState(false);

    const [checkOpen, setCheckOpen] = useState(false);
    const [typed, setTyped] = useState('');
    const [checking, setChecking] = useState(false);
    const [checkResult, setCheckResult] = useState<{ ok: boolean; text: string } | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        const tfa = getTfaSessionToken(activeNode.id);
        try {
            setStatus(await fetchTakeoverStatus(activeNode.url, activeNode.adminPassword, tfa));
            setStatusError(null);
        } catch (e) {
            setStatus(null);
            setStatusError(e instanceof TakeoverRequestError && e.status === 404
                ? 'This node is too old to lock its take-over keys. Update it to the latest release.'
                : `Could not read who can unlock this community: ${e instanceof Error ? e.message : 'the node did not answer'}.`);
        }
        try {
            setBackupLock((await fetchBackupLock(activeNode.url, activeNode.adminPassword, tfa)) ?? 'unknown');
        } catch {
            setBackupLock('unknown');
        } finally {
            setLoading(false);
        }
    }, [activeNode.id, activeNode.url, activeNode.adminPassword]);

    const closeCode = useCallback(() => {
        setShown(null);
        setWrittenDown(false);
        setPrintOpen(false);
    }, []);

    const closeCheck = useCallback(() => {
        setCheckOpen(false);
        setTyped('');
        setCheckResult(null);
    }, []);

    useEffect(() => {
        // A different node: nothing from the last one may stay on screen, least of all a code.
        closeCode();
        closeCheck();
        setConfirmReplace(false);
        setActionError(null);
        void load();
    }, [load, closeCode, closeCheck]);

    // The node on screen now. A code made for one node must never show under another's card, or print with its name.
    const nodeIdRef = useRef(activeNode.id);
    nodeIdRef.current = activeNode.id;

    const make = async (replace: boolean) => {
        const forNode = activeNode.id;
        setMaking(true);
        setActionError(null);
        try {
            const made = await makeRecoveryCode(activeNode.url, replace, activeNode.adminPassword, getTfaSessionToken(activeNode.id));
            if (nodeIdRef.current !== forNode) return;
            setConfirmReplace(false);
            setShown(made);
            setWrittenDown(false);
            setStatus(made.status);
            setStatusError(null);
            fetchBackupLock(activeNode.url, activeNode.adminPassword, getTfaSessionToken(activeNode.id))
                .then((l) => setBackupLock(l ?? 'unknown'))
                .catch(() => setBackupLock('unknown'));
        } catch (e) {
            if (nodeIdRef.current !== forNode) return;
            setConfirmReplace(false);
            setActionError(e instanceof Error ? e.message : 'The recovery code could not be made.');
            void load();
        } finally {
            setMaking(false);
        }
    };

    const check = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!typed.trim() || checking) return;
        setChecking(true);
        setCheckResult(null);
        try {
            const r = await checkRecoveryCodeApi(activeNode.url, typed, activeNode.adminPassword, getTfaSessionToken(activeNode.id));
            if (r.typo) setCheckResult({ ok: false, text: r.message || 'That is not a recovery code: check what you typed.' });
            else if (r.matches) setCheckResult({ ok: true, text: `Yes — this is recovery code #${r.codeId}. Your paper is right.` });
            else setCheckResult({ ok: false, text: `No — this does not match recovery code #${r.codeId ?? status?.recoveryCode?.codeId ?? '?'}.` });
        } catch (err) {
            setCheckResult({ ok: false, text: err instanceof Error ? err.message : 'The node did not answer.' });
        } finally {
            setChecking(false);
        }
    };

    const code = status?.recoveryCode ?? null;
    const isStandby = status?.state === 'standby';
    const canAct = isOwner && !isStandby && !!status;

    let stateTone = 'border-nature-800 bg-nature-950 text-nature-200';
    let stateLine: React.ReactNode = loading ? 'Reading the lock…' : null;
    if (statusError) {
        stateTone = 'border-red-800 bg-red-950/50 text-red-200';
        stateLine = <>⚠️ {statusError}</>;
    } else if (status) {
        if (status.state === 'sealed') {
            stateTone = 'border-emerald-800/80 bg-emerald-950/40 text-emerald-200';
            stateLine = <>🔒 <strong>Locked.</strong> {status.message}</>;
        } else if (status.state === 'error') {
            stateTone = 'border-red-800 bg-red-950/50 text-red-200';
            stateLine = <>⚠️ <strong>Error.</strong> {status.message}</>;
        } else if (status.state === 'standby') {
            stateLine = <>ℹ️ {status.message} Make the recovery code in the main server&apos;s Settings.</>;
        } else {
            stateTone = 'border-amber-800 bg-amber-950/50 text-amber-200';
            stateLine = <>🔓 <strong>Not locked yet.</strong> {status.message}</>;
        }
    }

    const madeOn = shown ? formatDay(shown.createdAt) : '';

    return (
        <div className="p-4 sm:p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4" data-testid="takeover-lock-panel">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-nature-800 pb-3">
                <div className="min-w-[12rem] flex-1">
                    <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                        <span>🔐</span>
                        <span>Who can unlock this community</span>
                    </h3>
                    <p className="text-xs text-nature-400 m-0 mt-0.5">
                        This server&apos;s keys and admin sign-in, locked to its owners and to the printed recovery code, for bringing the community up on another server. Today only the recovery code opens a locked backup.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => void load()}
                    disabled={loading}
                    className="min-h-[48px] px-4 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all disabled:opacity-50 shrink-0"
                >
                    {loading ? 'Reading…' : 'Refresh'}
                </button>
            </div>

            {status?.codeUsed && (
                <div role="alert" data-testid="takeover-code-used" className="p-3 rounded-xl border bg-amber-950/70 border-amber-800 text-amber-200 text-xs leading-relaxed" style={{ overflowWrap: 'anywhere' }}>
                    ⚠️ {status.codeUsed.message}
                </div>
            )}

            {stateLine && (
                <div role="status" data-testid="takeover-state" className={`p-3 rounded-xl border text-xs leading-relaxed ${stateTone}`}>
                    {stateLine}
                </div>
            )}

            {status && status.state === 'sealed' && (
                <div className="space-y-2">
                    <p className="text-xs font-bold text-nature-300 m-0">Any one of these can open it:</p>
                    <ul className="m-0 p-0 list-none space-y-1.5" data-testid="takeover-recipients">
                        {status.recipients.owners.map((o) => (
                            <li key={o.pubkey} className="text-xs text-white bg-nature-950 border border-nature-800 rounded-lg px-3 py-2 break-words">
                                👑 @{o.callsign} <span className="text-nature-500">· owner</span>
                            </li>
                        ))}
                        {status.recipients.codes.map((c) => (
                            <li key={c.codeId} className="text-xs text-white bg-nature-950 border border-nature-800 rounded-lg px-3 py-2 break-words">
                                📄 Recovery code #{c.codeId} <span className="text-nature-500">· made {formatDay(c.createdAt)}</span>
                            </li>
                        ))}
                    </ul>
                    {status.sealedAt && (
                        <p className="text-xs text-nature-400 m-0" data-testid="takeover-sealed-at">
                            Last re-locked {formatWhen(status.sealedAt)}{status.sealReason ? ` (${status.sealReason})` : ''}.
                        </p>
                    )}
                </div>
            )}

            {status && (status.skippedOwners?.length ?? 0) > 0 && (
                <div className="p-3 rounded-xl border border-amber-800 bg-amber-950/50 text-xs text-amber-200 space-y-1">
                    {status.skippedOwners.map((o) => (
                        <p key={o.pubkey} className="m-0 break-words">⚠️ @{o.callsign} is an owner but is not in the lock: {o.why}.</p>
                    ))}
                </div>
            )}

            <div data-testid="backup-lock" className="text-xs text-nature-300 bg-nature-950 border border-nature-800 rounded-xl p-3">
                {backupLock === null
                    ? 'Backups: checking…'
                    : backupLock === 'unknown'
                        ? 'Backups: this node did not say whether its backups are locked.'
                        : <>{backupLock.locked ? '🔒' : '🔓'} {backupLock.message}</>}
            </div>

            {status && !isStandby && (
                <div className="space-y-3 border-t border-nature-800 pt-3">
                    <p className="text-xs text-nature-300 m-0" data-testid="recovery-code-line">
                        {code
                            ? <>📄 Recovery code <strong className="text-white">#{code.codeId}</strong>, made {formatDay(code.createdAt)}.</>
                            : <>📄 <strong className="text-white">No printed recovery code.</strong> If every owner loses their phone and their 12 words, the take-over keys can&apos;t be opened, and backups aren&apos;t locked.</>}
                    </p>

                    {actionError && (
                        <div role="alert" className="p-3 rounded-xl bg-red-950/80 border border-red-800 text-xs text-red-200">❌ {actionError}</div>
                    )}

                    {canAct ? (
                        <div className="flex flex-wrap gap-2">
                            {code ? (
                                <button
                                    type="button"
                                    onClick={() => { setActionError(null); setConfirmReplace(true); }}
                                    disabled={making}
                                    className="min-h-[48px] px-4 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all disabled:opacity-50"
                                >
                                    Replace it
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => void make(false)}
                                    disabled={making}
                                    className="min-h-[48px] px-4 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all disabled:opacity-50"
                                >
                                    {making ? 'Making…' : 'Make a recovery code'}
                                </button>
                            )}
                            {code && (
                                <button
                                    type="button"
                                    onClick={() => setCheckOpen(true)}
                                    className="min-h-[48px] px-4 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all"
                                >
                                    Check a code
                                </button>
                            )}
                        </div>
                    ) : !isOwner ? (
                        <p className="text-xs text-nature-400 m-0" data-testid="owners-only-note">
                            Only an owner can make, replace or check the recovery code.
                        </p>
                    ) : null}
                </div>
            )}

            {/* Replace: the old paper still opens backups made while it was current (design §2.6). */}
            {confirmReplace && code && (
                <ModalBackdrop
                    onClose={() => { if (!making) setConfirmReplace(false); }}
                    dismissable={!making}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="replace-code-title"
                    className="fixed inset-0 overflow-y-auto z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in"
                >
                    <div className="m-auto bg-nature-900 border border-amber-700 rounded-2xl p-5 max-w-md w-full shadow-2xl space-y-4 font-sans text-white">
                        <div className="flex items-start justify-between gap-3 border-b border-nature-800 pb-3">
                            <h3 id="replace-code-title" className="text-base font-bold text-amber-300 m-0 min-w-0 flex-1">
                                Replace recovery code #{code.codeId}?
                            </h3>
                            <button
                                type="button"
                                onClick={() => { if (!making) setConfirmReplace(false); }}
                                disabled={making}
                                aria-label="Close replace recovery code"
                                className="shrink-0 text-nature-400 hover:text-white text-sm min-h-[48px] min-w-[48px] flex items-center justify-center disabled:opacity-50"
                            >
                                ✕
                            </button>
                        </div>
                        <div className="p-3 bg-amber-950/60 border border-amber-900/60 rounded-xl space-y-2 text-xs text-amber-200">
                            <p className="m-0">A new code is made and shown once. From now on the take-over keys and new backups are locked to the owners and the <strong>new</strong> code; code #{code.codeId} stops opening them.</p>
                            <p className="m-0"><strong>Backups made before now stay locked to the old code #{code.codeId} as well as the owners.</strong> Keep the old paper until those backups are destroyed.</p>
                        </div>
                        <div className="flex flex-wrap justify-end gap-2">
                            <button
                                type="button"
                                onClick={() => setConfirmReplace(false)}
                                disabled={making}
                                className="min-h-[48px] px-4 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={() => void make(true)}
                                disabled={making}
                                className="min-h-[48px] px-4 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white disabled:opacity-50"
                            >
                                {making ? 'Making…' : 'Make a new code'}
                            </button>
                        </div>
                    </div>
                </ModalBackdrop>
            )}

            {/* The code, once. A stray tap, Escape or Back must not throw it away: only ✕ and Done close it. */}
            {shown && (
                <ModalBackdrop
                    onClose={closeCode}
                    dismissable={false}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="code-shown-title"
                    className="fixed inset-0 overflow-y-auto z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in"
                >
                    <div className="m-auto bg-nature-900 border border-terra-600 rounded-2xl p-5 max-w-md w-full shadow-2xl space-y-4 font-sans text-white">
                        <div className="flex items-start justify-between gap-3 border-b border-nature-800 pb-3">
                            <h3 id="code-shown-title" className="text-base font-bold text-white m-0 min-w-0 flex-1">
                                Recovery code #{shown.codeId}
                            </h3>
                            <button
                                type="button"
                                onClick={closeCode}
                                aria-label="Close recovery code"
                                className="shrink-0 text-nature-400 hover:text-white text-sm min-h-[48px] min-w-[48px] flex items-center justify-center"
                            >
                                ✕
                            </button>
                        </div>
                        <p className="text-xs text-amber-200 m-0">
                            <strong>Write this down or print it now.</strong> It is shown once: this server does not keep it, and nobody can show it to you again.
                        </p>
                        <div className="p-4 rounded-xl bg-nature-950 border border-nature-700">
                            <CodeBlock code={shown.code} />
                        </div>
                        {shown.replacedCodeId !== null && (
                            <p className="text-xs text-nature-300 m-0">
                                Code #{shown.replacedCodeId} no longer opens anything locked from now on. Backups made before today still open with it: keep that paper until they are destroyed.
                            </p>
                        )}
                        <button
                            type="button"
                            onClick={() => setPrintOpen(true)}
                            className="w-full min-h-[48px] px-4 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700"
                        >
                            🖨️ Print
                        </button>
                        <label className="flex items-center gap-3 min-h-[48px] px-3 rounded-xl bg-nature-950 border border-nature-700 cursor-pointer text-xs text-white">
                            <input
                                type="checkbox"
                                checked={writtenDown}
                                onChange={(e) => setWrittenDown(e.target.checked)}
                                className="w-5 h-5 shrink-0"
                            />
                            <span>I&apos;ve printed it or written it down</span>
                        </label>
                        <button
                            type="button"
                            onClick={closeCode}
                            disabled={!writtenDown}
                            className="w-full min-h-[48px] px-4 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white disabled:opacity-50"
                        >
                            Done
                        </button>
                        {!writtenDown && (
                            <p className="text-[11px] text-nature-400 m-0">Closing without writing it down means making a new code.</p>
                        )}
                    </div>
                </ModalBackdrop>
            )}

            {/* The printed page: a plain white sheet, and only it, goes to the printer. No new window, no request. */}
            {shown && printOpen && (
                <ModalBackdrop
                    onClose={() => setPrintOpen(false)}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="print-code-title"
                    className="fixed inset-0 overflow-y-auto z-50 flex items-center justify-center p-4 bg-black/80 animate-fade-in"
                >
                    <div className="m-auto bg-white text-black rounded-2xl p-5 max-w-md w-full shadow-2xl space-y-4 font-sans" data-print-sheet data-testid="print-sheet">
                        <style>{PRINT_CSS}</style>
                        <div className="flex items-start justify-between gap-3 border-b border-gray-300 pb-3">
                            <div className="min-w-0 flex-1">
                                <h3 id="print-code-title" className="text-base font-bold m-0 break-words">
                                    BeanPool recovery code #{shown.codeId}
                                </h3>
                                <p className="text-sm m-0 mt-1 break-words" data-testid="print-community">{communityName || activeNode.name}</p>
                                <p className="text-xs text-gray-600 m-0 mt-0.5">Made {madeOn}</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setPrintOpen(false)}
                                aria-label="Close print view"
                                data-print-hide
                                className="shrink-0 text-gray-500 hover:text-black text-sm min-h-[48px] min-w-[48px] flex items-center justify-center"
                            >
                                ✕
                            </button>
                        </div>
                        <div className="p-4 rounded-xl border-2 border-black">
                            <CodeBlock code={shown.code} light />
                        </div>
                        <ul className="m-0 pl-4 space-y-2 text-xs leading-relaxed list-disc">
                            {printInstructions(shown.codeId, madeOn).map((t, i) => <li key={i}>{t}</li>)}
                        </ul>
                        <button
                            type="button"
                            data-print-hide
                            onClick={() => window.print()}
                            className="w-full min-h-[48px] px-4 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-xs font-bold text-white"
                        >
                            🖨️ Print this page
                        </button>
                    </div>
                </ModalBackdrop>
            )}

            {checkOpen && (
                <ModalBackdrop
                    onClose={closeCheck}
                    dismissable={!checking}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="check-code-title"
                    className="fixed inset-0 overflow-y-auto z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in"
                >
                    <div className="m-auto bg-nature-900 border border-nature-700 rounded-2xl p-5 max-w-md w-full shadow-2xl space-y-4 font-sans text-white">
                        <div className="flex items-start justify-between gap-3 border-b border-nature-800 pb-3">
                            <h3 id="check-code-title" className="text-base font-bold text-white m-0 min-w-0 flex-1">
                                Check a recovery code
                            </h3>
                            <button
                                type="button"
                                onClick={closeCheck}
                                disabled={checking}
                                aria-label="Close check a code"
                                className="shrink-0 text-nature-400 hover:text-white text-sm min-h-[48px] min-w-[48px] flex items-center justify-center disabled:opacity-50"
                            >
                                ✕
                            </button>
                        </div>
                        <p className="text-xs text-nature-300 m-0">
                            Type the code from your paper. The server checks it against code #{code?.codeId ?? '?'} and keeps nothing.
                        </p>
                        <form onSubmit={check} className="space-y-3">
                            <label htmlFor="check-code-input" className="block text-xs font-bold text-nature-300">Recovery code</label>
                            <input
                                id="check-code-input"
                                type="text"
                                value={typed}
                                onChange={(e) => { setTyped(e.target.value); setCheckResult(null); }}
                                autoComplete="off"
                                autoCorrect="off"
                                autoCapitalize="characters"
                                spellCheck={false}
                                data-1p-ignore
                                data-lpignore="true"
                                placeholder="BPRC-1 XXXX-XXXX-…"
                                className="w-full min-h-[48px] bg-nature-950 border border-nature-700 rounded-xl px-3 text-sm font-mono text-white"
                            />
                            <button
                                type="submit"
                                disabled={!typed.trim() || checking}
                                className="w-full min-h-[48px] px-4 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white disabled:opacity-50"
                            >
                                {checking ? 'Checking… (about a second)' : 'Check'}
                            </button>
                        </form>
                        {checkResult && (
                            <div
                                role="status"
                                data-testid="check-result"
                                className={`p-3 rounded-xl border text-xs ${checkResult.ok ? 'bg-emerald-950/40 border-emerald-800 text-emerald-200' : 'bg-red-950/50 border-red-800 text-red-200'}`}
                            >
                                {checkResult.ok ? '✓ ' : '✗ '}{checkResult.text}
                            </div>
                        )}
                    </div>
                </ModalBackdrop>
            )}
        </div>
    );
}
