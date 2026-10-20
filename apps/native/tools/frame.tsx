/**
 * What every tool gets for free, drawn by the host around the tool's screen (scratch/tools/DESIGN-tool-template-fable.md
 * §1.5, slice T0.2), so a tool never writes them:
 *
 * - The frame ({@link ToolFrame}): a header with ← Back ({@link toolBack}), the tool's emoji and name, its row's state line
 *   under them, and a "…" menu (Settings · About this tool · Remove my data from this phone); the backup line at the foot.
 * - The empty state with two doors ({@link ToolDoors}): "I already do this" (straight to the tool's own screen, where its
 *   Add is) and "I'm starting out" (its three examples and its guide page). The tool's Home card, when it has one, is
 *   offered here once, and never added by itself (Marty, 20 Oct).
 * - The backup line and the Settings sheet ({@link ToolSettingsSheet}): where the document is kept, the toggle "Keep a
 *   private copy on your community's server" (on by default; the copy itself is slice T0.4, and until then the line says
 *   plainly that it stays on this phone), the tool's reminders, and Remove my data.
 * - Home's body for a tool's card ({@link ToolHomeBody}) and the page for a tool or screen this build doesn't have
 *   ({@link ToolNotInThisVersion}): never a crash.
 *
 * Colours from the central tokens only; every sentence through t(); 48 dp targets; one column at 320 dp.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, Modal, ScrollView, Switch, StyleSheet, Linking, Platform } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t, type ToolLine, type ToolManifest } from '@beanpool/core';
import type { AppColors } from '../constants/colors';
import { HOME_TARGET_DP, HomeLink, HomeRow, homeStyles } from '../components/home/HomeParts';
import { editHomeStyles } from '../components/home/EditHomeSheet';
import { STORE_URLS } from '../utils/force-update';
import { NODE_COPY_BUILT, reminderOn, readToolDoc, type ToolSettings } from './store';
import type { PhoneTool } from './index';

/** The row's state line, the Home card's lines: a manifest's function on the document, never a throw. */
export function safeLine(f: () => ToolLine | null): ToolLine | null {
    try {
        return f();
    } catch {
        return null;
    }
}

/** The Home card's lines (at most two), never a throw. */
export function homeLines(manifest: ToolManifest, doc: unknown, now: number): ToolLine[] {
    try {
        const lines = manifest.homeCard?.lines(doc, now);
        return Array.isArray(lines) ? lines.slice(0, 2) : [];
    } catch {
        return [];
    }
}

/** A document is empty when it reads as the tool's empty one (compared as JSON, so key order never matters). */
export function isEmptyDoc(manifest: ToolManifest, doc: unknown): boolean {
    const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
        : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v;
    try {
        return JSON.stringify(sorted(doc)) === JSON.stringify(sorted(manifest.doc.empty()));
    } catch {
        return false;
    }
}

/** Where a tool's document is kept, in one sentence (once per tool, at the foot of its frame). */
export function backupLine(settings: ToolSettings): string {
    if (NODE_COPY_BUILT && settings.nodeCopy !== false) {
        return t("Kept on this phone, with a private copy on your community's server that only you can read through the app. Like everything on that server, its operator could.");
    }
    return t('Kept on this phone only. Nothing in it leaves this phone.');
}

/**
 * ← Back: the stack's, or Home when the tool is the first screen there is (a link or a reminder's tap that started the
 * app), where the stack's would do nothing.
 */
export function toolBack() {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
}

// ── The frame ────────────────────────────────────────────────────────────────────────────────────────────────────

