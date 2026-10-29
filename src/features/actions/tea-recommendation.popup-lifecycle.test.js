/** @vitest-environment happy-dom */
/**
 * Tea recommendation popup lifecycle: the outside-click listener belongs to its popup, a re-render
 * keeps the pin/ban constraints the controls show, and a request that awaited the Alchemy panel
 * does not draw over a newer one.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    optCalls: [],
    requirements: [],
    floorOn: false,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_BORDER: '#444',
        COLOR_INFO: '#0af',
        COLOR_WARNING: '#fa0',
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
        COLOR_GOLD: '#fc0',
        COLOR_ACCENT: '#a0f',
        getSetting: (key, fallback = false) => (key === 'teaRecommendation_xpFloor' ? mocks.floorOn : fallback),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => ({ itemDetailMap: {} }), getItemDetails: () => ({ name: 'Item' }) },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: {} }));
vi.mock('./action-filter.js', () => ({ default: { getCurrentSkillName: () => 'Foraging' } }));
vi.mock('../alchemy/alchemy-profit.js', () => ({
    default: {
        getCurrentActionHrid: () => '/actions/alchemy/coinify',
        extractRequirements: () => mocks.requirements.shift(),
    },
}));
vi.mock('../../utils/tea-optimizer.js', () => ({
    findOptimalTeas: (...args) => {
        mocks.optCalls.push(args);
        // Like the real search: a pin outside the enumerated tea set rules out every combination
        const set = args[9]?.teaSetGoal || args[1];
        const offered =
            set === 'gold'
                ? ['/items/wisdom_tea', '/items/efficiency_tea', '/items/gathering_tea']
                : ['/items/wisdom_tea', '/items/efficiency_tea'];
        if ([...(args[4]?.pinned || [])].some((t) => !offered.includes(t))) {
            return { optimal: null, playerLevel: 50, actionsEvaluated: 1, excludedActions: [], allResults: [] };
        }
        return {
            optimal: {
                teas: [{ hrid: '/items/a', name: 'A' }],
                avgScore: 1000,
                hasMissingPrices: false,
                actionScores: [{ action: 'Pincer Gloves', score: 5 }],
            },
            playerLevel: 50,
            actionsEvaluated: 1,
            excludedActions: [],
            allResults: [],
            teaCostPerHour: { total: 0, breakdown: [] },
        };
    },
    getTeaBuffDescription: () => '',
    getRelevantTeas: (_skill, goal) => ({
        skillTeas: [],
        generalTeas:
            goal === 'gold'
                ? ['/items/wisdom_tea', '/items/efficiency_tea', '/items/gathering_tea']
                : ['/items/wisdom_tea', '/items/efficiency_tea'],
    }),
    findXpFloorChoice: () => ({ status: 'none' }),
}));

const { default: teaRecommendation } = await import('./tea-recommendation.js');

function makeAnchor() {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    anchor.getBoundingClientRect = () => ({ top: 0, bottom: 10, left: 0, right: 10, width: 10, height: 10 });
    return anchor;
}

const popups = () => [...document.querySelectorAll('.mwi-tea-recommendation-popup')];

beforeEach(() => {
    vi.useFakeTimers();
    mocks.optCalls = [];
    mocks.requirements = [];
    mocks.floorOn = false;
});

afterEach(() => {
    teaRecommendation.closePopup();
    document.body.innerHTML = '';
    vi.useRealTimers();
});

describe('outside-click listener', () => {
    test('a closed Both popup leaves no listener that closes the next popup', async () => {
        const anchor = makeAnchor();
        teaRecommendation.showBothRecommendation(anchor, 'Foraging', null);
        vi.advanceTimersByTime(150);
        teaRecommendation.closePopup();

        await teaRecommendation.showRecommendation('xp', anchor);
        vi.advanceTimersByTime(150);
        const second = popups()[0];
        expect(second).toBeDefined();

        second.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(popups()).toHaveLength(1);
    });

    test('a popup closed inside the attach delay leaves no listener behind', async () => {
        const anchor = makeAnchor();
        await teaRecommendation.showRecommendation('xp', anchor);
        teaRecommendation.closePopup();

        await teaRecommendation.showRecommendation('gold', anchor);
        vi.advanceTimersByTime(150);
        popups()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(popups()).toHaveLength(1);
    });

    test('a click outside still closes the open popup', async () => {
        const anchor = makeAnchor();
        await teaRecommendation.showRecommendation('xp', anchor);
        vi.advanceTimersByTime(150);
        const elsewhere = document.createElement('div');
        document.body.appendChild(elsewhere);
        elsewhere.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(popups()).toHaveLength(0);
    });
});

describe('constraints survive a re-render', () => {
    test('drilling into an action and going back keep the pinned and banned teas', async () => {
        const anchor = makeAnchor();
        await teaRecommendation.showRecommendation('xp', anchor);
        const popup = popups()[0];
        teaRecommendation.pinnedTeas.add('/items/wisdom_tea');
        teaRecommendation.bannedTeas.add('/items/efficiency_tea');

        // The action list's rows are the only ones with a pointer cursor and the action's name
        const row = [...popup.querySelectorAll('div')].find(
            (el) => el.textContent === 'Pincer Gloves5' && el.style.cursor === 'pointer'
        );
        mocks.optCalls = [];
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const drill = mocks.optCalls.at(-1);
        expect(drill[3]).toBe('Pincer Gloves');
        expect([...drill[4].pinned]).toEqual(['/items/wisdom_tea']);
        expect([...drill[4].banned]).toEqual(['/items/efficiency_tea']);

        const back = [...popup.querySelectorAll('span')].find((el) => el.textContent.startsWith('←'));
        mocks.optCalls = [];
        back.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const all = mocks.optCalls.at(-1);
        expect([...all[4].pinned]).toEqual(['/items/wisdom_tea']);
        expect([...all[4].banned]).toEqual(['/items/efficiency_tea']);
    });
});

describe('back link after pinning a gold-set tea in a drilldown', () => {
    test('drops the pin the all-actions tea set cannot supply and still shows a result', async () => {
        mocks.floorOn = true;
        const anchor = makeAnchor();
        await teaRecommendation.showRecommendation('xp', anchor);
        const popup = popups()[0];
        const row = [...popup.querySelectorAll('div')].find(
            (el) => el.textContent === 'Pincer Gloves5' && el.style.cursor === 'pointer'
        );
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        // Pin through the drilldown's own control (the gold set is offered while the floor is on)
        teaRecommendation.pinnedTeas.add('/items/gathering_tea');
        teaRecommendation._rerunWithConstraints(popup, 'xp', 'Foraging', null, 'Pincer Gloves');
        expect(popup.textContent).toContain('Optimal XP/hr for Pincer Gloves');

        const back = [...popup.querySelectorAll('span')].find((el) => el.textContent.startsWith('←'));
        back.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(popup.textContent).toContain('Optimal XP/hr for Foraging');
        expect(popup.textContent).not.toContain('No valid combinations');
        expect(teaRecommendation.pinnedTeas.size).toBe(0);
    });
});

describe('Alchemy request race', () => {
    test('two quick clicks draw one popup, the newer one', async () => {
        const anchor = makeAnchor();
        const panel = document.createElement('div');
        panel.className = 'AlchemyPanel_panel';
        panel.appendChild(anchor);
        document.body.appendChild(panel);

        let releaseFirst;
        mocks.requirements = [
            new Promise((resolve) => {
                releaseFirst = () => resolve([{ itemHrid: '/items/first', enhancementLevel: 0 }]);
            }),
            Promise.resolve([{ itemHrid: '/items/second', enhancementLevel: 0 }]),
        ];

        const first = teaRecommendation.showRecommendation('gold', anchor);
        const second = teaRecommendation.showRecommendation('xp', anchor);
        await second;
        releaseFirst();
        await first;

        expect(popups()).toHaveLength(1);
        expect(mocks.optCalls.every((call) => call[5]?.itemHrid === '/items/second')).toBe(true);
    });
});
