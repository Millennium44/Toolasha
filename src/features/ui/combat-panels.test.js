/**
 * @vitest-environment happy-dom
 *
 * The four combat panels, built rather than reasoned about.
 *
 * They compute nothing — they read four collectors and lay the result out. So
 * the only failure mode is reading a field that is not there, which is exactly
 * what the Ability Book panel shipped with and what building them catches.
 */

import { describe, test, expect, afterEach, vi, beforeEach } from 'vitest';

const geometry = vi.hoisted(() => ({ width: null }));
const state = vi.hoisted(() => ({
    dps: {},
    luck: null,
    stats: null,
    breakdown: { seconds: 0, players: [] },
    taken: null,
    actions: [],
    actionDetail: null,
    filtering: true,
    inventory: [],
    openable: {},
    settings: {},
    battle: null,
    equipment: null,
    itemDetailMap: {},
    abilityDetailMap: {},
    // One object for the whole file, mutated rather than replaced: the panel
    // loads the snapshot once and caches the reference, so a reassigned object
    // would never be seen again
    snapshot: { savedAt: 0, zones: [] },
    characterId: 'char1',
}));

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 1100,
        getSetting: (key, fallback) => state.settings[key] ?? fallback ?? false,
        getSettingValue: (key, fallback) => fallback,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => state.inventory,
        getCurrentActions: () => state.actions,
        getActionDetails: () => state.actionDetail,
        getInitClientData: () => ({
            combatMonsterDetailMap: { '/monsters/rat': { name: 'Rat' } },
            itemDetailMap: state.itemDetailMap,
            abilityDetailMap: state.abilityDetailMap,
        }),
        getItemDetails: (hrid) => ({ name: hrid, isOpenable: Boolean(state.openable[hrid]) }),
        // The Record button's state reaches storage through the character key,
        // to put back the record target the last session was using
        getCurrentCharacterId: () => state.characterId,
        getCurrentCharacterGameMode: () => 'standard',
        get battleData() {
            return state.battle;
        },
        get characterEquipment() {
            return state.equipment;
        },
    },
}));
vi.mock('../../utils/all-zones-snapshot.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, loadAllZonesSnapshot: async () => state.snapshot };
});
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async () => null,
        setJSON: async () => {},
        // Reached through the character key, for the record target
        get: async (_key, _store, fallback) => fallback ?? null,
        set: async () => true,
        delete: async () => true,
        isQuotaExceeded: () => false,
    },
}));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: (panel, id, fallback) => {
        panel.style.width = `${geometry.width ?? fallback.width}px`;
    },
    saveGeometry: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: () => ({ ask: 400000, bid: 380000 }) }));
vi.mock('../../features/combat/combat-dps.js', () => ({
    default: {
        get dps() {
            return state.dps.dps ?? null;
        },
        get dtps() {
            return state.dps.dtps ?? null;
        },
        get damage() {
            return state.dps.damage ?? 0;
        },
        get taken() {
            return state.dps.taken ?? 0;
        },
        get seconds() {
            return state.dps.seconds ?? 0;
        },
        get partySize() {
            return state.dps.partySize ?? 1;
        },
    },
}));
vi.mock('../../features/combat/combat-drop-luck.js', () => ({
    default: {
        get lastResult() {
            return state.luck;
        },
    },
    formatOrdinal: (value) => `${Math.round(value * 100)}th`,
    describeLuck: () => 'about average',
}));
vi.mock('../../features/combat-stats/combat-stats-data-collector.js', () => ({
    default: { getLatestData: () => state.stats },
}));
vi.mock('../../features/combat/damage-tracker.js', () => ({
    default: {},
    damageBreakdown: () => state.breakdown,
    actionLabel: (action) => (action === 'auto' ? 'Auto attack' : action),
    isFilteringNonDamaging: () => state.filtering,
    setFilterNonDamaging: (value) => {
        state.filtering = value;
    },
    resetDamageTracker: () => {
        state.reset = true;
    },
}));

vi.mock('../../features/combat/damage-taken-tracker.js', () => ({
    default: {},
    takenBreakdown: () => state.taken,
}));

const { dpsPanel, deathsPanel, profitPanel, combatProfitView } = await import('./combat-panels.js');
const { salesTaxNetted, setSalesTaxNetted } = await import('../../features/combat-stats/sales-tax-view.js');

const panels = () => [dpsPanel, deathsPanel, profitPanel];
const FAILED = 'could not be drawn';