export function ToolFrame({ manifest, state, settings, colors, onSettings, onAbout, onRemove, children }: {
    manifest: ToolManifest;
    /** The row's state line now, or null. */
    state: string | null;
    settings: ToolSettings;
    colors: AppColors;
    onSettings: () => void;
    onAbout: () => void;
    onRemove: () => void;
    children: React.ReactNode;
}) {
    const insets = useSafeAreaInsets();
    const [menu, setMenu] = useState(false);
    const name = t(manifest.name);
    const pick = (f: () => void) => () => { setMenu(false); f(); };
    return (
        <View style={[frame.page, { backgroundColor: colors.surface.page, paddingTop: insets.top }]} testID="tool-frame">
            <View style={[frame.header, { backgroundColor: colors.surface.card, borderBottomColor: colors.border.default }]}>
                <Pressable onPress={toolBack} style={frame.headerButton} accessibilityRole="button" accessibilityLabel={t('Back')} testID="tool-back">
                    <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text.heading} />
                </Pressable>
                <Text style={frame.icon} accessibilityElementsHidden importantForAccessibility="no">{manifest.icon}</Text>
                <View style={frame.headerText}>
                    <Text style={[frame.title, { color: colors.text.heading }]} accessibilityRole="header" numberOfLines={2}>{name}</Text>
                    {state ? <Text style={[frame.state, { color: colors.text.secondary }]} numberOfLines={1} testID="tool-state">{state}</Text> : null}
                </View>
                <Pressable onPress={() => setMenu(true)} style={frame.headerButton} accessibilityRole="button"
                    accessibilityLabel={t('Options for {tool}', { tool: name })} testID="tool-menu">
                    <MaterialCommunityIcons name="dots-horizontal" size={24} color={colors.text.secondary} />
                </Pressable>
            </View>
            <View style={frame.body}>{children}</View>
            <Text style={[frame.backup, { color: colors.text.secondary, paddingBottom: 8 + insets.bottom }]} testID="tool-backup-line">{backupLine(settings)}</Text>
            <Modal visible={menu} transparent animationType="fade" onRequestClose={() => setMenu(false)} statusBarTranslucent>
                <View style={editHomeStyles.backdrop}>
                    {/* The dimmed space above the sheet closes it, as a tap outside does. */}
                    <Pressable style={frame.dismiss} onPress={() => setMenu(false)} accessibilityRole="button" accessibilityLabel={t('Close')} testID="tool-menu-close" />
                    <View style={[editHomeStyles.sheet, { backgroundColor: colors.surface.card, paddingBottom: 12 + insets.bottom }]} testID="tool-menu-sheet">
                        <MenuRow text={t('Settings')} icon="cog-outline" colors={colors} onPress={pick(onSettings)} testID="tool-menu-settings" />
                        <MenuRow text={t('About this tool')} icon="information-outline" colors={colors} onPress={pick(onAbout)} testID="tool-menu-about" />
                        <MenuRow text={t('Remove my data from this phone')} icon="delete-outline" colors={colors} danger onPress={pick(onRemove)} testID="tool-menu-remove" />
                    </View>
                </View>
            </Modal>
        </View>
    );
}

function MenuRow({ text, icon, colors, danger, onPress, testID }: {
    text: string; icon: React.ComponentProps<typeof MaterialCommunityIcons>['name']; colors: AppColors; danger?: boolean; onPress: () => void; testID?: string;
}) {
    const fg = danger ? colors.feedback.danger.fg : colors.text.body;
    return (
        <Pressable onPress={onPress} style={({ pressed }) => [frame.menuRow, pressed && { backgroundColor: colors.surface.subtle }]} accessibilityRole="button" accessibilityLabel={text} testID={testID}>
            <MaterialCommunityIcons name={icon} size={22} color={fg} />
            <Text style={[frame.menuText, { color: fg }]}>{text}</Text>
        </Pressable>
    );
}

// ── The two doors ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The empty state (round 2 §3.1). Before a door is taken: both doors. After "I'm starting out", while the document is
 * still empty: the three examples and the guide page, above the tool's own screen. The Home card's offer sits under the
 * doors once, for a tool that has a card, until the member answers it. It scrolls: at 320 dp with large text the doors and
 * the offer can be taller than the screen, and above the tool's own screen it takes at most half of the frame.
 */
