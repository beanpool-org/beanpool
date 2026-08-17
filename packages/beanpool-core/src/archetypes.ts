/**
 * Community Working Style & Archetype Engine
 *
 * Grounded in the 9 collaborative energies (Enneagram dynamics), translated
 * into positive, actionable community roles. Avoids raw numbers or clinical labels.
 */

export type ArchetypeKey =
    | 'weaver'      // Type 1 - Principled, craft-focused, brings structure and quality
    | 'connector'   // Type 2 - Warm, empathetic, mutual-aid champion
    | 'catalyst'    // Type 3 - Goal-oriented, energetic, moves projects forward
    | 'artisan'     // Type 4 - Creative, expressive, values authenticity and depth
    | 'sage'        // Type 5 - Analytical, thoughtful, designs tools and systems
    | 'guardian'    // Type 6 - Reliable, loyal, builds trust and community safety
    | 'spark'       // Type 7 - Visionary, enthusiastic, generates fresh ideas
    | 'champion'    // Type 8 - Protective, decisive, advocates for fairness
    | 'harmonizer'; // Type 9 - Receptive, peacemaker, bridges diverse viewpoints

export interface ArchetypeInfo {
    key: ArchetypeKey;
    name: string;
    emoji: string;
    tagline: string;
    description: string;
    superpowers: string[];
    collaborationStyle: string;
    idealPartners: ArchetypeKey[];
    communicationTip: string;
}

