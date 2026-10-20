/**
 * The Tools page and a tool's page on the web (scratch/tools/DESIGN-tool-template-fable.md §1.3, §1.5, slice T0.3): one
 * covered page, drawn over the tab with the bottom nav hidden (the public profile's pattern), opened by App's openTool
 * state `{ id, screen, key }` through navigateToTab('tools') and navigateToTab('tool', '<id>?screen=…&key=…').
 *
 * - With no id: the Tools screen. Its title, the resilience sentence, and the shelves from core's `toolsOnShelf`, each
 *   row a tool's icon, name and state line. Nothing here names a tool.
 * - With an id: the frame every tool gets for free. The header (Back, the tool's icon and name, its state line, and a
 *   "…" menu: Settings · About this tool · Remove my data from this browser); while its document is empty, the two doors
 *   ("I already do this", "I'm starting out" with its examples and guide page) and, once, the offer of its Home card;
 *   then the tool's screen, loaded as its own chunk (tools/index.ts) and given the host (tools/host.ts).
 * - An id or a screen this build doesn't have: "This tool isn't in this version of the app", never a crash.
 * - For a tool that asks for `node-copy` (slice T0.4, tools/node-copy.ts): its open reconciles this browser's copy with
 *   the server's, a write is followed five seconds later by one sync, Settings has the toggle (a round trip the setting
 *   waits for), and Remove my data takes the server's copy first, or nothing at all.
 *
 * `tools` and `apps` default to the registries; a test registers a tool through them. App's state and navigateToTab's
 * context for it are tools/route.ts.
 */
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import {
    TOOLS, TOOL_SHELVES, t, toolById, toolHomeCardType, toolsOnShelf, word,
    type AnyToolScreenProps, type ToolCopyOutcome, type ToolLine, type ToolManifest, type ToolShelf, type WordKey,
} from '@beanpool/core';
import type { BeanPoolIdentity } from '../lib/identity';
import { useCommunityInfo } from '../lib/features';
import { getNodeApiUrl } from '../lib/api';
import { TOOL_APPS, type WebToolApp } from '../tools';
import { isEmptyDoc, readDoc, useToolDoc, type ComposerDraft, type WebHostContext, webHostFor } from '../tools/builder';
import { patchToolSettings, readToolRecord, readToolSettings } from '../tools/store';
import { keepsNodeCopy, openToolCopy, pageNode, removeToolCopyFirst, switchToolCopy, toolCopyAfterWrite, type WebToolCopy } from '../tools/node-copy';
import type { OpenTool } from '../tools/route';
import { ToolButton, ToolEmpty, ToolRow, ToolSection } from '../tools/ui';

type ToolLoaders = Readonly<Record<string, () => Promise<{ default: WebToolApp }>>>;

export interface ToolsPageProps {
    identity: BeanPoolIdentity;
    open: OpenTool;
    /** Opens another tool, or the Tools screen (id null). */
    onOpen: (next: OpenTool) => void;
    onClose: () => void;
    /** The composer, opened prefilled from a tool's offer or need door (App: the page that owns the composer). */
    onComposer: (draft: ComposerDraft) => void;
    /** A page of the members' guide. */
    onGuide: (slug: string) => void;
    /** A tool's Home card, put on Home (its one offer, from the empty state). */
    onAddHomeCard: (type: string) => void;
    tools?: readonly ToolManifest[];
    apps?: ToolLoaders;
    now?: () => number;
}

const SHELF_NAMES: Record<ToolShelf, WordKey> = {
    stock: word('What you have'),
    trade: word('How you deal'),
    books: word("How it's going"),
};

const lineText = (l: ToolLine | null | undefined) => (l ? t(l.key, l.values) : null);

export function ToolsPage(props: ToolsPageProps) {
    const { open, onOpen, onClose } = props;
    // Back is the stack's (§1.5): a tool opened from the Tools screen goes back to it; one opened from anywhere else (a
    // Home card, a link) closes the page, back to where the member was.
    const [fromList, setFromList] = useState(false);
    const openFromList = useCallback((next: OpenTool) => { setFromList(next.id !== null); onOpen(next); }, [onOpen]);
    const backToList = useCallback(() => { setFromList(false); onOpen({ id: null, screen: 'main', key: null }); }, [onOpen]);
    return (
        <div className="page-overlay z-[110] overflow-y-auto" data-testid="tools-page">
            {/* z-[110]: above the mobile app header (App.tsx, zIndex 100), as the public profile; the page carries its
                own Back. .page-overlay (index.css) is the fixed layer: full bleed on a phone, past the sidebar on md+. */}
            {open.id === null
                ? <ToolsList {...props} onOpen={openFromList} />
                : <ToolView key={open.id} {...props} id={open.id} onBack={fromList ? backToList : onClose} />}
        </div>
    );
}

