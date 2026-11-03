import { describe, expect, it } from 'vitest';
import { BRAND_COLOURS } from '@beanpool/core';
import { CLUSTER_FILL, clusterIcon, clusterLabel, clusterStyle, elderHaloHtml, ELDER_HALO_GOLD } from './map-pin-style';

describe('the web bubble is the phone\'s ClusterVisual (apps/native/components/UnifiedMapPin.tsx getClusterStyle)', () => {
    it.each([
        [1, 36, 48], [4, 36, 48], [5, 42, 54], [9, 42, 54], [10, 46, 60], [14, 46, 60], [15, 50, 66],
        [24, 50, 66], [25, 56, 72], [49, 56, 72], [50, 64, 80], [120, 64, 80],
    ])('%i pins: a %ipx bubble in a %ipx glow', (points, size, glow) => {
        expect(clusterStyle(points)).toMatchObject({ size, glow });
    });

    it('says 99+ from 99, and the count below', () => {
        expect(clusterLabel(98)).toBe('98');
        expect(clusterLabel(99)).toBe('99+');
        expect(clusterLabel(3)).toBe('3');
        expect(clusterIcon(120).html).toContain('>99+<');
    });

    it('the icon box is the glow circle, anchored at its middle, so a tap lands on the bubble at every size', () => {
        for (const n of [3, 12, 30, 120]) {
            const { glow, size } = clusterStyle(n);
            const icon = clusterIcon(n);
            expect(icon.iconSize).toEqual([glow, glow]);
            expect(icon.iconAnchor).toEqual([glow / 2, glow / 2]);
            expect(icon.html).toContain(`width: ${size}px`);
        }
    });

    it('is the central info blue with a white 3px ring', () => {
        expect(CLUSTER_FILL).toBe(BRAND_COLOURS.info.fill.light);
        expect(CLUSTER_FILL).toBe('#2563eb');
        expect(clusterIcon(3).html).toContain('border: 3px solid #ffffff');
    });
});

describe('the Elder halo', () => {
    it('is nothing for anyone else', () => {
        expect(elderHaloHtml(false, 40)).toBe('');
    });

    it('is a gold circle 3px past the ring, 2px thick at 60%, and does not touch the ring', () => {
        const html = elderHaloHtml(true, 40);
        expect(html).toContain('width: 46px; height: 46px');
        expect(html).toContain('top: -3px; left: -3px');
        expect(html).toContain(`border: 2px solid ${ELDER_HALO_GOLD}`);
        expect(html).toContain('opacity: 0.6');
        expect(html).toContain('pointer-events: none');
    });
});
