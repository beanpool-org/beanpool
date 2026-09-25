/**
 * Getting an account back in a web browser with the sign-in it joined with (design G11 §4.4, G11-d): your name here,
 * the sign-in (Google, Apple and Facebook leave the page and come back to the join's own return page; GitHub shows its
 * code), then the account, only if it is the one the name belongs to. The logic is lib/web-restore.ts; the throwaway
 * key waits in identity.ts's pending restore while the page is away.
 *
 * WelcomePage shows it from the open door's "Already have BeanPool?" and from "You're already here" (a sign-in that
 * already has an account), and when a sign-in comes back for a restore. It saves nothing itself: `onRestored` hands the
 * account to WelcomePage, which asks the node, settles a join this browser sent first, and saves it through the identity
 * store's guarded write (one browser, one account).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    clearPendingRestore,
    loadIdentity,
    loadPendingRestore,
    savePendingRestore,
    takePendingRestore,
    PENDING_RESTORE_TTL_MS,
    type BeanPoolIdentity,
    type JoinProvider,
} from '../lib/identity';
import {
    captureAuthReturn,
    consumeCapturedAuthReturn,
    DoorUnreachableError,
    GITHUB_DEVICE_PAGE,
    matchAuthReturn,
    providerAuthUrl,
    providerLabel,
    refusalMessage,
    runGithubPoll,
    sleep,
    type AuthReturn,
    type RedirectProvider,
} from '../lib/web-join';
import {
    fetchSignInCopy,
    lookupRestorable,
    makeEphemeralKey,
    openRestoreSession,
    openRestoredAccount,
    pollGithubRestore,
    releaseRefusalMessage,
    releaseSignInCopy,
    requestRestoreNonce,
    restoreProviders,
    sessionRefusalMessage,
    startGithubRestore,
    type EphemeralKey,
    type RestoreCandidate,
    type RestoreNonce,
    type RestoreProof,
} from '../lib/web-restore';
import { heading, lede, NoticeLine, primaryButton, quietButton, secondaryButton, UNREACHABLE, type Notice } from './WebJoin';

interface Props {
    /**
     * The account came back, and its key is the one its name belongs to. WelcomePage asks the node and saves it; false
     * when the node could not be asked, and then this screen keeps it and offers to try again.
     */
    onRestored: (identity: BeanPoolIdentity) => Promise<boolean>;
    /** This browser holds another account (saved from another tab, say): nothing here replaces it. */
    onHeld: (held: BeanPoolIdentity) => void;
    /** Open the account this browser already holds. */
    onExisting: (identity: BeanPoolIdentity) => void;
    /** Back to the other ways, or to the lobby. */
    onBack: () => void;
    /** "Use my 12 words" / "Link with my phone": WelcomePage's own restore screens. */
    onOtherWay: (how: 'phone' | 'words') => void;
    /** The sign-in the member just tried to join with, offered first. */
    provider?: JoinProvider | null;
    /** A sign-in coming back for a restore. Null when there is none. */
    authReturn?: AuthReturn | null;
    /** Leaves the page for the provider. Swappable in tests. */
    navigate?: (url: string) => void;
    /** This web app's origin, for the return URL. Swappable in tests. */
    origin?: string;
}

type Screen =
    | { name: 'loading' }
    | { name: 'name' }
    /** Opening the node's recovery session and asking for a sign-in nonce. */
    | { name: 'starting' }
    | { name: 'providers' }
    | { name: 'github'; userCode: string }
    /** Released, fetched and opened: the sign-in copy becoming the account. */
    | { name: 'restoring' }
    /** Handed to WelcomePage, which asks the node and saves it. */
    | { name: 'saving' }
    /** The copy opened to another account than the name's. Nothing saved. */
    | { name: 'wrong_account' }
    /** No copy to open, or one the web can't open. */
    | { name: 'no_copy'; message: string }
    | { name: 'already_here'; identity: BeanPoolIdentity }
    /**
     * The account is open in this page and nothing is saved: the node could not be asked about it (`unreachable`), or
     * this browser could not write it. Try again hands the same account on.
     */
    | { name: 'save_failed'; unreachable: boolean };

/** The node's recovery session this page is in: bound to `eph`, for `account`. */
interface Session {
    eph: EphemeralKey;
    collectionId: string;
    account: RestoreCandidate;
}

/** A nonce lives ten minutes on the node; one older than this is fetched again before it goes to a provider. */
const NONCE_FRESH_MS = 5 * 60 * 1000;
const WENT_WRONG = 'Something went wrong on this page. Start again.';

