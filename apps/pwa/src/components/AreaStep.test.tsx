/**
 * The area step's town search (deciding review of #1766, N3): the Map's AddressSearch, given the area step's own words.
 * There is no map on this step, so nothing it says may mention a map or a pin; the box asks for a town or suburb, not
 * a street address, for a 10 km area; and a match reads "Choose <place>" to a screen reader. The event form's words are
 * unchanged. Nominatim is a stubbed fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AREA_TOWN_SEARCH_WORDS } from '@beanpool/core';
import { AreaStep } from './AreaStep';
import { AddressSearch } from './AddressSearch';

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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
