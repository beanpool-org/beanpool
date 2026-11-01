/**
 * The one host route of every tool (scratch/tools/DESIGN-tool-template-fable.md §1.3, slice T0.2): `/tool/<id>`, with
 * `toolScreen` (default: the manifest's first; never `screen` from inside the app, tools/route-params.ts says why) and any
 * params the tool set (`key`, a record's id). Deep links are `beanpool://tool/<id>?screen=…&key=…`, and either name opens
 * the screen. It looks the tool up in the registry (tools/index.ts phoneTool), reads its
 * document from the one store (tools/store.ts), builds its host narrowed to its permissions (tools/builder.ts hostFor) and
 * draws the screen inside the frame (tools/frame.tsx), with the two doors while the document is empty.
 *
 * A tool, a screen or a permission this build doesn't have shows "This tool isn't in this version of the app" with
 * Update, never a crash; a screen that throws is caught and the frame stays. Nothing here names a tool.
 *
 * Each `navigate` pushes another of these routes, so a tool can have several screens open at once (a record over its
 * list): they share its document and its settings ({@link openScreens}), and none of them writes back what another
 * changed. The host is keyed by the screen, so "Remove my data" on a later screen goes back to the first in place.
 *
 * For a tool that asks for `node-copy` (slice T0.4, tools/node-copy.ts): its first screen's open reconciles the phone's
 * copy with the server's, a write is followed five seconds later by one sync, the toggle is a round trip the setting
 * waits for, and Remove my data takes the server's copy first, or nothing at all.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { t, toolLineText, type AnyToolScreenProps, type ToolCopyOutcome, type ToolManifest, type ToolOfferDraft } from '@beanpool/core';
import { useIdentity } from '../IdentityContext';
import { useTheme } from '../ThemeContext';
import { useNodeProfile } from '../../utils/use-node-profile';
import { beansOn, getCachedNodeProfile } from '../../utils/node-profile';
import { composerNeedsProfilePhoto } from '../../utils/market-global';
import { getMemberProfile } from '../../utils/db';
import { phoneTool } from '../../tools/index';
import { hostFor, phoneHost, ungrantedPermissions, type PhoneHostContext } from '../../tools/builder';
import { openOfferComposer, unfinishedPostHere, type ToolListFee } from '../../tools/doors';
import {
    patchToolSettings, readToolDoc, readToolSettings, reminderOn, removeToolDataHere, toolDocMaxHere, writeToolDoc, writeToolSettings, communityKey,
    type ToolSettings,
} from '../../tools/store';
import { keepsNodeCopy, openToolCopy, removeToolCopyFirst, switchToolCopy, toolCopyAfterWrite, type PhoneToolCopy } from '../../tools/node-copy';
import { scheduleToolReminders } from '../../tools/reminders';
import {
    ToolDoors, ToolFrame, ToolNotInThisVersion, ToolScreenBoundary, ToolSettingsSheet, copyFailedLine, copyTooBigLine, isEmptyDoc, removeQuestion, safeLine,
    toolBack, type ToolCopyNote,
} from '../../tools/frame';
import { ToolListSheet } from '../../tools/list-sheet';
import { TOOL_SCREEN_PARAM, toolHref, toolParams, toolScreenOf } from '../../tools/route-params';
import { shopToggleState, type ShopToggleState } from '../../components/shop/ShopToggle';
import { SHOP_TOGGLE_READ_MS, readMyShop } from '../../utils/shop';

/** What every open screen of one tool, for one owner, shares. */
interface SharedState { doc: unknown; stored: boolean; settings: ToolSettings; copyNote: ToolCopyNote }
type Hear = (next: Partial<SharedState>) => void;
/**
 * The open screens of each tool, by owner and tool: a write on one is every other's at once (§1.6: one writer, last write
 * wins). Without it the screen under a pushed one would keep the document it read, show it on the way back, and its next
 * write would put back what the pushed one had changed, or schedule a reminder its Settings had turned off.
 */
const openScreens = new Map<string, Set<Hear>>();
function tellOpenScreens(key: string, from: Hear | null, next: Partial<SharedState>) {
    for (const hear of [...(openScreens.get(key) ?? [])]) if (hear !== from) hear(next);
}