beforeEach(() => {
    state.dps = { dps: 4000, dtps: 500, damage: 1_000_000, taken: 125_000, seconds: 250, partySize: 2 };
    state.filtering = true;
    state.inventory = [];
    state.openable = {};
    state.settings = {};
    state.battle = null;
    state.equipment = null;
    state.itemDetailMap = {};
    state.abilityDetailMap = {};
    state.characterId = 'char1';
    // Mutated in place — see the hoisted comment
    state.snapshot.savedAt = Date.parse('2026-08-01T00:00:00Z');
    state.snapshot.zones.length = 0;
    state.snapshot.zones.push({
        zoneHrid: '/actions/combat/rats',
        zoneName: 'Rats',
        difficultyTier: 0,
        profitPerHour: 1_000_000,
    });
    state.breakdown = {
        seconds: 300,
        players: [
            {
                index: '0',
                name: 'You',
                damage: 900000,
                hits: 90,
                crits: 18,
                misses: 10,
                accuracy: 0.9,
                critRate: 0.2,
                dps: 3000,
                abilities: [{ action: 'auto', damage: 900000, hits: 90, crits: 18, misses: 10 }],
                enemies: [
                    {
                        name: 'Rat',
                        damage: 600000,
                        hits: 60,
                        crits: 12,
                        misses: 6,
                        dps: 2000,
                        abilities: [{ action: 'auto', damage: 600000, hits: 60, crits: 12, misses: 6 }],
                    },
                ],
            },
        ],
        logging: 400,
        enemies: [
            {
                name: 'Rat',
                damage: 600000,
                hits: 60,
                crits: 12,
                misses: 6,
                kills: 20,
                maxHP: 2400,
                dps: 2000,
            },
            { name: 'Wolf', damage: 300000, hits: 30, crits: 6, misses: 4, kills: 5, maxHP: 8800, dps: 1000 },
        ],
    };
    state.taken = {
        seconds: 300,
        encounters: 40,
        players: [
            { index: '0', name: 'You', damage: 3400, regen: 3600, hits: 60, misses: 5, dps: 11.3, hps: 12 },
            { index: '1', name: 'Ally', damage: 900, regen: 400, hits: 20, misses: 2, dps: 3, hps: 1.3 },
        ],
        enemies: [
            {
                name: 'Veyes',
                damage: 3100,
                hits: 50,
                min: 66,
                max: 88,
                players: [
                    { index: '0', name: 'You', damage: 2800, hits: 44, min: 66, max: 88 },
                    { index: '1', name: 'Ally', damage: 300, hits: 6, min: 40, max: 60 },
                ],
            },
            {
                name: 'Unknown Enemy',
                damage: 8,
                hits: 1,
                min: 8,
                max: 8,
                players: [{ index: '0', name: 'You', damage: 8, hits: 1, min: 8, max: 8 }],
            },
        ],
        waves: [
            { name: 'Veyes x2', encounters: 1, damage: 171, average: 171, min: 83, max: 88 },
            { name: 'Eye x2 + Veyes', encounters: 2, damage: 230, average: 115, min: 49, max: 66 },
        ],
    };
    state.actions = [{ actionHrid: '/actions/combat/rats' }];
    state.actionDetail = {
        combatZoneInfo: {
            fightInfo: {
                randomSpawnInfo: {
                    maxSpawnCount: 1,
                    maxTotalStrength: 10,
                    spawns: [{ combatMonsterHrid: '/monsters/rat', rate: 1, strength: 1 }],
                },
            },
        },
    };
    state.luck = { percentile: 0.51, income: 5_000_000, expected: 4_000_000, battles: 300, hasBonuses: true };
    state.stats = {
        durationSeconds: 3600,
        totalEncounters: 400,
        players: [
            // Coins, because they are revenue at face value and so need no
            // market to price — the calculator here is the real one
            { name: 'Ally', deathCount: 2, loot: { a: { itemHrid: '/items/coin', count: 500_000 } } },
            {
                name: 'You',
                isCurrentPlayer: true,
                deathCount: 4,
                loot: { a: { itemHrid: '/items/coin', count: 2_000_000 } },
                dailyIncome: { ask: 100, bid: 80 },
                dailyProfit: { ask: 60, bid: 40 },
                dailyConsumableCosts: 30,
                dailyKeyCosts: 10,
            },
        ],
    };
});

afterEach(() => {
    for (const panel of panels()) panel.hide();
});

