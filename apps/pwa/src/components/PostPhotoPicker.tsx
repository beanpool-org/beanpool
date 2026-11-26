/**
 * A listing's photos while it is being written: each one with a ✕ to take it off, and a 📷 that adds photos, up to the five a
 * listing holds. The member's own composer's row (MapPage renderPhotoPicker), for a form that keeps its photos in a list of
 * data URLs. A photo goes through lib/photo-resize.ts: at most 800 px, a JPEG, the camera's metadata left behind.
 *
 * The browser's own file picker, opened only when 📷 is tapped: it asks the device for nothing (Marty, 26 Oct, from Damo).
 * Several photos can be picked in one go (Marty, 26 Nov 2026: "she had to go back in to gallery 3 times to select 3 photos"):
 * the first that fit the room left are kept, in the order picked, and a line says how many were left out (core
 * photos-that-fit.ts, the phone's rule too).
 */
import { useEffect, useState } from 'react';
import { photosLeftOutLine, photosThatFit, t } from '@beanpool/core';
import { resizePhotoFile } from '../lib/photo-resize';

/** The most photos a listing holds (the node keeps five). */
export const MAX_POST_PHOTOS = 5;

/**
 * One pick of several photos for a form with `room` left: the first `room` files, in the order picked, each through the
 * same resize as one photo always went (resizePhotoFile); a file the browser can't read is skipped and the rest kept. And how
 * many were left out for want of room.
 */
export async function pickedPostPhotos(files: ArrayLike<File> | null | undefined, room: number): Promise<{ photos: string[]; leftOut: number }> {
    const { kept, leftOut } = photosThatFit(Array.from(files ?? []), room);
    const photos: string[] = [];
    for (const file of kept) {
        try {
            photos.push(await resizePhotoFile(file));
        } catch (err) {
            console.error('Could not read the picked photo:', err);
        }
    }
    return { photos, leftOut };
}

/**
 * How many of the last pick were left out, shown while the form still holds the photos that pick left it with: taking a photo
 * off, adding another or emptying the form puts the line away. `note(leftOut, countAfter)` records a pick.
 */
export function usePhotosLeftOut(count: number): readonly [number, (leftOut: number, countAfter: number) => void] {
    const [last, setLast] = useState<{ leftOut: number; countAfter: number } | null>(null);
    // Forget the pick as soon as the count moves off what it left (review of #3391): a list later refilled to the same
    // length (an edit form, a draft) must not bring the old line back with no pick made.
    useEffect(() => { if (last && last.countAfter !== count) setLast(null); }, [count, last]);
    const shown = last && last.countAfter === count ? last.leftOut : 0;
    return [shown, (leftOut, countAfter) => setLast(leftOut > 0 ? { leftOut, countAfter } : null)] as const;
}

/** The line under a photo row that says how many photos of a pick were left out; nothing when none were. */
export function PhotosLeftOut({ leftOut }: { leftOut: number }) {
    if (leftOut <= 0) return null;
    return (
        <p role="status" data-testid="photos-left-out" className="m-0 mt-2 text-sm font-semibold text-nature-700 dark:text-nature-200">
            {photosLeftOutLine(leftOut)}
        </p>
    );
}

/** `max`: the most this form holds (a listing five, Local knowledge three). */
export function PostPhotoPicker({ photos, onChange, label, max = MAX_POST_PHOTOS }: { photos: string[]; onChange: (update: (prev: string[]) => string[]) => void; label?: string; max?: number }) {
    const [leftOut, noteLeftOut] = usePhotosLeftOut(photos.length);
    return (
        <div>
            {label && (
                <p className="block text-xs font-bold text-nature-600 dark:text-nature-400 uppercase tracking-wider mb-1">
                    {label}
                </p>
            )}
            <div className="flex gap-2 flex-wrap items-center">
                {photos.map((photo, i) => (
                    <div key={i} className="relative">
                        <img src={photo} alt={t('photo {n}', { n: i + 1 })} className="w-16 h-16 object-cover rounded-xl border border-nature-200 dark:border-nature-700 shadow-sm" />
                        <button
                            type="button"
                            onClick={() => onChange(prev => prev.filter((_, j) => j !== i))}
                            aria-label={t('Remove photo')}
                            className="absolute -top-1.5 -right-1.5 w-6 h-6 bg-bp-danger-fill hover:bg-bp-danger-hover border-none rounded-full text-bp-danger-on text-[11px] font-bold cursor-pointer flex items-center justify-center shadow-md transition-colors"
                        >
                            ✕
                        </button>
                    </div>
                ))}
                {photos.length < max && (
                    <label className="w-16 h-16 rounded-xl border-2 border-dashed border-nature-300 dark:border-nature-600 flex items-center justify-center cursor-pointer bg-nature-50 dark:bg-nature-900 text-2xl text-nature-400 dark:text-nature-300 hover:border-nature-400 hover:bg-oat-50 dark:hover:bg-nature-800 transition-all shadow-sm">
                        📷
                        <input
                            type="file"
                            accept="image/*"
                            multiple
                            aria-label={t('Add photo')}
                            className="hidden"
                            onChange={(e) => {
                                const files = Array.from(e.target.files ?? []);
                                e.target.value = '';
                                if (files.length === 0) return;
                                const before = photos.length;
                                void pickedPostPhotos(files, max - before).then((picked) => {
                                    if (picked.photos.length > 0) onChange(prev => [...prev, ...picked.photos].slice(0, max));
                                    noteLeftOut(picked.leftOut, Math.min(max, before + picked.photos.length));
                                });
                            }}
                        />
                    </label>
                )}
            </div>
            <PhotosLeftOut leftOut={leftOut} />
        </div>
    );
}
