import React, { useState, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, Modal, SafeAreaView, Alert, Linking, Platform } from 'react-native';
import MapView, { Marker, Circle, PROVIDER_DEFAULT } from 'react-native-maps';
import Slider from '@react-native-community/slider';
import * as Location from 'expo-location';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { colors, palette } from '../constants/colors';
import { HAS_MAPS_KEY } from '../utils/maps';

// Default to Mullumbimby for the demo/mock
const DEFAULT_LAT = -28.5523;
const DEFAULT_LNG = 153.4991;

const RADIUS_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 25, 50];

interface RadiusPickerModalProps {
    visible: boolean;
    initialRadius: number | null;
    initialLat?: number;
    initialLng?: number;
    onApply: (radius: number, lat: number, lng: number) => void;
    onCancel: () => void;
    onReset: () => void;
}

export function RadiusPickerModal({ visible, initialRadius, initialLat, initialLng, onApply, onCancel, onReset }: RadiusPickerModalProps) {
    const defaultRadius = 20;
    const mapRef = useRef<MapView | null>(null);

    const getInitialIndex = (rad: number | null) => {
        const target = rad || defaultRadius;
        const idx = RADIUS_STEPS.findIndex(s => s >= target);
        return idx >= 0 ? idx : RADIUS_STEPS.length - 1;
    };

    const [sliderIdx, setSliderIdx] = useState<number>(() => getInitialIndex(initialRadius));
    const radius = RADIUS_STEPS[sliderIdx];

    const [center, setCenter] = useState({ 
        latitude: initialLat || DEFAULT_LAT, 
        longitude: initialLng || DEFAULT_LNG 
    });

    React.useEffect(() => {
        if (visible) {
            setSliderIdx(getInitialIndex(initialRadius));
            setCenter({
                latitude: initialLat || DEFAULT_LAT,
                longitude: initialLng || DEFAULT_LNG
            });
        }
    }, [visible, initialRadius, initialLat, initialLng]);

    const region = {
        latitude: center.latitude,
        longitude: center.longitude,
        latitudeDelta: (radius / 111) * 2.5, // Rough zoom estimation based on radius
        longitudeDelta: (radius / 111) * 2.5,
    };

    const handleLocateUser = async () => {
        try {
            const { status: initStatus, canAskAgain } = await Location.getForegroundPermissionsAsync();
            let status = initStatus;
            if (status !== 'granted') {
                if (canAskAgain) {
                    const res = await Location.requestForegroundPermissionsAsync();
                    status = res.status;
                } else {
                    Alert.alert(
                        "Permission Denied", 
                        "Location permission was denied. Please enable it in settings to center the map.", 
                        [
                            { text: "Cancel", style: "cancel" },
                            { text: "Open Settings", onPress: () => Linking.openSettings() }
                        ]
                    );
                    return;
                }
            }
            if (status !== 'granted') return;
            
            const location = await Location.getCurrentPositionAsync({});
            const lat = location.coords.latitude;
            const lng = location.coords.longitude;
            
            setCenter({ latitude: lat, longitude: lng });
            
            mapRef.current?.animateToRegion({
                latitude: lat,
                longitude: lng,
                latitudeDelta: (radius / 111) * 2.5,
                longitudeDelta: (radius / 111) * 2.5,
            }, 1000);
        } catch (err) {
            console.log("Failed to fetch user location", err);
            Alert.alert("Error", "Could not fetch your current location. Make sure GPS is enabled.");
        }
    };

    return (
        <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onCancel}>
            <View style={styles.container}>
                <View style={styles.header}>
                    <Pressable onPress={onCancel} accessibilityRole="button" style={styles.headerBtn}>
                        <Text style={styles.cancelText}>Cancel</Text>
                    </Pressable>
                    <Text style={styles.title}>📍 Location & Radius</Text>
                    <Pressable onPress={onReset} accessibilityRole="button" style={styles.headerBtn}>
                        <Text style={styles.resetText}>Reset</Text>
                    </Pressable>
                </View>

                <View style={styles.mapContainer}>
                    {HAS_MAPS_KEY ? (
                        <MapView 
                            ref={mapRef}
                            style={styles.map} 
                            initialRegion={region}
                            region={region}
                            provider={PROVIDER_DEFAULT}
                            customMapStyle={mapStyle}
                            onPress={(e) => setCenter(e.nativeEvent.coordinate)}
                        >
                            <Marker 
                                coordinate={center} 
                                draggable 
                                onDragEnd={(e) => setCenter(e.nativeEvent.coordinate)} 
                            />
                            <Circle 
                                center={center}
                                radius={radius * 1000} // meters
                                strokeWidth={2}
                                strokeColor={palette.amber400}
                                lineDashPattern={[5, 5]}
                                fillColor="rgba(251, 191, 36, 0.15)"
                            />
                        </MapView>
                    ) : (
                        <View style={[styles.map, { justifyContent: 'center', alignItems: 'center', backgroundColor: colors.surface.subtle, padding: 24 }]}>
                            <MaterialCommunityIcons name="map-marker-off" size={48} color={colors.text.muted} />
                            <Text style={{ marginTop: 12, color: colors.text.body, fontWeight: '700', textAlign: 'center' }}>Google Maps is not configured</Text>
                            <Text style={{ marginTop: 4, color: colors.text.secondary, fontSize: 12, textAlign: 'center' }}>API key is missing in build config.</Text>
                        </View>
                    )}

                    {/* Floating GPS Button */}
                    <Pressable
                        style={styles.gpsBtn}
                        accessibilityRole="button"
                        accessibilityLabel="Center on my location"
                        onPress={handleLocateUser}
                    >
                        <MaterialCommunityIcons name="crosshairs-gps" size={22} color={palette.gray700} />
                    </Pressable>
                </View>

                <View style={styles.bottomPanel}>
                    <View style={styles.radiusHeaderRow}>
                        <Text style={styles.radiusLabel}>Search radius</Text>
                        <Text style={styles.radiusValue}>{radius < 1 ? `${Math.round(radius * 1000)}m` : `${radius}km`}</Text>
                    </View>
                    
                    <Slider
                        style={styles.slider}
                        minimumValue={0}
                        maximumValue={RADIUS_STEPS.length - 1}
                        step={1}
                        value={sliderIdx}
                        onValueChange={(val) => setSliderIdx(Math.round(val))}
                        minimumTrackTintColor={palette.amber600}
                        maximumTrackTintColor={palette.gray600}
                        thumbTintColor={colors.surface.subtle}
                    />
                    
                    <View style={styles.sliderLabels}>
                        <Text style={styles.sliderLabel}>100m</Text>
                        <Text style={styles.sliderLabel}>1km</Text>
                        <Text style={styles.sliderLabel}>10km</Text>
                        <Text style={styles.sliderLabel}>50km</Text>
                    </View>

                    <Text style={styles.hintText}>Tap the map or drag the pin to move the center point</Text>

                    <Pressable style={styles.applyBtn} accessibilityRole="button" onPress={() => onApply(radius, center.latitude, center.longitude)}>
                        <Text style={styles.applyBtnText}>Apply — {radius < 1 ? `${Math.round(radius * 1000)}m` : `${radius}km`} radius</Text>
                    </Pressable>
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.surface.app,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: colors.surface.card,
        paddingHorizontal: 28,
        paddingTop: 18,
        paddingBottom: 14,
        borderBottomWidth: 1,
        borderBottomColor: colors.border.default,
    },
    headerBtn: {
        padding: 8,
    },
    cancelText: {
        color: colors.text.secondary,
        fontSize: 16,
        fontWeight: '600',
    },
    resetText: {
        color: colors.feedback.danger.solid,
        fontSize: 16,
        fontWeight: '600',
    },
    title: {
        color: colors.text.heading,
        fontSize: 15,
        fontWeight: '800',
    },
    mapContainer: {
        flex: 1,
    },
    map: {
        width: '100%',
        height: '100%',
    },
    bottomPanel: {
        backgroundColor: colors.surface.card,
        padding: 24,
        paddingBottom: 40,
        borderTopWidth: 1,
        borderTopColor: colors.border.default,
    },
    radiusHeaderRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 16,
    },
    radiusLabel: {
        color: palette.gray600,
        fontSize: 16,
        fontWeight: '600',
    },
    radiusValue: {
        color: palette.amber600,
        fontSize: 20,
        fontWeight: '900',
    },
    slider: {
        width: '100%',
        height: 40,
    },
    sliderLabels: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingHorizontal: 4,
        marginBottom: 20,
    },
    sliderLabel: {
        color: colors.text.muted,
        fontSize: 12,
        fontWeight: '700',
    },
    hintText: {
        color: colors.text.muted,
        fontSize: 13,
        textAlign: 'center',
        marginBottom: 20,
        fontWeight: '500',
    },
    applyBtn: {
        backgroundColor: palette.orange600,
        paddingVertical: 15,
        borderRadius: 14,
        alignItems: 'center',
        shadowColor: palette.orange600,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.15,
        shadowRadius: 8,
        elevation: 3,
    },
    applyBtnText: {
        color: colors.text.inverse,
        fontSize: 16,
        fontWeight: '900',
    },
    gpsBtn: {
        position: 'absolute',
        bottom: 16,
        right: 16,
        backgroundColor: colors.surface.card,
        width: 44,
        height: 44,
        borderRadius: 22,
        justifyContent: 'center',
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.15,
        shadowRadius: 4,
        elevation: 4,
        borderWidth: 1,
        borderColor: colors.border.default,
    },
});