describe('every panel draws', () => {
    test('with data, and none of them fails', () => {
        for (const panel of panels()) {
            panel.show();
            expect(panel.panel.textContent).not.toContain(FAILED);
        }
    });

    test('with nothing loaded, and still none of them fails', () => {
        // The state every panel is in for the first minute of a session
        state.dps = {};
        state.luck = null;
        state.stats = null;
        state.breakdown = { seconds: 0, logging: 0, players: [], enemies: [] };
        // Null rather than empty: before its feature has started, the tracker is
        // not there to be asked at all
        state.taken = null;

        for (const panel of panels()) {
            panel.show();
            expect(panel.panel.textContent).not.toContain(FAILED);
            expect(panel.panel.textContent.length).toBeGreaterThan(0);
        }
    });

    test('opening one twice does not build a second', () => {
        dpsPanel.show();
        dpsPanel.show();
        expect(document.querySelectorAll('#toolasha-dpsPanel-panel')).toHaveLength(1);
    });

    test('hiding takes it off the page and stops its clock', () => {
        dpsPanel.show();
        dpsPanel.hide();
        expect(document.querySelector('#toolasha-dpsPanel-panel')).toBeNull();
        expect(dpsPanel.refreshId).toBeNull();
    });

    test('a panel that throws says so instead of showing an empty box', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        state.stats = {
            players: [
                {
                    isCurrentPlayer: true,
                    get name() {
                        throw new Error('deliberate');
                    },
                },
            ],
        };
        deathsPanel.show();
        expect(deathsPanel.panel.textContent).toContain('deliberate');
    });
});

/** The first player row, whichever way its arrow is pointing */
const dpsPlayerRow = () =>
    [...dpsPanel.panel.querySelectorAll('div')].find((el) => /^[\u25b6\u25bc]/.test(el.textContent));

/** Shut every open row — the panel remembers them between openings, as it should */
function collapseDpsRows() {
    for (let guard = 0; guard < 10; guard += 1) {
        const open = [...dpsPanel.panel.querySelectorAll('div')].find((el) => el.textContent.startsWith('\u25bc'));
        if (!open) return;
        open.click();
    }
}

