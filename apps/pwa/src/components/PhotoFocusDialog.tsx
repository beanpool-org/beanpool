/**
 * Choose what a photo's card shows (Marty, 26 Nov 2026: part of a first post's photo was cut off on its card), as the phone's
 * Adjust screen (apps/native components/PhotoFocusAdjust.tsx). The whole photo with the card's frame over it at the real card's
 * shape (core MARKET_CARD_SHELL.photo.grid, 4:3), the rest dimmed; a press or a drag moves the frame to the part to keep, and
 * arrow keys move it too. The card below shows the result exactly as the Market crops it (the same object-position). Done
 * hands back the focus (core photo-focus.ts); Reset is the card's own crop again (no focus); Cancel and Escape keep nothing.
 * The photo itself is never changed or copied (photos stay one 800 px copy).
 *
 * A real dialog, as the picture crop's (PictureCropDialog.tsx): labelled by its heading, drawn over everything, the keys heard
 * before the page's. Every colour is a class of the theme's, Light and Dark; at 320 px and 130% text the words wrap.
 *
 * Portalled to the page's body, as the crop is: the map's post composer (MapPage's map-new-post-panel) is a scrolling panel
 * with a backdrop blur, and a `backdrop-filter` ancestor is the containing block of a `position: fixed` box inside it, so
 * drawn in place the dialog was laid out against the panel, clipped by it and scrolled out of sight (review of 200e812d,
 * measured in Chromium and WebKit).
 *
 * Opened by itself on the photos a pick just added (Marty, 28 Nov 2026), it walks through them in place: `step` says where it
 * stands, the button reads Next (n of count) while more are to come and Done on the last, and Skip keeps this photo's choice
 * and closes, leaving the photos not yet shown at the card's own crop. The dialog stays from photo to photo (only `src`
 * changes), so the keyboard's place stays on the button. Cancel and Escape keep nothing for the photo on screen and stop.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_PHOTO_FOCUS, MARKET_CARD_SHELL, photoFocusObjectPosition, photoFocusToward, photoFocusWindow, t, type PhotoFocus } from '@beanpool/core';

const CARD_ASPECT = MARKET_CARD_SHELL.photo.grid.aspectWidth / MARKET_CARD_SHELL.photo.grid.aspectHeight;
/** How far an arrow key moves the frame, as a share of the photo. */
const KEY_STEP = 0.05;

// max-w-full and break-words: a longer word (Next (2 of 3) in another language) wraps inside its own button at 320 px and 130%.
const primary = 'min-w-[44px] min-h-[44px] max-w-full break-words px-4 rounded-xl border-0 bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-base font-bold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400';
const plain = 'min-w-[44px] min-h-[44px] max-w-full break-words px-4 rounded-xl border border-nature-300 dark:border-nature-700 bg-transparent text-base font-bold text-nature-800 dark:text-nature-100 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';

