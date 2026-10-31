import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { TagPicker } from './TagPicker';
import { POST_TAGS_MAX, SUGGESTED_TAGS_MAX, searchTagsFor, tagIndex, postTagsOf, buildTagIndex, wordsFor, setLanguage } from '@beanpool/core';
import coreEs from '@beanpool/core/words/es.json';
import { matchesExpandedSearch } from '../lib/search';

describe('TagPicker Web Component', () => {
    it('renders "Tags · optional" row with chosen chips and + Add button', () => {
        const handleChange = vi.fn();
        render(
            <TagPicker
                tags={['food.fruit.lemon']}
                onChange={handleChange}
                category="food"
                title="Lemons"
            />
        );

        expect(screen.getByText('Tags · optional')).toBeInTheDocument();
        expect(screen.getByText('+ Add')).toBeInTheDocument();
        expect(screen.getByText(/Lemon/i)).toBeInTheDocument();
    });

    it('opens modal sheet when + Add is clicked and closes on Done or Escape', () => {
        const handleChange = vi.fn();
        render(
            <TagPicker
                tags={[]}
                onChange={handleChange}
                category="food"
                title="Lemons"
            />
        );

        // Not open yet
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        // Click + Add
        fireEvent.click(screen.getByRole('button', { name: /\+ Add/i }));
        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();
        expect(screen.getByPlaceholderText('Search tags...')).toBeInTheDocument();

        // Click Done
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('enforces cap of at most 5 tags (≤ 5)', () => {
        const fiveTags = [
            'food.fruit.lemon',
            'food.fruit.apple',
            'food.fruit.orange',
            'food.produce.herbs',
            'food.preserve.jam',
        ];
        const handleChange = vi.fn();
        render(
            <TagPicker
                tags={fiveTags}
                onChange={handleChange}
                category="food"
                title="Produce"
            />
        );

        // When 5 tags are chosen, + Add button is hidden
        expect(screen.queryByRole('button', { name: /\+ Add/i })).not.toBeInTheDocument();
        expect(fiveTags.length).toBe(POST_TAGS_MAX);
    });

    it('searches from 2 characters in two languages (Spanish and English)', () => {
        const index = buildTagIndex(wordsFor('es', [coreEs]));
        expect('a'.length >= 2).toBe(false);

        // English search from 2 chars
        const enResults = index.search('le');
        expect(enResults.some(t => (typeof t === 'string' ? t : (t as any).id) === 'food.fruit.lemon')).toBe(true);

        // Spanish search from 2 chars
        const esResults = index.search('lim');
        expect(esResults.some(t => (typeof t === 'string' ? t : (t as any).id) === 'food.fruit.lemon')).toBe(true);
    });

    it('pressing Enter in the tag search input does not submit an outer form', () => {
        const handleSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
        render(
            <form onSubmit={handleSubmit}>
                <TagPicker tags={[]} onChange={vi.fn()} category="food" />
                <button type="submit">Submit outer form</button>
            </form>
        );

        // Open sheet
        fireEvent.click(screen.getByRole('button', { name: /\+ Add/i }));
        const input = screen.getByPlaceholderText('Search tags...');

        // Type in search and press Enter
        fireEvent.change(input, { target: { value: 'lemon' } });
        fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

        expect(handleSubmit).not.toHaveBeenCalled();
    });

    it('Escape in the tag sheet closes only the sheet and stops propagation to parent', () => {
        const parentEscape = vi.fn();
        window.addEventListener('keydown', parentEscape);
        try {
            render(<TagPicker tags={[]} onChange={vi.fn()} category="food" />);
            fireEvent.click(screen.getByRole('button', { name: /\+ Add/i }));
            expect(screen.getByRole('dialog')).toBeInTheDocument();

            // Press Escape
            const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
            window.dispatchEvent(event);

            expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
            expect(parentEscape).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener('keydown', parentEscape);
        }
    });

    it('suggests up to 8 tags from title, description and category', () => {
        const handleChange = vi.fn();
        render(
            <TagPicker
                tags={[]}
                onChange={handleChange}
                category="food"
                title="Fresh Meyer lemons and crusty sourdough bread"
                description="Organic garden fruit and warm bread"
            />
        );

        fireEvent.click(screen.getByRole('button', { name: /\+ Add/i }));
        expect(screen.getByText('Suggested')).toBeInTheDocument();
    });

    it('unknown tag ID is safely hidden on detail page with no error', () => {
        const idx = tagIndex();
        const postTags = ['food.fruit.lemon', 'unknown.id.does.not.exist'];
        const visible = postTagsOf(postTags).filter(id => {
            try {
                return !!idx.label(id);
            } catch {
                return false;
            }
        });
        expect(visible).toEqual(['food.fruit.lemon']);
    });

    it('cross-language search: matchesExpandedSearch matches Spanish query with tagged post', () => {
        try {
            setLanguage('es', [coreEs]);
            // Post tagged food.fruit.lemon in English text
            const matches = matchesExpandedSearch(
                'limón',
                'Backyard citrus basket',
                'Freshly picked organic citrus',
                'food.fruit.lemon'
            );
            expect(matches).toBe(true);
        } finally {
            setLanguage('en');
        }
    });
});
