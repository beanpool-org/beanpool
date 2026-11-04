/**
 * Lights-out H2: the hall door (utils/hall.ts; scratch/fable-design/DESIGN-lights-out-plain-ip-fable.md §2.5).
 *
 * Opened by the poster's QR (`beanpool://hall?at=…&for=…`, routed by app/+native-intent.ts with only the checked fields),
 * or from Settings → "In the hall? Enter the laptop's address" with nothing filled. Nothing is asked of the laptop until
 * the member taps Join: that tap is the moment of use, so on an iPhone the Local Network question comes then, never at
 * start (NSLocalNetworkUsageDescription, app.json). Then the phone checks the laptop is its community (plain reads: its
 * statement and its signature over a fresh nonce) and only then moves to it with its copy, signing for the community's
 * name.
 */
import React, { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ErrorBoundary, router, useLocalSearchParams } from 'expo-router';
import { t } from '@beanpool/core';
import { useStyles } from './ThemeContext';
import { enterHall, hallAddressOf, hallDepsWith, hallRefusalText, parseHallLink, type HallLink } from '../utils/hall';

export { ErrorBoundary };

type Step = { kind: 'ready' } | { kind: 'checking' } | { kind: 'refused'; text: string };

/** The link's checked fields, as the router passed them (hallRouteFor), read again with the same rules. */
function linkFromParams(p: { at?: string; for?: string; id?: string }): HallLink | null {
    if (!p.at) return null;
    const q = [`at=${encodeURIComponent(p.at)}`];
    if (p.for) q.push(`for=${encodeURIComponent(p.for)}`);
    if (p.id) q.push(`id=${encodeURIComponent(p.id)}`);
    return parseHallLink(`beanpool://hall?${q.join('&')}`);
}

export default function HallScreen() {
    const params = useLocalSearchParams<{ at?: string; for?: string; id?: string }>();
    const fromLink = linkFromParams(params);
    const [typed, setTyped] = useState('');
    const [step, setStep] = useState<Step>({ kind: 'ready' });
    const s = useStyles(({ colors }) => StyleSheet.create({
        page: { flex: 1, backgroundColor: colors.surface.page },
        scroll: { padding: 16, gap: 14 },
        title: { color: colors.text.heading, fontSize: 22, fontWeight: '700' },
        body: { color: colors.text.body, fontSize: 15, lineHeight: 22 },
        quiet: { color: colors.text.secondary, fontSize: 14, lineHeight: 20 },
        address: { color: colors.text.heading, fontSize: 20, fontWeight: '700' },
        input: {
            borderWidth: 1, borderColor: colors.border.default, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
            fontSize: 17, color: colors.text.heading, backgroundColor: colors.surface.card,
        },
        button: { backgroundColor: colors.brand.fill, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
        buttonText: { color: colors.text.onBrand, fontSize: 16, fontWeight: '700' },
        refused: { color: colors.feedback.danger.fg, fontSize: 15, lineHeight: 22 },
        link: { color: colors.text.link, fontSize: 15, paddingVertical: 10 },
    }));

    const at = fromLink?.at ?? hallAddressOf(typed);

    const join = async () => {
        const link: HallLink | null = fromLink ?? (at ? { at, for: null, id: null } : null);
        if (!link) {
            setStep({ kind: 'refused', text: t("That isn't a laptop's address on this Wi-Fi. It looks like 192.168.8.1:8080.") });
            return;
        }
        setStep({ kind: 'checking' });
        try {
            const result = await enterHall(link, await hallDepsWith());
            if (result.kind === 'moved' || result.kind === 'here') {
                router.replace('/(tabs)');
                return;
            }
            setStep({ kind: 'refused', text: hallRefusalText(result, Platform.OS === 'ios') });
        } catch (e) {
            setStep({ kind: 'refused', text: e instanceof Error && e.message ? e.message : t('Nothing has changed. Try again in a little while.') });
        }
    };

    return (
        <SafeAreaView style={s.page} edges={['top', 'bottom']}>
            <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
                <Text style={s.title} accessibilityRole="header">{t('The hall laptop')}</Text>
                <Text style={s.body}>
                    {t("When the internet is down, your community can run on a laptop in the hall. Join the hall's Wi-Fi, then join the laptop here. Your phone checks it is your community first.")}
                </Text>
                {fromLink ? (
                    <>
                        <Text style={s.address} testID="hall-address">{fromLink.at.replace(/^https?:\/\//, '')}</Text>
                        {fromLink.for ? <Text style={s.quiet}>{t('For {name}', { name: fromLink.for })}</Text> : null}
                        {fromLink.id ? <Text style={s.quiet}>{t('Server key {id}', { id: fromLink.id })}</Text> : null}
                    </>
                ) : (
                    <>
                        <Text style={s.body}>{t("The laptop's address, from the poster:")}</Text>
                        <TextInput
                            testID="hall-address-input"
                            style={s.input}
                            value={typed}
                            onChangeText={(v) => { setTyped(v); if (step.kind === 'refused') setStep({ kind: 'ready' }); }}
                            placeholder="192.168.8.1:8080"
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'url'}
                            returnKeyType="go"
                            onSubmitEditing={() => { if (step.kind !== 'checking') void join(); }}
                        />
                    </>
                )}
                <Text style={s.quiet}>
                    {t('On the hall Wi-Fi, what you post and your balance can be read by others on the Wi-Fi. Your messages stay private.')}
                </Text>
                {step.kind === 'refused' ? <Text style={s.refused} testID="hall-refused">{step.text}</Text> : null}
                <Pressable
                    testID="hall-join"
                    accessibilityRole="button"
                    style={[s.button, step.kind === 'checking' || (!fromLink && !typed.trim()) ? { opacity: 0.6 } : null]}
                    disabled={step.kind === 'checking' || (!fromLink && !typed.trim())}
                    onPress={() => void join()}
                >
                    {step.kind === 'checking'
                        ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><ActivityIndicator color={s.buttonText.color} /><Text style={s.buttonText}>{t('Checking the laptop…')}</Text></View>
                        : <Text style={s.buttonText}>{t('Join the hall laptop')}</Text>}
                </Pressable>
                <Pressable accessibilityRole="button" onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))}>
                    <Text style={s.link}>{t('Not now')}</Text>
                </Pressable>
            </ScrollView>
        </SafeAreaView>
    );
}
