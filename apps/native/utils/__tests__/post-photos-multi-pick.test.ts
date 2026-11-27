/**
 * Several photos picked in one go (Marty, 26 Nov 2026, from a member's first post: "she couldn't just click all the photos at
 * once ... she had to go back in to gallery 3 times to select 3 photos"). utils/post-photo.ts askForPostPhotos: Gallery and
 * Browse files pick up to the room left; each photo goes through the same 800 px redraw, in the order picked; more than the
 * room keeps the first ones and says how many were left out; the Camera still takes one; room for one opens exactly as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const picker = vi.hoisted(() => ({ calls: [] as any[], camera: [] as any[], assets: [] as Array<{ uri: string }>, canceled: false }));
const redraws = vi.hoisted(() => ({ uris: [] as string[], failOn: null as string | null }));
const alerts = vi.hoisted(() => ({ calls: [] as Array<{ title: string; body?: string; buttons?: Array<{ text: string; onPress?: () => unknown }> }> }));

vi.mock('expo-image-picker', () => ({
    launchImageLibraryAsync: vi.fn(async (options: any) => {
        picker.calls.push(options);
        return picker.canceled ? { canceled: true, assets: null } : { canceled: false, assets: picker.assets };
    }),
    launchCameraAsync: vi.fn(async (options: any) => {
        picker.camera.push(options);
        return { canceled: false, assets: [{ uri: 'file:///camera.jpg' }] };
    }),
    requestCameraPermissionsAsync: vi.fn(async () => ({ granted: true })),
}));

vi.mock('expo-image-manipulator', () => ({
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: vi.fn(async (uri: string, actions: any[]) => {
        redraws.uris.push(uri);
        if (uri === redraws.failOn) throw new Error('This photo could not be read.');
        expect(actions).toEqual([{ resize: { width: 800 } }]);
        return { uri: `${uri}.small.jpg`, base64: `B64:${uri}` };
    }),
}));

vi.mock('react-native', () => ({
    Alert: { alert: vi.fn((title: string, body?: string, buttons?: any) => { alerts.calls.push({ title, body, buttons }); }) },
    Platform: { OS: 'android' },
}));

import { askForPostPhotos, askForPostPhoto, postPhotosFromLibrary, postPhotosFromFiles } from '../post-photo';

const photo = (name: string) => `data:image/jpeg;base64,B64:file:///${name}.jpg`;
const pick = (...names: string[]) => { picker.assets = names.map((n) => ({ uri: `file:///${n}.jpg` })); };

/** Opens the sheet for `room`, taps `door`, waits for the photos, and gives back what was added and the alerts after the sheet. */
async function choose(room: number, door: 'Gallery' | 'Browse files' | 'Camera'): Promise<{ added: string[]; said: typeof alerts.calls }> {
    const added: string[] = [];
    askForPostPhotos(room, (p) => added.push(p));
    const sheet = alerts.calls[0];
    const button = sheet.buttons?.find((b) => b.text === door);
    expect(button, `the sheet offers ${door}`).toBeDefined();
    await button!.onPress!();
    return { added, said: alerts.calls.slice(1) };
}

beforeEach(() => {
    picker.calls.length = 0;
    picker.camera.length = 0;
    picker.canceled = false;
    redraws.uris.length = 0;
    redraws.failOn = null;
    alerts.calls.length = 0;
    pick('a');
});

describe('the photo picker (Gallery) with room for several', () => {
    it('asks for several, counted to the room left, in the order picked, on Albums', async () => {
        pick('a', 'b', 'c');
        const { added, said } = await choose(3, 'Gallery');
        expect(picker.calls).toEqual([{
            mediaTypes: ['images'], quality: 1, base64: false, defaultTab: 'albums',
            allowsMultipleSelection: true, selectionLimit: 3, orderedSelection: true,
        }]);
        expect(added).toEqual([photo('a'), photo('b'), photo('c')]);
        expect(redraws.uris).toEqual(['file:///a.jpg', 'file:///b.jpg', 'file:///c.jpg']);
        expect(said).toEqual([]);
    });

    it('room for one opens exactly as one photo always did: no multiple selection', async () => {
        await choose(1, 'Gallery');
        expect(picker.calls).toEqual([{ mediaTypes: ['images'], quality: 1, base64: false, defaultTab: 'albums' }]);
        picker.calls.length = 0;
        alerts.calls.length = 0;
        askForPostPhoto(() => {});
        await alerts.calls[0].buttons!.find((b) => b.text === 'Gallery')!.onPress!();
        expect(picker.calls).toEqual([{ mediaTypes: ['images'], quality: 1, base64: false, defaultTab: 'albums' }]);
    });

    it('leaving the picker without a photo adds nothing and says nothing', async () => {
        picker.canceled = true;
        const { added, said } = await choose(4, 'Gallery');
        expect(added).toEqual([]);
        expect(said).toEqual([]);
    });
});

