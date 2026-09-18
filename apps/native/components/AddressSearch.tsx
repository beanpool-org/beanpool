/**
 * Address search for the event form's pin (the settings app's node location search, reused). The lookup — the
 * Nominatim request, 1 s debounce, abort, 1 req/s floor and cache — is @beanpool/core's createAddressLookup;
 * this is only the phone's text box and list.
 *
 * What the member types, and the phone's IP, go straight to OpenStreetMap, as the settings app's search already
 * does. Tapping the map and "Use my location" never depend on it: a failed search says so in one line.
 *
 * Small screens: the list is at most five rows in a box of its own height limit, so at 320dp and 1.3x text it
 * never pushes the whole map away; the parent scrolls the box to the top when matches arrive so the keyboard
 * cannot sit over them.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, ActivityIndicator, StyleSheet, Keyboard, Platform } from 'react-native';
import Constants from 'expo-constants';
import { createAddressLookup, type AddressLookup, type AddressLookupState, type AddressResult } from '@beanpool/core';
import { useTheme, useStyles, type ThemeContextType } from '../app/ThemeContext';
import { nominatimHeaders } from '../utils/address-search';

interface AddressSearchProps {
    onPick: (result: AddressResult) => void;
    /** Matches (or a message) just appeared: the parent scrolls this box to the top, clear of the keyboard. */
    onResultsShown?: () => void;
    accent: string;
}

export function AddressSearch({ onPick, onResultsShown, accent }: AddressSearchProps) {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const [query, setQuery] = useState('');
    const [state, setState] = useState<AddressLookupState>({ status: 'idle', query: '', results: [] });
    const [open, setOpen] = useState(false);
    const lookupRef = useRef<AddressLookup | null>(null);
    const shownRef = useRef(onResultsShown);
    shownRef.current = onResultsShown;

    useEffect(() => {
        const lookup = createAddressLookup({
            headers: nominatimHeaders(Constants.expoConfig?.version, Platform.OS),
            onState: (s) => {
                setState(s);
                if (s.status === 'done' || s.status === 'error') {
                    setOpen(true);
                    shownRef.current?.();
                }
            },
        });
        lookupRef.current = lookup;
        return () => { lookup.dispose(); lookupRef.current = null; };
    }, []);

    const results = state.status === 'done' ? state.results : [];

    const pick = (item: AddressResult) => {
        Keyboard.dismiss();
        lookupRef.current?.cancel();
        setQuery(item.displayName);
        setOpen(false);
        onPick(item);
    };

    return (
        <View>
            <View style={styles.inputRow}>
                <TextInput
                    style={styles.input}
                    placeholder="Street and town, or a place"
                    placeholderTextColor={colors.text.muted}
                    value={query}
                    onChangeText={(text) => {
                        setQuery(text);
                        setOpen(true);
                        lookupRef.current?.input(text);
                    }}
                    onSubmitEditing={() => lookupRef.current?.submit(query)}
                    returnKeyType="search"
                    autoCorrect={false}
                    autoComplete="off"
                    accessibilityLabel="Find an address"
                />
                {state.status === 'searching' && (
                    <ActivityIndicator style={styles.spinner} size="small" color={accent} accessibilityLabel="Searching" />
                )}
            </View>
            {open && state.status === 'error' && (
                <Text style={styles.error} accessibilityLiveRegion="polite">
                    Address search isn't working right now. Tap the map or use your location.
                </Text>
            )}
            {open && state.status === 'done' && results.length === 0 && (
                <Text style={styles.helper} accessibilityLiveRegion="polite">No matches. Try a street and town, or tap the map.</Text>
            )}
            {open && results.length > 0 && (
                <ScrollView style={styles.list} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                    {results.map((item, idx) => (
                        <Pressable
                            key={`${item.lat},${item.lng},${idx}`}
                            onPress={() => pick(item)}
                            style={({ pressed }) => [styles.row, idx > 0 && styles.rowDivider, pressed && styles.rowPressed]}
                            accessibilityRole="button"
                            accessibilityLabel={`Put the pin at ${item.displayName}`}
                        >
                            <Text style={styles.rowTitle} numberOfLines={1}>{item.shortName || item.displayName}</Text>
                            <Text style={styles.rowSub} numberOfLines={1}>{item.displayName}</Text>
                        </Pressable>
                    ))}
                </ScrollView>
            )}
            <Text style={styles.helper}>Addresses from OpenStreetMap. What you type here is sent to them.</Text>
        </View>
    );
}

const makeStyles = ({ colors, theme }: ThemeContextType) =>
    StyleSheet.create({
        inputRow: { flexDirection: 'row', alignItems: 'center' },
        input: {
            flex: 1, backgroundColor: colors.surface.card, borderWidth: 1,
            borderColor: theme === 'dark' ? '#4b5563' : '#d1d5db', borderRadius: 12,
            paddingHorizontal: 14, paddingRight: 40, paddingVertical: 10, fontSize: 15, color: colors.text.body, minHeight: 48,
        },
        spinner: { position: 'absolute', right: 12 },
        // Room for about three rows at 1.3x text; the other two scroll inside, so the map stays near.
        list: {
            maxHeight: 200, marginTop: 6, borderRadius: 12, borderWidth: 1,
            borderColor: theme === 'dark' ? '#4b5563' : '#d1d5db', backgroundColor: colors.surface.card,
        },
        row: { minHeight: 48, paddingHorizontal: 12, paddingVertical: 8, justifyContent: 'center' },
        rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme === 'dark' ? '#4b5563' : '#d1d5db' },
        rowPressed: { backgroundColor: colors.surface.subtle },
        rowTitle: { fontSize: 14, fontWeight: '700', color: colors.text.body },
        rowSub: { fontSize: 12, color: colors.text.secondary, marginTop: 2 },
        helper: { fontSize: 12, color: colors.text.secondary, marginTop: 6, lineHeight: 16 },
        error: { fontSize: 12, fontWeight: '700', color: colors.feedback.danger.solid, marginTop: 6, lineHeight: 16 },
    });