export const ARCHETYPES: Record<ArchetypeKey, ArchetypeInfo> = {
    weaver: {
        key: 'weaver',
        name: 'The Weaver',
        emoji: '🏛️',
        tagline: 'Craft, Quality & Purpose',
        description: 'You bring thoughtful craftsmanship and structure to community initiatives. You care deeply about doing things well and setting up durable foundations.',
        superpowers: [
            'Turning loose ideas into structured, high-quality plans',
            'Spotting ways to improve shared processes and agreements',
            'Bringing reliability, precision, and follow-through',
        ],
        collaborationStyle: 'Values clear expectations, honest feedback, and well-thought-out workflows.',
        idealPartners: ['spark', 'harmonizer', 'connector'],
        communicationTip: 'Appreciates clarity and attention to detail upfront.',
    },
    connector: {
        key: 'connector',
        name: 'The Connector',
        emoji: '🤝',
        tagline: 'Warmth, Empathy & Mutual Aid',
        description: 'You naturally notice the human side of every project. You connect people who need help with people who can offer it, fostering a welcoming, supportive culture.',
        superpowers: [
            'Intuitive sense for who needs support or encouragement',
            'Weaving strong social bonds across community members',
            'Energizing mutual aid and cooperative exchanges',
        ],
        collaborationStyle: 'Thrives in collaborative, relational environments where people check in on each other.',
        idealPartners: ['weaver', 'sage', 'champion'],
        communicationTip: 'Values personal warmth and acknowledging shared contributions.',
    },
    catalyst: {
        key: 'catalyst',
        name: 'The Catalyst',
        emoji: '⚡',
        tagline: 'Momentum, Drive & Progress',
        description: 'You are energized by getting things off the ground. You break down complex goals into milestones and keep community momentum moving forward.',
        superpowers: [
            'Transforming discussions into actionable milestones',
            'Unblocking logjams and keeping energy high',
            'Adapting quickly to changing needs and resources',
        ],
        collaborationStyle: 'Enjoys dynamic, goal-oriented teamwork with tangible outcomes.',
        idealPartners: ['sage', 'harmonizer', 'artisan'],
        communicationTip: 'Prefers efficient updates and clear, actionable next steps.',
    },
    artisan: {
        key: 'artisan',
        name: 'The Artisan',
        emoji: '🎨',
        tagline: 'Creativity, Depth & Authenticity',
        description: 'You bring soul, aesthetic care, and original perspective to whatever you touch. You help the community stay true to its unique identity and deeper purpose.',
        superpowers: [
            'Infusing projects with authentic meaning and creative flair',
            'Seeing unique possibilities others might overlook',
            'Creating inspiring spaces, stories, and cultural touchpoints',
        ],
        collaborationStyle: 'Works best when there is room for authentic expression and genuine connection.',
        idealPartners: ['catalyst', 'guardian', 'weaver'],
        communicationTip: 'Values sincere, thoughtful listening over rushed transactions.',
    },
    sage: {
        key: 'sage',
        name: 'The Sage',
        emoji: '🧭',
        tagline: 'Insight, Systems & Deep Knowledge',
        description: 'You love understanding how things work beneath the surface. You research, design tools, and bring clarity to complex systems so everyone benefits.',
        superpowers: [
            'Synthesizing complex information into practical insights',
            'Designing scalable tools, guides, and decentralized systems',
            'Providing calm, objective analysis in uncertain situations',
        ],
        collaborationStyle: 'Prefers having space to think deeply and communicate asynchronously.',
        idealPartners: ['spark', 'connector', 'champion'],
        communicationTip: 'Appreciates well-structured information and respect for thinking time.',
    },
    guardian: {
        key: 'guardian',
        name: 'The Guardian',
        emoji: '🛡️',
        tagline: 'Loyalty, Trust & Resilience',
        description: 'You are the community anchor. You anticipate hurdles, protect shared resources, and build the trust networks that keep the ecosystem secure.',
        superpowers: [
            'Anticipating risks and preparing backup solutions',
            'Fierce loyalty to community members and shared commitments',
            'Building reliable, long-lasting trust circles',
        ],
        collaborationStyle: 'Thrives when there is mutual transparency and dependable follow-through.',
        idealPartners: ['artisan', 'spark', 'harmonizer'],
        communicationTip: 'Values predictability, honesty, and clear commitments.',
    },
    spark: {
        key: 'spark',
        name: 'The Spark',
        emoji: '✨',
        tagline: 'Vision, Possibility & Optimism',
        description: 'You bring creative energy and contagious enthusiasm. You love exploring new horizons, initiating fresh community projects, and connecting unexpected ideas.',
        superpowers: [
            'Igniting fresh excitement and rallying interest',
            'Synthesizing cross-disciplinary ideas into novel initiatives',
            'Keeping morale high with optimism and playful curiosity',
        ],
        collaborationStyle: 'Thrives in open, exploratory projects with creative freedom.',
        idealPartners: ['weaver', 'sage', 'guardian'],
        communicationTip: 'Enjoys brainstorming and exploring what could be possible.',
    },
    champion: {
        key: 'champion',
        name: 'The Champion',
        emoji: '🪵',
        tagline: 'Advocacy, Courage & Direct Action',
        description: 'You stand up for fairness and aren\'t afraid of tough challenges. You protect vulnerable members, cut through red tape, and get things done.',
        superpowers: [
            'Cutting through ambiguity with decisive, candid leadership',
            'Advocating fiercely for community equity and fairness',
            'Taking on heavy lifts when urgent action is needed',
        ],
        collaborationStyle: 'Prefers direct, transparent communication and people who stand behind their word.',
        idealPartners: ['harmonizer', 'connector', 'sage'],
        communicationTip: 'Values straight talk, courage, and direct clarity.',
    },
    harmonizer: {
        key: 'harmonizer',
        name: 'The Harmonizer',
        emoji: '🕊️',
        tagline: 'Balance, Consensus & Flow',
        description: 'You create calm, inclusive spaces where everyone feels heard. You balance different viewpoints, resolve tension, and help the community stay united.',
        superpowers: [
            'Unifying diverse opinions into common ground',
            'Bringing grounding calm to stressful or high-stakes moments',
            'Ensuring quiet voices and unseen needs are included',
        ],
        collaborationStyle: 'Thrives in collaborative, respectful spaces that value patience and harmony.',
        idealPartners: ['champion', 'catalyst', 'weaver'],
        communicationTip: 'Values patient listening and avoiding unnecessary pressure.',
    },
};

export interface QuizQuestion {
    id: string;
    prompt: string;
    scenario?: string;
    options: {
        text: string;
        emoji?: string;
        target: ArchetypeKey;
    }[];
}