export default function ToolRoute() {
    const all = useLocalSearchParams<Record<string, string>>();
    const { colors } = useTheme();
    const id = typeof all.id === 'string' ? all.id : '';
    const tool = phoneTool(id);
    const screenName = toolScreenOf(all) || (tool?.manifest.screens[0] ?? '');
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
    const [listChecks, setListChecks] = useState<{ photo: boolean; unfinished: boolean; shop: ShopToggleState }>({ photo: false, unfinished: false, shop: { kind: 'hidden' } });
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [notificationsAllowed, setNotificationsAllowed] = useState<boolean | null>(null);
    const [copyNote, setCopyNote] = useState<ToolCopyNote>(null);
    /** The toggle's round trip; a `too-big` one keeps the server's `max` it heard, for its line (copyTooBigLine). */
    const [copyRound, setCopyRound] = useState<{ busy: boolean; failed: 'failed' | 'older-node' | 'too-big' | null; max?: number }>({ busy: false, failed: null });
    const docRef = useRef<unknown>(undefined);
    const settingsRef = useRef<ToolSettings>({});
    const copyNoteRef = useRef<ToolCopyNote>(null);
    /** Whether this is the tool's first open screen (the one whose open reconciles with the server), and whether it has. */
    const firstOfTool = useRef(false);
    const reconciled = useRef(false);
    const shareKey = `${owner}\n${manifest.id}`;
    // What another open screen of this tool wrote, or the node copy brought (only state setters and refs: the same for
    // every drawing).
    const hear = useRef<Hear>((next) => {
        if ('doc' in next) { docRef.current = next.doc; setDoc(next.doc); }
        if (next.stored !== undefined) setStored(next.stored);
        if (next.settings) { settingsRef.current = next.settings; setSettings(next.settings); }
        if (next.copyNote !== undefined) { copyNoteRef.current = next.copyNote; setCopyNote(next.copyNote); }
    }).current;
    useEffect(() => {
        let open = openScreens.get(shareKey);
        if (!open) openScreens.set(shareKey, open = new Set());
        firstOfTool.current = open.size === 0;
        open.add(hear);
        return () => {
            open.delete(hear);
            if (open.size === 0) openScreens.delete(shareKey);
        };
    }, [shareKey, hear]);

    const reschedule = useCallback((d: unknown, s: ToolSettings, u?: string | null) => {
        const list = manifest.reminders?.list ?? [];
        const c = communityKey(u !== undefined ? u : url);
        void scheduleToolReminders(
            manifest, d, (rid) => { const r = list.find((x) => x.id === rid); return !!r && reminderOn(s, r); },
            Date.now(), undefined, undefined, c,
        );
    }, [manifest, url]);

    useEffect(() => {
        if (!owner) return;
        let gone = false;
        (async () => {
            const u = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
            const [read, s] = await Promise.all([
                readToolDoc(owner, manifest).catch(() => ({ doc: manifest.doc.empty(), stored: false })),
                readToolSettings(owner, manifest.id, u),
            ]);
            if (gone) return;
            docRef.current = read.doc;
            settingsRef.current = s;
            setDoc(read.doc);
            setStored(read.stored);
            setSettings(s);
            setUrl(u);
            // Whenever the tool opens: what due() says now, after a restart, a change of language or of the clock.
            reschedule(read.doc, s, u);
        })();
        return () => { gone = true; };
    }, [owner, manifest, reschedule]);

    const saveSettings = useCallback(async (next: ToolSettings) => {
        settingsRef.current = next;
        setSettings(next);
        tellOpenScreens(shareKey, hear, { settings: next });
        // Everything but the node copy's setting and the server's bound, which only the server's answers move
        // (tools/node-copy.ts).
        const rest: ToolSettings = { ...next };
        delete rest.nodeCopy;
        delete rest.nodeMax;
        await patchToolSettings(owner, manifest.id, rest, url).catch(() => {});
        reschedule(docRef.current, next);
    }, [owner, manifest.id, reschedule, shareKey, hear, url]);

    const copy: PhoneToolCopy = useMemo(() => ({ manifest, owner: { kind: 'member', publicKey: owner }, url }), [manifest, owner, url]);

    /**
     * The most the server said it keeps of the document, as the node copy kept it beside the setting, told to every open
     * screen when it is new: the store's bound, and the screens' room, are counted against it.
     */
    const heardMax = useCallback(() => {
        void readToolSettings(owner, manifest.id, url).then((s) => {
            if (s.nodeMax !== settingsRef.current.nodeMax) tellOpenScreens(shareKey, null, { settings: { ...settingsRef.current, nodeMax: s.nodeMax } });
        }).catch(() => {});
    }, [owner, manifest.id, url, shareKey]);
    /**
     * What a sync with the server did, told to every open screen of the tool (none open: the store already has it): the
     * server's copy taken (the document drawn again, its reminders from it), the copy switched off elsewhere (the
     * setting off and the line once), or a server that keeps no copies yet. And, whatever it did, its bound (heardMax).
     */
    const heardCopy = useCallback((outcome: ToolCopyOutcome) => {
        heardMax();
        if (outcome === 'taken') {
            void readToolDoc(owner, manifest).then((read) => {
                tellOpenScreens(shareKey, null, { doc: read.doc, stored: read.stored });
                reschedule(read.doc, settingsRef.current);
            }).catch(() => {});
        } else if (outcome === 'switched-off') {
            tellOpenScreens(shareKey, null, { settings: { ...settingsRef.current, nodeCopy: false }, copyNote: 'removed' });
        } else if (outcome === 'older-node') {
            tellOpenScreens(shareKey, null, { copyNote: 'older-node' });
        }
    }, [owner, manifest, shareKey, reschedule, heardMax]);

    // The tool's open: once, from its first screen, after the phone's copy and settings are read.
    useEffect(() => {
        if (!owner || settings === null || reconciled.current) return;
        reconciled.current = true;
        if (!keepsNodeCopy(manifest) || !firstOfTool.current) return;
        void openToolCopy(copy).then(heardCopy).catch(() => {});
    }, [owner, settings, manifest, copy, heardCopy]);

    /** The toggle: the setting follows the server's answer; with none, the switch stays and its line says why. */
    const switchCopy = useCallback(async (on: boolean) => {
        setCopyRound({ busy: true, failed: null });
        const done = await switchToolCopy(copy, on).catch(() => 'failed' as const);
        // Its answers say the server's bound too, whether or not it switched.
        heardMax();
        if (done === 'on' || done === 'off') {
            setCopyRound({ busy: false, failed: null });
            tellOpenScreens(shareKey, null, { settings: { ...settingsRef.current, nodeCopy: done === 'on' }, copyNote: null });
            // Switching on may have taken the server's copy: the document as the phone holds it now.
            if (done === 'on') heardCopy('taken');
        } else if (done === 'too-big') {
            // More than the server keeps: its line counts what to delete against the `max` its GET just said.
            const s = await readToolSettings(owner, manifest.id, url).catch(() => null);
            setCopyRound({ busy: false, failed: done, max: s?.nodeMax });
        } else {
            setCopyRound({ busy: false, failed: done });
        }
    }, [copy, shareKey, heardCopy, heardMax, owner, manifest.id, url]);

    const openListSheet = useCallback((draft: ToolOfferDraft) => {
        void (async () => {
            // "Put this in your shop": the member's shop as the node has it now (none yet, open, closed for now), or nothing
            // once it has taken SHOP_TOGGLE_READ_MS: the sheet waits for it with nothing shown. Asked first, beside the rest.
            const shopRead = readMyShop({ timeoutMs: SHOP_TOGGLE_READ_MS }).catch(() => null);
            const features = nodeProfile?.features ?? null;
            const needs = await composerNeedsProfilePhoto(features, async () => getCachedNodeProfile(await AsyncStorage.getItem('beanpool_anchor_url')));
            let hasPhoto = false;
            if (needs && owner) {
                // This community's own row only: a photo chosen in another community does not open the gate here.
                hasPhoto = !!(await getMemberProfile(owner).catch(() => null))?.avatar_url;
            }
            const shop = shopToggleState(await shopRead);
            setListChecks({ photo: needs && !hasPhoto, unfinished: await unfinishedPostHere(), shop });
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
                if (copyNoteRef.current !== 'older-node') toolCopyAfterWrite(copy, heardCopy);
            },
            maxBytes: () => toolDocMaxHere(manifest, settingsRef.current),
        },
        navigate: (screen: string, p?: Record<string, string>) => {
            router.push(toolHref(manifest.id, screen, p));
        },
        back: toolBack,
        now: () => Date.now(),
        openListSheet,
        nodeCopy: keepsNodeCopy(manifest) && settings?.nodeCopy !== false && copyNote !== 'older-node',
    }), [manifest, owner, identity?.callsign, url, nodeProfile, reschedule, openListSheet, shareKey, hear, copy, heardCopy, settings?.nodeCopy, settings?.nodeMax, copyNote]);

    const ungranted = useMemo(() => ungrantedPermissions(manifest, phoneHost(ctx)), [manifest, ctx]);
    const host = useMemo(() => hostFor(manifest, ctx), [manifest, ctx]);

    const remove = useCallback(() => {
        Alert.alert(t('Remove my data from this phone'), removeQuestion(manifest, settingsRef.current), [
            { text: t('Cancel'), style: 'cancel' },
            {
                text: t('Remove'), style: 'destructive', onPress: () => {
                    void (async () => {
                        // The server's copy first: if it can't go, nothing goes, so nothing removed comes back on the next open.
                        if (!await removeToolCopyFirst(copy).catch(() => false)) {
                            Alert.alert(t('Remove my data from this phone'), copyFailedLine());
                            return;
                        }
                        await removeToolDataHere(owner, manifest.id, url);
                        // The one setting kept: the copy off, so Settings says what is true; and the server's bound,
                        // which is the server's, not the member's data.
                        const nodeMax = settingsRef.current.nodeMax;
                        const left: ToolSettings = keepsNodeCopy(manifest) ? { nodeCopy: false, ...(nodeMax !== undefined ? { nodeMax } : {}) } : {};
                        if (keepsNodeCopy(manifest)) await writeToolSettings(owner, manifest.id, left, url);
                        const empty = manifest.doc.empty();
                        docRef.current = empty;
                        settingsRef.current = left;
                        copyNoteRef.current = null;
                        setDoc(empty);
                        setStored(false);
                        setSettings(left);
                        setCopyNote(null);
                        setSettingsOpen(false);
                        tellOpenScreens(shareKey, hear, { doc: empty, stored: false, settings: left, copyNote: null });
                        // On a later screen (a record), back to the first, where the doors are: what it showed has gone.
                        // The tool's own screens come off the stack, so no second copy of the first is left to back through;
                        // opened straight at this one (a link, a reminder), there are none under it and it becomes the first.
                        if (screenName !== manifest.screens[0]) {
                            const over = (openScreens.get(shareKey)?.size ?? 1) - 1;
                            if (over > 0) router.dismiss(over);
                            else router.setParams({ [TOOL_SCREEN_PARAM]: manifest.screens[0], screen: undefined, ...Object.fromEntries(Object.keys(params).map((k) => [k, undefined])) });
                        }
                    })().catch((e) => console.warn('[Tools] Could not remove the tool\'s data', e instanceof Error ? e.message : e));
                },
            },
        ]);
    }, [owner, manifest, shareKey, hear, screenName, params, url, copy]);

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
    // A tool whose first screen works on an empty document (manifest.doors === false) opens straight on it.
    const showDoors = manifest.doors !== false && empty && onFirstScreen;
    const ScreenAny = Screen as React.ComponentType<{ host: unknown; params: Readonly<Record<string, string>> }>;

    return (
        <>
            <ToolFrame
                manifest={manifest}
                state={row ? toolLineText(row) : null}
                settings={settings}
                copyNote={copyNote}
                ownerKind={ctx.owner.kind}
                colors={colors}
                onSettings={() => { setCopyRound((r) => (r.busy ? r : { busy: false, failed: null })); setSettingsOpen(true); }}
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
                copyNote={copyNote}
                ownerKind={ctx.owner.kind}
                copy={copyRound.failed === 'too-big' ? { ...copyRound, tooBig: copyTooBigLine(manifest, doc, copyRound.max) } : copyRound}
                notificationsAllowed={notificationsAllowed}
                colors={colors}
                onChange={(next) => { void saveSettings(next); }}
                onNodeCopy={(on) => { void switchCopy(on); }}
                onAllowNotifications={() => { void allowNotifications(); }}
                onRemove={remove}
                onClose={() => setSettingsOpen(false)}
            />
            <ToolListSheet
                draft={listDraft}
                beans={beansOn(nodeProfile?.features)}
                needsProfilePhoto={listChecks.photo}
                unfinishedPost={listChecks.unfinished}
                shop={listChecks.shop}
                colors={colors}
                onClose={() => setListDraft(null)}
                onList={(fee: ToolListFee, inShop: boolean) => {
                    const draft = listDraft;
                    setListDraft(null);
                    const shop = listChecks.shop;
                    const shopCategory = shop.kind === 'open' || shop.kind === 'paused' ? shop.category ?? null : null;
                    if (draft) void openOfferComposer(owner, manifest.id, draft, fee, inShop, shopCategory);
                }}
            />
        </>
    );
}
