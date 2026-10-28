import { createRoot } from 'react-dom/client';
import { t } from '@beanpool/core';
import { UsePhoneAppCard } from '../src/components/UsePhoneAppCard';
import { BeanPoolSettingsGroup } from '../src/pages/SettingsPage';
import '../src/index.css';

const params = new URLSearchParams(window.location.search);
const view = params.get('view') || 'card';

if (params.get('dark') === '1') {
    document.documentElement.classList.add('dark');
} else {
    document.documentElement.classList.remove('dark');
}

const samplePhoneLater = [
    'To use BeanPool on your phone later: install the app, tap **Already a member**, choose **Global community** and type your 12 words.',
    'If you joined with Google, **Recover with Social** works too.',
];

function Harness() {
    if (view === 'card') {
        return (
            <div className="max-w-md mx-auto p-4">
                <UsePhoneAppCard publicKey="pk-sample-123" phoneLater={samplePhoneLater} />
            </div>
        );
    }

    if (view === 'settings') {
        return (
            <div className="max-w-md mx-auto p-4 bg-white dark:bg-nature-900 rounded-2xl shadow-sm border border-nature-200 dark:border-nature-800">
                <BeanPoolSettingsGroup onHelp={() => {}} onSuggest={() => {}} phoneLater={samplePhoneLater} />
            </div>
        );
    }

    if (view === 'faq') {
        return (
            <div className="max-w-md mx-auto p-4 bg-white dark:bg-nature-900 rounded-2xl shadow-sm border border-nature-200 dark:border-nature-800 text-nature-900 dark:text-white">
                <h4 style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '0.75rem', color: 'var(--text-secondary)' }}>
                    {t('❓ Frequently Asked Questions')}
                </h4>
                <div style={{ padding: '0.65rem 0' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.85rem', fontWeight: 600 }}>
                        <span>{t('Can I use this on my phone?')}</span>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', transform: 'rotate(90deg)' }}>▶</span>
                    </div>
                    <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5, marginTop: '0.4rem', textAlign: 'left' }}>
                        {t('Yes! On a phone, get the app from Google Play, the App Store, or beanpool.org/android. On a computer, open the app link in Chrome or Edge and choose Install in the address bar or the menu; in Safari on a Mac, choose File, then Add to Dock.')}
                    </p>
                </div>
            </div>
        );
    }

    return null;
}

createRoot(document.getElementById('root')!).render(<Harness />);
