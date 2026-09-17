/**
 * One way to post. The Market tab's + and the map's + render the same `NEW_POST_TYPES` through the same
 * NewPostTypeSheet, so holding this list to all four types holds BOTH compose entries to them — the map's
 * + used to open an Offer/Need-only sheet, and that is the regression these tests exist to catch.
 */

import { describe, it, expect } from 'vitest';
import {
    NEW_POST_TYPES,
    composeCarriesPin,
    composeOptionA11yLabel,
    composeTargetFor,
    parseNewPostParam,
    type ComposePostType,
} from '../compose-options';

describe('the compose chooser', () => {
    it('offers all four post types, in order', () => {
        expect(NEW_POST_TYPES.map(o => o.id)).toEqual(['offer', 'need', 'poll', 'event']);
    });

    it('words each one the way the Market tab always has', () => {
        expect(NEW_POST_TYPES.map(o => o.title)).toEqual(['Offer', 'Need', 'Community Poll', 'Event']);
        expect(NEW_POST_TYPES.map(o => o.description)).toEqual([
            'List goods, skills, food, or tools on the map',
            'Ask your neighbours for something you need',
            'Ask a question with 2–4 options in the feed',
            'A gathering with a time and a place',
        ]);
    });

    it('gives every row an emoji and a screen-reader label', () => {
        for (const option of NEW_POST_TYPES) {
            expect(option.emoji).not.toBe('');
            expect(composeOptionA11yLabel(option)).toBe(`${option.title}: ${option.description}`);
        }
    });

    it('lists each type exactly once', () => {
        expect(new Set(NEW_POST_TYPES.map(o => o.id)).size).toBe(NEW_POST_TYPES.length);
    });
});

describe('which form a choice opens', () => {
    it('sends Offer and Need to the map sheet, and Poll and Event to their own modals', () => {
        expect(composeTargetFor('offer')).toBe('offer-need-form');
        expect(composeTargetFor('need')).toBe('offer-need-form');
        expect(composeTargetFor('poll')).toBe('poll-modal');
        expect(composeTargetFor('event')).toBe('event-modal');
    });

    it('has a form for every type it offers', () => {
        for (const option of NEW_POST_TYPES) {
            expect(composeTargetFor(option.id)).toBeTruthy();
        }
    });
});

describe('carrying an already-dropped pin', () => {
    it('carries into Offer, Need and Event', () => {
        expect(composeCarriesPin('offer')).toBe(true);
        expect(composeCarriesPin('need')).toBe(true);
        expect(composeCarriesPin('event')).toBe(true);
    });

    // The maintainer's call, 2026-09-18: a poll stays in the list and is still offered on the map.
    it('never carries into a Poll, which has no pin', () => {
        expect(composeCarriesPin('poll')).toBe(false);
    });
});

describe('the ?newPost= deep link', () => {
    it('still opens the chooser for newPost=true', () => {
        expect(parseNewPostParam('true')).toBe('chooser');
    });

    it('opens a named type straight into its form, so the Market tab does not bounce into a second chooser', () => {
        for (const option of NEW_POST_TYPES) {
            expect(parseNewPostParam(option.id)).toBe(option.id);
        }
    });

    it('does nothing for a blank, cleared or unknown value', () => {
        expect(parseNewPostParam('')).toBeNull();
        expect(parseNewPostParam(undefined)).toBeNull();
        expect(parseNewPostParam(null)).toBeNull();
        expect(parseNewPostParam('false')).toBeNull();
        expect(parseNewPostParam('offers')).toBeNull();
        expect(parseNewPostParam('OFFER')).toBeNull();
    });
});

describe('the whole compose entry, end to end', () => {
    // What the map's + does: chooser → a type → a form. Every type has to land somewhere real.
    it('routes every offered type to a form, and only Poll arrives without a pin', () => {
        const landed = NEW_POST_TYPES.map(o => ({
            id: o.id as ComposePostType,
            target: composeTargetFor(o.id),
            pin: composeCarriesPin(o.id),
        }));
        expect(landed).toEqual([
            { id: 'offer', target: 'offer-need-form', pin: true },
            { id: 'need', target: 'offer-need-form', pin: true },
            { id: 'poll', target: 'poll-modal', pin: false },
            { id: 'event', target: 'event-modal', pin: true },
        ]);
    });
});
