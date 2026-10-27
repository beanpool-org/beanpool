import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MAX_OFFER_PHOTOS, OfferPhotoPicker } from './OfferPhotoPicker';
import { resizePhotoFile } from '../../lib/photo-resize';
import { PICKED_PHOTO, pickOfferPhoto } from './__tests__/offer-photo-helpers';

// jsdom decodes no pictures: a picked photo comes back as PICKED_PHOTO (offer-photo-helpers).
vi.mock('../../lib/photo-resize', () => ({ resizePhotoFile: vi.fn(async () => 'data:image/jpeg;base64,cmVzaXplZA==') }));

function Harness({ start = [] as string[], onPhotos = (_: string[]) => {} }) {
    const [photos, setPhotos] = useState<string[]>(start);
    return (
        <OfferPhotoPicker
            photos={photos}
            onChange={(update) => setPhotos((prev) => { const next = update(prev); onPhotos(next); return next; })}
        />
    );
}

const file = () => new File(['eggs'], 'eggs.jpg', { type: 'image/jpeg' });

describe('OfferPhotoPicker', () => {
    beforeEach(() => { vi.mocked(resizePhotoFile).mockClear(); });

    it('adds the picked photo through resizePhotoFile (800 px, a JPEG) and takes it off with ✕', async () => {
        const onPhotos = vi.fn();
        render(<Harness onPhotos={onPhotos} />);
        expect(screen.getByText('Photo')).toBeInTheDocument();

        await pickOfferPhoto();
        expect(resizePhotoFile).toHaveBeenCalledTimes(1);
        expect(onPhotos).toHaveBeenLastCalledWith([PICKED_PHOTO]);
        expect(screen.getByAltText('photo 1')).toHaveAttribute('src', PICKED_PHOTO);

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove photo' })); });
        expect(onPhotos).toHaveBeenLastCalledWith([]);
        expect(screen.queryByAltText('photo 1')).not.toBeInTheDocument();
    });

    it('stops offering 📷 at the five photos a listing holds', () => {
        render(<Harness start={Array.from({ length: MAX_OFFER_PHOTOS }, (_, i) => `data:image/jpeg;base64,${i}`)} />);
        expect(MAX_OFFER_PHOTOS).toBe(5);
        expect(screen.getAllByRole('button', { name: 'Remove photo' })).toHaveLength(5);
        expect(screen.queryByLabelText('Add photo')).not.toBeInTheDocument();
    });

    it('says so when a picture cannot be read, and adds nothing', async () => {
        vi.mocked(resizePhotoFile).mockRejectedValueOnce(new Error('Could not decode the picture'));
        const onPhotos = vi.fn();
        render(<Harness onPhotos={onPhotos} />);

        await act(async () => {
            fireEvent.change(screen.getByLabelText('Add photo'), { target: { files: [file()] } });
        });
        expect(await screen.findByRole('alert')).toHaveTextContent('That picture could not be read. Choose a JPEG, PNG or WebP photo.');
        expect(onPhotos).not.toHaveBeenCalled();
        expect(screen.queryByAltText('photo 1')).not.toBeInTheDocument();

        // The next picture that reads clears the note.
        await pickOfferPhoto();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
});
