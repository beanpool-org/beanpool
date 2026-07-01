import React, { forwardRef } from 'react';
import ClusteredMapView from 'react-native-map-clustering';
import { Marker, Callout, PROVIDER_DEFAULT } from 'react-native-maps';

export { Marker, Callout, PROVIDER_DEFAULT };

/**
 * Patched MapView wrapper that disables LayoutAnimation on iOS by default.
 * 
 * react-native-map-clustering calls LayoutAnimation.configureNext(spring) on every
 * region change when animationEnabled=true (the default) on iOS. This causes markers
 * to fade/scale out during the cluster recalculation, making them "disappear" on zoom.
 * Android is unaffected because the library skips LayoutAnimation on Android.
 */
const MapView = forwardRef((props: any, ref: any) => (
    <ClusteredMapView
        animationEnabled={false}
        {...props}
        ref={ref}
    />
));

MapView.displayName = 'PatchedMapView';

export default MapView;
