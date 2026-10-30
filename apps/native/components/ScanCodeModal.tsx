import { useEffect, useRef } from 'react';
import { Modal, View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useWords } from './LanguageProvider';

/**
 * The camera, full screen, reading one QR code (Find a community's Scan a code, slice S3). Loaded only when the member taps
 * Scan (app/find-community.tsx imports this file then), and the camera is asked for then, at the tap that needs it, never
 * before (memory: permissions only when asked). Refused, the member is told what to type instead and the camera closes.
 *
 * `onRead` says whether the code was one the screen can use: true closes the camera; false keeps it reading.
 */
export default function ScanCodeModal({ hint, deniedText, onRead, onClose }: {
    hint: string;
    /** What to do instead when the camera is off ("…or type the community's address"). */
    deniedText: string;
    onRead(data: string): boolean;
    onClose(): void;
}) {
    const { t } = useWords();
    const [permission, requestPermission] = useCameraPermissions();
    const done = useRef(false);

    useEffect(() => {
        if (!permission || permission.granted) return;
        let alive = true;
        requestPermission().then((p) => {
            if (!alive || p.granted) return;
            Alert.alert(t('Camera is off'), deniedText);
            onClose();
        }).catch(() => { if (alive) onClose(); });
        return () => { alive = false; };
    }, [permission?.granted]);

    const scanned = ({ data }: BarcodeScanningResult) => {
        if (done.current) return;
        if (onRead(data)) done.current = true;
    };

    return (
        <Modal visible animationType="slide" onRequestClose={onClose}>
            <View style={styles.wrap}>
                {permission?.granted && (
                    <CameraView style={StyleSheet.absoluteFillObject} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={scanned} />
                )}
                <Text style={styles.hint}>{hint}</Text>
                <Pressable style={styles.close} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('Close the camera')}>
                    <MaterialCommunityIcons name="close" size={24} color="#fff" />
                </Pressable>
            </View>
        </Modal>
    );
}

// The camera's own black, whatever the theme: the picture is the screen.
const styles = StyleSheet.create({
    wrap: { flex: 1, backgroundColor: '#000' },
    close: { position: 'absolute', top: 48, right: 16, width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
    hint: { position: 'absolute', left: 16, right: 16, bottom: 48, color: '#fff', fontSize: 15, lineHeight: 21, textAlign: 'center' },
});