/** The bar at the top: Back, the title (and a line under it), and what sits at the end. */
function PageBar({ onBack, title, icon, line, end }: { onBack: () => void; title: string; icon?: string; line?: string | null; end?: ReactNode }) {
    return (
        <div className="sticky top-0 z-10 bg-nature-100 dark:bg-nature-950 border-b border-nature-200 dark:border-nature-800 px-2 py-1 flex items-center gap-1 min-w-0">
            <button type="button" onClick={onBack} data-testid="tools-back"
                className="shrink-0 max-w-[40%] min-h-[48px] min-w-[48px] px-2 flex items-center gap-1 break-words text-left bg-transparent border-0 cursor-pointer font-bold text-nature-700 dark:text-nature-200 hover:text-nature-900 dark:hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand rounded-lg">
                <span aria-hidden="true">‹</span>{t('Back')}
            </button>
            <div className="flex-1 min-w-0 flex items-center gap-2">
                {icon && <span aria-hidden="true" className="shrink-0 text-2xl leading-none">{icon}</span>}
                <div className="min-w-0">
                    <h1 className="m-0 min-w-0 break-words line-clamp-2 text-base font-bold text-nature-900 dark:text-white">{title}</h1>
                    {line && <p data-testid="tool-state-line" className="m-0 min-w-0 truncate text-xs text-nature-600 dark:text-nature-300">{line}</p>}
                </div>
            </div>
            {end}
        </div>
    );
}

/** The Tools screen: every tool on each shelf for a member on this node, and each one's state line. */
function ToolsList({ identity, onOpen, onClose, tools = TOOLS, apps = TOOL_APPS, now = Date.now }: ToolsPageProps) {
    const info = useCommunityInfo();
    const facts = useMemo(() => ({ profile: info?.profile ?? null, features: (info?.features ?? {}) as Record<string, unknown> }), [info]);
    const shelves = TOOL_SHELVES
        .map((shelf) => ({ shelf, list: toolsOnShelf(shelf, null, 'member', facts, tools).filter((m) => !!apps[m.id]) }))
        .filter((s) => s.list.length > 0);
    const rows = useToolRows(shelves.flatMap((s) => s.list), identity.publicKey, now);
    return (
        <>
            <PageBar onBack={onClose} title={t('Tools')} />
            <div className="max-w-xl mx-auto px-4 py-4 min-w-0">
                <p className="m-0 mb-4 text-sm text-nature-700 dark:text-nature-200 break-words">
                    {t('Things you can do on your own, that make your community stronger.')}
                </p>
                {shelves.length === 0 && (
                    <p data-testid="tools-none" className="m-0 text-sm text-nature-600 dark:text-nature-300 break-words">
                        {t('No tools in this version of the app yet.')}
                    </p>
                )}
                {shelves.map(({ shelf, list }) => (
                    <ToolSection key={shelf} title={t(SHELF_NAMES[shelf])} testId={`tools-shelf-${shelf}`}>
                        {list.map((m) => (
                            <ToolRow key={m.id} icon={m.icon} title={t(m.name)} state={rows[m.id] ?? t(m.line)} testId={`tools-row-${m.id}`}
                                onClick={() => onOpen({ id: m.id, screen: 'main', key: null })} />
                        ))}
                    </ToolSection>
                ))}
            </div>
        </>
    );
}

/** Each listed tool's state line, from its kept document; null where it has none to say. */
function useToolRows(list: readonly ToolManifest[], owner: string, now: () => number): Record<string, string | null> {
    const [rows, setRows] = useState<Record<string, string | null>>({});
    const ids = list.map((m) => m.id).join(',');
    useEffect(() => {
        let cancelled = false;
        Promise.all(list.map(async (m) => {
            const doc = readDoc(m, (await readToolRecord(owner, m.id))?.body ?? null);
            let line: ToolLine | null;
            try { line = m.row(doc, now()); } catch { line = null; }
            return [m.id, lineText(line)] as const;
        })).then((pairs) => { if (!cancelled) setRows(Object.fromEntries(pairs)); });
        return () => { cancelled = true; };
    }, [ids, owner]);
    return rows;
}

