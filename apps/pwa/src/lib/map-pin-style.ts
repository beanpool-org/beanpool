/**
 * How the web map's pins and bubbles are drawn, the phone's (apps/native/components/UnifiedMapPin.tsx, read only), as the
 * plain HTML a Leaflet divIcon takes. MapPage.tsx calls these; they are here so a test can read the numbers.
 *
 *   - A pin's ring is always its type colour (green offer, terracotta need, indigo for a remote pin). An Elder (an author
 *     who has cycled 1,400+ Beans) adds a gold halo OUTSIDE the ring: a circle 3 px past it, 2 px thick, 60 % opaque. The
 *     ring is never swapped to gold (Marty, 3 Nov: "Type colour + gold halo"), so an Elder's offer and need still differ.
 *   - A bubble is the phone's ClusterVisual: the blue fill, a white 3 px ring and a translucent blue glow, in six sizes by
 *     the number of pins inside, and "99+" from 99.
 */
import { BRAND_COLOURS } from '@beanpool/core';

/** The Elder halo's gold: the phone's `#fbbf24`. */
export const ELDER_HALO_GOLD = '#fbbf24';
/** How far past the ring the halo sits, its thickness and its opacity: the phone's r + 3, strokeWidth 2, opacity 0.6. */
export const ELDER_HALO_GAP_PX = 3;
export const ELDER_HALO_WIDTH_PX = 2;
export const ELDER_HALO_OPACITY = 0.6;

/** The bubble's fill: the central info blue (#2563eb, the phone's palette.blue600). */
export const CLUSTER_FILL = BRAND_COLOURS.info.fill.light;
/** The glow behind a bubble: the phone's rgba(59, 130, 246, 0.25), blue500 at a quarter. */
export const CLUSTER_GLOW = 'rgba(59, 130, 246, 0.25)';
export const CLUSTER_RING = '#ffffff';
export const CLUSTER_RING_PX = 3;

export interface ClusterStyle {
    /** The solid circle's outside width, ring included. */
    size: number;
    /** The glow circle's width: the icon's whole box. */
    glow: number;
    fontSize: number;
}

/** The phone's getClusterStyle: 36 / 42 / 46 / 50 / 56 / 64 at 1 / 5 / 10 / 15 / 25 / 50 pins. */
export function clusterStyle(points: number): ClusterStyle {
    if (points >= 50) return { size: 64, glow: 80, fontSize: 20 };
    if (points >= 25) return { size: 56, glow: 72, fontSize: 19 };
    if (points >= 15) return { size: 50, glow: 66, fontSize: 18 };
    if (points >= 10) return { size: 46, glow: 60, fontSize: 17 };
    if (points >= 5) return { size: 42, glow: 54, fontSize: 16 };
    return { size: 36, glow: 48, fontSize: 15 };
}

/** What the bubble says: the count, and "99+" from 99. */
export const clusterLabel = (points: number): string => (points >= 99 ? '99+' : String(points));

/**
 * The divIcon for a bubble of this many pins. The icon's box is the glow circle, anchored at its middle, so the point the
 * library places the bubble at is the bubble's centre and a tap lands on it at every size.
 */
export function clusterIcon(points: number): { html: string; iconSize: [number, number]; iconAnchor: [number, number] } {
    const { size, glow, fontSize } = clusterStyle(points);
    const labelSize = points >= 99 ? fontSize - 3 : fontSize;
    const html = `<div style="position: relative; width: ${glow}px; height: ${glow}px; display: flex; align-items: center; justify-content: center;">`
        + `<div style="position: absolute; inset: 0; border-radius: 50%; background-color: ${CLUSTER_GLOW};"></div>`
        + `<div data-cluster-bubble style="position: relative; box-sizing: border-box; width: ${size}px; height: ${size}px; border-radius: 50%; background-color: ${CLUSTER_FILL}; border: ${CLUSTER_RING_PX}px solid ${CLUSTER_RING}; color: #ffffff; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: ${labelSize}px; line-height: 1;">${clusterLabel(points)}</div>`
        + `</div>`;
    return { html, iconSize: [glow, glow], iconAnchor: [glow / 2, glow / 2] };
}

/**
 * The Elder halo behind a pin's ring, for a ring `ringPx` wide, or '' for anyone else. Drawn under the ring (the caller
 * puts it first, the ring has the higher z-index) and past its edge, so the ring keeps its type colour.
 */
export function elderHaloHtml(elder: boolean, ringPx: number): string {
    if (!elder) return '';
    const side = ringPx + ELDER_HALO_GAP_PX * 2;
    return `<div data-elder-halo style="position: absolute; top: -${ELDER_HALO_GAP_PX}px; left: -${ELDER_HALO_GAP_PX}px; width: ${side}px; height: ${side}px; box-sizing: border-box; border-radius: 50%; border: ${ELDER_HALO_WIDTH_PX}px solid ${ELDER_HALO_GOLD}; opacity: ${ELDER_HALO_OPACITY}; z-index: 1; pointer-events: none;"></div>`;
}
