/**
 * Settings → the consent a known community asks for (community modes slice 6; lib/known-consent.ts). Offered only in a
 * known community, until the member agrees to the text it says now; never blocks anything. "Not now" hides the offer
 * until Settings opens again. Once agreed it stays: what they agreed to, when, and "Withdraw", as easy as agreeing
 * (GDPR Art. 7(3)). Renders nothing for an older node, a guest, or offline.
 */
import { useEffect, useState } from 'react';
import { agreeToConsent, canWithdrawConsent, consentHeading, fetchMyConsent, shouldOfferConsent, showsConsentCard, withdrawConsent, type KnownConsent } from '../lib/known-consent';
import { ConsentText } from './ConsentText';

export function KnownConsentCard() {
    const [consent, setConsent] = useState<KnownConsent | null>(null);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [hidden, setHidden] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void fetchMyConsent().then((c) => { if (!cancelled) setConsent(c); });
        return () => { cancelled = true; };
    }, []);

    if (!consent || !showsConsentCard(consent)) return null;
    const offer = shouldOfferConsent(consent);
    const agreed = canWithdrawConsent(consent);
    if (hidden && !agreed) return null;

    const send = async (go: () => Promise<KnownConsent | null>, done: string) => {
        setBusy(true);
        setNote(null);
        try {
            const next = await go();
            if (next) { setConsent(next); setNote(done); }
        } catch (e) {
            setNote(e instanceof Error && e.message ? e.message : 'Not saved. Try again later.');
        } finally {
            setBusy(false);
        }
    };
    const agree = () => send(() => agreeToConsent(consent.version), 'Saved. You can take it back here at any time.');
    const withdraw = () => send(withdrawConsent, 'Withdrawn. From now on the admins don\'t see your balance.');
    const agreedOn = consent.consentedAt ? new Date(consent.consentedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null;

    const button: React.CSSProperties = {
        minHeight: 48, padding: '0 1rem', borderRadius: 10, fontFamily: 'inherit', fontSize: '0.9rem', cursor: 'pointer',
    };
    return (
        <section data-testid="known-consent-card" style={{
            border: '1px solid var(--border-color)', borderRadius: 12, padding: '1rem', marginBottom: '1rem',
            background: 'var(--bg-secondary)', overflowWrap: 'anywhere',
        }}>
            <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>{offer ? consentHeading(consent) : 'What you agreed the admins can see'}</h3>
            <ConsentText text={consent.text} fontSize="0.9rem" />
            <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', lineHeight: 1.45, color: 'var(--text-secondary)' }}>
                {agreed
                    ? <>You agreed{agreedOn ? ` on ${agreedOn}` : ''}{offer ? ' to the earlier text' : ''}. You can take it back at any time: from that moment the admins don&apos;t see your balance.</>
                    : <>Agreeing is up to you. If you don&apos;t, nothing else changes: the admins just never see your balance. You can take it back at any time, here in Settings.</>}
            </p>
            {note && <p role="status" style={{ margin: '0 0 0.75rem', fontSize: '0.85rem' }}>{note}</p>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {offer && (
                    <button type="button" onClick={() => { void agree(); }} disabled={busy} aria-busy={busy}
                        className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
                        style={{ ...button, border: 'none', background: '#10b981', color: '#fff', fontWeight: 700 }}>
                        {busy ? 'Saving…' : 'I agree'}
                    </button>
                )}
                {agreed && (
                    <button type="button" onClick={() => { void withdraw(); }} disabled={busy} aria-busy={busy} data-testid="known-consent-withdraw"
                        className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
                        style={{ ...button, border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-primary)' }}>
                        {busy ? 'Saving…' : 'Withdraw'}
                    </button>
                )}
                {offer && !agreed && (
                    <button type="button" onClick={() => setHidden(true)}
                        className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
                        style={{ ...button, border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-primary)' }}>
                        Not now
                    </button>
                )}
            </div>
        </section>
    );
}
