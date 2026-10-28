import { createRoot } from 'react-dom/client';
import { CommunityShapeModal } from '../src/components/CommunityShapeModal';
import { BeanPoolSettingsGroup } from '../src/pages/SettingsPage';
import { communityShapeSummary, type CommunityShapeFeatures } from '@beanpool/core';
import '../src/index.css';

const params = new URLSearchParams(window.location.search);
const view = params.get('view') || 'card';

if (params.get('dark') === '1') {
    document.documentElement.classList.add('dark', 'dark-theme');
} else {
    document.documentElement.classList.remove('dark', 'dark-theme');
}

const sampleFeatures: CommunityShapeFeatures = {
    door: 'members',
    knocks: true,
    privatePreview: true,
    beans: true,
    knownFloor: 1000,
    dmRequests: true,
    decisions: true,
    probation: true,
    autoHideReports: true,
    autoMute: true,
};

function Harness() {
    if (view === 'card') {
        const summary = communityShapeSummary(sampleFeatures);
        return (
            <div className="max-w-md mx-auto p-4 bg-white dark:bg-nature-900 rounded-2xl shadow-sm border border-nature-200 dark:border-nature-800 text-nature-900 dark:text-white">
                <div className="flex items-center gap-2 mb-3">
                    <span className="text-xl">🌱</span>
                    <h3 className="text-base font-semibold m-0 text-text-primary">Your community</h3>
                </div>
                <div className="mb-3 text-sm text-text-primary">
                    15 members · 5 trades this month · 500 Beans in the Commons
                </div>
                <button
                    type="button"
                    className="w-full text-left p-0 mb-3 bg-transparent border-none cursor-pointer flex items-center justify-between gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-lg"
                    data-testid="home-community-shape-summary"
                >
                    <span className="break-words">{summary}</span>
                    <span className="text-text-muted text-base shrink-0 select-none">›</span>
                </button>
            </div>
        );
    }

    if (view === 'modal') {
        return (
            <div className="relative min-h-[600px] w-full">
                <CommunityShapeModal
                    isOpen={true}
                    onClose={() => {}}
                    features={sampleFeatures}
                    onOpenGuide={() => {}}
                />
            </div>
        );
    }

    if (view === 'settings') {
        return (
            <div className="max-w-md mx-auto p-4 bg-white dark:bg-nature-900 rounded-2xl shadow-sm border border-nature-200 dark:border-nature-800">
                <BeanPoolSettingsGroup
                    onHelp={() => {}}
                    onSuggest={() => {}}
                    onOpenShape={() => {}}
                />
            </div>
        );
    }

    return null;
}

createRoot(document.getElementById('root')!).render(<Harness />);