describe('Browse files with room for several', () => {
    it('asks the document picker for every photo picked (no limit of its own) and keeps the first that fit', async () => {
        pick('a', 'b', 'c', 'd', 'e');
        const { added, said } = await choose(2, 'Browse files');
        expect(picker.calls).toEqual([{
            mediaTypes: ['images'], quality: 1, base64: false, legacy: true, allowsMultipleSelection: true, selectionLimit: 0,
        }]);
        expect(added).toEqual([photo('a'), photo('b')]);
        // Only the kept ones are redrawn: no work for the photos left out.
        expect(redraws.uris).toEqual(['file:///a.jpg', 'file:///b.jpg']);
        // A short title, the words in the message (alert-words-in-message).
        expect(said.map((a) => [a.title, a.body])).toEqual([['Photos', '3 photos were left out: there was no room for more.']]);
    });

    it('room for one: the files door as it always was, and a second photo picked there is left out and said', async () => {
        pick('a', 'b');
        const { added, said } = await choose(1, 'Browse files');
        expect(picker.calls).toEqual([{ mediaTypes: ['images'], quality: 1, base64: false, legacy: true }]);
        expect(added).toEqual([photo('a')]);
        expect(said.map((a) => [a.title, a.body])).toEqual([['Photos', '1 photo was left out: there was no room for more.']]);
    });
});

describe('0 to 5 picked against the room left (the table)', () => {
    const NAMES = ['a', 'b', 'c', 'd', 'e'];
    for (let room = 1; room <= 5; room++) {
        for (let n = 0; n <= 5; n++) {
            const kept = Math.min(room, n);
            const out = n - kept;
            it(`${n} picked, room for ${room}: the first ${kept} added in order${out ? `, "${out} left out"` : ', nothing said'}`, async () => {
                pick(...NAMES.slice(0, n));
                const { added, said } = await choose(room, 'Browse files');
                expect(added).toEqual(NAMES.slice(0, kept).map(photo));
                expect(said.map((a) => [a.title, a.body])).toEqual(
                    out === 0 ? [] : [['Photos', out === 1 ? '1 photo was left out: there was no room for more.' : `${out} photos were left out: there was no room for more.`]],
                );
            });
        }
    }
});

describe('a photo that cannot be redrawn', () => {
    it('costs only itself: the others are added in order and "Photo not added" says why', async () => {
        pick('a', 'b', 'c');
        redraws.failOn = 'file:///b.jpg';
        const { added, said } = await choose(3, 'Gallery');
        expect(added).toEqual([photo('a'), photo('c')]);
        expect(said).toEqual([{ title: 'Photo not added', body: 'This photo could not be read.', buttons: undefined }]);
    });

    it('postPhotosFromLibrary and postPhotosFromFiles hand back the error beside the photos kept', async () => {
        pick('a', 'b');
        redraws.failOn = 'file:///a.jpg';
        const lib = await postPhotosFromLibrary(2);
        expect(lib.photos).toEqual([photo('b')]);
        expect(lib.leftOut).toBe(0);
        expect((lib.failed as Error).message).toBe('This photo could not be read.');
        pick('a', 'b', 'c');
        redraws.failOn = null;
        const files = await postPhotosFromFiles(2);
        expect(files).toEqual({ photos: [photo('a'), photo('b')], leftOut: 1, failed: null });
    });
});

describe('the Camera', () => {
    it('still takes one photo, whatever the room', async () => {
        const { added, said } = await choose(5, 'Camera');
        expect(picker.camera).toEqual([{ mediaTypes: ['images'], quality: 1, base64: false }]);
        expect(picker.calls).toEqual([]);
        expect(added).toEqual(['data:image/jpeg;base64,B64:file:///camera.jpg']);
        expect(said).toEqual([]);
    });
});

describe('`picked`: one call per pick with the photos it added, so a post form opens Adjust on them (Marty, 28 Nov 2026)', () => {
    /** Opens the sheet with a `picked` listener, taps `door`, and gives back each `add` and each `picked` in the order heard. */
    async function heard(room: number, door: 'Gallery' | 'Browse files' | 'Camera'): Promise<string[]> {
        const order: string[] = [];
        askForPostPhotos(room, (p) => order.push(`add ${p}`), undefined, (photos) => order.push(`picked ${JSON.stringify(photos)}`));
        await alerts.calls[0].buttons!.find((b) => b.text === door)!.onPress!();
        return order;
    }

    it('after every add, once, with the photos kept in the order picked; never the photos left out', async () => {
        pick('a', 'b', 'c');
        expect(await heard(2, 'Browse files')).toEqual([`add ${photo('a')}`, `add ${photo('b')}`, `picked ${JSON.stringify([photo('a'), photo('b')])}`]);
    });

    it('the Camera: its one photo', async () => {
        expect(await heard(5, 'Camera')).toEqual(['add data:image/jpeg;base64,B64:file:///camera.jpg', `picked ${JSON.stringify(['data:image/jpeg;base64,B64:file:///camera.jpg'])}`]);
    });

    it('a photo that failed is not in it; a pick with no photo kept is never heard', async () => {
        pick('a', 'b');
        redraws.failOn = 'file:///a.jpg';
        expect(await heard(3, 'Gallery')).toEqual([`add ${photo('b')}`, `picked ${JSON.stringify([photo('b')])}`]);
        alerts.calls.length = 0;
        redraws.failOn = null;
        picker.canceled = true;
        expect(await heard(3, 'Gallery')).toEqual([]);
    });
});
