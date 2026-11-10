/**
 * Getting an account back in a web browser with the sign-in it joined with (design G11 §4.4, G11-d), with nothing typed
 * (recovery S1, scratch design DESIGN-recovery-no-callsign-fable.md §5): this page's community, the sign-in (Google, Apple
 * and Facebook leave the page and come back to the join's own return page), then the community finds the accounts that
 * sign-in protects; the member picks when there are several, and the account comes in only if it is the one the find
 * named. The logic is lib/web-restore.ts; the throwaway key waits in identity.ts's pending restore while the page is
 * away.
 *
 * WelcomePage shows it from the open door's "Already have BeanPool?" and from "You're already here" (a sign-in that
 * already has an account), and when a sign-in comes back for a restore. It saves nothing itself: `onRestored` hands the
 * account to WelcomePage, which asks the node, settles a join this browser sent first, and saves it through the identity
 * store's guarded write (one browser, one account).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { t, word } from '@beanpool/core';
import {
    clearPendingRestore,
    loadIdentityStrict,
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
    matchAuthReturn,
    providerAuthUrl,
    providerLabel,
    refusalMessage,
    type AuthReturn,
} from '../lib/web-join';
import {
    collectAccount,
    collectRefusalMessage,
    fetchSignInCopy,
    findAccounts,
    findRefusalMessage,
    makeEphemeralKey,
    noAccountMessage,
    openRestoredAccount,
    requestFindNonce,
    restoreProviders,
    type EphemeralKey,
    type RestoreCandidate,
    type RestoreNonce,
    type RestoreProof,
} from '../lib/web-restore';
import { heading, lede, NoticeLine, primaryButton, quietButton, saidWords, secondaryButton, JOIN_WORDS, type Notice, type Said } from './WebJoin';
// lib/web-restore.ts is on the 12 words' key path and writes its sentences in English; they are shown through this.
import { keyLineWords } from './key-lines';

interface Props {
    /**
     * The account came back, and its key is the one the find named. WelcomePage asks the node and saves it; false when
     * the node could not be asked, and then this screen keeps it and offers to try again.
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
    /**
     * The community this page belongs to, by name, where the find looks: the web app is its community's own, so the
     * address the member opened chose it (another community's account comes back on that community's page).
     */
    community: string;
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
    /** The first screen: this community, and the sign-ins. */
    | { name: 'providers' }
    /** Back from the sign-in: the community finds the accounts it protects. */
    | { name: 'finding' }
    /** Several accounts use this sign-in: the member picks theirs. */
    | { name: 'pick'; accounts: RestoreCandidate[] }
    /** No account here uses this sign-in. */
    | { name: 'none'; provider: JoinProvider }
    /** The community's server has no find yet. */
    /** Collected, fetched and opened: the sign-in copy becoming the account. */
    | { name: 'restoring' }
    /** Handed to WelcomePage, which asks the node and saves it. */
    | { name: 'saving' }
    /** The copy opened to another account than the one the find named. Nothing saved. */
    | { name: 'wrong_account' }
    /** No copy to open, or one the web can't open. */
    | { name: 'no_copy'; message: Said }
    | { name: 'already_here'; identity: BeanPoolIdentity }
    /**
     * The account is open in this page and nothing is saved: the node could not be asked about it (`unreachable`), or
     * this browser could not write it. Try again hands the same account on.
     */
    | { name: 'save_failed'; unreachable: boolean };

/** What the find verified for this page's throwaway key: the sign-in the copy opens with, and the accounts it named. */
interface Found {
    eph: EphemeralKey;
    proof: RestoreProof;
    accounts: RestoreCandidate[];
}

/** A nonce lives ten minutes on the node; one older than this is fetched again before it goes to a provider. */
const NONCE_FRESH_MS = 5 * 60 * 1000;
/** Said in more than one place: marked here, translated where it is shown. */
const RESTORE_WORDS = { wentWrong: word('Something went wrong on this page. Start again.') } as const;

/** The first letter of a name, for its round mark in the list (the node sends no photo to a restoring browser). */
function initialOf(name: string): string {
    return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?';
}