/** 9-Question Quick Spark Quiz (Takes ~60 seconds) */
export const QUICK_SPARK_QUESTIONS: QuizQuestion[] = [
    {
        id: 'q1',
        prompt: 'When a new community project kicks off, where do you naturally jump in?',
        options: [
            { text: 'Organizing logistics, checklists, and quality standards', emoji: '🏛️', target: 'weaver' },
            { text: 'Welcoming members and seeing who needs support', emoji: '🤝', target: 'connector' },
            { text: 'Setting clear milestones and rallying quick momentum', emoji: '⚡', target: 'catalyst' },
        ],
    },
    {
        id: 'q2',
        prompt: 'How do you prefer to bring value to a shared effort?',
        options: [
            { text: 'Crafting the creative identity, story, and meaningful details', emoji: '🎨', target: 'artisan' },
            { text: 'Researching the best tools, systems, and technical approaches', emoji: '🧭', target: 'sage' },
            { text: 'Identifying potential roadblocks and building trust among the team', emoji: '🛡️', target: 'guardian' },
        ],
    },
    {
        id: 'q3',
        prompt: 'What kind of contribution brings you the most energy?',
        options: [
            { text: 'Brainstorming fresh ideas and exploring possibilities', emoji: '✨', target: 'spark' },
            { text: 'Tackling tough challenges and making decisive things happen', emoji: '🪵', target: 'champion' },
            { text: 'Bringing people together to find peaceful, shared consensus', emoji: '🕊️', target: 'harmonizer' },
        ],
    },
    {
        id: 'q4',
        prompt: 'When collaborating with neighbours on a marketplace deal or project, you appreciate when:',
        options: [
            { text: 'Agreements are precise, tidy, and followed through with care', emoji: '🏛️', target: 'weaver' },
            { text: 'Communication is warm, personal, and mutually caring', emoji: '🤝', target: 'connector' },
            { text: 'Things move efficiently without getting bogged down in endless talk', emoji: '⚡', target: 'catalyst' },
        ],
    },
    {
        id: 'q5',
        prompt: 'If a challenge or disagreement arises in a group, your instinct is to:',
        options: [
            { text: 'Listen to everyone patiently and find common ground', emoji: '🕊️', target: 'harmonizer' },
            { text: 'Address the issue directly and advocate for fairness', emoji: '🪵', target: 'champion' },
            { text: 'Take a step back to analyze the root causes and data', emoji: '🧭', target: 'sage' },
        ],
    },
    {
        id: 'q6',
        prompt: 'In community meetings or group discussions, you often find yourself:',
        options: [
            { text: 'Sharing creative solutions or inspiring new directions', emoji: '✨', target: 'spark' },
            { text: 'Making sure plans are safe, realistic, and dependable', emoji: '🛡️', target: 'guardian' },
            { text: 'Ensuring the project stays true to its authentic purpose and heart', emoji: '🎨', target: 'artisan' },
        ],
    },
    {
        id: 'q7',
        prompt: 'What gives you the deepest sense of satisfaction at the end of a busy week?',
        options: [
            { text: 'Knowing work was done thoroughly, cleanly, and properly', emoji: '🏛️', target: 'weaver' },
            { text: 'Knowing you brightened someone’s day or helped someone out', emoji: '🤝', target: 'connector' },
            { text: 'Checking key milestones off the list and seeing tangible results', emoji: '⚡', target: 'catalyst' },
        ],
    },
    {
        id: 'q8',
        prompt: 'When exploring new tools or resources for the community, you love to:',
        options: [
            { text: 'Deep-dive into documentation and understand how it works', emoji: '🧭', target: 'sage' },
            { text: 'Dream up exciting new ways the community can use it', emoji: '✨', target: 'spark' },
            { text: 'Ensure the tool is secure and protects members\' privacy', emoji: '🛡️', target: 'guardian' },
        ],
    },
    {
        id: 'q9',
        prompt: 'What principle matters most to you in local cooperation?',
        options: [
            { text: 'Standing strong for fairness and standing up for others', emoji: '🪵', target: 'champion' },
            { text: 'Creating an atmosphere of peace, patience, and inclusion', emoji: '🕊️', target: 'harmonizer' },
            { text: 'Cultivating authentic beauty, expression, and uniqueness', emoji: '🎨', target: 'artisan' },
        ],
    },
];

