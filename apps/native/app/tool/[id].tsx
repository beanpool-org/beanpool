/**
 * The one host route of every tool (scratch/tools/DESIGN-tool-template-fable.md §1.3, slice T0.2): `/tool/<id>`, with
 * `screen` (default: the manifest's first) and any params the tool set (`key`, a record's id). Deep links are
 * `beanpool://tool/<id>?screen=…&key=…`. It looks the tool up in the registry (tools/index.ts phoneTool), reads its
 * document from the one store (tools/store.ts), builds its host narrowed to its permissions (tools/host.ts hostFor) and
 * draws the screen inside the frame (tools/frame.tsx), with the two doors while the document is empty.
 *
 * A tool, a screen or a permission this build doesn't have shows "This tool isn't in this version of the app" with
 * Update, never a crash; a screen that throws is caught and the frame stays. Nothing here names a tool.
 *
 * Each `navigate` pushes another of these routes, so a tool can have several screens open at once (a record over its
 * list): they share its document and its settings ({@link openScreens}), and none of them writes back what another
 * changed. The host is keyed by the screen, so "Remove my data" on a later screen goes back to the first in place.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { t, type AnyToolScreenProps, type ToolManifest, type ToolOfferDraft } from '@beanpool/core';
import { useIdentity } from '../IdentityContext';
import { useTheme } from '../ThemeContext';
import { useNodeProfile } from '../../utils/use-node-profile';
import { beansOn, getCachedNodeProfile } from '../../utils/node-profile';
import { composerNeedsProfilePhoto } from '../../utils/market-global';
import { getCanonicalAvatar } from '../../utils/canonical-profile';
import { getMemberProfile } from '../../utils/db';
import { phoneTool } from '../../tools/index';
import { hostFor, phoneHost, ungrantedPermissions, type PhoneHostContext } from '../../tools/host';
import { openOfferComposer, unfinishedPostHere, type ToolListFee } from '../../tools/doors';
import { readToolDoc, readToolSettings, reminderOn, removeToolDataHere, writeToolDoc, writeToolSettings, type ToolSettings } from '../../tools/store';
import { scheduleToolReminders } from '../../tools/reminders';
import { ToolDoors, ToolFrame, ToolNotInThisVersion, ToolScreenBoundary, ToolSettingsSheet, isEmptyDoc, safeLine } from '../../tools/frame';
import { ToolListSheet } from '../../tools/list-sheet';

/** What every open screen of one tool, for one owner, shares. */
interface SharedState { doc: unknown; stored: boolean; settings: ToolSettings }
type Hear = (next: Partial<SharedState>) => void;
/**
 * The open screens of each tool, by owner and tool: a write on one is every other's at once (§1.6: one writer, last write
 * wins). Without it the screen under a pushed one would keep the document it read, show it on the way back, and its next
 * write would put back what the pushed one had changed, or schedule a reminder its Settings had turned off.
 */
const openScreens = new Map<string, Set<Hear>>();
function tellOpenScreens(key: string, from: Hear, next: Partial<SharedState>) {
    for (const hear of openScreens.get(key) ?? []) if (hear !== from) hear(next);
}

/** The route's params as the tool sees them: every one but the route's own `id` and `screen`. */
function toolParams(all: Record<string, string | string[] | undefined>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(all)) if (k !== 'id' && k !== 'screen' && typeof v === 'string') out[k] = v;
    return out;
}

export default function ToolRoute() {
    const all = useLocalSearchParams<Record<string, string>>();
    const { colors } = useTheme();
    const id = typeof all.id === 'string' ? all.id : '';
    const tool = phoneTool(id);
    const screenName = typeof all.screen === 'string' && all.screen ? all.screen : tool?.manifest.screens[0] ?? '';
    const Screen = useMemo(() => {
        if (!tool || !tool.manifest.screens.includes(screenName)) return null;
        try {
            const screens = tool.app.screens();
            return Object.prototype.hasOwnProperty.call(screens, screenName) ? screens[screenName] ?? null : null;
        } catch (e) {
            console.warn('[Tools] A tool\'s screens could not load', e instanceof Error ? e.message : e);
            return null;
        }
    }, [tool, screenName]);
    if (!tool || !Screen) return <ToolNotInThisVersion colors={colors} />;
    return <ToolHostScreen key={`${id}:${screenName}`} manifest={tool.manifest} screenName={screenName} Screen={Screen} params={toolParams(all)} />;
}

