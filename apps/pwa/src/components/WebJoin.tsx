/**
 * Joining through the open door in a web browser: screens 0 to 4 of design G11 §2 (the lobby, "have you used
 * BeanPool before?", your name, the sign-in, GitHub's code, and the return). WelcomePage shows it on a node whose
 * door is open, and takes over again for the steps every new member has (photo, 12 words, tour) once `onJoined` says
 * the node has said yes. The logic is lib/web-join.ts; the key waits in identity.ts's pending slot.
 *
 * Self-contained on purpose: WelcomePage and App.tsx change again for the visitor lobby (G9), and these screens should
 * not have to move with them.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    clearUnsentPendingJoin,
    completePendingJoin,
    generateIdentity,
    lastSentAt,
    loadIdentity,
    loadPendingJoin,
    markPendingJoinSent,
    pendingJoinSent,
    releaseSentPendingJoin,
    savePendingJoin,
    IdentityHeldError,
    PendingJoinHeldError,
    PENDING_JOIN_RATE_LIMITED_TTL_MS,
    PENDING_JOIN_TTL_MS,
    SENT_JOIN_CAN_LAND_MS,
    type BeanPoolIdentity,
    type JoinProvider,
    type NodeRefusedJoin,
    type PendingJoin,
} from '../lib/identity';
import {
    browserCanHoldKey,
    captureAuthReturn,
    checkCallsign,
    checkSentJoin,
    consumeCapturedAuthReturn,
    doorRefusalMessage,
    DoorUnreachableError,
    joinBody,
    joinVerdict,
    matchAuthReturn,
    offeredProviders,
    pollGithubJoin,
    probeMembership,
    providerAuthUrl,
    providerLabel,
    refusalMessage,
    requestJoinNonce,
    runGithubPoll,
    sleep,
    startGithubJoin,
    submitJoin,
    MAX_JOIN_CALLSIGN,
    type AuthReturn,
    type CallsignCheck,
    type DoorOutcome,
    type GithubStart,
    type JoinNonce,
    type RedirectProvider,
    type SignInProof,
} from '../lib/web-join';
import { recoveryStored, sealJoinRecovery, type SealedJoinRecovery } from '../lib/join-recovery';

/** The node's word on the sign-in recovery copy a join carried (lib/join-recovery.ts). */
export interface JoinRecoveryResult {
    /** The node stored it: this sign-in also brings the account back. */
    enrolled: boolean;
    provider: JoinProvider;
}

export interface JoinedResult {
    /** The member's identity, now in this browser's identity slot, with the name the node gave it. */
    identity: BeanPoolIdentity;
    /** The name they asked for, when the node gave them another (it was taken). */
    requestedCallsign: string | null;
    /** The key was brought here (phone or 12 words), not made for this join. */
    restored: boolean;
    /**
     * Sign-in recovery enrolled with the join (G11-c): the sign-in it went with, and whether the node stored the copy
     * sealed to it (`enrolled`). Null when the node said nothing about one: none went, or the answer that let the
     * member in was not the join's own (the node was asked afterwards).
     */
    recovery: JoinRecoveryResult | null;
    /**
     * A key brought here (`restored`) was waiting while a join this browser sent earlier was asked about, and that join
     * had landed: this identity is that join's, and the key brought here was not added.
     */
    earlierJoinKept: boolean;
}

interface Props {
    /** The node has said yes; the identity is saved. */
    onJoined: (result: JoinedResult) => void;
    /** "I use BeanPool on my phone" / "I have my 12 words": WelcomePage's own restore screens. */
    onRestore: (how: 'phone' | 'words') => void;
    /** A key restored here that is not a member of this community yet: it goes through the door as it is. */
    restored?: BeanPoolIdentity | null;
    /**
     * The door isn't open: WelcomePage shows these screens only to settle a join that went out from this browser
     * (review 4106962311). Nothing is sent from here. The node is asked about that join; a member is in, and once the
     * node says it never landed and can no longer land, `onSettled` hands the page back.
     */
    settleOnly?: boolean;
    /** settleOnly: the sent join (this key, this latest sentAt) never landed and can't now; null when none was stored. */
    onSettled?: (cleared: { publicKey: string; sentAt: number } | null) => void;
    /** This browser already holds another account (saved from another tab, say): open it. Reloads the page if unset. */
    onExisting?: (identity: BeanPoolIdentity) => void;
    /** Reloads the page. Swappable in tests. */
    reload?: () => void;
    /** Leaves the page for the provider. Swappable in tests. */
    navigate?: (url: string) => void;
    /** This web app's origin, for the return URL. Swappable in tests. */
    origin?: string;
    /** Tests only: a captured return, in place of this page's URL. */
    authReturn?: AuthReturn | null;
}

type Screen =
    | { name: 'loading' }
    | { name: 'lobby' }
    | { name: 'guard' }
    | { name: 'restore' }
    | { name: 'name' }
    | { name: 'providers' }
    | { name: 'github'; start: GithubStart }
    /** `securing`: the sign-in recovery copy is being made (lib/join-recovery.ts), before the join goes. */
    | { name: 'joining'; securing?: boolean }
    | { name: 'unknown'; checking: boolean }
    | { name: 'checking'; checking: boolean }
    /**
     * A key restored here while a sent join holds the one pending slot: `canLand`, that join may still go through
     * (until `until`); otherwise the node says it is not a member and it can no longer land, and the member may let it
     * go ('abandon') for the restored key.
     */
    | { name: 'held'; canLand: boolean; until: number }
    | { name: 'abandon'; until: number }
    | { name: 'unavailable'; message: string }
    | { name: 'already_joined'; message: string }
    /**
     * This browser already holds `held`, saved from another tab or window while this page was open, and nothing here
     * replaces it. `joined`: what became of this page's key (`pending`): no join went with it ('none', and it was let
     * go), the node took it ('member'), or one went and may have landed ('maybe'). Either of those two is kept here.
     */
    | { name: 'taken'; held: BeanPoolIdentity; joined: 'none' | 'member' | 'maybe' }
    /** Something could not be saved or finished: the notice says what, and Reload is the way on. */
    | { name: 'failed' };

type Notice = { tone: 'error' | 'info'; text: string } | null;

const UNREACHABLE = "Can't reach the community right now. Try again in a minute.";
const WENT_WRONG = 'Something went wrong on this page. Reload it to try again.';
const WENT_WRONG_KEPT = "Something went wrong on this page before we could finish. Your join is kept on this device: reload the page and it will check whether you're in.";
/** A nonce lives ten minutes on the node; one older than this is fetched again before it is sent to a provider. */
const NONCE_FRESH_MS = 5 * 60 * 1000;
const TOO_OLD = 'This browser is too old to hold a BeanPool account. Try an up-to-date Chrome, Firefox, Safari or Edge.';

/** A key restored just now, as a pending join of its own. */
function restoredPending(r: BeanPoolIdentity): PendingJoin {
    const now = Date.now();
    return { identity: r, provider: null, nonce: null, startedAt: now, expiresAt: now + PENDING_JOIN_TTL_MS, restored: true };
}