/** This build has no such tool, or no such screen of it: said, with the way to the newest version. */
function NotInThisVersion({ onBack }: { onBack: () => void }) {
    return (
        <>
            <PageBar onBack={onBack} title={t('Tools')} />
            <ToolEmpty testId="tool-not-here" icon="🧩" title={t("This tool isn't in this version of the app")}
                line={t('Refresh the page to load the newest version your community has.')}>
                <ToolButton kind="primary" onClick={() => window.location.reload()}>{t('Refresh')}</ToolButton>
                <ToolButton onClick={onBack}>{t('Back')}</ToolButton>
            </ToolEmpty>
        </>
    );
}

type Loaded = { status: 'loading' } | { status: 'ready'; app: WebToolApp } | { status: 'failed' };

/** The tool's own chunk, fetched on first open. */
function useToolApp(id: string, loader: (() => Promise<{ default: WebToolApp }>) | undefined, attempt: number): Loaded {
    const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
    useEffect(() => {
        if (!loader) return;
        let cancelled = false;
        setLoaded({ status: 'loading' });
        loader().then((m) => { if (!cancelled) setLoaded({ status: 'ready', app: m.default }); },
            () => { if (!cancelled) setLoaded({ status: 'failed' }); });
        return () => { cancelled = true; };
    }, [id, attempt]);
    return loaded;
}

/** A tool's screen that throws is caught here: the page says so, and the document is untouched. */
class ScreenBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    render() {
        if (this.state.failed) {
            return <ToolEmpty testId="tool-failed" icon="⚠️" title={t('This screen stopped working')} line={t('What this tool keeps is safe. Go back and open it again.')} />;
        }
        return this.props.children;
    }
}

type Panel = 'tool' | 'settings' | 'about';
interface Step { screen: string; params: Record<string, string> }

function homeOfferKey(owner: string, id: string) {
    const node = getNodeApiUrl() || (typeof window !== 'undefined' ? window.location.origin : '');
    return `beanpool_tool_home_offered_${node}_${owner}_${id}`;
}
function homeOffered(owner: string, id: string): boolean {
    try { return localStorage.getItem(homeOfferKey(owner, id)) === '1'; } catch { return true; }
}
function markHomeOffered(owner: string, id: string) {
    try { localStorage.setItem(homeOfferKey(owner, id), '1'); } catch { /* a private window: offered again next time */ }
}

