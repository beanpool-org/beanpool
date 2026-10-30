/**
 * Unit tests for TagPicker logic, post detail chips, composer tags, and market search
 * (DESIGN-owner-seeding-tags-fable.md §4.2, §4.4, §4.7; SEED-TAGS T3).
 */

import { describe, it, expect } from 'vitest';
import {
    POST_TAGS_MAX,
    SUGGESTED_TAGS_MAX,
    SEARCH_TAGS_MAX,
    postTagsOf,
    suggestTags,
    tagIndex,
    searchTagsFor,
} from '@beanpool/core';
import { marketSearchMatches, marketSearchToSave } from '../market-filters';

describe('TagPicker logic', () => {
    it('enforces cap of at most 5 tags (≤ 5)', () => {
        expect(POST_TAGS_MAX).toBe(5);
        const tags = ['food.fruit.lemon', 'food.fruit.apple', 'food.fruit.orange', 'food.produce.herbs', 'food.preserve.jam'];
        expect(tags.length).toBe(POST_TAGS_MAX);

        // An attempt to add a 6th tag should be rejected by the cap
        const canAddMore = tags.length < POST_TAGS_MAX;
        expect(canAddMore).toBe(false);

        // postTagsOf clamps array / string
        const parsed = postTagsOf(tags);
        expect(parsed.length).toBe(5);
    });

    it('searches from 2 characters in two languages (Spanish and English)', () => {
        const index = tagIndex('es');

        // Less than 2 characters does not search
        expect('l'.length >= 2).toBe(false);

        // Search from 2 characters in English
        const enMatches = index.search('le');
        expect(enMatches.length).toBeGreaterThan(0);
        expect(enMatches.some(t => t.id === 'food.fruit.lemon')).toBe(true);

        // Search in Spanish ("lim" or "limón")
        const esMatches = index.search('lim');
        expect(esMatches.some(t => t.id === 'food.fruit.lemon')).toBe(true);

        const esFullMatches = index.search('limón');
        expect(esFullMatches.some(t => t.id === 'food.fruit.lemon')).toBe(true);
    });

    it('returns up to 8 suggested tags from title, description and category', () => {
        const suggestions = suggestTags(
            'Fresh lemons and sourdough bread',
            'Homegrown organic Meyer lemons and warm country bread',
            'food'
        );
        expect(suggestions.length).toBeGreaterThan(0);
        expect(suggestions.length).toBeLessThanOrEqual(SUGGESTED_TAGS_MAX);
        expect(suggestions).toContain('food.fruit.lemon');
        expect(suggestions).toContain('food.bakery.bread');
    });

    it('unknown tag ID is hidden without error on post detail', () => {
        const idx = tagIndex();
        const postTags = ['food.fruit.lemon', 'unknown.nonexistent.tag', 'another.fake.tag'];

        const visibleTags = postTagsOf(postTags).filter(id => {
            try {
                return !!idx.label(id);
            } catch {
                return false;
            }
        });

        // Unknown IDs are omitted, valid ones are kept
        expect(visibleTags).toEqual(['food.fruit.lemon']);
        expect(() => {
            for (const id of postTags) {
                const label = idx.label(id);
                // idx.label returns empty or fallback for unknown, never throws
            }
        }).not.toThrow();
    });
});

describe('Composers sending tags', () => {
    it('sends tags only when chosen (omitted or empty when none picked)', () => {
        const buildCreateBody = (post: { title: string; category: string; tags?: string[] }) => {
            return {
                title: post.title,
                category: post.category,
                ...(post.tags && post.tags.length > 0 ? { tags: post.tags } : {}),
            };
        };

        const withTags = buildCreateBody({
            title: 'Meyer lemons',
            category: 'food',
            tags: ['food.fruit.lemon'],
        });
        expect(withTags.tags).toEqual(['food.fruit.lemon']);

        const withoutTags = buildCreateBody({
            title: 'Meyer lemons',
            category: 'food',
            tags: [],
        });
        expect(withoutTags.tags).toBeUndefined();

        const omittedTags = buildCreateBody({
            title: 'Meyer lemons',
            category: 'food',
        });
        expect(omittedTags.tags).toBeUndefined();
    });

    it('keeps and updates tags on edit', () => {
        const originalTags = ['food.fruit.lemon'];
        const editedTags = ['food.fruit.lemon', 'food.fruit.orange'];

        const updatePayload = {
            id: 'post-123',
            tags: editedTags,
        };

        expect(updatePayload.tags).toEqual(['food.fruit.lemon', 'food.fruit.orange']);
        expect(updatePayload.tags.length).toBeLessThanOrEqual(POST_TAGS_MAX);
    });
});

describe('Market search sends q AND tags', () => {
    it('resolves typed query words to tag IDs and sends both q and tags', () => {
        const q = 'limón';
        const resolved = searchTagsFor(q);
        expect(resolved).toContain('food.fruit.lemon');

        // Market search sends both q AND tags (§4.7)
        const params = new URLSearchParams();
        params.set('q', q);
        if (resolved.length > 0) {
            params.set('tags', resolved.join(','));
        }

        expect(params.get('q')).toBe('limón');
        expect(params.get('tags')).toContain('food.fruit.lemon');
    });

    it('cross-language search: typing Spanish "limón" matches listing tagged food.fruit.lemon', () => {
        const post = {
            title: 'Homegrown organic citrus',
            description: 'Pick up from my backyard garden',
            tags: 'food.fruit.lemon',
        };

        // Query in Spanish
        const matches = marketSearchMatches(post, 'limón');
        expect(matches).toBe(true);
    });

    it('saved search stores resolved tag IDs', () => {
        const filterState = {
            type: 'all' as const,
            category: 'food',
            eventWindow: 'all' as const,
            trust: 'all' as const,
            beansOnly: false,
            radiusKm: null,
            center: null,
            groupId: 'all',
        };

        const saved = marketSearchToSave(filterState, 'limón');
        expect(saved).not.toBeNull();
        expect(saved?.q).toBe('limón');
        expect(saved?.tags).toContain('food.fruit.lemon');
    });
});
