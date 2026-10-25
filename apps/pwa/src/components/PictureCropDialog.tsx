/**
 * The crop dialog: one for every picture drawn in a fixed shape on the web (Marty, 25 Oct 2026: "this should be the case for
 * all image selection where size restrictions apply on both phone and pwa"). What the member crops is exactly what is shown.
 * The picture under a frame of the shape (a circle for an avatar or a logo, 3:1 for a shop's banner), the rest of it dimmed:
 *
 * - Mouse and touch: drag the picture to move it; two fingers, the mouse wheel, the slider or − and + zoom it.
 * - Keyboard: the arrow keys move it a tenth of the frame, + and − zoom; Tab goes round the dialog's controls and stays in
 *   it; Escape is Cancel. The keys work wherever focus is in the dialog, the slider's own arrows aside.
 * - The frame is never left empty (core picture-crop.ts settles every move); Done draws exactly the part in the frame
 *   (lib/picture-crop.ts drawPictureCrop) and Cancel keeps nothing.
 *
 * A real dialog, as Home's (components/AddCardDialog.tsx): `role="dialog"`, labelled by its heading, drawn over everything
 * (a sheet or form under it included), focus moved in and given back to what opened it. At 320 px and 1.3× text it is one
 * column and its words wrap; every control is at least 44 px. Colours are the page's nature scale with its dark pairs and
 * the central bp-* tokens; the stage under the picture is black in both themes, so the picture reads as it is.
 *
 * usePictureCrop: `crop(file, shape)` reads the file, opens the dialog, and answers with the part chosen (a JPEG data URL),
 * null on Cancel; it rejects when the file can't be read or drawn, for its caller to say so in its own words.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
    PICTURE_CROP_MAX_ZOOM, PICTURE_CROP_MOVE_STEP, PICTURE_CROP_ZOOM_STEP, cropPlacement, cropRectOf, moveCropView, startCropView,
    t, zoomCropView, type CropView, type PictureShape,
} from '@beanpool/core';
import { drawPictureCrop, readPictureFile, type LoadedPicture } from '../lib/picture-crop';

const primary = 'min-w-[44px] min-h-[44px] px-4 rounded-xl border-0 bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-base font-bold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-50';
const plain = 'min-w-[44px] min-h-[44px] px-4 rounded-xl border border-nature-300 dark:border-nature-700 bg-transparent text-base font-bold text-nature-800 dark:text-nature-100 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';
const zoomButton = 'shrink-0 w-11 h-11 rounded-full border border-nature-300 dark:border-nature-700 bg-transparent text-xl font-bold leading-none text-nature-800 dark:text-nature-100 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';

/** The stage's width before it is measured (and where nothing is laid out). */
const FALLBACK_WIDTH = 288;
/** The space kept round the frame inside the stage, so the dimmed picture shows what lies outside it. */
const FRAME_MARGIN = 16;
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The frame inside a stage of this size: as large as fits, centred. */
function frameIn(width: number, height: number, aspect: number) {
    const w = Math.max(1, Math.min(width - 2 * FRAME_MARGIN, (height - 2 * FRAME_MARGIN) * aspect));
    const h = w / aspect;
    return { width: w, height: h, left: (width - w) / 2, top: (height - h) / 2 };
}

