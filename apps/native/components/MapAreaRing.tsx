import React, { useMemo } from 'react';
import { PixelRatio, Platform } from 'react-native';
import { Polyline } from 'react-native-maps';
import { AREA_RING_WIDTH, areaRingColour, areaRingDash, areaRingPoints } from '@beanpool/core';

/**
 * The community's area on a phone's map: a thin dashed line round its edge, no fill (core's map-area-ring.ts).
 *
 * It is a closed Polyline and not a Circle because react-native-maps' Circle has no dash on Android (MapCircle.java draws a
 * solid stroke). `lineCap` has to say butt: the library defaults it to round, and on Android a round cap turns every dash
 * into a dot (MapPolyline.java, applyPattern). A line takes no taps unless it is asked to, on either platform.
 */
export function MapAreaRing({ area, darkMap }: { area: { lat: number; lng: number; radiusKm: number }; darkMap: boolean }) {
    const { lat, lng, radiusKm } = area;
    const coordinates = useMemo(() => areaRingPoints({ latitude: lat, longitude: lng }, radiusKm), [lat, lng, radiusKm]);
    return (
        <Polyline
            coordinates={coordinates}
            strokeColor={areaRingColour(darkMap)}
            strokeWidth={AREA_RING_WIDTH}
            lineCap="butt"
            lineDashPattern={areaRingDash(Platform.OS, PixelRatio.get())}
            tappable={false}
        />
    );
}
