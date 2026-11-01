/**
 * A member's copy of an Offer or a Need on the global community, as the phone draws it (DESIGN-reaching-across-fable.md §1 row 4,
 * slice G1′; the node's half is apps/server engine/event-copy.ts). A billboard: its words, its photos, where it is from, its
 * price there in words, and the door. No author, no Message, no Accept, no price card: this screen draws none of them, so
 * nothing on the post page has to remember not to, and the node refuses them whatever an app sends.
 *
 * Its author reads it here too: what they can do with it is take it down. Its words are edited at home.
 */
import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copyCardLine, copyPriceLine, eventCopyOf, listingFreeTags, t } from '@beanpool/core';
import { useIdentity } from '../app/IdentityContext';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { deletePost, reportAbuse } from '../utils/db';
import { reportedAlertBody } from '../utils/reportReasons';
import { EventCopyDoor } from './EventCopyDoor';
import { PhotoCarousel } from './PhotoCarousel';
import { PostTagChips } from './PostTagChips';
import { ReportReasonBox } from './ReportReasonBox';

function photosOfRow(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw;
    try {
        const parsed = typeof raw === 'string' && raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function ListingCopyDetail({ post }: { post: any }) {
    const styles = useStyles(makeStyles);
    const insets = useSafeAreaInsets();
    const { identity } = useIdentity();
    const [reporting, setReporting] = useState(false);
    const copy = eventCopyOf(post)!;
    const own = !!identity && post.author_pubkey === identity.publicKey;
    const photos = photosOfRow(post.photos);
    const goBack = () => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)'); };

    const report = async (reason: string) => {
        if (!identity?.publicKey) return;
        try {
            const sent = await reportAbuse(identity.publicKey, post.author_pubkey, reason, post.id);
            setReporting(false);
            Alert.alert(t('Reported'), reportedAlertBody(sent?.wordsLeftOut, reason));
        } catch (e: any) {
            Alert.alert(t('Not sent'), e?.message ? String(e.message) : t('Could not reach the node.'));
            throw e; // the box keeps the choice and the words
        }
    };
    const takeDown = async () => {
        try {
            await deletePost(post.id);
            goBack();
        } catch (e: any) {
            Alert.alert(t('Error'), e?.message ? String(e.message) : t('Could not reach the node.'));
        }
    };

    return (
        <View style={[styles.screen, { paddingTop: insets.top }]} testID="listing-copy">
            <Pressable onPress={goBack} style={styles.back} accessibilityRole="button">
                <Text style={styles.backText}>{t('← Back')}</Text>
            </Pressable>
            {/* The report box's words and Send are the last things here, and under edge-to-edge the window doesn't resize for the
                keyboard: as EventDetail, drawn from the same route. No keyboardVerticalOffset: this screen draws its own header. */}
            <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
            <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
                {photos.length > 0 && <PhotoCarousel photos={photos} height={220} borderRadius={14} />}
                <Text style={styles.kind}>{post.type === 'need' ? t('NEED') : t('OFFER')}</Text>
                <Text style={styles.title}>{post.title}</Text>
                {!!copy.from && <Text style={styles.from} testID="listing-copy-from">{copyCardLine(copy.from)}</Text>}
                <Text style={styles.body}>{post.description || t('No description provided.')}</Text>
                <PostTagChips tags={post.tags} freeTags={listingFreeTags(post)} inset={0} />
                {own
                    ? (
                        <View testID="listing-copy-own">
                            <Text style={styles.body}>{t('This is your copy. Change it in your own community and it follows.')}</Text>
                            <Pressable onPress={takeDown} style={styles.quiet} accessibilityRole="button" testID="listing-copy-remove">
                                <Text style={styles.link}>{t('Stop showing')}</Text>
                            </Pressable>
                        </View>
                    )
                    : <EventCopyDoor copy={copy} line={copyPriceLine(copy)} />}
                {!own && !!identity && (
                    <>
                        <Pressable onPress={() => setReporting((r) => !r)} style={styles.quiet} accessibilityRole="button" accessibilityState={{ expanded: reporting }} testID="listing-copy-report">
                            <Text style={styles.report}>{t('🚩 Report Post')}</Text>
                        </Pressable>
                        {reporting && <ReportReasonBox onSubmit={report} onCancel={() => setReporting(false)} />}
                    </>
                )}
            </ScrollView>
            </KeyboardAvoidingView>
        </View>
    );
}

const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.surface.app },
    back: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 16 },
    backText: { fontSize: 16, fontWeight: '700', color: colors.text.body },
    scroll: { padding: 16, paddingBottom: 60 },
    kind: { fontSize: 12, fontWeight: '800', letterSpacing: 1, color: colors.text.secondary, marginTop: 14 },
    title: { fontSize: 22, fontWeight: '800', color: colors.text.heading, marginTop: 4 },
    from: { fontSize: 14, fontWeight: '700', color: colors.text.body, marginTop: 6, lineHeight: 20 },
    body: { fontSize: 15, color: colors.text.body, lineHeight: 22, marginVertical: 12 },
    quiet: { minHeight: 44, justifyContent: 'center' },
    link: { fontSize: 14, fontWeight: '700', color: colors.text.link },
    report: { fontSize: 13, fontWeight: '700', color: colors.feedback.danger.fg },
});