const mapStyle = [
  {
    "elementType": "geometry",
    "stylers": [
      {
        "color": "#f5f5f5"
      }
    ]
  },
  {
    "elementType": "labels.icon",
    "stylers": [
      {
        "visibility": "off"
      }
    ]
  },
  {
    "elementType": "labels.text.fill",
    "stylers": [
      {
        "color": "#616161"
      }
    ]
  },
  {
    "elementType": "labels.text.stroke",
    "stylers": [
      {
        "color": "#f5f5f5"
      }
    ]
  },
  {
    "featureType": "administrative.land_parcel",
    "elementType": "labels.text.fill",
    "stylers": [
      {
        "color": "#bdbdbd"
      }
    ]
  },
  {
    "featureType": "poi",
    "elementType": "geometry",
    "stylers": [
      {
        "color": "#eeeeee"
      }
    ]
  },
  {
    "featureType": "poi",
    "elementType": "labels.text.fill",
    "stylers": [
      {
        "color": "#757575"
      }
    ]
  },
  {
    "featureType": "poi.park",
    "elementType": "geometry",
    "stylers": [
      {
        "color": "#e5e5e5"
      }
    ]
  },
  {
    "featureType": "poi.park",
    "elementType": "labels.text.fill",
    "stylers": [
      {
        "color": "#9e9e9e"
      }
    ]
  },
  {
    "featureType": "road",
    "elementType": "geometry",
    "stylers": [
      {
        "color": "#ffffff"
      }
    ]
  },
  {
    "featureType": "road.arterial",
    "elementType": "labels.text.fill",
    "stylers": [
      {
        "color": "#757575"
      }
    ]
  },
  {
    "featureType": "road.highway",
    "elementType": "geometry",
    "stylers": [
      {
        "color": "#dadada"
      }
    ]
  },
  {
    "featureType": "road.highway",
    "elementType": "labels.text.fill",
    "stylers": [
      {
        "color": "#616161"
      }
    ]
  },
  {
    "featureType": "road.local",
    "elementType": "labels.text.fill",
    "stylers": [
      {
        "color": "#9e9e9e"
      }
    ]
  },
  {
    "featureType": "transit.line",
    "elementType": "geometry",
    "stylers": [
      {
        "color": "#e5e5e5"
      }
    ]
  },
  {
    "featureType": "transit.station",
    "elementType": "geometry",
    "stylers": [
      {
        "color": "#eeeeee"
      }
    ]
  },
  {
    "featureType": "water",
    "elementType": "geometry",
    "stylers": [
      {
        "color": "#c9c9c9"
      }
    ]
  },
  {
    "featureType": "water",
    "elementType": "labels.text.fill",
    "stylers": [
      {
        "color": "#9e9e9e"
      }
    ]
  }
];