/** One tool, in the frame. */
function ToolView({ id, open, identity, onBack, onComposer, onGuide, onAddHomeCard, tools = TOOLS, apps = TOOL_APPS, now = Date.now }: ToolsPageProps & { id: string; onBack: () => void }) {
    const manifest = toolById(id, tools);
    const loader = manifest ? apps[id] : undefined;
    const [attempt, setAttempt] = useState(0);
    const loaded = useToolApp(id, loader, attempt);
    const owner = identity.publicKey;
    const copyOf: WebToolCopy | null = useMemo(
        () => (manifest && keepsNodeCopy(manifest) ? { manifest, owner: { kind: 'member', publicKey: owner }, node: pageNode() } : null),
        [manifest, owner]);
    const [copy, setCopy] = useState<CopyView>({ setting: undefined, note: null, busy: false, failed: null });
    const noteRef = useRef<CopyView['note']>(null);
    noteRef.current = copy.note;
    const reloadRef = useRef<() => Promise<void>>(async () => {});
    /** What a sync with the server did: its copy taken (read again), switched off elsewhere (the line, once), an older server. */
    const heard = useCallback((outcome: ToolCopyOutcome) => {
        if (outcome === 'taken') void reloadRef.current();
        else if (outcome === 'switched-off') setCopy((c) => ({ ...c, setting: false, note: 'removed' }));
        else if (outcome === 'older-node') setCopy((c) => ({ ...c, note: 'older-node' }));
    }, []);
    const afterWrite = useCallback(() => {
        if (copyOf && noteRef.current !== 'older-node') toolCopyAfterWrite(copyOf, heard);
    }, [copyOf, heard]);
    const store = useToolDoc(manifest, owner, afterWrite);
    reloadRef.current = store.reload;
    const info = useCommunityInfo();
    const [stack, setStack] = useState<Step[]>(() => [{ screen: open.screen, params: open.key ? { key: open.key } : {} as Record<string, string> }]);
    const [panel, setPanel] = useState<Panel>('tool');
    const [pastDoors, setPastDoors] = useState(false);
    // The tool's open: the setting as this browser last heard it, then the server's answer.
    useEffect(() => {
        if (!copyOf) return;
        let gone = false;
        void (async () => {
            const s = await readToolSettings(owner, copyOf.manifest.id);
            if (gone) return;
            setCopy((c) => ({ ...c, setting: s.nodeCopy }));
            const outcome = await openToolCopy(copyOf).catch(() => 'later' as const);
            if (!gone) heard(outcome);
        })();
        return () => { gone = true; };
    }, [copyOf, owner, heard]);
    /** The toggle: the setting follows the server's answer; with none, the switch stays and its line says why. */
    const switchCopy = useCallback(async (on: boolean) => {
        if (!copyOf) return;
        setCopy((c) => ({ ...c, busy: true, failed: null }));
        const done = await switchToolCopy(copyOf, on).catch(() => 'failed' as const);
        if (done === 'on' || done === 'off') {
            setCopy((c) => ({ ...c, busy: false, failed: null, setting: done === 'on', note: null }));
            // Switching on may have taken the server's copy.
            if (done === 'on') void reloadRef.current();
        } else {
            setCopy((c) => ({ ...c, busy: false, failed: done }));
        }
    }, [copyOf]);
    // Remove my data: the server's copy first, or nothing. It leaves the document empty, so the doors are back, as on a
    // first open, and the copy off (the one setting kept, so Settings says what is true).
    const remove = useCallback(async (): Promise<RemoveOutcome> => {
        if (copyOf && !await removeToolCopyFirst(copyOf).catch(() => false)) return 'failed';
        const gone = await store.remove();
        if (!gone) return 'not-kept';
        if (copyOf) {
            await patchToolSettings(owner, copyOf.manifest.id, { nodeCopy: false });
            setCopy({ setting: false, note: null, busy: false, failed: null });
        }
        setPastDoors(false);
        return 'removed';
    }, [store.remove, copyOf, owner]);

    const step = stack[stack.length - 1];
    const back = useCallback(() => {
        if (panel !== 'tool') { setPanel('tool'); return; }
        if (stack.length > 1) { setStack((s) => s.slice(0, -1)); return; }
        onBack();
    }, [panel, stack.length, onBack]);

    const ctx: WebHostContext = useMemo(() => ({
        owner: { kind: 'member', publicKey: owner, name: identity.callsign },
        node: { url: getNodeApiUrl() || null, profile: info?.profile ?? 'local', features: (info?.features as Record<string, unknown> | undefined) ?? null },
        navigate: (screen, params) => setStack((s) => [...s, { screen, params: { ...(params ?? {}) } }]),
        openComposer: onComposer,
        now,
        nodeCopy: !!copyOf && copy.setting !== false && copy.note !== 'older-node',
    }), [owner, identity.callsign, info, onComposer, now, copyOf, copy.setting, copy.note]);
    const docHandle = useMemo(() => ({ get: store.get, set: store.set }), [store.get, store.set]);
    const host = useMemo(() => (manifest ? webHostFor(manifest, ctx, docHandle) : null), [manifest, ctx, docHandle]);

    if (!manifest || !loader) return <NotInThisVersion onBack={onBack} />;
    if (loaded.status === 'failed') {
        return (
            <>
                <PageBar onBack={back} title={t(manifest.name)} icon={manifest.icon} />
                <ToolEmpty testId="tool-load-failed" icon={manifest.icon} title={t("This tool didn't load")} line={t('Check your connection, then try again.')}>
                    <ToolButton kind="primary" onClick={() => setAttempt((n) => n + 1)}>{t('Try again')}</ToolButton>
                </ToolEmpty>
            </>
        );
    }
    const screens = loaded.status === 'ready' ? loaded.app.screens() : null;
    const Screen: ComponentType<AnyToolScreenProps> | undefined = screens && manifest.screens.includes(step.screen) ? screens[step.screen] : undefined;
    if (screens && !Screen) return <NotInThisVersion onBack={onBack} />;

    const ready = store.state.status === 'ready' && Screen && host;
    const doc = store.state.status === 'ready' ? store.state.doc : null;
    let row: ToolLine | null = null;
    if (doc !== null) { try { row = manifest.row(doc, now()); } catch { row = null; } }
    const empty = doc !== null && isEmptyDoc(manifest, doc);

    return (
        <>
            <PageBar onBack={back} title={t(manifest.name)} icon={manifest.icon} line={lineText(row)}
                end={<ToolMenu name={t(manifest.name)} onPick={(p) => setPanel(p)} />} />
            <div className="max-w-xl mx-auto px-4 py-4 min-w-0">
                {panel === 'settings' && <ToolSettings manifest={manifest} copy={copy} onCopy={(on) => { void switchCopy(on); }} onRemove={remove} />}
                {panel === 'tool' && copy.note === 'removed' && (
                    <p role="status" data-testid="tool-copy-removed" className="m-0 mb-3 text-sm text-nature-700 dark:text-nature-200 break-words">{keptLine(manifest, copy)}</p>
                )}
                {panel === 'about' && <ToolAbout manifest={manifest} onGuide={onGuide} />}
                {panel === 'tool' && !ready && (
                    <p className="m-0 text-sm text-nature-600 dark:text-nature-300 break-words" role="status">{t('Loading...')}</p>
                )}
                {panel === 'tool' && ready && empty && !pastDoors && step.screen === 'main' && (
                    <EmptyDoors manifest={manifest} owner={owner} onIn={() => setPastDoors(true)} onGuide={onGuide} onAddHomeCard={onAddHomeCard} />
                )}
                {panel === 'tool' && ready && (!empty || pastDoors || step.screen !== 'main') && (
                    <ScreenBoundary key={`${step.screen}:${stack.length}`}>
                        <Screen host={host as unknown as AnyToolScreenProps['host']} params={step.params} />
                    </ScreenBoundary>
                )}
            </div>
        </>
    );
}