export function WebRestore({ onRestored, onHeld, onExisting, onBack, onOtherWay, community, provider: hinted = null, authReturn, navigate, origin }: Props) {
    const [screen, setScreen] = useState<Screen>({ name: 'loading' });
    const [notice, setNotice] = useState<Notice>(null);
    // This restore's throwaway key: made on arrival, or brought back from the provider in the pending restore, and made
    // anew by Start again. A ref, read when an answer comes: an answer for a key let go is not this restore's.
    const ephRef = useRef<EphemeralKey | null>(null);
    const [nonceHeld, setNonceHeld] = useState<{ value: RestoreNonce; at: number } | null>(null);
    const [fetchingNonce, setFetchingNonce] = useState(false);
    const [busy, setBusy] = useState(false);
    // The account being brought back, once the find has named it and the member has it: its name, for the screens after.
    const [account, setAccount] = useState<RestoreCandidate | null>(null);
    // The find's answer, kept in memory only while the member picks.
    const found = useRef<Found | null>(null);
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
        const held = await loadIdentityStrict();
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

    /**
     * A find nonce for `key`, held for the next trip to a provider. Null when none came, and then the screen says why.
     * Only the answers for this restore's current key count: a key let go may answer last (React's StrictMode runs the
     * arrival twice, each with its own key), and its nonce was issued to it, never to the key the find will sign with.
     */
    const fetchNonce = useCallback(async (key: EphemeralKey): Promise<RestoreNonce | null> => {
        const current = () => mounted.current && ephRef.current?.publicKey === key.publicKey;
        setFetchingNonce(true);
        try {
            const got = await requestFindNonce(key);
            if (!current()) return null;
            if ('nonce' in got) {
                setNonceHeld({ value: got.nonce, at: Date.now() });
                return got.nonce;
            }
            setNotice({ tone: 'error', text: findRefusalMessage(got.answer, null) });
        } catch (e) {
            if (!(e instanceof DoorUnreachableError)) console.error('[WebRestore] could not ask for a sign-in:', e);
            if (current()) setNotice({ tone: 'error', text: e instanceof DoorUnreachableError ? () => t(JOIN_WORDS.unreachable) : () => t(RESTORE_WORDS.wentWrong) });
        } finally {
            if (current()) setFetchingNonce(false);
        }
        return null;
    }, []);

    /** Back to the sign-ins with the same throwaway key, saying why, with a fresh nonce (the last one went to a provider). */
    const backToSignIns = useCallback(async (key: EphemeralKey, n: Notice) => {
        found.current = null;
        setAccount(null);
        setNonceHeld(null);
        toProviders(n);
        await fetchNonce(key);
    }, [toProviders, fetchNonce]);

    /**
     * The account picked (or the only one): this browser first (nothing replaces an account here, and one already here
     * needs nothing released), then the collect by the find's hold, the copy, and the one check that decides.
     */
    const bringBack = useCallback(async (f: Found, picked: RestoreCandidate) => {
        const held = await loadIdentityStrict();
        if (!mounted.current) return;
        if (held?.publicKey === picked.publicKey) {
            found.current = null;
            setScreen({ name: 'already_here', identity: held });
            return;
        }
        if (held?.publicKey) {
            found.current = null;
            onHeldRef.current(held);
            return;
        }
        found.current = null; // the hold is spent by the collect, whatever its answer
        setAccount(picked);
        setNotice(null);
        setScreen({ name: 'restoring' });
        const { eph: key, proof } = f;
        const label = providerLabel(proof.provider);
        let collected;
        try {
            collected = await collectAccount(key, picked);
        } catch (e) {
            if (!(e instanceof DoorUnreachableError)) throw e;
            // The hold may be spent or not: a fresh sign-in finds again either way.
            return backToSignIns(key, { tone: 'error', text: () => t(JOIN_WORDS.unreachable) });
        }
        if (!mounted.current) return;
        if ('answer' in collected) return backToSignIns(key, { tone: 'error', text: collectRefusalMessage(collected.answer) });
        let fetched;
        try {
            fetched = await fetchSignInCopy(key, collected.collectionId);
        } catch (e) {
            if (!(e instanceof DoorUnreachableError)) throw e;
            return backToSignIns(key, { tone: 'error', text: () => t(JOIN_WORDS.unreachable) });
        }
        if (!mounted.current) return;
        if ('answer' in fetched) {
            if (fetched.answer.status === 400) {
                // The session ended between the collect and the fetch (its owner stopped it, moved the copy, or it ran
                // out): the node hands nothing over from a dead session.
                return backToSignIns(key, { tone: 'error', text: () => t('That restore was stopped on the community, or has ended. Start again.') });
            }
            return backToSignIns(key, { tone: 'error', text: collectRefusalMessage(fetched.answer) });
        }
        if ('unopened' in fetched) {
            setScreen({ name: 'no_copy', message: () => t("The community's copy of {name} didn't open in this browser, so nothing was changed. Start again, or use your 12 words.", { name: picked.callsign }) });
            return;
        }
        if (!fetched.copy) {
            setScreen({ name: 'no_copy', message: () => t('The community has no {provider} copy of {name} to open.', { provider: label, name: picked.callsign }) });
            return;
        }
        const result = await openRestoredAccount(fetched.copy, proof.provider, proof.sub, picked);
        if (!mounted.current) return;
        switch (result.kind) {
            case 'ok':
                return hand(result.identity);
            case 'wrong_account':
                setScreen({ name: 'wrong_account' });
                return;
            case 'old_format':
                setScreen({ name: 'no_copy', message: () => t("{name}'s {provider} copy is an older kind the web app can't open. Use your 12 words, or the phone app.", { name: picked.callsign, provider: label }) });
                return;
            case 'unreadable':
                setScreen({ name: 'no_copy', message: () => t("{name}'s {provider} copy didn't open with this {provider} account. Use your 12 words, or the phone app.", { name: picked.callsign, provider: label }) });
                return;
        }
    }, [backToSignIns, hand]);

    /** Back from the provider with a token: the community finds the accounts this sign-in protects. */
    const finishSignIn = useCallback(async (key: EphemeralKey, proof: RestoreProof) => {
        setNotice(null);
        setScreen({ name: 'finding' });
        let answer;
        try {
            answer = await findAccounts(key, proof);
        } catch (e) {
            if (!(e instanceof DoorUnreachableError)) throw e;
            return backToSignIns(key, { tone: 'error', text: () => t(JOIN_WORDS.unreachable) });
        }
        if (!mounted.current) return;
        if ('answer' in answer) return backToSignIns(key, { tone: 'error', text: findRefusalMessage(answer.answer, proof.provider) });
        const f: Found = { eph: key, proof, accounts: answer.accounts };
        if (f.accounts.length === 0) {
            setScreen({ name: 'none', provider: proof.provider });
            return;
        }
        if (f.accounts.length === 1) return bringBack(f, f.accounts[0]);
        found.current = f;
        setScreen({ name: 'pick', accounts: f.accounts });
    }, [backToSignIns, bringBack]);

    const fail = useCallback((e: unknown) => {
        console.error('[WebRestore] could not finish:', e);
        if (!mounted.current) return;
        setBusy(false);
        found.current = null;
        setAccount(null);
        setNotice({ tone: 'error', text: () => t(RESTORE_WORDS.wentWrong) });
        // A new throwaway key and a new nonce: nothing of the restore that failed is used again.
        const key = makeEphemeralKey();
        ephRef.current = key;
        setNonceHeld(null);
        setScreen({ name: 'providers' });
        void fetchNonce(key);
    }, [fetchNonce]);

    // ---------- where the page starts ----------

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const ret = authReturn !== undefined ? authReturn : captureAuthReturn();
            if (!ret) {
                const key = makeEphemeralKey();
                ephRef.current = key;
                setScreen({ name: 'providers' });
                await fetchNonce(key);
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
                const key = makeEphemeralKey();
                ephRef.current = key;
                toProviders({ tone: 'error', text: refusalMessage('no_pending', ret.provider) });
                await fetchNonce(key);
                return;
            }
            ephRef.current = r.ephemeral;
            const outcome = matchAuthReturn(ret, { provider: r.provider, nonce: r.nonce });
            if (outcome.kind === 'token') {
                return finishSignIn(r.ephemeral, { provider: outcome.provider, idToken: outcome.idToken, nonce: outcome.nonce, sub: outcome.sub });
            }
            // Back to the sign-ins with the same key, with a fresh nonce: that one went to the provider.
            const text: Said = outcome.kind === 'cancelled' ? () => t('Sign-in was cancelled.')
                : outcome.kind === 'provider_error' ? outcome.message
                : refusalMessage(outcome.reason, r.provider);
            return backToSignIns(r.ephemeral, { tone: outcome.kind === 'cancelled' ? 'info' : 'error', text });
        })().catch((e) => { if (!cancelled) fail(e); });
        return () => { cancelled = true; };
        // Once, on arrival.
    }, []);

    // ---------- the screens' actions ----------

    async function signIn(provider: JoinProvider) {
        const key = ephRef.current;
        if (!key) return;
        setBusy(true);
        setNotice(null);
        try {
            // A nonce is single use and lives ten minutes: every trip to a provider takes a fresh one.
            const fresh = nonceHeld && Date.now() - nonceHeld.at < NONCE_FRESH_MS ? nonceHeld.value : null;
            const n = fresh ?? await fetchNonce(key);
            // fetchNonce has said why.
            if (!n) return;
            const clientId = n.clientIds[provider];
            if (!clientId) return toProviders({ tone: 'error', text: () => t("{provider} sign-in isn't available here.", { provider: providerLabel(provider) }) });
            const now = Date.now();
            await savePendingRestore({
                kind: 'restore',
                ephemeral: key,
                provider,
                nonce: n.nonce,
                startedAt: now,
                expiresAt: now + PENDING_RESTORE_TTL_MS,
            });
            setNonceHeld(null); // spent: this one is on its way to the provider
            go(providerAuthUrl(provider, { clientId, origin: here, nonce: n.nonce }));
        } catch (e) {
            console.error('[WebRestore] could not start the sign-in:', e);
            toProviders({ tone: 'error', text: () => t(RESTORE_WORDS.wentWrong) });
        } finally {
            if (mounted.current) setBusy(false);
        }
    }

    function pick(picked: RestoreCandidate) {
        const f = found.current;
        if (!f || busy) return;
        setBusy(true);
        bringBack(f, picked).catch(fail).finally(() => { if (mounted.current) setBusy(false); });
    }

    /**
     * "Try again" for the sign-ins: the can't-reach notice goes as it is tried, and comes back only if it fails again. Not
     * cleared in fetchNonce itself: there it would wipe why backToSignIns came back here (review 4109590845).
     */
    function retryNonce() {
        const key = ephRef.current;
        if (!key) return;
        setNotice(null);
        void fetchNonce(key);
    }

    /** From the start: a new throwaway key, so nothing of the last attempt (its hold, its session) is used again. */
    async function startAgain() {
        await clearPendingRestore().catch(() => {});
        opened.current = null; // an account left on the save-failed screen is let go, not kept in memory
        found.current = null;
        setAccount(null);
        setNonceHeld(null);
        setNotice(null);
        const key = makeEphemeralKey();
        ephRef.current = key;
        setScreen({ name: 'providers' });
        await fetchNonce(key);
    }

    async function retrySave() {
        const identity = opened.current;
        if (!identity) return startAgain();
        await hand(identity).catch(fail);
    }

    // ---------- drawing ----------

    const otherWays = (
        <>
            <button type="button" style={secondaryButton} onClick={() => onOtherWay('words')}>{t('Use my 12 words')}</button>
            <button type="button" style={secondaryButton} onClick={() => onOtherWay('phone')}>{t('Link with my phone')}</button>
        </>
    );
    const offered = nonceHeld ? restoreProviders(nonceHeld.value) : [];
    const ordered = hinted && offered.includes(hinted) ? [hinted, ...offered.filter((p) => p !== hinted)] : offered;
    const callsign = account?.callsign ?? '';
    const back = <button type="button" style={quietButton} disabled={busy} onClick={onBack}>{t('← Back')}</button>;

    let body: React.ReactNode;
    switch (screen.name) {
        case 'loading':
            body = <p role="status" style={lede}>{t('One moment…')}</p>;
            break;

        case 'providers':
            body = (
                <>
                    <h3 style={heading}>{t('Get your account back')}</h3>
                    <p style={lede}>{t('Choose your community, then sign in with the account you linked. It finds your account, so there is nothing else to type.')}</p>
                    {/* The community step: this page's own community, the one the address chose. */}
                    <p style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>{t('Which community?')}</p>
                    <p data-testid="restore-community" dir="auto" style={{
                        padding: '0.6rem 0.9rem', borderRadius: '10px', marginBottom: '0.75rem', overflowWrap: 'anywhere',
                        border: '2px solid var(--accent)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontWeight: 600,
                    }}>
                        {community}
                    </p>
                    <NoticeLine notice={notice} />
                    {!nonceHeld && fetchingNonce ? (
                        <p role="status" style={lede}>{t('Getting the sign-ins ready…')}</p>
                    ) : !nonceHeld ? (
                        <button type="button" style={secondaryButton} disabled={busy} onClick={retryNonce}>{t('Try again')}</button>
                    ) : ordered.length === 0 ? (
                        <p role="alert" style={lede}>{t('This community has no sign-in a browser can use yet.')}</p>
                    ) : (
                        ordered.map((p, i) => (
                            <button key={p} type="button" data-testid={`restore-provider-${p}`} style={i === 0 && p === hinted ? primaryButton : secondaryButton}
                                disabled={busy} onClick={() => void signIn(p)}>
                                {providerLabel(p)}
                            </button>
                        ))
                    )}
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', lineHeight: 1.5, marginTop: '0.5rem' }}>
                        {t("The account's owner is told on their devices that it is being brought back, in case it isn't them.")}
                    </p>
                    {back}
                </>
            );
            break;

        case 'finding':
            body = <p role="status" data-testid="restore-finding" style={{ ...lede, color: 'var(--text-primary)', fontWeight: 600 }}>{t('Finding your account…')}</p>;
            break;

        case 'pick':
            body = (
                <>
                    <h3 style={heading}>{t('Which account is yours?')}</h3>
                    {screen.accounts.map((c) => (
                        <button key={c.publicKey} type="button" data-testid="restore-candidate" disabled={busy} onClick={() => pick(c)}
                            style={{ ...secondaryButton, display: 'flex', alignItems: 'center', gap: '0.75rem', textAlign: 'start', paddingInline: '0.75rem' }}>
                            <span aria-hidden="true" style={{
                                flex: '0 0 auto', width: '2rem', height: '2rem', borderRadius: '50%', display: 'inline-flex',
                                alignItems: 'center', justifyContent: 'center', background: 'var(--bg-secondary)',
                                border: '1px solid var(--border-input)', color: 'var(--text-primary)', fontWeight: 700,
                            }}>
                                {initialOf(c.callsign)}
                            </span>
                            <span dir="auto" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{c.callsign}</span>
                        </button>
                    ))}
                    <button type="button" style={quietButton} disabled={busy} onClick={() => void startAgain()}>{t('← Start again')}</button>
                </>
            );
            break;

        case 'none':
            body = (
                <>
                    <p role="alert" data-testid="restore-none" style={{ ...lede, color: 'var(--text-primary)' }}>{keyLineWords(noAccountMessage(community, screen.provider))}</p>
                    <button type="button" style={primaryButton} onClick={() => void startAgain()}>{t('Start again')}</button>
                    {otherWays}
                    {back}
                </>
            );
            break;

        case 'restoring':
        case 'saving':
            body = (
                <p role="status" data-testid="restore-restoring" style={{ ...lede, color: 'var(--text-primary)', fontWeight: 600 }}>
                    {callsign ? t('Getting {name} back…', { name: callsign }) : t('Getting your account back…')}
                </p>
            );
            break;

        case 'wrong_account':
            body = (
                <>
                    <h3 style={heading}>{t("That isn't {name}", { name: callsign })}</h3>
                    <p role="alert" data-testid="restore-wrong-account" style={{ ...lede, color: 'var(--text-primary)' }}>
                        {t("The account that came back isn't {name}, so nothing was saved in this browser. Try again, or use your 12 words.", { name: callsign })}
                    </p>
                    <button type="button" style={primaryButton} onClick={() => void startAgain()}>{t('Start again')}</button>
                    {otherWays}
                </>
            );
            break;

        case 'no_copy':
            body = (
                <>
                    <p role="alert" data-testid="restore-no-copy" style={{ ...lede, color: 'var(--text-primary)' }}>{saidWords(screen.message)}</p>
                    {otherWays}
                    <button type="button" style={quietButton} onClick={() => void startAgain()}>{t('← Start again')}</button>
                </>
            );
            break;

        case 'already_here':
            body = (
                <>
                    <h3 style={heading}>{t('Already here')}</h3>
                    <p role="status" data-testid="restore-already-here" style={{ ...lede, color: 'var(--text-primary)' }}>
                        {screen.identity.callsign.trim()
                            ? t('{name} is already in this browser. Nothing needed bringing back.', { name: screen.identity.callsign.trim() })
                            : t('That account is already in this browser. Nothing needed bringing back.')}
                    </p>
                    <button type="button" style={primaryButton} onClick={() => onExisting(screen.identity)}>
                        {screen.identity.callsign.trim() ? t('Open {name}', { name: screen.identity.callsign.trim() }) : t('Open it')}
                    </button>
                </>
            );
            break;

        case 'save_failed':
            body = (
                <>
                    <p role="alert" data-testid="restore-save-failed" style={{ ...lede, color: 'var(--text-primary)' }}>
                        {screen.unreachable
                            ? t("{name} is back on this page, but the community can't be reached to finish. Check your connection, then try again. Nothing has been saved yet.", { name: callsign })
                            : t("{name} is back on this page, but this browser couldn't save it. Try again, or try another browser. Nothing has been saved yet.", { name: callsign })}
                    </p>
                    <button type="button" style={primaryButton} onClick={() => void retrySave()}>{t('Try again')}</button>
                    {/* A browser that can never save it (no storage, say) is not a dead end: the other ways, or the start. */}
                    {otherWays}
                    <button type="button" style={quietButton} onClick={() => void startAgain()}>{t('← Start again')}</button>
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
