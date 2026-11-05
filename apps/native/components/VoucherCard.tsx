import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { t, tn, formatNumber, formatDate } from '@beanpool/core';
import { useTheme, useStyles } from '../app/ThemeContext';
import {
    fetchVoucherCard, setVoucherBudget, stopNamesVoucher,
    type VoucherCardData, type OpenedEntry,
} from '../utils/names-list';
import type { BeanPoolIdentity } from '../utils/identity';

export interface VoucherCardProps {
    anchorUrl: string;
    identity: BeanPoolIdentity;
    memberPubkey: string;
    initialCard?: VoucherCardData | null;
    entry?: OpenedEntry | null;
    onClose?: () => void;
    onVoucherUpdated?: (updated: VoucherCardData) => void;
}

const QUICK_LEVELS = [500, 1000, 1500, 2000] as const;

function dateWords(iso: string | null | undefined, pattern: 'day-month' | 'day-month-year'): string {
    const d = iso ? new Date(iso) : null;
    return d && Number.isFinite(d.getTime()) ? formatDate(d, pattern) : '';
}

export function VoucherCard({ anchorUrl, identity, memberPubkey, initialCard, entry, onClose, onVoucherUpdated }: VoucherCardProps) {
    const { colors } = useTheme();
    const [card, setCard] = useState<VoucherCardData | null>(initialCard ?? null);
    const [loading, setLoading] = useState(!initialCard);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [showPeople, setShowPeople] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    const [targetLevel, setTargetLevel] = useState<number>(initialCard ? initialCard.level : 1000);

    const loadCard = useCallback(async () => {
        if (!anchorUrl || !identity || !memberPubkey) return;
        setLoading(true);
        setError(null);
        try {
            const res = await fetchVoucherCard(anchorUrl, identity, memberPubkey);
            if (res.ok) {
                setCard(res.value);
                setTargetLevel(res.value.level);
            } else {
                setError(res.message);
            }
        } finally {
            setLoading(false);
        }
    }, [anchorUrl, identity, memberPubkey]);

    useEffect(() => {
        if (!initialCard) {
            void loadCard();
        } else {
            setCard(initialCard);
            setTargetLevel(initialCard.level);
        }
    }, [initialCard, loadCard]);

    const handleSetBudget = async () => {
        if (!card || busy) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const res = await setVoucherBudget(anchorUrl, identity, card.memberPubkey, targetLevel);
            if (res.ok) {
                setCard((prev) => ({ ...res.value, canChange: prev?.canChange ?? true }));
                onVoucherUpdated?.(res.value);
                setNotice(t('Budget set to {level} Beans.', { level: formatNumber(targetLevel) }));
            } else {
                setError(res.message);
            }
        } finally {
            setBusy(false);
        }
    };

    const handleStopVoucher = () => {
        if (!card || busy) return;
        Alert.alert(
            t('Stop vouching'),
            t('Stop @{name} from vouching? Their budget ends. The credit lines they gave stay with the people they gave them to.', { name: card.callsign }),
            [
                { text: t('Cancel'), style: 'cancel' },
                {
                    text: t('Stop vouching'),
                    style: 'destructive',
                    onPress: async () => {
                        setBusy(true);
                        setError(null);
                        setNotice(null);
                        try {
                            const res = await stopNamesVoucher(anchorUrl, identity, card.memberPubkey);
                            if (res.ok) {
                                setCard((prev) => ({ ...res.value, canChange: prev?.canChange ?? true }));
                                onVoucherUpdated?.(res.value);
                                setNotice(t('Budget stopped.'));
                            } else {
                                setError(res.message);
                            }
                        } finally {
                            setBusy(false);
                        }
                    },
                },
            ],
        );
    };

    const styles = useStyles(({ colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        header: {
            flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 10,
            borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: colors.surface.card,
        },
        backButton: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
        headerTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: colors.text.heading, textAlign: 'center', paddingRight: 48 },
        scroll: { padding: 16, gap: 14, paddingBottom: 48 },
        titleBox: { gap: 4 },
        cardTitle: { fontSize: 20, fontWeight: '800', color: colors.text.heading },
        subtitle: { fontSize: 13, lineHeight: 18, color: colors.text.secondary },

        noticeBox: { padding: 12, borderRadius: 12, backgroundColor: colors.feedback.info.bg, borderWidth: 1, borderColor: colors.feedback.info.border },
        noticeText: { fontSize: 14, lineHeight: 20, color: colors.feedback.info.fg },
        errorBox: { padding: 12, borderRadius: 12, backgroundColor: colors.feedback.danger.bg, borderWidth: 1, borderColor: colors.feedback.danger.border },
        errorText: { fontSize: 14, lineHeight: 20, color: colors.feedback.danger.fg },

        box: {
            padding: 16, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default,
            backgroundColor: colors.surface.card, gap: 8,
        },
        boxHeader: { fontSize: 13, fontWeight: '700', letterSpacing: 0.5, color: colors.text.secondary, textTransform: 'uppercase', marginBottom: 2 },
        boxLine: { fontSize: 15, lineHeight: 22, color: colors.text.body },

        controlSection: { marginTop: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border.default, gap: 10 },
        controlTitle: { fontSize: 15, fontWeight: '700', color: colors.text.heading },
        controlHint: { fontSize: 13, color: colors.text.secondary },
        levelsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
        levelBtn: {
            minHeight: 48, minWidth: 64, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10,
            alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface.subtle,
            borderWidth: 1, borderColor: colors.border.strong,
        },
        levelBtnActive: { backgroundColor: colors.brand.fill, borderColor: colors.brand.fill },
        levelBtnText: { fontSize: 14, fontWeight: '600', color: colors.text.body },
        levelBtnTextActive: { color: colors.text.inverse, fontWeight: '800' },

        stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
        stepperBtn: {
            minWidth: 48, minHeight: 48, borderRadius: 10, backgroundColor: colors.surface.subtle,
            borderWidth: 1, borderColor: colors.border.strong, alignItems: 'center', justifyContent: 'center',
        },
        stepperBtnText: { fontSize: 20, fontWeight: '700', color: colors.text.heading },
        stepperValue: { flex: 1, fontSize: 16, fontWeight: '700', color: colors.text.heading, textAlign: 'center' },

        actionBtn: {
            minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12,
            alignItems: 'center', justifyContent: 'center', backgroundColor: colors.brand.fill,
        },
        actionBtnText: { fontSize: 15, fontWeight: '700', color: colors.text.inverse },
        dangerBtn: {
            minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12,
            alignItems: 'center', justifyContent: 'center', backgroundColor: colors.feedback.danger.bg,
            borderWidth: 1, borderColor: colors.feedback.danger.border,
        },
        dangerBtnText: { fontSize: 15, fontWeight: '700', color: colors.feedback.danger.fg },
        toggleBtn: {
            minHeight: 48, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12,
            alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface.subtle,
            borderWidth: 1, borderColor: colors.border.strong,
        },
        toggleBtnText: { fontSize: 14, fontWeight: '600', color: colors.text.body },
        disabled: { opacity: 0.5 },

        subList: { marginTop: 4, gap: 8 },
        sectionTitle: { fontSize: 16, fontWeight: '700', color: colors.text.heading, marginTop: 8 },
        emptyText: { fontSize: 14, color: colors.text.secondary },
        itemRow: {
            padding: 12, borderRadius: 10, backgroundColor: colors.surface.subtle,
            borderWidth: 1, borderColor: colors.border.default, gap: 4,
        },
        itemHead: { fontSize: 14, fontWeight: '700', color: colors.text.heading },
        itemDetail: { fontSize: 13, lineHeight: 18, color: colors.text.body },
    }));

    if (loading) {
        return (
            <View style={styles.container}>
                {onClose && (
                    <View style={styles.header}>
                        <Pressable onPress={onClose} style={styles.backButton} accessibilityRole="button" accessibilityLabel={t('Back')}>
                            <MaterialCommunityIcons name="arrow-left" size={26} color={colors.text.heading} />
                        </Pressable>
                        <Text style={styles.headerTitle}>{t('Voucher')}</Text>
                    </View>
                )}
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
                    <ActivityIndicator color={colors.brand.primary} accessibilityLabel={t('Loading')} />
                </View>
            </View>
        );
    }

    if (!card) {
        return (
            <View style={styles.container}>
                {onClose && (
                    <View style={styles.header}>
                        <Pressable onPress={onClose} style={styles.backButton} accessibilityRole="button" accessibilityLabel={t('Back')}>
                            <MaterialCommunityIcons name="arrow-left" size={26} color={colors.text.heading} />
                        </Pressable>
                        <Text style={styles.headerTitle}>{t('Voucher')}</Text>
                    </View>
                )}
                <View style={{ padding: 16 }}>
                    {error && (
                        <View style={styles.errorBox}>
                            <Text style={styles.errorText}>{error}</Text>
                        </View>
                    )}
                </View>
            </View>
        );
    }

    const titleName = entry?.text?.name?.trim() || (card.callsign ? `@${card.callsign}` : t('Voucher'));
    const confirmedPart = card.callsign
        ? (card.madeByCallsign
            ? t('@{name}: confirmed by @{confBy}, {confDate}', {
                name: card.callsign,
                confBy: card.madeByCallsign,
                confDate: dateWords(card.madeAt, 'day-month'),
            })
            : `@${card.callsign}`)
        : '';
    const madePart = card.source === 'role'
        ? t('made a voucher by role')
        : (card.madeByCallsign
            ? t('made a voucher by @{name}, {date}', { name: card.madeByCallsign, date: dateWords(card.madeAt, 'day-month') })
            : '');
    const subtitleLine = [confirmedPart, madePart].filter(Boolean).join(' · ');

    const minAllowed = Math.max(100, Math.ceil((card.held || 0) / 100) * 100);

    return (
        <View style={styles.container}>
            {onClose && (
                <View style={styles.header}>
                    <Pressable onPress={onClose} style={styles.backButton} accessibilityRole="button" accessibilityLabel={t('Back')}>
                        <MaterialCommunityIcons name="arrow-left" size={26} color={colors.text.heading} />
                    </Pressable>
                    <Text style={styles.headerTitle} accessibilityRole="header">{t('Voucher')}</Text>
                </View>
            )}

            <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
                <View style={styles.titleBox}>
                    <Text style={styles.cardTitle}>{t('{name} · Voucher', { name: titleName })}</Text>
                    {subtitleLine ? <Text style={styles.subtitle}>{subtitleLine}</Text> : null}
                </View>

                {notice && (
                    <View style={styles.noticeBox} accessibilityLiveRegion="polite">
                        <Text style={styles.noticeText}>{notice}</Text>
                    </View>
                )}
                {error && (
                    <View style={styles.errorBox} accessibilityLiveRegion="assertive">
                        <Text style={styles.errorText}>{error}</Text>
                    </View>
                )}

                {/* Their budget card */}
                <View style={styles.box} testID="voucher-budget-card">
                    <Text style={styles.boxHeader}>{t('Their budget')}</Text>
                    <Text style={styles.boxLine}>
                        {t('{left} of {budget} left', { left: formatNumber(card.left), budget: formatNumber(card.level) })}
                    </Text>
                    <Text style={styles.boxLine}>
                        {tn(card.peopleVouched, 'Vouched {amount} to {n} person who joined', 'Vouched {amount} to {n} people who joined', { amount: formatNumber(card.vouched) })}
                    </Text>
                    <Text style={styles.boxLine}>
                        {tn(card.heldInvites, 'Held {amount} on {n} invite not used yet', 'Held {amount} on {n} invites not used yet', { amount: formatNumber(card.held) })}
                    </Text>
                    <Text style={styles.boxLine}>
                        {tn(card.invitesWithVouch, 'Invites sent with a vouch: {n}', 'Invites sent with a vouch: {n}')}
                    </Text>
                    <Text style={styles.boxLine}>
                        {t('{belowZero} of {total} below zero · written off {writtenOff}', {
                            belowZero: card.belowZero,
                            total: card.peopleVouched,
                            writtenOff: formatNumber(card.writtenOff),
                        })}
                    </Text>
                    <Text style={styles.boxLine}>
                        {t('Trading: {others} with others · {inside} inside only', {
                            others: card.trading?.withOthers ?? 0,
                            inside: card.trading?.insideOnly ?? 0,
                        })}
                    </Text>
                    <Text style={styles.boxLine}>
                        {card.passedOn && card.passedOn.amount > 0
                            ? tn(card.passedOn.people, 'Passed on: {amount} of their {vouched} to {n} person · {belowZero} of it below zero', 'Passed on: {amount} of their {vouched} to {n} people · {belowZero} of it below zero', {
                                amount: formatNumber(card.passedOn.amount),
                                vouched: formatNumber(card.vouched),
                                belowZero: 0,
                            })
                            : t('Passed on: 0')}
                    </Text>

                    {/* Set budget to control (§10) */}
                    {card.canChange && !card.stoppedAt && (
                        <View style={styles.controlSection} testID="set-budget-control">
                            <Text style={styles.controlTitle}>{t('Set budget to')}</Text>
                            <Text style={styles.controlHint}>
                                {t('{left} left · {held} held', { left: formatNumber(card.left), held: formatNumber(card.held) })}
                            </Text>

                            <View style={styles.levelsRow}>
                                {QUICK_LEVELS.map((lvl) => {
                                    const disabled = lvl < minAllowed || lvl > 2000;
                                    const active = targetLevel === lvl;
                                    return (
                                        <Pressable
                                            key={lvl}
                                            style={[styles.levelBtn, active && styles.levelBtnActive, disabled && styles.disabled]}
                                            onPress={() => setTargetLevel(lvl)}
                                            disabled={disabled || busy}
                                            accessibilityRole="button"
                                            accessibilityLabel={formatNumber(lvl)}
                                        >
                                            <Text style={[styles.levelBtnText, active && styles.levelBtnTextActive]}>
                                                {formatNumber(lvl)}
                                            </Text>
                                        </Pressable>
                                    );
                                })}
                            </View>

                            <View style={styles.stepperRow}>
                                <Pressable
                                    style={[styles.stepperBtn, (targetLevel <= minAllowed || busy) && styles.disabled]}
                                    onPress={() => setTargetLevel((l) => Math.max(minAllowed, l - 100))}
                                    disabled={targetLevel <= minAllowed || busy}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('Decrease by 100')}
                                >
                                    <Text style={styles.stepperBtnText}>−</Text>
                                </Pressable>
                                <Text style={styles.stepperValue}>
                                    {t('Set budget to: {level}', { level: formatNumber(targetLevel) })}
                                </Text>
                                <Pressable
                                    style={[styles.stepperBtn, (targetLevel >= 2000 || busy) && styles.disabled]}
                                    onPress={() => setTargetLevel((l) => Math.min(2000, l + 100))}
                                    disabled={targetLevel >= 2000 || busy}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('Increase by 100')}
                                >
                                    <Text style={styles.stepperBtnText}>+</Text>
                                </Pressable>
                            </View>

                            <Pressable
                                style={[styles.actionBtn, busy && styles.disabled]}
                                onPress={() => { void handleSetBudget(); }}
                                disabled={busy}
                                accessibilityRole="button"
                                accessibilityLabel={t('Set budget to {level}', { level: formatNumber(targetLevel) })}
                            >
                                <Text style={styles.actionBtnText}>
                                    {t('Set budget to {level}', { level: formatNumber(targetLevel) })}
                                </Text>
                            </Pressable>
                        </View>
                    )}

                    <Pressable
                        style={styles.toggleBtn}
                        onPress={() => setShowPeople(!showPeople)}
                        accessibilityRole="button"
                        accessibilityLabel={t('See who they brought in ›')}
                    >
                        <Text style={styles.toggleBtnText}>{t('See who they brought in ›')}</Text>
                    </Pressable>

                    {card.canChange && card.source === 'entry' && !card.stoppedAt && (
                        <Pressable
                            style={[styles.dangerBtn, busy && styles.disabled]}
                            onPress={handleStopVoucher}
                            disabled={busy}
                            accessibilityRole="button"
                            accessibilityLabel={t('Stop vouching')}
                        >
                            <Text style={styles.dangerBtnText}>{t('Stop vouching')}</Text>
                        </Pressable>
                    )}
                </View>

                {/* See who they brought in */}
                {showPeople && (
                    <View style={styles.box} testID="who-they-brought-in">
                        <Text style={styles.sectionTitle}>{t('People vouched for')}</Text>
                        {card.people.length === 0 ? (
                            <Text style={styles.emptyText}>{t('No members vouched for yet.')}</Text>
                        ) : (
                            <View style={styles.subList}>
                                {card.people.map((p) => {
                                    const tradingText = p.trading === 'others'
                                        ? t('trades with others ✓')
                                        : p.trading === 'inside'
                                        ? t('trades inside only')
                                        : t('no trades yet');
                                    const dateStr = dateWords(p.joinedAt, 'day-month-year');
                                    return (
                                        <View key={p.memberPubkey} style={styles.itemRow}>
                                            <Text style={styles.itemHead}>@{p.callsign}</Text>
                                            <Text style={styles.itemDetail}>
                                                {p.belowZero
                                                    ? t('@{name} · joined {date} · {amount} vouched · {trading} · below zero', {
                                                        name: p.callsign,
                                                        date: dateStr,
                                                        amount: formatNumber(p.amount),
                                                        trading: tradingText,
                                                    })
                                                    : t('@{name} · joined {date} · {amount} vouched · {trading}', {
                                                        name: p.callsign,
                                                        date: dateStr,
                                                        amount: formatNumber(p.amount),
                                                        trading: tradingText,
                                                    })}
                                            </Text>
                                        </View>
                                    );
                                })}
                            </View>
                        )}
                    </View>
                )}

                {/* Budget history */}
                <Pressable
                    style={styles.toggleBtn}
                    onPress={() => setShowHistory(!showHistory)}
                    accessibilityRole="button"
                    accessibilityLabel={t('Budget history ›')}
                >
                    <Text style={styles.toggleBtnText}>{t('Budget history ›')}</Text>
                </Pressable>

                {showHistory && (
                    <View style={styles.box} testID="budget-history-section">
                        <Text style={styles.sectionTitle}>{t('Budget history')}</Text>
                        {card.history.length === 0 ? (
                            <Text style={styles.emptyText}>{t('No budget history yet.')}</Text>
                        ) : (
                            <View style={styles.subList}>
                                {card.history.map((h, idx) => {
                                    const dateStr = dateWords(h.at, 'day-month');
                                    const actorName = h.actorCallsign || (h.actor.startsWith('migration:') ? 'migration' : h.actor);
                                    let line: string;
                                    if (h.kind === 'grant') {
                                        line = t('+{amount} budget, made a voucher by @{name}, {date}', { amount: formatNumber(h.amount), name: actorName, date: dateStr });
                                    } else if (h.kind === 'top_up') {
                                        line = t('+{amount} top-up by @{name}, {date}', { amount: formatNumber(h.amount), name: actorName, date: dateStr });
                                    } else if (h.kind === 'lower') {
                                        line = t('−{amount} lower by @{name}, {date}', { amount: formatNumber(-h.amount), name: actorName, date: dateStr });
                                    } else if (h.kind === 'hold') {
                                        if (h.for === 'profile' && h.person) {
                                            line = t('−{amount} held for @{name}, {date}', { amount: formatNumber(-h.amount), name: h.person.callsign, date: dateStr });
                                        } else {
                                            line = t('−{amount} held for an invite, {date}', { amount: formatNumber(-h.amount), date: dateStr });
                                        }
                                    } else if (h.kind === 'return') {
                                        if (h.why === 'expired') {
                                            line = t('+{amount} back, invite expired, {date}', { amount: formatNumber(h.amount), date: dateStr });
                                        } else if (h.why === 'stopped') {
                                            line = t('+{amount} back, budget stopped, {date}', { amount: formatNumber(h.amount), date: dateStr });
                                        } else if (h.why === 'not_landed') {
                                            line = t('+{amount} back, vouch didn’t land, {date}', { amount: formatNumber(h.amount), date: dateStr });
                                        } else {
                                            line = t('+{amount} back, {date}', { amount: formatNumber(h.amount), date: dateStr });
                                        }
                                    } else if (h.kind === 'stop') {
                                        line = t('Budget stopped by @{name}, {date}', { name: actorName, date: dateStr });
                                    } else {
                                        line = `${h.kind}: ${formatNumber(h.amount)} (${dateStr})`;
                                    }
                                    return (
                                        <View key={`${h.kind}-${h.at}-${idx}`} style={styles.itemRow}>
                                            <Text style={styles.itemDetail}>{line}</Text>
                                        </View>
                                    );
                                })}
                            </View>
                        )}
                    </View>
                )}
            </ScrollView>
        </View>
    );
}