export function ToolDoors({ manifest, settings, colors, onDoor, onHomeAnswer }: {
    manifest: ToolManifest;
    settings: ToolSettings;
    colors: AppColors;
    onDoor: (door: 'doing' | 'starting') => void;
    /** The Home card offer answered: true to add it (Home adds it), false for no. */
    onHomeAnswer: (add: boolean) => void;
}) {
    const s = homeStyles(colors);
    const offerHome = !!manifest.homeCard && !settings.homeOffered;
    return (
        <ScrollView style={settings.door ? frame.doorsAbove : frame.doors} keyboardShouldPersistTaps="handled" testID="tool-doors">
            {!settings.door ? (
                <View style={s.card}>
                    <HomeRow text={t('I already do this')} sub={t('Go straight in and add what you keep.')} a11y={t('I already do this: go straight in and add what you keep.')} strong colors={colors}
                        onPress={() => onDoor('doing')} testID="tool-door-doing" />
                    <HomeRow text={t("I'm starting out")} sub={t('A few examples to start from, and a guide.')} a11y={t("I'm starting out: a few examples to start from, and a guide.")} strong colors={colors}
                        onPress={() => onDoor('starting')} testID="tool-door-starting" />
                </View>
            ) : null}
            {settings.door === 'starting' ? (
                <View style={s.card} testID="tool-examples">
                    <View style={s.captionRow}>
                        <Text style={s.caption} accessibilityRole="header" numberOfLines={2}>{t('Some examples')}</Text>
                    </View>
                    {manifest.examples.map((_, i) => (
                        <HomeRow key={i} text={t(manifest.examples[i])} a11y={t(manifest.examples[i])} colors={colors} lines={1} />
                    ))}
                    {manifest.guide ? (
                        <HomeLink id="tool-guide" text={t('Read the guide')} a11y={t('Read the guide')} colors={colors} testID="tool-guide"
                            onPress={() => router.push({ pathname: '/guide/[slug]', params: { slug: manifest.guide as string } })} />
                    ) : null}
                </View>
            ) : null}
            {offerHome ? (
                <View style={s.card} testID="tool-home-offer">
                    <Text style={[s.rowLine, { paddingTop: 10 }]}>{t('Put this tool on your Home? It shows what it keeps at a glance.')}</Text>
                    <View style={s.buttonRow}>
                        <Pressable onPress={() => onHomeAnswer(true)} style={[s.button, s.buttonPrimary]} accessibilityRole="button" accessibilityLabel={t('Add to Home')} testID="tool-home-add">
                            <Text style={[s.buttonText, s.buttonTextPrimary]}>{t('Add to Home')}</Text>
                        </Pressable>
                        <Pressable onPress={() => onHomeAnswer(false)} style={s.button} accessibilityRole="button" accessibilityLabel={t('No thanks')} testID="tool-home-no">
                            <Text style={s.buttonText}>{t('No thanks')}</Text>
                        </Pressable>
                    </View>
                </View>
            ) : null}
        </ScrollView>
    );
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────────────────────

export function ToolSettingsSheet({ visible, manifest, settings, notificationsAllowed, colors, onChange, onAllowNotifications, onRemove, onClose }: {
    visible: boolean;
    manifest: ToolManifest;
    settings: ToolSettings;
    /** Null while unknown; false shows the line and the button that asks. */
    notificationsAllowed: boolean | null;
    colors: AppColors;
    onChange: (next: ToolSettings) => void;
    onAllowNotifications: () => void;
    onRemove: () => void;
    onClose: () => void;
}) {
    const insets = useSafeAreaInsets();
    const reminders = manifest.permissions.includes('reminders') ? manifest.reminders?.list ?? [] : [];
    const nodeCopy = settings.nodeCopy !== false;
    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose} statusBarTranslucent>
            <View style={editHomeStyles.backdrop}>
                <View style={[editHomeStyles.sheet, { backgroundColor: colors.surface.card, paddingBottom: 12 + insets.bottom, marginTop: insets.top + 24 }]} testID="tool-settings-sheet">
                    <View style={editHomeStyles.head}>
                        <Text style={[editHomeStyles.title, { color: colors.text.heading }]} accessibilityRole="header" numberOfLines={2}>{t('Settings')}</Text>
                        <Pressable onPress={onClose} style={editHomeStyles.done} accessibilityRole="button" accessibilityLabel={t('Done')} testID="tool-settings-done">
                            <Text style={[editHomeStyles.doneText, { color: colors.text.link }]}>{t('Done')}</Text>
                        </Pressable>
                    </View>
                    <ScrollView contentContainerStyle={editHomeStyles.list}>
                        <Text style={[editHomeStyles.note, { color: colors.text.secondary }]}>{backupLine(settings)}</Text>
                        <SwitchRow text={t("Keep a private copy on your community's server")} value={nodeCopy} colors={colors}
                            onChange={(on) => onChange({ ...settings, nodeCopy: on })} testID="tool-settings-node-copy" />
                        {!NODE_COPY_BUILT ? (
                            <Text style={[editHomeStyles.note, { color: colors.text.secondary }]} testID="tool-settings-node-copy-note">
                                {t("Your community's server can't keep a copy yet, so for now it stays on this phone only.")}
                            </Text>
                        ) : null}
                        {reminders.length > 0 ? (
                            <>
                                <Text style={[editHomeStyles.section, { color: colors.text.secondary }]} accessibilityRole="header">{t('Reminders')}</Text>
                                {reminders.map((r, i) => (
                                    <SwitchRow key={r.id} text={t(reminders[i].name)} value={reminderOn(settings, r)} colors={colors}
                                        onChange={(on) => onChange({ ...settings, reminders: { ...settings.reminders, [r.id]: on } })}
                                        testID={`tool-settings-reminder-${r.id}`} />
                                ))}
                                {notificationsAllowed === false ? (
                                    <View testID="tool-settings-notifications-off">
                                        <Text style={[editHomeStyles.note, { color: colors.text.secondary, marginTop: 8 }]}>
                                            {t("Notifications are off for BeanPool on this phone, so reminders can't show.")}
                                        </Text>
                                        <Pressable onPress={onAllowNotifications} style={[editHomeStyles.addRow, { backgroundColor: colors.surface.subtle }]}
                                            accessibilityRole="button" accessibilityLabel={t('Allow notifications')} testID="tool-settings-allow">
                                            <Text style={[editHomeStyles.addText, { color: colors.text.link }]}>{t('Allow notifications')}</Text>
                                        </Pressable>
                                    </View>
                                ) : null}
                            </>
                        ) : null}
                        <Pressable onPress={onRemove} style={[editHomeStyles.addRow, { backgroundColor: colors.feedback.danger.bg, marginTop: 16 }]}
                            accessibilityRole="button" accessibilityLabel={t('Remove my data from this phone')} testID="tool-settings-remove">
                            <Text style={[editHomeStyles.addText, { color: colors.feedback.danger.fg }]}>{t('Remove my data from this phone')}</Text>
                        </Pressable>
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
}

