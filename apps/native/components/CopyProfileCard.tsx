/**
 * Settings → "Use this name and photo in another community" (Profile S4, scratch/fable-design/
 * DESIGN-per-community-profile-fable.md §3-§4; Marty, 28-29 Oct 2026).
 *
 * A member has one name and one picture PER COMMUNITY, and nothing moves from one to another by itself. Here the member
 * asks: this card shows the name and photo they have in the community the phone is on, they pick another community and
 * tick what to carry, and only the tap on the button keeps the copy for it (utils/profile-copy.ts). Opening the card, picking
 * a community and ticking a box change nothing. The button names exactly what goes and where; the line after it says the
 * copy WAITS for the community and goes the next time they open it, because the phone publishes to the community it is on.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { t } from '@beanpool/core';
import type { AppColors } from '../constants/colors';
import { useStyles } from '../app/ThemeContext';
import { MemberAvatar } from './MemberAvatar';
import { useCommunities } from '../utils/use-communities';
import { plainOriginOf } from '../utils/node-url';
import { isGuestNode } from '../utils/nodes';
import { queueProfileCopy, readCopySource, type CopyResult, type CopySource } from '../utils/profile-copy';

/**
 * The card's look, from the colour library's roles only (constants/colors.ts), light and dark alike. A local table the
 * whole-tree contrast check can read (e2e/button-contrast.check.ts follows `useStyles(... makeStyles(colors))`).
 */
function makeStyles(colors: AppColors) {
    return StyleSheet.create({
        body: { color: colors.text.secondary, fontSize: 14, lineHeight: 20, marginBottom: 12 },
        // The name and photo being copied: the member's own, in the community they are in.
        mine: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 },
        mineText: { flex: 1, flexShrink: 1, color: colors.text.heading, fontSize: 15, lineHeight: 20, fontWeight: '700' },
        // A tick row, as the tick beside Protect with (components/CopyCommunitiesTick.tsx): the words wrap beside a box that keeps its size.
        tick: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48 },
        tickText: { flex: 1, flexShrink: 1, fontSize: 14, lineHeight: 20, color: colors.text.body },
        tickTextOff: { flex: 1, flexShrink: 1, fontSize: 14, lineHeight: 20, color: colors.text.secondary },
        box: { width: 24, height: 24, flexShrink: 0, borderRadius: 6, borderWidth: 2, borderColor: colors.text.secondary, alignItems: 'center', justifyContent: 'center' },
        // The fill under the tick, outlined in the brand ink: the fill alone sits too close to the card in dark (3:1 for a control).
        boxOn: { backgroundColor: colors.brand.fill, borderColor: colors.brand.primary },
        boxMark: { color: colors.text.onBrand, fontSize: 14, fontWeight: '800' },
        note: { color: colors.text.secondary, fontSize: 13, lineHeight: 18, marginLeft: 34, marginBottom: 4 },
        heading: { color: colors.text.heading, fontSize: 15, fontWeight: '700', marginTop: 12, marginBottom: 8 },
        // One community a row, full width: two never share a row at 320 dp with 1.3× text.
        row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, borderColor: colors.border.strong, borderWidth: 1, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12, marginBottom: 8, backgroundColor: colors.surface.card },
        rowOn: { borderColor: colors.brand.primary, borderWidth: 2, backgroundColor: colors.surface.subtle },
        radio: { width: 22, height: 22, flexShrink: 0, borderRadius: 11, borderWidth: 2, borderColor: colors.text.secondary, alignItems: 'center', justifyContent: 'center' },
        radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.brand.primary },
        rowName: { flex: 1, flexShrink: 1, color: colors.text.heading, fontSize: 15, lineHeight: 20, fontWeight: '600' },
        rowSub: { color: colors.text.secondary, fontSize: 12, lineHeight: 17 },
        none: { color: colors.text.secondary, fontSize: 14, lineHeight: 20 },
        // Full width: the one action.
        go: { backgroundColor: colors.brand.fill, borderRadius: 12, minHeight: 48, paddingHorizontal: 14, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
        goOff: { backgroundColor: colors.surface.subtle, borderColor: colors.border.strong, borderWidth: 1 },
        goText: { color: colors.text.onBrand, fontSize: 15, fontWeight: '700', textAlign: 'center' },
        goTextOff: { color: colors.text.secondary },
        said: { color: colors.text.heading, fontSize: 14, lineHeight: 20, marginTop: 12 },
        failed: { color: colors.feedback.danger.fg, fontSize: 14, lineHeight: 20, marginTop: 12 },
    });
}

