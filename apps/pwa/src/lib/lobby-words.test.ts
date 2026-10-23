/**
 * The lobby's and the examples' sentences (lib/visitor-lobby.ts, lib/example-listings.ts, components/VisitorListing.tsx's
 * labels) in the member's language: what a stranger reads first. In English each is exactly as before; in Portuguese
 * from a catalog that has it; in the pseudo-locale bracketed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { pseudoLocalise, setLanguage } from '@beanpool/core';
import { VISITOR_WORDS, composerVisitorNote, visitorDistanceText, visitorKmText, visitorPriceText } from './visitor-lobby';
import { EXAMPLE_LISTINGS, exampleLabel } from './example-listings';
import { joinToSeeLabel } from '../components/VisitorListing';
import type { MarketplacePost } from './api';

afterEach(() => setLanguage('en'));

const post = (over: Partial<MarketplacePost>): MarketplacePost => ({ id: 'p', type: 'offer', title: 'Sourdough', category: 'food', credits: 5, priceType: 'fixed', ...over }) as MarketplacePost;

describe('the lobby\'s terms, distance and notes', () => {
    it('in English as the lobby always wrote them', () => {
        expect(visitorPriceText(post({}), true)).toBe('5 Beans');
        expect(visitorPriceText(post({ credits: 1, priceType: 'hourly' }), true)).toBe('1 Beans an hour');
        expect(visitorPriceText(post({ credits: 0 }), true)).toBe('Free');
        expect(visitorPriceText(post({}), false)).toBe('Free, a swap, or ask');
        expect(visitorDistanceText(10.6)).toBe('about 11 km');
        expect(visitorDistanceText(0.2)).toBe('about 1 km');
        expect(visitorKmText(10.6)).toBe('11 km');
        expect(composerVisitorNote('global')).toBe("Visitors to the global community can see this listing's photos and its rough area before they join.");
        expect(joinToSeeLabel(post({ type: 'need' }))).toBe("Join to see who's asking");
    });

    it('in Portuguese from a catalog that has them', () => {
        setLanguage('pt', [{
            '{n} Beans a week|{n} Beans a week': { one: '{n} Bean por semana', other: '{n} Beans por semana' },
            'Free, a swap, or ask': 'Grátis, uma troca, ou pergunte',
            'about {km} km': 'a cerca de {km} km',
            "Visitors to this community can see this listing's photos and its rough area before they join.": 'Quem visita esta comunidade vê as fotos deste anúncio e a zona aproximada antes de entrar.',
            "Join to see who's offering": 'Entre para ver quem oferece',
            [VISITOR_WORDS.placeAfterJoin]: 'O local aparece depois de entrar',
        }]);
        expect(visitorPriceText(post({ credits: 3, priceType: 'weekly' }), true)).toBe('3 Beans por semana');
        expect(visitorPriceText(post({}), false)).toBe('Grátis, uma troca, ou pergunte');
        expect(visitorDistanceText(10.6)).toBe('a cerca de 11 km');
        expect(composerVisitorNote('local')).toBe('Quem visita esta comunidade vê as fotos deste anúncio e a zona aproximada antes de entrar.');
        expect(joinToSeeLabel(post({}))).toBe('Entre para ver quem oferece');
    });

    it('in the pseudo-locale, bracketed', () => {
        setLanguage('xx');
        for (const s of [visitorPriceText(post({ priceType: 'monthly' }), true), visitorPriceText(post({}), false), visitorDistanceText(4), joinToSeeLabel(post({ type: 'poll' }))]) {
            expect(s).toMatch(/^\[.*\]$/);
        }
    });
});

describe('the example cards\' words', () => {
    it('a screen reader\'s line in English as before, and in Portuguese where the catalog has the title, description and line', () => {
        const seedlings = EXAMPLE_LISTINGS[0];
        expect(exampleLabel(seedlings)).toBe('Example, not a real listing. Offer: Vegetable seedlings to give away. More than I can plant. Free to anyone who will grow them.');
        setLanguage('pt', [{
            'Example, not a real listing. Offer: {title}. {description}': 'Exemplo, não é um anúncio real. Oferta: {title}. {description}',
            [seedlings.title]: 'Mudas de legumes para dar',
            [seedlings.description]: 'Mais do que consigo plantar. Grátis para quem as for cultivar.',
        }]);
        expect(exampleLabel(seedlings)).toBe('Exemplo, não é um anúncio real. Oferta: Mudas de legumes para dar. Mais do que consigo plantar. Grátis para quem as for cultivar.');
        setLanguage('xx');
        for (const e of EXAMPLE_LISTINGS) expect(exampleLabel(e)).toBe(pseudoLocalise(`Example, not a real listing. ${e.type === 'offer' ? 'Offer' : 'Need'}: {title}. {description}`)
            .replace('{title}', pseudoLocalise(e.title)).replace('{description}', pseudoLocalise(e.description)));
    });
});
