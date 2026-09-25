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
    clearPendingJoin,
    completePendingJoin,
    generateIdentity,
    loadPendingJoin,
    pendingJoinSent,
    savePendingJoin,
    PendingJoinHeldError,
    PENDING_JOIN_RATE_LIMITED_TTL_MS,
    PENDING_JOIN_TTL_MS,
    type BeanPoolIdentity,
    type JoinProvider,
    type PendingJoin,
} from '../lib/identity';
import {
    browserCanHoldKey,
    captureAuthReturn,
    checkCallsign,
    checkMembershipWithKey,
    checkSentJoin,
    consumeCapturedAuthReturn,
    doorOutcome,
    doorRefusalMessage,
    DoorUnreachableError,
    joinBody,
    matchAuthReturn,
    offeredProviders,
    pollGithubJoin,
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

export interface JoinedResult {
    /** The member's identity, now in this browser's identity slot, with the name the node gave it. */
    identity: BeanPoolIdentity;
    /** The name they asked for, when the node gave them another (it was taken). */
    requestedCallsign: string | null;
    /** The key was brought here (phone or 12 words), not made for this join. */
    restored: boolean;
    /** What the node said about sign-in recovery enrolled with the join (G11-c), or null when none was asked. */
    recovery: { enrolled?: boolean } | null;
}

interface Props {
    /** The node has said yes; the identity is saved. */
    onJoined: (result: JoinedResult) => void;
    /** "I use BeanPool on my phone" / "I have my 12 words": WelcomePage's own restore screens. */
    onRestore: (how: 'phone' | 'words') => void;
    /** A key restored here that is not a member of this community yet: it goes through the door as it is. */
    restored?: BeanPoolIdentity | null;
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
    | { name: 'joining' }
    | { name: 'unknown'; checking: boolean }
    | { name: 'checking'; checking: boolean }
    | { name: 'unavailable'; message: string }
    | { name: 'already_joined'; message: string };

type Notice = { tone: 'error' | 'info'; text: string } | null;

const UNREACHABLE = "Can't reach the community right now. Try again in a minute.";
/** A nonce lives ten minutes on the node; one older than this is fetched again before it is sent to a provider. */
const NONCE_FRESH_MS = 5 * 60 * 1000;
const TOO_OLD = 'This browser is too old to hold a BeanPool account. Try an up-to-date Chrome, Firefox, Safari or Edge.';

/**
 * The node refused a join outright: a 4xx, which it answers before it writes a member. That join did not land, so
 * the key is an unsent one again and the pending join's own clock applies. A 5xx keeps it sent: a gateway can answer
 * 5xx after the node has taken the member.
 */
function unsent(p: PendingJoin): PendingJoin {
    const next = { ...p };
    delete next.sentAt;
    return next;
}

/** A key restored just now, as a pending join of its own. */
function restoredPending(r: BeanPoolIdentity): PendingJoin {
    const now = Date.now();
    return { identity: r, provider: null, nonce: null, startedAt: now, expiresAt: now + PENDING_JOIN_TTL_MS, restored: true };
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

export function WebJoin({ onJoined, onRestore, restored = null, navigate, origin, authReturn }: Props) {
    const [screen, setScreen] = useState<Screen>({ name: 'loading' });
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
    const mounted = useRef(true);
    useEffect(() => () => { mounted.current = false; }, []);
    // Held in a ref so every callback below stays the same function for the life of the screens: a parent re-render
    // must not restart the GitHub wait or ask for another nonce.
    const onJoinedRef = useRef(onJoined);
    onJoinedRef.current = onJoined;

    const go = navigate ?? ((url: string) => window.location.assign(url));
    const here = origin ?? window.location.origin;

    // ---------- the node's answer to a join ----------

    const finish = useCallback(async (p: PendingJoin, nodeCallsign: string | null, recovery: { enrolled?: boolean } | null) => {
        const identity = { ...p.identity, callsign: nodeCallsign || p.identity.callsign };
        try {
            await completePendingJoin(identity);
        } catch (e) {
            // The node has the member; this browser could not keep the key. The pending join still holds it (the
            // move is one transaction), marked sent, so no clock drops it: a reload finds it, asks the node, and is
            // told "a member". One that was not marked yet (a restored key the nonce request found a member) is
            // marked now, if this browser can still write at all.
            console.error('[WebJoin] joined, but the identity could not be saved:', e);
            if (!pendingJoinSent(p)) await savePendingJoin({ ...p, sentAt: Date.now() }).catch(() => {});
            setNotice({ tone: 'error', text: "You're in, but this browser couldn't save your account. Reload the page to finish." });
            setScreen({ name: 'lobby' });
            return;
        }
        lastJoin.current = null;
        onJoinedRef.current({
            identity,
            requestedCallsign: nodeCallsign && nodeCallsign !== p.identity.callsign ? p.identity.callsign : null,
            restored: p.restored,
            recovery,
        });
    }, []);

    /** Back to the sign-in buttons with the same key, saying why. */
    const toProviders = useCallback((p: PendingJoin, n: Notice) => {
        setPending(p);
        setNotice(n);
        setScreen({ name: 'providers' });
    }, []);

    // Declared before use through a ref, because an expired sign-in retries itself through the same path a tap takes.
    const signInRef = useRef<(p: PendingJoin, provider: JoinProvider, fresh?: JoinNonce | null) => Promise<void>>(async () => {});

    const handleOutcome = useCallback(async (outcome: DoorOutcome, p: PendingJoin, proof: SignInProof, status: number) => {
        switch (outcome.kind) {
            case 'joined':
                return finish(p, outcome.callsign, outcome.recovery);
            case 'already_member':
                return finish(p, null, null);
            case 'already_joined':
                // One sign-in account, one identity: this key is not needed, and must not linger as a second one. The
                // node answers this only for a key that is not a member (a member's gets already_member).
                await clearPendingJoin();
                setPending(null);
                setScreen({ name: 'already_joined', message: outcome.message });
                return;
            case 'expired': {
                if (!p.retriedExpired) {
                    // Once, by itself, with a fresh nonce: most often somebody took longer than ten minutes.
                    const next = { ...unsent(p), retriedExpired: true };
                    await savePendingJoin(next);
                    setNotice({ tone: 'info', text: outcome.message });
                    return signInRef.current(next, proof.provider, null);
                }
                const next = { ...unsent(p), nonce: null };
                await savePendingJoin(next);
                return toProviders(next, { tone: 'error', text: outcome.message });
            }
            case 'rate_limited': {
                // Kept for an hour, so trying again later uses this key rather than making a second one.
                const next = { ...unsent(p), nonce: null, expiresAt: Date.now() + PENDING_JOIN_RATE_LIMITED_TTL_MS };
                await savePendingJoin(next);
                return toProviders(next, { tone: 'error', text: outcome.message });
            }
            case 'unavailable':
                setScreen({ name: 'unavailable', message: outcome.message });
                return;
            case 'door_closed':
                await clearPendingJoin();
                setPending(null);
                setNotice({ tone: 'error', text: outcome.message });
                setScreen({ name: 'lobby' });
                return;
            case 'refused': {
                const next = { ...(status < 500 ? unsent(p) : p), nonce: null };
                await savePendingJoin(next);
                return toProviders(next, { tone: 'error', text: outcome.message });
            }
        }
    }, [finish, toProviders]);

    /** "We can't tell if that worked": ask whether this key is a member now, and never claim it is when it is not. */
    const settleUnknown = useCallback(async (p: PendingJoin, proof: SignInProof) => {
        setScreen({ name: 'unknown', checking: true });
        try {
            const m = await checkMembershipWithKey(p.identity);
            if (m.isMember) return finish(p, m.callsign, null);
            lastJoin.current = { pending: p, proof };
            setScreen({ name: 'unknown', checking: false });
        } catch {
            lastJoin.current = { pending: p, proof };
            setScreen({ name: 'unknown', checking: false });
        }
    }, [finish]);

    const submit = useCallback(async (p: PendingJoin, proof: SignInProof) => {
        setNotice(null);
        setScreen({ name: 'joining' });
        // Marked sent BEFORE it goes, and not sent if that cannot be written: once the node has the join, the answer
        // can be lost, and this record may be the only copy of a member's key. The nonce is on its way to the node;
        // the page never offers it again.
        const sent: PendingJoin = { ...p, nonce: null, sentAt: Date.now() };
        try {
            await savePendingJoin(sent);
        } catch (e) {
            console.error('[WebJoin] the join could not be marked sent, so it was not sent:', e);
            return toProviders(p, { tone: 'error', text: "This browser couldn't save your account, so nothing was sent. Try again, or try another browser." });
        }
        setPending(sent);
        lastJoin.current = { pending: sent, proof };
        // G11-c seals the seed to `proof.sub` here and passes the shares as joinBody's third argument.
        const body = joinBody(sent.identity.callsign, proof);
        let answer;
        try {
            answer = await submitJoin(sent.identity, body);
        } catch (e) {
            if (e instanceof DoorUnreachableError) return settleUnknown(sent, proof);
            throw e;
        }
        return handleOutcome(doorOutcome(answer, proof.provider), sent, proof, answer.status);
    }, [handleOutcome, settleUnknown, toProviders]);

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
     * gets. A key the node says is not a member, once that join can no longer land, is an unsent one again: dropped
     * if its time is up, as always, or making room for a key restored just now. A join that could still land keeps
     * its key, and signing in again carries on with it. No answer keeps it and says so, with Try again.
     */
    const settleSent = useCallback(async (p: PendingJoin) => {
        setPending(p);
        setName(p.identity.callsign);
        setNotice(null);
        setScreen({ name: 'checking', checking: true });
        const check = await checkSentJoin(p);
        if (!mounted.current) return;
        const replacing = restored && restored.publicKey !== p.identity.publicKey ? restored : null;
        switch (check.kind) {
            case 'member':
                return finish(p, check.callsign, null);
            case 'not_member': {
                if (replacing) {
                    await clearPendingJoin();
                    const next = restoredPending(replacing);
                    await savePendingJoin(next);
                    return resume(next);
                }
                const next = unsent(p);
                if (next.expiresAt > Date.now()) {
                    await savePendingJoin(next);
                    return resume(next);
                }
                await clearPendingJoin();
                setPending(null);
                setScreen({ name: 'lobby' });
                return;
            }
            case 'may_still_land':
                // A key restored just now cannot take the one pending slot from a join that may yet land.
                if (replacing) return setScreen({ name: 'checking', checking: false });
                return resume(p, { tone: 'info', text: "Your join hasn't reached the community yet. Sign in again to finish." });
            case 'unknown':
                setScreen({ name: 'checking', checking: false });
                return;
        }
    }, [finish, resume, restored]);

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
            if (!(e instanceof DoorUnreachableError)) throw e;
            if (mounted.current) setNonceProblem(UNREACHABLE);
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
            if (provider === 'github') {
                let got;
                try {
                    got = await startGithubJoin(p.identity);
                } catch (e) {
                    if (!(e instanceof DoorUnreachableError)) throw e;
                    return toProviders(p, { tone: 'error', text: UNREACHABLE });
                }
                if ('answer' in got) return toProviders(p, { tone: 'error', text: doorRefusalMessage(got.answer) });
                const next: PendingJoin = { ...p, provider: 'github', nonce: null };
                await savePendingJoin(next);
                setPending(next);
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
        } finally {
            if (mounted.current) setBusy(false);
        }
    }, [nonceHeld, fetchNonce, toProviders, go, here]);
    signInRef.current = signIn;

    // ---------- where the page starts ----------

    useEffect(() => {
        let cancelled = false;
        browserCanHoldKey().then((ok) => { if (!cancelled) setCanHoldKey(ok); });
        (async () => {
            const ret = authReturn !== undefined ? authReturn : captureAuthReturn();
            let p = await loadPendingJoin();
            if (cancelled) return;
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
            if (restored && p?.identity.publicKey !== restored.publicKey) {
                // A key restored just now wins over an older join left pending here that never went out.
                p = restoredPending(restored);
                await savePendingJoin(p);
                if (cancelled) return;
            }
            if (p) {
                // A reload, a closed tab, or a key restored here: carry on with the same key and name.
                resume(p);
                return;
            }
            setScreen({ name: 'lobby' });
        })().catch((e) => {
            console.error('[WebJoin] could not start:', e);
            if (!cancelled) {
                setNotice({ tone: 'error', text: 'Something went wrong on this page. Reload it to try again.' });
                setScreen({ name: 'lobby' });
            }
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
                    return submit(p, { provider: 'github', sessionId: start.sessionId, sub: result.sub });
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
    }, [screen, pending, submit, toProviders]);

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
            const now = Date.now();
            // Going back to change the name keeps the key already made: one person, one key.
            const identity = pending ? { ...pending.identity, callsign: trimmed } : await generateIdentity(trimmed);
            const next: PendingJoin = pending
                ? { ...pending, identity }
                : { identity, provider: null, nonce: null, startedAt: now, expiresAt: now + PENDING_JOIN_TTL_MS, restored: false };
            await savePendingJoin(next);
            setPending(next);
            setScreen({ name: 'providers' });
        } catch (e) {
            console.error('[WebJoin] could not make a key:', e);
            setNotice({
                tone: 'error',
                text: e instanceof PendingJoinHeldError
                    ? 'An earlier join from this browser is still being checked. Reload the page to finish it.'
                    : 'This browser could not make your key. Try again, or try another browser.',
            });
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
        if (p && pendingJoinSent(p)) {
            // A join with this key went out, and the node may have it as a member: asked before the key can go.
            setBusy(true);
            const check = await checkSentJoin(p);
            if (!mounted.current) return;
            setBusy(false);
            if (check.kind === 'member') return finish(p, check.callsign, null);
            if (check.kind !== 'not_member') {
                // Kept, and joining from here carries on with the same key.
                setNotice(null);
                setScreen({ name: 'guard' });
                return;
            }
        }
        // Back past the name, before any sign-in worked: the key made for this join is dropped, never kept as a spare.
        await clearPendingJoin();
        setPending(null);
        setNonceHeld(null);
        setName('');
        setNotice(null);
        setScreen({ name: 'guard' });
    }

    async function copyCode(code: string) {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
        } catch {
            setCopied(false);
        }
    }

    function retryLastJoin() {
        const last = lastJoin.current;
        if (last) void submit(last.pending, last.proof);
    }

    async function retryUnknown() {
        const last = lastJoin.current;
        if (!last) return;
        // Ask first: the last one may have landed after all, and a second join with a spent sign-in would only fail.
        setScreen({ name: 'unknown', checking: true });
        try {
            const m = await checkMembershipWithKey(last.pending.identity);
            if (m.isMember) return finish(last.pending, m.callsign, null);
        } catch {
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
                    Joining as {callsign}…
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
                    <button type="button" style={primaryButton} onClick={() => void retryUnknown()}>Try again</button>
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
                    <button type="button" style={primaryButton} onClick={() => pending && void settleSent(pending)}>Try again</button>
                </>
            );
            break;

        case 'unavailable':
            body = (
                <>
                    <p role="alert" data-testid="join-unavailable" style={{ ...lede, color: 'var(--text-primary)' }}>{screen.message}</p>
                    <button type="button" style={primaryButton} onClick={retryLastJoin}>Try again</button>
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
    }

    return (
        <div data-testid={`join-screen-${screen.name}`} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
            {body}
        </div>
    );
}
