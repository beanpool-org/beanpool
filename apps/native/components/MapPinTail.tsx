import React from 'react';
import { View, StyleSheet } from 'react-native';

export default function MapPinTail({ color }: { color: string }) {
    // Relative positioning forces the Android Layout Engine (WRAP_CONTENT)
    // to explicitly expand the vertical bounds of the marker bitmap to fit this shape.
    // If this was `position: 'absolute'`, Android drops the height from the canvas 
    // bounds entirely, which violently chops the bottom of the arrow off natively.
    return (
        <View style={styles.tailWrapper}>
            <View style={[styles.tail, { backgroundColor: color }]} />
        </View>
    );
}

const styles = StyleSheet.create({
    tailWrapper: {
        width: 20,
        height: 20, 
        alignItems: 'center',
        justifyContent: 'center',
        transform: [{ translateY: -12 }], // Visually slides the diamond up WITHOUT shrinking the allocated Marker rasterization Canvas natively!
        zIndex: 1,
    },
    tail: {
        width: 14,
        height: 14,
        transform: [{ rotate: '45deg' }],
    }
});