/** The words after a tap, for what it did. The three sentences say what went, in a sentence a language can order its own way. */
export function copyResultLine(result: CopyResult, what: { name: boolean; photo: boolean }, community: string): { text: string; ok: boolean } {
    switch (result) {
        case 'waits':
            return {
                ok: true,
                text: what.name && what.photo ? t('Your name and photo will go to {community} the next time you open it.', { community })
                    : what.name ? t('Your name will go to {community} the next time you open it.', { community })
                        : t('Your photo will go to {community} the next time you open it.', { community }),
            };
        case 'photo-unreadable':
            return { ok: false, text: t("The photo couldn't be read just now, so nothing was copied. Try again, or copy only the name.") };
        case 'nothing':
            return { ok: false, text: t('Nothing to copy. Tick the name or the photo.') };
        default:
            return { ok: false, text: t("Couldn't copy. Nothing was changed.") };
    }
}

export function CopyProfileCard({ publicKey }: { publicKey: string }): React.JSX.Element {
    const styles = useStyles(({ colors }) => makeStyles(colors));
    const { rows, active } = useCommunities();
    const [source, setSource] = useState<CopySource | null | undefined>(undefined);
    const [target, setTarget] = useState<string | null>(null);
    // The name and the photo start ticked: the member asked for them by opening this card. Neither moves until the button is tapped.
    const [name, setName] = useState(true);
    const [photo, setPhoto] = useState(true);
    const [busy, setBusy] = useState(false);
    const [outcome, setOutcome] = useState<{ result: CopyResult; what: { name: boolean; photo: boolean }; community: string } | null>(null);

    // Read again if the phone moves to another community (this card is for the one it is on).
    useEffect(() => {
        let live = true;
        setSource(undefined);
        readCopySource(publicKey).then((s) => { if (live) setSource(s); }).catch(() => { if (live) setSource(null); });
        return () => { live = false; };
    }, [publicKey, active]);

    // Which saved communities were visited only as a guest (utils/nodes.ts markGuestNode), read for the communities now listed.
    // The row's `status` cannot say: useCommunities gives every row 'checking' first and 'offline' the moment the health read
    // fails, before it asks about membership at all, so a guest community that is down or not yet checked looks like any other.
    // A copy kept for one would be sent on every visit, answered "Member not found", and never clear. A read that has not
    // come back for the listed communities leaves them all out; one that fails counts every one as a guest (fails closed).
    const listed = rows.map((r) => r.url).join('\n');
    const [guests, setGuests] = useState<{ listed: string; urls: Set<string> } | null>(null);
    useEffect(() => {
        let live = true;
        const urls = listed ? listed.split('\n') : [];
        Promise.all(urls.map((u) => isGuestNode(u).catch(() => true)))
            .then((marks) => { if (live) setGuests({ listed, urls: new Set(urls.filter((_, i) => marks[i])) }); })
            .catch(() => { if (live) setGuests({ listed, urls: new Set(urls) }); });
        return () => { live = false; };
    }, [listed]);
    const marksRead = guests !== null && guests.listed === listed;

    // Another community that holds the member: not the one the phone is on, and not one visited as a guest, whatever its status.
    const targets = useMemo(
        () => (marksRead
            ? rows.filter((r) => r.status !== 'guest' && !guests!.urls.has(r.url) && plainOriginOf(r.url) !== plainOriginOf(source?.from ?? active))
            : []),
        [rows, source, active, marksRead, guests],
    );
    const chosen = targets.find((r) => r.url === target) ?? null;
    const hasPhoto = !!source && source.photo !== 'none';
    const hasName = !!source?.callsign;
    const sendName = name && hasName;
    const sendPhoto = photo && hasPhoto;
    const ready = !!source && !!chosen && (sendName || sendPhoto) && !busy;

    const label = !chosen
        ? t('Pick a community to copy to')
        : !(sendName || sendPhoto)
            ? t('Tick the name or the photo')
            : sendName && sendPhoto ? t('Copy name and photo to {community}', { community: chosen.name })
                : sendName ? t('Copy name to {community}', { community: chosen.name })
                    : t('Copy photo to {community}', { community: chosen.name });

    const copy = useCallback(async () => {
        if (!source || !chosen || busy) return;
        setBusy(true);
        setOutcome(null);
        const what = { name: sendName, photo: sendPhoto };
        try {
            const { result } = await queueProfileCopy({ publicKey, source, target: chosen.url, choice: what });
            setOutcome({ result, what, community: chosen.name });
        } catch {
            setOutcome({ result: 'not-a-community', what, community: chosen.name });
        } finally {
            setBusy(false);
        }
    }, [source, chosen, busy, sendName, sendPhoto, publicKey]);

    const tick = (on: boolean, enabled: boolean, text: string, toggle: () => void, testID: string) => (
        <Pressable
            style={styles.tick}
            onPress={toggle}
            disabled={!enabled}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on && enabled, disabled: !enabled }}
            accessibilityLabel={text}
            testID={testID}
        >
            <View style={[styles.box, on && enabled && styles.boxOn]}>
                {on && enabled ? <Text style={styles.boxMark} accessibilityElementsHidden importantForAccessibility="no">✓</Text> : null}
            </View>
            <Text style={enabled ? styles.tickText : styles.tickTextOff}>{text}</Text>
        </Pressable>
    );

    if (source === undefined) {
        return <View><ActivityIndicator accessibilityLabel={t('Loading…')} /></View>;
    }
    if (source === null) {
        return <Text style={styles.none}>{t("Couldn't read your name and photo here. Go back and try again.")}</Text>;
    }

    const hereName = rows.find((r) => plainOriginOf(r.url) === plainOriginOf(source.from))?.name ?? t('this community');

    return (
        <View>
            <Text style={styles.body}>
                {t('This is your name and photo in {community}. Pick where to use them too, and what to copy. Nothing is copied until you tap the button.', { community: hereName })}
            </Text>
            <View style={styles.mine}>
                <MemberAvatar avatarUrl={source.photoValue} pubkey={publicKey} callsign={source.callsign ?? ''} size={48} />
                <Text style={styles.mineText}>{source.callsign ?? hereName}</Text>
            </View>

            {tick(sendName, hasName, hasName ? t('Name: {name}', { name: source.callsign ?? '' }) : t('No name here to copy'), () => setName((v) => !v), 'copy-profile-name')}
            {tick(sendPhoto, hasPhoto, hasPhoto ? t('Photo') : t('No photo of your own here to copy'), () => setPhoto((v) => !v), 'copy-profile-photo')}
            {!hasPhoto ? <Text style={styles.note}>{t('The ready-made picture is not a photo you chose, so it is not copied.')}</Text> : null}

            <Text style={styles.heading} accessibilityRole="header">{t('Copy to')}</Text>
            {marksRead && targets.length === 0 ? <Text style={styles.none}>{t('You have not joined another community on this phone yet.')}</Text> : null}
            {targets.map((r) => {
                const on = r.url === target;
                return (
                    <Pressable
                        key={r.url}
                        style={[styles.row, on && styles.rowOn]}
                        onPress={() => { setTarget(r.url); setOutcome(null); }}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: on, checked: on }}
                        accessibilityLabel={r.name}
                        testID={`copy-profile-to-${r.url}`}
                    >
                        <View style={styles.radio}>{on ? <View style={styles.radioDot} /> : null}</View>
                        <View style={{ flex: 1, flexShrink: 1 }}>
                            <Text style={styles.rowName}>{r.name}</Text>
                            {r.status === 'offline' ? <Text style={styles.rowSub}>{t('Not reachable right now. The copy waits until you open it.')}</Text> : null}
                        </View>
                    </Pressable>
                );
            })}

            <Pressable
                style={[styles.go, !ready && styles.goOff]}
                onPress={() => { void copy(); }}
                disabled={!ready}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityState={{ disabled: !ready, busy }}
                testID="copy-profile-go"
            >
                {busy ? <ActivityIndicator /> : <Text style={[styles.goText, !ready && styles.goTextOff]}>{label}</Text>}
            </Pressable>

            {outcome ? (
                <Text style={copyResultLine(outcome.result, outcome.what, outcome.community).ok ? styles.said : styles.failed} accessibilityLiveRegion="polite" testID="copy-profile-said">
                    {copyResultLine(outcome.result, outcome.what, outcome.community).text}
                </Text>
            ) : null}
        </View>
    );
}