/** The header's "…": the tool's Settings, About this tool, and Remove my data (Settings, at its Remove). */
function ToolMenu({ name, onPick }: { name: string; onPick: (panel: Panel) => void }) {
    const [open, setOpen] = useState(false);
    const button = useRef<HTMLButtonElement | null>(null);
    const list = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!open) return;
        list.current?.querySelector<HTMLButtonElement>('button')?.focus();
        const away = (e: MouseEvent) => {
            const target = e.target as Node | null;
            if (target && !list.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
        };
        document.addEventListener('mousedown', away);
        return () => document.removeEventListener('mousedown', away);
    }, [open]);
    const pick = (p: Panel) => { setOpen(false); onPick(p); };
    const item = 'w-full min-h-[48px] px-4 py-2 text-left text-sm font-semibold break-words text-nature-900 dark:text-white bg-transparent border-0 cursor-pointer hover:bg-nature-50 dark:hover:bg-nature-800 focus-visible:outline-none focus-visible:bg-nature-100 dark:focus-visible:bg-nature-800';
    return (
        <div className="relative shrink-0">
            <button ref={button} type="button" aria-haspopup="true" aria-expanded={open} data-testid="tool-menu"
                aria-label={t('Options for {tool}', { tool: name })} onClick={() => setOpen((o) => !o)}
                className="min-h-[48px] min-w-[48px] flex items-center justify-center bg-transparent border-0 rounded-full cursor-pointer text-lg font-black text-nature-600 dark:text-nature-300 hover:text-nature-900 dark:hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand">
                <span aria-hidden="true">…</span>
            </button>
            {open && (
                <div ref={list} role="group" aria-label={t('Options for {tool}', { tool: name })}
                    onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); button.current?.focus(); } }}
                    className="absolute right-0 top-full z-30 w-56 max-w-[calc(100vw-2rem)] py-1 rounded-xl shadow-xl bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-700">
                    <button type="button" className={item} data-testid="tool-menu-settings" onClick={() => pick('settings')}>{t('Settings')}</button>
                    <button type="button" className={item} data-testid="tool-menu-about" onClick={() => pick('about')}>{t('About this tool')}</button>
                    <button type="button" className={item} data-testid="tool-menu-remove" onClick={() => pick('settings')}>{t('Remove my data from this browser')}</button>
                </div>
            )}
        </div>
    );
}

