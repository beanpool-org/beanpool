/**
 * Learn — the place where Local knowledge is read (slice K2, web half, read-only; scratch/fable-design/
 * DESIGN-local-knowledge-fable.md as amended by DESIGN-local-knowledge-amend-fable.md, every pick Marty's, 11 Nov 2026).
 *
 * Not a tab and not a Market pill: a page value `learn` with no entry in the nav, as `pulse` is (App.tsx), with its own
 * "‹ Back" to where the member came from. Its views, one screen's worth of state:
 *   front  — pinned pages, then one block a topic (up to three rows, "See all {n} ›"), a search box on top, never by date;
 *   topic  — one topic alone, every row, a page at a time;
 *   search — one flat list, best match first;
 *   page   — one page whole: the answer first, then its place, photos, sources, when it was last checked and who stands behind it.
 * What a node holds is read through GET /api/knowledge/front (rows, never a body) and GET /api/marketplace/posts?type=knowledge
 * (one page whole): lib/learn.ts. Where the node has Learn off and shows previews (the global community) the same screens are
 * drawn from Example Valley's three pages under a strip that says so, and nothing is asked of the node.
 *
 * Writing (slice K4): "＋ Suggest knowledge" fixed at the foot of the front ("＋ Add local knowledge" for an owner or admin,
 * whose page publishes at once) opens the form (components/LearnForm.tsx); line 4 under the search is "1 of yours is waiting for
 * an admin ›" (My suggestions, components/LearnMine.tsx) and, amber, "3 to check ›" (To check, components/LearnCheck.tsx).
 * Doors: `learn-suggest`, `learn-mine`, `learn-check`. Not in the preview: Example Valley takes no suggestions.
 * Still to come: "This helped", "Suggest a fix", pin and edit (K5), "Thank" (K8). Report is the existing sheet, by post id.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    KNOWLEDGE_NAMES, LEARN_HOME_WORDS, LOCAL_COMMUNITY_SHEET, formatCount, isKnowledgeTopic, pinLive, t, tn, upperCase, type KnowledgeFront,
    type KnowledgeRow, type KnowledgeTopicPage,
} from '@beanpool/core';
import type { BeanPoolIdentity } from '../lib/identity';
import { resolveImageUrl } from '../lib/avatar';
import { shownLanguage } from '../lib/language';
import {
    getLearnFront, getLearnPost, getLearnToCheck, getLearnTopic, getMyLearnDrafts, languageNameOf, learnFrontOf, learnSearchOf, learnTopicOf,
    monthYear, publishLearn, safeSourceUrl, searchLearn, showsLearn, sourceHost, suggestLearn, topicEmoji, topicLabel, useChecksLearn, useLearn,
    type LearnPost,
} from '../lib/learn';
import { LearnForm } from '../components/LearnForm';
import { LearnMine } from '../components/LearnMine';
import { LearnCheckList, LearnCheckOne } from '../components/LearnCheck';
import { sampleLearnPosts } from '../components/ShowcasePreviews';
import { ImageLightbox } from '../components/ImageLightbox';
import { LearnRow } from '../components/LearnRow';
import { LocalCommunityPill } from '../components/LocalCommunityMark';
import { MemberAvatar } from '../components/MemberAvatar';
import { ReportModal } from '../components/ReportModal';
import { ScrollHintRow } from '../components/ScrollHintRow';
import { StartCommunityScreen } from '../components/StartCommunityScreen';
import { BOX_LABEL, CHIP, PAGE_BOX, PAGE_INK, PAGE_TYPE, chip } from '../components/market-card-shell';

/** Where a door sends Learn: App.tsx's `learn`, `learn-topic`, `learn-search`, `learn-page`, `learn-suggest`, `learn-mine`, `learn-check`. */
export type LearnTarget =
    | { kind: 'front' }
    | { kind: 'topic'; topic: string }
    | { kind: 'search'; q: string }
    | { kind: 'page'; id: string }
    | { kind: 'suggest' }
    | { kind: 'mine' }
    | { kind: 'check' };

/** A screen of Learn beside its lists (slice K4): the form, what was sent, My suggestions, To check. */
type Screen = 'list' | 'form' | 'sent' | 'mine' | 'check';

interface Props {
    identity: BeanPoolIdentity | null;
    /** A door's request, taken once: `onTargetTaken` tells the app to forget it. */
    target: LearnTarget | null;
    onTargetTaken: () => void;
    /** "‹ Back" from the first screen of Learn: to the tab the member came from. */
    onBack: () => void;
    onOpenProfile: (pubkey: string) => void;
    /** App's doors: `marketplace-search` for "Search the Market for …"; Home's Find card for the preview's "Communities near you". */
    onNavigate?: (tab: string, ctxId?: string) => void;
    onNearYou?: () => void;
}

