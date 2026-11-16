/**
 * Forum links on the web (slice F9) for e2e/forum-links-shots.mjs: the real ForumPage opened on a topic whose chips are a
 * shown group, a placeholder listing, "Posted as a Need ›" and a shown event (each as the node would answer), with the real
 * Link sheet one tap away; under it, the real "Talked about in the forum" block a listing shows. In the look the driver
 * stored and `?lang=en|xx|<code>`. The driver answers the forum's reads; nothing here talks to a node.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { UiLang } from '@beanpool/core';
import { ForumPage } from '../src/pages/ForumPage';
import { ForumLinkSheet, ForumLinkedTopics, LINK_WORDS } from '../src/components/forum/ForumLinks';
import { useTheme } from '../src/lib/useTheme';
import { showLanguage } from '../src/lib/language';
import { t } from '@beanpool/core';
import '../src/index.css';

const params = new URLSearchParams(window.location.search);
const lang = params.get('lang') ?? 'en';
// `sheet=1`: the Link sheet open over it, as the topic's writer sees it (one thing linked, room for two more).
const sheet = params.get('sheet') === '1';
const ME = 'a'.repeat(64);
// One object for the page's life, as App holds its door in state: a new one each render would open the topic again.
const DOOR = { topic: 'ft-1' };

function Harness() {
    useTheme();
    const [ready, setReady] = useState(lang === 'en');
    useEffect(() => { if (lang !== 'en') void showLanguage(lang as UiLang).then(() => setReady(true)); }, []);
    if (!ready) return null;
    return (
        <div data-ready="1" className="p-4 flex flex-col gap-6">
            <ForumPage me={ME} door={DOOR}onNavigate={() => {}} onMakeNeed={() => {}} />
            <div data-testid="listing-side" className="flex flex-col gap-2">
                <ForumLinkedTopics kind="listing" id="n-1" heading={t(LINK_WORDS.talkedAbout)} onOpenTopic={() => {}} />
            </div>
            {sheet && (
                <ForumLinkSheet me={ME} linked={[{ kind: 'group', id: 'g-1', title: 'Riverside community garden working group' }]} room={2}
                    onPick={async () => {}} onTakeOff={async () => {}} onClose={() => {}} />
            )}
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
