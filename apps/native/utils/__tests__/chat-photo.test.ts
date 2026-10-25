/**
 * A chat photo leaves the phone fitted within 800 px on its longest side, never enlarged, JPEG at 0.7
 * (DESIGN-group-chat-photos-fable.md §2.5; utils/chat-photo.ts). The encoder itself is the phone's: stubbed here.
 */
import { describe, it, expect, vi } from 'vitest';

const manipulateAsync = vi.hoisted(() => vi.fn(async () => ({ base64: 'QUJD', uri: 'file:///out.jpg', width: 800, height: 600 })));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync, SaveFormat: { JPEG: 'jpeg' } }));

import { chatPhotoDataUri, chatPhotoResize, CHAT_PHOTO_MAX_PX } from '../chat-photo';

describe('a chat photo: 800 px on its longest side, never enlarged', () => {
    it('fits the longest side, landscape or portrait, and leaves a picture already within 800 px as it is', () => {
        expect(CHAT_PHOTO_MAX_PX).toBe(800);
        expect(chatPhotoResize(4000, 3000)).toEqual([{ resize: { width: 800 } }]);
        expect(chatPhotoResize(3000, 4000)).toEqual([{ resize: { height: 800 } }]);
        expect(chatPhotoResize(1200, 1200)).toEqual([{ resize: { width: 800 } }]);
        expect(chatPhotoResize(800, 600)).toEqual([]);
        expect(chatPhotoResize(320, 480)).toEqual([]);
        // A size the picker didn't give: 800 px wide, as every other photo on the phone.
        expect(chatPhotoResize(0, 0)).toEqual([{ resize: { width: 800 } }]);
    });

    it('encodes JPEG at quality 0.7 and answers a data URI; a picture the phone could not encode throws', async () => {
        await expect(chatPhotoDataUri({ uri: 'file:///in.jpg', width: 4032, height: 3024 })).resolves.toBe('data:image/jpeg;base64,QUJD');
        expect(manipulateAsync).toHaveBeenLastCalledWith('file:///in.jpg', [{ resize: { width: 800 } }], { compress: 0.7, format: 'jpeg', base64: true });
        manipulateAsync.mockResolvedValueOnce({ base64: '', uri: 'file:///out.jpg', width: 1, height: 1 });
        await expect(chatPhotoDataUri({ uri: 'file:///in.jpg', width: 10, height: 10 })).rejects.toThrow('Could not process image.');
    });
});

// Marty, 25 Oct ("Yes, all four", design question 2): a direct message's photo is 800 px too, through this one helper.
describe('the direct message screen sends its photo through chatPhotoDataUri', () => {
    it('app/chat/[id].tsx has no 1000 px resize of its own', async () => {
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const screen = readFileSync(resolve(__dirname, '../../app/chat/[id].tsx'), 'utf8');
        expect(screen).not.toMatch(/width:\s*1000/);
        expect(screen).toMatch(/chatPhotoDataUri\(/);
    });
});
