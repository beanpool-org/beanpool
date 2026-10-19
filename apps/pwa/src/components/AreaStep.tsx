/**
 * "Roughly where are you?" (design DESIGN-global-sync-by-area §3.2): the signup's Your Area step after the photo on a
 * community that syncs listings by area (pages/WelcomePage.tsx), and Settings → Your area. The same words as
 * the phone's (@beanpool/core AREA_STEP_WORDS).
 *
 * Use my location takes one low-accuracy reading and rounds it to 0.1° before the request is built (lib/member-area.ts);
 * Type a town is the Map's AddressSearch in the step's own words (no map, no pin; a town or suburb), rounded the same
 * way. Skip writes nothing. A refusal or a failed save says so in one line and never blocks: Skip is always there, even
 * while the reading or the save waits, and leaving (Skip, Back, the step closing) drops whatever answers later. A town
 * picked while a reading or a save waits drops that too: the newest choice wins. The reading (20 s) and the save
 * (lib/member-area.ts) have time limits that end in the same one line.
 *
 * Small screens: three stacked full-width controls, each at least 44px tall; holds at 320px and 130% text.
 *
 * Every word on it is drawn through t() in the member's language: core's word() keys, the town search's, and
 * lib/member-area.ts's failure sentences, matched where they are shown (areaFailureWords), as the phone's AreaPicker does.
 */
import { useEffect, useRef, useState } from 'react';
import { AREA_STEP_WORDS, AREA_TOWN_SEARCH_WORDS, areaWhyLine, t, word, type AddressResult, type AddressSearchWords } from '@beanpool/core';
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

/**
 * lib/member-area.ts's own failure sentences (a reading refused or unavailable, a place that can't be read, the community
 * out of reach or saying no), each drawn in the member's language here, where it is shown. Anything else is the
 * community's own sentence (or the standing refusal's, already translated), shown as it came.
 */
const AREA_FAILURES = {
    noLocation: word("This browser can't share a location. Type a town instead, or skip for now."),
    locationOff: word('Location is off for this site. Type a town instead, or skip for now.'),
    unreadableLocation: word("Couldn't read your location. Type a town instead, or skip for now."),
    unreadablePlace: word("That place couldn't be read. Try again or type a town."),
    unreachable: word("Couldn't reach the community. Check your connection and try again."),
} as const;
const REFUSED = /^The community said no \((\d+)\)\. Try again later\.$/;

/** A failed reading's or save's line (readBrowserPosition's message, writeArea's `error`), in the member's language. */
export function areaFailureWords(error: string): string {
    for (const k of Object.keys(AREA_FAILURES) as (keyof typeof AREA_FAILURES)[]) if (error === AREA_FAILURES[k]) return t(AREA_FAILURES[k]);
    const refused = REFUSED.exec(error);
    if (refused) return t('The community said no ({status}). Try again later.', { status: refused[1] });
    return error;
}

const fullButton = {
    width: '100%', minHeight: '44px', padding: '0.75rem', borderRadius: '10px', fontSize: '1rem', fontWeight: 600,
    fontFamily: 'inherit', display: 'block', boxSizing: 'border-box' as const, marginBottom: '0.6rem',
};

