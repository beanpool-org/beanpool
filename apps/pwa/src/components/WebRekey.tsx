/**
 * "An admin gave me a re-key code", in the web app (#1768; design DESIGN-rekey-redeem-fable.md §5): the member types the
 * code (or arrives with `/?rekey=RK-…` from the admin's QR), shows the two digits to the admin, and is the member once
 * the admin binds this device. The community is the node serving the page. The flow is lib/web-rekey.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    completePendingJoin, loadIdentity, loadPendingJoin, markPendingJoinSent, releaseSentPendingJoin, IdentityHeldError,
    PendingJoinHeldError, type BeanPoolIdentity,
} from '../lib/identity';
import { signReEnrollAsk, signedFetchWithKey } from '../lib/api';
import {
    abandonWebRekey, askWebRekey, endsWebRekey, finishWebRekey, isRekeyCode, pollWebRekey, webRekeyKey, WEB_REKEY_POLL_MS,
    WEB_REKEY_TEXT, type WebRekeyAnswer, type WebRekeyDeps, type WebRekeyKey,
} from '../lib/web-rekey';

// Each default reads its import only when called: other screens' tests mock ../lib/identity and ../lib/api without
// these exports, and a read at module load would fail every file that renders WelcomePage.
const defaultDeps: WebRekeyDeps = {
    loadIdentity: () => loadIdentity(),
    loadPendingJoin: () => loadPendingJoin(),
    markPendingJoinSent: (pending, at) => markPendingJoinSent(pending, at),
    completePendingJoin: (identity) => completePendingJoin(identity),
    releaseSentPendingJoin: (r) => releaseSentPendingJoin(r),
    signReEnrollAsk: (code, privateKeyHex) => signReEnrollAsk(code, privateKeyHex),
    signedFetchWithKey: (method, path, body, privateKeyHex, publicKeyHex) => signedFetchWithKey(method, path, body, privateKeyHex, publicKeyHex),
};

interface Props {
    initialCode?: string | null;
    /** Bound: the member, and whether the key (and its 12 words) is new to them. */
    onBound: (member: BeanPoolIdentity) => void;
    onBack: () => void;
    deps?: WebRekeyDeps;
}

type Phase = 'form' | 'asking' | 'waiting' | 'words' | 'linkAgain';

