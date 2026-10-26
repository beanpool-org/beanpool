import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const pickerCalls: any[] = [];
const manipulatedCalls: any[] = [];
let alertCalls: Array<{ title: string; body?: string; buttons?: Array<{ text: string; onPress?: () => void; style?: string }> }> = [];

vi.mock('expo-image-picker', () => ({
    launchImageLibraryAsync: vi.fn(async (options: any) => {
        pickerCalls.push(options);
        return {
            canceled: false,
            assets: [{ uri: 'file:///path/to/banner_in_pictures.png', width: 2400, height: 800 }],
        };
    }),
    launchCameraAsync: vi.fn(async (options: any) => {
        pickerCalls.push(options);
        return {
            canceled: false,
            assets: [{ uri: 'file:///path/to/camera.jpg', width: 4000, height: 3000 }],
        };
    }),
    requestCameraPermissionsAsync: vi.fn(async () => ({ granted: true })),
}));

vi.mock('expo-image-manipulator', () => ({
    SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
    manipulateAsync: vi.fn(async (uri: string, actions: any[], save: any) => {
        manipulatedCalls.push({ uri, actions, save });
        return {
            uri: `${uri}.small.jpg`,
            width: 800,
            height: 267,
            base64: 'UkVTSVpFRF9QSFRPTw==',
        };
    }),
}));

vi.mock('react-native', () => ({
    Alert: {
        alert: vi.fn((title: string, body?: string, buttons?: any) => {
            alertCalls.push({ title, body, buttons });
        }),
    },
    Platform: {
        OS: 'android',
        select: (obj: any) => obj.android ?? obj.default,
    },
}));

vi.mock('@beanpool/core', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        t: (k: string) => k,
    };
});

import { askForPostPhoto, postPhotoFromLibrary, postPhotoFromFiles, POST_PHOTO_WIDTH } from '../post-photo';
import { pickPicture } from '../picture-crop';

describe('photo picker: Albums default and Browse files door', () => {
    beforeEach(() => {
        pickerCalls.length = 0;
        manipulatedCalls.length = 0;
        alertCalls = [];
        vi.clearAllMocks();
    });

    it('no new permission appears in app.json and blockedPermissions contains READ_MEDIA_IMAGES', () => {
        const appJsonPath = path.resolve(__dirname, '../../../app.json');
        const raw = fs.readFileSync(appJsonPath, 'utf8');
        const config = JSON.parse(raw);
        const blocked: string[] = config.expo.android.blockedPermissions ?? [];
        const perms: string[] = config.expo.android.permissions ?? [];

        expect(blocked).toContain('android.permission.READ_MEDIA_IMAGES');
        expect(perms).not.toContain('android.permission.READ_MEDIA_IMAGES');
        expect(perms).not.toContain('android.permission.READ_EXTERNAL_STORAGE');
        expect(perms).not.toContain('android.permission.MANAGE_EXTERNAL_STORAGE');
    });

    it('the shared helper is called with the Albums option on Android', async () => {
        const photo = await postPhotoFromLibrary();
        expect(photo).toBe('data:image/jpeg;base64,UkVTSVpFRF9QSFRPTw==');

        expect(pickerCalls).toHaveLength(1);
        expect(pickerCalls[0]).toMatchObject({
            mediaTypes: ['images'],
            defaultTab: 'albums',
        });
    });

    it('"Browse files" is offered beside Gallery and opens the document picker with image types', async () => {
        const added: string[] = [];
        askForPostPhoto((p) => added.push(p));

        expect(alertCalls).toHaveLength(1);
        const alert = alertCalls[0];
        expect(alert.title).toBe('Add Photo');
        expect(alert.body).toBe('Choose a source');

        const buttonTexts = alert.buttons?.map((b) => b.text);
        expect(buttonTexts).toEqual(['Camera', 'Gallery', 'Browse files', 'Cancel']);

        const browseBtn = alert.buttons?.find((b) => b.text === 'Browse files');
        expect(browseBtn).toBeDefined();

        await browseBtn!.onPress!();

        expect(pickerCalls).toHaveLength(1);
        expect(pickerCalls[0]).toMatchObject({
            mediaTypes: ['images'],
            legacy: true,
        });

        expect(added).toEqual(['data:image/jpeg;base64,UkVTSVpFRF9QSFRPTw==']);
    });

    it('the picked file from Browse files goes through the existing 800 px resize path', async () => {
        const result = await postPhotoFromFiles();
        expect(result).toBe('data:image/jpeg;base64,UkVTSVpFRF9QSFRPTw==');

        expect(manipulatedCalls).toHaveLength(1);
        expect(manipulatedCalls[0]).toEqual({
            uri: 'file:///path/to/banner_in_pictures.png',
            actions: [{ resize: { width: POST_PHOTO_WIDTH } }],
            save: { compress: 0.7, format: 'jpeg', base64: true },
        });
    });

    it('pickPicture helper supports both library (Albums) and files (legacy document mode)', async () => {
        // Library: Albums tab
        const libraryPicture = await pickPicture('library');
        expect(libraryPicture).not.toBeNull();
        expect(pickerCalls.at(-1)).toMatchObject({
            mediaTypes: ['images'],
            defaultTab: 'albums',
        });

        // Files: document picker mode
        const filesPicture = await pickPicture('files' as any);
        expect(filesPicture).not.toBeNull();
        expect(pickerCalls.at(-1)).toMatchObject({
            mediaTypes: ['images'],
            legacy: true,
        });
    });
});
