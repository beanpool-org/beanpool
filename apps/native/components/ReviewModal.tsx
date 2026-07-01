import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, Modal, ActivityIndicator, Alert, StyleSheet, ScrollView, Platform, Keyboard } from 'react-native';
import { KeyboardAvoidingView } from 'react-native';
import { submitRating, getDb } from '../utils/db';
import { useIdentity } from '../app/IdentityContext';
import { colors, palette } from '../constants/colors';

interface ReviewModalProps {
    visible: boolean;
    txId: string;
    targetPubkey: string;
    targetCallsign: string;
    onClose: () => void;
    onSuccess: () => void;
}

export function ReviewModal({ visible, txId, targetPubkey, targetCallsign, onClose, onSuccess }: ReviewModalProps) {
    const { identity } = useIdentity();
    const [stars, setStars] = useState(5);
    const [comment, setComment] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [isExisting, setIsExisting] = useState(false);
    const [keyboardShown, setKeyboardShown] = useState(false);

    React.useEffect(() => {
        const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
        const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

        const showSubscription = Keyboard.addListener(showEvent, () => {
            setKeyboardShown(true);
        });
        const hideSubscription = Keyboard.addListener(hideEvent, () => {
            setKeyboardShown(false);
        });

        return () => {
            showSubscription.remove();
            hideSubscription.remove();
        };
    }, []);

    React.useEffect(() => {
        if (visible && txId && identity?.publicKey) {
            (async () => {
                try {
                    const db = await getDb();
                    const existing = await db.getFirstAsync<any>(
                        "SELECT stars, comment FROM ratings WHERE transaction_id=? AND rater_pubkey=?",
                        [txId, identity.publicKey]
                    );
                    if (existing) {
                        setStars(existing.stars);
                        setComment(existing.comment || '');
                        setIsExisting(true);
                    } else {
                        setStars(5);
                        setComment('');
                        setIsExisting(false);
                    }
                } catch (e) {
                    console.error("[ReviewModal] Failed to load existing rating:", e);
                }
            })();
        }
    }, [visible, txId, identity?.publicKey]);

    const handleSubmit = async () => {
        if (!identity) return;
        setSubmitting(true);
        try {
            await submitRating(identity.publicKey, targetPubkey, stars, comment, txId);
            onSuccess();
        } catch (e: any) {
            Alert.alert('Error', e.message || 'Failed to submit review');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal visible={visible} transparent animationType="slide">
            <KeyboardAvoidingView
                style={styles.overlay}
                behavior="padding"
            >
                <ScrollView
                    contentContainerStyle={[
                        styles.scrollContent,
                        keyboardShown && { justifyContent: 'flex-start', paddingTop: Platform.OS === 'ios' ? 80 : 50 }
                    ]}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                >
                    <View style={styles.card}>
                        <Text style={styles.emoji}>🎉</Text>
                        <Text style={styles.title}>{isExisting ? 'Edit Your Review' : 'Deal Complete!'}</Text>
                        <Text style={styles.subtitle}>
                            How was your experience with <Text style={styles.bold}>{targetCallsign}</Text>?
                        </Text>

                        <View style={styles.starsRow}>
                            {[1, 2, 3, 4, 5].map(s => (
                                <Pressable key={s} accessibilityRole="button" accessibilityLabel={`Rate ${s} stars`} accessibilityState={{ selected: s <= stars }} onPress={() => setStars(s)}>
                                    <Text style={[styles.star, s <= stars ? styles.starActive : styles.starInactive]}>★</Text>
                                </Pressable>
                            ))}
                        </View>

                        <TextInput
                            style={styles.input}
                            accessibilityLabel="Review comment"
                            placeholder="Write a short review (optional)..."
                            placeholderTextColor={colors.text.muted}
                            multiline
                            numberOfLines={3}
                            value={comment}
                            onChangeText={setComment}
                        />

                        <View style={styles.buttonRow}>
                            <Pressable style={styles.skipBtn} accessibilityRole="button" onPress={onClose} disabled={submitting}>
                                <Text style={styles.skipText}>Skip for now</Text>
                            </Pressable>
                            <Pressable style={[styles.submitBtn, submitting && styles.btnDisabled]} accessibilityRole="button" onPress={handleSubmit} disabled={submitting}>
                                {submitting ? (
                                    <ActivityIndicator size="small" color={colors.text.inverse} />
                                ) : (
                                    <Text style={styles.submitText}>{isExisting ? 'Update Rating' : 'Submit Rating'}</Text>
                                )}
                            </Pressable>
                        </View>
                    </View>
                </ScrollView>
            </KeyboardAvoidingView>
        </Modal>
    );
}

const styles = StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
    scrollContent: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
    card: { backgroundColor: colors.surface.card, borderRadius: 24, padding: 24, width: '100%', alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 10 },
    emoji: { fontSize: 40, marginBottom: 16 },
    title: { fontSize: 20, fontWeight: '900', color: colors.text.body, marginBottom: 8 },
    subtitle: { fontSize: 14, color: palette.gray600, textAlign: 'center', marginBottom: 24 },
    bold: { fontWeight: '800', color: colors.text.heading },
    starsRow: { flexDirection: 'row', gap: 8, marginBottom: 24 },
    star: { fontSize: 40 },
    starActive: { color: palette.amber400 },
    starInactive: { color: colors.border.default },
    input: { width: '100%', backgroundColor: colors.surface.app, borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, padding: 16, fontSize: 14, minHeight: 80, marginBottom: 24, color: colors.text.body },
    buttonRow: { flexDirection: 'row', gap: 12, width: '100%' },
    skipBtn: { flex: 1, backgroundColor: colors.surface.subtle, paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
    skipText: { fontWeight: '700', color: palette.gray600, fontSize: 14 },
    submitBtn: { flex: 1.5, backgroundColor: palette.amber500, paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
    submitText: { fontWeight: '700', color: colors.text.inverse, fontSize: 14 },
    btnDisabled: { opacity: 0.7 },
});