interface View { topic: string | null; words: string; pageId: string | null; screen: Screen }

/** What a door asks for, as the view's state. */
function viewFor(target: LearnTarget | null): View {
    const none: View = { topic: null, words: '', pageId: null, screen: 'list' };
    if (!target || target.kind === 'front') return none;
    if (target.kind === 'topic') return { ...none, topic: isKnowledgeTopic(target.topic) ? target.topic : null };
    if (target.kind === 'search') return { ...none, words: target.q };
    if (target.kind === 'page') return { ...none, pageId: target.id };
    return { ...none, screen: target.kind === 'suggest' ? 'form' : target.kind };
}

/** A door that opens a page or a screen straight (a link, a bell line, the New Post panel): Back from it leaves Learn. */
const opensStraight = (target: LearnTarget | null) => !!target && target.kind !== 'front' && target.kind !== 'topic' && target.kind !== 'search';

const TOPIC_CHIP = `${CHIP} bg-bp-chip-learn-tint text-bp-chip-learn-ink`;
const LINK_BUTTON = 'min-h-[44px] inline-flex items-center gap-1 px-1 text-start font-bold text-bp-ink-learn bg-transparent border-0 cursor-pointer hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-learn rounded';
const MUTED = 'text-nature-600 dark:text-nature-300';
/** "3 to check ›": amber, never by colour alone (a ▲ leads it). */
const WARN_LINK = LINK_BUTTON.replace('text-bp-ink-learn', 'text-bp-ink-warning');

function Shell({ children }: { children: React.ReactNode }) {
    return (
        <div data-testid="learn-page" className="max-w-xl mx-auto w-full px-4 pt-2" style={{ paddingBottom: 'calc(var(--bottom-nav-offset) + 4rem)' }}>
            {children}
        </div>
    );
}

function Header({ title, onBack, label }: { title: string; onBack: () => void; label?: boolean }) {
    return (
        <div className="flex items-center gap-1 min-h-[48px]">
            <button
                type="button"
                data-testid="learn-back"
                onClick={onBack}
                className="-ms-2 min-h-[48px] min-w-[48px] px-2 inline-flex items-center gap-1 font-bold text-nature-700 dark:text-nature-200 bg-transparent border-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-learn rounded-lg"
            >
                <span aria-hidden="true">‹</span><span>{t('Back')}</span>
            </button>
            <h1 className={`m-0 min-w-0 break-words ${label ? 'text-[0.625rem] font-extrabold tracking-[1.5px] uppercase text-bp-ink-learn' : 'text-xl font-extrabold text-nature-900 dark:text-nature-50'}`}>{title}</h1>
        </div>
    );
}

/** The strip across the top of the preview: it says this is Example Valley's, and leads to a local community. */
function PreviewStrip({ onNearYou }: { onNearYou?: () => void }) {
    const [start, setStart] = useState(false);
    return (
        <section data-testid="learn-preview-strip" aria-label={t('Local community')}
            className="mb-3 rounded-2xl p-4 border border-dashed border-blue-400 dark:border-blue-600 bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-200">
            <div className="mb-2"><LocalCommunityPill /></div>
            <p className="m-0 text-sm text-nature-800 dark:text-nature-100">
                <strong>{t('Example pages.')}</strong>{' '}
                <span>{t('Neighbours write what is worth knowing, and an owner or admin checks it first.')}</span>
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <button type="button" data-testid="learn-preview-start" onClick={() => setStart(true)}
                    className="w-full rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover px-4 py-2.5 font-bold text-bp-cta-on">{t(LOCAL_COMMUNITY_SHEET.start)}</button>
                {onNearYou && (
                    <button type="button" onClick={onNearYou}
                        className="w-full rounded-xl border border-blue-300 dark:border-blue-700 bg-white/70 dark:bg-nature-900/60 px-4 py-2.5 font-bold text-nature-800 dark:text-nature-100">
                        {t(LOCAL_COMMUNITY_SHEET.nearYou)}
                    </button>
                )}
            </div>
            {start && createPortal(<StartCommunityScreen onClose={() => setStart(false)} onNearYou={onNearYou} />, document.body)}
        </section>
    );
}

/** A request that lands once: the data, or an error to try again, or null while it is on its way. */
function useRead<T>(read: (() => Promise<T>) | null, deps: readonly unknown[]): { data: T | null; failed: boolean; again: () => void } {
    const [data, setData] = useState<T | null>(null);
    const [failed, setFailed] = useState(false);
    const [tries, setTries] = useState(0);
    useEffect(() => {
        if (!read) return;
        let live = true;
        setFailed(false);
        read().then((d) => { if (live) setData(d); }, () => { if (live) { setData(null); setFailed(true); } });
        return () => { live = false; };
    }, [...deps, tries]);
    return { data, failed, again: () => setTries((n) => n + 1) };
}

