/**
 * Several photos picked in one go (Marty, 26 Nov 2026, from a first post on Byron: "she had to go back in to gallery 3 times
 * to select 3 photos. bad UX"). The room a post, an event or a Local knowledge page has left decides how many it keeps: the
 * first ones, in the order they were picked, and the member is told plainly how many were left out. One rule for the phone
 * (apps/native/utils/post-photo.ts askForPostPhotos) and the web app (apps/pwa/src/components/PostPhotoPicker.tsx
 * pickedPostPhotos), so both keep the same photos from the same pick and say it in the same sentence.
 */
import { tn } from './words.js';

/** What a form keeps from one pick: the photos that fit, in the order picked, and how many did not. */
export interface PhotosThatFit<T> {
    kept: T[];
    leftOut: number;
}

/**
 * The first `room` of `picked`, in the order picked, and how many were left out. A room that is no number, or below
 * nothing, is none: a full form keeps nothing and leaves every photo out. A fraction keeps the whole photos below it.
 */
export function photosThatFit<T>(picked: readonly T[], room: number): PhotosThatFit<T> {
    const fits = Number.isFinite(room) ? Math.max(0, Math.floor(room)) : 0;
    const kept = picked.slice(0, fits);
    return { kept, leftOut: picked.length - kept.length };
}

/** The sentence a member reads when a pick held more photos than the form had room for. Empty when none were left out. */
export function photosLeftOutLine(leftOut: number): string {
    if (!(leftOut > 0)) return '';
    return tn(leftOut, '{n} photo was left out: there was no room for more.', '{n} photos were left out: there was no room for more.');
}
