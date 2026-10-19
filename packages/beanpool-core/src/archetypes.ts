/**
 * Community Working Style & Archetype Engine
 *
 * Grounded in the 9 collaborative energies (Enneagram dynamics), written as
 * working preferences ("You prefer…", "Works best when…"), not identities.
 * A member sees their own type; nothing shown about another member names one.
 * Archetypes gate nothing. See docs/the-commons.md, "Working-style archetypes".
 *
 * The types and the questions are word() keys (words.ts): the quiz shows them with t(), in the member's language. The
 * English is the key, so code that reads them as plain strings reads the same English as before.
 */

import { word, type WordKey } from './words.js';

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
    name: WordKey;
    emoji: string;
    tagline: WordKey;
    description: WordKey;
    superpowers: WordKey[];
    collaborationStyle: WordKey;
    idealPartners: ArchetypeKey[];
    communicationTip: WordKey;
}

export const ARCHETYPES: Record<ArchetypeKey, ArchetypeInfo> = {
    weaver: {
        key: 'weaver',
        name: word('The Weaver'),
        emoji: '🏛️',
        tagline: word('Craft, Quality & Purpose'),
        description: word('You prefer work with structure and care, built to last. Works best when standards are agreed up front and there is time to do things well.'),
        superpowers: [
            word('Turning loose ideas into structured, high-quality plans'),
            word('Spotting ways to improve shared processes and agreements'),
            word('Bringing reliability, precision, and follow-through'),
        ],
        collaborationStyle: word('Values clear expectations, honest feedback, and well-thought-out workflows.'),
        idealPartners: ['spark', 'harmonizer', 'connector'],
        communicationTip: word('Appreciates clarity and attention to detail upfront.'),
    },
    connector: {
        key: 'connector',
        name: word('The Connector'),
        emoji: '🤝',
        tagline: word('Warmth, Empathy & Mutual Aid'),
        description: word('You prefer work that looks after people and links those who need help with those who can offer it. Works best when members check in on each other.'),
        superpowers: [
            word('Intuitive sense for who needs support or encouragement'),
            word('Weaving strong social bonds across community members'),
            word('Energizing mutual aid and cooperative exchanges'),
        ],
        collaborationStyle: word('Thrives in collaborative, relational environments where people check in on each other.'),
        idealPartners: ['weaver', 'sage', 'champion'],
        communicationTip: word('Values personal warmth and acknowledging shared contributions.'),
    },
    catalyst: {
        key: 'catalyst',
        name: word('The Catalyst'),
        emoji: '⚡',
        tagline: word('Momentum, Drive & Progress'),
        description: word('You prefer getting things off the ground: clear goals, milestones and visible progress. Works best when decisions come quickly and next steps are concrete.'),
        superpowers: [
            word('Transforming discussions into actionable milestones'),
            word('Unblocking logjams and keeping energy high'),
            word('Adapting quickly to changing needs and resources'),
        ],
        collaborationStyle: word('Enjoys dynamic, goal-oriented teamwork with tangible outcomes.'),
        idealPartners: ['sage', 'harmonizer', 'artisan'],
        communicationTip: word('Prefers efficient updates and clear, actionable next steps.'),
    },
    artisan: {
        key: 'artisan',
        name: word('The Artisan'),
        emoji: '🎨',
        tagline: word('Creativity, Depth & Authenticity'),
        description: word('You prefer work with meaning, craft and a personal touch. Works best when there is room for original ideas and the deeper purpose stays in view.'),
        superpowers: [
            word('Infusing projects with authentic meaning and creative flair'),
            word('Seeing unique possibilities others might overlook'),
            word('Creating inspiring spaces, stories, and cultural touchpoints'),
        ],
        collaborationStyle: word('Works best when there is room for authentic expression and genuine connection.'),
        idealPartners: ['catalyst', 'guardian', 'weaver'],
        communicationTip: word('Values sincere, thoughtful listening over rushed transactions.'),
    },
    sage: {
        key: 'sage',
        name: word('The Sage'),
        emoji: '🧭',
        tagline: word('Insight, Systems & Deep Knowledge'),
        description: word('You prefer to understand how things work before acting, and to build tools others can use. Works best with time to think and clear written information.'),
        superpowers: [
            word('Synthesizing complex information into practical insights'),
            word('Designing scalable tools, guides, and decentralized systems'),
            word('Providing calm, objective analysis in uncertain situations'),
        ],
        collaborationStyle: word('Prefers having space to think deeply and communicate asynchronously.'),
        idealPartners: ['spark', 'connector', 'champion'],
        communicationTip: word('Appreciates well-structured information and respect for thinking time.'),
    },
    guardian: {
        key: 'guardian',
        name: word('The Guardian'),
        emoji: '🛡️',
        tagline: word('Loyalty, Trust & Resilience'),
        description: word('You prefer to plan ahead, look after shared resources and keep commitments. Works best when roles are clear and people follow through on what they say.'),
        superpowers: [
            word('Anticipating risks and preparing backup solutions'),
            word('Fierce loyalty to community members and shared commitments'),
            word('Building reliable, long-lasting trust circles'),
        ],
        collaborationStyle: word('Thrives when there is mutual transparency and dependable follow-through.'),
        idealPartners: ['artisan', 'spark', 'harmonizer'],
        communicationTip: word('Values predictability, honesty, and clear commitments.'),
    },
    spark: {
        key: 'spark',
        name: word('The Spark'),
        emoji: '✨',
        tagline: word('Vision, Possibility & Optimism'),
        description: word('You prefer starting fresh projects and connecting unexpected ideas. Works best when there is room to explore and others help carry things through.'),
        superpowers: [
            word('Igniting fresh excitement and rallying interest'),
            word('Synthesizing cross-disciplinary ideas into novel initiatives'),
            word('Keeping morale high with optimism and playful curiosity'),
        ],
        collaborationStyle: word('Thrives in open, exploratory projects with creative freedom.'),
        idealPartners: ['weaver', 'sage', 'guardian'],
        communicationTip: word('Enjoys brainstorming and exploring what could be possible.'),
    },
    champion: {
        key: 'champion',
        name: word('The Champion'),
        emoji: '🪵',
        tagline: word('Advocacy, Courage & Direct Action'),
        description: word('You prefer direct action, plain talk and standing up for what is fair. Works best when people say what they mean and stand behind their word.'),
        superpowers: [
            word('Cutting through ambiguity with decisive, candid leadership'),
            word('Advocating fiercely for community equity and fairness'),
            word('Taking on heavy lifts when urgent action is needed'),
        ],
        collaborationStyle: word('Prefers direct, transparent communication and people who stand behind their word.'),
        idealPartners: ['harmonizer', 'connector', 'sage'],
        communicationTip: word('Values straight talk, courage, and direct clarity.'),
    },
    harmonizer: {
        key: 'harmonizer',
        name: word('The Harmonizer'),
        emoji: '🕊️',
        tagline: word('Balance, Consensus & Flow'),
        description: word('You prefer calm, inclusive work where everyone is heard. Works best when there is patience for different views and no needless pressure.'),
        superpowers: [
            word('Unifying diverse opinions into common ground'),
            word('Bringing grounding calm to stressful or high-stakes moments'),
            word('Ensuring quiet voices and unseen needs are included'),
        ],
        collaborationStyle: word('Thrives in collaborative, respectful spaces that value patience and harmony.'),
        idealPartners: ['champion', 'catalyst', 'weaver'],
        communicationTip: word('Values patient listening and avoiding unnecessary pressure.'),
    },
};