function Failed({ onAgain }: { onAgain: () => void }) {
    return (
        <div role="alert" data-testid="learn-failed" className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-3 text-sm text-red-700 dark:text-red-300">
            <p className="m-0 mb-2">{t("Couldn't load Learn. Check your connection and try again.")}</p>
            <button type="button" onClick={onAgain} className="min-h-[44px] px-3 rounded-lg border border-red-300 dark:border-red-700 font-bold">{t('Try again')}</button>
        </div>
    );
}

function Rows({ rows, onOpen }: { rows: KnowledgeRow[]; onOpen: (id: string) => void }) {
    return (
        <div className="flex flex-col gap-2">
            {rows.map((row) => <LearnRow key={row.id} row={row} onOpen={() => onOpen(row.id)} />)}
        </div>
    );
}

export function LearnPage({ identity, target, onTargetTaken, onBack, onOpenProfile, onNavigate, onNearYou }: Props) {
    const { ready, mode } = useLearn();
    const preview = mode === 'preview';
    const open = ready && showsLearn(mode);

    const [view, setView] = useState<View>(() => viewFor(target));
    // A page or screen a door opened straight (a link, a bell line) leaves Learn on Back; one opened from a list returns to it.
    const [pageIsEntry, setPageIsEntry] = useState(() => opensStraight(target));
    // To check: the suggestion open, the answer just given, and "Edit first" (open, and whether its form was changed).
    const [checkId, setCheckId] = useState<string | null>(null);
    const [checkSaid, setCheckSaid] = useState<string | null>(null);
    const [checkEditing, setCheckEditing] = useState(false);
    const [checkEdited, setCheckEdited] = useState(false);
    const closeCheckOne = () => { setCheckId(null); setCheckEditing(false); setCheckEdited(false); };
    // Every way into a screen starts it afresh, a door (the bell's line, a push, Home) as much as a link in Learn: no answer
    // said on an earlier visit to To check, no suggestion left open.
    const freshScreen = () => { setCheckSaid(null); closeCheckOne(); };
    useEffect(() => {
        if (!target) return;
        setView(viewFor(target));
        setPageIsEntry(opensStraight(target));
        freshScreen();
        onTargetTaken();
    }, [target, onTargetTaken]);

    const { topic, words, pageId, screen } = view;
    const setTopic = (next: string | null) => setView((v) => ({ ...v, topic: next }));
    const setWords = (next: string) => setView((v) => ({ ...v, words: next }));
    // A page opened from a screen (My suggestions' "Added") returns there; from a list, to the list.
    const openPage = (id: string) => { setPageIsEntry(false); setView((v) => ({ ...v, pageId: id })); };
    const closePage = () => { if (pageIsEntry) onBack(); else setView((v) => ({ ...v, pageId: null })); };
    const openScreen = (next: Screen) => { setPageIsEntry(false); freshScreen(); setView((v) => ({ ...v, screen: next, pageId: null })); };
    const closeScreen = () => { if (pageIsEntry) onBack(); else setView((v) => ({ ...v, screen: 'list' })); };

    // The sample pages, made once per preview screen.
    const sample = useRef<LearnPost[] | null>(null);
    const samplePosts = (): LearnPost[] => (sample.current ??= sampleLearnPosts());

    const onList = open && !pageId && screen === 'list';
    const front = useRead<KnowledgeFront>(onList ? () => (preview ? Promise.resolve(learnFrontOf(samplePosts())) : getLearnFront()) : null, [onList, preview]);
    // Writing (K4): a member's own waiting suggestions and, for an owner or admin, what waits for them; never in the preview.
    const writes = open && !preview && !!identity;
    const checks = useChecksLearn(writes);
    const mineWaiting = useRead<number>(writes && onList ? () => getMyLearnDrafts().then((m) => m.waiting.length) : null, [writes, onList]);
    const toCheck = useRead<number>(writes && checks && onList ? () => getLearnToCheck().then((l) => l.total) : null, [writes, checks, onList]);
    const [sentBy, setSentBy] = useState<'suggest' | 'publish'>('suggest');

    // One topic, a page at a time.
    const [more, setMore] = useState<{ topic: string; rows: KnowledgeRow[]; next: number | null; count: number } | null>(null);
    // The topic's first page failed (nothing to keep: Failed, with Try again), and a later page failed (the rows read stay).
    const [topicFailed, setTopicFailed] = useState(false);
    const [topicTries, setTopicTries] = useState(0);
    const [moreFailed, setMoreFailed] = useState(false);
    // A later page is out: a ref, so a second tap in the same frame (before the screen has drawn the first) is turned away too.
    const [moreLoading, setMoreLoading] = useState(false);
    const moreOut = useRef(false);
    // Which read of the topic this is: an answer for an earlier one (another topic, or the same one read again) is dropped.
    const topicRead = useRef(0);
    useEffect(() => {
        topicRead.current += 1;
        moreOut.current = false;
        setMoreLoading(false);
        setMoreFailed(false);
        setTopicFailed(false);
        if (!open || !topic || pageId) { setMore(null); return; }
        let live = true;
        const first: Promise<KnowledgeTopicPage> = preview ? Promise.resolve(learnTopicOf(samplePosts(), topic)) : getLearnTopic(topic);
        first.then((p) => { if (live) setMore({ topic, rows: p.rows, next: p.next, count: p.count }); }, () => { if (live) setTopicFailed(true); });
        return () => { live = false; };
    }, [open, preview, topic, pageId, topicTries]);
    const showMore = useCallback(() => {
        if (!more || more.next === null || !topic || moreOut.current) return;
        const from = more.next;
        const mine = topicRead.current;
        moreOut.current = true;
        setMoreLoading(true);
        setMoreFailed(false);
        const next: Promise<KnowledgeTopicPage> = preview ? Promise.resolve(learnTopicOf(samplePosts(), topic, from)) : getLearnTopic(topic, from);
        next.then(
            (p) => {
                if (topicRead.current !== mine) return;
                moreOut.current = false;
                setMoreLoading(false);
                // Only the page that follows what is drawn: the same offset is never added twice.
                setMore((m) => (m && m.topic === topic && m.next === from ? { ...m, rows: [...m.rows, ...p.rows], next: p.next } : m));
            },
            () => {
                if (topicRead.current !== mine) return;
                moreOut.current = false;
                setMoreLoading(false);
                setMoreFailed(true);
            },
        );
    }, [more, preview, topic]);

    // A search, 300 ms after the last key: the node's, or a plain match over the sample.
    const typed = words.trim();
    const [found, setFound] = useState<{ words: string; rows: KnowledgeRow[] } | null>(null);
    const [searchFailed, setSearchFailed] = useState(false);
    const [searchTries, setSearchTries] = useState(0);
    useEffect(() => {
        if (!open || !typed || pageId) { setFound(null); setSearchFailed(false); return; }
        let live = true;
        const timer = setTimeout(() => {
            const read = preview ? Promise.resolve(learnSearchOf(samplePosts(), typed)) : searchLearn(typed);
            read.then((r) => { if (live) { setFound({ words: typed, rows: r.rows }); setSearchFailed(false); } }, () => { if (live) setSearchFailed(true); });
        }, 300);
        return () => { live = false; clearTimeout(timer); };
    }, [open, preview, typed, pageId, searchTries]);

    if (!ready) return <Shell><Header title={t(KNOWLEDGE_NAMES.place)} onBack={onBack} /><p className={`mt-4 ${MUTED}`}>{t('Loading...')}</p></Shell>;
    if (!open) {
        return (
            <Shell>
                <Header title={t(KNOWLEDGE_NAMES.place)} onBack={onBack} />
                <p data-testid="learn-off" className={`mt-4 ${MUTED}`}>{t("Learn isn't switched on in this community.")}</p>
            </Shell>
        );
    }

    if (pageId) {
        return (
            <Shell>
                <PageView id={pageId} preview={preview} identity={identity} samplePosts={samplePosts} onBack={closePage} onOpenProfile={onOpenProfile} />
            </Shell>
        );
    }

    if (screen === 'form' && writes) {
        return (
            <Shell>
                <Header title={checks ? t('Add local knowledge') : t('Suggest knowledge')} onBack={closeScreen} />
                <LearnForm use={checks ? 'publish' : 'suggest'} onSend={async (input) => {
                    if (checks) await publishLearn(input); else await suggestLearn(input);
                    setSentBy(checks ? 'publish' : 'suggest');
                    setView((v) => ({ ...v, screen: 'sent' }));
                }} />
            </Shell>
        );
    }
    if (screen === 'sent' && writes) {
        return (
            <Shell>
                <Header title={t(KNOWLEDGE_NAMES.place)} onBack={closeScreen} />
                <section data-testid="learn-sent" role="status" className="py-6 flex flex-col gap-2">
                    <h2 className="m-0 text-xl font-extrabold text-nature-900 dark:text-white">{sentBy === 'publish' ? t('Published') : t('Sent')}</h2>
                    <p className={`m-0 ${MUTED}`}>{sentBy === 'publish' ? t("It's in Learn.") : t("An owner or admin will check it. You'll hear back here.")}</p>
                    <button type="button" data-testid="learn-sent-open" onClick={() => openScreen('list')} className={LINK_BUTTON}>{t('Open Learn')}</button>
                </section>
            </Shell>
        );
    }
    if (screen === 'mine' && writes) {
        return (
            <Shell>
                <Header title={t('My suggestions')} onBack={closeScreen} />
                <LearnMine onOpenPage={openPage} />
            </Shell>
        );
    }
    if (screen === 'check' && writes) {
        // Back from "Edit first" returns to the suggestion, asking first when the form was changed; from a suggestion, to the list.
        const checkBack = () => {
            if (checkEditing) {
                if (checkEdited && !window.confirm(t("Leave without approving? Your changes won't be kept."))) return;
                setCheckEditing(false);
                setCheckEdited(false);
            } else if (checkId) closeCheckOne();
            else closeScreen();
        };
        return (
            <Shell>
                <Header title={t('To check')} onBack={checkBack} />
                {checkSaid && !checkId && <p role="status" data-testid="learn-check-said" className="m-0 mt-1 mb-2 text-sm font-bold text-bp-ink-learn">{checkSaid}</p>}
                {checkId
                    ? <LearnCheckOne key={checkId} id={checkId} editing={checkEditing} onEditing={setCheckEditing} onEdited={setCheckEdited}
                        onAnswered={(said) => { setCheckSaid(said); closeCheckOne(); }} />
                    : <LearnCheckList onOpen={(id) => { setCheckSaid(null); closeCheckOne(); setCheckId(id); }} />}
            </Shell>
        );
    }

    const searching = typed.length > 0;
    return (
        <Shell>
            <Header title={t(KNOWLEDGE_NAMES.place)} onBack={onBack} />
            <p className={`m-0 mb-3 text-sm ${MUTED}`}>{t('Things worth knowing about your community.')}</p>
            {preview && <PreviewStrip onNearYou={onNearYou} />}
            <input
                type="text"
                inputMode="search"
                enterKeyHint="search"
                data-testid="learn-search"
                value={words}
                onChange={(e) => setWords(e.target.value)}
                placeholder={t('Search Learn')}
                aria-label={t('Search Learn')}
                className="w-full min-h-[44px] mb-3 py-2 px-4 rounded-full border border-nature-200 dark:border-nature-600 bg-white dark:bg-nature-900 text-nature-900 dark:text-white text-[14px] font-medium focus:outline-none focus:ring-2 focus:ring-bp-ink-learn shadow-sm"
            />
            {/* Line 4 (amended §3.1): what waits for this member; for an owner or admin, what waits for them (amber, and a ▲). */}
            {(mineWaiting.data ?? 0) > 0 && (
                <button type="button" data-testid="learn-mine-line" onClick={() => openScreen('mine')} className={`${LINK_BUTTON} mb-1`}>
                    {tn(mineWaiting.data!, '{n} of yours is waiting for an admin ›', '{n} of yours are waiting for an admin ›', { n: formatCount(mineWaiting.data!) })}
                </button>
            )}
            {(toCheck.data ?? 0) > 0 && (
                <button type="button" data-testid="learn-check-line" onClick={() => openScreen('check')} className={`${WARN_LINK} mb-1`}>
                    <span aria-hidden="true" className="font-black">▲</span>
                    <span>{tn(toCheck.data!, LEARN_HOME_WORDS.toCheck.one, LEARN_HOME_WORDS.toCheck.other, { n: formatCount(toCheck.data!) })}</span>
                </button>
            )}

            {searching ? (
                searchFailed ? <Failed onAgain={() => setSearchTries((n) => n + 1)} />
                : found === null || found.words !== typed ? <p className={MUTED}>{t('Loading...')}</p>
                : found.rows.length === 0 ? (
                    <div data-testid="learn-search-empty" className="py-4">
                        <p className={`m-0 mb-2 ${MUTED}`}>{t('Nothing in Learn for "{words}".', { words: typed })}</p>
                        {writes && (
                            <button type="button" data-testid="learn-search-suggest" onClick={() => openScreen('form')} className={`${LINK_BUTTON} me-3`}>
                                {checks ? t('Add local knowledge') : t('Suggest knowledge')}
                            </button>
                        )}
                        {onNavigate && !preview && (
                            <button type="button" data-testid="learn-search-market" onClick={() => onNavigate('marketplace-search', typed)} className={LINK_BUTTON}>
                                {t('Search the Market for "{words}" ›', { words: typed })}
                            </button>
                        )}
                    </div>
                ) : <Rows rows={found.rows} onOpen={openPage} />
            ) : front.failed ? <Failed onAgain={front.again} />
            : !front.data ? <p className={MUTED}>{t('Loading...')}</p>
            : (
                <>
                    {front.data.topics.length > 0 && (
                        <ScrollHintRow testId="learn-topic-chips" role="group" aria-label={t('Topics')} className="max-w-full flex flex-nowrap items-center gap-2 overflow-x-auto overscroll-x-contain py-1 mb-2">
                            <TopicChip pressed={topic === null} onClick={() => setTopic(null)} label={t('All topics')} />
                            {front.data.topics.map((tp) => (
                                <TopicChip key={tp.id} pressed={topic === tp.id} onClick={() => setTopic(tp.id)} emoji={topicEmoji(tp.id)} label={t('{topic} {n}', { topic: topicLabel(tp.id), n: tp.count })} />
                            ))}
                        </ScrollHintRow>
                    )}
                    {front.data.total === 0 ? (
                        <p data-testid="learn-empty" className={`py-4 ${MUTED}`}>
                            {t('Nothing here yet.')}{writes && <> {t('Know something locals should know?')}</>}
                        </p>
                    ) : topic ? (
                        <TopicView
                            topic={topic} more={more} failed={topicFailed} onTopicAgain={() => setTopicTries((n) => n + 1)}
                            moreFailed={moreFailed} moreLoading={moreLoading} onMore={showMore} onOpen={openPage}
                        />
                    ) : (
                        <Front front={front.data} onOpen={openPage} onTopic={setTopic} />
                    )}
                </>
            )}
            <p data-testid="learn-standing" className={`mt-6 text-xs ${MUTED}`}>{t('Local knowledge is written by members. Check the source before you rely on it.')}</p>
            {/* Fixed at the foot, above the bottom bar; at the end of the list it sits in its own place, under the last row. */}
            {writes && (
                <div className="sticky z-10 pt-2" style={{ bottom: 'calc(var(--bottom-nav-offset) + 0.5rem)' }}>
                    <button type="button" data-testid="learn-suggest" onClick={() => openScreen('form')}
                        className="w-full min-h-[48px] rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover px-4 py-2.5 font-bold text-bp-cta-on shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-learn">
                        {checks ? t('＋ Add local knowledge') : t('＋ Suggest knowledge')}
                    </button>
                </div>
            )}
        </Shell>
    );
}

