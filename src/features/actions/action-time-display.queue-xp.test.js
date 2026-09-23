/**
 * What a queued action is expected to teach, on the row and in the panel's footer.
 *
 * Two sources, one line. A fight's experience rides on the same stored simulation that times it,
 * so it inherits that reading's freshness and gear caveats exactly as its profit figure does; a
 * skilling row's comes from game data through the repo's one experience helper. Either can be
 * missing on its own, and a row with no figure must mark the footer's Total XP `+ [?]` rather
 * than quietly counting as zero.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {} },
}));

const game = vi.hoisted(() => ({
    currentActions: [],
    actionDetails: {},
    snapshot: null,
    loadoutMap: {},
    rates: {},
    showXp: true,
    characterId: 'char1',
    /** What `calculateExpPerHour` answers for a skilling action, or null for one it cannot */
    expData: { expPerHour: 36_000, modifiedXP: 100 },
    inventory: [],
    itemDetailMap: {},
    /** What the alchemy calculator answers for a queued alchemy row, or null for none */
    alchemyProfit: null,
    /** Wisdom and Charm Experience together, as a multiplier on base XP */
    xpMultiplier: 1,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => game.currentActions,
        getActionDetails: (hrid) => game.actionDetails[hrid] ?? null,
        getItemDetails: (hrid) => game.itemDetailMap[hrid] ?? null,
        getInventory: () => game.inventory,
        getInitClientData: () => ({ itemDetailMap: game.itemDetailMap }),
        getActionDrinkSlots: () => [],
        getElapsedSecondsInCurrentUnit: () => 0,
        getSkills: () => [],
        getEquipment: () => [],
        getCurrentCharacterId: () => game.characterId,
        get characterData() {
            return { characterLoadoutMap: game.loadoutMap };
        },
        on: () => () => {},
    },
}));

vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: () => ({ actionTime: 10, totalEfficiency: 0 }),
}));

