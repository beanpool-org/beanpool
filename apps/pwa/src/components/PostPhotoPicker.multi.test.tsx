/**
 * Several photos picked in one go on the web (Marty, 26 Nov 2026: "she had to go back in to gallery 3 times to select 3
 * photos"). PostPhotoPicker's 📷 is a file input with `multiple`; the first files that fit the room left are kept, in the order
 * picked, each through the same resize as one photo (resizePhotoFile); more than the room says how many were left out, and the
 * line goes when the form's photos change. The composer (MapPage) and the listing's edit form (MarketplacePage) use the same
 * pickedPostPhotos and line.
 */
import { useState } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const resize = vi.hoisted(() => ({ calls: [] as string[], failOn: null as string | null }));
vi.mock('../lib/photo-resize', () => ({
    resizePhotoFile: vi.fn(async (file: File) => {
        resize.calls.push(file.name);
        // A later file resolves sooner, so an order kept by completion would come out wrong.
        await new Promise((r) => setTimeout(r, file.name === 'a.jpg' ? 15 : 1));
        if (file.name === resize.failOn) throw new Error('Could not decode the picture');
        return `data:image/jpeg;base64,${file.name}`;
    }),
}));

import { PostPhotoPicker, pickedPostPhotos } from './PostPhotoPicker';

const files = (...names: string[]) => names.map((n) => new File(['x'], n, { type: 'image/jpeg' }));
const photo = (name: string) => `data:image/jpeg;base64,${name}`;

function Form({ start = [] as string[], max }: { start?: string[]; max?: number }) {
    const [photos, setPhotos] = useState<string[]>(start);
    return (
        <>
            <PostPhotoPicker photos={photos} onChange={(update) => setPhotos(update)} max={max} />
            <output data-testid="photos">{JSON.stringify(photos)}</output>
        </>
    );
}

const held = () => JSON.parse(screen.getByTestId('photos').textContent ?? '[]') as string[];
const input = () => screen.getByLabelText('Add photo') as HTMLInputElement;
async function choose(...names: string[]) {
    await act(async () => { fireEvent.change(input(), { target: { files: files(...names) } }); });
}

beforeEach(() => {
    resize.calls.length = 0;
    resize.failOn = null;
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('PostPhotoPicker: several photos in one go', () => {
    it('the 📷 lets the browser pick several images', () => {
        render(<Form />);
        expect(input().multiple).toBe(true);
        expect(input().accept).toBe('image/*');
    });

    it('three picked into an empty listing: all three, in the order picked, each resized', async () => {
        render(<Form />);
        await choose('a.jpg', 'b.jpg', 'c.jpg');
        await waitFor(() => expect(held()).toEqual([photo('a.jpg'), photo('b.jpg'), photo('c.jpg')]));
        expect(resize.calls).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
        expect(screen.queryByTestId('photos-left-out')).toBeNull();
    });

    it('more than the room: the first that fit are kept and a line says how many were left out', async () => {
        render(<Form start={[photo('old.jpg'), photo('old2.jpg')]} />);
        await choose('a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg');
        await waitFor(() => expect(held()).toHaveLength(5));
        expect(held()).toEqual([photo('old.jpg'), photo('old2.jpg'), photo('a.jpg'), photo('b.jpg'), photo('c.jpg')]);
        // The left-out ones are never resized.
        expect(resize.calls).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
        const line = screen.getByTestId('photos-left-out');
        expect(line.textContent).toBe('2 photos were left out: there was no room for more.');
        expect(line.getAttribute('role')).toBe('status');
        // The row is full: the 📷 goes, the line stays.
        expect(screen.queryByLabelText('Add photo')).toBeNull();
        // Taking a photo off puts the line away.
        await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Remove photo' })[0]); });
        expect(screen.queryByTestId('photos-left-out')).toBeNull();
    });

    it('the line stays gone when the list is later refilled to the same length (an edit form, a draft)', async () => {
        const five = ['p1', 'p2', 'p3', 'p4', 'p5'].map(photo);
        function Refill() {
            const [photos, setPhotos] = useState<string[]>([photo('old.jpg'), photo('old2.jpg')]);
            return (
                <>
                    <PostPhotoPicker photos={photos} onChange={(update) => setPhotos(update)} />
                    <button type="button" onClick={() => setPhotos([])}>empty</button>
                    <button type="button" onClick={() => setPhotos(five)}>refill</button>
                </>
            );
        }
        render(<Refill />);
        await choose('a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg');
        await waitFor(() => expect(screen.getByTestId('photos-left-out')).toBeTruthy());
        await act(async () => { fireEvent.click(screen.getByText('empty')); });
        expect(screen.queryByTestId('photos-left-out')).toBeNull();
        await act(async () => { fireEvent.click(screen.getByText('refill')); });
        expect(screen.queryByTestId('photos-left-out')).toBeNull();
    });

    it('Local knowledge holds three: room is the form\'s own max', async () => {
        render(<Form max={3} />);
        await choose('a.jpg', 'b.jpg', 'c.jpg', 'd.jpg');
        await waitFor(() => expect(held()).toHaveLength(3));
        expect(screen.getByTestId('photos-left-out').textContent).toBe('1 photo was left out: there was no room for more.');
    });

    it('a file the browser cannot read costs only itself', async () => {
        resize.failOn = 'b.jpg';
        render(<Form />);
        await choose('a.jpg', 'b.jpg', 'c.jpg');
        await waitFor(() => expect(held()).toEqual([photo('a.jpg'), photo('c.jpg')]));
        expect(screen.queryByTestId('photos-left-out')).toBeNull();
    });
});

describe('pickedPostPhotos: 0 to 5 picked against the room left (the table)', () => {
    const NAMES = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'];
    for (let room = 0; room <= 5; room++) {
        for (let n = 0; n <= 5; n++) {
            const kept = Math.min(room, n);
            it(`${n} picked, room for ${room}: the first ${kept} in order, ${n - kept} left out`, async () => {
                const picked = await pickedPostPhotos(files(...NAMES.slice(0, n)), room);
                expect(picked).toEqual({ photos: NAMES.slice(0, kept).map(photo), leftOut: n - kept });
            });
        }
    }

    it('no files at all is nothing picked', async () => {
        expect(await pickedPostPhotos(null, 5)).toEqual({ photos: [], leftOut: 0 });
    });
});

describe('every post photo input on the web picks several through the same helper', () => {
    const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const source = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

    it.each(['pages/MapPage.tsx', 'pages/MarketplacePage.tsx'])('%s: its photo input is `multiple`, goes through pickedPostPhotos and shows the left-out line', (file) => {
        const src = source(file);
        expect(src).toMatch(/pickedPostPhotos\(files, 5 - before\)/);
        expect(src).toMatch(/<PhotosLeftOut leftOut=\{/);
        expect(src).toMatch(/accept="image\/\*"\s+multiple/);
        // No second, inline resize beside the shared one.
        expect(src).not.toMatch(/canvas\.toDataURL\('image\/jpeg', 0\.7\)/);
    });
});
