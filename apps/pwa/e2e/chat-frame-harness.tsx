/**
 * The Chat tab's top (slice T0, pages/ChatTabPage.tsx) for e2e/chat-frame-shots.mjs: the real ChatTabPage and the real
 * MessagesPage, in the look the driver stored, in `?lang=en|xx|<code>`. The driver answers the community's info (with or
 * without `forum`) and an empty conversation list; every other read is refused. Nothing here talks to a node.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { UiLang } from '@beanpool/core';
import { ChatTabPage } from '../src/pages/ChatTabPage';
import type { BeanPoolIdentity } from '../src/lib/identity';
import { useTheme } from '../src/lib/useTheme';
import { showLanguage } from '../src/lib/language';
import '../src/index.css';

const lang = new URLSearchParams(window.location.search).get('lang') ?? 'en';
const ME: BeanPoolIdentity = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64), callsign: 'Ana', createdAt: '2026-11-14T00:00:00Z' };

function Harness() {
    useTheme();
    const [ready, setReady] = useState(lang === 'en');
    useEffect(() => { if (lang !== 'en') void showLanguage(lang as UiLang).then(() => setReady(true)); }, []);
    if (!ready) return null;
    return <div data-ready="1"><ChatTabPage identity={ME} /></div>;
}

createRoot(document.getElementById('root')!).render(<Harness />);
