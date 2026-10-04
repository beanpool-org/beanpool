/**
 * Settings → the consent a known community asks for (community modes slice 6; lib/known-consent.ts). Shown only in a
 * known community, until the member agrees to the text it says now; never blocks anything. "Not now" hides it until
 * Settings opens again. Renders nothing for an older node, a guest, or offline.
 */
import { useEffect, useState } from 'react';
import { agreeToConsent, consentHeading, fetchMyConsent, shouldOfferConsent, type KnownConsent } from '../lib/known-consent';

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

    if (hidden || !consent || !shouldOfferConsent(consent)) return null;

    const agree = async () => {
        setBusy(true);
        setNote(null);
        try {
            const next = await agreeToConsent(consent.version);
            if (next) setConsent(next);
        } catch (e) {
            setNote(e instanceof Error && e.message ? e.message : 'Not saved. Try again later.');
        } finally {
            setBusy(false);
        }
    };

    const button: React.CSSProperties = {
        minHeight: 48, padding: '0 1rem', borderRadius: 10, fontFamily: 'inherit', fontSize: '0.9rem', cursor: 'pointer',
    };
    return (
        <section data-testid="known-consent-card" style={{
            border: '1px solid var(--border-color)', borderRadius: 12, padding: '1rem', marginBottom: '1rem',
            background: 'var(--bg-secondary)', overflowWrap: 'anywhere',
        }}>
            <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>{consentHeading(consent)}</h3>
            <p style={{ margin: '0 0 0.5rem', fontSize: '0.9rem', lineHeight: 1.45 }}>{consent.text}</p>
            <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', lineHeight: 1.45, color: 'var(--text-secondary)' }}>
                Agreeing is up to you. If you don&apos;t, nothing else changes: the admins just never see your balance.
            </p>
            {note && <p role="status" style={{ margin: '0 0 0.75rem', fontSize: '0.85rem' }}>{note}</p>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                <button type="button" onClick={() => { void agree(); }} disabled={busy} aria-busy={busy}
                    style={{ ...button, border: 'none', background: '#10b981', color: '#fff', fontWeight: 700 }}>
                    {busy ? 'Saving…' : 'I agree'}
                </button>
                <button type="button" onClick={() => setHidden(true)}
                    style={{ ...button, border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-primary)' }}>
                    Not now
                </button>
            </div>
        </section>
    );
}
