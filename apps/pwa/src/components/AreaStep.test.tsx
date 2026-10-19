/**
 * The area step's town search (deciding review of #1766, N3): the Map's AddressSearch, given the area step's own words.
 * There is no map on this step, so nothing it says may mention a map or a pin; the box asks for a town or suburb, not
 * a street address, for a 10 km area; and a match reads "Choose <place>" to a screen reader. The event form's words are
 * unchanged. Nominatim is a stubbed fetch.
 *
 * And the step in the member's language (words W3): every word it draws, its town box's and its failure lines came
 * through t(), checked in the pseudo-locale.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { AREA_STEP_WORDS, AREA_TOWN_SEARCH_WORDS } from '@beanpool/core';
import { AreaStep, areaFailureWords } from './AreaStep';
import { AddressSearch } from './AddressSearch';
import { readBrowserPosition, senderForKey, writeArea, type AreaWriteResult } from '../lib/member-area';
import { backToEnglish, bypassing, showIn, xx } from '../words-xx.test-support';

const BYRON = { lat: '-28.6474', lon: '153.6120', display_name: 'Byron Bay, Byron Shire Council, New South Wales, Australia', name: 'Byron Bay', type: 'town' };
const MAP_OR_PIN = /\b(map|pin)\b/i;
let nominatim: 'byron' | 'none' | 'down' = 'byron';

beforeEach(() => {
    nominatim = 'byron';
    vi.stubGlobal('fetch', vi.fn(async () => {
        if (nominatim === 'down') throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify(nominatim === 'byron' ? [BYRON] : []), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
});
afterEach(() => { cleanup(); backToEnglish(); vi.unstubAllGlobals(); });

function openAreaSearch() {
    render(<AreaStep send={async () => ({})} onSaved={() => {}} onSkip={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Type a town or suburb/ }));
    return screen.getByLabelText('Find your town or suburb') as HTMLInputElement;
}
function search(input: HTMLInputElement, text: string) {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: 'Enter' });
}

describe("the area step's town search (review N3)", () => {
    it('asks for a town or suburb, and says nothing about a map or a pin', () => {
        const input = openAreaSearch();
        expect(input.placeholder).toBe('Town or suburb');
        expect(screen.getByTestId('area-step').textContent).not.toMatch(MAP_OR_PIN);
    });

    it('a match reads "Choose <place>" to a screen reader', async () => {
        search(openAreaSearch(), 'Byron');
        expect(await screen.findByRole('option', { name: 'Choose Byron Bay, Byron Shire Council, New South Wales, Australia' })).toBeInTheDocument();
        expect(within(screen.getByTestId('area-step')).getByRole('listbox').outerHTML).not.toMatch(MAP_OR_PIN);
    });

    it('no matches, or the search down: one line each, neither about a map or a pin', async () => {
        nominatim = 'none';
        search(openAreaSearch(), 'Nowhere');
        expect(await screen.findByText(AREA_TOWN_SEARCH_WORDS.noMatches)).toBeInTheDocument();
        expect(screen.getByTestId('area-step').textContent).not.toMatch(MAP_OR_PIN);
        cleanup();
        nominatim = 'down';
        search(openAreaSearch(), 'Byron');
        expect(await screen.findByText(AREA_TOWN_SEARCH_WORDS.unavailable)).toBeInTheDocument();
        expect(screen.getByTestId('area-step').textContent).not.toMatch(MAP_OR_PIN);
    });

    it("the event form's search keeps its own words", async () => {
        render(<AddressSearch onPick={() => {}} />);
        const input = screen.getByLabelText('Find an address') as HTMLInputElement;
        expect(input.placeholder).toBe('Street and town, or a place');
        search(input, 'Byron');
        const option = await screen.findByRole('option', { name: /Byron Bay/ });
        expect(option.getAttribute('aria-label')).toBeNull();
    });
});

describe('the area step in the member\'s language (words W3)', () => {
    const PLACES = [BYRON.display_name, BYRON.name];

    it('the step and its town box: a match, no matches and the search down, every word through t()', async () => {
        await showIn('xx');
        render(<AreaStep send={async () => ({})} limits={{ radiusKm: 100, max: 300 }} onSaved={() => {}} onSkip={() => {}} />);
        const step = screen.getByTestId('area-step');
        expect(within(step).getByText(`📍 ${xx(AREA_STEP_WORDS.title)}`)).toBeInTheDocument();
        expect(within(step).getByText(xx(AREA_STEP_WORDS.privacy))).toBeInTheDocument();
        expect(within(step).getByRole('button', { name: xx(AREA_STEP_WORDS.skip) })).toBeInTheDocument();
        expect(within(step).getByText(xx(AREA_STEP_WORDS.later))).toBeInTheDocument();
        expect(bypassing(step)).toEqual([]);

        fireEvent.click(within(step).getByTestId('area-type-town'));
        const input = within(step).getByLabelText(xx(AREA_TOWN_SEARCH_WORDS.label)) as HTMLInputElement;
        expect(input.placeholder).toBe(xx(AREA_TOWN_SEARCH_WORDS.placeholder));
        expect(within(step).getByText(xx(AREA_TOWN_SEARCH_WORDS.source))).toBeInTheDocument();
        search(input, 'Byron');
        expect(await within(step).findByRole('option', { name: xx('Choose {place}').replace('{place}', BYRON.display_name) })).toBeInTheDocument();
        expect(within(step).getByRole('listbox', { name: xx('Address matches') })).toBeInTheDocument();
        expect(bypassing(step, { others: PLACES })).toEqual([]);

        // A fresh box each time (the lookup's 1 s floor is per box).
        for (const [answer, line] of [['none', AREA_TOWN_SEARCH_WORDS.noMatches], ['down', AREA_TOWN_SEARCH_WORDS.unavailable]] as const) {
            nominatim = answer;
            fireEvent.click(within(step).getByTestId('area-type-town'));
            fireEvent.click(within(step).getByTestId('area-type-town'));
            search(within(step).getByLabelText(xx(AREA_TOWN_SEARCH_WORDS.label)) as HTMLInputElement, 'Byron');
            expect(await within(step).findByText(xx(line))).toBeInTheDocument();
            expect(bypassing(step)).toEqual([]);
        }
    });

    it('a failed reading and a failed save say so in the member\'s language', async () => {
        await showIn('xx');
        render(<AreaStep send={async () => { throw new Error('unused'); }} onSaved={() => {}} onSkip={() => {}} />);
        // jsdom has no geolocation: the browser can't share a location.
        fireEvent.click(screen.getByTestId('area-use-location'));
        expect(await screen.findByRole('alert')).toHaveTextContent(xx("This browser can't share a location. Type a town instead, or skip for now."));
        expect(bypassing(screen.getByTestId('area-step'))).toEqual([]);
        cleanup();
        // The save never answers, so it ends in "couldn't reach the community" once it is stopped.
        render(<AreaStep send={() => new Promise(() => {})} onSaved={() => {}} onSkip={() => {}} />);
        fireEvent.click(screen.getByTestId('area-type-town'));
        search(screen.getByLabelText(xx(AREA_TOWN_SEARCH_WORDS.label)) as HTMLInputElement, 'Byron');
        fireEvent.click(await screen.findByRole('option', { name: xx('Choose {place}').replace('{place}', BYRON.display_name) }));
        expect(await screen.findByText(xx('Saving your area…'))).toBeInTheDocument();
        expect(bypassing(screen.getByTestId('area-step'), { others: PLACES })).toEqual([]);
    });

    it("the failure lines are lib/member-area.ts's, line for line; the community's own sentence stays as it came", async () => {
        const seed = new Uint8Array(32).fill(7);
        const failure = async (r: Promise<AreaWriteResult>) => {
            const result = await r;
            expect(result.ok).toBe(false);
            return result.ok ? '' : result.error;
        };
        const reading = async (geolocation?: unknown) => {
            if (geolocation) vi.stubGlobal('navigator', { ...navigator, geolocation });
            try { await readBrowserPosition(); } catch (e) { return (e as Error).message; } finally { vi.unstubAllGlobals(); }
            throw new Error('the reading did not fail');
        };
        const refusing = () => { vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 }))); };
        const sentences = [
            await reading(),
            await reading({ getCurrentPosition: (_ok: unknown, fail: (e: { code: number }) => void) => fail({ code: 1 }) }),
            await reading({ getCurrentPosition: (_ok: unknown, fail: (e: { code: number }) => void) => fail({ code: 2 }) }),
            await failure(writeArea(async () => ({}), { lat: Number.NaN, lng: 1 })),
            await failure(writeArea(() => new Promise(() => {}), { lat: 1, lng: 1 }, { timeoutMs: 5 })),
        ];
        refusing();
        sentences.push(await failure(writeArea(senderForKey(bytesToHex(seed), bytesToHex(ed25519.getPublicKey(seed))), { lat: 1, lng: 1 })));
        expect(sentences).toEqual([
            "This browser can't share a location. Type a town instead, or skip for now.",
            'Location is off for this site. Type a town instead, or skip for now.',
            "Couldn't read your location. Type a town instead, or skip for now.",
            "That place couldn't be read. Try again or type a town.",
            "Couldn't reach the community. Check your connection and try again.",
            'The community said no (403). Try again later.',
        ]);
        for (const s of sentences) expect(areaFailureWords(s), s).toBe(s);
        await showIn('xx');
        for (const s of sentences) expect(areaFailureWords(s), s).toMatch(/^\[.*\]$/s);
        expect(areaFailureWords('The community said no (403). Try again later.')).toBe(xx('The community said no ({status}). Try again later.').replace('{status}', '403'));
        // The community's own sentence stays as it came.
        expect(areaFailureWords('The node is busy.')).toBe('The node is busy.');
    });
});
