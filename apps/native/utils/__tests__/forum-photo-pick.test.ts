/**
 * A forum photo as it leaves the phone (slice F3 part 2; components/forum/ForumBits.tsx pickForumPhoto): through the one helper
 * every chat photo uses (utils/chat-photo.ts), so fitted within 800 px on its longest side, never enlarged, JPEG, a data address
 * (memory photos-stay-800px). And the phone is asked for nothing until a source is tapped: the camera's permission only at
 * Camera (permissions only when asked).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ manip: [] as unknown[][], cameraAsked: 0, sources: null as null | { camera?: () => void; gallery: () => void; files: () => void }, cancel: null as null | (() => void), picked: { width: 4000, height: 3000 } }));
vi.mock('react-native', () => ({ Image: 'img', Linking: {}, Modal: 'div', Pressable: 'button', Text: 'span', View: 'div', StyleSheet: { create: (s: unknown) => s } }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: 'i' }));
vi.mock('../../app/ThemeContext', () => ({ useTheme: () => ({}), useStyles: () => ({}) }));
vi.mock('../keyboard-alert', () => ({ Alert: { alert: vi.fn() } }));
vi.mock('../forum', () => ({ forumPhotoUri: vi.fn() }));
vi.mock('../post-photo', () => ({
    askPhotoSource: (_title: string, sources: typeof calls.sources, onCancel: () => void) => { calls.sources = sources; calls.cancel = onCancel; },
}));
vi.mock('expo-image-picker', () => ({
    requestCameraPermissionsAsync: vi.fn(async () => { calls.cameraAsked += 1; return { granted: true }; }),
    launchCameraAsync: vi.fn(async () => ({ canceled: false, assets: [{ uri: 'file:///camera.jpg', ...calls.picked }] })),
    launchImageLibraryAsync: vi.fn(async () => ({ canceled: false, assets: [{ uri: 'file:///library.jpg', ...calls.picked }] })),
}));
vi.mock('expo-image-manipulator', () => ({
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: vi.fn(async (...args: unknown[]) => { calls.manip.push(args); return { base64: 'AAAA' }; }),
}));

import { pickForumPhoto } from '../../components/forum/ForumBits';

beforeEach(() => {
    calls.manip = [];
    calls.cameraAsked = 0;
    calls.sources = null;
    calls.cancel = null;
    calls.picked = { width: 4000, height: 3000 };
});

describe('a forum photo leaving the phone', () => {
    it('a 4000 × 3000 picture from the gallery goes fitted to 800 px wide, JPEG, as a data address; the camera is never asked', async () => {
        const photo = pickForumPhoto();
        expect(calls.cameraAsked).toBe(0);
        calls.sources!.gallery();
        expect(await photo).toBe('data:image/jpeg;base64,AAAA');
        expect(calls.manip).toHaveLength(1);
        const [uri, actions, opts] = calls.manip[0] as [string, unknown, { format: string; base64: boolean }];
        expect(uri).toBe('file:///library.jpg');
        expect(actions).toEqual([{ resize: { width: 800 } }]);
        expect(opts).toMatchObject({ format: 'jpeg', base64: true });
        expect(calls.cameraAsked).toBe(0);
    });

    it('a tall picture is fitted to 800 px high; one already within 800 px is never enlarged', async () => {
        calls.picked = { width: 1200, height: 3000 };
        let photo = pickForumPhoto();
        calls.sources!.files();
        await photo;
        expect(calls.manip[0][1]).toEqual([{ resize: { height: 800 } }]);
        calls.picked = { width: 640, height: 480 };
        photo = pickForumPhoto();
        calls.sources!.gallery();
        await photo;
        expect(calls.manip[1][1]).toEqual([]);
    });

    it('the camera\'s permission is asked only at Camera; leaving the sheet with no choice gives nothing', async () => {
        let photo = pickForumPhoto();
        expect(calls.cameraAsked).toBe(0);
        calls.sources!.camera!();
        expect(await photo).toBe('data:image/jpeg;base64,AAAA');
        expect(calls.cameraAsked).toBe(1);
        expect((calls.manip[0] as [string])[0]).toBe('file:///camera.jpg');
        photo = pickForumPhoto();
        calls.cancel!();
        expect(await photo).toBeNull();
    });
});