/** 27-Question Deep Resonance Quiz (Takes ~3-4 mins for deep nuance) */
export const DEEP_RESONANCE_QUESTIONS: QuizQuestion[] = [
    // Weaver cluster (1)
    {
        id: 'd1',
        prompt: 'I naturally spot what needs improvement in a process and care about getting details right.',
        options: [
            { text: 'Strongly describes me', target: 'weaver' },
            { text: 'Somewhat describes me', target: 'weaver' },
            { text: 'Not my primary focus', target: 'harmonizer' },
        ],
    },
    {
        id: 'd2',
        prompt: 'I feel most comfortable when expectations, roles, and guidelines are clearly defined.',
        options: [
            { text: 'Definitely agree', target: 'weaver' },
            { text: 'Sometimes agree', target: 'guardian' },
            { text: 'I prefer open, flexible fluidity', target: 'spark' },
        ],
    },
    {
        id: 'd3',
        prompt: 'In shared projects, I am often the one ensuring our work meets high craft and ethical standards.',
        options: [
            { text: 'Yes, very much so', target: 'weaver' },
            { text: 'I focus more on the big picture', target: 'spark' },
            { text: 'I focus more on how people feel', target: 'connector' },
        ],
    },

    // Connector cluster (2)
    {
        id: 'd4',
        prompt: 'I quickly sense when someone in the community is feeling left out or overwhelmed.',
        options: [
            { text: 'Always — I notice people right away', target: 'connector' },
            { text: 'Sometimes, if I know them well', target: 'harmonizer' },
            { text: 'I focus more on the task at hand', target: 'catalyst' },
        ],
    },
    {
        id: 'd5',
        prompt: 'Helping neighbours and contributing to mutual aid gives me real joy and energy.',
        options: [
            { text: 'A core part of who I am', target: 'connector' },
            { text: 'I enjoy helping when asked', target: 'guardian' },
            { text: 'I prefer contributing through ideas or tools', target: 'sage' },
        ],
    },
    {
        id: 'd6',
        prompt: 'I place a high value on warm, appreciative, and considerate communication.',
        options: [
            { text: 'Strongly agree', target: 'connector' },
            { text: 'I value clarity above all', target: 'champion' },
            { text: 'I value authenticity and depth', target: 'artisan' },
        ],
    },

    // Catalyst cluster (3)
    {
        id: 'd7',
        prompt: 'I am motivated by setting tangible goals and seeing steady, measurable progress.',
        options: [
            { text: 'Yes, I love momentum and results', target: 'catalyst' },
            { text: 'I prefer to let things unfold naturally', target: 'harmonizer' },
            { text: 'I prioritize quality over speed', target: 'weaver' },
        ],
    },
    {
        id: 'd8',
        prompt: 'When energy dips in a project, I naturally try to revitalize the group and get us moving.',
        options: [
            { text: 'Very typical of me', target: 'catalyst' },
            { text: 'I look for new creative angles', target: 'spark' },
            { text: 'I step in to do the heavy lifting directly', target: 'champion' },
        ],
    },
    {
        id: 'd9',
        prompt: 'I can quickly adapt my strategy when circumstances change to keep our goals on track.',
        options: [
            { text: 'Strongly describes me', target: 'catalyst' },
            { text: 'I prefer sticking to the researched plan', target: 'sage' },
            { text: 'I check in with the team first', target: 'guardian' },
        ],
    },

    // Artisan cluster (4)
    {
        id: 'd10',
        prompt: 'I value authenticity and bring a distinct creative flair or personal touch to my work.',
        options: [
            { text: 'Absolutely — creativity is essential', target: 'artisan' },
            { text: 'I appreciate good design', target: 'weaver' },
            { text: 'Function matters more to me than style', target: 'sage' },
        ],
    },
    {
        id: 'd11',
        prompt: 'I prefer deep, meaningful conversations over casual small talk or surface pleasantries.',
        options: [
            { text: 'Very true for me', target: 'artisan' },
            { text: 'I enjoy connecting in various ways', target: 'connector' },
            { text: 'I prefer practical, goal-focused talk', target: 'catalyst' },
        ],
    },
    {
        id: 'd12',
        prompt: 'I am sensitive to whether a community initiative feels genuinely heartfelt and true.',
        options: [
            { text: 'Strongly agree', target: 'artisan' },
            { text: 'I look at whether it works practically', target: 'champion' },
            { text: 'I look at whether it is inclusive to everyone', target: 'harmonizer' },
        ],
    },

    // Sage cluster (5)
    {
        id: 'd13',
        prompt: 'I enjoy digging deep into a topic to thoroughly master the details before jumping in.',
        options: [
            { text: 'Yes, I like being well-informed', target: 'sage' },
            { text: 'I prefer learning by doing on the fly', target: 'spark' },
            { text: 'I rely on trusted community experts', target: 'guardian' },
        ],
    },
    {
        id: 'd14',
        prompt: 'I often contribute by creating guides, systems, or tools that make things easier for others.',
        options: [
            { text: 'Strongly describes me', target: 'sage' },
            { text: 'I prefer direct hands-on collaboration', target: 'connector' },
            { text: 'I prefer initiating and pitching ideas', target: 'spark' },
        ],
    },
    {
        id: 'd15',
        prompt: 'I appreciate having time and quiet space to reflect before making major decisions.',
        options: [
            { text: 'Essential for me', target: 'sage' },
            { text: 'I can make decisions quickly under pressure', target: 'champion' },
            { text: 'I prefer talking it through with others', target: 'harmonizer' },
        ],
    },

    // Guardian cluster (6)
    {
        id: 'd16',
        prompt: 'I am naturally alert to what could go wrong and like having backup plans in place.',
        options: [
            { text: 'Very true — preparedness matters', target: 'guardian' },
            { text: 'I am optimistic that things will work out', target: 'spark' },
            { text: 'I deal with issues when they appear', target: 'champion' },
        ],
    },
    {
        id: 'd17',
        prompt: 'Once I commit to a community group or neighbour, I am dependable and fiercely loyal.',
        options: [
            { text: 'Deeply true for me', target: 'guardian' },
            { text: 'I stay committed as long as goals are progressing', target: 'catalyst' },
            { text: 'I value flexibility and exploring new circles', target: 'spark' },
        ],
    },
    {
        id: 'd18',
        prompt: 'Trust and reliability are the most important qualities I look for in collaborators.',
        options: [
            { text: 'Strongly agree', target: 'guardian' },
            { text: 'Creativity and vision matter most', target: 'artisan' },
            { text: 'Action and decisiveness matter most', target: 'champion' },
        ],
    },

    // Spark cluster (7)
    {
        id: 'd19',
        prompt: 'I love brainstorming new ideas, possibilities, and adventures with neighbours.',
        options: [
            { text: 'Yes, this is where I shine', target: 'spark' },
            { text: 'I prefer refining existing solid plans', target: 'weaver' },
            { text: 'I focus on executing today\'s tasks', target: 'catalyst' },
        ],
    },
    {
        id: 'd20',
        prompt: 'I bring optimism, spontaneous energy, and enthusiasm into group projects.',
        options: [
            { text: 'Strongly describes me', target: 'spark' },
            { text: 'I bring calm and grounded balance', target: 'harmonizer' },
            { text: 'I bring focus and discipline', target: 'weaver' },
        ],
    },
    {
        id: 'd21',
        prompt: 'I get excited about connecting different projects, skills, or groups together.',
        options: [
            { text: 'Very true of me', target: 'spark' },
            { text: 'I prefer deep focus on one core project', target: 'sage' },
            { text: 'I focus on personal 1-on-1 connections', target: 'connector' },
        ],
    },

    // Champion cluster (8)
    {
        id: 'd22',
        prompt: 'I am comfortable speaking up directly when something feels unfair or inefficient.',
        options: [
            { text: 'Always — I value direct honesty', target: 'champion' },
            { text: 'I prefer raising concerns gently', target: 'harmonizer' },
            { text: 'I analyze the rules first', target: 'weaver' },
        ],
    },
    {
        id: 'd23',
        prompt: 'I am energized by stepping into challenges that require courage and clear direction.',
        options: [
            { text: 'Strongly describes me', target: 'champion' },
            { text: 'I prefer calm, collaborative facilitation', target: 'harmonizer' },
            { text: 'I prefer strategic, backstage planning', target: 'sage' },
        ],
    },
    {
        id: 'd24',
        prompt: 'I respect people who say what they mean and stand firmly behind their commitments.',
        options: [
            { text: 'Strongly agree', target: 'champion' },
            { text: 'I value kindness and understanding', target: 'connector' },
            { text: 'I value precision and craft', target: 'weaver' },
        ],
    },

    // Harmonizer cluster (9)
    {
        id: 'd25',
        prompt: 'I naturally sense multiple sides of an argument and help people find common ground.',
        options: [
            { text: 'Yes, peacemaking is natural for me', target: 'harmonizer' },
            { text: 'I usually take a clear, decisive stance', target: 'champion' },
            { text: 'I look at the objective facts', target: 'sage' },
        ],
    },
    {
        id: 'd26',
        prompt: 'I prefer calm, steady environments where everyone feels respected and unhurried.',
        options: [
            { text: 'Deeply true for me', target: 'harmonizer' },
            { text: 'I thrive in fast-paced, buzzing settings', target: 'catalyst' },
            { text: 'I thrive in spontaneous, novel settings', target: 'spark' },
        ],
    },
    {
        id: 'd27',
        prompt: 'I am patient with different paces and value keeping the community atmosphere harmonious.',
        options: [
            { text: 'Strongly agree', target: 'harmonizer' },
            { text: 'I push for faster progress when needed', target: 'catalyst' },
            { text: 'I push for higher standards when needed', target: 'weaver' },
        ],
    },
];

