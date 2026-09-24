/**
 * NewEventModal — create an event from the Market's "Create New Post" sheet (docs/events-on-the-map.md §3
 * "Create form", slice 3). Opened the way NewPollModal is, so the protected map screen is not involved.
 *
 * One column, in the design's order: title; Starts / Ends (optional, 2 hours after start if blank); place
 * name; an address search (the settings app's, shared through @beanpool/core) and the pin with Approximate and
 * the public-pin warning; description; photo; the note for people who are
 * going; audience (this community or a group); and "Post as", shown only to a keeper or convenor.
 *
 * Reach is always local in v1 (§2.4), so there is no linked-communities option. Keyboard avoidance comes from
 * react-native-keyboard-controller's root provider; this Modal must not add its own.
 *
 * With `editOf` it is the host's Edit Event screen (events round 2, decision 29): every field filled from the
 * event, dates and photo included; Save sends only what changed. Audience and host are fixed once posted.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
    View, Text, StyleSheet, Modal, TextInput, Pressable, ScrollView, Alert, ActivityIndicator, Platform,
    Linking, Keyboard,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Crypto from 'expo-crypto';
import { Image } from 'expo-image';
import { useTheme, useStyles, type ThemeContextType } from '../app/ThemeContext';
import { useIdentity } from '../app/IdentityContext';
import { createPost, fetchGroups, getBalance, getTreasuries, updateEvent } from '../utils/db';
import { HAS_MAPS_KEY } from '../utils/maps';
import { pageSheetTopInset } from '../utils/modal-safe-area';
import {
    buildEventDraft, buildEventEditPatch, approximatePin, defaultEventEnd, formatPickerValue,
    EVENT_PIN_WARNING, EVENT_PIN_HINT, EVENT_PLACE_NAME_MAX, EVENT_PRIVATE_NOTE_MAX, EVENT_TITLE_MAX,
    type EventCopy, type EventEditValues,
} from '../utils/events';
import { effectiveEventAudience } from '../utils/event-extras';
import { EVENT_ACCENT } from './EventCard';
import { AddressSearch } from './AddressSearch';
import { placeNameAfterPick } from '../utils/address-search';
import type { AddressResult } from '@beanpool/core';

// Mullumbimby, as the radius picker uses, until the member's own location is known.
const DEFAULT_REGION = { latitude: -28.5523, longitude: 153.4991, latitudeDelta: 0.02, longitudeDelta: 0.02 };

type Field = 'start' | 'end';

const HEADER_PAD_TOP = 10;
type HostOption = { key: string; label: string; authorPubkey: string; groupId: string | null };

interface NewEventModalProps {
    visible: boolean;
    onClose: () => void;
    onSuccess?: () => void;
    /**
     * "Copy to a new date" (§3, slice 5): open the form filled from an event that already ran, with Starts and
     * Ends blank. This is the whole of repeats in v1 — no rules, no materialiser (§5).
     */
    prefill?: EventCopy | null;
    /**
     * A pin the member had already dropped on the map before opening this form, carried in as the event's
     * place. Not the same thing as `prefill`, which titles the sheet "Copy Event" — this is a plain new
     * event that starts with its location known.
     */
    initialPin?: { lat: number; lng: number } | null;
    /**
     * Edit an existing event: its id, the form as it stands on the node, and who can see it (for one read-only
     * line). The same object must be passed for the whole opening — it is applied once, like `prefill`.
     */
    editOf?: { id: string; values: EventEditValues; audienceLabel: string } | null;
    /** After a save, with the event as the node now has it. */
    onSaved?: (post: any) => void;
}