type Point = { x: number; y: number };
const apart = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export function PictureCropDialog({ picture, shape, onCancel, onDone, onFailed }: {
    picture: LoadedPicture;
    shape: PictureShape;
    onCancel: () => void;
    /** The part chosen, as a JPEG data URL. */
    onDone: (dataUrl: string) => void;
    /** It couldn't be drawn: the dialog closes, and its opener says so. */
    onFailed: (e: unknown) => void;
}) {
    const titleId = useId();
    const hintId = useId();
    const dialog = useRef<HTMLDivElement | null>(null);
    const stageRef = useRef<HTMLDivElement | null>(null);
    const [stageWidth, setStageWidth] = useState(FALLBACK_WIDTH);
    const [view, setView] = useState<CropView>(() => startCropView(picture));
    const viewRef = useRef(view);
    const show = useCallback((next: CropView) => { viewRef.current = next; setView(next); }, []);

    // A square stage for a round picture, a 4:3 one for a wide one (room above and below the strip), never taller than
    // most of the window.
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 640;
    const stageHeight = Math.round(Math.min(stageWidth * (shape.aspect >= 2 ? 0.75 : 1), Math.max(200, viewportHeight * 0.55)));
    const frame = frameIn(stageWidth, stageHeight, shape.aspect);
    const frameRef = useRef(frame);
    frameRef.current = frame;
    const rect = cropRectOf(picture, shape, view);
    const placed = cropPlacement(picture, rect, frame.width);

    const zoom = useCallback((factor: number) => show(zoomCropView(picture, shape, viewRef.current, factor)), [picture, shape, show]);
    const move = useCallback((dx: number, dy: number) => show(moveCropView(picture, shape, viewRef.current, dx, dy)), [picture, shape, show]);

    // Its width as laid out, again whenever it changes (a phone turned, a window resized).
    useLayoutEffect(() => {
        const el = stageRef.current;
        if (!el) return;
        const measure = () => { if (el.clientWidth > 0) setStageWidth(el.clientWidth); };
        measure();
        if (typeof ResizeObserver === 'function') {
            const watch = new ResizeObserver(measure);
            watch.observe(el);
            return () => watch.disconnect();
        }
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, []);

    // Focus in on open (the picture, so the keys move it at once) and back to what opened it on close.
    useEffect(() => {
        const opener = document.activeElement as HTMLElement | null;
        stageRef.current?.focus();
        return () => { if (opener && opener !== document.body && opener.isConnected) opener.focus?.(); };
    }, []);

    // The mouse wheel zooms: a listener of its own, as React's is passive and could not keep the page from scrolling.
    useEffect(() => {
        const el = stageRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            zoom(Math.exp(-e.deltaY * 0.002));
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [zoom]);

    // Fingers and the mouse on the picture: one moves it, two pinch. A gesture starts again whenever a finger comes or goes.
    const pointers = useRef(new Map<number, Point>());
    const gesture = useRef<{ from: CropView; at: Point; spread: number | null } | null>(null);
    const restart = () => {
        const pts = [...pointers.current.values()];
        gesture.current = pts.length ? { from: viewRef.current, at: pts[0], spread: pts.length >= 2 ? apart(pts[0], pts[1]) : null } : null;
    };
    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        restart();
    };
    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!pointers.current.has(e.pointerId)) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const g = gesture.current;
        if (!g) return;
        const pts = [...pointers.current.values()];
        if (pts.length >= 2 && g.spread) {
            show(zoomCropView(picture, shape, g.from, apart(pts[0], pts[1]) / g.spread));
        } else if (pts.length === 1) {
            const f = frameRef.current;
            show(moveCropView(picture, shape, g.from, (pts[0].x - g.at.x) / f.width, (pts[0].y - g.at.y) / f.height));
        }
    };
    const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
        pointers.current.delete(e.pointerId);
        restart();
    };

    const done = () => {
        try {
            onDone(drawPictureCrop(picture, cropRectOf(picture, shape, viewRef.current), shape));
        } catch (err) {
            onFailed(err);
        }
    };

    // The keys are the dialog's wherever focus is while it is open (a click on its heading, or Safari after a button, leaves focus on
    // <body>): one listener on the window, before anything else hears them, so a page's own Escape under it never does.
    const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
    onKey.current = (e: KeyboardEvent) => {
        const mine = dialog.current;
        if (!mine) return;
        // Only the topmost crop dialog answers.
        const open = document.querySelectorAll('[data-testid="picture-crop"]');
        if (open[open.length - 1] !== mine) return;
        const inside = e.target instanceof Node && mine.contains(e.target);
        const onSlider = inside && (e.target as HTMLElement).getAttribute?.('type') === 'range';
        const steps: Record<string, () => void> = {
            '+': () => zoom(PICTURE_CROP_ZOOM_STEP), '=': () => zoom(PICTURE_CROP_ZOOM_STEP),
            '-': () => zoom(1 / PICTURE_CROP_ZOOM_STEP), '_': () => zoom(1 / PICTURE_CROP_ZOOM_STEP), '−': () => zoom(1 / PICTURE_CROP_ZOOM_STEP),
            ...(onSlider ? {} : {
                ArrowLeft: () => move(-PICTURE_CROP_MOVE_STEP, 0), ArrowRight: () => move(PICTURE_CROP_MOVE_STEP, 0),
                ArrowUp: () => move(0, -PICTURE_CROP_MOVE_STEP), ArrowDown: () => move(0, PICTURE_CROP_MOVE_STEP),
            }),
            Escape: onCancel,
        };
        const step = steps[e.key];
        if (step) {
            // Kept here: a page's own Escape (a form's, under this dialog) never sees it.
            e.preventDefault();
            e.stopPropagation();
            step();
            return;
        }
        if (e.key !== 'Tab') return;
        const items = Array.from(mine.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const at = document.activeElement;
        if (!at || !mine.contains(at)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
        else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    };
    useEffect(() => {
        const listen = (e: KeyboardEvent) => onKey.current(e);
        window.addEventListener('keydown', listen, true);
        return () => window.removeEventListener('keydown', listen, true);
    }, []);

    return <>{createPortal(
        // Above everything while it is open (Home's dialogs, 1100; the install banner, 1000): it is modal.
        <div className="fixed inset-0 flex items-end sm:items-center justify-center sm:p-4" style={{ zIndex: 1200, background: 'rgba(0,0,0,0.6)' }}>
            <div
                ref={dialog}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={hintId}
                data-testid="picture-crop"
                data-aspect={String(shape.aspect)}
                data-round={String(shape.round)}
                tabIndex={-1}
                className="w-full sm:max-w-lg max-h-full overflow-y-auto outline-none bg-white dark:bg-nature-950 rounded-t-2xl sm:rounded-2xl shadow-2xl p-4 min-w-0 flex flex-col gap-3"
            >
                <h2 id={titleId} className="m-0 text-lg font-extrabold text-nature-950 dark:text-white break-words">{t('Choose the part that shows')}</h2>
                <p id={hintId} className="m-0 text-sm text-nature-700 dark:text-nature-200 break-words">
                    {t('Drag the picture to move it, and zoom with the slider, the buttons or two fingers. With a keyboard, the arrow keys move it and + and − zoom.')}
                </p>
                <div
                    ref={stageRef}
                    data-testid="picture-crop-stage"
                    role="application"
                    aria-label={t('The part of the picture that shows')}
                    aria-describedby={hintId}
                    tabIndex={0}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerEnd}
                    onPointerCancel={onPointerEnd}
                    className="relative w-full overflow-hidden rounded-xl bg-black touch-none select-none cursor-grab active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                    style={{ height: stageHeight }}
                >
                    <img
                        src={picture.src}
                        alt=""
                        draggable={false}
                        className="absolute max-w-none pointer-events-none"
                        style={{ left: frame.left + placed.left, top: frame.top + placed.top, width: placed.width, height: placed.height }}
                    />
                    {/* The frame; its shadow dims everything round it. */}
                    <div
                        data-testid="picture-crop-frame"
                        aria-hidden="true"
                        className="absolute pointer-events-none border-2 border-white"
                        style={{
                            left: frame.left, top: frame.top, width: frame.width, height: frame.height,
                            borderRadius: shape.round ? '50%' : 0, boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
                        }}
                    />
                </div>
                <div className="flex items-center gap-3">
                    <button type="button" aria-label={t('Zoom out')} onClick={() => zoom(1 / PICTURE_CROP_ZOOM_STEP)} className={zoomButton}>−</button>
                    <input
                        type="range"
                        aria-label={t('Zoom')}
                        min={1}
                        max={PICTURE_CROP_MAX_ZOOM}
                        step="any"
                        value={view.zoom}
                        onChange={(e) => { const z = Number(e.target.value); if (z > 0) zoom(z / viewRef.current.zoom); }}
                        className="flex-1 min-w-0 h-11 accent-emerald-600 cursor-pointer"
                    />
                    <button type="button" aria-label={t('Zoom in')} onClick={() => zoom(PICTURE_CROP_ZOOM_STEP)} className={zoomButton}>+</button>
                </div>
                <div className="flex gap-3">
                    <button type="button" onClick={onCancel} className={`${plain} flex-1`}>{t('Cancel')}</button>
                    <button type="button" onClick={done} className={`${primary} flex-1`}>{t('Done')}</button>
                </div>
            </div>
        </div>,
        document.body,
    )}</>;
}