export interface QuizResult {
    primary: ArchetypeKey;
    secondary: ArchetypeKey;
    mode: 'quick' | 'deep';
    scores: Record<ArchetypeKey, number>;
    updatedAt: string;
}

export function scoreQuiz(
    selectedTargets: ArchetypeKey[],
    mode: 'quick' | 'deep'
): QuizResult {
    const scores: Record<ArchetypeKey, number> = {
        weaver: 0,
        connector: 0,
        catalyst: 0,
        artisan: 0,
        sage: 0,
        guardian: 0,
        spark: 0,
        champion: 0,
        harmonizer: 0,
    };

    for (const target of selectedTargets) {
        if (scores[target] !== undefined) {
            scores[target] += 1;
        }
    }

    // Sort archetypes by score descending
    const sorted = (Object.keys(scores) as ArchetypeKey[]).sort(
        (a, b) => scores[b] - scores[a]
    );

    const primary = sorted[0] || 'weaver';
    let secondary = sorted[1] || 'connector';

    // If second place has 0 votes, pick a complementary wing
    if (scores[secondary] === 0) {
        secondary = ARCHETYPES[primary].idealPartners[0] || 'harmonizer';
    }

    return {
        primary,
        secondary,
        mode,
        scores,
        updatedAt: new Date().toISOString(),
    };
}

