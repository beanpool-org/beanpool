/**
 * "Finish your profile first" prompt — shown when a member tries to list or
 * accept without a name + photo. Routes them into the setup wizard.
 */
interface Props {
    message: string;
    onSetup: () => void;
    onClose: () => void;
}

export function ProfileGateModal({ message, onSetup, onClose }: Props) {
    return (
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-6"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
        >
            <div
                className="bg-white dark:bg-nature-900 rounded-2xl shadow-xl max-w-sm w-full p-6"
                onClick={(e) => e.stopPropagation()}
            >
                <h3 className="text-lg font-bold text-nature-950 dark:text-white mb-2">Finish your profile first</h3>
                <p className="text-sm text-nature-600 dark:text-nature-400 mb-5 leading-relaxed">{message}</p>
                <div className="flex gap-3">
                    <button
                        onClick={onClose}
                        className="flex-1 py-3 rounded-xl border border-nature-200 dark:border-nature-700 text-nature-700 dark:text-nature-200 font-semibold cursor-pointer bg-transparent hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors"
                    >
                        Not now
                    </button>
                    <button
                        onClick={onSetup}
                        className="flex-1 py-3 rounded-xl bg-nature-900 dark:bg-white text-white dark:text-nature-900 font-bold cursor-pointer border-none hover:opacity-90 transition-opacity"
                    >
                        Set up profile
                    </button>
                </div>
            </div>
        </div>
    );
}

export default ProfileGateModal;