function ToolHostScreen({ manifest, screenName, Screen, params }: {
    manifest: ToolManifest;
    screenName: string;
    Screen: React.ComponentType<AnyToolScreenProps>;
    params: Record<string, string>;
}) {
    const { colors } = useTheme();
    const { identity } = useIdentity();
    const nodeProfile = useNodeProfile();
    const owner = identity?.publicKey ?? '';
    const [doc, setDoc] = useState<unknown>(undefined);
    const [stored, setStored] = useState(false);
    const [settings, setSettings] = useState<ToolSettings | null>(null);
    const [url, setUrl] = useState<string | null>(null);
    const [listDraft, setListDraft] = useState<ToolOfferDraft | null>(null);
    const [listChecks, setListChecks] = useState({ photo: false, unfinished: false });
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [notificationsAllowed, setNotificationsAllowed] = useState<boolean | null>(null);
    const docRef = useRef<unknown>(undefined);
    const settingsRef = useRef<ToolSettings>({});
    const shareKey = `${owner}\n${manifest.id}`;
    // What another open screen of this tool wrote (only state setters and refs: the same for every drawing).
    const hear = useRef<Hear>((next) => {
        if ('doc' in next) { docRef.current = next.doc; setDoc(next.doc); }
        if (next.stored !== undefined) setStored(next.stored);
        if (next.settings) { settingsRef.current = next.settings; setSettings(next.settings); }
    }).current;
    useEffect(() => {
        let open = openScreens.get(shareKey);
        if (!open) openScreens.set(shareKey, open = new Set());
        open.add(hear);
        return () => {
            open.delete(hear);
            if (open.size === 0) openScreens.delete(shareKey);
        };
    }, [shareKey, hear]);

    const reschedule = useCallback((d: unknown, s: ToolSettings) => {
        const list = manifest.reminders?.list ?? [];
        void scheduleToolReminders(manifest, d, (rid) => { const r = list.find((x) => x.id === rid); return !!r && reminderOn(s, r); });
    }, [manifest]);

    useEffect(() => {
        if (!owner) return;
        let gone = false;
        (async () => {
            const [read, s, u] = await Promise.all([
                readToolDoc(owner, manifest).catch(() => ({ doc: manifest.doc.empty(), stored: false })),
                readToolSettings(owner, manifest.id),
                AsyncStorage.getItem('beanpool_anchor_url').catch(() => null),
            ]);
            if (gone) return;
            docRef.current = read.doc;
            settingsRef.current = s;
            setDoc(read.doc);
            setStored(read.stored);
            setSettings(s);
            setUrl(u);
            // Whenever the tool opens: what due() says now, after a restart, a change of language or of the clock.
            reschedule(read.doc, s);
        })();
        return () => { gone = true; };
    }, [owner, manifest, reschedule]);

    const saveSettings = useCallback(async (next: ToolSettings) => {
        settingsRef.current = next;
        setSettings(next);
        tellOpenScreens(shareKey, hear, { settings: next });
        await writeToolSettings(owner, manifest.id, next).catch(() => {});
        reschedule(docRef.current, next);
    }, [owner, manifest.id, reschedule, shareKey, hear]);

    const openListSheet = useCallback((draft: ToolOfferDraft) => {
        void (async () => {
            const features = nodeProfile?.features ?? null;
            const needs = await composerNeedsProfilePhoto(features, async () => getCachedNodeProfile(await AsyncStorage.getItem('beanpool_anchor_url')));
            let hasPhoto = false;
            if (needs && owner) {
                hasPhoto = !!(await getMemberProfile(owner).catch(() => null))?.avatar_url || !!(await getCanonicalAvatar().catch(() => null));
            }
            setListChecks({ photo: needs && !hasPhoto, unfinished: await unfinishedPostHere() });
            setListDraft(draft);
        })();
    }, [nodeProfile, owner]);

    const ctx: PhoneHostContext<unknown> = useMemo(() => ({
        manifest,
        owner: { kind: 'member', publicKey: owner, name: identity?.callsign ?? '' },
        node: { url, profile: nodeProfile?.profile ?? 'local', features: (nodeProfile?.features as Record<string, unknown> | undefined) ?? null },
        doc: {
            get: () => docRef.current,
            set: async (next: unknown) => {
                await writeToolDoc(owner, manifest, next);
                docRef.current = next;
                setDoc(next);
                setStored(true);
                tellOpenScreens(shareKey, hear, { doc: next, stored: true });
                reschedule(next, settingsRef.current);
            },
        },
        navigate: (screen: string, p?: Record<string, string>) => {
            router.push({ pathname: '/tool/[id]', params: { ...(p ?? {}), id: manifest.id, screen } });
        },
        now: () => Date.now(),
        openListSheet,
    }), [manifest, owner, identity?.callsign, url, nodeProfile, reschedule, openListSheet, shareKey, hear]);

    const ungranted = useMemo(() => ungrantedPermissions(manifest, phoneHost(ctx)), [manifest, ctx]);
    const host = useMemo(() => hostFor(manifest, ctx), [manifest, ctx]);

    const remove = useCallback(() => {
        Alert.alert(t('Remove my data from this phone'), t("Everything this tool keeps on this phone goes: its list, its photos and its reminders. This can't be undone."), [
            { text: t('Cancel'), style: 'cancel' },
            {
                text: t('Remove'), style: 'destructive', onPress: () => {
                    void removeToolDataHere(owner, manifest.id).then(() => {
                        const empty = manifest.doc.empty();
                        docRef.current = empty;
                        settingsRef.current = {};
                        setDoc(empty);
                        setStored(false);
                        setSettings({});
                        setSettingsOpen(false);
                        tellOpenScreens(shareKey, hear, { doc: empty, stored: false, settings: {} });
                        // On a later screen (a record), back to the first, where the doors are: what it showed has gone.
                        if (screenName !== manifest.screens[0]) {
                            router.setParams({ screen: manifest.screens[0], ...Object.fromEntries(Object.keys(params).map((k) => [k, undefined])) });
                        }
                    }).catch((e) => console.warn('[Tools] Could not remove the tool\'s data', e instanceof Error ? e.message : e));
                },
            },
        ]);
    }, [owner, manifest, shareKey, hear, screenName, params]);

    const about = useCallback(() => {
        Alert.alert(t(manifest.name), t(manifest.line));
    }, [manifest]);

    const allowNotifications = useCallback(async () => {
        try {
            const n = require('expo-notifications');
            const { status } = await n.requestPermissionsAsync();
            setNotificationsAllowed(status === 'granted');
        } catch {
            setNotificationsAllowed(null);
        }
    }, []);
    useEffect(() => {
        if (!settingsOpen) return;
        (async () => {
            try {
                const n = require('expo-notifications');
                setNotificationsAllowed((await n.getPermissionsAsync()).status === 'granted');
            } catch {
                setNotificationsAllowed(null);
            }
        })();
    }, [settingsOpen]);

    if (ungranted.length > 0) return <ToolNotInThisVersion colors={colors} />;
    if (!owner || doc === undefined || !settings) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface.page }} testID="tool-loading">
                <ActivityIndicator size="large" color={colors.brand.primary} accessibilityLabel={t('Loading...')} />
            </View>
        );
    }

    const row = safeLine(() => manifest.row(doc, Date.now()));
    const empty = !stored || isEmptyDoc(manifest, doc);
    const onFirstScreen = screenName === manifest.screens[0];
    const showDoors = empty && onFirstScreen;
    const ScreenAny = Screen as React.ComponentType<{ host: unknown; params: Readonly<Record<string, string>> }>;

    return (
        <>
            <ToolFrame
                manifest={manifest}
                state={row ? t(row.key, row.values) : null}
                settings={settings}
                colors={colors}
                onSettings={() => setSettingsOpen(true)}
                onAbout={about}
                onRemove={remove}
            >
                {showDoors ? (
                    <ToolDoors
                        manifest={manifest}
                        settings={settings}
                        colors={colors}
                        onDoor={(door) => { void saveSettings({ ...settingsRef.current, door }); }}
                        onHomeAnswer={(add) => {
                            void saveSettings({ ...settingsRef.current, homeOffered: true });
                            // Home adds it, through its own Add (the same as its picker's), and says so.
                            if (add) router.navigate({ pathname: '/(tabs)', params: { addTool: manifest.id } });
                        }}
                    />
                ) : null}
                {!showDoors || settings.door ? (
                    <ToolScreenBoundary colors={colors}>
                        <ScreenAny host={host} params={params} />
                    </ToolScreenBoundary>
                ) : null}
            </ToolFrame>
            <ToolSettingsSheet
                visible={settingsOpen}
                manifest={manifest}
                settings={settings}
                notificationsAllowed={notificationsAllowed}
                colors={colors}
                onChange={(next) => { void saveSettings(next); }}
                onAllowNotifications={() => { void allowNotifications(); }}
                onRemove={remove}
                onClose={() => setSettingsOpen(false)}
            />
            <ToolListSheet
                draft={listDraft}
                beans={beansOn(nodeProfile?.features)}
                needsProfilePhoto={listChecks.photo}
                unfinishedPost={listChecks.unfinished}
                colors={colors}
                onClose={() => setListDraft(null)}
                onList={(fee: ToolListFee) => {
                    const draft = listDraft;
                    setListDraft(null);
                    if (draft) void openOfferComposer(owner, manifest.id, draft, fee);
                }}
            />
        </>
    );
}