export interface QuizQuestion {
    id: string;
    prompt: WordKey;
    scenario?: WordKey;
    options: {
        text: WordKey;
        emoji?: string;
        target: ArchetypeKey;
    }[];
}

/** 9-Question Quick Spark Quiz (Takes ~60 seconds) */
export const QUICK_SPARK_QUESTIONS: QuizQuestion[] = [
    {
        id: 'q1',
        prompt: word('When a new community project kicks off, where do you naturally jump in?'),
        options: [
            { text: word('Organizing logistics, checklists, and quality standards'), emoji: '🏛️', target: 'weaver' },
            { text: word('Welcoming members and seeing who needs support'), emoji: '🤝', target: 'connector' },
            { text: word('Setting clear milestones and rallying quick momentum'), emoji: '⚡', target: 'catalyst' },
        ],
    },
    {
        id: 'q2',
        prompt: word('How do you prefer to bring value to a shared effort?'),
        options: [
            { text: word('Crafting the creative identity, story, and meaningful details'), emoji: '🎨', target: 'artisan' },
            { text: word('Researching the best tools, systems, and technical approaches'), emoji: '🧭', target: 'sage' },
            { text: word('Identifying potential roadblocks and building trust among the team'), emoji: '🛡️', target: 'guardian' },
        ],
    },
    {
        id: 'q3',
        prompt: word('What kind of contribution brings you the most energy?'),
        options: [
            { text: word('Brainstorming fresh ideas and exploring possibilities'), emoji: '✨', target: 'spark' },
            { text: word('Tackling tough challenges and making decisive things happen'), emoji: '🪵', target: 'champion' },
            { text: word('Bringing people together to find peaceful, shared consensus'), emoji: '🕊️', target: 'harmonizer' },
        ],
    },
    {
        id: 'q4',
        prompt: word('When collaborating with neighbours on a marketplace deal or project, you appreciate when:'),
        options: [
            { text: word('Agreements are precise, tidy, and followed through with care'), emoji: '🏛️', target: 'weaver' },
            { text: word('Communication is warm, personal, and mutually caring'), emoji: '🤝', target: 'connector' },
            { text: word('Things move efficiently without getting bogged down in endless talk'), emoji: '⚡', target: 'catalyst' },
        ],
    },
    {
        id: 'q5',
        prompt: word('If a challenge or disagreement arises in a group, your instinct is to:'),
        options: [
            { text: word('Listen to everyone patiently and find common ground'), emoji: '🕊️', target: 'harmonizer' },
            { text: word('Address the issue directly and advocate for fairness'), emoji: '🪵', target: 'champion' },
            { text: word('Take a step back to analyze the root causes and data'), emoji: '🧭', target: 'sage' },
        ],
    },
    {
        id: 'q6',
        prompt: word('In community meetings or group discussions, you often find yourself:'),
        options: [
            { text: word('Sharing creative solutions or inspiring new directions'), emoji: '✨', target: 'spark' },
            { text: word('Making sure plans are safe, realistic, and dependable'), emoji: '🛡️', target: 'guardian' },
            { text: word('Ensuring the project stays true to its authentic purpose and heart'), emoji: '🎨', target: 'artisan' },
        ],
    },
    {
        id: 'q7',
        prompt: word('What gives you the deepest sense of satisfaction at the end of a busy week?'),
        options: [
            { text: word('Knowing work was done thoroughly, cleanly, and properly'), emoji: '🏛️', target: 'weaver' },
            { text: word('Knowing you brightened someone’s day or helped someone out'), emoji: '🤝', target: 'connector' },
            { text: word('Checking key milestones off the list and seeing tangible results'), emoji: '⚡', target: 'catalyst' },
        ],
    },
    {
        id: 'q8',
        prompt: word('When exploring new tools or resources for the community, you love to:'),
        options: [
            { text: word('Deep-dive into documentation and understand how it works'), emoji: '🧭', target: 'sage' },
            { text: word('Dream up exciting new ways the community can use it'), emoji: '✨', target: 'spark' },
            { text: word('Ensure the tool is secure and protects members\' privacy'), emoji: '🛡️', target: 'guardian' },
        ],
    },
    {
        id: 'q9',
        prompt: word('What principle matters most to you in local cooperation?'),
        options: [
            { text: word('Standing strong for fairness and standing up for others'), emoji: '🪵', target: 'champion' },
            { text: word('Creating an atmosphere of peace, patience, and inclusion'), emoji: '🕊️', target: 'harmonizer' },
            { text: word('Cultivating authentic beauty, expression, and uniqueness'), emoji: '🎨', target: 'artisan' },
        ],
    },
];