/**
 * The account this browser holds, when it is not the key `p` holds: another tab or window saved it after this page
 * opened (App shows this page only to a browser with none). Asked before a key is made, a sign-in starts or a join
 * goes, so a second tab never makes a second member (review 4106962020); completePendingJoin refuses the rest.
 */
async function accountHeldElsewhere(p: PendingJoin | null): Promise<BeanPoolIdentity | null> {
    const held = await loadIdentity();
    return held?.publicKey && held.publicKey !== p?.identity.publicKey ? held : null;
}

const primaryButton: React.CSSProperties = {
    width: '100%', padding: '0.85rem 0.5rem', borderRadius: '10px', border: 'none',
    background: '#2563eb', color: '#fff', fontSize: '1rem', fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit', marginBottom: '0.75rem',
};

const secondaryButton: React.CSSProperties = {
    width: '100%', padding: '0.8rem 0.5rem', borderRadius: '10px',
    border: '1px solid var(--border-primary, #334155)', background: 'transparent',
    color: 'var(--text-primary)', fontSize: '0.95rem', fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit', marginBottom: '0.75rem',
};

const quietButton: React.CSSProperties = {
    background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.85rem',
    cursor: 'pointer', marginTop: '0.5rem', fontFamily: 'inherit', padding: '0.25rem',
};

