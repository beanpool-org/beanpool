/**
 * "BeanPool: help and how it works" in the web app — the same members' sheet, manual and search as the member app,
 * from the same source (see lib/guide.ts). Opened from Settings → BeanPool → Help & how it works.
 *
 * Text is rendered as plain React text (bold is the only style): a copy fetched from beanpool.org can never inject
 * markup. Views: the sheet (with search), one section of the manual, one page. Back walks back through them.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
    FEEDBACK_LIVE, BEANPOOL_WEBSITE_URL, GUIDE_SLUGS,
    beanPoolSheetEntries, findGuidePage, findGuideSection, findGuideVideo, manualSections, relatedPages,
    searchGuide, sectionPages, splitBold,
    type GuidePage,
} from '@beanpool/core';
import { useGuide, useLearnVideos } from '../lib/guide';
import { getCommunityHealth } from '../lib/api';

type View = { kind: 'home' } | { kind: 'section'; id: string } | { kind: 'page'; slug: string };

interface Props {
    onBack: () => void;
    /** Opens the one Suggest-a-change screen. Only offered while FEEDBACK_LIVE is true. */
    onSuggest?: () => void;
    /** Defaults to FEEDBACK_LIVE; tests pass it to check both states. */
    feedbackLive?: boolean;
}

const card = 'bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800 shadow-sm overflow-hidden divide-y divide-nature-100 dark:divide-nature-800';
const rowBtn = 'w-full min-h-[56px] px-4 py-3 flex items-center gap-3 text-left bg-transparent border-none cursor-pointer hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors text-nature-900 dark:text-white no-underline';
const label = 'text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400 mb-2 mt-6 px-1';

function Rich({ text }: { text: string }) {
    return <>{splitBold(text).map((s, i) => (s.bold ? <strong key={i} className="font-bold text-nature-950 dark:text-white">{s.text}</strong> : <span key={i}>{s.text}</span>))}</>;
}

function Row({ title, sub, onClick, icon }: { title: string; sub?: string; onClick: () => void; icon?: string }) {
    return (
        <button type="button" onClick={onClick} className={rowBtn}>
            {icon && <span className="text-xl shrink-0" aria-hidden="true">{icon}</span>}
            <span className="flex-1 min-w-0">
                <span className="block text-[15px] font-bold break-words">{title}</span>
                {sub && <span className="block text-xs font-normal text-nature-500 dark:text-nature-400 mt-0.5 break-words">{sub}</span>}
            </span>
            <span className="text-nature-400 shrink-0" aria-hidden="true">›</span>
        </button>
    );
}

const SECTION_ICONS: Record<string, string> = {
    'getting-started': '🚩', market: '🤝', map: '🗺️', talk: '💬', pulse: '📡', commons: '🌱', ledger: '📊', settings: '⚙️',
};

function useCommunityStatus(): 'checking' | 'online' | 'offline' {
    const [status, setStatus] = useState<'checking' | 'online' | 'offline'>('checking');
    useEffect(() => {
        let alive = true;
        getCommunityHealth().then(() => { if (alive) setStatus('online'); }).catch(() => { if (alive) setStatus('offline'); });
        return () => { alive = false; };
    }, []);
    return status;
}

