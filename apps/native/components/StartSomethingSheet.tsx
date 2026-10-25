import React from 'react';
import {
    Modal,
    View,
    Text,
    StyleSheet,
    Pressable,
    ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme, useStyles } from '../app/ThemeContext';
import { t } from '@beanpool/core';
import type { StartRow, StartRowKey } from '../utils/start-something';
import { hapticTick } from '../utils/haptics';

interface StartSomethingSheetProps {
    visible: boolean;
    onClose: () => void;
    rows: StartRow[];
    onPick: (key: StartRowKey) => void;
}

export function StartSomethingSheet({ visible, onClose, rows, onPick }: StartSomethingSheetProps) {
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();

    const styles = useStyles(({ colors }) => StyleSheet.create({
        backdrop: {
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.5)',
            justifyContent: 'flex-end',
        },
        sheet: {
            backgroundColor: colors.surface.card,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            flexShrink: 1,
            maxHeight: '85%',
        },
        header: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 20,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: colors.border.default,
        },
        title: {
            fontSize: 18,
            fontWeight: '800',
            color: colors.text.heading,
        },
        closeBtn: {
            width: 48,
            height: 48,
            marginRight: -12,
            alignItems: 'center',
            justifyContent: 'center',
        },
        content: {
            paddingHorizontal: 20,
            paddingTop: 8,
            paddingBottom: 20,
        },
        sectionCaption: {
            fontSize: 11,
            fontWeight: '700',
            color: colors.text.secondary,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            marginTop: 12,
            marginBottom: 4,
        },
        row: {
            minHeight: 56,
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 10,
        },
        emojiWrap: {
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: colors.surface.subtle,
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 14,
        },
        emojiText: {
            fontSize: 22,
        },
        textWrap: {
            flex: 1,
        },
        rowTitle: {
            fontSize: 15,
            fontWeight: '700',
            color: colors.text.heading,
        },
        rowLine: {
            fontSize: 12,
            lineHeight: 18,
            color: colors.text.secondary,
            marginTop: 2,
        },
        standingLine: {
            fontSize: 12,
            lineHeight: 16,
            color: colors.feedback.warning.fg,
            marginTop: 2,
        },
    }));

    const commonsRows = rows.filter(r => r.section === 'commons');
    const marketRows = rows.filter(r => r.section === 'market');

    const renderRow = (row: StartRow) => {
        const titleText = t(row.title);
        const lineText = t(row.line);
        const standingText = row.standingLine ? t(row.standingLine) : null;
        const accessibilityLabel = standingText
            ? `${titleText}, ${lineText}, ${standingText}`
            : `${titleText}, ${lineText}`;

        return (
            <Pressable
                key={row.key}
                style={styles.row}
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel}
                onPress={() => {
                    hapticTick();
                    onPick(row.key);
                }}
            >
                <View style={styles.emojiWrap}>
                    <Text style={styles.emojiText} allowFontScaling={false}>{row.emoji}</Text>
                </View>
                <View style={styles.textWrap}>
                    <Text style={styles.rowTitle}>{titleText}</Text>
                    <Text style={styles.rowLine} numberOfLines={2}>{lineText}</Text>
                    {standingText && (
                        <Text style={styles.standingLine} numberOfLines={2}>
                            ⚠ {standingText}
                        </Text>
                    )}
                </View>
                <MaterialCommunityIcons name="chevron-right" size={20} color={colors.text.muted} />
            </Pressable>
        );
    };

    return (
        <Modal
            visible={visible}
            animationType="slide"
            transparent
            onRequestClose={onClose}
        >
            <View style={styles.backdrop}>
                <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
                    <View style={styles.header}>
                        <Text style={styles.title} accessibilityRole="header">{t('Start something')}</Text>
                        <Pressable
                            style={styles.closeBtn}
                            onPress={onClose}
                            accessibilityRole="button"
                            accessibilityLabel={t('Close')}
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        >
                            <MaterialCommunityIcons name="close" size={22} color={colors.text.muted} />
                        </Pressable>
                    </View>
                    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                        {commonsRows.map(renderRow)}
                        {marketRows.length > 0 && (
                            <>
                                <Text style={styles.sectionCaption}>{t('IN THE MARKET')}</Text>
                                {marketRows.map(renderRow)}
                            </>
                        )}
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
}