describe('what the panels add over their tiles', () => {
    test('Damage says whether you are winning the exchange', () => {
        // 4,000 dealt against 500 taken
        dpsPanel.show();
        expect(dpsPanel.panel.textContent).toContain('8.0× in your favour');
    });

    test('DPs lays it out as a table, with the columns it uses', () => {
        dpsPanel.show();
        const text = dpsPanel.panel.textContent;

        expect(text).toContain('Character / Ability');
        expect(text).toContain('Atks');
        expect(text).toContain('Crit');
        expect(text).toContain('You');
        // Ninety hits against ten misses, written as DPs writes it
        expect(text).toContain('90 (90.0%)');
    });

    test('the abilities are behind the row rather than always on it', () => {
        // A table that lists every ability of every player at once is a wall,
        // which is why DPs makes the player row the thing you open
        dpsPanel.show();
        collapseDpsRows();
        expect(dpsPanel.panel.textContent).not.toContain('Auto attack');

        dpsPlayerRow().click();
        expect(dpsPanel.panel.textContent).toContain('Auto attack');
    });

    test('an opened row stays open when the panel repaints', () => {
        // It repaints every couple of seconds; a row that shuts itself while
        // you are reading it is worse than one that never opened
        dpsPanel.show();
        collapseDpsRows();
        dpsPlayerRow().click();

        dpsPanel.refresh();
        expect(dpsPanel.panel.textContent).toContain('Auto attack');
    });

    test('and carries the non-damaging filter DPs has, in the header', () => {
        dpsPanel.show();
        const toggle = [...dpsPanel.panel.querySelectorAll('button')].find((b) =>
            b.textContent.startsWith('Filter Nondamage')
        );
        expect(toggle.textContent).toContain('Enabled');

        toggle.click();
        expect(state.filtering).toBe(false);
        state.filtering = true;
    });

    test('the enemies sit under the player who fought them', () => {
        // Collapsing a player takes their enemies with them, as DPs does it:
        // one player kiting while another burns the boss is two fights, and a
        // party-wide enemy row averages them into neither
        // Asserted on the row rather than the panel text: the enemy-HP card
        // below names the same monsters, and that card is party-level on purpose
        const ratRow = () =>
            [...dpsPanel.panel.querySelectorAll('div')].find((el) => /^[\u25b6\u25bc]\s+Rat/.test(el.textContent));

        dpsPanel.show();
        collapseDpsRows();
        expect(ratRow()).toBeUndefined();

        dpsPlayerRow().click();
        expect(ratRow()).toBeTruthy();
    });

    test('the health bars give a second reading the attribution cannot drift from', () => {
        // 20 rats at 2.4K plus 5 wolves at 8.8K is 92K of health, over 300s of
        // battle time and 400s of logging
        dpsPanel.show();
        const text = dpsPanel.panel.textContent;

        expect(text).toContain('DPS based off enemy HPs');
        expect(text).toContain('306.7'); // 92,000 / 300
        expect(text).toContain('230.0'); // 92,000 / 400
        expect(text).toContain('25'); // enemies killed
        expect(text).toContain('20 kills × 2.4K HP = 48.0K');
    });

    test('with nothing dead it says so rather than dividing by nothing', () => {
        state.breakdown = { ...state.breakdown, enemies: [{ name: 'Rat', damage: 10, hits: 1, kills: 0, maxHP: 0 }] };
        dpsPanel.show();

        expect(dpsPanel.panel.textContent).toContain('no health bars to count');
    });

    test('an enemy row opens to what was used against it', () => {
        // The question an enemy row raises: is it tanky, or is the wrong thing
        // being pointed at it
        dpsPanel.show();
        collapseDpsRows();
        dpsPlayerRow().click();

        const rat = [...dpsPanel.panel.querySelectorAll('div')].find((el) => el.textContent.startsWith('▶  Rat'));
        rat.click();

        // The player's own ability row and the one used against the rat
        expect(dpsPanel.panel.textContent.match(/Auto attack/g).length).toBeGreaterThan(1);
        collapseDpsRows();
    });

    test('a width remembered from before the table is widened to fit it', () => {
        // The panel was 440 wide when it was a stack of cards; a table at that
        // width is a column of ellipses, and nothing else would widen it again
        dpsPanel.hide();
        geometry.width = 320;
        dpsPanel.show();

        expect(parseFloat(dpsPanel.panel.style.width)).toBeGreaterThanOrEqual(460);
        geometry.width = null;
    });

    test('a name too long for its column is still readable', () => {
        // The first column is the one that truncates first and the only cell
        // you cannot infer from the others
        dpsPanel.show();
        const cell = [...dpsPanel.panel.querySelectorAll('span')].find((el) => el.textContent.includes('You'));

        expect(cell.title).toContain('You');
    });

    test('and a Reset, as DPs has', () => {
        state.reset = false;
        dpsPanel.show();
        [...dpsPanel.panel.querySelectorAll('button')].find((b) => b.textContent === 'Reset').click();

        expect(state.reset).toBe(true);
    });

    test('with nothing attributed it says why rather than showing zeroes', () => {
        state.breakdown = { seconds: 0, logging: 0, players: [], enemies: [] };
        dpsPanel.show();
        expect(dpsPanel.panel.textContent).toContain('needs a cast to start');
    });

    test('IHurt leads with deaths per player and for the party', () => {
        // A party figure says the group is dying and not who, and "who" is the
        // whole question when one member is under-geared for the zone
        deathsPanel.show();
        const text = deathsPanel.panel.textContent;

        expect(text).toContain('Session Deaths:');
        expect(text).toContain('Session Deaths/hr:');
        expect(text).toContain('Ally');
        expect(text).toContain('You');
        // Two plus four across an hour
        expect(text).toContain('6');
    });

    test('damage taken and healed are shown side by side, never netted', () => {
        // A net figure of −200 describes both a comfortable zone and one you
        // barely survive; the pair is what tells them apart
        deathsPanel.show();
        const text = deathsPanel.panel.textContent;

        expect(text).toContain('Total dmg');
        expect(text).toContain('Total regen');
        expect(text).toContain('Damage/s');
        expect(text).toContain('Regen/s');
    });

    test('deaths come from the server even when the tracker has never seen the player', () => {
        // Two sources for one number is two numbers that eventually disagree
        state.taken = { seconds: 0, encounters: 0, players: [], enemies: [], waves: [] };
        deathsPanel.show();

        expect(deathsPanel.panel.textContent).toContain('Ally');
        expect(deathsPanel.panel.textContent).not.toContain(FAILED);
    });

    test('it breaks the damage down by what dealt it, with hit ranges', () => {
        // An average of forty with a maximum of two hundred is a zone that kills
        // you, and the average alone says it is comfortable
        deathsPanel.show();
        const text = deathsPanel.panel.textContent;

        expect(text).toContain('Enemy Damage to Party:');
        expect(text).toContain('Veyes');
        expect(text).toContain('[66-88]');
    });

    test('and by wave, so a composition can be recognised again', () => {
        deathsPanel.show();
        const text = deathsPanel.panel.textContent;

        expect(text).toContain('Damage Profiles');
        expect(text).toContain('Eye x2 + Veyes');
        expect(text).toContain('Avg/Encounter');
    });

    test('the sections start open, since collapsed there is nothing to read', () => {
        deathsPanel.show();
        expect(deathsPanel.panel.textContent).toContain('▼');
    });

    test('a section closes and stays closed through a repaint', () => {
        deathsPanel.show();
        const header = [...deathsPanel.panel.querySelectorAll('div')].find((element) =>
            element.textContent.startsWith('▼Enemy Damage to Party:')
        );
        header.click();

        expect(deathsPanel.panel.textContent).not.toContain('[66-88]');
        deathsPanel.refresh();
        expect(deathsPanel.panel.textContent).not.toContain('[66-88]');
    });

    test('an unattributed hit is named rather than dropped', () => {
        // Dropping it would make the enemy totals disagree with the party total
        deathsPanel.show();
        expect(deathsPanel.panel.textContent).toContain('Unknown Enemy');
    });

    test('it counts kills against what the zone owed', () => {
        // Seven Rats is a lot or a little depending entirely on how often the
        // zone spawns them, and nobody carries that number around
        deathsPanel.show();
        const text = deathsPanel.panel.textContent;

        expect(text).toContain('Encounters & Kills:');
        expect(text).toContain('Kills: 25');
        expect(text).toContain('Actual: 20');
        expect(text).toContain('Expected:');
        expect(text).toMatch(/[+-]\d+\.\d%/);
    });

    test('a monster the zone spawns but which has not died is still listed', () => {
        // A rare spawn you have not seen once is what somebody checking this is
        // looking for, and an absent row reads as "not in this zone"
        state.breakdown.enemies = [
            { name: 'Wolf', damage: 1, hits: 1, crits: 0, misses: 0, kills: 3, maxHP: 100, dps: 1 },
        ];
        deathsPanel.show();

        expect(deathsPanel.panel.textContent).toContain('Rat');
    });

    test('off a modelled zone it shows the counts and no comparison', () => {
        // Rather than comparing against zero, which would call every kill
        // infinitely lucky
        state.actionDetail = null;
        deathsPanel.show();
        const text = deathsPanel.panel.textContent;

        expect(text).toContain('Actual: 20');
        expect(text).not.toContain('Expected:');
    });

    test('and it says why an attacker can be unknown', () => {
        deathsPanel.show();
        expect(deathsPanel.panel.textContent).toContain('auto-attack spends none');
    });

    test('with nothing having hit the party it says so rather than showing nothing', () => {
        state.taken = { seconds: 0, encounters: 0, players: [], enemies: [], waves: [] };
        deathsPanel.show();

        expect(deathsPanel.panel.textContent).toContain('Nothing has hit the party yet');
    });

    test('Profit names the three cases HWhat names', () => {
        profitPanel.show();
        const text = profitPanel.panel.textContent;

        expect(text).toContain('Lazy Profit');
        expect(text).toContain('Mid Profit');
        expect(text).toContain('Revenue (Bid) - Cost (Ask)');
    });

    test('and costs the weekly tax in cowbell bags', () => {
        profitPanel.show();
        const text = profitPanel.panel.textContent;

        expect(text).toContain('Pay the MooPass');
        expect(text).toContain('25 bags');
    });

    test('each case shows its working, not just its conclusion', () => {
        // "55.6M/day" is a conclusion. The sum beneath it is the same
        // conclusion with the revenue and the cost visible, which is what says
        // whether a bad number is a revenue problem or a cost problem.
        profitPanel.show();
        const text = profitPanel.panel.textContent;

        expect(text).toContain('coin/day');
        expect(text).toMatch(/-?[\d.]+[KMB]? - -?[\d.]+[KMB]? = -?[\d.]+[KMB]?/);
    });

    test('Costs Off drops the cost side rather than zeroing it', () => {
        profitPanel.show();
        const button = [...profitPanel.panel.querySelectorAll('button')].find((b) => b.textContent === 'Costs On');
        expect(button).toBeTruthy();

        button.click();
        const text = profitPanel.panel.textContent;
        expect(text).toContain('Costs Off');
        expect(text).not.toContain('Cost (Ask)');

        // Put it back, since the panel remembers between openings
        [...profitPanel.panel.querySelectorAll('button')].find((b) => b.textContent === 'Costs Off').click();
    });

    test('the mode button cycles the headline through the three cases', () => {
        profitPanel.show();
        const mode = () =>
            [...profitPanel.panel.querySelectorAll('button')].find((b) =>
                ['Lazy', 'Mid', 'Patient'].includes(b.textContent)
            );

        const first = mode().textContent;
        mode().click();
        expect(mode().textContent).not.toBe(first);
    });

    test('the fourth corner of the book is there too', () => {
        // Bid-Ask, Bid-Bid and Ask-Bid have names; Ask - Ask is the one that
        // does not, and leaving it out leaves the set incomplete
        profitPanel.show();
        const text = profitPanel.panel.textContent;

        expect(text).toContain('Ask - Ask');
        expect(text).toContain('Revenue (Ask) - Cost (Ask)');
        // Each named case says which corner it is, so the set reads as a set
        expect(text).toContain('(Bid - Bid)');
    });

    test('the tax counts what is already in the bag', () => {
        // 25 bags a week is the price of a MooPass, not the price of *your*
        // MooPass — cowbells accumulate, and charging for all 25 overstates it
        state.inventory = [
            { itemHrid: '/items/cowbell', count: 50 },
            { itemHrid: '/items/bag_of_10_cowbells', count: 5 },
        ];
        profitPanel.show();

        // 50 loose plus 5 bags is 100 cowbells, so 15 bags are still owed
        expect(profitPanel.panel.textContent).toContain('15 of 25 bags');
    });

    test('Moopass On subtracts it from every case', () => {
        profitPanel.show();
        const before = profitPanel.panel.textContent;
        expect(before).toContain('Moopass Off');

        [...profitPanel.panel.querySelectorAll('button')].find((b) => b.textContent === 'Moopass Off').click();
        const after = profitPanel.panel.textContent;

        expect(after).toContain('Moopass On');
        expect(after).toContain('Paying the MooPass');
        // Three terms in the sum now, not two
        expect(after).toMatch(/-?[\d.]+[KMB]? - -?[\d.]+[KMB]? - -?[\d.]+[KMB]? = -?[\d.]+[KMB]?/);

        [...profitPanel.panel.querySelectorAll('button')].find((b) => b.textContent === 'Moopass On').click();
    });

    test('the Tax button flips whether income is netted of the market sale tax', () => {
        const wasNetted = salesTaxNetted();
        try {
            setSalesTaxNetted(true);
            profitPanel.show();
            expect(profitPanel.panel.textContent).toContain('Tax On');

            [...profitPanel.panel.querySelectorAll('button')].find((b) => b.textContent === 'Tax On').click();
            expect(salesTaxNetted()).toBe(false);
            expect(profitPanel.panel.textContent).toContain('Tax Off');

            [...profitPanel.panel.querySelectorAll('button')].find((b) => b.textContent === 'Tax Off').click();
            expect(salesTaxNetted()).toBe(true);
        } finally {
            setSalesTaxNetted(wasNetted);
        }
    });

    test('the tile is told which reading the panel is showing', () => {
        // The tile used to be hard-wired to bid revenue less every cost, which
        // is one of four readings and not necessarily the one on screen
        profitPanel.show();
        const lazy = combatProfitView(state.stats);
        expect(lazy).toBeTruthy();

        [...profitPanel.panel.querySelectorAll('button')]
            .find((b) => ['Lazy', 'Mid', 'Patient', 'Ask'].includes(b.textContent.split(' ')[0]))
            .click();

        expect(combatProfitView(state.stats).title).not.toBe(lazy.title);
    });

    test('nothing to read from is nothing rather than a row of zeroes', () => {
        expect(combatProfitView(null)).toBeNull();
    });

    test('the tile carries the tax only when the panel is counting it', () => {
        profitPanel.show();
        expect(combatProfitView(state.stats).tax).toBe(0);

        [...profitPanel.panel.querySelectorAll('button')].find((b) => b.textContent === 'Moopass Off').click();
        expect(combatProfitView(state.stats).tax).toBeGreaterThan(0);

        [...profitPanel.panel.querySelectorAll('button')].find((b) => b.textContent === 'Moopass On').click();
    });

    test('Profit lists every character, not only you', () => {
        // Loot is rolled per character against their own drop gear, so a party
        // does not split a zone evenly — and the panel only ever asked the
        // calculator about the current player
        profitPanel.show();
        const text = profitPanel.panel.textContent;

        expect(text).toContain('Per player');
        expect(text).toContain('Ally');
        expect(text).toContain('You');
    });

    test('and puts you first, whatever order the party arrived in', () => {
        // The collector lists Ally first; the panel is read by one person
        profitPanel.show();
        const rows = [...profitPanel.panel.querySelectorAll('div')].filter((element) =>
            element.textContent.startsWith('You')
        );
        const allies = [...profitPanel.panel.querySelectorAll('div')].filter((element) =>
            element.textContent.startsWith('Ally')
        );

        expect(rows.length).toBeGreaterThan(0);
        expect(allies.length).toBeGreaterThan(0);
        expect(
            rows[rows.length - 1].compareDocumentPosition(allies[0]) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
    });

    test('solo there is nobody to compare against, so the section is not drawn', () => {
        state.stats.players = [state.stats.players[1]];
        profitPanel.show();

        expect(profitPanel.panel.textContent).not.toContain('Per player');
    });

    test('a dungeon says its chests are counted at expected value', () => {
        // Which is the thing that makes a dungeon read as a loss until it pays:
        // the key is charged when the chest drops, and the chest is worth what
        // opening it is worth rather than what it sells for
        state.openable['/items/chimerical_chest'] = true;
        state.stats.players[1].loot = { a: { itemHrid: '/items/chimerical_chest', count: 3 } };
        profitPanel.show();

        expect(profitPanel.panel.textContent).toContain('expected value');
    });

    test('Profit shows what patience is worth', () => {
        profitPanel.show();
        expect(profitPanel.panel.textContent).toContain('Patient over lazy');
    });
});

/** Let the snapshot load land — one microtask queue flush is all it needs */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the sim forecast beside the measured revenue', () => {
    test('quotes the snapshot row for this zone at this tier, dated and marked simulated', async () => {
        profitPanel.show();
        await flush();
        profitPanel.refresh();

        const text = profitPanel.panel.textContent;
        expect(text).toContain('sim said here');
        // 1M/hr × 24, and never presented as a measurement
        expect(text).toContain('24.0M/day');
        expect(text).toContain('simulated');

        // The tooltip lives on the line itself, now wrapped in its own card at
        // the foot of the panel — find the element that carries the title
        const row = [...profitPanel.panel.querySelectorAll('div')].find(
            (el) => el.textContent.startsWith('sim said here') && el.title
        );
        expect(row.title).toContain('knows nothing about this run');
        expect(row.title).toContain('Rats');
    });

    test('a tier mismatch draws nothing rather than a neighbouring figure', async () => {
        // Tier 1 of a zone is a different fight from the tier 0 being run
        state.snapshot.zones[0].difficultyTier = 1;
        profitPanel.show();
        await flush();
        profitPanel.refresh();

        expect(profitPanel.panel.textContent).not.toContain('sim said here');
    });

    test('a zone the sim never ran draws nothing', async () => {
        state.actions = [{ actionHrid: '/actions/combat/elsewhere' }];
        profitPanel.show();
        await flush();
        profitPanel.refresh();

        expect(profitPanel.panel.textContent).not.toContain('sim said here');
    });

    test('a character switch drops the snapshot rather than quoting it at the next character', async () => {
        profitPanel.show();
        await flush();
        profitPanel.refresh();
        expect(profitPanel.panel.textContent).toContain('24.0M/day');

        // The snapshot is stored per character, and this one has never run the
        // sim: the line has to go, not carry the last character's figure over
        state.characterId = 'char2';
        state.snapshot = { savedAt: 0, zones: [] };

        profitPanel.refresh();
        await flush();
        profitPanel.refresh();

        expect(profitPanel.panel.textContent).not.toContain('sim said here');
        expect(profitPanel.panel.textContent).not.toContain('24.0M/day');
    });
});

