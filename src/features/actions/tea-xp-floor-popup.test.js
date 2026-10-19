/** @vitest-environment happy-dom */
/**
 * The "almost as fast" line in the tea recommendation popup (issue #552): every way the XP-floor
 * result can end, what the popup shows for it, and that the setting gates and parameterizes it.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: { teaRecommendation_xpFloor: true, teaRecommendation_xpFloorPercent: 95 },
    floor: { status: 'none' },
    floorCalls: [],
    throwFloor: false,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_BORDER: '#444',
        COLOR_INFO: '#0af',
        COLOR_WARNING: '#fa0',
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
        COLOR_GOLD: '#fc0',
        getSetting: (key, fallback = false) => (key in mocks.settings ? mocks.settings[key] : fallback),
    },
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getInitClientData: () => ({ itemDetailMap: {} }) } }));
vi.mock('../../core/dom-observer.js', () => ({ default: {} }));
vi.mock('./action-filter.js', () => ({ default: {} }));
vi.mock('../alchemy/alchemy-profit.js', () => ({ default: {} }));
vi.mock('../../utils/tea-optimizer.js', () => ({
    findOptimalTeas: () => ({}),
    getTeaBuffDescription: () => '',
    getRelevantTeas: () => ({ skillTeas: [], generalTeas: [] }),
    findXpFloorChoice: (...args) => {
        mocks.floorCalls.push(args);
        if (mocks.throwFloor) throw new Error('boom');
        return mocks.floor;
    },
}));

const { default: teaRecommendation, buildXpFloorSection } = await import('./tea-recommendation.js');

const pick = { teas: ['/items/b'], names: ['Wisdom Tea'], xp: 960, gold: 120_000 };
const baseline = { teas: ['/items/a'], names: ['Efficiency Tea', 'Wisdom Tea'], xp: 1000, gold: 90_000 };
const result = {
    optimal: { teas: [{ hrid: '/items/a', name: 'A' }], avgScore: 1000, actionScores: [], profitableCount: 1 },
    playerLevel: 50,
    actionsEvaluated: 1,
    excludedActions: [],
    allResults: [],
    teaCostPerHour: { total: 0, breakdown: [] },
};

function render(drilldownAction, alchemyContext = null) {
    const popup = document.createElement('div');
    teaRecommendation.buildPopupContent(popup, result, 'xp', 'Cheesesmithing', null, drilldownAction, alchemyContext);
    return popup;
}

beforeEach(() => {
    mocks.settings = { teaRecommendation_xpFloor: true, teaRecommendation_xpFloorPercent: 95 };
    mocks.floor = { status: 'none' };
    mocks.floorCalls = [];
    mocks.throwFloor = false;
});

describe('buildXpFloorSection', () => {
    test('ok: names the teas and states the XP given up and the gold/hr gained', () => {
        const el = buildXpFloorSection({
            status: 'ok',
            floorPercent: 95,
            pick,
            baseline,
            xpRetainedPercent: 96,
            goldDelta: 30_000,
        });
        expect(el.textContent).toContain('Within 95% of top XP: Wisdom Tea');
        expect(el.textContent).toContain('XP −4.0%');
        expect(el.textContent).toContain('+30.0K gold/hr');
        expect(el.textContent).toContain('This setup: 960 XP/hr, 120.0K gold/hr');
        expect(el.textContent).toContain('Top XP: 1.0K XP/hr, 90.0K gold/hr');
        expect(el.querySelector('sup')).toBeNull();
    });

    test('ok with a loss: the gold change keeps its sign', () => {
        const el = buildXpFloorSection({
            status: 'ok',
            floorPercent: 90,
            pick,
            baseline,
            xpRetainedPercent: 92,
            goldDelta: -1500,
        });
        expect(el.textContent).toContain('-1.5K gold/hr');
    });

    test('ok on an unpriced pick or reference is marked, never silent', () => {
        const flagged = { ...pick, unpriced: true };
        const el = buildXpFloorSection({
            status: 'ok',
            floorPercent: 95,
            pick: flagged,
            baseline,
            xpRetainedPercent: 96,
            goldDelta: 5,
        });
        expect(el.querySelector('sup')?.title).toMatch(/unpriced/i);
        const ref = buildXpFloorSection({
            status: 'ok',
            floorPercent: 95,
            pick,
            baseline: { ...baseline, unpriced: true },
            xpRetainedPercent: 96,
            goldDelta: 5,
        });
        expect(ref.querySelector('sup')).not.toBeNull();
    });

    test('an unknown gold change is said to be unavailable, not drawn as 0', () => {
        const el = buildXpFloorSection({
            status: 'ok',
            floorPercent: 95,
            pick,
            baseline,
            xpRetainedPercent: 96,
            goldDelta: null,
        });
        expect(el.textContent).toContain('gold/hr n/a');
        expect(el.textContent).not.toContain('+0');
    });

    test('same: says the top-XP setup is already the pick instead of repeating it', () => {
        const el = buildXpFloorSection({ status: 'same', floorPercent: 99, pick: baseline, baseline });
        expect(el.textContent).toContain('already the best gold/hr');
        expect(el.textContent).not.toContain('Efficiency Tea');
    });

    test('no-xp and no-gold say why there is no pick', () => {
        expect(buildXpFloorSection({ status: 'no-xp', floorPercent: 95, baseline }).textContent).toMatch(/no XP/);
        expect(buildXpFloorSection({ status: 'no-gold', floorPercent: 95, baseline }).textContent).toMatch(
            /no setup has a gold/
        );
    });

    test.each(['none', 'not-single-action', 'error', undefined])('%s draws nothing', (status) => {
        expect(buildXpFloorSection(status ? { status } : null)).toBeNull();
    });
});

describe('popup wiring', () => {
    test('a drilled-down action shows the section, with the current constraints and setting', () => {
        mocks.floor = { status: 'ok', floorPercent: 88, pick, baseline, xpRetainedPercent: 96, goldDelta: 30_000 };
        mocks.settings.teaRecommendation_xpFloorPercent = 88;
        const popup = render('Pincer Gloves');
        expect(popup.querySelector('.mwi-tea-xp-floor')).not.toBeNull();
        const [skill, params] = mocks.floorCalls[0];
        expect(skill).toBe('Cheesesmithing');
        expect(params.actionName).toBe('Pincer Gloves');
        expect(params.floorPercent).toBe(88);
        expect(params.constraints.pinned).toBe(teaRecommendation.pinnedTeas);
        expect(params.constraints.banned).toBe(teaRecommendation.bannedTeas);
    });

    test('an alchemy item counts as one action', () => {
        mocks.floor = { status: 'same', floorPercent: 95, pick: baseline, baseline };
        const popup = render(null, { actionType: 'coinify', itemName: 'Thing', itemHrid: '/items/thing' });
        expect(popup.querySelector('.mwi-tea-xp-floor')).not.toBeNull();
    });

    test('the all-actions view never computes it', () => {
        render(null);
        expect(mocks.floorCalls).toHaveLength(0);
    });

    test('turning the setting off removes it and skips the work', () => {
        mocks.floor = { status: 'ok', floorPercent: 95, pick, baseline, xpRetainedPercent: 96, goldDelta: 1 };
        mocks.settings.teaRecommendation_xpFloor = false;
        const popup = render('Pincer Gloves');
        expect(popup.querySelector('.mwi-tea-xp-floor')).toBeNull();
        expect(mocks.floorCalls).toHaveLength(0);
    });

    test('a thrown floor calculation leaves the rest of the popup intact', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.throwFloor = true;
        const popup = render('Pincer Gloves');
        expect(popup.querySelector('.mwi-tea-xp-floor')).toBeNull();
        expect(popup.textContent).toContain('Tea Constraints');
        spy.mockRestore();
    });
});