function TopicChip({ pressed, onClick, label, emoji }: { pressed: boolean; onClick: () => void; label: string; emoji?: string }) {
    return (
        <button
            type="button"
            aria-pressed={pressed}
            onClick={onClick}
            className={`shrink-0 min-h-[44px] px-3 rounded-full inline-flex items-center whitespace-nowrap text-sm cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-learn ${
                pressed
                    ? 'bg-bp-chip-learn-tint text-bp-chip-learn-ink border-2 border-bp-ink-learn font-black'
                    : 'bg-white/90 dark:bg-nature-900/80 text-nature-700 dark:text-nature-200 border border-nature-300 dark:border-nature-600 font-bold'
            }`}
        >
            {emoji && <span aria-hidden="true" className="me-1.5">{emoji}</span>}
            <span>{label}</span>
        </button>
    );
}

/** Pinned pages, then one block a topic that holds something (core's order), each with up to three rows. */
function Front({ front, onOpen, onTopic }: { front: KnowledgeFront; onOpen: (id: string) => void; onTopic: (id: string) => void }) {
    return (
        <div className="flex flex-col gap-5">
            {front.pinned.length > 0 && (
                <section data-testid="learn-pinned" aria-label={t('📌 PINNED')}>
                    <h2 className="m-0 mb-2 text-sm font-extrabold text-nature-800 dark:text-nature-100">{t('📌 PINNED')}</h2>
                    <Rows rows={front.pinned} onOpen={onOpen} />
                </section>
            )}
            {front.topics.map((tp) => {
                return (
                    <section key={tp.id} data-testid={`learn-topic-${tp.id}`}>
                        <h2 className="m-0 mb-2 flex flex-wrap items-baseline gap-x-2 text-sm font-extrabold text-nature-800 dark:text-nature-100">
                            <span aria-hidden="true">{topicEmoji(tp.id)}</span>
                            <span>{topicLabel(tp.id)}</span>
                            <span className={`text-xs font-bold ${MUTED}`}>{tp.count}</span>
                        </h2>
                        <Rows rows={tp.rows} onOpen={onOpen} />
                        {tp.count > tp.rows.length && (
                            <button type="button" data-testid={`learn-see-all-${tp.id}`} onClick={() => onTopic(tp.id)} className={LINK_BUTTON}>
                                {t('See all {n} ›', { n: tp.count })}
                            </button>
                        )}
                    </section>
                );
            })}
        </div>
    );
}