const heading: React.CSSProperties = { fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.5rem' };
const lede: React.CSSProperties = { color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1.25rem', lineHeight: 1.5 };

function NoticeLine({ notice }: { notice: Notice }) {
    if (!notice) return null;
    return notice.tone === 'error' ? (
        <div role="alert" data-testid="join-notice"
            className="bg-red-50 dark:bg-red-950/40 border border-red-300 dark:border-red-700 text-red-800 dark:text-red-300 p-2.5 rounded-xl text-xs mb-4 text-center leading-relaxed font-medium">
            {notice.text}
        </div>
    ) : (
        <p role="status" data-testid="join-notice" style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1rem', lineHeight: 1.5 }}>
            {notice.text}
        </p>
    );
}

export function WebJoin({ onJoined, onRestore, restored = null, settleOnly = false, onSettled, onExisting, reload, navigate, origin, authReturn }: Props) {
    const [screen, setScreen] = useState<Screen>({ name: 'loading' });
    const [showWords, setShowWords] = useState(false);
    const [notice, setNotice] = useState<Notice>(null);
    const [pending, setPending] = useState<PendingJoin | null>(null);
    const [name, setName] = useState('');
    const [nameCheck, setNameCheck] = useState<CallsignCheck | null>(null);
    const [busy, setBusy] = useState(false);
    const [canHoldKey, setCanHoldKey] = useState<boolean | null>(null);
    const [nonceHeld, setNonceHeld] = useState<{ value: JoinNonce; at: number } | null>(null);
    const nonce = nonceHeld?.value ?? null;
    const [nonceProblem, setNonceProblem] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    // The last join sent, kept in memory only: a 503 is retried with the same sign-in (the node did not spend it).
    const lastJoin = useRef<{ pending: PendingJoin; proof: SignInProof } | null>(null);
    // The sign-in recovery copy made for that sign-in and key, so a retry sends the same join without sealing again.
    const lastSealed = useRef<{ proof: SignInProof; publicKey: string; recovery: SealedJoinRecovery | null } | null>(null);
    const mounted = useRef(true);
    // Set on every mount: React's StrictMode (main.tsx) runs this effect, its cleanup, and the effect again.
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    // Held in a ref so every callback below stays the same function for the life of the screens: a parent re-render
    // must not restart the GitHub wait or ask for another nonce.
    const onJoinedRef = useRef(onJoined);
    onJoinedRef.current = onJoined;
    const settleOnlyRef = useRef(settleOnly);
    settleOnlyRef.current = settleOnly;
    const onSettledRef = useRef(onSettled);
    onSettledRef.current = onSettled;
    // A join with this page's key has gone (from here or before this page opened): what a failure says depends on it.
    const joinWent = useRef(false);

    const go = navigate ?? ((url: string) => window.location.assign(url));
    const here = origin ?? window.location.origin;
    const reloadPage = reload ?? (() => window.location.reload());

    // ---------- when something can't be finished ----------

    /**
     * Said, with Reload (review 4106962149): never "Joining…" with nothing to press. Whatever failed, a sent join's key
     * is still stored marked sent (identity.ts), so the reload asks the node about it.
     */
    const failed = useCallback((e: unknown) => {
        console.error('[WebJoin] could not finish:', e);
        if (!mounted.current) return;
        setBusy(false);
        if (!joinWent.current && !settleOnlyRef.current) {
            // Nothing has gone: the lobby, which starts again from the top, says so.
            setNotice({ tone: 'error', text: WENT_WRONG });
            setScreen({ name: 'lobby' });
            return;
        }
        setNotice({ tone: 'error', text: joinWent.current ? WENT_WRONG_KEPT : WENT_WRONG });
        setScreen({ name: 'failed' });
    }, []);

    /** Every step after a join has gone runs through this, from a GitHub wait, a Try again or the return: none is left to fail unseen. */
    const afterJoin = useCallback((step: () => Promise<unknown>) => {
        step().catch(failed);
    }, [failed]);

    /**
     * This browser holds another account, saved from another tab or window while this page was open: nothing here
     * replaces it (identity.ts, review 4106962020). This page's key, `p`, is let go if no join went with it (it was made
     * for this join, or brought here and is still where it came from). If one went, it stays here, marked sent: `joined`
     * (the node said yes) or maybe, and the member is told, with its 12 words to hand.
     */
    const showTaken = useCallback(async (held: BeanPoolIdentity, p: PendingJoin | null, joined: boolean) => {
        let kept: PendingJoin | null = joined ? p : null;
        if (p && !joined) {
            try {
                kept = await clearUnsentPendingJoin(p.identity.publicKey);
            } catch (e) {
                // Nothing was cleared: an unsent key stays until its clock drops it, a sent one as it is.
                console.error('[WebJoin] could not let the unsent key go:', e);
                kept = pendingJoinSent(p) ? p : null;
            }
        }
        if (!mounted.current) return;
        lastJoin.current = null;
        setPending(kept);
        setShowWords(false);
        setBusy(false);
        setNotice(null);
        setScreen({ name: 'taken', held, joined: joined ? 'member' : kept ? 'maybe' : 'none' });
    }, []);

    // ---------- the node's answer to a join ----------

    const finish = useCallback(async (p: PendingJoin, nodeCallsign: string | null, recovery: JoinRecoveryResult | null, earlierJoinKept = false) => {
        const identity = { ...p.identity, callsign: nodeCallsign || p.identity.callsign };
        try {
            await completePendingJoin(identity);
        } catch (e) {
            // The node has the member; this browser did not keep the key as its identity. The pending join still holds
            // it (the move is one transaction), marked sent, so no clock drops it. One that was not marked yet (a
            // restored key the nonce request found a member) is marked now, if this browser can still write at all.
            if (!pendingJoinSent(p)) await markPendingJoinSent(p).catch(() => {});
            if (e instanceof IdentityHeldError) return showTaken(e.held, { ...p, identity }, true);
            // A reload finds it, asks the node, and is told "a member".
            console.error('[WebJoin] joined, but the identity could not be saved:', e);
            setNotice({ tone: 'error', text: "You're in, but this browser couldn't save your account. Reload the page to finish." });
            setScreen({ name: 'failed' });
            return;
        }
        lastJoin.current = null;
        onJoinedRef.current({
            identity,
            requestedCallsign: nodeCallsign && nodeCallsign !== p.identity.callsign ? p.identity.callsign : null,
            restored: p.restored,
            recovery,
            earlierJoinKept,
        });
    }, [showTaken]);

    /** Back to the sign-in buttons with the same key, saying why. */
    const toProviders = useCallback((p: PendingJoin, n: Notice) => {
        setPending(p);
        setNotice(n);
        setScreen({ name: 'providers' });
    }, []);

    // Declared before use through a ref, because an expired sign-in retries itself through the same path a tap takes.
    const signInRef = useRef<(p: PendingJoin, provider: JoinProvider, fresh?: JoinNonce | null) => Promise<void>>(async () => {});

    /**
     * Keep `p` and show it. identity.ts keeps a sent mark it finds stored for this key, whatever `p` says, and this
     * page shows what was stored.
     */
    const keep = useCallback(async (p: PendingJoin): Promise<PendingJoin> => {
        const stored = await savePendingJoin(p);
        setPending(stored);
        return stored;
    }, []);

    /**
     * What the member sees after an answer that did not let them in. `p` is the pending join as it now stands: unsent
     * only when the node has confirmed it (settleAnswer), and otherwise still sent. Nothing here can change that:
     * `keep` keeps a stored mark, and clearUnsentPendingJoin never deletes a sent pending join.
     */
    const showOutcome = useCallback(async (outcome: DoorOutcome, p: PendingJoin, proof: SignInProof) => {
        switch (outcome.kind) {
            case 'joined':
            case 'already_member':
                // joinVerdict takes these as a yes before they get here.
                setScreen({ name: 'unknown', checking: false });
                return;
            case 'already_joined': {
                // One sign-in account, one identity: this key is not needed, and must not linger as a second one. The
                // node answers this only for a key that is not a member (a member's gets already_member).
                const kept = await clearUnsentPendingJoin(p.identity.publicKey);
                setPending(kept);
                setScreen({ name: 'already_joined', message: outcome.message });
                return;
            }
            case 'expired': {
                if (!p.retriedExpired) {
                    // Once, by itself, with a fresh nonce: most often somebody took longer than ten minutes.
                    const next = await keep({ ...p, retriedExpired: true });
                    setNotice({ tone: 'info', text: outcome.message });
                    return signInRef.current(next, proof.provider, null);
                }
                const next = await keep({ ...p, nonce: null });
                return toProviders(next, { tone: 'error', text: outcome.message });
            }
            case 'rate_limited': {
                // Kept for an hour, so trying again later uses this key rather than making a second one.
                const next = await keep({ ...p, nonce: null, expiresAt: Date.now() + PENDING_JOIN_RATE_LIMITED_TTL_MS });
                return toProviders(next, { tone: 'error', text: outcome.message });
            }
            case 'unavailable':
                setPending(p);
                setScreen({ name: 'unavailable', message: outcome.message });
                return;
            case 'door_closed': {
                const kept = await clearUnsentPendingJoin(p.identity.publicKey);
                setPending(kept);
                setNotice({ tone: 'error', text: outcome.message });
                setScreen({ name: 'lobby' });
                return;
            }
            case 'refused': {
                const next = await keep({ ...p, nonce: null });
                return toProviders(next, { tone: 'error', text: outcome.message });
            }
        }
    }, [keep, toProviders]);

    /**
     * Any answer but a yes: the node is asked, signed by this key, before anything else happens to it (a 5xx, a lost
     * or garbled answer, or a refusal from something in front of the node can all come after it took the member). A
     * member is in. Otherwise the key keeps its sent mark unless the door refused this join definitely (`refusal`) and
     * the node now says the key is not a member: releaseSentPendingJoin checks both against what is stored.
     */
    const settleAnswer = useCallback(async (p: PendingJoin, proof: SignInProof, refusal: NodeRefusedJoin | null, outcome: DoorOutcome | null) => {
        lastJoin.current = { pending: p, proof };
        setScreen(refusal ? { name: 'joining' } : { name: 'unknown', checking: true });
        const probe = await probeMembership(p.identity);
        if (probe.kind === 'member') return finish(p, probe.callsign, null);
        let now = p;
        if (refusal && probe.kind === 'not_member') {
            const r = await releaseSentPendingJoin({ kind: 'refused', refusal, notMember: probe.answer });
            if (r.pending?.identity.publicKey === p.identity.publicKey) now = r.pending;
        }
        lastJoin.current = { pending: now, proof };
        if (!mounted.current) return;
        if (!outcome) {
            setPending(now);
            setScreen({ name: 'unknown', checking: false });
            return;
        }
        return showOutcome(outcome, now, proof);
    }, [finish, showOutcome]);

    const submit = useCallback(async (p: PendingJoin, proof: SignInProof) => {
        setNotice(null);
        // The sign-in also becomes this account's way back (G11-c, lib/join-recovery.ts): the key and its words sealed
        // to it, in the join. Made before anything is written or sent, from the key and words `p` already holds, so
        // nothing about the pending join waits on it; a seal that fails is null, and the join goes without a copy. A
        // retry of the same sign-in with the same key sends the copy already made.
        const made = lastSealed.current;
        let sealed: SealedJoinRecovery | null;
        if (made && made.proof === proof && made.publicKey === p.identity.publicKey) {
            sealed = made.recovery;
            setScreen({ name: 'joining' });
        } else {
            setScreen({ name: 'joining', securing: true });
            sealed = await sealJoinRecovery(p.identity, proof.provider, proof.sub);
            lastSealed.current = { proof, publicKey: p.identity.publicKey, recovery: sealed };
            if (mounted.current) setScreen({ name: 'joining' });
        }

        /** Send the join once, with the copy or without it. */
        const send = async (from: PendingJoin, recovery: SealedJoinRecovery | null): Promise<void> => {
            // Another tab saved an account here while this one was at the sign-in: nothing is sent (one browser, one account).
            const held = await accountHeldElsewhere(from);
            if (held) return showTaken(held, from, false);
            // Marked sent BEFORE it goes, and not sent if that cannot be written: once the node has the join, the answer
            // can be lost, and this record may be the only copy of a member's key. The nonce is on its way to the node;
            // the page never offers it again.
            let sent: PendingJoin;
            try {
                sent = await markPendingJoinSent({ ...from, nonce: null });
            } catch (e) {
                console.error('[WebJoin] the join could not be marked sent, so it was not sent:', e);
                return toProviders(from, {
                    tone: 'error',
                    text: e instanceof PendingJoinHeldError
                        ? 'An earlier join from this browser is still being checked. Reload the page to finish it.'
                        : "This browser couldn't save your account, so nothing was sent. Try again, or try another browser.",
                });
            }
            joinWent.current = true;
            setPending(sent);
            lastJoin.current = { pending: sent, proof };
            const body = joinBody(sent.identity.callsign, proof, recovery ? { shares: recovery.shares } : undefined);
            let answer;
            try {
                answer = await submitJoin(sent.identity, body);
            } catch (e) {
                if (e instanceof DoorUnreachableError) return settleAnswer(sent, proof, null, null);
                throw e;
            }
            const verdict = joinVerdict(answer, sent, proof.provider);
            // The node could not read the copy, and said so before it checked the sign-in or wrote anything (400
            // `recovery_invalid`: the nonce is not spent). The same join goes again without it, once, through the same
            // sent mark: a copy is never what keeps somebody out.
            if (recovery && verdict.kind === 'refused' && verdict.refusal.code === 'recovery_invalid') {
                console.warn('[WebJoin] the community could not read the sign-in recovery copy; joining without it');
                lastSealed.current = { proof, publicKey: sent.identity.publicKey, recovery: null };
                return send(sent, null);
            }
            if (verdict.kind === 'joined' && recovery && !recoveryStored(verdict.recovery)) {
                // In, without the copy: the words are the way back, and Settings will say not connected. Why, for a log.
                const said = (verdict.recovery as { error?: unknown } | null)?.error;
                console.warn(`[WebJoin] joined, but the community did not store the sign-in recovery copy: ${typeof said === 'string' ? said.slice(0, 200) : 'no reason given'}`);
            }
            switch (verdict.kind) {
                case 'joined': return finish(sent, verdict.callsign, verdict.recovery ? { enrolled: recoveryStored(verdict.recovery), provider: proof.provider } : null);
                case 'already_member': return finish(sent, null, null);
                case 'refused': return settleAnswer(sent, proof, verdict.refusal, verdict.outcome);
                case 'unknown': return settleAnswer(sent, proof, null, verdict.outcome);
            }
        };
        return send(p, sealed);
    }, [finish, settleAnswer, toProviders, showTaken]);

    /** Carry on with this pending join's key and name: the sign-in, or the name first when it has none. */
    const resume = useCallback((p: PendingJoin, n: Notice = null) => {
        setPending(p);
        setName(p.identity.callsign);
        setNotice(n);
        setScreen(p.identity.callsign.trim().length >= 2 ? { name: 'providers' } : { name: 'name' });
    }, []);

    /**
     * A join that went out before this page opened: only the node's word decides what becomes of its key (the
     * answer may have been lost after the node took the member). A member is in, and gets every step a new member
     * gets. Otherwise the key is kept, still marked sent, and signing in again carries on with it: a definite refusal
     * of that new join is what can let it go. A key restored just now cannot take the one pending slot from it: the
     * 'held' screen says whether it may still land, and once it cannot, lets the member choose to let it go.
     */
    const settleSent = useCallback(async (p: PendingJoin) => {
        joinWent.current = true;
        setPending(p);
        setName(p.identity.callsign);
        setNotice(null);
        setScreen({ name: 'checking', checking: true });
        const check = await checkSentJoin(p);
        if (!mounted.current) return;
        const replacing = restored && restored.publicKey !== p.identity.publicKey ? restored : null;
        switch (check.kind) {
            case 'member':
                return finish(p, check.callsign, null, !!replacing);
            case 'not_member':
            case 'may_still_land':
                if (settleOnlyRef.current) {
                    // The door isn't open, so nothing can be sent again from here. A join that can no longer land is
                    // settled: WelcomePage goes on, and its key stays kept as it is. One that still can, the member
                    // waits for, told how long (review 4106962311).
                    if (check.kind === 'not_member') {
                        onSettledRef.current?.({ publicKey: p.identity.publicKey, sentAt: lastSentAt(p) });
                        return;
                    }
                    setScreen({ name: 'held', canLand: true, until: lastSentAt(p) + SENT_JOIN_CAN_LAND_MS });
                    return;
                }
                if (replacing) {
                    setScreen({ name: 'held', canLand: check.kind === 'may_still_land', until: lastSentAt(p) + SENT_JOIN_CAN_LAND_MS });
                    return;
                }
                return resume(p, {
                    tone: 'info',
                    text: check.kind === 'may_still_land'
                        ? "Your join hasn't reached the community yet. Sign in again to finish."
                        : "Your join didn't reach the community. Sign in again to finish.",
                });
            case 'unknown':
                setScreen({ name: 'checking', checking: false });
                return;
        }
    }, [finish, resume, restored]);

    /**
     * "Check again" and "Try again" on a sent join: asked on the pending join as stored now, never this tab's copy.
     * Another tab may have sent it again since (a later join, which may still land) or settled it.
     */
    const checkAgain = useCallback(async () => {
        const p = await loadPendingJoin();
        if (!mounted.current) return;
        if (p && pendingJoinSent(p)) return settleSent(p);
        // Settled meanwhile, somewhere else: go on from what is stored.
        if (settleOnlyRef.current) {
            onSettledRef.current?.(null);
            return;
        }
        const held = await accountHeldElsewhere(p);
        if (held) return showTaken(held, p, false);
        if (p) return resume(p);
        setNotice(null);
        setScreen({ name: 'lobby' });
    }, [settleSent, showTaken, resume]);

    // ---------- starting a sign-in ----------

    const fetchNonce = useCallback(async (p: PendingJoin): Promise<JoinNonce | null> => {
        setNonceProblem(null);
        try {
            const got = await requestJoinNonce(p.identity);
            if ('nonce' in got) {
                if (mounted.current) setNonceHeld({ value: got.nonce, at: Date.now() });
                return got.nonce;
            }
            if (got.answer.status === 409 && got.answer.body.code === 'already_member') {
                // A restored key that is a member here already: nothing to join.
                await finish(p, null, null);
                return null;
            }
            if (mounted.current) setNonceProblem(doorRefusalMessage(got.answer));
        } catch (e) {
            // Said either way, with Try again beside it: never "Getting the sign-ins ready…" for good.
            if (!(e instanceof DoorUnreachableError)) console.error('[WebJoin] could not ask for a sign-in:', e);
            if (mounted.current) setNonceProblem(e instanceof DoorUnreachableError ? UNREACHABLE : WENT_WRONG);
        }
        return null;
    }, [finish]);

    const signIn = useCallback(async (
        p: PendingJoin,
        provider: JoinProvider,
        fresh: JoinNonce | null = nonceHeld && Date.now() - nonceHeld.at < NONCE_FRESH_MS ? nonceHeld.value : null,
    ) => {
        setBusy(true);
        try {
            const held = await accountHeldElsewhere(p);
            if (held) return await showTaken(held, p, false);
            if (provider === 'github') {
                let got;
                try {
                    got = await startGithubJoin(p.identity);
                } catch (e) {
                    if (!(e instanceof DoorUnreachableError)) throw e;
                    return toProviders(p, { tone: 'error', text: UNREACHABLE });
                }
                if ('answer' in got) return toProviders(p, { tone: 'error', text: doorRefusalMessage(got.answer) });
                await keep({ ...p, provider: 'github', nonce: null });
                setCopied(false);
                setScreen({ name: 'github', start: got.start });
                return;
            }
            // A nonce is single use and lives ten minutes: every trip to a provider takes a fresh one.
            const n = fresh ?? await fetchNonce(p);
            if (!n) {
                setScreen({ name: 'providers' });
                setPending(p);
                return;
            }
            const clientId = n.clientIds[provider];
            if (!clientId) return toProviders(p, { tone: 'error', text: `${providerLabel(provider)} sign-in isn't available here.` });
            const now = Date.now();
            const next: PendingJoin = {
                ...p,
                provider,
                nonce: n.nonce,
                startedAt: now,
                expiresAt: Math.max(p.expiresAt, now + PENDING_JOIN_TTL_MS),
            };
            await savePendingJoin(next);
            setNonceHeld(null); // spent: this one is on its way to the provider
            go(providerAuthUrl(provider as RedirectProvider, { clientId, origin: here, nonce: n.nonce }));
        } catch (e) {
            // A join with another key went out from this browser (another tab, say): that one is settled first.
            if (e instanceof PendingJoinHeldError) return settleSent(e.held);
            console.error('[WebJoin] could not start the sign-in:', e);
            toProviders(p, { tone: 'error', text: WENT_WRONG });
        } finally {
            if (mounted.current) setBusy(false);
        }
    }, [nonceHeld, fetchNonce, toProviders, keep, go, here, showTaken, settleSent]);
    signInRef.current = signIn;

    // ---------- where the page starts ----------

    useEffect(() => {
        let cancelled = false;
        browserCanHoldKey().then((ok) => { if (!cancelled) setCanHoldKey(ok); });
        (async () => {
            // Settling only: a sign-in that came back is not sent (the door isn't open), as WelcomePage drops one.
            const ret = settleOnlyRef.current ? null : authReturn !== undefined ? authReturn : captureAuthReturn();
            let p = await loadPendingJoin();
            if (cancelled) return;
            if (settleOnlyRef.current) {
                if (p && pendingJoinSent(p)) return settleSent(p);
                // Settled already (another tab, say): nothing to ask about.
                onSettledRef.current?.(null);
                return;
            }
            if (ret) {
                consumeCapturedAuthReturn();
                if (!p) {
                    // Nothing was started here, or it expired: whatever came back is not this page's to send.
                    setNotice({ tone: 'error', text: refusalMessage('no_pending', ret.provider) });
                    setScreen({ name: 'lobby' });
                    return;
                }
                const outcome = matchAuthReturn(ret, p);
                if (outcome.kind === 'token') {
                    const proof: SignInProof = { provider: outcome.provider, idToken: outcome.idToken, nonce: outcome.nonce, sub: outcome.sub };
                    setPending(p);
                    setName(p.identity.callsign);
                    return submit(p, proof);
                }
                // A foreign or unfinished return leaves the pending join as it was: it may still be this page's own.
                const text = outcome.kind === 'cancelled' ? 'Sign-in was cancelled.'
                    : outcome.kind === 'provider_error' ? outcome.message
                    : refusalMessage(outcome.reason, p.provider ?? ret.provider);
                setName(p.identity.callsign);
                return toProviders(p, { tone: outcome.kind === 'cancelled' ? 'info' : 'error', text });
            }
            // A join that went out: the node is asked before anything else happens to its key.
            if (p && pendingJoinSent(p)) return settleSent(p);
            // Another tab saved an account here since App opened this page: said now, before anything is started.
            const held = await accountHeldElsewhere(p);
            if (cancelled) return;
            if (held && held.publicKey !== restored?.publicKey) return showTaken(held, p, false);
            if (restored && p?.identity.publicKey !== restored.publicKey) {
                // A key restored just now wins over an older join left pending here that never went out.
                p = await savePendingJoin(restoredPending(restored));
                if (cancelled) return;
            }
            if (p) {
                // A reload, a closed tab, or a key restored here: carry on with the same key and name.
                resume(p);
                return;
            }
            setScreen({ name: 'lobby' });
        })().catch((e) => {
            if (cancelled) return;
            // Another tab sent a join with another key while this one was starting: that one is settled first.
            if (e instanceof PendingJoinHeldError) {
                afterJoin(() => settleSent(e.held));
                return;
            }
            // Before a join went, or after (the return's answer, then a write that failed): said, with Reload.
            failed(e);
        });
        return () => { cancelled = true; };
        // Once, on arrival: `restored` is fixed for the life of this component (WelcomePage remounts it to change it).
    }, []);

    // The sign-in screen asks for its nonce (and so which sign-ins to show) as it opens.
    useEffect(() => {
        if (screen.name !== 'providers' || !pending || nonce) return;
        void fetchNonce(pending);
    }, [screen.name, pending, nonce, fetchNonce]);

    // GitHub: wait for the code to be entered.
    useEffect(() => {
        if (screen.name !== 'github' || !pending) return;
        const start = screen.start;
        const controller = new AbortController();
        const p = pending;
        runGithubPoll({
            poll: () => pollGithubJoin(p.identity, start.sessionId),
            sleep,
            intervalSeconds: start.intervalSeconds,
            expiresAt: Date.now() + start.expiresInSeconds * 1000,
            signal: controller.signal,
        }).then((result) => {
            if (controller.signal.aborted) return;
            switch (result.status) {
                case 'ok':
                    // From here the join's own screens take over, and this wait's cleanup aborts: whatever fails in
                    // the join is caught there, never here (review 4106962149).
                    afterJoin(() => submit(p, { provider: 'github', sessionId: start.sessionId, sub: result.sub }));
                    return;
                case 'denied':
                    return toProviders(p, { tone: 'error', text: 'GitHub said no. Try again, or choose another way.' });
                case 'expired':
                    return toProviders(p, { tone: 'error', text: 'That GitHub code expired. Choose GitHub again for a new one.' });
                case 'failed':
                    return toProviders(p, { tone: 'error', text: doorRefusalMessage(result.answer) });
            }
        }).catch((e) => {
            console.error('[WebJoin] GitHub wait failed:', e);
            if (!controller.signal.aborted) toProviders(p, { tone: 'error', text: UNREACHABLE });
        });
        return () => controller.abort();
    }, [screen, pending, submit, toProviders, afterJoin]);

    // ---------- the screens' actions ----------

    async function chooseName() {
        const trimmed = name.trim().slice(0, MAX_JOIN_CALLSIGN).trim();
        if (trimmed.length < 2) {
            setNotice({ tone: 'error', text: 'Please choose a name of at least 2 letters.' });
            return;
        }
        setBusy(true);
        setNotice(null);
        try {
            // Another tab saved an account here since this page opened: no key is made for a second one.
            const held = await accountHeldElsewhere(pending);
            if (held) return await showTaken(held, pending, false);
            const now = Date.now();
            // Going back to change the name keeps the key already made: one person, one key.
            const identity = pending ? { ...pending.identity, callsign: trimmed } : await generateIdentity(trimmed);
            const next: PendingJoin = pending
                ? { ...pending, identity }
                : { identity, provider: null, nonce: null, startedAt: now, expiresAt: now + PENDING_JOIN_TTL_MS, restored: false };
            await keep(next);
            setScreen({ name: 'providers' });
        } catch (e) {
            if (e instanceof PendingJoinHeldError) {
                // A join with another key went out from this browser (another tab, say): that one comes first.
                setBusy(false);
                return settleSent(e.held);
            }
            console.error('[WebJoin] could not make a key:', e);
            setNotice({ tone: 'error', text: 'This browser could not make your key. Try again, or try another browser.' });
        } finally {
            setBusy(false);
        }
    }

    // Live "is this name free?" on the name screen. Never blocks: the node lands a taken name on a free variant.
    useEffect(() => {
        if (screen.name !== 'name') return;
        const trimmed = name.trim();
        setNameCheck(null);
        if (trimmed.length < 2) return;
        let cancelled = false;
        const t = setTimeout(() => {
            checkCallsign(trimmed).then((r) => { if (!cancelled) setNameCheck(r); });
        }, 400);
        return () => { cancelled = true; clearTimeout(t); };
    }, [name, screen.name]);

    async function startOver() {
        const p = pending;
        setBusy(true);
        try {
            // Back past the name, before any sign-in worked: the key made for this join is dropped, never kept as a
            // spare. Unless a join with it has gone (from this tab or another: the store says, not this tab's copy),
            // in which case it is kept, and the node is asked whether it is in.
            const kept = p ? await clearUnsentPendingJoin(p.identity.publicKey) : null;
            if (!mounted.current) return;
            if (kept) {
                const check = await checkSentJoin(kept);
                if (!mounted.current) return;
                if (check.kind === 'member') return finish(kept, check.callsign, null);
                // Kept, and joining from here carries on with the same key.
                setPending(kept);
                setName(kept.identity.callsign);
                setNotice(null);
                setScreen({ name: 'guard' });
                return;
            }
            setPending(null);
            setNonceHeld(null);
            setName('');
            setNotice(null);
            setScreen({ name: 'guard' });
        } catch (e) {
            console.error('[WebJoin] could not go back:', e);
            setNotice({ tone: 'error', text: 'Something went wrong on this page. Reload it to try again.' });
        } finally {
            if (mounted.current) setBusy(false);
        }
    }

    /**
     * The member chose, on the 'abandon' screen, to let go of a sent join the node says it never took, for the key they
     * restored. Only that record goes (the key and sentAt they were shown); if another tab has sent it again since, it
     * is checked again instead.
     */
    async function abandonHeld() {
        const p = pending;
        if (!p || !restored) return;
        setBusy(true);
        try {
            const out = await releaseSentPendingJoin({ kind: 'abandoned', publicKey: p.identity.publicKey, sentAt: p.sentAt });
            if (!mounted.current) return;
            if (!out.released) {
                if (out.pending) return settleSent(out.pending);
                setScreen({ name: 'lobby' });
                return;
            }
            resume(await savePendingJoin(restoredPending(restored)));
        } catch (e) {
            if (e instanceof PendingJoinHeldError) return settleSent(e.held);
            console.error('[WebJoin] could not let the earlier join go:', e);
            setNotice({ tone: 'error', text: 'Something went wrong on this page. Reload it to try again.' });
        } finally {
            if (mounted.current) setBusy(false);
        }
    }

    async function copyCode(code: string) {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
        } catch {
            setCopied(false);
        }
    }

    /**
     * "Try again" after no answer, an answer that said nothing sure, or a 5xx: ask the node first. The last join may
     * have landed after all, and a join sent again would be answered about the door and the rate limit before the
     * member table (open-join.ts), which says nothing about the last one. Only a node that says "not a member" is sent
     * the same sign-in again; one that cannot be asked is not.
     */
    async function retryLastJoin() {
        const last = lastJoin.current;
        if (!last) return;
        setScreen({ name: 'unknown', checking: true });
        const probe = await probeMembership(last.pending.identity);
        if (!mounted.current) return;
        if (probe.kind === 'member') return finish(last.pending, probe.callsign, null);
        if (probe.kind === 'unknown') {
            setScreen({ name: 'unknown', checking: false });
            return;
        }
        return submit(last.pending, last.proof);
    }

    // ---------- drawing ----------

    const offered = nonce ? offeredProviders(nonce) : [];
    const callsign = pending?.identity.callsign ?? '';

    let body: React.ReactNode;
    switch (screen.name) {
        case 'loading':
            body = <p role="status" style={lede}>One moment…</p>;
            break;

        case 'lobby':
            body = (
                <>
                    <h3 style={heading}>Join BeanPool</h3>
                    <p style={lede}>
                        Post what you can offer and what you need, and talk with the people here.
                        It takes a name and one sign-in. No invite needed.
                    </p>
                    <NoticeLine notice={notice} />
                    {canHoldKey === false ? (
                        <p role="alert" data-testid="join-too-old" style={{ ...lede, color: 'var(--text-primary)' }}>{TOO_OLD}</p>
                    ) : (
                        <button type="button" data-testid="join-start" style={primaryButton} disabled={canHoldKey === null}
                            onClick={() => { setNotice(null); setScreen({ name: 'guard' }); }}>
                            Join
                        </button>
                    )}
                    <button type="button" style={quietButton} onClick={() => { setNotice(null); setScreen({ name: 'restore' }); }}>
                        Already have BeanPool?
                    </button>
                </>
            );
            break;

        case 'guard':
            // Asked once, before a key is made: two keys made separately can never be merged into one account.
            body = (
                <>
                    <h3 style={heading}>Have you used BeanPool before?</h3>
                    <p style={lede}>One person, one account. If you already have one, bring it here instead of making another.</p>
                    <button type="button" data-testid="join-new" style={primaryButton} onClick={() => { setNotice(null); setScreen({ name: 'name' }); }}>
                        I'm new to BeanPool
                    </button>
                    <button type="button" style={secondaryButton} onClick={() => onRestore('phone')}>
                        I use BeanPool on my phone
                    </button>
                    <button type="button" style={secondaryButton} onClick={() => onRestore('words')}>
                        I have my 12 words
                    </button>
                    <button type="button" style={quietButton} onClick={() => setScreen({ name: 'lobby' })}>← Back</button>
                </>
            );
            break;

        case 'restore':
            body = (
                <>
                    <h3 style={heading}>Bring your account here</h3>
                    <p style={lede}>Use the phone app, or your 12 words.</p>
                    <button type="button" style={secondaryButton} onClick={() => onRestore('phone')}>
                        Link with my phone
                    </button>
                    <button type="button" style={secondaryButton} onClick={() => onRestore('words')}>
                        Use my 12 words
                    </button>
                    <button type="button" style={quietButton} onClick={() => setScreen({ name: 'lobby' })}>← Back</button>
                </>
            );
            break;

        case 'name': {
            const trimmed = name.trim();
            body = (
                <>
                    <h3 style={heading}>What should we call you?</h3>
                    <p style={lede}>The name people here will see. At least 2 letters.</p>
                    <label htmlFor="join-callsign" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
                        Your name
                    </label>
                    <input
                        id="join-callsign"
                        data-testid="join-callsign"
                        type="text"
                        value={name}
                        maxLength={MAX_JOIN_CALLSIGN}
                        autoComplete="nickname"
                        placeholder="e.g. Alice"
                        disabled={busy}
                        onChange={(e) => { setName(e.target.value); setNotice(null); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') void chooseName(); }}
                        style={{
                            width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '0.75rem 1rem', borderRadius: '10px',
                            border: '1px solid var(--border-input)', background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)', fontSize: '1rem', fontFamily: 'inherit', outline: 'none',
                            marginBottom: '0.5rem',
                        }}
                    />
                    <p role="status" style={{ fontSize: '0.8rem', minHeight: '1.2em', marginBottom: '0.75rem', textAlign: 'left', color: 'var(--text-muted)' }}>
                        {trimmed.length >= 2 && nameCheck === 'available' && '✓ Available'}
                        {trimmed.length >= 2 && nameCheck === 'taken' && `Someone here is already called ${trimmed}. You can keep it (we'll add a number) or choose another.`}
                    </p>
                    <NoticeLine notice={notice} />
                    <button type="button" data-testid="join-name-next" style={primaryButton} disabled={busy} onClick={() => void chooseName()}>
                        {busy ? 'One moment…' : 'Next →'}
                    </button>
                    <button type="button" style={quietButton} disabled={busy} onClick={() => void startOver()}>
                        ← Back
                    </button>
                </>
            );
            break;
        }

        case 'providers':
            body = (
                <>
                    <h3 style={heading}>Prove you're a person</h3>
                    <p style={lede}>One sign-in, once. After this your 12 words are your account everywhere.</p>
                    <p style={{ fontSize: '0.85rem', marginBottom: '1rem' }}>
                        Joining as <strong data-testid="join-as">{callsign}</strong>
                    </p>
                    <NoticeLine notice={notice} />
                    {nonceProblem ? (
                        <>
                            <p role="alert" data-testid="join-nonce-problem" style={{ ...lede, color: 'var(--text-primary)' }}>{nonceProblem}</p>
                            <button type="button" style={secondaryButton} onClick={() => pending && void fetchNonce(pending)}>Try again</button>
                        </>
                    ) : !nonce ? (
                        <p role="status" style={lede}>Getting the sign-ins ready…</p>
                    ) : offered.length === 0 ? (
                        <p role="alert" style={lede}>This community has no sign-in a browser can use yet.</p>
                    ) : (
                        <>
                            <p style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Sign in with</p>
                            {offered.map((provider) => (
                                <button key={provider} type="button" data-testid={`join-provider-${provider}`} style={secondaryButton}
                                    disabled={busy || !pending} onClick={() => pending && void signIn(pending, provider)}>
                                    {providerLabel(provider)}
                                </button>
                            ))}
                        </>
                    )}
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', lineHeight: 1.5, marginTop: '0.5rem' }}>
                        Why a sign-in? It stops one person making many accounts. We keep only a scrambled reference to it,
                        never your email or name from there.
                    </p>
                    <button type="button" style={quietButton} onClick={() => { setNotice(null); setScreen({ name: 'name' }); }}>
                        ← Change name
                    </button>
                </>
            );
            break;

        case 'github': {
            const { start } = screen;
            body = (
                <>
                    <h3 style={heading}>Your GitHub code</h3>
                    <p style={lede}>Enter this code at GitHub, then come back here. We'll notice.</p>
                    <p data-testid="join-github-code" style={{
                        fontFamily: 'monospace', fontSize: 'min(1.4rem, 7.5vw)', fontWeight: 800, letterSpacing: '0.08em',
                        margin: '0 0 0.75rem', overflowWrap: 'anywhere',
                    }}>
                        {start.userCode}
                    </p>
                    <button type="button" style={secondaryButton} onClick={() => void copyCode(start.userCode)}>
                        {copied ? 'Copied ✓' : 'Copy code'}
                    </button>
                    <a href={start.verificationUri} target="_blank" rel="noopener noreferrer" data-testid="join-github-link"
                        style={{ ...primaryButton, display: 'block', textDecoration: 'none', boxSizing: 'border-box' }}>
                        Open GitHub
                    </a>
                    <p role="status" style={{ ...lede, marginBottom: '0.5rem' }}>Waiting for GitHub…</p>
                    <button type="button" style={quietButton} onClick={() => pending && toProviders(pending, null)}>← Choose another way</button>
                </>
            );
            break;
        }

        case 'joining':
            body = (
                <p role="status" data-testid="join-joining" style={{ ...lede, color: 'var(--text-primary)', fontWeight: 600 }}>
                    {screen.securing ? 'Securing your account…' : <>Joining as {callsign}…</>}
                </p>
            );
            break;

        case 'unknown':
            body = screen.checking ? (
                <p role="status" data-testid="join-unknown" style={lede}>We can't tell if that worked. Checking…</p>
            ) : (
                <>
                    <p role="alert" data-testid="join-unknown" style={{ ...lede, color: 'var(--text-primary)' }}>
                        We can't tell if that worked, and you're not in yet. Check your connection, then try again.
                    </p>
                    <button type="button" style={primaryButton} onClick={() => afterJoin(retryLastJoin)}>Try again</button>
                    {/* The same key, kept: if the join did land, the next nonce request answers "already a member". */}
                    <button type="button" style={quietButton} onClick={() => pending && toProviders(pending, null)}>← Choose another way</button>
                </>
            );
            break;

        case 'checking':
            body = screen.checking ? (
                <p role="status" data-testid="join-checking" style={lede}>Checking whether you've joined as {callsign}…</p>
            ) : (
                <>
                    <p role="alert" data-testid="join-checking" style={{ ...lede, color: 'var(--text-primary)' }}>
                        We can't tell yet whether you joined as {callsign}. Your account is kept on this device. Check your
                        connection, then try again.
                    </p>
                    <button type="button" style={primaryButton} onClick={() => afterJoin(checkAgain)}>Try again</button>
                    {/* Kept either way: from the lobby, joining again carries on with this same key. Settling only, there is
                        no lobby: the door isn't open, and nothing else here may run until the node has answered. */}
                    {!settleOnly && (
                        <button type="button" style={quietButton} onClick={() => { setNotice(null); setScreen({ name: 'lobby' }); }}>← Back</button>
                    )}
                </>
            );
            break;

        case 'held': {
            const minutes = Math.max(1, Math.ceil((screen.until - Date.now()) / 60_000));
            const brought = restored?.callsign.trim() || null;
            const wait = `Wait about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, then check again`;
            body = (
                <>
                    <h3 style={heading}>{screen.canLand ? 'Your earlier join may still go through' : "Your earlier join didn't go through"}</h3>
                    {screen.canLand ? (
                        <p role="alert" data-testid="join-held" style={{ ...lede, color: 'var(--text-primary)' }}>
                            This browser started joining as {callsign}, and that join may still go through, so its account is
                            kept here for now. {settleOnly ? `${wait}.` : `${wait}, or go back and finish joining as ${callsign}.`}
                        </p>
                    ) : (
                        <p role="alert" data-testid="join-held" style={{ ...lede, color: 'var(--text-primary)' }}>
                            The community says {callsign} isn't a member, and that earlier join can no longer go through. To
                            join as {brought ?? 'the account you brought here'}, this browser has to let go of it first. Or
                            finish joining as {callsign} instead.
                        </p>
                    )}
                    {screen.canLand ? (
                        <button type="button" style={primaryButton} onClick={() => afterJoin(checkAgain)}>Check again</button>
                    ) : (
                        <button type="button" style={primaryButton} onClick={() => setScreen({ name: 'abandon', until: screen.until })}>
                            {brought ? `Use ${brought} instead` : 'Use the account I brought here'}
                        </button>
                    )}
                    {/* Settling only, the door isn't open: there is no joining again from here, and no lobby to go back to. */}
                    {!settleOnly && (
                        <>
                            <button type="button" style={secondaryButton} onClick={() => pending && resume(pending)}>Finish joining as {callsign}</button>
                            <button type="button" style={quietButton} onClick={() => { setNotice(null); setScreen({ name: 'lobby' }); }}>← Back</button>
                        </>
                    )}
                </>
            );
            break;
        }

        case 'abandon':
            body = (
                <>
                    <h3 style={heading}>Let go of {callsign}?</h3>
                    <p role="alert" data-testid="join-abandon" style={{ ...lede, color: 'var(--text-primary)' }}>
                        This deletes {callsign}'s key and its 12 words from this browser for good. The community says it
                        never took that join, so no account there is lost, but this can't be undone.
                    </p>
                    <NoticeLine notice={notice} />
                    <button type="button" data-testid="join-abandon-confirm" disabled={busy} onClick={() => void abandonHeld()}
                        style={{ ...primaryButton, background: '#b91c1c' }}>
                        Let go of {callsign}
                    </button>
                    <button type="button" style={quietButton} disabled={busy}
                        onClick={() => setScreen({ name: 'held', canLand: false, until: screen.until })}>
                        ← Keep it
                    </button>
                </>
            );
            break;

        case 'unavailable':
            body = (
                <>
                    <p role="alert" data-testid="join-unavailable" style={{ ...lede, color: 'var(--text-primary)' }}>{screen.message}</p>
                    <button type="button" style={primaryButton} onClick={() => afterJoin(retryLastJoin)}>Try again</button>
                    <button type="button" style={quietButton} onClick={() => pending && toProviders({ ...pending }, null)}>← Choose another way</button>
                </>
            );
            break;

        case 'already_joined':
            body = (
                <>
                    <h3 style={heading}>You're already here</h3>
                    <p role="alert" data-testid="join-already-joined" style={{ ...lede, color: 'var(--text-primary)' }}>{screen.message}</p>
                    <button type="button" data-testid="join-restore-words" style={primaryButton} onClick={() => onRestore('words')}>
                        Restore with my 12 words
                    </button>
                    <button type="button" data-testid="join-restore-phone" style={secondaryButton} onClick={() => onRestore('phone')}>
                        Link with my phone
                    </button>
                    <button type="button" style={quietButton} onClick={() => setScreen({ name: 'lobby' })}>← Back</button>
                </>
            );
            break;

        case 'taken': {
            const heldName = screen.held.callsign.trim() || null;
            // This page's key: kept here when a join went with it, and then its 12 words are one tap away.
            const mine = pending?.identity.callsign.trim() || null;
            const words = screen.joined !== 'none' ? pending?.identity.mnemonic ?? null : null;
            const it = mine ?? 'that account';
            body = (
                <>
                    <h3 style={heading}>This browser already has an account</h3>
                    <p role="alert" data-testid="join-taken" style={{ ...lede, color: 'var(--text-primary)' }}>
                        {heldName ?? 'An account'} was saved in this browser from another tab or window while this page was
                        open. A browser holds one account, so it stays as it is.
                    </p>
                    {screen.joined === 'none' ? (
                        <p style={lede}>Nothing was sent from this page, so no second account was made.</p>
                    ) : (
                        <p style={{ ...lede, color: 'var(--text-primary)' }}>
                            {screen.joined === 'member'
                                ? `The community took ${it} too, so you have two accounts there now.`
                                : `The join from this page${mine ? `, as ${mine},` : ''} may have gone through too.`}
                            {` ${mine ?? 'Its'}${mine ? "'s" : ''} key is kept on this device. Write down its 12 words to keep it.`}
                            {` To use ${it} here instead, sign out of ${heldName ?? 'the other account'} in Settings, then restore ${it} with those words.`}
                        </p>
                    )}
                    {words && (showWords ? (
                        // As the Safety Backup step lays them out: as many columns as whole words fit (one on a 320px
                        // phone at 1.3x text), and a word someone copies onto paper is never broken across lines.
                        <ol data-testid="join-taken-words" style={{
                            listStyle: 'none', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 6.5em), 1fr))',
                            gap: '0.4rem', padding: 0, margin: '0 0 0.75rem', overflowWrap: 'normal',
                        }}>
                            {words.map((w, i) => (
                                <li key={i} style={{
                                    background: 'var(--bg-secondary, #1e293b)', borderRadius: 8, padding: '0.5rem 0.4rem',
                                    fontSize: '0.8rem', fontFamily: 'monospace', textAlign: 'center', minWidth: 0,
                                }}>
                                    <span style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>{i + 1}. </span>
                                    <strong>{w}</strong>
                                </li>
                            ))}
                        </ol>
                    ) : (
                        <button type="button" style={secondaryButton} onClick={() => setShowWords(true)}>
                            {mine ? `Show ${mine}'s 12 words` : 'Show its 12 words'}
                        </button>
                    ))}
                    <button type="button" style={primaryButton} onClick={() => (onExisting ? onExisting(screen.held) : reloadPage())}>
                        {heldName ? `Open ${heldName}` : 'Open it'}
                    </button>
                </>
            );
            break;
        }

        case 'failed':
            body = (
                <>
                    <NoticeLine notice={notice ?? { tone: 'error', text: WENT_WRONG }} />
                    <button type="button" style={primaryButton} onClick={() => reloadPage()}>Reload page</button>
                </>
            );
            break;
    }

    return (
        <div data-testid={`join-screen-${screen.name}`} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
            {body}
        </div>
    );
}
