import React, { useState, useEffect } from 'react';
import {
    Modal,
    View,
    Text,
    StyleSheet,
    Pressable,
    ScrollView,
    ActivityIndicator,
    SafeAreaView,
    Platform,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
    ARCHETYPES,
    QUICK_SPARK_QUESTIONS,
    DEEP_RESONANCE_QUESTIONS,
    scoreQuiz,
    type ArchetypeKey,
    type QuizQuestion,
    type QuizResult,
} from '../utils/archetypes';
import { colors, palette } from '../constants/colors';
import { useTheme } from '../app/ThemeContext';

interface ArchetypeQuizModalProps {
    visible: boolean;
    initialMode?: 'quick' | 'deep';
    onClose: () => void;
    onComplete: (result: QuizResult) => void;
}

export function ArchetypeQuizModal({
    visible,
    initialMode = 'quick',
    onClose,
    onComplete,
}: ArchetypeQuizModalProps) {
    const { theme, colors } = useTheme();
    const [step, setStep] = useState<'intro' | 'quiz' | 'result'>('intro');
    const [mode, setMode] = useState<'quick' | 'deep'>(initialMode);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [answers, setAnswers] = useState<ArchetypeKey[]>([]);
    const [result, setResult] = useState<QuizResult | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (visible) {
            setStep('intro');
            setMode(initialMode);
            setCurrentIndex(0);
            setAnswers([]);
            setResult(null);
            setSaving(false);
        }
    }, [visible, initialMode]);

    const questions: QuizQuestion[] =
        mode === 'quick' ? QUICK_SPARK_QUESTIONS : DEEP_RESONANCE_QUESTIONS;
    const currentQ = questions[currentIndex];
    const totalQuestions = questions.length;
    const progress = totalQuestions > 0 ? (currentIndex + 1) / totalQuestions : 0;

    const handleSelectOption = (target: ArchetypeKey) => {
        const nextAnswers = [...answers];
        nextAnswers[currentIndex] = target;
        setAnswers(nextAnswers);

        if (currentIndex + 1 < totalQuestions) {
            setCurrentIndex(currentIndex + 1);
        } else {
            // Completed quiz!
            const finalResult = scoreQuiz(nextAnswers, mode);
            setResult(finalResult);
            setStep('result');
        }
    };

    const handleBackQuestion = () => {
        if (currentIndex > 0) {
            setCurrentIndex(currentIndex - 1);
        } else {
            setStep('intro');
        }
    };

    const handleSave = async () => {
        if (!result) return;
        setSaving(true);
        try {
            await onComplete(result);
        } finally {
            setSaving(false);
        }
    };

    const primaryInfo = result ? ARCHETYPES[result.primary] : null;
    const secondaryInfo = result ? ARCHETYPES[result.secondary] : null;

    return (
        <Modal
            visible={visible}
            animationType="slide"
            presentationStyle="pageSheet"
            onRequestClose={onClose}
        >
            <SafeAreaView
                style={[
                    styles.container,
                    { backgroundColor: theme === 'dark' ? colors.surface.app : palette.grayAlt100 },
                ]}
            >
                {/* ─── Header ─── */}
                <View
                    style={[
                        styles.header,
                        {
                            backgroundColor: colors.surface.card,
                            borderBottomColor: colors.border.default,
                        },
                    ]}
                >
                    {step === 'quiz' ? (
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Go back to previous question"
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            style={styles.headerBtn}
                            onPress={handleBackQuestion}
                        >
                            <MaterialCommunityIcons
                                name="arrow-left"
                                size={22}
                                color={colors.text.body}
                            />
                        </Pressable>
                    ) : (
                        <View style={{ width: 36 }} />
                    )}

                    <Text style={[styles.headerTitle, { color: colors.text.heading }]}>
                        {step === 'intro'
                            ? 'Discover Your Archetype'
                            : step === 'quiz'
                            ? `${mode === 'quick' ? '⚡ Quick Spark' : '🧭 Deep Resonance'}`
                            : '✨ Your Working Style'}
                    </Text>

                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Close quiz modal"
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        style={styles.headerBtn}
                        onPress={onClose}
                    >
                        <MaterialCommunityIcons name="close" size={22} color={colors.text.muted} />
                    </Pressable>
                </View>

                {/* ─── Body Content ─── */}
                {step === 'intro' && (
                    <ScrollView
                        contentContainerStyle={styles.introContent}
                        showsVerticalScrollIndicator={false}
                    >
                        <View style={styles.introEmojiWrap}>
                            <Text style={styles.introBigEmoji}>🌱</Text>
                        </View>

                        <Text style={[styles.introHeadline, { color: colors.text.heading }]}>
                            Community Working Style
                        </Text>
                        <Text style={[styles.introSub, { color: colors.text.secondary }]}>
                            Every community thrives on a balance of different energies — from
                            creative visionaries and organizers to anchors and champions. Discover
                            your natural superpowers and see your collaboration synergy with neighbours.
                        </Text>

                        {/* Mode Card: Quick Spark */}
                        <Pressable
                            accessibilityRole="button"
                            style={({ pressed }) => [
                                styles.modeCard,
                                {
                                    backgroundColor: colors.surface.card,
                                    borderColor: colors.border.default,
                                    opacity: pressed ? 0.85 : 1,
                                },
                            ]}
                            onPress={() => {
                                setMode('quick');
                                setCurrentIndex(0);
                                setAnswers([]);
                                setStep('quiz');
                            }}
                        >
                            <View style={styles.modeCardHeader}>
                                <View style={styles.modeIconWrap}>
                                    <Text style={{ fontSize: 22 }}>⚡</Text>
                                </View>
                                <View style={{ flex: 1, marginLeft: 12 }}>
                                    <View style={styles.modeTitleRow}>
                                        <Text
                                            style={[styles.modeTitle, { color: colors.text.heading }]}
                                        >
                                            Quick Spark
                                        </Text>
                                        <View
                                            style={[
                                                styles.timeBadge,
                                                { backgroundColor: colors.brand.tint },
                                            ]}
                                        >
                                            <Text
                                                style={[
                                                    styles.timeBadgeText,
                                                    { color: colors.brand.primary },
                                                ]}
                                            >
                                                9 Qs • ~1 min
                                            </Text>
                                        </View>
                                    </View>
                                    <Text
                                        style={[styles.modeDesc, { color: colors.text.secondary }]}
                                    >
                                        A fast 60-second snapshot to discover your core community
                                        rhythm and start seeing synergy with others.
                                    </Text>
                                </View>
                            </View>
                        </Pressable>

                        {/* Mode Card: Deep Resonance */}
                        <Pressable
                            accessibilityRole="button"
                            style={({ pressed }) => [
                                styles.modeCard,
                                {
                                    backgroundColor: colors.surface.card,
                                    borderColor: colors.brand.primary,
                                    borderWidth: 1.5,
                                    opacity: pressed ? 0.85 : 1,
                                },
                            ]}
                            onPress={() => {
                                setMode('deep');
                                setCurrentIndex(0);
                                setAnswers([]);
                                setStep('quiz');
                            }}
                        >
                            <View style={styles.modeCardHeader}>
                                <View
                                    style={[
                                        styles.modeIconWrap,
                                        { backgroundColor: colors.brand.tint },
                                    ]}
                                >
                                    <Text style={{ fontSize: 22 }}>🧭</Text>
                                </View>
                                <View style={{ flex: 1, marginLeft: 12 }}>
                                    <View style={styles.modeTitleRow}>
                                        <Text
                                            style={[styles.modeTitle, { color: colors.text.heading }]}
                                        >
                                            Deep Resonance
                                        </Text>
                                        <View
                                            style={[
                                                styles.timeBadge,
                                                {
                                                    backgroundColor:
                                                        theme === 'dark'
                                                            ? colors.brand.tint
                                                            : palette.emerald100,
                                                },
                                            ]}
                                        >
                                            <Text
                                                style={[
                                                    styles.timeBadgeText,
                                                    {
                                                        color:
                                                            theme === 'dark'
                                                                ? colors.brand.primary
                                                                : palette.emerald800,
                                                    },
                                                ]}
                                            >
                                                27 Qs • ~3 min
                                            </Text>
                                        </View>
                                    </View>
                                    <Text
                                        style={[styles.modeDesc, { color: colors.text.secondary }]}
                                    >
                                        Recommended for deep accuracy. Maps your primary archetype,
                                        secondary wings, and complementary collaborator pairings.
                                    </Text>
                                </View>
                            </View>
                        </Pressable>

                        {/* Privacy Note */}
                        <View
                            style={[
                                styles.privacyBox,
                                {
                                    backgroundColor:
                                        theme === 'dark'
                                            ? colors.surface.subtle
                                            : palette.green50,
                                    borderColor:
                                        theme === 'dark' ? colors.border.default : palette.green100,
                                },
                            ]}
                        >
                            <MaterialCommunityIcons
                                name="shield-check-outline"
                                size={18}
                                color={colors.brand.primary}
                                style={{ marginRight: 8, marginTop: 1 }}
                            />
                            <Text
                                style={[
                                    styles.privacyText,
                                    {
                                        color:
                                            theme === 'dark'
                                                ? colors.text.secondary
                                                : palette.green800,
                                    },
                                ]}
                            >
                                <Text style={{ fontWeight: '700' }}>Privacy-First:</Text> We never
                                display psychological type numbers or clinical labels. The app only
                                calculates relational synergy between members.
                            </Text>
                        </View>
                    </ScrollView>
                )}

                {step === 'quiz' && currentQ && (
                    <View style={styles.quizWrapper}>
                        {/* Progress Header */}
                        <View
                            style={styles.progressContainer}
                            accessibilityRole="progressbar"
                            accessibilityLabel="Quiz progress"
                            accessibilityValue={{
                                min: 1,
                                max: totalQuestions,
                                now: currentIndex + 1,
                                text: `Question ${currentIndex + 1} of ${totalQuestions}`,
                            }}
                        >
                            <View style={styles.progressTrack}>
                                <View
                                    style={[
                                        styles.progressFill,
                                        {
                                            width: `${Math.round(progress * 100)}%`,
                                            backgroundColor: colors.brand.primary,
                                        },
                                    ]}
                                />
                            </View>
                            <Text style={[styles.progressText, { color: colors.text.muted }]}>
                                Question {currentIndex + 1} of {totalQuestions}
                            </Text>
                        </View>

                        {/* Question Prompt Card */}
                        <ScrollView
                            contentContainerStyle={styles.quizScroll}
                            showsVerticalScrollIndicator={false}
                        >
                            <View
                                style={[
                                    styles.questionCard,
                                    {
                                        backgroundColor: colors.surface.card,
                                        borderColor: colors.border.default,
                                    },
                                ]}
                            >
                                <Text
                                    style={[styles.questionPrompt, { color: colors.text.heading }]}
                                >
                                    {currentQ.prompt}
                                </Text>
                            </View>

                            {/* Options */}
                            <View style={styles.optionsList}>
                                {currentQ.options.map((opt, idx) => {
                                    const isSelected = answers[currentIndex] === opt.target;
                                    return (
                                        <Pressable
                                            key={idx}
                                            accessibilityRole="radio"
                                            accessibilityLabel={opt.text}
                                            accessibilityState={{ selected: isSelected }}
                                            style={({ pressed }) => [
                                                styles.optionButton,
                                                {
                                                    backgroundColor: isSelected
                                                        ? colors.brand.tint
                                                        : colors.surface.card,
                                                    borderColor: isSelected
                                                        ? colors.brand.primary
                                                        : colors.border.default,
                                                    opacity: pressed ? 0.85 : 1,
                                                },
                                            ]}
                                            onPress={() => handleSelectOption(opt.target)}
                                        >
                                            {opt.emoji && (
                                                <Text style={styles.optionEmoji} aria-hidden={true}>
                                                    {opt.emoji}
                                                </Text>
                                            )}
                                            <Text
                                                style={[
                                                    styles.optionText,
                                                    {
                                                        color: isSelected
                                                            ? colors.brand.dark
                                                            : colors.text.body,
                                                        fontWeight: isSelected ? '700' : '500',
                                                    },
                                                ]}
                                            >
                                                {opt.text}
                                            </Text>
                                        </Pressable>
                                    );
                                })}
                            </View>
                        </ScrollView>
                    </View>
                )}

                {step === 'result' && result && primaryInfo && (
                    <ScrollView
                        contentContainerStyle={styles.resultScroll}
                        showsVerticalScrollIndicator={false}
                    >
                        {/* Primary Badge Card */}
                        <View
                            style={[
                                styles.resultHeroCard,
                                {
                                    backgroundColor: colors.surface.card,
                                    borderColor: colors.border.default,
                                },
                            ]}
                        >
                            <Text style={styles.resultEmoji}>{primaryInfo.emoji}</Text>
                            <Text style={[styles.resultArchetypeName, { color: colors.text.heading }]}>
                                {primaryInfo.name}
                            </Text>
                            <Text style={[styles.resultTagline, { color: colors.brand.primary }]}>
                                {primaryInfo.tagline}
                            </Text>
                            <Text style={[styles.resultDesc, { color: colors.text.secondary }]}>
                                {primaryInfo.description}
                            </Text>

                            {secondaryInfo && (
                                <View
                                    style={[
                                        styles.secondaryPill,
                                        {
                                            backgroundColor: colors.surface.subtle,
                                            borderColor: colors.border.default,
                                        },
                                    ]}
                                >
                                    <Text
                                        style={[
                                            styles.secondaryText,
                                            { color: colors.text.body },
                                        ]}
                                    >
                                        Secondary Rhythm: {secondaryInfo.emoji} {secondaryInfo.name}
                                    </Text>
                                </View>
                            )}
                        </View>

                        {/* Superpowers */}
                        <View
                            style={[
                                styles.sectionCard,
                                {
                                    backgroundColor: colors.surface.card,
                                    borderColor: colors.border.default,
                                },
                            ]}
                        >
                            <Text style={[styles.sectionTitle, { color: colors.text.heading }]}>
                                🌟 Your Community Superpowers
                            </Text>
                            {primaryInfo.superpowers.map((power, i) => (
                                <View key={i} style={styles.bulletRow}>
                                    <Text style={[styles.bulletPoint, { color: colors.brand.primary }]}>
                                        •
                                    </Text>
                                    <Text style={[styles.bulletText, { color: colors.text.body }]}>
                                        {power}
                                    </Text>
                                </View>
                            ))}
                        </View>

                        {/* Ideal Collaborators */}
                        <View
                            style={[
                                styles.sectionCard,
                                {
                                    backgroundColor: colors.surface.card,
                                    borderColor: colors.border.default,
                                },
                            ]}
                        >
                            <Text style={[styles.sectionTitle, { color: colors.text.heading }]}>
                                👥 Ideal Collaborator Pairings
                            </Text>
                            <Text style={[styles.sectionSubtitle, { color: colors.text.secondary }]}>
                                You naturally build high synergy when collaborating on projects or deals with:
                            </Text>
                            <View style={styles.partnerTagsRow}>
                                {primaryInfo.idealPartners.map((partnerKey) => {
                                    const p = ARCHETYPES[partnerKey];
                                    if (!p) return null;
                                    return (
                                        <View
                                            key={partnerKey}
                                            style={[
                                                styles.partnerTag,
                                                {
                                                    backgroundColor: colors.surface.subtle,
                                                    borderColor: colors.border.default,
                                                },
                                            ]}
                                        >
                                            <Text style={styles.partnerEmoji}>{p.emoji}</Text>
                                            <Text
                                                style={[
                                                    styles.partnerName,
                                                    { color: colors.text.heading },
                                                ]}
                                            >
                                                {p.name}
                                            </Text>
                                        </View>
                                    );
                                })}
                            </View>
                        </View>

                        {/* Action Buttons */}
                        <View style={styles.actionButtonsWrap}>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={saving ? "Saving archetype to profile" : "Save to My Profile"}
                                accessibilityState={{ disabled: saving, busy: saving }}
                                style={({ pressed }) => [
                                    styles.saveBtn,
                                    {
                                        backgroundColor: colors.brand.dark,
                                        opacity: pressed || saving ? 0.85 : 1,
                                    },
                                ]}
                                onPress={handleSave}
                                disabled={saving}
                            >
                                {saving ? (
                                    <ActivityIndicator size="small" color={colors.text.inverse} />
                                ) : (
                                    <Text
                                        style={[
                                            styles.saveBtnText,
                                            { color: colors.text.inverse },
                                        ]}
                                    >
                                        Save to My Profile
                                    </Text>
                                )}
                            </Pressable>

                            {mode === 'quick' && (
                                <Pressable
                                    accessibilityRole="button"
                                    style={styles.secondaryActionBtn}
                                    onPress={() => {
                                        setMode('deep');
                                        setCurrentIndex(0);
                                        setAnswers([]);
                                        setStep('quiz');
                                    }}
                                >
                                    <Text
                                        style={[
                                            styles.secondaryActionText,
                                            { color: colors.brand.primary },
                                        ]}
                                    >
                                        🧭 Deepen with 27 Questions (~3 min)
                                    </Text>
                                </Pressable>
                            )}
                        </View>
                    </ScrollView>
                )}
            </SafeAreaView>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderBottomWidth: 1,
    },
    headerBtn: {
        width: 36,
        height: 36,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 18,
    },
    headerTitle: {
        fontSize: 16,
        fontWeight: '800',
    },

    // Intro Screen
    introContent: {
        padding: 24,
        paddingBottom: 48,
        alignItems: 'center',
    },
    introEmojiWrap: {
        width: 72,
        height: 72,
        borderRadius: 36,
        backgroundColor: palette.green50,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 12,
        marginBottom: 16,
    },
    introBigEmoji: {
        fontSize: 38,
    },
    introHeadline: {
        fontSize: 24,
        fontWeight: '900',
        textAlign: 'center',
        marginBottom: 8,
    },
    introSub: {
        fontSize: 14,
        lineHeight: 21,
        textAlign: 'center',
        marginBottom: 24,
        paddingHorizontal: 8,
    },
    modeCard: {
        width: '100%',
        borderRadius: 16,
        padding: 16,
        marginBottom: 16,
        borderWidth: 1,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.04,
        shadowRadius: 4,
        elevation: 2,
    },
    modeCardHeader: {
        flexDirection: 'row',
        alignItems: 'flex-start',
    },
    modeIconWrap: {
        width: 44,
        height: 44,
        borderRadius: 12,
        backgroundColor: palette.grayAlt100,
        alignItems: 'center',
        justifyContent: 'center',
    },
    modeTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 4,
    },
    modeTitle: {
        fontSize: 16,
        fontWeight: '800',
    },
    timeBadge: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 8,
    },
    timeBadgeText: {
        fontSize: 11,
        fontWeight: '700',
    },
    modeDesc: {
        fontSize: 13,
        lineHeight: 18,
    },
    privacyBox: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        padding: 14,
        borderRadius: 12,
        borderWidth: 1,
        marginTop: 8,
        width: '100%',
    },
    privacyText: {
        flex: 1,
        fontSize: 12,
        lineHeight: 17,
    },

    // Quiz Screen
    quizWrapper: {
        flex: 1,
    },
    progressContainer: {
        paddingHorizontal: 20,
        paddingTop: 16,
        paddingBottom: 8,
    },
    progressTrack: {
        height: 6,
        backgroundColor: palette.gray200,
        borderRadius: 3,
        overflow: 'hidden',
        marginBottom: 6,
    },
    progressFill: {
        height: '100%',
        borderRadius: 3,
    },
    progressText: {
        fontSize: 12,
        fontWeight: '600',
        textAlign: 'right',
    },
    quizScroll: {
        padding: 20,
        paddingBottom: 40,
    },
    questionCard: {
        padding: 20,
        borderRadius: 16,
        borderWidth: 1,
        marginBottom: 20,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.03,
        shadowRadius: 4,
        elevation: 1,
    },
    questionPrompt: {
        fontSize: 17,
        fontWeight: '800',
        lineHeight: 24,
    },
    optionsList: {
        gap: 12,
    },
    optionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 16,
        borderRadius: 14,
        borderWidth: 1.5,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.02,
        shadowRadius: 2,
        elevation: 1,
    },
    optionEmoji: {
        fontSize: 22,
        marginRight: 12,
    },
    optionText: {
        flex: 1,
        fontSize: 14,
        lineHeight: 20,
    },

    // Result Screen
    resultScroll: {
        padding: 20,
        paddingBottom: 48,
    },
    resultHeroCard: {
        alignItems: 'center',
        padding: 24,
        borderRadius: 20,
        borderWidth: 1,
        marginBottom: 16,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.05,
        shadowRadius: 6,
        elevation: 2,
    },
    resultEmoji: {
        fontSize: 52,
        marginBottom: 10,
    },
    resultArchetypeName: {
        fontSize: 24,
        fontWeight: '900',
        marginBottom: 4,
    },
    resultTagline: {
        fontSize: 14,
        fontWeight: '700',
        marginBottom: 12,
    },
    resultDesc: {
        fontSize: 14,
        lineHeight: 21,
        textAlign: 'center',
        marginBottom: 16,
    },
    secondaryPill: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 12,
        borderWidth: 1,
    },
    secondaryText: {
        fontSize: 12,
        fontWeight: '600',
    },
    sectionCard: {
        padding: 18,
        borderRadius: 16,
        borderWidth: 1,
        marginBottom: 16,
    },
    sectionTitle: {
        fontSize: 15,
        fontWeight: '800',
        marginBottom: 12,
    },
    sectionSubtitle: {
        fontSize: 13,
        lineHeight: 18,
        marginBottom: 12,
    },
    bulletRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginBottom: 8,
    },
    bulletPoint: {
        fontSize: 18,
        lineHeight: 20,
        marginRight: 8,
    },
    bulletText: {
        flex: 1,
        fontSize: 13,
        lineHeight: 19,
    },
    partnerTagsRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    partnerTag: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 12,
        borderWidth: 1,
    },
    partnerEmoji: {
        fontSize: 16,
        marginRight: 6,
    },
    partnerName: {
        fontSize: 13,
        fontWeight: '700',
    },
    actionButtonsWrap: {
        marginTop: 8,
        gap: 12,
    },
    saveBtn: {
        paddingVertical: 16,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 3,
    },
    saveBtnText: {
        fontSize: 16,
        fontWeight: '800',
    },
    secondaryActionBtn: {
        paddingVertical: 10,
        alignItems: 'center',
    },
    secondaryActionText: {
        fontSize: 14,
        fontWeight: '700',
    },
});