export interface SynergyInsight {
    relationshipType: 'dynamic_complements' | 'kindred_spirits' | 'balanced_allies';
    title: string;
    emoji: string;
    headline: string;
    summary: string;
    strengths: string[];
    collaborationTip: string;
}

/**
 * Parses archetype metadata string (which could be JSON or plain string key)
 */
export function parseArchetype(raw?: string | null): QuizResult | null {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;

    try {
        const parsed = JSON.parse(trimmed);
        if (
            parsed &&
            typeof parsed === 'object' &&
            typeof parsed.primary === 'string' &&
            Object.prototype.hasOwnProperty.call(ARCHETYPES, parsed.primary)
        ) {
            const primary = parsed.primary as ArchetypeKey;
            const secondary = (typeof parsed.secondary === 'string' && Object.prototype.hasOwnProperty.call(ARCHETYPES, parsed.secondary))
                ? (parsed.secondary as ArchetypeKey)
                : (ARCHETYPES[primary].idealPartners[0] || 'harmonizer');
            return {
                primary,
                secondary,
                mode: parsed.mode === 'deep' ? 'deep' : 'quick',
                scores: typeof parsed.scores === 'object' && parsed.scores !== null ? parsed.scores : { [primary]: 1 } as any,
                updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
            };
        }
        if (typeof parsed === 'string' && Object.prototype.hasOwnProperty.call(ARCHETYPES, parsed)) {
            const k = parsed as ArchetypeKey;
            return {
                primary: k,
                secondary: ARCHETYPES[k].idealPartners[0] || 'harmonizer',
                mode: 'quick',
                scores: { weaver: 0, connector: 0, catalyst: 0, artisan: 0, sage: 0, guardian: 0, spark: 0, champion: 0, harmonizer: 0, [k]: 1 },
                updatedAt: new Date().toISOString(),
            };
        }
    } catch {
        // Fallback for unquoted raw string keys
    }

    if (Object.prototype.hasOwnProperty.call(ARCHETYPES, trimmed)) {
        const k = trimmed as ArchetypeKey;
        return {
            primary: k,
            secondary: ARCHETYPES[k].idealPartners[0] || 'harmonizer',
            mode: 'quick',
            scores: { weaver: 0, connector: 0, catalyst: 0, artisan: 0, sage: 0, guardian: 0, spark: 0, champion: 0, harmonizer: 0, [k]: 1 },
            updatedAt: new Date().toISOString(),
        };
    }
    return null;
}