export function MemberGuide({ onBack, onSuggest, feedbackLive = FEEDBACK_LIVE }: Props) {
    const { guide, source } = useGuide();
    const [stack, setStack] = useState<View[]>([{ kind: 'home' }]);
    const [query, setQuery] = useState('');
    const topRef = useRef<HTMLDivElement>(null);
    const view = stack[stack.length - 1];
    const status = useCommunityStatus();
    const results = useMemo(() => searchGuide(guide, query), [guide, query]);
    const searching = query.trim().length >= 2;

    const go = (next: View) => setStack(s => [...s, next]);
    const back = () => (stack.length > 1 ? setStack(s => s.slice(0, -1)) : onBack());
    const openPage = (slug: string) => go({ kind: 'page', slug });

    useEffect(() => {
        try { topRef.current?.scrollIntoView?.({ block: 'start' }); } catch { /* not in every browser */ }
    }, [view]);

    const header = (
        <div className="flex items-center mb-4">
            <button type="button" onClick={back} className="min-h-[48px] min-w-[48px] px-2 text-nature-600 dark:text-nature-400 font-semibold text-sm cursor-pointer border-none bg-transparent hover:text-nature-900 dark:hover:text-white">
                ← Back
            </button>
            <h2 className="flex-1 text-center text-xl font-bold text-nature-950 dark:text-white tracking-tight m-0">BeanPool</h2>
            <div className="w-12" />
        </div>
    );

    let body: ReactNode;
    if (view.kind === 'page') {
        body = <GuidePageView slug={view.slug} openPage={openPage} openSection={id => go({ kind: 'section', id })} />;
    } else if (view.kind === 'section') {
        const section = findGuideSection(guide, view.id);
        body = !section ? (
            <p className="text-center text-nature-700 dark:text-nature-300 mt-8">This part of the guide is not available. Go back and pick another one.</p>
        ) : (
            <>
                <h1 className="text-2xl font-extrabold text-nature-950 dark:text-white m-0">{section.title}</h1>
                <p className="text-nature-600 dark:text-nature-300 mt-2 mb-4">{section.summary}</p>
                <div className={card}>
                    {sectionPages(guide, section).map(p => <Row key={p.slug} title={p.title} sub={p.summary} onClick={() => openPage(p.slug)} />)}
                </div>
            </>
        );
    } else {
        const about = [GUIDE_SLUGS.howItWorks, GUIDE_SLUGS.rules, GUIDE_SLUGS.faq]
            .map(s => findGuidePage(guide, s)).filter((p): p is GuidePage => p !== null);
        const whatsNew = findGuidePage(guide, GUIDE_SLUGS.whatsNew);
        body = (
            <>
                <label className="flex items-center gap-2 min-h-[48px] px-3 rounded-2xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900">
                    <span aria-hidden="true">🔍</span>
                    <input
                        type="search"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="Search the guide"
                        aria-label="Search the guide"
                        className="flex-1 min-w-0 min-h-[46px] bg-transparent border-none outline-none text-base text-nature-900 dark:text-white placeholder:text-nature-400"
                    />
                </label>

                {searching ? (
                    <>
                        <div className={label} aria-live="polite">
                            {results.length === 0 ? 'Nothing found' : `${results.length} ${results.length === 1 ? 'page' : 'pages'}`}
                        </div>
                        <div className={card}>
                            {results.length === 0
                                ? <p className="p-4 m-0 text-nature-700 dark:text-nature-300">No page has all of those words. Try one word, like "gift" or "vote".</p>
                                : results.map(r => <Row key={r.page.slug} title={r.page.title} sub={r.snippet} onClick={() => openPage(r.page.slug)} />)}
                        </div>
                    </>
                ) : (
                    <>
                        <div className={label}>Your community</div>
                        <div className={card}>
                            <div className="min-h-[56px] px-4 py-3 flex items-center gap-3">
                                <span className="text-xl shrink-0" aria-hidden="true">🏡</span>
                                <span className="flex-1 min-w-0">
                                    <span className="block text-[15px] font-bold text-nature-900 dark:text-white break-all">{globalThis.location?.host || 'This community'}</span>
                                    <span className="flex items-center gap-1.5 text-xs text-nature-500 dark:text-nature-400 mt-0.5">
                                        <span aria-hidden="true" className={`inline-block w-2.5 h-2.5 rounded-full ${status === 'online' ? 'bg-emerald-500' : status === 'offline' ? 'bg-red-500' : 'bg-nature-400'}`} />
                                        {status === 'online' ? 'Connected' : status === 'offline' ? "Can't reach it right now" : 'Checking the connection…'}
                                    </span>
                                </span>
                            </div>
                        </div>

                        <div className={label}>Guides</div>
                        <div className={card}>
                            {about.map((p, i) => <Row key={p.slug} icon={['📖', '⚖️', '❓'][i]} title={p.title} sub={p.summary} onClick={() => openPage(p.slug)} />)}
                        </div>

                        <div className={label}>How to use the app</div>
                        <div className={card}>
                            {manualSections(guide).map(s => (
                                <Row key={s.id} icon={SECTION_ICONS[s.id] ?? '📄'} title={s.title} sub={s.summary} onClick={() => go({ kind: 'section', id: s.id })} />
                            ))}
                        </div>

                        <div className={label}>The BeanPool project</div>
                        <div className={card}>
                            {beanPoolSheetEntries(feedbackLive).map(entry => {
                                if (entry === 'suggest') {
                                    return onSuggest ? <Row key={entry} icon="💬" title="Suggest a change" sub="Ideas and problems go to the BeanPool project team" onClick={onSuggest} /> : null;
                                }
                                if (entry === 'whats-new') {
                                    return whatsNew ? <Row key={entry} icon="🆕" title={whatsNew.title} sub={whatsNew.summary} onClick={() => openPage(whatsNew.slug)} /> : null;
                                }
                                return (
                                    <a key={entry} href={BEANPOOL_WEBSITE_URL} target="_blank" rel="noopener noreferrer" className={rowBtn}>
                                        <span className="text-xl shrink-0" aria-hidden="true">🌐</span>
                                        <span className="flex-1 min-w-0">
                                            <span className="block text-[15px] font-bold">beanpool.org</span>
                                            <span className="block text-xs font-normal text-nature-500 dark:text-nature-400 mt-0.5">The public website, to share with friends</span>
                                        </span>
                                        <span className="text-nature-400 shrink-0" aria-hidden="true">↗</span>
                                    </a>
                                );
                            })}
                        </div>

                        <p className="text-center text-xs text-nature-400 dark:text-nature-500 mt-6">
                            Guide version {guide.version}{source === 'bundled' ? ' · built into the app' : ' · updated from beanpool.org'}
                            <br />Works without a connection.
                        </p>
                    </>
                )}
            </>
        );
    }

    return (
        <div ref={topRef} className="flex justify-center p-4 min-h-screen page-surface transition-colors" data-testid="member-guide">
            <div className="max-w-3xl w-full mt-2 pb-32">
                {header}
                {body}
            </div>
        </div>
    );
}