export function PhotoFocusDialog({ src, focus, step, onDone, onSkip, onCancel }: {
    /** The photo to adjust (a data URL or the photo's address). */
    src: string;
    focus: PhotoFocus | null;
    /** A walk through several new photos: this one is `n` of `count`; `more` while photos are still to come. */
    step?: { n: number; count: number; more: boolean } | null;
    /** Next or Done, with the focus chosen for this photo. */
    onDone: (focus: PhotoFocus | null) => void;
    /** Skip (offered while a walk has photos still to come), with the focus chosen for this photo. */
    onSkip?: (focus: PhotoFocus | null) => void;
    onCancel: () => void;
}) {
    const titleId = useId();
    const hintId = useId();
    // The photo's shape, with the photo it was read from: the next photo of a walk never borrows the last one's shape while it loads.
    const [measured, setMeasured] = useState<{ src: string; aspect: number } | null>(null);
    const aspect = measured && measured.src === src ? measured.aspect : null;
    const more = !!step?.more;
    const [picked, setPicked] = useState<PhotoFocus | null>(focus);
    const stageRef = useRef<HTMLDivElement | null>(null);
    const dragging = useRef(false);

    useEffect(() => { setPicked(focus); }, [focus, src]);
    // Escape is Cancel, heard before the page's own (a form under the dialog).
    useEffect(() => {
        const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onCancel(); } };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [onCancel]);

    const shown = picked ?? DEFAULT_PHOTO_FOCUS;
    const win = aspect ? photoFocusWindow(aspect, CARD_ASPECT, shown) : null;
    const moveTo = (clientX: number, clientY: number) => {
        const box = stageRef.current?.getBoundingClientRect();
        if (!aspect || !box || box.width <= 0 || box.height <= 0) return;
        const px = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
        const py = Math.min(1, Math.max(0, (clientY - box.top) / box.height));
        setPicked((was) => photoFocusToward(aspect, CARD_ASPECT, px, py, was ?? DEFAULT_PHOTO_FOCUS));
    };
    const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
        dragging.current = true;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not every browser */ }
        moveTo(e.clientX, e.clientY);
    };
    const onPointerMove = (e: PointerEvent<HTMLDivElement>) => { if (dragging.current) moveTo(e.clientX, e.clientY); };
    const onPointerEnd = () => { dragging.current = false; };
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        const step: Record<string, [number, number]> = { ArrowLeft: [-KEY_STEP, 0], ArrowRight: [KEY_STEP, 0], ArrowUp: [0, -KEY_STEP], ArrowDown: [0, KEY_STEP] };
        const d = step[e.key];
        if (!d) return;
        e.preventDefault();
        setPicked((was) => {
            const f = was ?? DEFAULT_PHOTO_FOCUS;
            return { x: Math.min(1, Math.max(0, Math.round((f.x + d[0]) * 1000) / 1000)), y: Math.min(1, Math.max(0, Math.round((f.y + d[1]) * 1000) / 1000)) };
        });
    };

    // In a fragment, as PictureCropDialog's: the portal's own type is react-dom's copy of React's, which this file can't name.
    return <>{createPortal(
        <div data-testid="photo-focus-backdrop" className="fixed inset-0 flex items-end sm:items-center justify-center sm:p-4 bg-black/60" style={{ zIndex: 1200 }}>
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={hintId}
                data-testid="photo-focus-dialog"
                className="w-full sm:max-w-lg max-h-full overflow-y-auto outline-none bg-white dark:bg-nature-950 rounded-t-2xl sm:rounded-2xl shadow-2xl p-4 min-w-0 flex flex-col gap-3"
            >
                <h2 id={titleId} className="m-0 text-lg font-extrabold text-nature-950 dark:text-white break-words">{t('Choose what the card shows')}</h2>
                <p id={hintId} className="m-0 text-sm text-nature-700 dark:text-nature-200 break-words">
                    {t('Drag or tap the part of the photo to keep. The whole photo still shows when someone opens the post.')}
                </p>
                <div
                    ref={stageRef}
                    data-testid="photo-focus-stage"
                    role="application"
                    tabIndex={0}
                    aria-label={t('Photo with the card frame over it')}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerEnd}
                    onPointerCancel={onPointerEnd}
                    onKeyDown={onKeyDown}
                    className="relative mx-auto overflow-hidden rounded-xl bg-black touch-none select-none cursor-crosshair focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                    style={aspect && aspect < 1 ? { height: 'min(18rem, 60vh)', aspectRatio: String(aspect) } : { width: '100%', aspectRatio: String(aspect ?? CARD_ASPECT) }}
                >
                    <img
                        src={src}
                        alt=""
                        draggable={false}
                        className="absolute inset-0 w-full h-full pointer-events-none"
                        onLoad={(e) => { const i = e.currentTarget; setMeasured({ src, aspect: i.naturalWidth > 0 && i.naturalHeight > 0 ? i.naturalWidth / i.naturalHeight : 1 }); }}
                    />
                    {win ? (
                        <div
                            data-testid="photo-focus-frame"
                            aria-hidden="true"
                            className="absolute pointer-events-none border-2 border-white"
                            style={{ left: `${win.left * 100}%`, top: `${win.top * 100}%`, width: `${win.width * 100}%`, height: `${win.height * 100}%`, boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)' }}
                        />
                    ) : null}
                </div>
                <p className="m-0 text-xs font-bold uppercase tracking-wide text-nature-600 dark:text-nature-300">{t('On the card')}</p>
                <div className="mx-auto w-3/5 aspect-[4/3] rounded-xl overflow-hidden border border-nature-200 dark:border-nature-800">
                    <img data-testid="photo-focus-card" src={src} alt="" className="w-full h-full object-cover" style={{ objectPosition: photoFocusObjectPosition(shown) }} />
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                    <button type="button" onClick={() => setPicked(null)} className={plain}>{t('Reset')}</button>
                    <button type="button" onClick={onCancel} className={plain}>{t('Cancel')}</button>
                    {more && onSkip ? (
                        <button type="button" data-testid="photo-focus-skip" onClick={() => onSkip(picked)} className={plain}>{t('Skip')}</button>
                    ) : null}
                    <button type="button" data-testid="photo-focus-done" onClick={() => onDone(picked)} className={primary}>
                        {more && step ? t('Next ({n} of {count})', { n: step.n, count: step.count }) : t('Done')}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    )}</>;
}