/**
 * The crop dialog for a form: `crop(file, shape)` reads the file and opens the dialog; it answers with the part chosen,
 * null on Cancel (or when the form goes away), and rejects when the file couldn't be read or drawn. `cancel()` gives up
 * the one being read or cropped (a ready-made picture chosen meanwhile): it answers null and no dialog opens for it.
 * `dialog` is drawn anywhere in the form (it is put over the page).
 */
export function usePictureCrop(): { crop: (file: Blob, shape: PictureShape) => Promise<string | null>; cancel: () => void; dialog: ReactNode } {
    const [open, setOpen] = useState<{ picture: LoadedPicture; shape: PictureShape; resolve: (v: string | null) => void; reject: (e: unknown) => void } | null>(null);
    const openRef = useRef(open);
    openRef.current = open;
    // The latest crop asked for: one read after another was asked, or after cancel(), never opens.
    const asked = useRef(0);
    useEffect(() => () => { openRef.current?.resolve(null); }, []);
    const crop = useCallback(async (file: Blob, shape: PictureShape) => {
        const mine = ++asked.current;
        const picture = await readPictureFile(file);
        if (mine !== asked.current) return null;
        return new Promise<string | null>((resolve, reject) => {
            openRef.current?.resolve(null);
            setOpen({ picture, shape, resolve, reject });
        });
    }, []);
    const cancel = useCallback(() => {
        asked.current++;
        openRef.current?.resolve(null);
        setOpen(null);
    }, []);
    const dialog = useMemo(() => (open ? (
        <PictureCropDialog
            picture={open.picture}
            shape={open.shape}
            onCancel={() => { open.resolve(null); setOpen(null); }}
            onDone={(dataUrl) => { open.resolve(dataUrl); setOpen(null); }}
            onFailed={(e) => { open.reject(e); setOpen(null); }}
        />
    ) : null), [open]);
    return { crop, cancel, dialog };
}
