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
import { checkPhotoFocusVectors } from '@beanpool/core/photo-focus-vectors';
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