/** The two doors over an empty document, the examples and guide page behind the second, and the Home card's one offer. */
function EmptyDoors({ manifest, owner, onIn, onGuide, onAddHomeCard }: {
    manifest: ToolManifest; owner: string; onIn: () => void; onGuide: (slug: string) => void; onAddHomeCard: (type: string) => void;
}) {
    const [starting, setStarting] = useState(false);
    const [offer, setOffer] = useState(() => !!manifest.homeCard && !homeOffered(owner, manifest.id));
    const answer = (add: boolean) => {
        markHomeOffered(owner, manifest.id);
        setOffer(false);
        if (add) onAddHomeCard(toolHomeCardType(manifest.id));
    };
    return (
        <div data-testid="tool-doors">
            <ToolEmpty icon={manifest.icon} title={t(manifest.name)} line={t(manifest.line)}>
                <ToolButton kind="primary" testId="tool-door-already" onClick={onIn}>{t('I already do this')}</ToolButton>
                <ToolButton testId="tool-door-starting" onClick={() => setStarting(true)}>{t("I'm starting out")}</ToolButton>
            </ToolEmpty>
            {starting && (
                <ToolSection title={t('For example')} testId="tool-examples">
                    {manifest.examples.map((ex, i) => <ToolRow key={ex} title={t(manifest.examples[i])} />)}
                    <div className="p-3 flex flex-wrap gap-2 min-w-0">
                        <ToolButton kind="primary" onClick={onIn}>{t('Start')}</ToolButton>
                        {manifest.guide && <ToolButton testId="tool-guide" onClick={() => onGuide(manifest.guide!)}>{t('Read the guide')}</ToolButton>}
                    </div>
                </ToolSection>
            )}
            {offer && manifest.homeCard && (
                <ToolSection title={t('On your Home')} testId="tool-home-offer">
                    <p className="m-0 px-3 pt-3 text-sm text-nature-800 dark:text-nature-100 break-words">{t(manifest.homeCard.line)}</p>
                    <div className="p-3 flex flex-wrap gap-2 min-w-0">
                        <ToolButton testId="tool-home-add" onClick={() => answer(true)}>{t('Add to Home')}</ToolButton>
                        <ToolButton testId="tool-home-no" onClick={() => answer(false)}>{t('Not now')}</ToolButton>
                    </div>
                </ToolSection>
            )}
        </div>
    );
}

/**
 * What this page knows of a tool's node copy: the setting as this browser last heard it (undefined: never set, so on),
 * what this open learned (the server keeps no copies yet, or no longer keeps this one: said once), and the toggle's
 * round trip (under way, or the last one failed).
 */
interface CopyView {
    setting: boolean | undefined;
    note: 'older-node' | 'removed' | null;
    busy: boolean;
    failed: 'failed' | 'older-node' | null;
}
type RemoveOutcome = 'removed' | 'not-kept' | 'failed';

const olderNodeLine = () => t("Your community's server can't keep a copy yet, so for now it stays in this browser only.");
const copyFailedLine = () => t("Couldn't reach your community's server, so nothing changed. Try again when you're online.");

/** Where a tool's document is kept, in one sentence: this browser only, or with its private copy on the server. */
function keptLine(manifest: ToolManifest, copy: CopyView, owner: 'member' | 'enterprise' = 'member'): string {
    if (!keepsNodeCopy(manifest)) return t('Kept in this browser, for you only. Nothing of it leaves this browser, and signing out here removes it.');
    if (copy.note === 'removed') {
        return owner === 'enterprise'
            ? t('A keeper switched off the server copy of this tool, so it is kept in this browser only. You can switch it on again in Settings.')
            : t("Your community's server no longer keeps a copy of this tool, so it is kept in this browser only. You can switch the copy on again in Settings.");
    }
    if (copy.note === 'older-node') return olderNodeLine();
    if (copy.setting === false) return t('Kept in this browser, for you only. Nothing of it leaves this browser, and signing out here removes it.');
    return t("Kept in this browser, with a private copy on your community's server that only you can read through the app. Like everything on that server, its operator could.");
}