function TopicView({ topic, more, failed, onTopicAgain, moreFailed, moreLoading, onMore, onOpen }: {
    topic: string; more: { topic: string; rows: KnowledgeRow[]; next: number | null } | null; failed: boolean; onTopicAgain: () => void;
    moreFailed: boolean; moreLoading: boolean; onMore: () => void; onOpen: (id: string) => void;
}) {
    // The topic's first page: nothing is drawn yet, so the alert with Try again stands in the list's place.
    if (failed) return <Failed onAgain={onTopicAgain} />;
    if (!more || more.topic !== topic) return <p className={MUTED}>{t('Loading...')}</p>;
    return (
        <section data-testid="learn-topic-view">
            <h2 className="m-0 mb-2 flex items-baseline gap-x-2 text-sm font-extrabold text-nature-800 dark:text-nature-100">
                <span aria-hidden="true">{topicEmoji(topic)}</span>
                <span>{topicLabel(topic)}</span>
            </h2>
            <Rows rows={more.rows} onOpen={onOpen} />
            {/* A later page that failed: the rows read stay, and Try again asks for that page again. */}
            {moreFailed ? <Failed onAgain={onMore} />
            : more.next !== null && (
                <button type="button" data-testid="learn-show-more" onClick={onMore} disabled={moreLoading} aria-busy={moreLoading} className={`${LINK_BUTTON} disabled:cursor-wait disabled:opacity-60`}>
                    {moreLoading ? t('Loading...') : t('Show more')}
                </button>
            )}
        </section>
    );
}

