/**
 * A listing's photos while it is being written: each one with a ✕ to take it off, and a 📷 that adds one, up to the five a
 * listing holds. The member's own composer's row (MapPage renderPhotoPicker), for a form that keeps its photos in a list of
 * data URLs. A photo goes through lib/photo-resize.ts: at most 800 px, a JPEG, the camera's metadata left behind.
 *
 * The browser's own file picker, opened only when 📷 is tapped: it asks the device for nothing (Marty, 26 Oct, from Damo).
 */
import { t } from '@beanpool/core';
import { resizePhotoFile } from '../lib/photo-resize';

/** The most photos a listing holds (the node keeps five). */
export const MAX_POST_PHOTOS = 5;

export function PostPhotoPicker({ photos, onChange, label }: { photos: string[]; onChange: (update: (prev: string[]) => string[]) => void; label?: string }) {
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
                {photos.length < MAX_POST_PHOTOS && (
                    <label className="w-16 h-16 rounded-xl border-2 border-dashed border-nature-300 dark:border-nature-600 flex items-center justify-center cursor-pointer bg-nature-50 dark:bg-nature-900 text-2xl text-nature-400 dark:text-nature-300 hover:border-nature-400 hover:bg-oat-50 dark:hover:bg-nature-800 transition-all shadow-sm">
                        📷
                        <input
                            type="file"
                            accept="image/*"
                            aria-label={t('Add photo')}
                            className="hidden"
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                e.target.value = '';
                                if (!file) return;
                                resizePhotoFile(file)
                                    .then((dataUrl) => onChange(prev => [...prev, dataUrl].slice(0, MAX_POST_PHOTOS)))
                                    .catch((err) => console.error('Could not read the picked photo:', err));
                            }}
                        />
                    </label>
                )}
            </div>
        </div>
    );
}
