import { useState, useEffect, useMemo } from 'react';
import { 
    getCrowdfundProjects, createCrowdfundProject, pledgeToCrowdfundProject, 
    type CrowdfundProject, getAllMembers, request 
} from '../lib/api';
import { type BeanPoolIdentity } from '../lib/identity';
import { resolveAvatarUrl } from '../lib/avatar';

interface Props {
    identity: BeanPoolIdentity | null;
}

export function ProjectsPage({ identity }: Props) {
    const [projects, setProjects] = useState<CrowdfundProject[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    
    // UI States
    const [selectedProject, setSelectedProject] = useState<CrowdfundProject | null>(null);
    const [showNewProject, setShowNewProject] = useState(false);
    
    // New Project Form
    const [newTitle, setNewTitle] = useState('');
    const [newDescription, setNewDescription] = useState('');
    const [newGoal, setNewGoal] = useState<number | ''>('');
    const [newDeadline, setNewDeadline] = useState('');
    const [newPhotos, setNewPhotos] = useState<string[]>([]);
    const [creating, setCreating] = useState(false);
    
    // Pledge Form
    const [pledgeAmount, setPledgeAmount] = useState<number | ''>('');
    const [pledgeMemo, setPledgeMemo] = useState('');
    const [pledging, setPledging] = useState(false);

    const [isEditingProject, setIsEditingProject] = useState(false);
    const [editTitle, setEditTitle] = useState('');
    const [editDescription, setEditDescription] = useState('');
    const [editGoal, setEditGoal] = useState<number | ''>('');
    const [editDeadline, setEditDeadline] = useState('');
    const [editPhotos, setEditPhotos] = useState<string[]>([]);
    const [updating, setUpdating] = useState(false);
    const [deleting, setDeleting] = useState(false);

    // Profile Cache
    const [profiles, setProfiles] = useState<Record<string, { callsign: string, homeNodeUrl?: string }>>({});
    const [maxExpiryDays, setMaxExpiryDays] = useState<number>(365);

    const maxDateString = useMemo(() => {
        const d = new Date();
        d.setDate(d.getDate() + maxExpiryDays);
        return d.toISOString().split('T')[0];
    }, [maxExpiryDays]);

    const minDateString = useMemo(() => {
        return new Date().toISOString().split('T')[0];
    }, []);

    const fetchProjects = async () => {
        try {
            setLoading(true);
            const [data, members] = await Promise.all([
                getCrowdfundProjects(),
                getAllMembers()
            ]);
            setProjects(data.projects);
            if (data.maxProjectExpiryDays) setMaxExpiryDays(data.maxProjectExpiryDays);
            
            const profs: Record<string, { callsign: string, homeNodeUrl?: string }> = {};
            members.forEach(m => {
                profs[m.publicKey] = { callsign: m.callsign };
            });
            setProfiles(profs);
        } catch (err: any) {
            setError(err.message || 'Failed to fetch projects');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchProjects();
    }, []);

    const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files) return;
        
        Array.from(files).forEach((file) => {
            if (!file.type.startsWith('image/')) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                const base64 = event.target?.result as string;
                if (base64) {
                    setNewPhotos(prev => [...prev, base64].slice(0, 3)); // Max 3 photos
                }
            };
            // Resize image before uploading (basic implementation)
            reader.readAsDataURL(file); 
        });
        e.target.value = ''; // Reset
    };

    const handleEditPhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files) return;
        
        Array.from(files).forEach((file) => {
            if (!file.type.startsWith('image/')) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                const base64 = event.target?.result as string;
                if (base64) {
                    setEditPhotos(prev => [...prev, base64].slice(0, 3)); // Max 3 photos
                }
            };
            reader.readAsDataURL(file); 
        });
        e.target.value = ''; 
    };

    const submitNewProject = async () => {
        if (!identity) return;
        if (!newTitle.trim() || !newGoal || Number(newGoal) <= 0) return;
        
        let deadlineAt = null;
        if (newDeadline) {
            deadlineAt = new Date(newDeadline).toISOString();
        }

        setCreating(true);
        try {
            await createCrowdfundProject(identity.publicKey, newTitle, newDescription, newPhotos, Number(newGoal), deadlineAt);
            setShowNewProject(false);
            setNewTitle('');
            setNewDescription('');
            setNewGoal('');
            setNewDeadline('');
            setNewPhotos([]);
            fetchProjects();
        } catch (err: any) {
            alert(err.message || 'Failed to create project');
        } finally {
            setCreating(false);
        }
    };

    const submitPledge = async () => {
        if (!identity || !selectedProject) return;
        if (!pledgeAmount || Number(pledgeAmount) <= 0) return;

        setPledging(true);
        try {
            await pledgeToCrowdfundProject(selectedProject.id, identity.publicKey, Number(pledgeAmount), pledgeMemo);
            setPledgeAmount('');
            setPledgeMemo('');
            
            // Refresh instantly
            const { project } = await import('../lib/api').then(m => m.getCrowdfundProject(selectedProject.id));
            if (project) {
                setSelectedProject(project);
                setProjects(prev => prev.map(p => p.id === project.id ? project : p));
            }
        } catch (err: any) {
            alert(err.message || 'Pledge failed');
        } finally {
            setPledging(false);
        }
    };

    const startEditing = () => {
        if (!selectedProject) return;
        setEditTitle(selectedProject.title);
        setEditDescription(selectedProject.description || '');
        setEditGoal(selectedProject.goal_amount);
        setEditDeadline(selectedProject.deadline_at ? new Date(selectedProject.deadline_at).toISOString().split('T')[0] : '');
        try { setEditPhotos(JSON.parse(selectedProject.photos) || []); } catch { setEditPhotos([]); }
        setIsEditingProject(true);
    };

    const submitUpdateProject = async () => {
        if (!identity || !selectedProject) return;
        if (!editTitle.trim() || !editGoal || Number(editGoal) <= 0) return;

        let deadlineAt = null;
        if (editDeadline) {
            deadlineAt = new Date(editDeadline).toISOString();
        }

        setUpdating(true);
        try {
            const { project } = await import('../lib/api').then(m => m.updateCrowdfundProject(
                selectedProject.id,
                identity.publicKey,
                editTitle.trim(),
                editDescription.trim(),
                editPhotos,
                Number(editGoal),
                deadlineAt
            ));
            setSelectedProject(project);
            setProjects(prev => prev.map(p => p.id === project.id ? project : p));
            setIsEditingProject(false);
        } catch (err: any) {
            alert(err.message || 'Update failed');
        } finally {
            setUpdating(false);
        }
    };

    // Calculate progress helpers
    const getProgress = (current: number, goal: number) => Math.min(100, (current / goal) * 100);

    const getDaysRemaining = (deadline: string | null) => {
        if (!deadline) return null;
        const diff = new Date(deadline).getTime() - new Date().getTime();
        const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
        if (days < 0) return 'Expired';
        if (days === 0) return 'Ends today';
        return `${days} days left`;
    };

    return (
        <div className="flex flex-col h-full bg-bg-primary relative" style={{ overflowY: 'auto', paddingBottom: '4rem' }}>
            <header className="sticky top-0 z-40 bg-nature-900 border-b border-nature-800 p-4 shadow-sm flex flex-col gap-3">
                <div className="flex justify-between items-center">
                    <div>
                        <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
                            <span>🌱</span> Community Projects
                        </h1>
                        <p className="text-nature-400 text-sm mt-0.5">Crowdfund shared goals with Beans</p>
                    </div>
                    {identity && (
                        <button
                            onClick={() => setShowNewProject(true)}
                            className="bg-accent hover:bg-emerald-500 text-white px-4 py-2 rounded-xl font-bold text-sm shadow-md transition-all active:scale-95"
                        >
                            + Propose
                        </button>
                    )}
                </div>
            </header>

            {loading ? (
                <div className="p-8 text-center text-nature-500">Loading projects...</div>
            ) : error ? (
                <div className="p-8 text-center text-red-500">{error}</div>
            ) : projects.length === 0 ? (
                <div className="p-8 text-center text-nature-500">
                    <p className="mb-4">No projects have been proposed yet.</p>
                    <p className="text-4xl opacity-50">🌱</p>
                </div>
            ) : (
                <div className="p-4 flex flex-col gap-4">
                    {projects.map(project => {
                        const commonsAlloc = project.commons_allocation || 0;
                        const pledgeAmount = project.current_amount - commonsAlloc;
                        const progress = getProgress(project.current_amount, project.goal_amount);
                        const pledgeProgress = getProgress(pledgeAmount, project.goal_amount);
                        const commonsProgress = getProgress(commonsAlloc, project.goal_amount);
                        const isFunded = project.current_amount >= project.goal_amount;
                        const callsign = profiles[project.creator_pubkey]?.callsign || 'Unknown';
                        
                        let photosArr: string[] = [];
                        try { photosArr = JSON.parse(project.photos); } catch {}
                        // A2-19 (PWA-2): the project photo is server-controlled and is
                        // interpolated into a CSS url(); run it through the same
                        // allowlist/sanitizer as avatars (rejects scheme/CSS-breakout
                        // chars) so it can't break out of url() to inject CSS / a beacon.
                        const bgImage = photosArr.length > 0 ? resolveAvatarUrl(photosArr[0]) : null;

                        return (
                            <div 
                                key={project.id} 
                                onClick={() => setSelectedProject(project)}
                                className="bg-bg-card border border-border-secondary rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow cursor-pointer flex flex-col active:scale-[0.99]"
                            >
                                {/* Banner Image Strip */}
                                <div 
                                    className="h-24 w-full bg-nature-800 relative"
                                    style={{
                                        backgroundImage: bgImage ? `url("${bgImage}")` : 'none',
                                        backgroundSize: 'cover',
                                        backgroundPosition: 'center',
                                    }}
                                >
                                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
                                    {isFunded && (
                                        <div className="absolute top-2 right-2 bg-emerald-500 text-white text-xs font-bold px-2 py-1 rounded-md shadow-sm">
                                            🎉 FUNDED
                                        </div>
                                    )}
                                    <div className="absolute bottom-2 left-3 right-3 flex justify-between items-end">
                                        <h2 className="text-white font-bold tracking-tight text-lg line-clamp-1 flex-1 drop-shadow-md">{project.title}</h2>
                                    </div>
                                </div>
                                
                                <div className="p-4 flex flex-col gap-3">
                                    <p className="text-text-secondary text-sm line-clamp-2 leading-relaxed">
                                        {project.description || 'No description provided.'}
                                    </p>
                                    
                                    <div className="flex items-center text-xs text-nature-500 font-medium">
                                        <span>Proposed by <span className="text-accent">{callsign}</span></span>
                                    </div>

                                    {/* Progress Goal Bar */}
                                    <div className="mt-1">
                                        <div className="flex justify-between text-xs font-bold mb-1.5 items-end flex-wrap gap-1">
                                            <span className={isFunded ? 'text-emerald-500' : 'text-text-primary'}>
                                                {project.current_amount} B <span className="text-nature-500 font-normal">raised</span>
                                            </span>
                                            <div className="text-right">
                                                <span className="text-nature-500">Goal: {project.goal_amount} B</span>
                                                {project.deadline_at && (
                                                    <div className={`mt-0.5 text-[10px] ${getDaysRemaining(project.deadline_at) === 'Expired' ? 'text-red-500' : 'text-accent'}`}>{getDaysRemaining(project.deadline_at)}</div>
                                                )}
                                            </div>
                                        </div>
                                        <div className="h-2 w-full bg-nature-200 dark:bg-nature-800 rounded-full overflow-hidden flex">
                                            <div 
                                                className={`h-full transition-all duration-1000 ${isFunded ? 'bg-emerald-500' : 'bg-emerald-400'}`}
                                                style={{ width: `${pledgeProgress}%` }}
                                                title={`Pledges: ${pledgeAmount.toFixed(0)} B`}
                                            />
                                            {commonsAlloc > 0 && (
                                                <div 
                                                    className="h-full transition-all duration-1000 bg-blue-500"
                                                    style={{ width: `${commonsProgress}%` }}
                                                    title={`Commons: ${commonsAlloc.toFixed(0)} B`}
                                                />
                                            )}
                                        </div>
                                        {commonsAlloc > 0 && (
                                            <div className="flex items-center gap-3 mt-1.5 text-[10px] font-bold">
                                                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />Pledges</span>
                                                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />Commons</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* FULL SCREEN MODAL: New Project */}
            {showNewProject && (
                <div className="fixed inset-0 z-50 bg-bg-primary flex flex-col" style={{ overflowY: 'auto' }}>
                    <header className="sticky top-0 bg-nature-900 border-b border-nature-800 p-4 shadow-sm flex items-center justify-between z-10">
                        <h2 className="text-white font-bold text-lg">Propose Project</h2>
                        <button onClick={() => setShowNewProject(false)} className="p-2 text-nature-400 hover:text-white bg-nature-800 hover:bg-nature-700 rounded-full" aria-label="Close new project proposal">
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </header>
                    <div className="p-5 flex flex-col gap-4 flex-1">
                        <p className="text-sm text-nature-500 dark:text-nature-400">
                            Pitch an idea to the community. Beans pledged will be instantly credited to your account to fund the work.
                        </p>
                        
                        <div>
                            <label className="block text-xs font-bold text-nature-500 uppercase mb-1">Project Title</label>
                            <input 
                                value={newTitle} onChange={e => setNewTitle(e.target.value)}
                                className="w-full bg-bg-input border border-border-secondary p-3 rounded-xl text-text-primary focus:border-accent outline-none"
                                placeholder="E.g., Solar Panel Installation for Community Hall"
                                maxLength={100}
                            />
                        </div>
                        
                        <div>
                            <label className="block text-xs font-bold text-nature-500 uppercase mb-1">Funding Goal (Beans)</label>
                            <input 
                                type="number" value={newGoal} onChange={e => setNewGoal(e.target.value ? Number(e.target.value) : '')}
                                className="w-full bg-bg-input border border-border-secondary p-3 rounded-xl text-text-primary focus:border-accent outline-none font-mono text-lg"
                                placeholder="1000"
                                min="1"
                            />
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-nature-500 uppercase mb-1">Funding Deadline (Optional)</label>
                            <input 
                                type="date" value={newDeadline} onChange={e => setNewDeadline(e.target.value)}
                                className="w-full bg-bg-input border border-border-secondary p-3 rounded-xl text-text-primary focus:border-accent outline-none font-medium text-lg"
                                min={minDateString} max={maxDateString}
                            />
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-nature-500 uppercase mb-1">Description</label>
                            <textarea 
                                value={newDescription} onChange={e => setNewDescription(e.target.value)}
                                className="w-full bg-bg-input border border-border-secondary p-3 rounded-xl text-text-primary focus:border-accent outline-none resize-none h-32"
                                placeholder="Describe why this project matters and what the funds will be used for..."
                                maxLength={2000}
                            />
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-nature-500 uppercase mb-1">Photos (Up to 3)</label>
                            <div className="flex gap-2 overflow-x-auto pb-2">
                                {newPhotos.map((photo, i) => (
                                    <div key={i} className="relative w-24 h-24 shrink-0 rounded-lg overflow-hidden border border-border-secondary">
                                        <img src={photo} className="w-full h-full object-cover" alt={`Upload ${i}`} />
                                        <button 
                                            onClick={() => setNewPhotos(prev => prev.filter((_, idx) => idx !== i))}
                                            className="absolute top-1 right-1 bg-black/50 p-1 rounded-full text-white"
                                        >
                                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                            </svg>
                                        </button>
                                    </div>
                                ))}
                                {newPhotos.length < 3 && (
                                    <label className="w-24 h-24 shrink-0 rounded-lg border-2 border-dashed border-border-secondary flexflex-col items-center justify-center cursor-pointer hover:bg-bg-input transition-colors flex flex-col items-center justify-center">
                                        <svg className="w-6 h-6 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                        </svg>
                                        <input type="file" multiple accept="image/*" className="hidden" onChange={handlePhotoUpload} />
                                    </label>
                                )}
                            </div>
                        </div>

                        <div className="mt-8">
                            <button
                                onClick={submitNewProject}
                                disabled={creating || !newTitle.trim() || !newGoal || Number(newGoal) <= 0}
                                className={`w-full py-3.5 rounded-xl font-bold text-white shadow-md transition-all ${
                                    (creating || !newTitle.trim() || !newGoal || Number(newGoal) <= 0)
                                        ? 'bg-nature-300 dark:bg-nature-700 cursor-not-allowed opacity-70'
                                        : 'bg-accent hover:bg-emerald-500'
                                }`}
                            >
                                {creating ? 'Publishing...' : 'Propose Project'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* FULL SCREEN MODAL: Project Detail */}
            {selectedProject && (
                <div className="fixed inset-0 z-50 flex flex-col" style={{ backgroundColor: 'var(--bg-primary)', overflowY: 'auto' }}>
                    <header className="sticky top-0 bg-nature-900 border-b border-nature-800 p-3 shadow-md flex items-center gap-3 z-10 transition-colors">
                        <button onClick={() => { setSelectedProject(null); setIsEditingProject(false); }} className="p-2 text-nature-400 hover:text-white bg-nature-800 hover:bg-nature-700 rounded-full transition-colors" aria-label="Close project details">
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                            </svg>
                        </button>
                        <h2 className="text-white font-bold text-lg leading-tight flex-1 tracking-tight truncate">
                            {isEditingProject ? 'Edit Project' : 'Project Details'}
                        </h2>
                        {identity && identity.publicKey === selectedProject.creator_pubkey && !isEditingProject && (
                            <button onClick={startEditing} className="px-3 py-1.5 bg-nature-800 hover:bg-nature-700 text-nature-300 hover:text-white rounded-lg text-sm font-bold flex items-center gap-1.5 transition-colors shadow-sm cursor-pointer ml-auto active:scale-95 z-50 relative pointer-events-auto">
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                </svg>
                                Edit
                            </button>
                        )}
                    </header>
                    
                    <div className="flex-1 pb-24">
                        {isEditingProject ? (
                            <div className="p-5 flex flex-col gap-4">
                                {selectedProject.current_amount > 0 ? (
                                    <div className="p-4 bg-red-900/20 border border-red-500/30 rounded-xl flex items-start gap-3 shadow-sm">
                                        <span className="text-red-400 mt-0.5 text-lg">🔒</span>
                                        <p className="text-sm text-red-200 leading-relaxed font-medium">
                                            This project has already received community pledges. The funding goal is permanently locked to protect backers.
                                        </p>
                                    </div>
                                ) : (
                                    <div className="p-4 bg-accent/10 border border-accent/20 rounded-xl flex items-start gap-3 shadow-sm">
                                        <span className="text-accent mt-0.5 text-lg">ℹ️</span>
                                        <p className="text-sm text-emerald-100 leading-relaxed font-medium">
                                            You may edit the funding goal because no pledges have been made yet.
                                        </p>
                                    </div>
                                )}

                                <div>
                                    <label className="block text-xs font-bold text-nature-500 uppercase mb-1">Project Title</label>
                                    <input 
                                        value={editTitle} onChange={e => setEditTitle(e.target.value)}
                                        className="w-full bg-bg-input border border-border-secondary p-3 rounded-xl text-text-primary focus:border-accent outline-none font-medium shadow-inner"
                                        maxLength={100}
                                    />
                                </div>
                                
                                <div>
                                    <label className="block text-xs font-bold text-nature-500 uppercase mb-1">Funding Goal (Beans)</label>
                                    <input 
                                        type="number" value={editGoal} onChange={e => setEditGoal(e.target.value ? Number(e.target.value) : '')}
                                        className={`w-full bg-bg-input border border-border-secondary p-3 rounded-xl text-text-primary focus:border-accent outline-none font-mono text-lg shadow-inner ${selectedProject.current_amount > 0 ? 'opacity-50 cursor-not-allowed bg-nature-800' : ''}`}
                                        disabled={selectedProject.current_amount > 0}
                                        min="1"
                                    />
                                </div>

                                <div>
                                    <label className="block text-xs font-bold text-nature-500 uppercase mb-1">Funding Deadline (Optional)</label>
                                    <input 
                                        type="date" value={editDeadline} onChange={e => setEditDeadline(e.target.value)}
                                        className="w-full bg-bg-input border border-border-secondary p-3 rounded-xl text-text-primary focus:border-accent outline-none font-medium text-lg shadow-inner"
                                        min={minDateString} max={maxDateString}
                                    />
                                </div>

                                <div>
                                    <label className="block text-xs font-bold text-nature-500 uppercase mb-1">Description</label>
                                    <textarea 
                                        value={editDescription} onChange={e => setEditDescription(e.target.value)}
                                        className="w-full bg-bg-input border border-border-secondary p-3 rounded-xl text-text-primary focus:border-accent outline-none resize-none h-32 leading-relaxed shadow-inner"
                                        maxLength={2000}
                                    />
                                </div>

                                <div>
                                    <label className="block text-xs font-bold text-nature-500 uppercase mb-1">Photos (Up to 3)</label>
                                    <div className="flex gap-2 overflow-x-auto pb-2">
                                        {editPhotos.map((photo, i) => (
                                            <div key={i} className="relative w-24 h-24 shrink-0 rounded-xl overflow-hidden border border-border-secondary shadow-sm">
                                                <img src={photo} className="w-full h-full object-cover" alt={`Edit ${i}`} />
                                                <button 
                                                    onClick={() => setEditPhotos(prev => prev.filter((_, idx) => idx !== i))}
                                                    className="absolute top-1.5 right-1.5 bg-black/60 backdrop-blur-sm p-1.5 rounded-full text-white hover:bg-red-500/80 transition-colors"
                                                >
                                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                                    </svg>
                                                </button>
                                            </div>
                                        ))}
                                        {editPhotos.length < 3 && (
                                            <label className="w-24 h-24 shrink-0 rounded-xl border-2 border-dashed border-border-secondary flex items-center justify-center cursor-pointer hover:bg-bg-input transition-colors group">
                                                <svg className="w-8 h-8 text-nature-500 group-hover:text-accent transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                                </svg>
                                                <input type="file" multiple accept="image/*" className="hidden" onChange={handleEditPhotoUpload} />
                                            </label>
                                        )}
                                    </div>
                                </div>

                                <div className="mt-6 flex gap-3">
                                    <button 
                                        onClick={() => setIsEditingProject(false)}
                                        className="flex-1 py-3.5 rounded-xl font-bold bg-nature-800 text-white hover:bg-nature-700 transition-colors shadow-sm"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={submitUpdateProject}
                                        disabled={updating || !editTitle.trim() || !editGoal || Number(editGoal) <= 0}
                                        className={`flex-1 py-3.5 rounded-xl font-bold text-white shadow-md transition-all ${
                                            (updating || !editTitle.trim() || !editGoal || Number(editGoal) <= 0)
                                                ? 'bg-nature-300 dark:bg-nature-700 cursor-not-allowed opacity-70'
                                                : 'bg-accent hover:bg-emerald-500 hover:shadow-lg active:scale-95'
                                        }`}
                                    >
                                        {updating ? 'Saving...' : 'Save Changes'}
                                    </button>
                                </div>

                                <div className="mt-6 pt-6 border-t border-red-900/30">
                                    <button
                                        onClick={async () => {
                                            if (window.confirm("CRITICAL WARNING: This will immediately delete your project and automatically refund all current backers from the Trust Wallet. This action cannot be undone. Are you sure you want to proceed?")) {
                                                setDeleting(true);
                                                try {
                                                    await request('POST', '/api/crowdfund/projects/delete', { id: selectedProject.id, creatorPubkey: identity!.publicKey });
                                                    alert("Project deleted and funds refunded to backers.");
                                                    setIsEditingProject(false);
                                                    setSelectedProject(null);
                                                    fetchProjects();
                                                } catch (e: any) {
                                                    alert(e.message || "Failed to delete project");
                                                } finally {
                                                    setDeleting(false);
                                                }
                                            }
                                        }}
                                        disabled={deleting}
                                        className="w-full py-3.5 rounded-xl font-bold bg-red-900/20 text-red-500 border border-red-900/50 hover:bg-red-500 hover:text-white transition-colors"
                                    >
                                        {deleting ? 'Deleting...' : 'Delete Project & Refund Backers'}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <>
                                {/* Hero Images */}
                                {(() => {
                            let photosArr: string[] = [];
                            try { photosArr = JSON.parse(selectedProject.photos); } catch {}
                            
                            if (photosArr.length > 0) {
                                return (
                                    <div className="w-full flex overflow-x-auto snap-x snap-mandatory">
                                        {photosArr.map((photo, i) => (
                                            <div key={i} className="w-full shrink-0 snap-center h-64 bg-black relative">
                                                <img src={photo} className="w-full h-full object-cover" alt={`Project ${i}`} />
                                                <div className="absolute bottom-2 right-2 bg-black/60 backdrop-blur-md px-2 py-0.5 rounded text-white text-[10px] font-bold">
                                                    {i + 1} / {photosArr.length}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                );
                            }
                            return (
                                <div className="w-full h-32 bg-gradient-to-br from-nature-800 to-nature-900 flex items-center justify-center border-b border-border-secondary">
                                    <span className="text-5xl opacity-40 drop-shadow-md">🌱</span>
                                </div>
                            );
                        })()}

                        <div className="p-5 flex flex-col gap-6">
                            {/* Title & Creator */}
                            <div>
                                {selectedProject.current_amount >= selectedProject.goal_amount && (
                                    <div className="inline-block px-3 py-1 bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 font-bold text-xs rounded-full mb-3 border border-emerald-200 dark:border-emerald-800/50">
                                        🎉 SUCCESSFULLY FUNDED
                                    </div>
                                )}
                                <h1 className="text-2xl font-black text-text-primary tracking-tight leading-tight drop-shadow-sm mb-2">
                                    {selectedProject.title}
                                </h1>
                                <p className="text-sm font-medium text-nature-500">
                                    Proposed by <span className="text-accent underline decoration-accent/30 underline-offset-4">{profiles[selectedProject.creator_pubkey]?.callsign || 'Unknown'}</span>
                                </p>
                            </div>

                            {/* Progress Bar Large */}
                            <div className="bg-bg-card p-5 rounded-2xl border border-border-secondary shadow-sm mt-2">
                                <div className="flex items-start justify-between gap-4 mb-3 flex-wrap">
                                    <div className="flex flex-col gap-1">
                                        <span className={`text-3xl font-black ${selectedProject.current_amount >= selectedProject.goal_amount ? 'text-emerald-500' : 'text-text-primary'} drop-shadow-sm`}>
                                            {selectedProject.current_amount} <span className="text-sm font-bold text-nature-500">B raised</span>
                                        </span>
                                        <span className="text-sm font-bold text-nature-500">
                                            Goal: <span className="text-text-primary">{selectedProject.goal_amount} B</span>
                                        </span>
                                    </div>
                                    {selectedProject.deadline_at && (
                                        <div className={`font-bold text-sm px-3 py-1.5 rounded-lg border shadow-sm whitespace-nowrap ${getDaysRemaining(selectedProject.deadline_at) === 'Expired' ? 'bg-red-500/10 text-red-500 border-red-500/20' : 'bg-accent/10 text-accent border-accent/20'}`}>
                                            ⏳ {getDaysRemaining(selectedProject.deadline_at)}
                                        </div>
                                    )}
                                </div>
                                
                                <div className="h-3 w-full bg-nature-200 dark:bg-nature-800 rounded-full overflow-hidden shadow-inner mb-3">
                                    <div 
                                        className={`h-full transition-all duration-1000 ${selectedProject.current_amount >= selectedProject.goal_amount ? 'bg-emerald-500' : 'bg-gradient-to-r from-accent to-emerald-400'}`}
                                        style={{ width: `${getProgress(selectedProject.current_amount, selectedProject.goal_amount)}%` }}
                                    />
                                </div>

                                <p className="text-[11px] text-nature-500 leading-relaxed bg-nature-900/30 p-2.5 rounded-lg border border-border-secondary">
                                    🔒 <span className="font-bold text-nature-400">Held in Trust:</span> Pledges are securely held in a Trust Wallet and only released when the goal is met. If deleted, Beans are automatically refunded.
                                </p>
                            </div>

                            {/* Description */}
                            <div>
                                <h3 className="text-lg font-bold text-text-primary mb-2">About the Project</h3>
                                <p className="text-text-secondary leading-relaxed whitespace-pre-wrap">
                                    {selectedProject.description || 'No description provided.'}
                                </p>
                            </div>
                            </div>
                            </>
                        )}
                    </div>

                    {/* Pledge Sticky Footer */}
                    {identity?.publicKey !== selectedProject.creator_pubkey && !isEditingProject && (
                        <div className="fixed bottom-0 left-0 right-0 bg-bg-card border-t border-border-secondary p-4 shadow-[0_-10px_20px_rgba(0,0,0,0.05)] dark:shadow-[0_-5px_20px_rgba(0,0,0,0.5)] z-20">
                            <div className="max-w-md mx-auto">
                                <div className="flex gap-2">
                                    <input 
                                        type="number" 
                                        value={pledgeAmount}
                                        onChange={e => setPledgeAmount(e.target.value ? Number(e.target.value) : '')}
                                        placeholder="Amount"
                                        className="w-24 bg-bg-input border border-border-secondary rounded-xl text-center font-black text-lg focus:border-accent outline-none shadow-inner text-nature-900 dark:text-white p-2.5"
                                        style={{ color: '#1a1a1a' }}
                                    />
                                    <input 
                                        type="text"
                                        value={pledgeMemo}
                                        onChange={e => setPledgeMemo(e.target.value)}
                                        placeholder="Optional memo..."
                                        className="flex-1 bg-bg-input border border-border-secondary rounded-xl px-3 py-2.5 focus:border-accent outline-none text-sm text-nature-900 dark:text-white"
                                        style={{ color: '#1a1a1a' }}
                                    />
                                </div>
                                <button
                                    onClick={submitPledge}
                                    disabled={pledging || !pledgeAmount || Number(pledgeAmount) <= 0}
                                    className={`w-full mt-3 py-3.5 rounded-xl font-bold text-white shadow-md transition-all ${
                                        (pledging || !pledgeAmount || Number(pledgeAmount) <= 0)
                                            ? 'bg-nature-300 dark:bg-nature-700 cursor-not-allowed opacity-70'
                                            : 'bg-accent hover:bg-emerald-500 hover:shadow-lg active:scale-[0.98]'
                                    }`}
                                >
                                    {pledging ? 'Sending Pledge...' : 'Pledge Beans 🌱'}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
