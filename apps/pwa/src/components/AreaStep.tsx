/**
 * "Roughly where are you?" (design DESIGN-global-sync-by-area §3.2): the signup's Your Area step after the photo on a
 * community that syncs listings by area (pages/WelcomePage.tsx), and Settings → Your area → Change. The same words as
 * the phone's (@beanpool/core AREA_STEP_WORDS).
 *
 * Use my location takes one low-accuracy reading and rounds it to 0.1° before the request is built (lib/member-area.ts);
 * Type a town is the Map's AddressSearch, rounded the same way. Skip writes nothing. A refusal or a failed save says so
 * in one line and never blocks: Skip is always there.
 *
 * Small screens: three stacked full-width controls, each at least 44px tall; holds at 320px and 130% text.
 */
import { useState } from 'react';
import { AREA_STEP_WORDS, areaWhyLine, type AddressResult } from '@beanpool/core';
import { AddressSearch } from './AddressSearch';
import { readBrowserPosition, writeArea, type AreaSender, type MemberArea } from '../lib/member-area';

interface AreaStepProps {
    send: AreaSender;
    limits?: { radiusKm: number; max: number } | null;
    onSaved: (area: MemberArea | null, placeName: string | null) => void;
    onSkip: () => void;
    skipLabel?: string;
    /** Settings shows its own heading. */
    hideTitle?: boolean;
}

const fullButton = {
    width: '100%', minHeight: '44px', padding: '0.75rem', borderRadius: '10px', fontSize: '1rem', fontWeight: 600,
    fontFamily: 'inherit', display: 'block', boxSizing: 'border-box' as const, marginBottom: '0.6rem',
};

export function AreaStep({ send, limits, onSaved, onSkip, skipLabel = AREA_STEP_WORDS.skip, hideTitle }: AreaStepProps) {
    const [busy, setBusy] = useState<'location' | 'town' | null>(null);
    const [showTown, setShowTown] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const save = async (point: { lat: number; lng: number }, placeName: string | null, kind: 'location' | 'town') => {
        setBusy(kind);
        setError(null);
        const result = await writeArea(send, point);
        setBusy(null);
        if (result.ok) onSaved(result.area, placeName);
        else setError(result.error);
    };

    const useMyLocation = async () => {
        setError(null);
        setBusy('location');
        try {
            const p = await readBrowserPosition();
            await save(p, null, 'location');
        } catch (e) {
            setBusy(null);
            setError(e instanceof Error ? e.message : "Couldn't read your location. Type a town instead, or skip for now.");
        }
    };

    const pickTown = (r: AddressResult) => { void save({ lat: r.lat, lng: r.lng }, r.shortName || r.displayName, 'town'); };

    return (
        <div data-testid="area-step">
            {!hideTitle && <h3 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.5rem' }}>📍 {AREA_STEP_WORDS.title}</h3>}
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.5rem', lineHeight: 1.5 }}>{areaWhyLine(limits)}</p>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1rem', lineHeight: 1.5 }}>{AREA_STEP_WORDS.privacy}</p>

            <button
                type="button"
                data-testid="area-use-location"
                onClick={useMyLocation}
                disabled={busy !== null}
                aria-busy={busy === 'location'}
                style={{ ...fullButton, border: 'none', background: busy ? '#555' : '#2563eb', color: '#fff', cursor: busy ? 'not-allowed' : 'pointer' }}
            >
                {busy === 'location' ? 'Reading your location…' : `📍 ${AREA_STEP_WORDS.useLocation}`}
            </button>
            <button
                type="button"
                data-testid="area-type-town"
                onClick={() => { setError(null); setShowTown((v) => !v); }}
                disabled={busy !== null}
                aria-expanded={showTown}
                style={{ ...fullButton, border: '1px solid var(--border-primary, #334155)', background: 'transparent', color: 'var(--text-primary)', cursor: busy ? 'not-allowed' : 'pointer' }}
            >
                🔎 {AREA_STEP_WORDS.typeTown}
            </button>
            {showTown && (
                <div style={{ marginBottom: '0.6rem', textAlign: 'left' }}>
                    <AddressSearch onPick={pickTown} />
                    {busy === 'town' && <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Saving your area…</p>}
                </div>
            )}

            {error && <p role="alert" style={{ color: '#ef4444', fontSize: '0.85rem', marginBottom: '0.6rem' }}>{error}</p>}

            <button
                type="button"
                data-testid="area-skip"
                onClick={onSkip}
                disabled={busy !== null}
                style={{ ...fullButton, border: 'none', background: 'none', color: 'var(--text-muted)', textDecoration: 'underline', cursor: 'pointer', fontSize: '0.95rem' }}
            >
                {skipLabel}
            </button>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', lineHeight: 1.5, marginTop: '0.25rem' }}>{AREA_STEP_WORDS.later}</p>
        </div>
    );
}