export function NewEventModal({ visible, onClose, onSuccess, prefill, initialPin, editOf, onSaved }: NewEventModalProps) {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const { identity } = useIdentity();
    // Android draws this pageSheet full-screen under the status bar; see utils/modal-safe-area.
    const topInset = pageSheetTopInset(Platform.OS, useSafeAreaInsets().top);

    const [title, setTitle] = useState('');
    const [start, setStart] = useState<Date | null>(null);
    const [end, setEnd] = useState<Date | null>(null);
    const [placeName, setPlaceName] = useState('');
    const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
    const [approximate, setApproximate] = useState(false);
    const mapRef = useRef<MapView | null>(null);
    const scrollRef = useRef<ScrollView | null>(null);
    // Where the address box sits in the scroll content, for bringing it (and the map under it) into view.
    const addressY = useRef(0);
    const centreMap = (latitude: number, longitude: number) => {
        mapRef.current?.animateToRegion({ ...DEFAULT_REGION, latitude, longitude }, 400);
    };
    const [description, setDescription] = useState('');
    const [photo, setPhoto] = useState<string | null>(null);
    const [note, setNote] = useState('');
    const [audienceGroupId, setAudienceGroupId] = useState<string | null>(null);
    const [hostKey, setHostKey] = useState('me');
    // The host a copy names, held separately so the copy is posted by the same enterprise or group even if the
    // member submits before fetchGroups/getTreasuries have answered and filled the real "Post as" list.
    const [copiedHost, setCopiedHost] = useState<HostOption | null>(null);
    const [isCopy, setIsCopy] = useState(false);
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
                // ⚡ Bolt: O(1) Map lookup for enterprise treasuries by publicKey instead of O(T) .find() scans
                const treasuriesMap = new Map((treasuries || []).map(t => [t.publicKey, t.name]));
                setEnterprises(keeperOf.map(pk => ({
                    publicKey: pk,
                    name: treasuriesMap.get(pk) || 'Enterprise',
                })));
            })
            .catch(() => {});
        // Centre the pin map on the member only if they have already allowed location; never prompt here.
        // A carried-in pin wins: it is a place the member has just chosen, and recentring on their own
        // position would quietly drag the map off it.
        if (!initialPin) {
            Location.getForegroundPermissionsAsync()
                .then(async ({ status }) => {
                    if (status !== 'granted') return;
                    const last = await Location.getLastKnownPositionAsync();
                    if (!cancelled && last) centreMap(last.coords.latitude, last.coords.longitude);
                })
                .catch(() => {});
        }
        return () => { cancelled = true; };
    }, [visible, identity?.publicKey]);

    const hostOptions: HostOption[] = [
        { key: 'me', label: 'Me', authorPubkey: identity?.publicKey || '', groupId: null },
        ...enterprises.map(e => ({ key: `ent:${e.publicKey}`, label: e.name, authorPubkey: e.publicKey, groupId: null })),
        ...memberGroups.filter(g => g.convenor).map(g => ({ key: `grp:${g.id}`, label: g.name, authorPubkey: identity?.publicKey || '', groupId: g.id })),
    ];
    const host = hostOptions.find(h => h.key === hostKey) || copiedHost || hostOptions[0];
    // An enterprise hosts for the whole community: the node refuses an enterprise event aimed at a group,
    // and it used to do so with a message about signatures (#1054). So the pair cannot be chosen here, and
    // cannot be sent either — the audience is cleared when the host is picked, and again on the way out.
    const enterpriseHosts = host.key.startsWith('ent:');
    const effectiveAudience = effectiveEventAudience(host, audienceGroupId);

    const reset = () => {
        setTitle(''); setStart(null); setEnd(null); setPlaceName(''); setPin(null); setApproximate(false);
        setDescription(''); setPhoto(null); setNote(''); setAudienceGroupId(null); setHostKey('me'); setPicker(null);
        setCopiedHost(null); setIsCopy(false);
    };

    // Fill the form from the copied event, once per opening: a host who then edits a field must not have it
    // written over by a re-render. Everything carries over EXCEPT the two dates — picking the new date is the
    // one thing this screen is open for — and the photo, which the node serves as a URL that create cannot take.
    const appliedPrefill = useRef<EventCopy | null>(null);
    useEffect(() => {
        if (!visible) { appliedPrefill.current = null; return; }
        if (!prefill || appliedPrefill.current === prefill) return;
        appliedPrefill.current = prefill;
        setIsCopy(true);
        setTitle(prefill.title);
        setDescription(prefill.description);
        setPlaceName(prefill.placeName);
        setNote(prefill.privateNote);
        setStart(null); setEnd(null); setPicker(null); setPhoto(null);
        setApproximate(false);
        setAudienceGroupId(prefill.groupId);
        const copied: HostOption | null = prefill.enterprisePubkey
            ? { key: `ent:${prefill.enterprisePubkey}`, label: 'Enterprise', authorPubkey: prefill.enterprisePubkey, groupId: null }
            : prefill.groupId
                ? { key: `grp:${prefill.groupId}`, label: 'Group', authorPubkey: identity?.publicKey || '', groupId: prefill.groupId }
                : null;
        setCopiedHost(copied);
        setHostKey(copied?.key ?? 'me');
        if (prefill.lat != null && prefill.lng != null) {
            setPin({ lat: prefill.lat, lng: prefill.lng });
            centreMap(prefill.lat, prefill.lng);
        } else {
            setPin(null);
        }
    }, [visible, prefill, identity?.publicKey]);

    // Edit: fill every field from the event, once per opening, so typing is never written over by a re-render.
    const appliedEdit = useRef<NewEventModalProps['editOf']>(null);
    useEffect(() => {
        if (!visible) { appliedEdit.current = null; return; }
        if (!editOf || appliedEdit.current === editOf) return;
        appliedEdit.current = editOf;
        const v = editOf.values;
        setIsCopy(false);
        setTitle(v.title);
        setDescription(v.description);
        setStart(v.start);
        setEnd(v.end);
        setPlaceName(v.placeName);
        setNote(v.privateNote);
        setPhoto(v.photo);
        setPicker(null);
        setApproximate(false);
        if (v.lat != null && v.lng != null) {
            setPin({ lat: v.lat, lng: v.lng });
            centreMap(v.lat, v.lng);
        } else {
            setPin(null);
        }
    }, [visible, editOf]);

    // A pin the member dropped on the map before tapping + carries in as the place, once per opening so a
    // later move of the pin is not written over by a re-render. A copy brings its own pin, so it wins.
    const appliedInitialPin = useRef(false);
    useEffect(() => {
        if (!visible) { appliedInitialPin.current = false; return; }
        if (prefill || editOf || appliedInitialPin.current || !initialPin) return;
        appliedInitialPin.current = true;
        setPin({ lat: initialPin.lat, lng: initialPin.lng });
        centreMap(initialPin.lat, initialPin.lng);
    }, [visible, prefill, initialPin]);

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

    // An address picked from the search is placed exactly as a tap on the map would be, so Approximate still
    // applies the same way; an empty Place name takes the result's short name. Then the map scrolls into view.
    const pickAddress = (result: AddressResult) => {
        placePin(result.lat, result.lng);
        centreMap(result.lat, result.lng);
        setPlaceName(prev => placeNameAfterPick(prev, result, EVENT_PLACE_NAME_MAX));
        // Scroll to the address box, not the map: the map's offset is stale while the match list collapses, and
        // the box's is not. With the list gone the map sits right under it, in view even at 320dp and 1.3x.
        setTimeout(() => scrollRef.current?.scrollTo({ y: Math.max(0, addressY.current - 8), animated: true }), 50);
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

    const editValues = (): EventEditValues => ({
        title, description, start, end, placeName, lat: pin?.lat ?? null, lng: pin?.lng ?? null, privateNote: note, photo,
    });
    const editCheck = editOf ? buildEventEditPatch(editOf.values, editValues()) : null;

    const handleSave = async () => {
        Keyboard.dismiss();
        if (!editOf || !editCheck) return;
        if (!editCheck.ok) {
            Alert.alert('Almost there', editCheck.error);
            return;
        }
        if (Object.keys(editCheck.patch).length === 0) {
            onClose();
            return;
        }
        setSubmitting(true);
        try {
            const saved = await updateEvent(editOf.id, editCheck.patch);
            reset();
            Alert.alert('Event saved', editCheck.notifies
                ? 'It now shows UPDATED, and everyone going has been told.'
                : 'Your changes are saved.');
            onSaved?.(saved);
            onClose();
        } catch (err: any) {
            Alert.alert('Event not saved', err?.message || 'The node did not accept the change.');
        } finally {
            setSubmitting(false);
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
                    <View style={[styles.header, { paddingTop: HEADER_PAD_TOP + topInset }]}>
                        <Pressable onPress={onClose} hitSlop={12} style={styles.headerBtn} accessibilityRole="button" accessibilityLabel="Cancel">
                            <Text style={styles.cancelText} numberOfLines={1}>Cancel</Text>
                        </Pressable>
                        <Text style={styles.headerTitle} numberOfLines={1}>{editOf ? 'Edit Event' : isCopy ? 'Copy Event' : 'New Event'}</Text>
                        <Pressable
                            onPress={editOf ? handleSave : handleCreate}
                            disabled={submitting}
                            style={[styles.postBtn, submitting && { opacity: 0.5 }]}
                            accessibilityRole="button"
                            accessibilityLabel={editOf ? (submitting ? 'Saving event' : 'Save changes') : (submitting ? 'Creating event' : 'Create event')}
                            accessibilityState={{ disabled: submitting, busy: submitting }}
                        >
                            {submitting ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.postText} numberOfLines={1}>{editOf ? 'Save' : 'Create'}</Text>}
                        </Pressable>
                    </View>

                    <ScrollView ref={scrollRef} style={styles.body} contentContainerStyle={{ paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
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

                        {isCopy && (
                            <Text style={styles.copyNote}>
                                Copied from your last one. Pick the new date and time. The photo is not copied — add one again if you want.
                            </Text>
                        )}
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

                        <View style={styles.field} onLayout={(e) => { addressY.current = e.nativeEvent.layout.y; }}>
                            <Text style={styles.label}>FIND AN ADDRESS</Text>
                            <AddressSearch
                                accent={EVENT_ACCENT}
                                onPick={pickAddress}
                                onResultsShown={() => scrollRef.current?.scrollTo({ y: Math.max(0, addressY.current - 8), animated: true })}
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
                                        onMapReady={() => { if (pin) centreMap(pin.lat, pin.lng); }}
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

                        {editOf && editCheck?.ok && editCheck.notifies && (
                            <View style={styles.warningBox} accessibilityLiveRegion="polite">
                                <Text style={styles.warningTitle}>You changed the time or place.</Text>
                                <Text style={styles.warningBody}>The event will show UPDATED and everyone going will be told.</Text>
                            </View>
                        )}

                        {editOf ? (
                            <View style={styles.field}>
                                <Text style={styles.label}>WHO CAN SEE IT</Text>
                                <Text style={styles.helper}>{editOf.audienceLabel} Who can see it and who hosts it stay as they are.</Text>
                            </View>
                        ) : (<>
                        {hostOptions.length > 1 && (
                            <View style={styles.field}>
                                <Text style={styles.label}>POST AS</Text>
                                <View style={styles.chipWrap}>
                                    {hostOptions.map(h => chip(h.key, h.label, h.key === host.key, () => {
                                        setHostKey(h.key);
                                        if (h.key.startsWith('ent:')) setAudienceGroupId(null);
                                    }))}
                                </View>
                            </View>
                        )}

                        <View style={styles.field}>
                            <Text style={styles.label}>WHO CAN SEE IT</Text>
                            {host.groupId ? (
                                <Text style={styles.helper}>🔒 Only {host.label} members, because the group is hosting.</Text>
                            ) : enterpriseHosts ? (
                                <Text style={styles.helper}>{host.label} hosts for the whole community, so this event is not group-only.</Text>
                            ) : (
                                <View style={styles.chipWrap}>
                                    {chip('public', 'This community', audienceGroupId === null, () => setAudienceGroupId(null))}
                                    {memberGroups.map(g => chip(g.id, `🔒 ${g.name}`, audienceGroupId === g.id, () => setAudienceGroupId(g.id)))}
                                </View>
                            )}
                        </View>
                        </>)}
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
        container: { flex: 1, backgroundColor: colors.surface.page },
        header: {
            flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
            paddingHorizontal: 12, paddingTop: HEADER_PAD_TOP, paddingBottom: 10, borderBottomWidth: 1,
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
        copyNote: {
            fontSize: 13, color: colors.text.secondary, lineHeight: 18, marginBottom: 12,
            padding: 10, borderRadius: 10, backgroundColor: colors.surface.subtle,
        },
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