/** The tool's Settings: where its document is kept, the node copy's toggle (for a tool that asks for one), and Remove my data. */
function ToolSettings({ manifest, copy, onCopy, onRemove }: {
    manifest: ToolManifest; copy: CopyView; onCopy: (on: boolean) => void; onRemove: () => Promise<RemoveOutcome>;
}) {
    const [confirming, setConfirming] = useState(false);
    const [said, setSaid] = useState<string | null>(null);
    const keeps = keepsNodeCopy(manifest);
    const on = copy.setting !== false;
    const remove = async () => {
        const done = await onRemove();
        setConfirming(false);
        setSaid(done === 'removed' ? t('Removed from this browser.') : done === 'failed' ? copyFailedLine() : t("It couldn't be removed. Try again."));
    };
    const name = t("Keep a private copy on your community's server");
    return (
        <div data-testid="tool-settings">
            <ToolSection title={t('Where it is kept')}>
                <p data-testid="tool-kept-line" className="m-0 p-3 text-sm text-nature-800 dark:text-nature-100 break-words">{keptLine(manifest, copy)}</p>
                {keeps && (
                    <>
                        <button type="button" role="switch" aria-checked={on} disabled={copy.busy} onClick={() => onCopy(!on)} data-testid="tool-node-copy"
                            className="w-full min-h-[48px] px-3 py-2 flex items-center gap-3 text-left bg-transparent border-0 cursor-pointer disabled:cursor-default disabled:opacity-60 hover:bg-nature-50 dark:hover:bg-nature-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand">
                            <span className="min-w-0 flex-1 break-words text-sm font-semibold text-nature-900 dark:text-white">{name}</span>
                            <span aria-hidden="true" className={`shrink-0 w-11 h-6 p-0.5 rounded-full flex ${on ? 'justify-end bg-bp-commit-fill' : 'justify-start bg-nature-300 dark:bg-nature-700'}`}>
                                <span className="w-5 h-5 rounded-full bg-white" />
                            </span>
                        </button>
                        <p data-testid="tool-node-copy-note" className="m-0 p-3 text-sm text-nature-700 dark:text-nature-200 break-words">
                            {copy.note === 'older-node' || copy.failed === 'older-node' ? olderNodeLine() : t('One device at a time: the copy you changed last is the one kept.')}
                        </p>
                        {copy.failed === 'failed' && (
                            <p role="status" data-testid="tool-node-copy-failed" className="m-0 p-3 text-sm font-semibold text-bp-ink-danger break-words">{copyFailedLine()}</p>
                        )}
                    </>
                )}
            </ToolSection>
            <ToolSection title={t('Remove my data from this browser')}>
                <p className="m-0 px-3 pt-3 text-sm text-nature-800 dark:text-nature-100 break-words">
                    {keeps && on
                        ? t("Takes this community's data for {tool} out of this browser, and its copy on your community's server. Another device signed in as you keeps what it has and stops sending it. The same tool in another community keeps its own. It can't be undone.", { tool: t(manifest.name) })
                        : t('Takes this community\'s data for {tool} out of this browser. The same tool in another community keeps its own. It can\'t be undone.', { tool: t(manifest.name) })}
                </p>
                <div className="p-3 flex flex-wrap gap-2 min-w-0">
                    {!confirming
                        ? <ToolButton testId="tool-remove" onClick={() => { setSaid(null); setConfirming(true); }}>{t('Remove my data')}</ToolButton>
                        : <>
                            <ToolButton kind="danger" testId="tool-remove-yes" onClick={() => { void remove(); }}>{t('Yes, remove it')}</ToolButton>
                            <ToolButton testId="tool-remove-no" onClick={() => setConfirming(false)}>{t('Keep it')}</ToolButton>
                        </>}
                </div>
                {said && <p role="status" className="m-0 px-3 pb-3 text-sm text-nature-800 dark:text-nature-100 break-words">{said}</p>}
            </ToolSection>
        </div>
    );
}

/** About this tool: what it keeps, and its guide page. */
function ToolAbout({ manifest, onGuide }: { manifest: ToolManifest; onGuide: (slug: string) => void }) {
    return (
        <div data-testid="tool-about">
            <ToolSection title={t('About this tool')}>
                <p className="m-0 p-3 text-sm text-nature-800 dark:text-nature-100 break-words">{t(manifest.line)}</p>
                {manifest.guide && (
                    <div className="px-3 pb-3">
                        <ToolButton onClick={() => onGuide(manifest.guide!)}>{t('Read the guide')}</ToolButton>
                    </div>
                )}
            </ToolSection>
        </div>
    );
}
