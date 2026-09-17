/**
 * NewEventModal — create an event from the Market's "Create New Post" sheet (docs/events-on-the-map.md §3
 * "Create form", slice 3). Opened the way NewPollModal is, so the protected map screen is not involved.
 *
 * One column, in the design's order: title; Starts / Ends (optional, 2 hours after start if blank); place
 * name; the pin with Approximate and the public-pin warning; description; photo; the note for people who are
 * going; audience (this community or a group); and "Post as", shown only to a keeper or convenor.
 *
 * Reach is always local in v1 (§2.4), so there is no linked-communities option. Keyboard avoidance comes from
 * react-native-keyboard-controller's root provider; this Modal must not add its own.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
    View, Text, StyleSheet, Modal, TextInput, Pressable, ScrollView, Alert, ActivityIndicator, Platform,
    Linking, Keyboard,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Crypto from 'expo-crypto';
import { Image } from 'expo-image';
import { useTheme, useStyles, type ThemeContextType } from '../app/ThemeContext';
import { useIdentity } from '../app/IdentityContext';
import { createPost, fetchGroups, getBalance, getTreasuries } from '../utils/db';
import { HAS_MAPS_KEY } from '../utils/maps';
import {
    buildEventDraft, approximatePin, defaultEventEnd, formatPickerValue,
    EVENT_PIN_WARNING, EVENT_PIN_HINT, EVENT_PLACE_NAME_MAX, EVENT_PRIVATE_NOTE_MAX, EVENT_TITLE_MAX,
} from '../utils/events';
import { EVENT_ACCENT } from './EventCard';

// Mullumbimby, as the radius picker uses, until the member's own location is known.
const DEFAULT_REGION = { latitude: -28.5523, longitude: 153.4991, latitudeDelta: 0.02, longitudeDelta: 0.02 };

type Field = 'start' | 'end';
type HostOption = { key: string; label: string; authorPubkey: string; groupId: string | null };

interface NewEventModalProps {
    visible: boolean;
    onClose: () => void;
    onSuccess?: () => void;
}

export function NewEventModal({ visible, onClose, onSuccess }: NewEventModalProps) {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const { identity } = useIdentity();

    const [title, setTitle] = useState('');
    const [start, setStart] = useState<Date | null>(null);
    const [end, setEnd] = useState<Date | null>(null);
    const [placeName, setPlaceName] = useState('');
    const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
    const [approximate, setApproximate] = useState(false);
    const mapRef = useRef<MapView | null>(null);
    const centreMap = (latitude: number, longitude: number) => {
        mapRef.current?.animateToRegion({ ...DEFAULT_REGION, latitude, longitude }, 400);
    };
    const [description, setDescription] = useState('');
    const [photo, setPhoto] = useState<string | null>(null);
    const [note, setNote] = useState('');
    const [audienceGroupId, setAudienceGroupId] = useState<string | null>(null);
    const [hostKey, setHostKey] = useState('me');
    const [submitting, setSubmitting] = useState(false);

    // Android shows the OS dialog twice (date, then time); iOS shows one inline datetime spinner.
    const [picker, setPicker] = useState<{ field: Field; mode: 'date' | 'time'; draft: Date } | null>(null);

    const [memberGroups, setMemberGroups] = useState<{ id: string; name: string; convenor: boolean }[]>([]);
    const [enterprises, setEnterprises] = useState<{ publicKey: string; name: string }[]>([]);

    useEffect(() => {
        if (!visible || !identity?.publicKey) return;
        let cancelled = false;
        fetchGroups({ memberPubkey: identity.publicKey })
            .then(groups => {
                if (cancelled) return;
                setMemberGroups(groups
                    .filter(g => (g.viewerStatus ?? 'active') === 'active' && (g.viewerRole === 'convenor' || g.viewerRole === 'member'))
                    .map(g => ({ id: g.id, name: g.name, convenor: g.viewerRole === 'convenor' })));
            })
            .catch(() => {});
        Promise.all([getBalance(identity.publicKey), getTreasuries()])
            .then(([bal, treasuries]) => {
                if (cancelled) return;
                const keeperOf: string[] = Array.isArray((bal as any)?.keeperOf) ? (bal as any).keeperOf : [];
                setEnterprises(keeperOf.map(pk => ({
                    publicKey: pk,
                    name: treasuries.find(t => t.publicKey === pk)?.name || 'Enterprise',
                })));
            })
            .catch(() => {});
        // Centre the pin map on the member only if they have already allowed location; never prompt here.
        Location.getForegroundPermissionsAsync()
            .then(async ({ status }) => {
                if (status !== 'granted') return;
                const last = await Location.getLastKnownPositionAsync();
                if (!cancelled && last) centreMap(last.coords.latitude, last.coords.longitude);
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [visible, identity?.publicKey]);

    const hostOptions: HostOption[] = [
        { key: 'me', label: 'Me', authorPubkey: identity?.publicKey || '', groupId: null },
        ...enterprises.map(e => ({ key: `ent:${e.publicKey}`, label: e.name, authorPubkey: e.publicKey, groupId: null })),
        ...memberGroups.filter(g => g.convenor).map(g => ({ key: `grp:${g.id}`, label: g.name, authorPubkey: identity?.publicKey || '', groupId: g.id })),
    ];
    const host = hostOptions.find(h => h.key === hostKey) || hostOptions[0];
    // A group host posts to that group only.
    const effectiveAudience = host.groupId ?? audienceGroupId;

    const reset = () => {
        setTitle(''); setStart(null); setEnd(null); setPlaceName(''); setPin(null); setApproximate(false);
        setDescription(''); setPhoto(null); setNote(''); setAudienceGroupId(null); setHostKey('me'); setPicker(null);
    };

    const openPicker = (field: Field) => {
        Keyboard.dismiss();
        const base = field === 'start'
            ? (start ?? nextWholeHour())
            : (end ?? (start ? defaultEventEnd(start) : defaultEventEnd(nextWholeHour())));
        setPicker({ field, mode: 'date', draft: base });
    };

    const commit = (field: Field, value: Date) => {
        if (field === 'start') setStart(value); else setEnd(value);
    };

    const onPickerChange = (event: DateTimePickerEvent, selected?: Date) => {
        if (!picker) return;
        if (Platform.OS === 'ios') {
            if (selected) setPicker({ ...picker, draft: selected });
            return;
        }
        if (event.type !== 'set' || !selected) { setPicker(null); return; }
        if (picker.mode === 'date') {
            const d = new Date(picker.draft);
            d.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
            setPicker({ field: picker.field, mode: 'time', draft: d });
        } else {
            const d = new Date(picker.draft);
            d.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
            setPicker(null);
            commit(picker.field, d);
        }
    };

    const placePin = (lat: number, lng: number) => {
        setPin({ lat, lng });
        setApproximate(false);
    };

    const placePinAtMyLocation = async () => {
        try {
            const permission = await Location.getForegroundPermissionsAsync();
            let status = permission.status;
            const canAskAgain = permission.canAskAgain;
            if (status !== 'granted' && canAskAgain) {
                status = (await Location.requestForegroundPermissionsAsync()).status;
            } else if (status !== 'granted') {
                Alert.alert('Location is off', 'Allow location in settings, or tap the map to place the pin.', [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Open Settings', onPress: () => Linking.openSettings() },
                ]);
                return;
            }
            if (status !== 'granted') return;
            const loc = await Location.getCurrentPositionAsync({});
            placePin(loc.coords.latitude, loc.coords.longitude);
            centreMap(loc.coords.latitude, loc.coords.longitude);
        } catch {
            Alert.alert('Location unavailable', 'Tap the map to place the pin instead.');
        }
    };

    const makeApproximate = () => {
        if (!pin) return;
        setPin(approximatePin(pin.lat, pin.lng));
        setApproximate(true);
    };

    const pickPhoto = async () => {
        Keyboard.dismiss();
        try {
            const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, base64: false });
            if (result.canceled || !result.assets[0]?.uri) return;
            const out = await ImageManipulator.manipulateAsync(
                result.assets[0].uri,
                [{ resize: { width: 800 } }],
                { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true }
            );
            if (out.base64) setPhoto(`data:image/jpeg;base64,${out.base64}`);
        } catch (e: any) {
            Alert.alert('Photo not added', e?.message || 'Could not open your photos.');
        }
    };

    const handleCreate = async () => {
        Keyboard.dismiss();
        if (!identity?.publicKey) {
            Alert.alert('Error', 'No member identity found. Please set up your profile.');
            return;
        }
        const built = buildEventDraft({
            title, description, start, end, placeName,
            lat: pin?.lat ?? null, lng: pin?.lng ?? null,
            privateNote: note, audienceGroupId: effectiveAudience, authorPubkey: host.authorPubkey || identity.publicKey,
        });
        if (!built.ok) {
            Alert.alert('Almost there', built.error);
            return;
        }
        setSubmitting(true);
        try {
            await createPost({
                id: Crypto.randomUUID(),
                ...built.draft,
                photos: photo ? JSON.stringify([photo]) : null,
                created_at: new Date().toISOString(),
            });
            reset();
            Alert.alert('Event created', 'Your event is in the Market feed.');
            onSuccess?.();
            onClose();
        } catch (err: any) {
            Alert.alert('Event not created', err?.message || 'The node did not accept the event.');
        } finally {
            setSubmitting(false);
        }
    };

    const dateRow = (field: Field, label: string, value: Date | null, placeholder: string) => (
        <View style={styles.field}>
            <Text style={styles.label}>{label}</Text>
            <View style={styles.dateRow}>
                <Pressable
                    style={[styles.input, styles.dateBtn]}
                    onPress={() => openPicker(field)}
                    accessibilityRole="button"
                    accessibilityLabel={value ? `${label}: ${formatPickerValue(value)}. Change` : `${label}: ${placeholder}`}
                >
                    <Text style={[styles.dateText, !value && { color: colors.text.muted }]} numberOfLines={1}>
                        {value ? formatPickerValue(value) : placeholder}
                    </Text>
                </Pressable>
                {field === 'end' && value && (
                    <Pressable
                        onPress={() => setEnd(null)}
                        style={styles.clearBtn}
                        accessibilityRole="button"
                        accessibilityLabel="Clear end time"
                    >
                        <Text style={styles.clearText}>Clear</Text>
                    </Pressable>
                )}
            </View>
            {picker?.field === field && (
                <View>
                    <DateTimePicker
                        key={`${picker.field}-${picker.mode}`}
                        value={picker.draft}
                        mode={Platform.OS === 'ios' ? 'datetime' : picker.mode}
                        display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                        minimumDate={field === 'end' && start ? start : new Date()}
                        onChange={onPickerChange}
                    />
                    {Platform.OS === 'ios' && (
                        <Pressable
                            style={styles.doneBtn}
                            onPress={() => { commit(picker.field, picker.draft); setPicker(null); }}
                            accessibilityRole="button"
                            accessibilityLabel="Done"
                        >
                            <Text style={styles.doneText}>Done</Text>
                        </Pressable>
                    )}
                </View>
            )}
        </View>
    );

    const chip = (key: string, label: string, selected: boolean, onPress: () => void) => (
        <Pressable
            key={key}
            onPress={onPress}
            style={[styles.chip, selected && styles.chipSelected]}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={label}
        >
            <Text style={[styles.chipText, selected && styles.chipTextSelected]} numberOfLines={1}>{label}</Text>
        </Pressable>
    );

    return (
        <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
            <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
                <View style={styles.container}>
                    <View style={styles.header}>
                        <Pressable onPress={onClose} hitSlop={12} style={styles.headerBtn} accessibilityRole="button" accessibilityLabel="Cancel">
                            <Text style={styles.cancelText} numberOfLines={1}>Cancel</Text>
                        </Pressable>
                        <Text style={styles.headerTitle} numberOfLines={1}>New Event</Text>
                        <Pressable
                            onPress={handleCreate}
                            disabled={submitting}
                            style={[styles.postBtn, submitting && { opacity: 0.5 }]}
                            accessibilityRole="button"
                            accessibilityLabel={submitting ? 'Creating event' : 'Create event'}
                            accessibilityState={{ disabled: submitting, busy: submitting }}
                        >
                            {submitting ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.postText} numberOfLines={1}>Create</Text>}
                        </Pressable>
                    </View>

                    <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
                        <View style={styles.field}>
                            <Text style={styles.label}>TITLE *</Text>
                            <TextInput
                                style={styles.input}
                                placeholder="e.g. Working bee at the hall"
                                placeholderTextColor={colors.text.muted}
                                value={title}
                                onChangeText={setTitle}
                                maxLength={EVENT_TITLE_MAX}
                                accessibilityLabel="Event title"
                            />
                        </View>

                        {dateRow('start', 'STARTS *', start, 'Pick a date and time')}
                        {dateRow('end', 'ENDS (OPTIONAL)', end, start ? `2 hours after start (${formatPickerValue(defaultEventEnd(start)).split(', ')[1]})` : '2 hours after start if blank')}

                        <View style={styles.field}>
                            <Text style={styles.label}>PLACE NAME *</Text>
                            <TextInput
                                style={styles.input}
                                placeholder="e.g. The old bowls club"
                                placeholderTextColor={colors.text.muted}
                                value={placeName}
                                onChangeText={setPlaceName}
                                maxLength={EVENT_PLACE_NAME_MAX}
                                accessibilityLabel="Place name"
                            />
                        </View>

                        <View style={styles.field}>
                            <Text style={styles.label}>PIN ON THE MAP *</Text>
                            <View style={styles.mapBox}>
                                {HAS_MAPS_KEY ? (
                                    <MapView
                                        style={StyleSheet.absoluteFill}
                                        provider={PROVIDER_DEFAULT}
                                        ref={mapRef}
                                        initialRegion={DEFAULT_REGION}
                                        onPress={(e) => placePin(e.nativeEvent.coordinate.latitude, e.nativeEvent.coordinate.longitude)}
                                        toolbarEnabled={false}
                                    >
                                        {pin && (
                                            <Marker
                                                coordinate={{ latitude: pin.lat, longitude: pin.lng }}
                                                pinColor={EVENT_ACCENT}
                                                draggable
                                                onDragEnd={(e) => placePin(e.nativeEvent.coordinate.latitude, e.nativeEvent.coordinate.longitude)}
                                            />
                                        )}
                                    </MapView>
                                ) : (
                                    <View style={[StyleSheet.absoluteFill, styles.mapFallback]}>
                                        <Text style={styles.helper}>The map is not available in this build. Use your location.</Text>
                                    </View>
                                )}
                            </View>
                            <Text style={styles.helper} numberOfLines={2}>
                                {pin ? `${approximate ? 'Approximate pin' : 'Exact pin'} · ${pin.lat.toFixed(approximate ? 3 : 5)}, ${pin.lng.toFixed(approximate ? 3 : 5)}` : 'Tap the map to place the pin.'}
                            </Text>
                            <View style={styles.pinActions}>
                                <Pressable onPress={placePinAtMyLocation} style={styles.secondaryBtn} accessibilityRole="button" accessibilityLabel="Use my location for the pin">
                                    <Text style={styles.secondaryText} numberOfLines={1}>📍 Use my location</Text>
                                </Pressable>
                            </View>
                            <View style={styles.warningBox}>
                                <Text style={styles.warningTitle}>{EVENT_PIN_WARNING}</Text>
                                <Text style={styles.warningBody}>{EVENT_PIN_HINT}</Text>
                                <Pressable
                                    onPress={makeApproximate}
                                    disabled={!pin || approximate}
                                    style={[styles.secondaryBtn, styles.approxBtn, (!pin || approximate) && { opacity: 0.45 }]}
                                    accessibilityRole="button"
                                    accessibilityLabel="Approximate the pin to about 100 metres"
                                    accessibilityState={{ disabled: !pin || approximate, selected: approximate }}
                                >
                                    <Text style={styles.secondaryText} numberOfLines={1}>{approximate ? 'Approximate ✓' : 'Approximate (~100 m)'}</Text>
                                </Pressable>
                            </View>
                        </View>

                        <View style={styles.field}>
                            <Text style={styles.label}>DESCRIPTION</Text>
                            <TextInput
                                style={[styles.input, styles.textArea]}
                                placeholder="What is happening, and who is it for?"
                                placeholderTextColor={colors.text.muted}
                                value={description}
                                onChangeText={setDescription}
                                multiline
                                accessibilityLabel="Description"
                            />
                        </View>

                        <View style={styles.field}>
                            <Text style={styles.label}>PHOTO (OPTIONAL)</Text>
                            <View style={styles.photoRow}>
                                {photo ? (
                                    <Image source={{ uri: photo }} style={styles.photo} contentFit="cover" accessibilityLabel="Event photo" />
                                ) : null}
                                <Pressable onPress={photo ? () => setPhoto(null) : pickPhoto} style={styles.secondaryBtn} accessibilityRole="button" accessibilityLabel={photo ? 'Remove photo' : 'Add a photo'}>
                                    <Text style={styles.secondaryText} numberOfLines={1}>{photo ? 'Remove photo' : '📷 Add a photo'}</Text>
                                </Pressable>
                            </View>
                        </View>

                        <View style={styles.field}>
                            <Text style={styles.label}>NOTE FOR PEOPLE WHO ARE GOING</Text>
                            <TextInput
                                style={[styles.input, styles.textArea]}
                                placeholder="Gate code, parking, what to bring"
                                placeholderTextColor={colors.text.muted}
                                value={note}
                                onChangeText={setNote}
                                multiline
                                maxLength={EVENT_PRIVATE_NOTE_MAX}
                                accessibilityLabel="Note for people who are going"
                            />
                            <Text style={styles.helper}>Only people who tap Going see this.</Text>
                        </View>

                        {hostOptions.length > 1 && (
                            <View style={styles.field}>
                                <Text style={styles.label}>POST AS</Text>
                                <View style={styles.chipWrap}>
                                    {hostOptions.map(h => chip(h.key, h.label, h.key === host.key, () => setHostKey(h.key)))}
                                </View>
                            </View>
                        )}

                        <View style={styles.field}>
                            <Text style={styles.label}>WHO CAN SEE IT</Text>
                            {host.groupId ? (
                                <Text style={styles.helper}>🔒 Only {host.label} members, because the group is hosting.</Text>
                            ) : (
                                <View style={styles.chipWrap}>
                                    {chip('public', 'This community', audienceGroupId === null, () => setAudienceGroupId(null))}
                                    {memberGroups.map(g => chip(g.id, `🔒 ${g.name}`, audienceGroupId === g.id, () => setAudienceGroupId(g.id)))}
                                </View>
                            )}
                        </View>
                    </ScrollView>
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
}

function nextWholeHour(): Date {
    const d = new Date();
    d.setHours(d.getHours() + 1, 0, 0, 0);
    return d;
}

const makeStyles = ({ colors, theme }: ThemeContextType) =>
    StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.app },
        header: {
            flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
            paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1,
            borderBottomColor: theme === 'dark' ? '#374151' : '#e5e7eb', gap: 8,
        },
        headerBtn: { minHeight: 48, minWidth: 48, justifyContent: 'center', paddingHorizontal: 6, flexShrink: 0 },
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '800', color: colors.text.body },
        cancelText: { fontSize: 15, color: colors.text.secondary },
        postBtn: {
            backgroundColor: EVENT_ACCENT, paddingHorizontal: 16, minHeight: 40, borderRadius: 20,
            justifyContent: 'center', alignItems: 'center', flexShrink: 0,
        },
        postText: { fontSize: 14, fontWeight: '800', color: '#fff' },
        body: { flex: 1, paddingHorizontal: 16, paddingTop: 14 },
        field: { marginBottom: 16 },
        label: { fontSize: 11, fontWeight: '800', color: colors.text.secondary, letterSpacing: 0.5, marginBottom: 6 },
        input: {
            backgroundColor: colors.surface.card, borderWidth: 1,
            borderColor: theme === 'dark' ? '#4b5563' : '#d1d5db', borderRadius: 12,
            paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, color: colors.text.body, minHeight: 48,
        },
        textArea: { minHeight: 80, textAlignVertical: 'top' },
        dateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
        dateBtn: { flex: 1, justifyContent: 'center' },
        dateText: { fontSize: 15, color: colors.text.heading },
        clearBtn: { minHeight: 48, minWidth: 48, justifyContent: 'center', alignItems: 'center', flexShrink: 0 },
        clearText: { fontSize: 13, fontWeight: '700', color: colors.feedback.danger.solid },
        doneBtn: { alignSelf: 'flex-end', minHeight: 44, paddingHorizontal: 16, justifyContent: 'center' },
        doneText: { fontSize: 15, fontWeight: '800', color: EVENT_ACCENT },
        mapBox: {
            height: 180, borderRadius: 12, overflow: 'hidden', borderWidth: 1,
            borderColor: theme === 'dark' ? '#4b5563' : '#d1d5db', backgroundColor: colors.surface.subtle,
        },
        mapFallback: { justifyContent: 'center', alignItems: 'center', padding: 16 },
        helper: { fontSize: 12, color: colors.text.secondary, marginTop: 6, lineHeight: 16 },
        pinActions: { flexDirection: 'row', marginTop: 8 },
        secondaryBtn: {
            minHeight: 48, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1,
            borderColor: theme === 'dark' ? '#4b5563' : '#d1d5db', backgroundColor: colors.surface.card,
            justifyContent: 'center', alignItems: 'center', flexShrink: 1,
        },
        secondaryText: { fontSize: 14, fontWeight: '700', color: colors.text.body },
        warningBox: {
            marginTop: 10, padding: 12, borderRadius: 12, borderWidth: 1,
            backgroundColor: colors.feedback.warning.bg, borderColor: colors.feedback.warning.border,
        },
        warningTitle: { fontSize: 13, fontWeight: '800', color: colors.feedback.warning.fg },
        warningBody: { fontSize: 12, color: colors.text.body, marginTop: 4, lineHeight: 17 },
        approxBtn: { alignSelf: 'flex-start', marginTop: 10 },
        photoRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
        photo: { width: 64, height: 64, borderRadius: 10, backgroundColor: colors.surface.subtle },
        chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
        chip: {
            minHeight: 44, maxWidth: '100%', paddingHorizontal: 14, borderRadius: 22, borderWidth: 1,
            borderColor: theme === 'dark' ? '#4b5563' : '#d1d5db', backgroundColor: colors.surface.card,
            justifyContent: 'center',
        },
        chipSelected: { borderColor: EVENT_ACCENT, backgroundColor: theme === 'dark' ? 'rgba(124, 58, 237, 0.2)' : '#f5f3ff' },
        chipText: { fontSize: 14, fontWeight: '600', color: colors.text.secondary },
        chipTextSelected: { fontWeight: '800', color: EVENT_ACCENT },
    });