/**
 * Calculates privacy-preserving relational chemistry between two members.
 * Avoids raw numbers or clinical labels; focuses on collaborative synergy.
 */
export function calculateSynergy(
    viewerArchetypeKey: ArchetypeKey,
    memberArchetypeKey: ArchetypeKey
): SynergyInsight {
    const me = ARCHETYPES[viewerArchetypeKey];
    const other = ARCHETYPES[memberArchetypeKey];

    if (!me || !other) {
        return {
            relationshipType: 'balanced_allies',
            title: 'Collaborative Allies',
            emoji: '🤝',
            headline: 'Natural community partners',
            summary: 'You both bring unique strengths that enrich community projects and marketplace deals.',
            strengths: ['Open communication', 'Shared community values'],
            collaborationTip: 'Enjoy collaborating and learning from each other\'s rhythm.',
        };
    }

    // Case 1: Kindred Spirits (Same archetype or close shared values)
    if (viewerArchetypeKey === memberArchetypeKey) {
        const baseName = me.name.replace(/^The\s+/i, '');
        return {
            relationshipType: 'kindred_spirits',
            title: 'Kindred Rhythms',
            emoji: '🌱',
            headline: `Shared ${baseName} intuition`,
            summary: `You both share the ${baseName} rhythm. Conversations tend to flow effortlessly because you naturally prioritize similar values and community care.`,
            strengths: [
                `Instant mutual understanding of working style`,
                `High alignment on ${me.tagline.toLowerCase()}`,
                `Shared appreciation for how tasks should be approached`,
            ],
            collaborationTip: `Because you think alike, you'll reach decisions quickly. Be sure to seek an outside perspective for blind spots!`,
        };
    }

    // Case 2: Dynamic Complements (Direct ideal partner pairing)
    const isDirectPartner =
        me.idealPartners.includes(memberArchetypeKey) ||
        other.idealPartners.includes(viewerArchetypeKey);

    if (isDirectPartner) {
        return {
            relationshipType: 'dynamic_complements',
            title: 'Complementary Synergy',
            emoji: '⚡',
            headline: `${me.name} + ${other.name}`,
            summary: `You two have high collaboration chemistry. Your strengths naturally cover each other's blind spots — where one brings the spark or vision, the other brings structure and execution.`,
            strengths: [
                `Natural balance of ideation and follow-through`,
                `Highly effective pairing for community projects and deals`,
                `Diverse perspectives that create stronger outcomes`,
            ],
            collaborationTip: other.communicationTip,
        };
    }

    // Case 3: Balanced Allies (Good general synergy)
    return {
        relationshipType: 'balanced_allies',
        title: 'Balanced Collaboration',
        emoji: '✨',
        headline: `${me.name} & ${other.name}`,
        summary: `You bring different, harmonious approaches to collaboration. Working together brings balanced depth to any project.`,
        strengths: [
            `Complementary contributions to community discussions`,
            `Fresh perspectives on problem-solving`,
            `Respectful, balanced group dynamics`,
        ],
        collaborationTip: other.communicationTip,
    };
}
