import { act, fireEvent, screen } from '@testing-library/react';

/**
 * Tests only: what resizePhotoFile answers in a test file that mocks it. jsdom decodes no pictures, so each file that
 * picks a photo mocks '../../lib/photo-resize' to resolve to this.
 */
export const PICKED_PHOTO = 'data:image/jpeg;base64,cmVzaXplZA==';

/** Tests only: pick one photo in the open form's OfferPhotoPicker, and wait for its thumbnail. */
export async function pickOfferPhoto(): Promise<void> {
    const input = screen.getByLabelText('Add photo');
    await act(async () => {
        fireEvent.change(input, { target: { files: [new File(['eggs'], 'eggs.jpg', { type: 'image/jpeg' })] } });
    });
    await screen.findByAltText('photo 1');
}