/** 27-Question Deep Resonance Quiz (Takes ~3-4 mins for deep nuance) */
export const DEEP_RESONANCE_QUESTIONS: QuizQuestion[] = [
    // Weaver cluster (1)
    {
        id: 'd1',
        prompt: word('I naturally spot what needs improvement in a process and care about getting details right.'),
        options: [
            { text: word('Strongly describes me'), target: 'weaver' },
            { text: word('Somewhat describes me'), target: 'weaver' },
            { text: word('Not my primary focus'), target: 'harmonizer' },
        ],
    },
    {
        id: 'd2',
        prompt: word('I feel most comfortable when expectations, roles, and guidelines are clearly defined.'),
        options: [
            { text: word('Definitely agree'), target: 'weaver' },
            { text: word('Sometimes agree'), target: 'guardian' },
            { text: word('I prefer open, flexible fluidity'), target: 'spark' },
        ],
    },
    {
        id: 'd3',
        prompt: word('In shared projects, I am often the one ensuring our work meets high craft and ethical standards.'),
        options: [
            { text: word('Yes, very much so'), target: 'weaver' },
            { text: word('I focus more on the big picture'), target: 'spark' },
            { text: word('I focus more on how people feel'), target: 'connector' },
        ],
    },

    // Connector cluster (2)
    {
        id: 'd4',
        prompt: word('I quickly sense when someone in the community is feeling left out or overwhelmed.'),
        options: [
            { text: word('Always — I notice people right away'), target: 'connector' },
            { text: word('Sometimes, if I know them well'), target: 'harmonizer' },
            { text: word('I focus more on the task at hand'), target: 'catalyst' },
        ],
    },
    {
        id: 'd5',
        prompt: word('Helping neighbours and contributing to mutual aid gives me real joy and energy.'),
        options: [
            { text: word('A core part of who I am'), target: 'connector' },
            { text: word('I enjoy helping when asked'), target: 'guardian' },
            { text: word('I prefer contributing through ideas or tools'), target: 'sage' },
        ],
    },
    {
        id: 'd6',
        prompt: word('I place a high value on warm, appreciative, and considerate communication.'),
        options: [
            { text: word('Strongly agree'), target: 'connector' },
            { text: word('I value clarity above all'), target: 'champion' },
            { text: word('I value authenticity and depth'), target: 'artisan' },
        ],
    },

    // Catalyst cluster (3)
    {
        id: 'd7',
        prompt: word('I am motivated by setting tangible goals and seeing steady, measurable progress.'),
        options: [
            { text: word('Yes, I love momentum and results'), target: 'catalyst' },
            { text: word('I prefer to let things unfold naturally'), target: 'harmonizer' },
            { text: word('I prioritize quality over speed'), target: 'weaver' },
        ],
    },
    {
        id: 'd8',
        prompt: word('When energy dips in a project, I naturally try to revitalize the group and get us moving.'),
        options: [
            { text: word('Very typical of me'), target: 'catalyst' },
            { text: word('I look for new creative angles'), target: 'spark' },
            { text: word('I step in to do the heavy lifting directly'), target: 'champion' },
        ],
    },
    {
        id: 'd9',
        prompt: word('I can quickly adapt my strategy when circumstances change to keep our goals on track.'),
        options: [
            { text: word('Strongly describes me'), target: 'catalyst' },
            { text: word('I prefer sticking to the researched plan'), target: 'sage' },
            { text: word('I check in with the team first'), target: 'guardian' },
        ],
    },

    // Artisan cluster (4)
    {
        id: 'd10',
        prompt: word('I value authenticity and bring a distinct creative flair or personal touch to my work.'),
        options: [
            { text: word('Absolutely — creativity is essential'), target: 'artisan' },
            { text: word('I appreciate good design'), target: 'weaver' },
            { text: word('Function matters more to me than style'), target: 'sage' },
        ],
    },
    {
        id: 'd11',
        prompt: word('I prefer deep, meaningful conversations over casual small talk or surface pleasantries.'),
        options: [
            { text: word('Very true for me'), target: 'artisan' },
            { text: word('I enjoy connecting in various ways'), target: 'connector' },
            { text: word('I prefer practical, goal-focused talk'), target: 'catalyst' },
        ],
    },
    {
        id: 'd12',
        prompt: word('I am sensitive to whether a community initiative feels genuinely heartfelt and true.'),
        options: [
            { text: word('Strongly agree'), target: 'artisan' },
            { text: word('I look at whether it works practically'), target: 'champion' },
            { text: word('I look at whether it is inclusive to everyone'), target: 'harmonizer' },
        ],
    },

    // Sage cluster (5)
    {
        id: 'd13',
        prompt: word('I enjoy digging deep into a topic to thoroughly master the details before jumping in.'),
        options: [
            { text: word('Yes, I like being well-informed'), target: 'sage' },
            { text: word('I prefer learning by doing on the fly'), target: 'spark' },
            { text: word('I rely on trusted community experts'), target: 'guardian' },
        ],
    },
    {
        id: 'd14',
        prompt: word('I often contribute by creating guides, systems, or tools that make things easier for others.'),
        options: [
            { text: word('Strongly describes me'), target: 'sage' },
            { text: word('I prefer direct hands-on collaboration'), target: 'connector' },
            { text: word('I prefer initiating and pitching ideas'), target: 'spark' },
        ],
    },
    {
        id: 'd15',
        prompt: word('I appreciate having time and quiet space to reflect before making major decisions.'),
        options: [
            { text: word('Essential for me'), target: 'sage' },
            { text: word('I can make decisions quickly under pressure'), target: 'champion' },
            { text: word('I prefer talking it through with others'), target: 'harmonizer' },
        ],
    },

    // Guardian cluster (6)
    {
        id: 'd16',
        prompt: word('I am naturally alert to what could go wrong and like having backup plans in place.'),
        options: [
            { text: word('Very true — preparedness matters'), target: 'guardian' },
            { text: word('I am optimistic that things will work out'), target: 'spark' },
            { text: word('I deal with issues when they appear'), target: 'champion' },
        ],
    },
    {
        id: 'd17',
        prompt: word('Once I commit to a community group or neighbour, I am dependable and fiercely loyal.'),
        options: [
            { text: word('Deeply true for me'), target: 'guardian' },
            { text: word('I stay committed as long as goals are progressing'), target: 'catalyst' },
            { text: word('I value flexibility and exploring new circles'), target: 'spark' },
        ],
    },
    {
        id: 'd18',
        prompt: word('Trust and reliability are the most important qualities I look for in collaborators.'),
        options: [
            { text: word('Strongly agree'), target: 'guardian' },
            { text: word('Creativity and vision matter most'), target: 'artisan' },
            { text: word('Action and decisiveness matter most'), target: 'champion' },
        ],
    },

    // Spark cluster (7)
    {
        id: 'd19',
        prompt: word('I love brainstorming new ideas, possibilities, and adventures with neighbours.'),
        options: [
            { text: word('Yes, this is where I shine'), target: 'spark' },
            { text: word('I prefer refining existing solid plans'), target: 'weaver' },
            { text: word('I focus on executing today\'s tasks'), target: 'catalyst' },
        ],
    },
    {
        id: 'd20',
        prompt: word('I bring optimism, spontaneous energy, and enthusiasm into group projects.'),
        options: [
            { text: word('Strongly describes me'), target: 'spark' },
            { text: word('I bring calm and grounded balance'), target: 'harmonizer' },
            { text: word('I bring focus and discipline'), target: 'weaver' },
        ],
    },
    {
        id: 'd21',
        prompt: word('I get excited about connecting different projects, skills, or groups together.'),
        options: [
            { text: word('Very true of me'), target: 'spark' },
            { text: word('I prefer deep focus on one core project'), target: 'sage' },
            { text: word('I focus on personal 1-on-1 connections'), target: 'connector' },
        ],
    },

    // Champion cluster (8)
    {
        id: 'd22',
        prompt: word('I am comfortable speaking up directly when something feels unfair or inefficient.'),
        options: [
            { text: word('Always — I value direct honesty'), target: 'champion' },
            { text: word('I prefer raising concerns gently'), target: 'harmonizer' },
            { text: word('I analyze the rules first'), target: 'weaver' },
        ],
    },
    {
        id: 'd23',
        prompt: word('I am energized by stepping into challenges that require courage and clear direction.'),
        options: [
            { text: word('Strongly describes me'), target: 'champion' },
            { text: word('I prefer calm, collaborative facilitation'), target: 'harmonizer' },
            { text: word('I prefer strategic, backstage planning'), target: 'sage' },
        ],
    },
    {
        id: 'd24',
        prompt: word('I respect people who say what they mean and stand firmly behind their commitments.'),
        options: [
            { text: word('Strongly agree'), target: 'champion' },
            { text: word('I value kindness and understanding'), target: 'connector' },
            { text: word('I value precision and craft'), target: 'weaver' },
        ],
    },

    // Harmonizer cluster (9)
    {
        id: 'd25',
        prompt: word('I naturally sense multiple sides of an argument and help people find common ground.'),
        options: [
            { text: word('Yes, peacemaking is natural for me'), target: 'harmonizer' },
            { text: word('I usually take a clear, decisive stance'), target: 'champion' },
            { text: word('I look at the objective facts'), target: 'sage' },
        ],
    },
    {
        id: 'd26',
        prompt: word('I prefer calm, steady environments where everyone feels respected and unhurried.'),
        options: [
            { text: word('Deeply true for me'), target: 'harmonizer' },
            { text: word('I thrive in fast-paced, buzzing settings'), target: 'catalyst' },
            { text: word('I thrive in spontaneous, novel settings'), target: 'spark' },
        ],
    },
    {
        id: 'd27',
        prompt: word('I am patient with different paces and value keeping the community atmosphere harmonious.'),
        options: [
            { text: word('Strongly agree'), target: 'harmonizer' },
            { text: word('I push for faster progress when needed'), target: 'catalyst' },
            { text: word('I push for higher standards when needed'), target: 'weaver' },
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

/** The words are word() keys, as the types' are: an app shows each through t(), in the member's language. */
export interface SynergyInsight {
    relationshipType: 'dynamic_complements' | 'kindred_spirits' | 'balanced_allies';
    title: WordKey;
    emoji: string;
    headline: WordKey;
    summary: WordKey;
    strengths: WordKey[];
    collaborationTip: WordKey;
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
 *
 * Everything returned is shown to the viewer about ANOTHER member, so no field
 * names a type or quotes a type's tagline, not even in the kindred case, where
 * naming "your" type would name theirs too. The tip stays (archetype decision
 * note, 2026-09-17, decision 3).
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
            title: word('Collaborative Allies'),
            emoji: '🤝',
            headline: word('Natural community partners'),
            summary: word('You both bring unique strengths that enrich community projects and marketplace deals.'),
            strengths: [word('Open communication'), word('Shared community values')],
            collaborationTip: word("Enjoy collaborating and learning from each other's rhythm."),
        };
    }

    // Case 1: Kindred Spirits (Same archetype or close shared values)
    if (viewerArchetypeKey === memberArchetypeKey) {
        return {
            relationshipType: 'kindred_spirits',
            title: word('Kindred Rhythms'),
            emoji: '🌱',
            headline: word('Similar ways of working'),
            summary: word('You both prefer similar ways of working. Conversations tend to flow easily because you prioritize similar things.'),
            strengths: [
                word('Instant mutual understanding of working style'),
                word('Shared sense of what matters in the work'),
                word('Shared appreciation for how tasks should be approached'),
            ],
            collaborationTip: word("Because you think alike, you'll reach decisions quickly. Be sure to seek an outside perspective for blind spots!"),
        };
    }

    // Case 2: Dynamic Complements (Direct ideal partner pairing)
    const isDirectPartner =
        me.idealPartners.includes(memberArchetypeKey) ||
        other.idealPartners.includes(viewerArchetypeKey);

    if (isDirectPartner) {
        return {
            relationshipType: 'dynamic_complements',
            title: word('Complementary Synergy'),
            emoji: '⚡',
            headline: word('Strengths that complement'),
            summary: word("You two have high collaboration chemistry. Your strengths naturally cover each other's blind spots — where one brings the spark or vision, the other brings structure and execution."),
            strengths: [
                word('Natural balance of ideation and follow-through'),
                word('Highly effective pairing for community projects and deals'),
                word('Diverse perspectives that create stronger outcomes'),
            ],
            collaborationTip: other.communicationTip,
        };
    }

    // Case 3: Balanced Allies (Good general synergy)
    return {
        relationshipType: 'balanced_allies',
        title: word('Balanced Collaboration'),
        emoji: '✨',
        headline: word('Different, compatible styles'),
        summary: word('You bring different, harmonious approaches to collaboration. Working together brings balanced depth to any project.'),
        strengths: [
            word('Complementary contributions to community discussions'),
            word('Fresh perspectives on problem-solving'),
            word('Respectful, balanced group dynamics'),
        ],
        collaborationTip: other.communicationTip,
    };
}
