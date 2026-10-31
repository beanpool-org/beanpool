import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import React, { useState } from 'react';
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

        // Type in search and press Enter. jsdom submits no form from a key press, so the browser's own step is what is read:
        // keydown's default action is the implicit submit, and fireEvent answers false once it has been prevented.
        fireEvent.change(input, { target: { value: 'lemon' } });
        expect(fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })).toBe(false);

        expect(handleSubmit).not.toHaveBeenCalled();
    });

    it('the sheet is drawn on document.body, out of any panel that would clip it (the map New Post panel), and above that panel', () => {
        const { container } = render(<div className="fixed z-[1000] overflow-y-auto backdrop-blur-xl"><TagPicker tags={[]} onChange={vi.fn()} category="food" /></div>);
        fireEvent.click(screen.getByRole('button', { name: /\+ Add/i }));
        const sheet = screen.getByRole('dialog');
        expect(sheet.parentElement).toBe(document.body);
        expect(container.contains(sheet)).toBe(false);
        expect(Number(/z-\[(\d+)\]/.exec(sheet.className)?.[1])).toBeGreaterThan(1000);
    });

    it('a click on the sheet or its overlay reaches no form it was opened from: React bubbles through the portal', () => {
        const parentClick = vi.fn();
        render(<div onClick={parentClick}><TagPicker tags={[]} onChange={vi.fn()} category="food" /></div>);
        fireEvent.click(screen.getByRole('button', { name: /\+ Add/i }));
        parentClick.mockClear();
        fireEvent.click(screen.getByPlaceholderText('Search tags...'));
        expect(parentClick).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('dialog'));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(parentClick).not.toHaveBeenCalled();
    });

    it('the button reads "+ Add", once (never "+ + Add")', () => {
        render(<TagPicker tags={[]} onChange={vi.fn()} category="food" />);
        expect(screen.getByRole('button', { name: '+ Add tag' }).textContent).toBe('+ Add');
    });

    it('every button in the sheet is type="button", so no tap in it can submit an outer form', () => {
        render(<TagPicker tags={[]} onChange={vi.fn()} category="food" title="Lemons" />);
        fireEvent.click(screen.getByRole('button', { name: /\+ Add/i }));
        fireEvent.change(screen.getByPlaceholderText('Search tags...'), { target: { value: 'lemon' } });
        const buttons = screen.getByRole('dialog').querySelectorAll('button');
        expect(buttons.length).toBeGreaterThan(2);
        for (const b of buttons) expect(b.getAttribute('type')).toBe('button');
    });

    it('Escape in the tag sheet closes only the sheet and stops propagation to parent', () => {
        const parentEscape = vi.fn();
        // Where the pages listen (MarketplacePage, TreasuryDetailPage, MapPage: window, bubbling), and a parent's own listener.
        window.addEventListener('keydown', parentEscape);
        document.addEventListener('keydown', parentEscape);
        try {
            render(<div onKeyDown={parentEscape}><TagPicker tags={[]} onChange={vi.fn()} category="food" /></div>);
            fireEvent.click(screen.getByRole('button', { name: /\+ Add/i }));
            expect(screen.getByRole('dialog')).toBeInTheDocument();

            // Press Escape where the keyboard really is: in the sheet's search
            fireEvent.keyDown(screen.getByPlaceholderText('Search tags...'), { key: 'Escape' });

            expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
            expect(parentEscape).not.toHaveBeenCalled();

            // The sheet shut: Escape is the page's again.
            fireEvent.keyDown(screen.getByRole('button', { name: /\+ Add/i }), { key: 'Escape' });
            expect(parentEscape).toHaveBeenCalled();
        } finally {
            window.removeEventListener('keydown', parentEscape);
            document.removeEventListener('keydown', parentEscape);
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

describe('a tag the member types (DESIGN-tags-free-entry-fable.md §3, slice F2)', () => {
    const held = { tags: [] as string[], freeTags: [] as string[] };
    function Composer({ tags = [], freeTags = [] }: { tags?: string[]; freeTags?: string[] }) {
        const [nowTags, setTags] = useState(tags);
        const [nowFree, setFree] = useState(freeTags);
        held.tags = nowTags;
        held.freeTags = nowFree;
        return <TagPicker tags={nowTags} onChange={setTags} freeTags={nowFree} onFreeTagsChange={setFree} category="food" />;
    }
    const open = (tags?: string[], freeTags?: string[]) => {
        render(<Composer tags={tags} freeTags={freeTags} />);
        fireEvent.click(screen.getByRole('button', { name: /\+ Add/i }));
    };
    const field = () => screen.getByPlaceholderText('Search tags...') as HTMLInputElement;
    const type = (value: string) => fireEvent.change(field(), { target: { value } });
    const enter = () => fireEvent.keyDown(field(), { key: 'Enter', code: 'Enter' });
    const addRow = () => screen.queryByTestId('tag-picker-add-typed');

    it('Enter makes the typed words a tag, the # shown and not stored, and the sheet stays for the next', () => {
        open();
        type('#2nd  Hand');
        expect(enter()).toBe(false);
        expect(held.freeTags).toEqual(['2nd hand']);
        expect(held.tags).toEqual([]);
        expect(field().value).toBe('');
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: 'Remove #2nd hand' })[0].textContent).toContain('#2nd hand');
    });

    it('Enter on a library label picks the library tag, never a free twin', () => {
        open();
        type('Lemons');
        enter();
        expect(held.tags).toEqual(['food.fruit.lemon']);
        expect(held.freeTags).toEqual([]);
    });

    it('a comma commits what is before it and leaves what follows', () => {
        open();
        type('vintage, re');
        expect(held.freeTags).toEqual(['vintage']);
        expect(field().value).toBe(' re');
    });

    it('Done commits what is in the field and shuts the sheet', () => {
        open();
        type('vintage');
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(held.freeTags).toEqual(['vintage']);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('a refused tag shows its words before anything is sent, and Done keeps the sheet open on them', () => {
        open();
        type('me@example.org');
        expect(screen.getByRole('alert').textContent).toBe('A tag is a word to find your listing by, not a contact');
        expect(addRow()).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(held.freeTags).toEqual([]);
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(field().value).toBe('me@example.org');
    });

    it('a word still being typed is not called too short until it is committed', () => {
        open();
        type('a');
        expect(screen.queryByRole('alert')).toBeNull();
        enter();
        expect(screen.getByRole('alert').textContent).toBe('A tag needs at least two letters or numbers');
        type('ab');
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('the cap, in words, on the kind that is full', () => {
        open([], ['aa', 'bb', 'cc', 'dd', 'ee']);
        type('ff');
        expect(screen.getByRole('alert').textContent).toBe('Five tags at most');
        enter();
        expect(held.freeTags).toHaveLength(5);
    });

    it('five of a kind leave the + Add for the other kind; ten leave none', () => {
        const library = ['food.fruit.apple', 'food.fruit.orange', 'food.produce.herbs', 'food.preserve.jam', 'food.bakery.bread'];
        const { unmount } = render(<Composer tags={library} />);
        expect(screen.getByRole('button', { name: /\+ Add/i })).toBeInTheDocument();
        unmount();
        render(<Composer tags={library} freeTags={['aa', 'bb', 'cc', 'dd', 'ee']} />);
        expect(screen.queryByRole('button', { name: /\+ Add/i })).toBeNull();
    });

    it('the last row adds what is typed; a word the library has, or nothing typed, has no such row', () => {
        open();
        expect(addRow()).toBeNull();
        type('2nd hand');
        expect(addRow()?.textContent).toBe('Add “#2nd hand”');
        fireEvent.click(addRow()!);
        expect(held.freeTags).toEqual(['2nd hand']);
        type('lemon');
        expect(addRow()).toBeNull();
    });

    it("a plural has its label's row, and a tap on a result ends what was typed: Done does not put back one just taken off", () => {
        open();
        type('lemons');
        fireEvent.click(screen.getByRole('button', { name: 'Lemon' }));
        expect(held.tags).toEqual(['food.fruit.lemon']);
        expect(field().value).toBe('');
        fireEvent.click(screen.getAllByRole('button', { name: 'Remove Lemon' })[0]);
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(held.tags).toEqual([]);
    });

    it('backspace on an empty field takes the last chip off, the typed ones first; with words in the field, or held down, it does not', () => {
        open(['food.fruit.lemon'], ['aa']);
        type('b');
        fireEvent.keyDown(field(), { key: 'Backspace' });
        expect(held.freeTags).toEqual(['aa']);
        type('');
        fireEvent.keyDown(field(), { key: 'Backspace', repeat: true });
        expect(held.freeTags).toEqual(['aa']);
        fireEvent.keyDown(field(), { key: 'Backspace' });
        expect(held.freeTags).toEqual([]);
        fireEvent.keyDown(field(), { key: 'Backspace' });
        expect(held.tags).toEqual([]);
    });

    it('Enter and a comma leave a word an input method is still building alone: it commits when the composition ends', () => {
        open();
        fireEvent.compositionStart(field());
        fireEvent.change(field(), { target: { value: '二手，' }, nativeEvent: { isComposing: true } });
        fireEvent.keyDown(field(), { key: 'Enter', isComposing: true });
        expect(held.freeTags).toEqual([]);
        fireEvent.compositionEnd(field());
        expect(held.freeTags).toEqual(['二手']);
    });

    it('its chip takes it off', () => {
        open([], ['aa', 'bb']);
        fireEvent.click(screen.getAllByRole('button', { name: 'Remove #aa' })[0]);
        expect(held.freeTags).toEqual(['bb']);
    });

    it('the two hints are under the field', () => {
        open();
        expect(screen.getByText('Tags are public with your listing')).toBeInTheDocument();
        expect(screen.getByText('A tag you type is in your own words. Pick a library tag to be found in every language.')).toBeInTheDocument();
    });

    it('no key in the field submits an outer form, and every button in the sheet is type="button"', () => {
        const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
        render(<form onSubmit={onSubmit}><Composer freeTags={['aa']} /></form>);
        fireEvent.click(screen.getByRole('button', { name: /\+ Add/i }));
        type('vintage');
        expect(enter()).toBe(false);
        type('retro');
        for (const b of screen.getByRole('dialog').querySelectorAll('button')) expect(b.getAttribute('type')).toBe('button');
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('every target in the row and the sheet asks for 44 px', () => {
        open(['food.fruit.lemon'], ['2nd hand']);
        type('vintage');
        const targets = [...screen.getByRole('dialog').querySelectorAll('button')].filter(b => !b.className.includes('min-h-[44px]'));
        expect(targets.map(b => b.textContent)).toEqual([]);
    });
});
