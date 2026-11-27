/**
 * The web's post forms hold each photo's focus by the photo itself (lib/photo-focus.ts usePhotoFocusByPhoto), so a focus goes
 * wherever its photo goes: one taken off, several picked at once, the list put in whole by a tool's draft or an edit (review of
 * #3390: a tool's draft put in whole posted with another photo's focus). The same table the phone's form runs
 * (@beanpool/core/photo-focus-vectors), and a check that no form keeps a list of focus points beside its photos or opens Adjust
 * on a photo's place.
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPhotoFocusRunVectors, checkPhotoFocusVectors } from '@beanpool/core/photo-focus-vectors';
import { usePhotoFocusByPhoto } from './photo-focus';

const here = dirname(fileURLToPath(import.meta.url));
/** Every web form with photos that carry a focus. */
const FORMS = ['../pages/MapPage.tsx', '../pages/MarketplacePage.tsx'];

describe('usePhotoFocusByPhoto: each photo keeps its own focus', () => {
    it('every way a form changes its photos keeps each photo\'s own focus (the table both apps run)', () => {
        const wrong = checkPhotoFocusVectors(() => {
            const { result } = renderHook(() => usePhotoFocusByPhoto());
            let photos: string[] = [];
            return {
                setPhotos: (next) => { photos = next; },
                removed: () => act(() => { result.current.removed(); }),
                adjust: (photo, f) => {
                    act(() => { result.current.open(photo); });
                    act(() => { result.current.setAt(photo, f); result.current.close(); });
                },
                putWhole: (next, focus) => { photos = next; act(() => { result.current.resetFrom(next, focus); }); },
                sent: () => result.current.forPhotos(photos),
            };
        });
        expect(wrong).toEqual([]);
    });

    it('an edit is touched by a focus changed or a photo taken off, and put in whole untouched again', () => {
        const { result } = renderHook(() => usePhotoFocusByPhoto());
        act(() => { result.current.resetFrom(['u1', 'u2'], [null, { x: 1, y: 0 }]); });
        expect(result.current.touched).toBe(false);
        expect(result.current.at('u2')).toEqual({ x: 1, y: 0 });
        act(() => { result.current.removed(); });
        expect(result.current.touched).toBe(true);
        expect(result.current.forPhotos(['u2'])).toEqual([{ x: 1, y: 0 }]);
        act(() => { result.current.resetFrom(['u1']); });
        expect(result.current.touched).toBe(false);
        act(() => { result.current.open('u1'); });
        expect(result.current.adjusting).toBe('u1');
        act(() => { result.current.setAt('u1', { x: 0.5, y: 0.5 }); result.current.close(); });
        expect(result.current.touched).toBe(true);
        expect(result.current.adjusting).toBeNull();
        expect(result.current.forPhotos(['u1'])).toEqual([{ x: 0.5, y: 0.5 }]);
    });

    it('no web form keeps focus points in a list beside its photos, or opens Adjust on a photo\'s place', () => {
        for (const form of FORMS) {
            const src = readFileSync(resolve(here, form), 'utf8');
            expect(src, form).toContain('usePhotoFocusByPhoto()');
            expect(src, form).not.toMatch(/useState<Array<PhotoFocus \| null>>/);
            // Adjust opens on the photo itself: `.open(photo)`, never a number.
            expect(src, form).not.toMatch(/Focus\.open\(\s*i\s*\)/);
            expect(src, form).not.toMatch(/setFocusAdjusting|setEditFocusAt/);
        }
    });
});

describe('usePhotoFocusByPhoto: Adjust opens by itself on the photos a pick adds, and walks through them (Marty, 28 Nov 2026)', () => {
    it('holds every walk in core\'s table (the phone\'s usePhotoFocusList runs the same one)', () => {
        const wrong = checkPhotoFocusRunVectors(() => {
            const { result } = renderHook(() => usePhotoFocusByPhoto());
            let photos: string[] = [];
            return {
                setPhotos: (next) => { photos = next; },
                added: (added) => act(() => { result.current.added(added); }),
                open: (photo) => act(() => { result.current.open(photo); }),
                done: (f) => act(() => { result.current.done(f); }),
                skip: (f) => act(() => { result.current.skip(f); }),
                cancel: () => act(() => { result.current.close(); }),
                putWhole: (next, focus) => { photos = next; act(() => { result.current.resetFrom(next, focus); }); },
                showing: () => ({ photo: result.current.adjusting, step: result.current.step }),
                sent: () => result.current.forPhotos(photos),
            };
        });
        expect(wrong).toEqual([]);
    });

    it('an edit: Done or Skip with nothing moved marks nothing; a real change marks it touched', () => {
        const { result } = renderHook(() => usePhotoFocusByPhoto());
        act(() => { result.current.resetFrom(['u1'], [{ x: 0.2, y: 0.8 }]); });
        act(() => { result.current.added(['n1', 'n2']); });
        act(() => { result.current.done(null); });
        act(() => { result.current.skip(null); });
        act(() => { result.current.open('u1'); });
        act(() => { result.current.done({ x: 0.2, y: 0.8 }); });
        expect(result.current.touched).toBe(false);
        act(() => { result.current.added(['n3']); });
        act(() => { result.current.done({ x: 0.5, y: 0 }); });
        expect(result.current.touched).toBe(true);
        expect(result.current.forPhotos(['u1', 'n1', 'n2', 'n3'])).toEqual([{ x: 0.2, y: 0.8 }, null, null, { x: 0.5, y: 0 }]);
    });

    it('each web form opens the walk only from a pick (after the photos land), never as an edit opens, and hands the dialog its step and Skip', () => {
        for (const [form, hook] of [['../pages/MapPage.tsx', 'newPostFocus'], ['../pages/MarketplacePage.tsx', 'editFocus']] as const) {
            const src = readFileSync(resolve(here, form), 'utf8');
            // `added` is named once, in the pick's handler, right after the photos are appended.
            expect(src.split(`${hook}.added(`).length - 1, form).toBe(1);
            expect(src, form).toMatch(new RegExp(`void pickedPostPhotos\\(files, 5 - before\\)\\.then\\(\\(picked\\) => \\{\\s*if \\(picked\\.photos\\.length > 0\\) set\\w+Photos\\(prev => \\[\\.\\.\\.prev, \\.\\.\\.picked\\.photos\\]\\.slice\\(0, 5\\)\\);\\s*//[^\\n]*\\n\\s*${hook}\\.added\\(picked\\.photos\\);`));
            expect(src, form).toContain(`step={${hook}.step}`);
            expect(src, form).toContain(`onDone={${hook}.done}`);
            expect(src, form).toContain(`onSkip={${hook}.skip}`);
            expect(src, form).toContain(`onCancel={${hook}.close}`);
        }
    });
});
