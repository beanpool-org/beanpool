/**
 * The ⓘ beside Contacts (scratch/fable-design/DESIGN-private-contacts-fable.md §3.2, slice C2): what the private contacts
 * list is, in the design's words, the same five lines as the web's ContactsInfo, with the true sentence about encryption
 * (§3.3: chats between two people and group chats are end-to-end encrypted, event and enterprise chats are not).
 */
import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { t } from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';

export function contactsInfoLines(): string[] {
    return [
        t("A contacts list that is yours. Sign in on any phone or browser and it's there, in every community you belong to."),
        t("It is locked on this device with your account's key, the one your 12 words make. Only you can open it. Each of your communities keeps a locked copy for you. The people who run those servers can't read it."),
        t('Nobody is told they are in your list. BeanPool never matches phone numbers.'),
        t("Chats between two people and group chats are end-to-end encrypted, always: there is nothing to turn on. Event chats and enterprise chats are not: the community's server can read those."),
        t("It's optional. Nothing is taken from your phone unless you choose it here."),
    ];
}

export function ContactsInfoSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
    const styles = useStyles(({ colors }) => StyleSheet.create({
        backdrop: { flex: 1, backgroundColor: colors.overlay.scrim, justifyContent: 'flex-end' },
        sheet: { backgroundColor: colors.surface.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '90%' },
        title: { fontSize: 18, fontWeight: '800', color: colors.text.heading, marginBottom: 12 },
        line: { flexDirection: 'row', gap: 8, marginBottom: 10 },
        dot: { fontSize: 15, color: colors.text.muted, lineHeight: 21 },
        text: { flex: 1, fontSize: 15, lineHeight: 21, color: colors.text.body },
        button: { marginTop: 8, minHeight: 48, borderRadius: 12, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
        buttonText: { fontSize: 16, fontWeight: '800', color: colors.text.inverse },
    }));
    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
            <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={t('Close')}>
                <Pressable style={styles.sheet} onPress={() => {}} testID="contacts-info">
                    <ScrollView>
                        <Text style={styles.title} accessibilityRole="header">{t('Your private contacts')}</Text>
                        {contactsInfoLines().map((line) => (
                            <View key={line} style={styles.line}>
                                <Text style={styles.dot} importantForAccessibility="no">•</Text>
                                <Text style={styles.text}>{line}</Text>
                            </View>
                        ))}
                        <Pressable accessibilityRole="button" style={styles.button} onPress={onClose}>
                            <Text style={styles.buttonText}>{t('Got it')}</Text>
                        </Pressable>
                    </ScrollView>
                </Pressable>
            </Pressable>
        </Modal>
    );
}
