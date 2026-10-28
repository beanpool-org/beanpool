import { createRoot } from 'react-dom/client';
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

    return null;
}

createRoot(document.getElementById('root')!).render(<Harness />);
