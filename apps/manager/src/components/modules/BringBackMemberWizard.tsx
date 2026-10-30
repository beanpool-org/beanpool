import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    issueBringBackCodeApi,
    cancelRekeyCodeApi,
    bindRekeyByMatchApi,
    declineRekeyProposalApi,
    fetchRekeyStatusApi,
    RekeyBindError,
    type RekeyProposal,
    type RekeyStatusResponse,
} from '../../lib/node-client';
import { generateOfflineQrUrl } from '../../lib/qr';
import { ModalBackdrop } from '../common/ModalBackdrop';
import { FreshProofBox, useFreshProof } from '../common/FreshProofBox';
import { askedAt, rekeyLink, rekeyTimeLeft, REKEY_PROPOSALS_POLL_MS } from './RekeyMemberWizard';

/**
 * Bring back (vault rethink VR3, scratch/fable-design/DESIGN-vault-rethink-fable.md §4.3 and §4.5): the member's SAME key
 * on their new phone, from the copy they keep with this community, beside Re-key's NEW key. The re-key's code-and-digits
 * flow: a BB- code, their new phone asks on it and shows two digits, the admin types them, and the node releases the copy
 * to that phone alone. Nothing moves and nobody is suspended. An owner for an owner or admin (the node's rule, as a
 * re-key's), with the fresh proof. The same brakes as Re-key's step 2: the phones that asked on the code, read every few
 * seconds, each with Not theirs, and a warning when codes like it are being guessed at.
 */

/** The admin's two ways, side by side (design §4.5). */
export const BRING_BACK_WORDS = 'Brings back the same key: their Beans, name, chats and every community. Only for someone you have checked in person. They need their new phone here.';
export const REKEY_INSTEAD_WORDS = 'Re-key gives a new key, for someone whose way back is gone. Their Beans and history move; chats will say the key changed.';
/** The admin's line on the code's screen (design §4.4). */
export const ONLY_IN_PERSON = 'Only bring back someone you have checked in person.';

export interface BringBackMemberWizardProps {
    member: { publicKey: string; callsign: string };
    nodeUrl: string;
    adminPassword?: string;
    tfaToken?: string;
    /** Opens Re-key instead (a member with no copy here, or a new key wanted). */
    onRekeyInstead?: () => void;
    onClose: () => void;
}