function SwitchRow({ text, value, colors, onChange, testID }: { text: string; value: boolean; colors: AppColors; onChange: (v: boolean) => void; testID?: string }) {
    return (
        <View style={[editHomeStyles.row, { borderBottomColor: colors.border.default }]}>
            <Text style={[editHomeStyles.rowText, editHomeStyles.name, { color: colors.text.body }]}>{text}</Text>
            <Switch value={value} onValueChange={onChange} accessibilityLabel={text} testID={testID}
                trackColor={{ false: colors.border.strong, true: colors.brand.fill }} thumbColor={colors.surface.card} />
        </View>
    );
}

// ── Home ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Opens a tool, at a screen of its own (its first when none is named). */
export function openTool(id: string, screen?: string) {
    router.push({ pathname: '/tool/[id]', params: screen ? { id, screen } : { id } });
}

/**
 * The body of a tool's Home card: the manifest's lines worked out on the phone from the document (asks: 'none', so the
 * node is asked nothing), each opening the tool at its screen; with none, one link into the tool.
 */
export function ToolHomeBody({ tool, owner, colors, now }: { tool: PhoneTool; owner: string; colors: AppColors; now: number }) {
    const { manifest } = tool;
    // The document is read as Home comes into view (back from the tool, too), not at every drawing; its lines are worked
    // out at each drawing, for the time now.
    const [doc, setDoc] = useState<{ value: unknown } | null>(null);
    useFocusEffect(useCallback(() => {
        let gone = false;
        readToolDoc(owner, manifest)
            .then(({ doc: value }) => { if (!gone) setDoc({ value }); })
            .catch(() => { if (!gone) setDoc({ value: manifest.doc.empty() }); });
        return () => { gone = true; };
    }, [owner, manifest]));
    const lines = doc ? homeLines(manifest, doc.value, now) : [];
    const name = t(manifest.name);
    return (
        <View testID={`tool-home-${manifest.id}`}>
            {lines.map((line, i) => (
                <HomeRow key={i} text={t(line.key, line.values)} a11y={t(line.key, line.values)} colors={colors} lines={2}
                    onPress={() => openTool(manifest.id, line.screen && manifest.screens.includes(line.screen) ? line.screen : undefined)} />
            ))}
            <HomeLink id={`tool-home-${manifest.id}-open`} text={t('Open {tool}', { tool: name })} a11y={t('Open {tool}', { tool: name })} colors={colors} onPress={() => openTool(manifest.id)} />
        </View>
    );
}