describe('the live party lint on the Damage panel', () => {
    /** A `new_battle` player with the whole equipped kit, as the payload has it */
    const battlePlayer = (id, name, abilityHrids) => ({
        character: { id, name },
        combatDetails: { combatAbilities: abilityHrids.map((hrid) => ({ abilityHrid: hrid, level: 40 })) },
    });

    beforeEach(() => {
        state.abilityDetailMap = {
            '/abilities/fierce_aura': {
                name: 'Fierce Aura',
                isSpecialAbility: true,
                abilityEffects: [
                    {
                        targetType: 'allAllies',
                        effectType: '/ability_effect_types/buff',
                        buffs: [{ uniqueHrid: '/buff_uniques/fierce_aura' }],
                    },
                ],
            },
            '/abilities/sweep': { name: 'Sweep', isSpecialAbility: false, abilityEffects: [] },
        };
        state.itemDetailMap = {
            '/items/foragers_top': {
                name: "Forager's Top",
                equipmentDetail: {
                    type: '/equipment_types/body',
                    combatStats: {},
                    noncombatStats: { foragingExperience: 0.1 },
                },
            },
        };
        state.battle = {
            players: [
                battlePlayer('char1', 'You', ['/abilities/fierce_aura']),
                battlePlayer('char2', 'Ally', ['/abilities/fierce_aura']),
            ],
        };
    });

    test('a duplicated aura across the live party is called out in amber', () => {
        dpsPanel.show();

        const text = dpsPanel.panel.textContent;
        expect(text).toContain('Fierce Aura is equipped by You and Ally — auras do not stack');
    });

    test('your own skilling gear is flagged, and the block says gear is checked for you only', () => {
        state.equipment = new Map([['/item_locations/body', { itemHrid: '/items/foragers_top', enhancementLevel: 2 }]]);
        dpsPanel.show();

        const text = dpsPanel.panel.textContent;
        expect(text).toContain("You has skilling gear equipped: Forager's Top");
        expect(text).toContain('checked for you only');
    });

    test('solo draws nothing, whatever is equipped', () => {
        state.battle = { players: [battlePlayer('char1', 'You', ['/abilities/fierce_aura'])] };
        state.equipment = new Map([['/item_locations/body', { itemHrid: '/items/foragers_top' }]]);
        dpsPanel.show();

        expect(dpsPanel.panel.textContent).not.toContain('⚠');
    });

    test('a clean party draws no block at all', () => {
        state.battle = {
            players: [
                battlePlayer('char1', 'You', ['/abilities/fierce_aura']),
                battlePlayer('char2', 'Ally', ['/abilities/sweep']),
            ],
        };
        dpsPanel.show();

        expect(dpsPanel.panel.textContent).not.toContain('⚠');
    });

    test('the setting turns it off', () => {
        state.settings.partyLint_live = false;
        dpsPanel.show();

        expect(dpsPanel.panel.textContent).not.toContain('auras do not stack');
    });
});