export function WebRestore({ onRestored, onHeld, onExisting, onBack, onOtherWay, provider: hinted = null, authReturn, navigate, origin }: Props) {
    const [screen, setScreen] = useState<Screen>({ name: 'loading' });
    const [notice, setNotice] = useState<Notice>(null);
    const [name, setName] = useState('');
    const [candidates, setCandidates] = useState<RestoreCandidate[] | null | 'looking'>([]);
    const [session, setSession] = useState<Session | null>(null);
    const [nonceHeld, setNonceHeld] = useState<{ value: RestoreNonce; at: number } | null>(null);
    const [fetchingNonce, setFetchingNonce] = useState(false);
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);
    const [githubSessionId, setGithubSessionId] = useState<{ sessionId: string; expiresAt: number; intervalSeconds: number } | null>(null);
    // The account once it has opened, kept in memory only, for "Try again" when the node could not be asked.
    const opened = useRef<BeanPoolIdentity | null>(null);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    const onRestoredRef = useRef(onRestored);
    onRestoredRef.current = onRestored;
    const onHeldRef = useRef(onHeld);
    onHeldRef.current = onHeld;

    const go = navigate ?? ((url: string) => window.location.assign(url));
    const here = origin ?? window.location.origin;

    // ---------- the account, once it has opened ----------

    /**
     * Hand the account to WelcomePage, unless this browser already has an account: the same one is said to be here
     * already, another is never replaced. WelcomePage's write refuses the same way if one arrives in between.
     */
    const hand = useCallback(async (identity: BeanPoolIdentity) => {
        opened.current = identity;
        const held = await loadIdentity();
        if (!mounted.current) return;
        if (held?.publicKey && held.publicKey === identity.publicKey) {
            opened.current = null;
            setScreen({ name: 'already_here', identity: held });
            return;
        }
        if (held?.publicKey) {
            opened.current = null;
            onHeldRef.current(held);
            return;
        }
        setNotice(null);
        setScreen({ name: 'saving' });
        let ok: boolean;
        try {
            ok = await onRestoredRef.current(identity);
        } catch (e) {
            console.error('[WebRestore] the account could not be saved:', e);
            if (mounted.current) setScreen({ name: 'save_failed', unreachable: false });
            return;
        }
        if (!mounted.current || ok) return;
        setScreen({ name: 'save_failed', unreachable: true });
    }, []);

    // ---------- the sign-in ----------

    const toProviders = useCallback((n: Notice) => {
        setNotice(n);
        setBusy(false);
        setScreen({ name: 'providers' });
    }, []);

    const fetchNonce = useCallback(async (s: Session): Promise<RestoreNonce | null> => {
        setFetchingNonce(true);
        try {
            const got = await requestRestoreNonce(s.eph, s.collectionId);
            if ('nonce' in got) {
                if (mounted.current) setNonceHeld({ value: got.nonce, at: Date.now() });
                return got.nonce;
            }
            if (!mounted.current) return null;
            if (got.answer.status === 404) {
                // The node no longer has this session (it lives a while, then goes): from the name again.
                setSession(null);
                setNotice({ tone: 'error', text: 'That restore timed out on the community. Start again.' });
                setScreen({ name: 'name' });
                return null;
            }
            setNotice({ tone: 'error', text: sessionRefusalMessage(got.answer, s.account.callsign) });
        } catch (e) {
            if (!(e instanceof DoorUnreachableError)) console.error('[WebRestore] could not ask for a sign-in:', e);
            if (mounted.current) setNotice({ tone: 'error', text: e instanceof DoorUnreachableError ? UNREACHABLE : WENT_WRONG });
        } finally {
            if (mounted.current) setFetchingNonce(false);
        }
        return null;
    }, []);

    /** Back to the sign-ins on the same session, saying why, with a fresh nonce (the last one went to a provider). */
    const backToSignIns = useCallback(async (s: Session, n: Notice) => {
        setNonceHeld(null);
        toProviders(n);
        await fetchNonce(s);
    }, [toProviders, fetchNonce]);

    /** Release the copy with this sign-in, fetch it, open it, and hand the account on if it is the name's. */
    const finishSignIn = useCallback(async (s: Session, proof: RestoreProof) => {
        setNotice(null);
        setScreen({ name: 'restoring' });
        const label = providerLabel(proof.provider);
        let released;
        try {
            released = await releaseSignInCopy(s.eph, s.collectionId, proof);
        } catch (e) {
            if (!(e instanceof DoorUnreachableError)) throw e;
            // Asked again with a fresh sign-in: the node lets the copy go to this session again, whichever answer was lost.
            return backToSignIns(s, { tone: 'error', text: UNREACHABLE });
        }
        if (released.status !== 200) {
            return backToSignIns(s, { tone: 'error', text: releaseRefusalMessage(released, proof.provider, s.account.callsign) });
        }
        let fetched;
        try {
            fetched = await fetchSignInCopy(s.eph, s.collectionId);
        } catch (e) {
            if (!(e instanceof DoorUnreachableError)) throw e;
            return backToSignIns(s, { tone: 'error', text: UNREACHABLE });
        }
        if ('answer' in fetched) {
            return backToSignIns(s, { tone: 'error', text: releaseRefusalMessage(fetched.answer, proof.provider, s.account.callsign) });
        }
        if (!fetched.copy) {
            setScreen({ name: 'no_copy', message: `The community has no ${label} copy of ${s.account.callsign} to open.` });
            return;
        }
        const result = await openRestoredAccount(fetched.copy, proof.provider, proof.sub, s.account);
        if (!mounted.current) return;
        switch (result.kind) {
            case 'ok':
                return hand(result.identity);
            case 'wrong_account':
                setScreen({ name: 'wrong_account' });
                return;
            case 'old_format':
                setScreen({ name: 'no_copy', message: `${s.account.callsign}'s ${label} copy is an older kind the web app can't open. Use your 12 words, or the phone app.` });
                return;
            case 'unreadable':
                setScreen({ name: 'no_copy', message: `${s.account.callsign}'s ${label} copy didn't open with this ${label} account. Use your 12 words, or the phone app.` });
                return;
        }
    }, [backToSignIns, hand]);

    const fail = useCallback((e: unknown) => {
        console.error('[WebRestore] could not finish:', e);
        if (!mounted.current) return;
        setBusy(false);
        setSession(null);
        setNotice({ tone: 'error', text: WENT_WRONG });
        setScreen({ name: 'name' });
    }, []);

    // ---------- where the page starts ----------

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const ret = authReturn !== undefined ? authReturn : captureAuthReturn();
            if (!ret) {
                setScreen({ name: 'name' });
                return;
            }
            // A read first, which takes nothing: React's StrictMode (main.tsx) runs this effect, cancels it, and runs it
            // again, and the cancelled run stops here, before it has taken the pending restore from the run that stays.
            await loadPendingRestore();
            if (cancelled) return;
            consumeCapturedAuthReturn();
            // Taken out of the store as it is read: one return is acted on once. From here it is this page's to finish.
            const r = await takePendingRestore(ret.state ?? '');
            if (!mounted.current) return;
            if (!r) {
                setNotice({ tone: 'error', text: refusalMessage('no_pending', ret.provider) });
                setScreen({ name: 'name' });
                return;
            }
            const s: Session = { eph: r.ephemeral, collectionId: r.collectionId, account: r.account };
            setSession(s);
            setName(r.account.callsign);
            const outcome = matchAuthReturn(ret, { provider: r.provider, nonce: r.nonce });
            if (outcome.kind === 'token') {
                return finishSignIn(s, { provider: outcome.provider, idToken: outcome.idToken, nonce: outcome.nonce, sub: outcome.sub });
            }
            // Back to the sign-ins on the same session, with a fresh nonce: that one went to the provider.
            const text = outcome.kind === 'cancelled' ? 'Sign-in was cancelled.'
                : outcome.kind === 'provider_error' ? outcome.message
                : refusalMessage(outcome.reason, r.provider);
            return backToSignIns(s, { tone: outcome.kind === 'cancelled' ? 'info' : 'error', text });
        })().catch((e) => { if (!cancelled) fail(e); });
        return () => { cancelled = true; };
        // Once, on arrival.
    }, []);

    // The name: which accounts here it could be, as the member types.
    useEffect(() => {
        if (screen.name !== 'name') return;
        const typed = name.trim();
        if (typed.length < 2) {
            setCandidates([]);
            return;
        }
        let cancelled = false;
        setCandidates('looking');
        const t = setTimeout(() => {
            lookupRestorable(typed).then((c) => { if (!cancelled) setCandidates(c); });
        }, 400);
        return () => { cancelled = true; clearTimeout(t); };
    }, [name, screen.name]);

    // GitHub: wait for the code to be entered, then release with the node's session.
    useEffect(() => {
        if (screen.name !== 'github' || !session || !githubSessionId) return;
        const s = session;
        const gh = githubSessionId;
        const controller = new AbortController();
        runGithubPoll({
            poll: () => pollGithubRestore(s.eph, s.collectionId, gh.sessionId),
            sleep,
            intervalSeconds: gh.intervalSeconds,
            expiresAt: gh.expiresAt,
            signal: controller.signal,
        }).then(async (result) => {
            if (controller.signal.aborted) return;
            switch (result.status) {
                case 'ok':
                    return finishSignIn(s, { provider: 'github', sessionId: gh.sessionId, sub: result.sub }).catch(fail);
                case 'denied':
                    return toProviders({ tone: 'error', text: 'GitHub said no. Try again, or choose another way.' });
                case 'expired':
                    return toProviders({ tone: 'error', text: 'That GitHub code expired. Choose GitHub again for a new one.' });
                case 'failed': {
                    const said = typeof result.answer.body.error === 'string' && result.answer.body.error ? result.answer.body.error : null;
                    return toProviders({ tone: 'error', text: said ?? 'GitHub sign-in could not be checked. Try again, or choose another way.' });
                }
            }
        }).catch((e) => {
            console.error('[WebRestore] GitHub wait failed:', e);
            if (!controller.signal.aborted) toProviders({ tone: 'error', text: UNREACHABLE });
        });
        return () => controller.abort();
    }, [screen.name, session, githubSessionId, finishSignIn, toProviders, fail]);

    // ---------- the screens' actions ----------

    /** "That's me": this browser first (nothing replaces an account here), then the node's session for it. */
    async function chooseAccount(account: RestoreCandidate) {
        setBusy(true);
        setNotice(null);
        try {
            const held = await loadIdentity();
            if (!mounted.current) return;
            if (held?.publicKey === account.publicKey) {
                setScreen({ name: 'already_here', identity: held });
                return;
            }
            if (held?.publicKey) {
                onHeldRef.current(held);
                return;
            }
            setScreen({ name: 'starting' });
            const eph = makeEphemeralKey();
            let opened;
            try {
                opened = await openRestoreSession(eph, account.callsign);
            } catch (e) {
                if (!(e instanceof DoorUnreachableError)) throw e;
                setNotice({ tone: 'error', text: UNREACHABLE });
                setScreen({ name: 'name' });
                return;
            }
            if (!mounted.current) return;
            if ('answer' in opened) {
                setNotice({ tone: 'error', text: sessionRefusalMessage(opened.answer, account.callsign) });
                setScreen({ name: 'name' });
                return;
            }
            const s: Session = { eph, collectionId: opened.collectionId, account };
            setSession(s);
            await fetchNonce(s);
            // To the sign-ins, with Try again if the nonce did not come; unless the node had already let the session go
            // and fetchNonce has gone back to the name.
            if (mounted.current) setScreen((now) => (now.name === 'starting' ? { name: 'providers' } : now));
        } catch (e) {
            fail(e);
        } finally {
            if (mounted.current) setBusy(false);
        }
    }

    async function signIn(provider: JoinProvider) {
        if (!session) return;
        const s = session;
        setBusy(true);
        setNotice(null);
        try {
            if (provider === 'github') {
                let got;
                try {
                    got = await startGithubRestore(s.eph, s.collectionId);
                } catch (e) {
                    if (!(e instanceof DoorUnreachableError)) throw e;
                    return toProviders({ tone: 'error', text: UNREACHABLE });
                }
                if ('answer' in got) return toProviders({ tone: 'error', text: sessionRefusalMessage(got.answer, s.account.callsign) });
                setCopied(false);
                setGithubSessionId({ sessionId: got.sessionId, expiresAt: Date.now() + got.expiresInSeconds * 1000, intervalSeconds: got.intervalSeconds });
                setScreen({ name: 'github', userCode: got.userCode });
                return;
            }
            // A nonce is single use and lives ten minutes: every trip to a provider takes a fresh one.
            const fresh = nonceHeld && Date.now() - nonceHeld.at < NONCE_FRESH_MS ? nonceHeld.value : null;
            const n = fresh ?? await fetchNonce(s);
            // fetchNonce has said why.
            if (!n) return;
            const clientId = n.clientIds[provider as RedirectProvider];
            if (!clientId) return toProviders({ tone: 'error', text: `${providerLabel(provider)} sign-in isn't available here.` });
            const now = Date.now();
            await savePendingRestore({
                kind: 'restore',
                ephemeral: s.eph,
                account: s.account,
                collectionId: s.collectionId,
                provider,
                nonce: n.nonce,
                startedAt: now,
                expiresAt: now + PENDING_RESTORE_TTL_MS,
            });
            setNonceHeld(null); // spent: this one is on its way to the provider
            go(providerAuthUrl(provider as RedirectProvider, { clientId, origin: here, nonce: n.nonce }));
        } catch (e) {
            console.error('[WebRestore] could not start the sign-in:', e);
            toProviders({ tone: 'error', text: WENT_WRONG });
        } finally {
            if (mounted.current) setBusy(false);
        }
    }

    async function backToName() {
        await clearPendingRestore().catch(() => {});
        setSession(null);
        setNonceHeld(null);
        setNotice(null);
        setScreen({ name: 'name' });
    }

    async function retrySave() {
        const identity = opened.current;
        if (!identity) return backToName();
        await hand(identity).catch(fail);
    }

    async function copyCode(code: string) {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
        } catch {
            setCopied(false);
        }
    }

    // ---------- drawing ----------

    const otherWays = (
        <>
            <button type="button" style={secondaryButton} onClick={() => onOtherWay('words')}>Use my 12 words</button>
            <button type="button" style={secondaryButton} onClick={() => onOtherWay('phone')}>Link with my phone</button>
        </>
    );
    const offered = nonceHeld ? restoreProviders(nonceHeld.value) : [];
    const ordered = hinted && offered.includes(hinted) ? [hinted, ...offered.filter((p) => p !== hinted)] : offered;
    const callsign = session?.account.callsign ?? '';

    let body: React.ReactNode;
    switch (screen.name) {
        case 'loading':
            body = <p role="status" style={lede}>One moment…</p>;
            break;

        case 'name': {
            const typed = name.trim();
            body = (
                <>
                    <h3 style={heading}>Get your account back</h3>
                    <p style={lede}>With the sign-in you joined with. First, what's your name here?</p>
                    <label htmlFor="restore-callsign" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
                        Your name here
                    </label>
                    <input
                        id="restore-callsign"
                        data-testid="restore-callsign"
                        type="text"
                        value={name}
                        maxLength={32}
                        autoComplete="nickname"
                        placeholder="e.g. Alice"
                        disabled={busy}
                        onChange={(e) => { setName(e.target.value); setNotice(null); }}
                        style={{
                            width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '0.75rem 1rem', borderRadius: '10px',
                            border: '1px solid var(--border-input)', background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)', fontSize: '1rem', fontFamily: 'inherit', outline: 'none',
                            marginBottom: '0.75rem',
                        }}
                    />
                    <NoticeLine notice={notice} />
                    {typed.length >= 2 && candidates === 'looking' && (
                        <p role="status" style={lede}>Looking…</p>
                    )}
                    {typed.length >= 2 && candidates === null && (
                        <p role="alert" style={{ ...lede, color: 'var(--text-primary)' }}>{UNREACHABLE}</p>
                    )}
                    {typed.length >= 2 && Array.isArray(candidates) && candidates.length === 0 && (
                        <p role="status" data-testid="restore-none" style={{ ...lede, color: 'var(--text-primary)' }}>
                            No account here starting with {typed} can come back with a sign-in. Your 12 words or the phone app
                            can still bring yours here.
                        </p>
                    )}
                    {typed.length >= 2 && Array.isArray(candidates) && candidates.length > 0 && (
                        <>
                            <p style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                                Which one is you?
                            </p>
                            {candidates.map((c) => (
                                <button key={c.publicKey} type="button" data-testid="restore-candidate" style={secondaryButton} disabled={busy}
                                    onClick={() => void chooseAccount(c)}>
                                    {c.callsign}
                                </button>
                            ))}
                        </>
                    )}
                    {typed.length >= 2 && Array.isArray(candidates) && candidates.length === 0 && otherWays}
                    <button type="button" style={quietButton} disabled={busy} onClick={onBack}>← Back</button>
                </>
            );
            break;
        }

        case 'starting':
            body = <p role="status" data-testid="restore-starting" style={lede}>One moment…</p>;
            break;

        case 'providers':
            body = (
                <>
                    <h3 style={heading}>Sign in as {callsign}</h3>
                    <p style={lede}>Choose the sign-in you joined with. It brings your account back to this browser.</p>
                    <NoticeLine notice={notice} />
                    {!nonceHeld && fetchingNonce ? (
                        <p role="status" style={lede}>Getting the sign-ins ready…</p>
                    ) : !nonceHeld ? (
                        <button type="button" style={secondaryButton} disabled={busy} onClick={() => session && void fetchNonce(session)}>Try again</button>
                    ) : ordered.length === 0 ? (
                        <p role="alert" style={lede}>This community has no sign-in a browser can use yet.</p>
                    ) : (
                        ordered.map((p, i) => (
                            <button key={p} type="button" data-testid={`restore-provider-${p}`} style={i === 0 && p === hinted ? primaryButton : secondaryButton}
                                disabled={busy} onClick={() => void signIn(p)}>
                                {providerLabel(p)}
                            </button>
                        ))
                    )}
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', lineHeight: 1.5, marginTop: '0.5rem' }}>
                        {callsign} is told on their devices that the account is being brought back, in case it isn't them.
                    </p>
                    <button type="button" style={quietButton} disabled={busy} onClick={() => void backToName()}>← Not {callsign}</button>
                </>
            );
            break;

        case 'github':
            body = (
                <>
                    <h3 style={heading}>Your GitHub code</h3>
                    <p style={lede}>Enter this code at GitHub, then come back here. We'll notice.</p>
                    <p data-testid="restore-github-code" style={{
                        fontFamily: 'monospace', fontSize: 'min(1.4rem, 7.5vw)', fontWeight: 800, letterSpacing: '0.08em',
                        margin: '0 0 0.75rem', overflowWrap: 'anywhere',
                    }}>
                        {screen.userCode}
                    </p>
                    <button type="button" style={secondaryButton} onClick={() => void copyCode(screen.userCode)}>
                        {copied ? 'Copied ✓' : 'Copy code'}
                    </button>
                    <a href={GITHUB_DEVICE_PAGE} target="_blank" rel="noopener noreferrer"
                        style={{ ...primaryButton, display: 'block', textDecoration: 'none', boxSizing: 'border-box' }}>
                        Open GitHub
                    </a>
                    <p role="status" style={{ ...lede, marginBottom: '0.5rem' }}>Waiting for GitHub…</p>
                    <button type="button" style={quietButton} onClick={() => toProviders(null)}>← Choose another way</button>
                </>
            );
            break;

        case 'restoring':
        case 'saving':
            body = (
                <p role="status" data-testid="restore-restoring" style={{ ...lede, color: 'var(--text-primary)', fontWeight: 600 }}>
                    Getting {callsign || 'your account'} back…
                </p>
            );
            break;

        case 'wrong_account':
            body = (
                <>
                    <h3 style={heading}>That isn't {callsign}</h3>
                    <p role="alert" data-testid="restore-wrong-account" style={{ ...lede, color: 'var(--text-primary)' }}>
                        The account that came back isn't {callsign}, so nothing was saved in this browser. Try again, or
                        use your 12 words.
                    </p>
                    <button type="button" style={primaryButton} onClick={() => void backToName()}>Start again</button>
                    {otherWays}
                </>
            );
            break;

        case 'no_copy':
            body = (
                <>
                    <p role="alert" data-testid="restore-no-copy" style={{ ...lede, color: 'var(--text-primary)' }}>{screen.message}</p>
                    {otherWays}
                    <button type="button" style={quietButton} onClick={() => void backToName()}>← Start again</button>
                </>
            );
            break;

        case 'already_here':
            body = (
                <>
                    <h3 style={heading}>Already here</h3>
                    <p role="status" data-testid="restore-already-here" style={{ ...lede, color: 'var(--text-primary)' }}>
                        {screen.identity.callsign.trim() || 'That account'} is already in this browser. Nothing needed bringing back.
                    </p>
                    <button type="button" style={primaryButton} onClick={() => onExisting(screen.identity)}>
                        {screen.identity.callsign.trim() ? `Open ${screen.identity.callsign.trim()}` : 'Open it'}
                    </button>
                </>
            );
            break;

        case 'save_failed':
            body = (
                <>
                    <p role="alert" data-testid="restore-save-failed" style={{ ...lede, color: 'var(--text-primary)' }}>
                        {screen.unreachable
                            ? `${callsign} is back on this page, but the community can't be reached to finish. Check your connection, then try again.`
                            : `${callsign} is back on this page, but this browser couldn't save it. Try again, or try another browser.`}
                        {' '}Nothing has been saved yet.
                    </p>
                    <button type="button" style={primaryButton} onClick={() => void retrySave()}>Try again</button>
                </>
            );
            break;
    }

    return (
        <div data-testid={`restore-screen-${screen.name}`} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
            {body}
        </div>
    );
}