// ── A tool or a screen this build doesn't have ───────────────────────────────────────────────────────────────────

function openStore() {
    const urls = Platform.OS === 'ios' ? STORE_URLS.ios : STORE_URLS.android;
    Linking.openURL(urls.app).catch(() => { Linking.openURL(urls.web).catch(() => {}); });
}

/** A link to a tool (or a screen of one) this version doesn't have, or one it can't open yet: said, never a crash. */
export function ToolNotInThisVersion({ colors }: { colors: AppColors }) {
    const insets = useSafeAreaInsets();
    const s = homeStyles(colors);
    return (
        <View style={[frame.page, { backgroundColor: colors.surface.page, paddingTop: insets.top + 8 }]} testID="tool-not-in-version">
            <View style={[s.card, { paddingVertical: 16 }]}>
                <Text style={[frame.title, { color: colors.text.heading }]} accessibilityRole="header">{t("This tool isn't in this version of the app")}</Text>
                <Text style={[s.note, { marginTop: 8 }]}>{t('Update BeanPool to use it. Your version is shown at the foot of Settings.')}</Text>
                <View style={s.buttonRow}>
                    <Pressable onPress={openStore} style={[s.button, s.buttonPrimary]} accessibilityRole="button" accessibilityLabel={t('Update')} testID="tool-update">
                        <Text style={[s.buttonText, s.buttonTextPrimary]}>{t('Update')}</Text>
                    </Pressable>
                    <Pressable onPress={() => router.navigate('/(tabs)/settings')} style={s.button} accessibilityRole="button" accessibilityLabel={t('Settings')} testID="tool-open-settings">
                        <Text style={s.buttonText}>{t('Settings')}</Text>
                    </Pressable>
                    <Pressable onPress={toolBack} style={s.button} accessibilityRole="button" accessibilityLabel={t('Back')} testID="tool-not-in-version-back">
                        <Text style={s.buttonText}>{t('Back')}</Text>
                    </Pressable>
                </View>
            </View>
        </View>
    );
}

/** A tool's screen that throws is caught here: the frame stays, and the member is told what is safe. */
export class ToolScreenBoundary extends React.Component<{ colors: AppColors; children: React.ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() {
        return { failed: true };
    }
    componentDidCatch(e: unknown) {
        console.warn('[Tools] A tool screen failed', e instanceof Error ? e.message : e);
    }
    render() {
        if (!this.state.failed) return this.props.children;
        const s = homeStyles(this.props.colors);
        return (
            <View style={[s.card, { paddingVertical: 14 }]} testID="tool-screen-failed">
                <Text style={s.rowLine}>{t('Something went wrong in this tool. What it keeps on this phone is safe.')}</Text>
            </View>
        );
    }
}

const frame = StyleSheet.create({
    page: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: 4, borderBottomWidth: 1, gap: 4 },
    headerButton: { width: HOME_TARGET_DP, height: HOME_TARGET_DP, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    icon: { fontSize: 24, flexShrink: 0 },
    headerText: { flex: 1, minWidth: 0, paddingVertical: 6, paddingLeft: 4 },
    title: { fontSize: 18, fontWeight: '800' },
    state: { fontSize: 13, marginTop: 1 },
    body: { flex: 1 },
    doors: { flex: 1 },
    doorsAbove: { flexGrow: 0, flexShrink: 1, maxHeight: '50%' },
    backup: { fontSize: 12, lineHeight: 17, paddingHorizontal: 16, paddingTop: 8, textAlign: 'center' },
    dismiss: { flex: 1 },
    menuRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: HOME_TARGET_DP + 8, paddingHorizontal: 16 },
    menuText: { flex: 1, fontSize: 16, fontWeight: '600' },
});
