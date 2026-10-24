/**
 * chat-photo — a chat photo as it leaves the phone (DESIGN-group-chat-photos-fable.md §2.5): fitted within 800 px on its
 * longest side, never enlarged, JPEG at quality 0.7, as a data URI. One helper for every chat: a group chat's photo goes
 * through it, and a DM's can too (the DM screen still fits a photo to 1000 px wide, app/chat/[id].tsx, until Marty says
 * whether DM photos move to 800 px; design question 2).
 */
import * as ImageManipulator from 'expo-image-manipulator';
import { t } from '@beanpool/core';

/** The longest side of a chat photo, in pixels: the ceiling for every photo in BeanPool (memory photos-stay-800px). */
export const CHAT_PHOTO_MAX_PX = 800;
export const CHAT_PHOTO_QUALITY = 0.7;

/**
 * The resize that fits a picture of this size within 800 px on its longest side: nothing for one already within it, so a
 * small picture is never enlarged. A size the picker didn't report is fitted to 800 px wide, as other photos are.
 */
export function chatPhotoResize(width: number, height: number): ImageManipulator.Action[] {
    if (!(width > 0) || !(height > 0)) return [{ resize: { width: CHAT_PHOTO_MAX_PX } }];
    if (Math.max(width, height) <= CHAT_PHOTO_MAX_PX) return [];
    return [{ resize: width >= height ? { width: CHAT_PHOTO_MAX_PX } : { height: CHAT_PHOTO_MAX_PX } }];
}

/** A picked picture (an image picker's asset) as a chat photo's data URI. Throws when the phone can't encode it. */
export async function chatPhotoDataUri(asset: { uri: string; width?: number; height?: number }): Promise<string> {
    const out = await ImageManipulator.manipulateAsync(asset.uri, chatPhotoResize(asset.width ?? 0, asset.height ?? 0), {
        compress: CHAT_PHOTO_QUALITY, format: ImageManipulator.SaveFormat.JPEG, base64: true,
    });
    if (!out.base64) throw new Error(t('Could not process image.'));
    return `data:image/jpeg;base64,${out.base64}`;
}

/**
 * An await bounded, so a hung step never leaves a send button dead (the DM screen's field report, 2026-07-18). The step
 * isn't cancelled; the caller's catch and finally run, and the screen stays usable.
 */
export function withinMs<T>(promise: Promise<T>, ms: number, tooLong: string): Promise<T> {
    return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(tooLong)), ms))]);
}
