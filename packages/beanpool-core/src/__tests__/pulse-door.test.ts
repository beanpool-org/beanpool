/**
 * The Pulse's door and its one add button (scratch/fable-design/DESIGN-pulse-home-fable.md §3.2, §3.4, §3.8; Marty's picks
 * of 14 Nov 2026): the words both apps draw the same, and who is offered Add to Pulse. On the worldwide community the
 * button waits until adding there has rules for new people (P5); a local community adds at once.
 */
import { describe, expect, it } from 'vitest';
import { PULSE_PAGE_WORDS, pulseAddsHere } from '../channels.js';

describe('the Pulse page (P2/P3)', () => {
    it('Add to Pulse on a local community at once, and while the profile is not heard yet; never on the worldwide one', () => {
        expect(pulseAddsHere('local')).toBe(true);
        expect(pulseAddsHere(null)).toBe(true);
        expect(pulseAddsHere(undefined)).toBe(true);
        expect(pulseAddsHere('global')).toBe(false);
    });

    it('the words: one add button, Your channels, and a quiet week that asks nothing and points at How it works', () => {
        expect(PULSE_PAGE_WORDS).toEqual({
            add: 'Add to Pulse',
            yourChannels: 'Your channels',
            quietTitle: 'Nothing new this week.',
            quietBody: 'Have a video, a song, a blog or photos of your own? Add a link and your neighbours see it here.',
            // One pair for both apps: "Learn" is the Local knowledge place, so the lines name How it works as it reads there,
            // the web's chip and the phone's lane (review of 24850a67; the phone's Learn lane renamed in slice KP). The
            // worldwide community, where nothing is asked to be added yet (§3.8), gets the second: the videos lead.
            learnLineWeb: 'Nothing to add? Tap {chip} for short videos about BeanPool.',
            learnGlobalWeb: 'Tap {chip} for short videos about BeanPool.',
        });
        expect(PULSE_PAGE_WORDS.learnLineWeb).not.toMatch(/Learn/);
        expect(PULSE_PAGE_WORDS.learnGlobalWeb).not.toMatch(/Learn/);
        // A quiet week asks nothing of the member: no Beans, no steps, nothing they must do.
        for (const w of Object.values(PULSE_PAGE_WORDS)) expect(w).not.toMatch(/Beans|must|step|Ʀ/);
    });
});
