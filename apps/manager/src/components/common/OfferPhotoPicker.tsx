/**
 * An Offer's photos while the Manager writes it for an enterprise: each one with a ✕ to take it off, and a 📷 that adds
 * one, up to the five a listing holds. The node refuses a new Offer with no photo (every listing in the Market has one,
 * the admin routes included), so each Manager form that posts an Offer keeps its photos here, as data URLs. A photo
 * goes through lib/photo-resize.ts: at most 800 px, a JPEG, the camera's metadata left behind.
 *
 * The browser's own file picker, opened only when 📷 is clicked: it asks the device for nothing.
 */
import { useState } from 'react';
import { resizePhotoFile } from '../../lib/photo-resize';

/** The most photos a listing holds (the node keeps five). */
export const MAX_OFFER_PHOTOS = 5;

export function OfferPhotoPicker({
    photos,
    onChange,
    label = 'Photo',
    labelClassName = 'block text-xs font-bold text-nature-300 mb-1',
}: {
    photos: string[];
    onChange: (update: (prev: string[]) => string[]) => void;
    label?: string;
    labelClassName?: string;
}) {
    const [unreadable, setUnreadable] = useState(false);
    return (
        <div>
            <p className={labelClassName}>{label}</p>
            <div className="flex gap-2 flex-wrap items-center">
                {photos.map((photo, i) => (
                    <div key={i} className="relative">
                        <img src={photo} alt={`photo ${i + 1}`} className="w-16 h-16 object-cover rounded-xl border border-nature-700" />
                        <button
                            type="button"
                            onClick={() => onChange((prev) => prev.filter((_, j) => j !== i))}
                            aria-label="Remove photo"
                            className="absolute -top-1.5 -right-1.5 w-6 h-6 bg-bp-danger-fill hover:bg-bp-danger-hover rounded-full text-bp-danger-on text-[11px] font-bold flex items-center justify-center shadow-md"
                        >
                            ✕
                        </button>
                    </div>
                ))}
                {photos.length < MAX_OFFER_PHOTOS && (
                    <label className="w-16 h-16 rounded-xl border-2 border-dashed border-nature-600 flex items-center justify-center cursor-pointer bg-nature-950 text-2xl text-nature-300 hover:border-nature-400">
                        📷
                        <input
                            type="file"
                            accept="image/*"
                            aria-label="Add photo"
                            className="hidden"
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                e.target.value = '';
                                if (!file) return;
                                setUnreadable(false);
                                resizePhotoFile(file)
                                    .then((dataUrl) => onChange((prev) => [...prev, dataUrl].slice(0, MAX_OFFER_PHOTOS)))
                                    .catch(() => setUnreadable(true));
                            }}
                        />
                    </label>
                )}
            </div>
            {unreadable && (
                <p role="alert" className="text-[11px] text-red-300 mt-1 mb-0">
                    That picture could not be read. Choose a JPEG, PNG or WebP photo.
                </p>
            )}
        </div>
    );
}