// The repo's one answer to "what does this action teach" — mocked so the test is about the panel,
// not about wisdom parsing, which experience-calculator's own tests cover
vi.mock('../../utils/experience-calculator.js', () => ({
    calculateExpPerHour: (hrid) => (hrid === '/actions/milking/cow' ? game.expData : null),
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => key === 'actionQueue',
        getSettingValue: (key, fallback) => {
            if (key === 'actionQueue_showXp') return game.showXp;
            // The value line is off throughout: this file is about the XP line, and the panel
            // must show it with nothing else on the row
            if (key === 'actionQueue_showValue') return false;
            return fallback;
        },
        COLOR_TOOLTIP_INFO: '#abc',
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => false, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({
    default: {
        calculate: async () => null,
        calculateCoinifyProfit: () => game.alchemyProfit,
        calculateDecomposeProfit: () => game.alchemyProfit,
        calculateTransmuteProfit: () => game.alchemyProfit,
    },
}));
vi.mock('../../utils/experience-parser.js', () => ({
    calculateExperienceMultiplier: () => ({ totalMultiplier: game.xpMultiplier }),
}));
vi.mock('../enhancement/enhancement-xp.js', () => ({ calculateEnhancementPredictions: () => null }));

vi.mock('../../utils/all-zones-snapshot.js', async (importOriginal) => ({
    ...(await importOriginal()),
    loadAllZonesSnapshot: async () => game.snapshot,
    loadZoneSimRates: async () => game.rates,
}));

const { default: actionTimeDisplay, estimateCombatQueueRow } = await import('./action-time-display.js');

const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;
const MILK = '/actions/milking/cow';
const GOBO = '/actions/combat/gobo_planet';
const COMBAT_ID = 41704;

const DECOMPOSE = '/actions/alchemy/decompose';
const COINIFY = '/actions/alchemy/coinify';
/** Alchemy actions carry no experienceGain: what they teach comes from the item alchemized */
const decompose = { hrid: DECOMPOSE, name: 'Decompose', type: '/action_types/alchemy', inputItems: [] };
const coinify = { hrid: COINIFY, name: 'Coinify', type: '/action_types/alchemy', inputItems: [] };
const STAR_FRUIT = '/items/star_fruit';
const FORAGING_ESSENCE = '/items/foraging_essence';

/** An alchemy row as the game queues it: the item rides in primaryItemHash. */
function alchemyAction(id, actionHrid, itemHrid, maxCount = 0) {
    return {
        id,
        ordinal: id,
        actionHrid,
        primaryItemHash: `161296::/item_locations/inventory::${itemHrid}::0`,
        secondaryItemHash: '',
        hasMaxCount: maxCount > 0,
        maxCount,
        currentCount: 0,
    };
}

const gobo = { hrid: GOBO, name: 'Gobo Planet', type: '/action_types/combat', combatZoneInfo: { isDungeon: false } };

/** A gathering action: no inputs, so a counted row runs exactly what it asks for. */
const cow = {
    hrid: MILK,
    name: 'Milk Cow',
    type: '/action_types/milking',
    inputItems: [],
    outputItems: [{ itemHrid: '/items/milk', count: 1 }],
    experienceGain: { skillHrid: '/skills/milking', value: 50 },
};

/** A fight with 1000 waves left, which at 500 waves an hour is two hours. */
function combatAction(id, { maxCount = 1080, currentCount = 80, tier = 3, loadoutId = COMBAT_ID } = {}) {
    return {
        id,
        ordinal: id,
        actionHrid: GOBO,
        difficultyTier: tier,
        characterLoadoutID: loadoutId,
        primaryItemHash: '',
        hasMaxCount: maxCount > 0,
        maxCount,
        currentCount,
    };
}

/** A counted skilling row. */
function countedAction(id, actionHrid, count) {
    return {
        id,
        ordinal: id,
        actionHrid,
        primaryItemHash: '',
        hasMaxCount: true,
        maxCount: count,
        currentCount: 0,
    };
}

/** A Repeat-∞ row: no count, and for a gathering action nothing to cap it either. */
function endlessAction(id, actionHrid) {
    return { id, ordinal: id, actionHrid, primaryItemHash: '', hasMaxCount: false, maxCount: 0, currentCount: 0 };
}

function snapshot({ rate = 500, xpPerHour = 250_000, tier = 3 } = {}) {
    return {
        savedAt: NOW - 3 * HOUR,
        fingerprint: 'abc',
        loadout: { source: 'loadout', name: 'Combat' },
        zones: [
            {
                zoneHrid: GOBO,
                zoneName: 'Gobo Planet',
                difficultyTier: tier,
                profitPerHour: 1_000_000,
                revenuePerHour: 1_400_000,
                // Absent in a run stored before the field was kept, which `xpPerHour: null` means
                ...(xpPerHour === null ? {} : { xpPerHour }),
                ...(rate === null ? {} : { encountersPerHour: rate }),
            },
        ],
    };
}

/** The edit menu as the game draws it, one row per label. */
function queueMenu(labels) {
    const parent = document.createElement('div');
    const menu = document.createElement('div');
    menu.className = 'QueuedActions_queuedActionsEditMenu__x';
    menu.innerHTML = labels
        .map(
            (label, index) => `
        <div class="QueuedActions_action__item">
            <div class="QueuedActions_actionText__y">
                <div class="QueuedActions_text__z">#${index + 1}${label}</div>
            </div>
        </div>`
        )
        .join('');
    parent.appendChild(menu);
    document.body.appendChild(parent);
    return menu;
}

const xpLines = (root) => [...root.querySelectorAll('.mwi-queue-action-xp')].map((el) => el.textContent);
const totalText = () => document.querySelector('#mwi-queue-total-time')?.textContent ?? '';
const flush = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe('estimateCombatQueueRow carries the experience its rate came with', () => {
    const estimate = (overrides = {}) =>
        estimateCombatQueueRow({
            actionObj: combatAction(1),
            actionDetails: gobo,
            snapshot: snapshot(),
            rowLoadout: { known: true, name: 'Combat' },
            now: NOW,
            ...overrides,
        });

    test('a counted row gets the run total and the rate it rests on', () => {
        const result = estimate();
        expect(result.seconds).toBe(7200);
        expect(result.xpPerHour).toBe(250_000);
        expect(result.xpTotal).toBe(500_000);
    });

    test('a Fight ∞ row has a rate but no total', () => {
        const result = estimate({ actionObj: combatAction(1, { maxCount: 0 }) });
        expect(result.xpPerHour).toBe(250_000);
        expect(result.xpTotal).toBeNull();
    });

    test('a reading stored before the field was kept has neither, and never a zero', () => {
        const result = estimate({ snapshot: snapshot({ xpPerHour: null }) });
        expect(result.xpPerHour).toBeNull();
        expect(result.xpTotal).toBeNull();
    });
});

describe('the Queued Actions panel shows what the queue is expected to teach', () => {
    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        document.body.innerHTML = '';
        game.actionDetails = { [GOBO]: gobo, [MILK]: cow };
        game.loadoutMap = { [COMBAT_ID]: { name: 'Combat' } };
        game.snapshot = snapshot();
        game.rates = {};
        game.showXp = true;
        game.expData = { expPerHour: 36_000, modifiedXP: 100 };
        game.inventory = [];
        game.itemDetailMap = {};
        game.alchemyProfit = null;
        game.xpMultiplier = 1;
        await actionTimeDisplay.refreshCombatSnapshot();
    });

    afterEach(() => {
        vi.useRealTimers();
        actionTimeDisplay._combatSnapshotCache = null;
        actionTimeDisplay._lastQueueMenu = null;
    });

    test('a combat row reads the XP its snapshot simulated', async () => {
        game.currentActions = [combatAction(1)];
        const menu = queueMenu(['Gobo Planet (T3)']);
        actionTimeDisplay.injectQueueTimes(menu);
        await flush();

        expect(xpLines(menu)).toEqual(['XP: 500.00K (250.00K/hr)']);
        expect(totalText()).toContain('Total XP: 500.00K');
        expect(totalText()).not.toContain('[?]');
        expect(menu.textContent).not.toContain('undefined');
    });

    test('redrawing the panel replaces the XP line rather than stacking another one under it', async () => {
        // The line is appended per pass, like the profit line beside it. The panel redraws
        // whenever the queue is reopened or a rate lands, so anything not swept first survives:
        // a row grew one `XP:` line per redraw, each frozen at the rate known when it was drawn.
        game.currentActions = [combatAction(1)];
        const menu = queueMenu(['Gobo Planet (T3)']);

        for (let pass = 0; pass < 3; pass++) {
            actionTimeDisplay.injectQueueTimes(menu);
            await flush();
        }

        expect(xpLines(menu)).toEqual(['XP: 500.00K (250.00K/hr)']);
        expect(menu.querySelectorAll('.mwi-queue-action-xp')).toHaveLength(1);
        // The footer must not count the row once per redraw either
        expect(totalText()).toContain('Total XP: 500.00K');
    });

    test('a skilling row reads the XP its action grants, over the count it will run', async () => {
        game.currentActions = [countedAction(1, MILK, 250)];
        const menu = queueMenu(['Milk Cow']);
        actionTimeDisplay.injectQueueTimes(menu);
        await flush();

        // 250 completions at 100 XP each, at 36,000 XP an hour
        expect(xpLines(menu)).toEqual(['XP: 25.00K (36.00K/hr)']);
        expect(totalText()).toContain('Total XP: 25.00K');
    });

    test('a mixed queue totals both kinds of row together', async () => {
        game.currentActions = [combatAction(1), countedAction(2, MILK, 250)];
        const menu = queueMenu(['Gobo Planet (T3)', 'Milk Cow']);
        actionTimeDisplay.injectQueueTimes(menu);
        await flush();

        expect(xpLines(menu)).toEqual(['XP: 500.00K (250.00K/hr)', 'XP: 25.00K (36.00K/hr)']);
        expect(totalText()).toContain('Total XP: 525.00K');
        expect(totalText()).not.toContain('[?]');
    });

    test('a fight whose snapshot has no XP marks the total short rather than counting as zero', async () => {
        game.snapshot = snapshot({ xpPerHour: null });
        await actionTimeDisplay.refreshCombatSnapshot();
        game.currentActions = [combatAction(1), countedAction(2, MILK, 250)];
        const menu = queueMenu(['Gobo Planet (T3)', 'Milk Cow']);
        actionTimeDisplay.injectQueueTimes(menu);
        await flush();

        expect(xpLines(menu)).toEqual(['XP: [? · no xp figure]', 'XP: 25.00K (36.00K/hr)']);
        expect(totalText()).toContain('Total XP: 25.00K + [?]');
    });

    test('a fight with no stored reading at all marks the total short too', async () => {
        game.snapshot = snapshot({ rate: null });
        await actionTimeDisplay.refreshCombatSnapshot();
        game.currentActions = [combatAction(1), countedAction(2, MILK, 250)];
        const menu = queueMenu(['Gobo Planet (T3)', 'Milk Cow']);
        actionTimeDisplay.injectQueueTimes(menu);
        await flush();

        expect(totalText()).toContain('Total XP: 25.00K + [?]');
    });

    test('an action the game grants no experience for says so, and marks the total short', async () => {
        game.expData = null;
        game.currentActions = [countedAction(1, MILK, 250)];
        const menu = queueMenu(['Milk Cow']);
        actionTimeDisplay.injectQueueTimes(menu);
        await flush();

        expect(xpLines(menu)).toEqual(['XP: [? · no xp figure]']);
        // Nothing could be totalled at all, so there is no figure for a `+ [?]` to qualify
        expect(totalText()).not.toContain('Total XP');
    });

    test('a Repeat-∞ skilling row reads the rate alone, and the total says it is short', async () => {
        game.currentActions = [countedAction(1, MILK, 250), endlessAction(2, MILK)];
        const menu = queueMenu(['Milk Cow', 'Milk Cow']);
        actionTimeDisplay.injectQueueTimes(menu);
        await flush();

        expect(xpLines(menu)).toEqual(['XP: 25.00K (36.00K/hr)', 'XP: 36.00K/hr']);
        expect(totalText()).toContain('Total XP: 25.00K + [?]');
    });

    test('rows after a Repeat-∞ action show their own XP but do not enter the reachable total', async () => {
        game.currentActions = [countedAction(1, MILK, 250), endlessAction(2, MILK), countedAction(3, MILK, 500)];
        const menu = queueMenu(['Milk Cow', 'Milk Cow', 'Milk Cow']);
        actionTimeDisplay.injectQueueTimes(menu);
        await flush();

        expect(xpLines(menu)).toEqual(['XP: 25.00K (36.00K/hr)', 'XP: 36.00K/hr', 'XP: 50.00K (36.00K/hr)']);
        expect(totalText()).toContain('Total XP: 25.00K + [?]');
        expect(totalText()).not.toContain('75.00K');
    });

    test('an active Repeat-∞ action prevents queued rows from entering the duration and XP totals', async () => {
        const header = document.createElement('div');
        header.className = 'Header_actionName__x';
        header.textContent = 'Milk Cow';
        document.body.appendChild(header);
        game.currentActions = [endlessAction(1, MILK), countedAction(2, MILK, 500)];
        const menu = queueMenu(['Milk Cow']);
        actionTimeDisplay.injectQueueTimes(menu);
        await flush();

        expect(totalText()).toContain('Total time: [∞]');
        expect(totalText()).not.toContain('Total XP: 50.00K');
        expect(xpLines(menu)).toEqual(['XP: 50.00K (36.00K/hr)']);
    });

    test('queued alchemy rows read the XP their item grants, not "no xp figure"', async () => {
        // Base XP comes from the item's level: decompose 1.4 x level + 14, coinify level + 10.
        // A failed attempt teaches a tenth of a success.
        game.itemDetailMap = {
            [STAR_FRUIT]: { hrid: STAR_FRUIT, itemLevel: 40, alchemyDetail: { bulkMultiplier: 1 } },
            [FORAGING_ESSENCE]: { hrid: FORAGING_ESSENCE, itemLevel: 20, alchemyDetail: { bulkMultiplier: 1 } },
        };
        game.actionDetails = { ...game.actionDetails, [DECOMPOSE]: decompose, [COINIFY]: coinify };
        game.inventory = [
            { itemHrid: STAR_FRUIT, itemLocationHrid: '/item_locations/inventory', enhancementLevel: 0, count: 500 },
            {
                itemHrid: FORAGING_ESSENCE,
                itemLocationHrid: '/item_locations/inventory',
                enhancementLevel: 0,
                count: 50,
            },
            { itemHrid: '/items/coin', itemLocationHrid: '/item_locations/inventory', enhancementLevel: 0, count: 1e9 },
        ];
        game.alchemyProfit = { successRate: 0.5, actionsPerHour: 100, profitPerHour: 0 };
        game.xpMultiplier = 1.2;
        game.currentActions = [
            alchemyAction(1, DECOMPOSE, STAR_FRUIT),
            alchemyAction(2, COINIFY, FORAGING_ESSENCE, 10),
        ];
        const menu = queueMenu(['Decompose: Star Fruit', 'Coinify: Foraging Essence']);
        actionTimeDisplay.injectQueueTimes(menu);
        await flush();

        // Decompose: (1.4 x 40 + 14) x 1.2 = 84 per success, 0.5 x 84 + 0.5 x 8.4 = 46.2 per
        // attempt, 4,620 an hour; Repeat-∞, but the 500 Star Fruit bound it. Coinify: 30 x 1.2
        // = 36, 19.8 per attempt, 198 over ten.
        expect(xpLines(menu)).toEqual(['XP: 23.10K (4.62K/hr)', 'XP: 198 (1.98K/hr)']);
        expect(totalText()).toContain('Total XP: 23.30K');
        expect(menu.textContent).not.toContain('no xp figure');
    });

    test('with the setting off nothing is drawn at all', async () => {
        game.showXp = false;
        game.currentActions = [combatAction(1), countedAction(2, MILK, 250)];
        const menu = queueMenu(['Gobo Planet (T3)', 'Milk Cow']);
        actionTimeDisplay.injectQueueTimes(menu);
        await flush();

        expect(xpLines(menu)).toEqual([]);
        expect(totalText()).not.toContain('XP');
    });
});
