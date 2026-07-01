/**
 * CategoryPickerModal — Grid-based category picker for PWA
 *
 * Web equivalent of Native CategoryPickerSheet.
 * Bottom-sheet on mobile, centered modal on desktop.
 * 4-column grid with emoji + label per category.
 */

const CATEGORIES = [
    { id: 'all', emoji: '🏷️', label: 'All' },
    { id: 'food', emoji: '🥕', label: 'Food' },
    { id: 'services', emoji: '🤝', label: 'Services' },
    { id: 'labour', emoji: '👷', label: 'Labour' },
    { id: 'tools', emoji: '🛠️', label: 'Tools' },
    { id: 'goods', emoji: '📦', label: 'Goods' },
    { id: 'garden', emoji: '🌻', label: 'Garden' },
    { id: 'housing', emoji: '🏠', label: 'Housing' },
    { id: 'transport', emoji: '🚗', label: 'Transport' },
    { id: 'education', emoji: '📚', label: 'Education' },
    { id: 'arts', emoji: '🎨', label: 'Arts' },
    { id: 'health', emoji: '🌿', label: 'Health' },
    { id: 'care', emoji: '❤️', label: 'Care' },
    { id: 'animals', emoji: '🐾', label: 'Animals' },
    { id: 'tech', emoji: '💻', label: 'Tech' },
    { id: 'energy', emoji: '☀️', label: 'Energy' },
    { id: 'general', emoji: '🌱', label: 'General' },
];

interface CategoryPickerModalProps {
    visible: boolean;
    selected: string;
    onSelect: (categoryId: string) => void;
    onClose: () => void;
}

export function CategoryPickerModal({ visible, selected, onSelect, onClose }: CategoryPickerModalProps) {
    if (!visible) return null;

    return (
        <div
            className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={onClose}
        >
            <div
                className="bg-white dark:bg-nature-950 w-full sm:w-[90vw] sm:max-w-md rounded-t-3xl sm:rounded-3xl shadow-2xl p-6 pb-10 sm:pb-6 max-h-[60vh] overflow-y-auto animate-in slide-in-from-bottom-full sm:slide-in-from-bottom-10 duration-300"
                onClick={e => e.stopPropagation()}
            >
                {/* Handle bar (mobile) */}
                <div className="w-10 h-1 rounded-full bg-nature-300 dark:bg-nature-700 mx-auto mb-4 sm:hidden" />

                <h3 className="text-lg font-black text-nature-900 dark:text-white text-center mb-5">Category</h3>

                <div className="grid grid-cols-4 gap-3">
                    {CATEGORIES.map(cat => {
                        const isActive = selected === cat.id;
                        return (
                            <button
                                key={cat.id}
                                onClick={() => { onSelect(cat.id); onClose(); }}
                                className={`flex flex-col items-center justify-center py-3 rounded-2xl border-[1.5px] transition-all ${
                                    isActive
                                        ? 'bg-indigo-50 dark:bg-indigo-900/30 border-indigo-400 dark:border-indigo-600'
                                        : 'bg-nature-50 dark:bg-nature-900 border-nature-200 dark:border-nature-800 hover:bg-nature-100 dark:hover:bg-nature-800'
                                }`}
                            >
                                <span className="text-2xl mb-1">{cat.emoji}</span>
                                <span className={`text-[11px] font-bold ${
                                    isActive
                                        ? 'text-indigo-700 dark:text-indigo-300'
                                        : 'text-nature-500 dark:text-nature-400'
                                }`}>
                                    {cat.label}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