describe('the Record button in the DPs header', () => {
    /** The shared recorder, as the panel finds it */
    function install(recording = false) {
        const fake = {
            recording,
            downloads: 0,
            isRecording: () => fake.recording,
            recordingStatus: () => ({ ticks: 240, seconds: 600, full: false, fights: 37, target: null }),
            normalizeTarget: () => null,
            startRecording: vi.fn(() => {
                fake.recording = true;
            }),
            stopRecording: vi.fn(() => {
                fake.recording = false;
            }),
            // What the real one now writes: every segment of the session, not
            // whatever the last rotation happened to leave in the buffer
            downloadRecording: vi.fn(() => {
                fake.downloads += 1;
                return true;
            }),
            setRecordTarget: vi.fn(),
        };
        globalThis.window.Toolasha = { Combat: { combatRecorder: fake } };
        return fake;
    }

    /** The header button carrying this label */
    const labelled = (text) =>
        [...dpsPanel.panel.querySelectorAll('button')].find((button) => button.textContent.startsWith(text));

    afterEach(() => {
        delete globalThis.window.Toolasha;
    });

    test('stopping from here writes the recording out', () => {
        const recorder = install(true);
        dpsPanel.show();

        labelled('Recording').click();

        expect(recorder.stopRecording).toHaveBeenCalledTimes(1);
        // The whole session. Rotation used to leave this handing over the last
        // segment only, on a recording that had banked a dozen.
        expect(recorder.downloadRecording).toHaveBeenCalledTimes(1);
    });

    test('a simulation running elsewhere does not change what the button says', async () => {
        const recorder = install(true);
        dpsPanel.show();
        expect(labelled('Recording 37 fights…')).toBeTruthy();

        for (let i = 0; i < 5; i += 1) {
            dpsPanel.refresh();
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        expect(labelled('Recording 37 fights…')).toBeTruthy();
        expect(labelled('Record (')).toBeFalsy();
        expect(recorder.stopRecording).not.toHaveBeenCalled();
        // And nothing wrote to the recorder on the way past: a target restored
        // from disk underneath a running recording is how one stops itself
        expect(recorder.setRecordTarget).not.toHaveBeenCalled();
    });
});