function GuidePageView({ slug, openPage, openSection }: { slug: string; openPage: (slug: string) => void; openSection: (id: string) => void }) {
    const { guide } = useGuide();
    const videos = useLearnVideos();
    const page = findGuidePage(guide, slug);
    if (!page) return <p className="text-center text-nature-700 dark:text-nature-300 mt-8">This guide is not available. Go back and pick another one.</p>;
    const section = findGuideSection(guide, page.section);
    const video = findGuideVideo(page, videos);
    const related = relatedPages(guide, page);
    return (
        <article className="text-nature-800 dark:text-nature-200 text-base leading-relaxed">
            {section && (
                <button type="button" onClick={() => openSection(section.id)} className="min-h-[48px] p-0 bg-transparent border-none cursor-pointer text-xs font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                    {section.title}
                </button>
            )}
            <h1 className="text-2xl font-extrabold text-nature-950 dark:text-white m-0">{page.title}</h1>
            <p className="text-nature-600 dark:text-nature-300 mt-2">{page.summary}</p>
            {video && (
                <a href={video.url} target="_blank" rel="noopener noreferrer" className="mt-3 flex items-center gap-2 min-h-[48px] px-4 py-2 rounded-2xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900 font-semibold text-nature-900 dark:text-white no-underline">
                    <span aria-hidden="true">▶️</span>
                    <span className="flex-1 min-w-0 break-words">Watch: {video.title}</span>
                </a>
            )}
            {page.blocks.map((b, i) => {
                if (b.type === 'ul') return (
                    <ul key={i} className="mt-2 mb-0 pl-5 list-disc space-y-1.5">
                        {b.items.map((it, j) => <li key={j}><Rich text={it} /></li>)}
                    </ul>
                );
                if (b.type === 'h2') return <h2 key={i} className="text-xl font-bold text-nature-950 dark:text-white mt-7 mb-1"><Rich text={b.text} /></h2>;
                if (b.type === 'h3') return <h3 key={i} className="text-lg font-bold text-nature-950 dark:text-white mt-5 mb-1"><Rich text={b.text} /></h3>;
                return <p key={i} className="mt-2 mb-0"><Rich text={b.text} /></p>;
            })}
            {related.length > 0 && (
                <>
                    <h2 className={label + ' mt-8'}>Related</h2>
                    <div className={card}>
                        {related.map(r => <Row key={r.slug} title={r.title} sub={r.summary} onClick={() => openPage(r.slug)} />)}
                    </div>
                </>
            )}
        </article>
    );
}