// ── One page, whole ──────────────────────────────────────────────────────────────────────

function PageView({ id, preview, identity, samplePosts, onBack, onOpenProfile }: {
    id: string; preview: boolean; identity: BeanPoolIdentity | null; samplePosts: () => LearnPost[]; onBack: () => void; onOpenProfile: (pubkey: string) => void;
}) {
    const [state, setState] = useState<{ id: string; post: LearnPost | null } | 'failed' | null>(null);
    const [tries, setTries] = useState(0);
    const [photo, setPhoto] = useState<{ index: number; trigger: HTMLElement | null } | null>(null);
    const [reporting, setReporting] = useState(false);
    useEffect(() => {
        let live = true;
        setState(null);
        const read = preview ? Promise.resolve(samplePosts().find((p) => p.id === id) ?? null) : getLearnPost(id);
        read.then((post) => { if (live) setState({ id, post }); }, () => { if (live) setState('failed'); });
        return () => { live = false; };
    }, [id, preview, tries]);

    const header = <Header title={upperCase(t(KNOWLEDGE_NAMES.kind))} label onBack={onBack} />;
    if (state === 'failed') return <>{header}<Failed onAgain={() => setTries((n) => n + 1)} /></>;
    if (!state || state.id !== id) return <>{header}<p className={`mt-4 ${MUTED}`}>{t('Loading...')}</p></>;
    const post = state.post;
    if (!post) {
        return (
            <>
                {header}
                <p data-testid="learn-page-gone" className={`mt-4 ${MUTED}`}>{t("This page of Local knowledge isn't showing any more.")}</p>
                <button type="button" onClick={onBack} className={LINK_BUTTON}>{t('Back')}</button>
            </>
        );
    }

    const k = post.knowledge;
    const pinned = pinLive(post as never);
    // Only addresses the web's image allow-list lets through (lib/avatar.ts, PWA-2): a refused one is not drawn, never fetched.
    const photos = (post.photos ?? []).map((p) => (typeof p === 'string' ? resolveImageUrl(p) : null)).filter((p): p is string => !!p);
    const language = k.lang && k.lang !== shownLanguage() ? languageNameOf(k.lang) : null;
    const own = !!identity && post.authorPublicKey === identity.publicKey;
    // A preview names nobody and has nothing to report: it is Example Valley's.
    const writer = !preview && post.authorPublicKey !== '';
    const markedOn = k.outdatedAt ? new Date(k.outdatedAt).toLocaleDateString(shownLanguage(), { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    return (
        <>
            {header}
            <article data-testid="learn-post" className="flex flex-col gap-3 pt-2 pb-4">
                <div className="flex flex-wrap items-center gap-1">
                    <span data-testid="learn-post-topic" className={TOPIC_CHIP}>{upperCase(topicLabel(post.category))}</span>
                    {pinned && <span className={chip('pinned')}>{t('📌 PINNED')}</span>}
                </div>
                <h2 dir="auto" lang={k.lang ?? undefined} className="m-0 text-xl font-extrabold leading-snug text-nature-950 dark:text-white break-words">{post.title}</h2>
                {language && <p data-testid="learn-post-lang" className={`m-0 text-xs ${MUTED}`}>{t('Written in {language}', { language })}</p>}
                {k.outdatedAt && (
                    <div role="note" data-testid="learn-post-outdated" className="rounded-xl p-3 bg-bp-chip-warn-tint text-bp-chip-warn-ink">
                        <p className="m-0 font-bold">{t('This may be out of date.')}</p>
                        {k.outdatedNote && <p dir="auto" className="m-0 mt-1 text-sm break-words">{k.outdatedNote}</p>}
                        <p className="m-0 mt-1 text-xs">{t('Marked {date}', { date: markedOn })}</p>
                    </div>
                )}
                {/* Plain text with paragraphs: no markup and no links made of it (§2.2). */}
                <div dir="auto" lang={k.lang ?? undefined} data-testid="learn-post-body" className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-nature-900 dark:text-nature-50">{post.description}</div>
                {k.place && <p dir="auto" data-testid="learn-post-place" className="m-0 text-sm font-bold text-nature-800 dark:text-nature-100 break-words">{t('Where: {place}', { place: k.place })}</p>}

                {photos.length > 0 && (
                    <div data-testid="learn-post-photos" className="flex flex-col gap-2">
                        {photos.map((src, i) => (
                            <button key={`${i}-${src}`} type="button" onClick={(e) => setPhoto({ index: i, trigger: e.currentTarget })}
                                aria-label={t('View enlarged photo {n} of {total}: {title}', { n: i + 1, total: photos.length, title: post.title })}
                                className="p-0 border-0 bg-transparent cursor-pointer rounded-xl overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-learn">
                                <img src={src} alt="" loading="lazy" className="w-full aspect-[4/3] object-cover" />
                            </button>
                        ))}
                    </div>
                )}

                {k.sources.length > 0 && (
                    <section data-testid="learn-post-sources" className={PAGE_BOX}>
                        <h3 className={BOX_LABEL.muted}>{t('Sources')}</h3>
                        <ul className="m-0 p-0 list-none flex flex-col gap-1">
                            {k.sources.map((s, i) => {
                                const href = safeSourceUrl(s.url);
                                const host = sourceHost(s.url);
                                const inner = (
                                    <>
                                        <span className="min-w-0 flex-1">
                                            <span dir="auto" className="block font-bold text-sm break-words">{s.label || host}</span>
                                            <span className={`block text-xs break-all ${MUTED}`}>{host}</span>
                                        </span>
                                        {href && <span aria-hidden="true" className="shrink-0">↗</span>}
                                    </>
                                );
                                return (
                                    <li key={`${i}-${s.url}`}>
                                        {href ? (
                                            <a href={href} target="_blank" rel="noopener noreferrer" className="flex items-start gap-2 min-h-[44px] py-1 text-bp-ink-learn hover:underline">{inner}</a>
                                        ) : <div className="flex items-start gap-2 min-h-[44px] py-1">{inner}</div>}
                                    </li>
                                );
                            })}
                        </ul>
                    </section>
                )}

                <p data-testid="learn-post-checked" className={`m-0 text-sm font-bold ${MUTED}`}>{t('Checked {date}', { date: monthYear(k.checkedAt) })}</p>
                {k.gathered ? (
                    <p data-testid="learn-post-gathered" className="m-0 text-sm text-nature-800 dark:text-nature-100">
                        {t('Gathered with the assistant from the sources above. Checked by {name}.', { name: post.authorCallsign })}
                    </p>
                ) : writer && (
                    <section className={PAGE_BOX}>
                        <h3 className={BOX_LABEL.muted}>{t('Written by')}</h3>
                        <button type="button" data-testid="learn-post-writer" onClick={() => onOpenProfile(post.authorPublicKey)}
                            className="flex items-center gap-3 w-full min-h-[48px] text-start bg-transparent border-0 cursor-pointer rounded-xl p-1 -ms-1 hover:bg-oat-50/50 dark:hover:bg-black/20">
                            <MemberAvatar avatarUrl={post.authorAvatarUrl} pubkey={post.authorPublicKey} callsign={post.authorCallsign} size={40} />
                            <span className="min-w-0 font-bold text-base text-nature-950 dark:text-white break-words">{post.authorCallsign}</span>
                        </button>
                    </section>
                )}
                {/* K5 puts "This helped", Share, "Suggest a fix" and the writer's and admins' tools here; K8 "Thank {name}". */}
                <p className={`m-0 text-xs ${MUTED}`}>{t('Local knowledge is written by members. Check the source before you rely on it.')}</p>
                {writer && !own && identity && (
                    <button type="button" data-testid="learn-post-report" onClick={() => setReporting(true)}
                        className={`self-start inline-flex items-center min-h-[48px] px-0 bg-transparent border-0 cursor-pointer hover:underline ${PAGE_TYPE.report} ${PAGE_INK.danger} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 rounded`}>
                        {t('🚩 Report')}
                    </button>
                )}
            </article>
            {photo && <ImageLightbox isOpen photos={photos} initialIndex={photo.index} title={post.title} triggerElement={photo.trigger} onClose={() => setPhoto(null)} />}
            {reporting && identity && (
                <ReportModal isOpen onClose={() => setReporting(false)} reporterPubkey={identity.publicKey} targetPubkey={post.authorPublicKey}
                    targetName={post.authorCallsign} targetPostId={post.id} onReported={() => setReporting(false)} />
            )}
        </>
    );
}