const box: React.CSSProperties = { width: '100%', padding: '0.75rem', borderRadius: '12px', border: '1px solid var(--border-primary, #333)', background: 'var(--bg-secondary, transparent)', color: 'inherit', fontSize: '1rem', fontFamily: 'monospace', boxSizing: 'border-box' };
const primary: React.CSSProperties = { width: '100%', padding: '0.9rem 1rem', borderRadius: '14px', border: 'none', background: 'var(--bp-info-fill)', color: 'var(--bp-info-on)', fontSize: '1rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', marginTop: '1rem' };
const secondary: React.CSSProperties = { background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.85rem', cursor: 'pointer', marginTop: '1rem', fontFamily: 'inherit' };

export function WebRekey({ initialCode, onBound, onBack, deps = defaultDeps }: Props) {
    const [code, setCode] = useState(initialCode ?? '');
    const [phase, setPhase] = useState<Phase>('form');
    const [error, setError] = useState<string | null>(null);
    const [match, setMatch] = useState<string | null>(null);
    const [member, setMember] = useState<BeanPoolIdentity | null>(null);
    const [wroteThemDown, setWroteThemDown] = useState(false);
    // The node removed sign-in copies of the old key in the move: only then is the member asked to link one again.
    const [linkSignInAgain, setLinkSignInAgain] = useState(false);
    const key = useRef<WebRekeyKey | null>(null);
    const finishing = useRef(false);

    const apply = useCallback(async (answer: WebRekeyAnswer) => {
        const k = key.current;
        if (!k) return;
        if (answer.state === 'waiting') {
            setMatch(answer.match);
            setError(null);
            setPhase('waiting');
            return;
        }
        if (answer.state === 'bound') {
            if (finishing.current) return;
            finishing.current = true;
            try {
                const m = await finishWebRekey(k, answer, deps);
                setLinkSignInAgain(answer.linkSignInAgain);
                setMember(m);
                setPhase(k.madeHere ? 'words' : 'linkAgain');
            } catch (e) {
                finishing.current = false;
                setError(e instanceof IdentityHeldError ? 'This browser holds another BeanPool account, so this one wasn’t saved here.' : WEB_REKEY_TEXT.unreachable);
                setPhase('form');
            }
            return;
        }
        if (answer.state === 'unreachable') {
            setError(WEB_REKEY_TEXT.unreachable);
            return;
        }
        if (endsWebRekey(answer)) await abandonWebRekey(k, deps).catch(() => {});
        setError(answer.state === 'declined' ? WEB_REKEY_TEXT.declined : answer.state === 'gone' ? WEB_REKEY_TEXT.gone : answer.message);
        setPhase('form');
    }, [deps]);

    // While the number shows: ask every few seconds whether the admin bound this device.
    useEffect(() => {
        if (phase !== 'waiting') return;
        const id = setInterval(async () => {
            const k = key.current;
            if (!k) return;
            const answer = await pollWebRekey(code, k, deps);
            if (answer.state !== 'waiting' && answer.state !== 'unreachable') await apply(answer);
        }, WEB_REKEY_POLL_MS);
        return () => clearInterval(id);
    }, [phase, code, deps, apply]);

    const ask = async () => {
        setError(null);
        if (!isRekeyCode(code)) { setError('That isn’t a whole re-key code. It starts RK- and has eight letters and numbers.'); return; }
        setPhase('asking');
        try {
            key.current = await webRekeyKey(deps);
        } catch (e) {
            setError(e instanceof PendingJoinHeldError
                ? 'A join you started in this browser is still waiting. Finish it first, then come back to your code.'
                : 'This browser couldn’t keep the key safely, so nothing was sent.');
            setPhase('form');
            return;
        }
        await apply(await askWebRekey(code, key.current, deps));
        setPhase((p) => (p === 'asking' ? 'form' : p));
    };

    if (phase === 'waiting' && match) {
        return (
            <div data-testid="web-rekey-waiting">
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>Show this number to your admin</h3>
                <p style={{ fontSize: '3rem', fontWeight: 900, letterSpacing: '0.4rem', fontFamily: 'monospace', margin: '0.75rem 0' }} data-testid="web-rekey-number">{match}</p>
                {/* The community this number came from, so the admin can check it is theirs (#1783 review N9). */}
                <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', margin: '0 0 0.5rem', overflowWrap: 'anywhere' }} data-testid="web-rekey-number-host">from {typeof window !== 'undefined' ? window.location.host : ''}</p>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.5 }}>
                    They type it on their screen. Check the address above is your community's. Your old phone stops working for good.
                </p>
                <p role="status" style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Waiting for your admin…</p>
                {error && <p role="alert" style={{ color: '#dc2626', fontSize: '0.85rem' }}>{error}</p>}
            </div>
        );
    }
    if (phase === 'words' && member) {
        return (
            <div data-testid="web-rekey-words">
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>You’re in</h3>
                <p style={{ fontSize: '0.9rem', lineHeight: 1.5 }}>These are the 12 words of your NEW key. Your old words no longer work. Write them down and keep them safe.</p>
                {/* English in every language: the browser's page translation may not rewrite them (#1947 confirmation N-B). */}
                <ol data-testid="web-rekey-word-list" translate="no" className="notranslate" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', listStyle: 'none', padding: 0 }}>
                    {(member.mnemonic ?? []).map((w, i) => (
                        <li key={i} style={{ padding: '0.3rem 0.5rem', borderRadius: '8px', border: '1px solid var(--border-primary, #333)', fontFamily: 'monospace' }}>{i + 1}. {w}</li>
                    ))}
                </ol>
                <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.75rem', fontSize: '0.9rem' }}>
                    <input type="checkbox" checked={wroteThemDown} onChange={(e) => setWroteThemDown(e.target.checked)} /> I’ve written my 12 words down
                </label>
                <button type="button" style={primary} onClick={() => setPhase('linkAgain')}>Continue</button>
            </div>
        );
    }
    if (phase === 'linkAgain' && member && !linkSignInAgain) {
        return (
            <div data-testid="web-rekey-done">
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>You’re in</h3>
                <p style={{ fontSize: '0.9rem', lineHeight: 1.5 }}>This device now holds your account: your Beans, your name and your history.</p>
                <button type="button" style={primary} onClick={() => onBound(member)}>Continue</button>
            </div>
        );
    }
    if (phase === 'linkAgain' && member) {
        return (
            <div data-testid="web-rekey-link-again">
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>Link your sign-in again</h3>
                <p style={{ fontSize: '0.9rem', lineHeight: 1.5 }}>A sign-in you had linked protected your old key, so it was removed. Link it again in Settings, so you can get back in if you lose this device.</p>
                <button type="button" style={primary} onClick={() => onBound(member)}>Continue</button>
            </div>
        );
    }
    return (
        <div data-testid="web-rekey-form">
            <h3 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: '0.35rem' }}>🪪 An admin gave me a re-key code</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', lineHeight: 1.5 }}>
                Lost your phone and your 12 words? An admin of this community checked it’s you and made a code. This device takes over your account: your Beans, your name and your history.
            </p>
            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 700, marginTop: '0.75rem', marginBottom: '0.25rem' }} htmlFor="web-rekey-code">The code</label>
            <input id="web-rekey-code" style={box} value={code} onChange={(e) => setCode(e.target.value)} placeholder="RK-XXXX-XXXX" autoCapitalize="characters" autoComplete="off" spellCheck={false} />
            {error && <p role="alert" style={{ color: '#dc2626', fontSize: '0.85rem', marginTop: '0.5rem', lineHeight: 1.5 }}>{error}</p>}
            <button type="button" style={primary} onClick={ask} disabled={phase === 'asking'}>{phase === 'asking' ? 'One moment…' : 'Continue'}</button>
            <button type="button" style={secondary} onClick={onBack}>← Back</button>
        </div>
    );
}