export function AreaStep({ send, limits, onSaved, onSkip, skipLabel, hideTitle }: AreaStepProps) {
    const [busy, setBusy] = useState<'location' | 'town' | null>(null);
    const [showTown, setShowTown] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Skip, Back and the step closing move this on: a reading or an answer that comes after is dropped, so nothing is
    // sent and onSaved isn't called once the member has gone on (review B2).
    const generation = useRef(0);
    const saving = useRef<AbortController | null>(null);
    const drop = () => {
        generation.current += 1;
        saving.current?.abort();
        saving.current = null;
    };
    useEffect(() => drop, []);

    const save = async (point: { lat: number; lng: number }, placeName: string | null, kind: 'location' | 'town', gen: number) => {
        setBusy(kind);
        setError(null);
        const stop = new AbortController();
        saving.current = stop;
        const result = await writeArea(send, point, { signal: stop.signal });
        if (gen !== generation.current) return;
        if (saving.current === stop) saving.current = null;
        setBusy(null);
        if (result.ok) onSaved(result.area, placeName);
        else setError(areaFailureWords(result.error));
    };

    const useMyLocation = async () => {
        const gen = generation.current;
        setError(null);
        setBusy('location');
        try {
            const p = await readBrowserPosition();
            if (gen !== generation.current) return;
            await save(p, null, 'location', gen);
        } catch (e) {
            if (gen !== generation.current) return;
            setBusy(null);
            setError(e instanceof Error && e.message ? areaFailureWords(e.message) : t(AREA_FAILURES.unreadableLocation));
        }
    };

    // The town box stays open while Use my location waits, so a town can be picked then. It drops the reading or the
    // save under way: the node never keeps the reading's area while this browser names the town (review N8).
    const pickTown = (r: AddressResult) => {
        drop();
        void save({ lat: r.lat, lng: r.lng }, r.shortName || r.displayName, 'town', generation.current);
    };

    const skip = () => {
        drop();
        setBusy(null);
        onSkip();
    };

    // Made in each render, so a language change redraws the town box in the new language.
    const townWords: AddressSearchWords = {
        label: t(AREA_TOWN_SEARCH_WORDS.label),
        placeholder: t(AREA_TOWN_SEARCH_WORDS.placeholder),
        unavailable: t(AREA_TOWN_SEARCH_WORDS.unavailable),
        noMatches: t(AREA_TOWN_SEARCH_WORDS.noMatches),
        source: t(AREA_TOWN_SEARCH_WORDS.source),
        pickLabel: AREA_TOWN_SEARCH_WORDS.pickLabel,
    };

    return (
        <div data-testid="area-step">
            {!hideTitle && <h3 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.5rem' }}>📍 <>{t(AREA_STEP_WORDS.title)}</></h3>}
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.5rem', lineHeight: 1.5 }}>{areaWhyLine(limits)}</p>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1rem', lineHeight: 1.5 }}>{t(AREA_STEP_WORDS.privacy)}</p>

            <button
                type="button"
                data-testid="area-use-location"
                onClick={useMyLocation}
                disabled={busy !== null}
                aria-busy={busy === 'location'}
                style={{ ...fullButton, border: 'none', background: busy ? 'var(--bp-neutral-fill)' : 'var(--bp-info-fill)', color: 'var(--bp-info-on)', cursor: busy ? 'not-allowed' : 'pointer' }}
            >
                {busy === 'location' ? t('Reading your location…') : <>📍 <>{t(AREA_STEP_WORDS.useLocation)}</></>}
            </button>
            <button
                type="button"
                data-testid="area-type-town"
                onClick={() => { setError(null); setShowTown((v) => !v); }}
                disabled={busy !== null}
                aria-expanded={showTown}
                style={{ ...fullButton, border: '1px solid var(--border-primary, #334155)', background: 'transparent', color: 'var(--text-primary)', cursor: busy ? 'not-allowed' : 'pointer' }}
            >
                🔎 <>{t(AREA_STEP_WORDS.typeTown)}</>
            </button>
            {showTown && (
                <div style={{ marginBottom: '0.6rem', textAlign: 'left' }}>
                    <AddressSearch onPick={pickTown} words={townWords} />
                    {busy === 'town' && <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{t('Saving your area…')}</p>}
                </div>
            )}

            {error && <p role="alert" style={{ color: 'var(--bp-ink-danger)', fontSize: '0.85rem', marginBottom: '0.6rem' }}>{error}</p>}

            <button
                type="button"
                data-testid="area-skip"
                onClick={skip}
                style={{ ...fullButton, border: 'none', background: 'none', color: 'var(--text-muted)', textDecoration: 'underline', cursor: 'pointer', fontSize: '0.95rem' }}
            >
                {skipLabel ?? t(AREA_STEP_WORDS.skip)}
            </button>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', lineHeight: 1.5, marginTop: '0.25rem' }}>{t(AREA_STEP_WORDS.later)}</p>
        </div>
    );
}