export function BringBackMemberWizard({ member, nodeUrl, adminPassword, tfaToken, onRekeyInstead, onClose }: BringBackMemberWizardProps) {
    const [status, setStatus] = useState<RekeyStatusResponse | null>(null);
    const [statusFailed, setStatusFailed] = useState(false);
    const [checked, setChecked] = useState(false);
    const [code, setCode] = useState<string | null>(null);
    const [expiresAt, setExpiresAt] = useState<string | null>(null);
    const [typedMatch, setTypedMatch] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    const [stopped, setStopped] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const proof = useFreshProof();
    const binding = useRef(false);
    // The phones that asked on the code (Re-key's step 2 reads the same): the admin turns away any that isn't theirs, and
    // can see that their phone hasn't asked yet, or that others took the code's places.
    const [proposals, setProposals] = useState<RekeyProposal[]>([]);
    const [declining, setDeclining] = useState<string | null>(null);
    // Someone is guessing at codes starting like this one (the node's per-prefix count, #1783 review N3).
    const [underAttack, setUnderAttack] = useState<RekeyStatusResponse['codeUnderAttack'] | null>(null);
    // The node no longer holds this code, so its phones are no longer this code's: 'expired' when it ran out (the node marks
    // it before this page's clock does), 'elsewhere' when it was used, cancelled or replaced on another screen.
    const [gone, setGone] = useState<false | 'expired' | 'elsewhere'>(false);

    /** A code made, cancelled or put away here starts clean: nothing of the one before it shows. */
    const forgetCodeState = () => {
        setProposals([]);
        setUnderAttack(null);
        setGone(false);
        setStopped(false);
    };

    const read = useCallback(async () => {
        setStatusFailed(false);
        try {
            const s = await fetchRekeyStatusApi(nodeUrl, member.publicKey, adminPassword, tfaToken);
            setStatus(s);
            const pending = s.pendingRequest;
            if (pending?.kind === 'bring_back' && pending.code && new Date(pending.expires_at).getTime() > Date.now()) {
                setCode(pending.code);
                setExpiresAt(pending.expires_at);
                setProposals(s.proposals ?? []);
                setUnderAttack(s.codeUnderAttack ?? null);
            }
        } catch {
            setStatusFailed(true);
        }
    }, [nodeUrl, member.publicKey, adminPassword, tfaToken]);

    useEffect(() => { read(); }, [read]);
    useEffect(() => {
        if (!code) return;
        const id = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(id);
    }, [code]);

    // While the code waits: which phones asked on it, and whether codes like it are being guessed at.
    useEffect(() => {
        if (!code || done || stopped || gone) return;
        let live = true;
        const id = setInterval(async () => {
            try {
                const s = await fetchRekeyStatusApi(nodeUrl, member.publicKey, adminPassword, tfaToken);
                if (!live) return;
                const pending = s.pendingRequest;
                if (pending?.kind === 'bring_back' && pending.code === code) {
                    setProposals(s.proposals ?? []);
                    setUnderAttack(s.codeUnderAttack ?? null);
                } else if (!(pending?.kind === 'bring_back' && !pending.code)) {
                    // A code held back from this reader (a phone session past its step-up window) can't be told apart, so
                    // it is left as it was; anything else means the node holds this code no more.
                    const ranOut = !pending && !!expiresAt && new Date(expiresAt).getTime() - Date.now() < 60000;
                    setGone(ranOut ? 'expired' : 'elsewhere');
                }
            } catch {
                // The next read tries again; the cards stay as they were.
            }
        }, REKEY_PROPOSALS_POLL_MS);
        return () => {
            live = false;
            clearInterval(id);
        };
    }, [code, expiresAt, done, stopped, gone, nodeUrl, member.publicKey, adminPassword, tfaToken]);

    const kept = status?.communityCopy?.kept === true;
    const rekeyWaiting = status?.pendingRequest && status.pendingRequest.kind !== 'bring_back';
    const expired = !!expiresAt && new Date(expiresAt).getTime() < now;

    const makeCode = async (fresh?: string) => {
        if (!checked || busy) return;
        setBusy(true);
        setError(null);
        try {
            const res = await issueBringBackCodeApi(nodeUrl, member.publicKey, adminPassword, tfaToken, ...(fresh ? [fresh] : []));
            proof.close();
            forgetCodeState();
            setCode(res.code);
            setExpiresAt(res.expiresAt);
            setTypedMatch('');
        } catch (err: unknown) {
            if (proof.checkError(err, (c) => makeCode(c), fresh)) return;
            setError(err instanceof Error ? err.message : 'Failed to make a bring-back code');
        } finally {
            setBusy(false);
        }
    };

    const confirmNumber = async (fresh?: string) => {
        const match = typedMatch.trim();
        if (!/^\d{2}$/.test(match)) {
            setError('Type the two digits on their phone.');
            return;
        }
        if (!code || binding.current) return;
        binding.current = true;
        setBusy(true);
        setError(null);
        try {
            const res = await bindRekeyByMatchApi(nodeUrl, member.publicKey, code, match, adminPassword, tfaToken, ...(fresh ? [fresh] : []));
            proof.close();
            if (res.broughtBack) setDone(true);
            else setError('The node did not bring them back. Open the member again and check.');
        } catch (err: unknown) {
            if (proof.checkError(err, (c) => confirmNumber(c), fresh)) return;
            setTypedMatch('');
            if (err instanceof RekeyBindError && err.code === 'code_stopped') setStopped(true);
            const left = err instanceof RekeyBindError && err.triesLeft !== undefined ? ` ${err.triesLeft === 1 ? 'One more wrong number stops this code.' : `${err.triesLeft} tries left.`}` : '';
            setError(`${err instanceof Error ? err.message : 'Failed to bring them back'}${left}`);
        } finally {
            binding.current = false;
            setBusy(false);
        }
    };

    const cancel = async () => {
        setBusy(true);
        setError(null);
        try {
            await cancelRekeyCodeApi(nodeUrl, member.publicKey, adminPassword, tfaToken);
            forgetCodeState();
            setCode(null);
            setExpiresAt(null);
            setChecked(false);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Failed to cancel the code');
        } finally {
            setBusy(false);
        }
    };

    /** "Not theirs": the phone is turned away (its poll answers declined), and its card goes. */
    const decline = async (key: string) => {
        setDeclining(key);
        setError(null);
        try {
            await declineRekeyProposalApi(nodeUrl, member.publicKey, key, adminPassword, tfaToken);
            setProposals((list) => list.filter((p) => p.newPubkey !== key));
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Failed to decline that phone');
        } finally {
            setDeclining(null);
        }
    };

    const waiting = !expired && !stopped && !gone;

    return (
        <ModalBackdrop onClose={onClose} className="fixed inset-0 overflow-y-auto bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-fade-in font-sans">
            <div className="w-full max-w-lg bg-nature-950 border border-nature-700 rounded-3xl shadow-2xl p-5 space-y-4 text-xs text-nature-200" data-testid="bring-back-wizard">
                <div className="flex items-start justify-between gap-3">
                    <h3 className="text-lg font-bold text-white leading-tight break-words m-0">Bring back @{member.callsign}</h3>
                    <button type="button" onClick={onClose} className="text-nature-400 hover:text-white text-lg leading-none" aria-label="Close">×</button>
                </div>

                {done ? (
                    <div className="space-y-3" data-testid="bring-back-done">
                        <p className="text-sm font-bold text-emerald-300 m-0 break-words">@{member.callsign} has their account back on their new phone.</p>
                        <p className="m-0 leading-relaxed break-words">Nothing moved: the same key, their Beans, name, chats and every community. Their other phones were told.</p>
                        <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl bg-bp-gold-fill hover:bg-bp-gold-hover text-bp-gold-on font-semibold">Done</button>
                    </div>
                ) : statusFailed ? (
                    <div className="space-y-2">
                        <p className="m-0 text-amber-300">Couldn't read this member's ways back from the node.</p>
                        <button type="button" onClick={read} className="px-3 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-white font-semibold">Try again</button>
                    </div>
                ) : !status ? (
                    <p className="m-0 text-nature-400">Reading…</p>
                ) : !code ? (
                    <div className="space-y-3">
                        <p className="m-0 leading-relaxed break-words" data-testid="bring-back-words">{BRING_BACK_WORDS}</p>
                        <p className="m-0 leading-relaxed break-words text-nature-400">{REKEY_INSTEAD_WORDS}</p>
                        <p className="m-0 font-bold break-words" data-testid="bring-back-can">
                            {kept
                                ? `Can be brought back by this community: yes${status.communityCopy?.since ? `, since ${new Date(status.communityCopy.since).toLocaleDateString()}` : ''}.`
                                : 'Can be brought back by this community: no. They haven’t turned on “Your community’s admins” here, so there is nothing to bring back.'}
                        </p>
                        {rekeyWaiting && (
                            <p className="m-0 text-amber-300 break-words">They have a re-key code waiting, which holds their key. Cancel it on Re-Key first.</p>
                        )}
                        {kept && !rekeyWaiting && (
                            <>
                                <label className="flex items-start gap-2 cursor-pointer">
                                    <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5" data-testid="bring-back-checked" />
                                    <span className="break-words">I have checked @{member.callsign} in person, and their new phone is here.</span>
                                </label>
                                <button
                                    type="button"
                                    disabled={!checked || busy}
                                    onClick={() => makeCode()}
                                    className="px-4 py-2 rounded-xl bg-bp-gold-fill hover:bg-bp-gold-hover text-bp-gold-on font-semibold disabled:opacity-50"
                                    data-testid="bring-back-make-code"
                                >
                                    {busy ? 'Making the code…' : 'Make a bring-back code'}
                                </button>
                            </>
                        )}
                        {onRekeyInstead && (
                            <button type="button" onClick={onRekeyInstead} className="block text-amber-300 underline">Re-key instead</button>
                        )}
                    </div>
                ) : (
                    <div className="space-y-3">
                        <p className="m-0 font-bold text-amber-200 break-words" data-testid="bring-back-in-person">{ONLY_IN_PERSON}</p>
                        <div className="bg-nature-900/90 border border-nature-700/80 p-4 rounded-2xl text-center space-y-2">
                            <span className="text-2xl font-mono font-extrabold tracking-widest text-amber-300 bg-black/40 px-4 py-2 rounded-xl border border-amber-900/60 break-all inline-block" data-testid="bring-back-code">{code}</span>
                            {!waiting ? (
                                <p className="m-0 text-amber-300" data-testid="bring-back-code-ended">
                                    {gone === 'elsewhere' && !stopped && !expired
                                        ? 'This code is no longer waiting: it was used, cancelled or replaced on another screen. Open the member again to see where they are.'
                                        : `${stopped ? 'Three wrong numbers were typed, so this code has stopped.' : 'This code has expired.'} Make a new one with them there.`}
                                </p>
                            ) : (
                                <>
                                    <img src={generateOfflineQrUrl(rekeyLink(nodeUrl, code))} data-qr-value={rekeyLink(nodeUrl, code)} alt={`QR code for ${code}`} className="mx-auto w-40 h-40 max-w-full rounded-lg bg-white p-1" />
                                    {expiresAt && <p className="m-0 text-[10px] text-nature-400">{rekeyTimeLeft(expiresAt, now)}</p>}
                                </>
                            )}
                        </div>
                        {waiting && underAttack && (
                            <div data-testid="bring-back-under-attack" className="p-3 bg-red-950/60 border border-red-800/80 rounded-2xl text-[11px] leading-relaxed text-red-200 break-words">
                                {underAttack.refusing
                                    ? 'Someone is guessing at codes like this one, so phones asking with it are turned away for the rest of the hour. Cancel it and make a new code: a new one starts differently.'
                                    : `Someone has tried ${underAttack.wrongTries} wrong codes like this one in the last hour. A phone you don't recognise is someone else's: press Not theirs.`}
                            </div>
                        )}
                        <p className="m-0 leading-relaxed break-words">
                            Have them open BeanPool on the new phone → <strong>Already a Member? Restore Account</strong> → <strong>An admin gave me a re-key code</strong>, and scan this or type the code and your community's name. Their phone shows two digits.
                        </p>
                        {waiting && (
                            <label className="block space-y-1.5">
                                <span className="block font-bold text-amber-200">Type the number on their phone:</span>
                                <div className="flex flex-wrap items-center gap-2">
                                    <input
                                        value={typedMatch}
                                        onChange={(e) => setTypedMatch(e.target.value.replace(/\D/g, '').slice(0, 2))}
                                        inputMode="numeric"
                                        className="w-20 px-3 py-2 rounded-xl bg-black/40 border border-nature-600 text-white font-mono text-lg text-center"
                                        data-testid="bring-back-number"
                                    />
                                    <button type="button" disabled={busy || typedMatch.length !== 2} onClick={() => confirmNumber()} className="px-4 py-2 rounded-xl bg-bp-gold-fill hover:bg-bp-gold-hover text-bp-gold-on font-semibold disabled:opacity-50" data-testid="bring-back-confirm">
                                        {busy ? 'Bringing back…' : 'Bring them back'}
                                    </button>
                                </div>
                            </label>
                        )}
                        {/* The phones that asked: the admin types the number on the phone in front of them, and turns away the rest */}
                        {waiting && (
                            <div className="space-y-2" data-testid="bring-back-proposals">
                                {proposals.length === 0 ? (
                                    <p className="m-0 text-[11px] text-nature-400">Waiting for their phone to ask…</p>
                                ) : (
                                    <>
                                        <p className="m-0 text-[11px] text-nature-300 break-words">
                                            {proposals.length === 1 ? 'One phone has asked.' : `${proposals.length} phones have asked.`} More than theirs means someone else has the code: press Not theirs on any you don't recognise, or cancel the code and make a new one with them here.
                                        </p>
                                        {proposals.map((p) => (
                                            <div key={p.newPubkey} data-testid="bring-back-proposal" className="p-3 bg-nature-900/80 border border-nature-700/80 rounded-2xl flex flex-wrap items-center justify-between gap-2">
                                                <p className="text-nature-200 m-0 break-words min-w-0">
                                                    A phone asked at {askedAt(p.proposedAt)} · key{' '}
                                                    <span className="font-mono">{p.newPubkey.slice(0, 6)}…</span>
                                                </p>
                                                <button
                                                    type="button"
                                                    disabled={busy || declining !== null}
                                                    onClick={() => decline(p.newPubkey)}
                                                    className="shrink-0 px-3 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-nature-200 text-xs font-semibold"
                                                >
                                                    {declining === p.newPubkey ? 'Declining…' : 'Not theirs'}
                                                </button>
                                            </div>
                                        ))}
                                    </>
                                )}
                            </div>
                        )}
                        {!waiting ? (
                            <button type="button" onClick={() => { forgetCodeState(); setCode(null); setExpiresAt(null); setChecked(false); }} className="text-nature-400 underline">Make a new code</button>
                        ) : (
                            <button type="button" disabled={busy} onClick={cancel} className="text-nature-400 underline">Cancel this code</button>
                        )}
                    </div>
                )}
                <FreshProofBox proof={proof} testId="bring-back-proof" />
                {error && <p className="m-0 text-red-300 break-words" role="alert">{error}</p>}
            </div>
        </ModalBackdrop>
    );
}
