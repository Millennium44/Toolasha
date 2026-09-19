/**
 * A counted combat row in the queue, timed from the last all-zones simulation.
 *
 * Every combat row used to read `[∞]`, a "Fight 580 times" included: the queue had no rate
 * to divide the count by. The all-zones snapshot now keeps encounters per hour per zone, and
 * the game's count and the simulator's encounter are the same unit — one wave. So a counted
 * row can be timed, but only as what it is: a simulated figure, in whatever gear the run was
 * set up with, from however long ago. These tests hold the row to saying so, and hold an
 * unknown to reading as one rather than as a time.
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
    combatSim: false,
    simUI: null,
    characterId: 'char1',
    valueMode: 'profit',
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => game.currentActions,
        getActionDetails: (hrid) => game.actionDetails[hrid] ?? null,
        getItemDetails: () => null,
        getInventory: () => [],
        getInitClientData: () => ({ itemDetailMap: {} }),
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

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => key === 'actionQueue' || (key === 'combatSim' && game.combatSim),
        getSettingValue: (key, fallback) => (key === 'actionQueue_valueMode' ? game.valueMode : fallback),
        COLOR_TOOLTIP_INFO: '#abc',
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    // Not loaded, so the panel's async profit pass never runs and the total is what it drew
    default: { isLoaded: () => false, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../enhancement/enhancement-xp.js', () => ({ calculateEnhancementPredictions: () => null }));

vi.mock('../../utils/all-zones-snapshot.js', async (importOriginal) => ({
    ...(await importOriginal()),
    loadAllZonesSnapshot: async () => game.snapshot,
    loadZoneSimRates: async () => game.rates,
}));

vi.mock('../../utils/bundle-bridge.js', async (importOriginal) => ({
    ...(await importOriginal()),
    combatSimUI: () => game.simUI,
}));

const { default: actionTimeDisplay, estimateCombatQueueRow } = await import('./action-time-display.js');

// Local time, so the completion clocks read the same in every timezone
const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;
const GOBO = '/actions/combat/gobo_planet';
const DEN = '/actions/combat/chimerical_den';
const COINIFY = '/actions/alchemy/coinify';
const COMBAT_ID = 41704;
const TANK_ID = 41705;

function combatAction(id, { maxCount = 580, currentCount = 80, tier = 3, loadoutId = COMBAT_ID, hrid = GOBO } = {}) {
    return {
        id,
        ordinal: id,
        actionHrid: hrid,
        difficultyTier: tier,
        characterLoadoutID: loadoutId,
        primaryItemHash: '',
        hasMaxCount: maxCount > 0,
        maxCount,
        currentCount,
    };
}

function coinifyAction(id, remaining = 3) {
    return {
        id,
        ordinal: id,
        actionHrid: COINIFY,
        difficultyTier: 0,
        characterLoadoutID: 0,
        primaryItemHash: '',
        hasMaxCount: true,
        maxCount: remaining,
        currentCount: 0,
    };
}

/** An all-zones run: 500 waves an hour at Gobo Planet T3, in the named loadout. */
function snapshot({ rate = 500, tier = 3, loadout = { source: 'loadout', name: 'Combat' }, ageMs = 3 * HOUR } = {}) {
    return {
        savedAt: NOW - ageMs,
        fingerprint: 'abc',
        ...(loadout === null ? {} : { loadout }),
        zones: [
            {
                zoneHrid: GOBO,
                zoneName: 'Gobo Planet',
                difficultyTier: tier,
                profitPerHour: 1_000_000,
                xpPerHour: 50_000,
                ...(rate === null ? {} : { encountersPerHour: rate }),
            },
        ],
    };
}

const gobo = { hrid: GOBO, name: 'Gobo Planet', type: '/action_types/combat', combatZoneInfo: { isDungeon: false } };
const den = { hrid: DEN, name: 'Chimerical Den', type: '/action_types/combat', combatZoneInfo: { isDungeon: true } };

function estimate(overrides = {}) {
    return estimateCombatQueueRow({
        actionObj: combatAction(1),
        actionDetails: gobo,
        snapshot: snapshot(),
        rowLoadout: { known: true, name: 'Combat' },
        now: NOW,
        ...overrides,
    });
}

describe('estimateCombatQueueRow', () => {
    test('times the remaining waves at the simulated rate, marked as an estimate', () => {
        const result = estimate();
        expect(result.kind).toBe('estimate');
        // 500 waves left at 500 an hour
        expect(result.seconds).toBe(3600);
        expect(result.flags).toEqual([]);
        expect(result.text).toBe('[~1h 00m 00s · sim]');
        expect(result.title).toContain('500 waves/h');
        expect(result.title).toContain('3h ago');
        expect(result.title).toContain('Combat loadout, which this action also uses');
    });

    test('a run in another named loadout still estimates, and says so', () => {
        const result = estimate({ rowLoadout: { known: true, name: 'Tank' } });
        expect(result.text).toContain('~');
        expect(result.kind).toBe('estimate');
        expect(result.seconds).toBe(3600);
        expect(result.flags).toEqual(['other gear']);
        expect(result.text).toBe('[~1h 00m 00s · sim, other gear]');
        expect(result.title).toContain('but this action uses your Tank loadout');
    });

    test('a row fought in no loadout does not match a run in a named one', () => {
        const result = estimate({ rowLoadout: { known: true, name: null } });
        expect(result.flags).toEqual(['other gear']);
        expect(result.title).toContain('uses no loadout');
    });

    test.each([
        ['a hand-edited simulator setup', { source: 'editor', name: 'Combat' }],
        ['worn gear', { source: 'worn', name: null }],
        ['an unrecorded source', { source: 'unknown', name: null }],
        ['a run that predates the field', null],
    ])('%s is unknown gear, never a match', (_label, loadout) => {
        const result = estimate({ snapshot: snapshot({ loadout }) });
        expect(result.kind).toBe('estimate');
        expect(result.flags).toEqual(['unknown gear']);
        expect(result.text).toBe('[~1h 00m 00s · sim, unknown gear]');
    });

    test('a row whose loadout cannot be resolved is unknown gear', () => {
        const result = estimate({ rowLoadout: { known: false, name: null } });
        expect(result.flags).toEqual(['unknown gear']);
    });

    test('a run over a week old is flagged stale', () => {
        const result = estimate({ snapshot: snapshot({ ageMs: 8 * 24 * HOUR }) });
        expect(result.flags).toEqual(['stale']);
        expect(result.text).toBe('[~1h 00m 00s · sim, stale]');
        expect(result.title).toContain('8d ago');
    });

    test.each([
        ['no snapshot', { snapshot: null }],
        ['no row for this tier', { snapshot: snapshot({ tier: 2 }) }],
        ['a run that predates the rate', { snapshot: snapshot({ rate: null }) }],
        ['a run with no encounters', { snapshot: snapshot({ rate: 0 }) }],
    ])('%s reads as unknown, not as a time', (_label, overrides) => {
        const result = estimate(overrides);
        expect(result.kind).toBe('unknown');
        expect(result.seconds).toBeNull();
        expect(result.text).toBe('[? · no sim rate]');
        expect(result.text).not.toMatch(/\d/);
        expect(result.title).toMatch(/^No time estimate/);
    });

    test('a dungeon reads as unknown: its count is runs and the sim rates waves', () => {
        const result = estimate({
            actionObj: combatAction(1, { hrid: DEN, tier: 0 }),
            actionDetails: den,
            snapshot: { ...snapshot(), zones: [{ ...snapshot().zones[0], zoneHrid: DEN, difficultyTier: 0 }] },
        });
        expect(result.kind).toBe('unknown');
        expect(result.title).toContain('dungeon');
    });

    test('Fight ∞ stays infinite', () => {
        const result = estimate({ actionObj: combatAction(1, { maxCount: 0 }) });
        expect(result.kind).toBe('infinite');
    });

    test('a non-combat row is not its business', () => {
        expect(estimate({ actionObj: coinifyAction(1), actionDetails: { hrid: COINIFY } })).toBeNull();
    });
});

/** A single-zone rate from a row's button: 250 waves an hour at Gobo Planet T3 in the Combat loadout. */
function zoneRate(overrides = {}) {
    return {
        zoneHrid: GOBO,
        difficultyTier: 3,
        loadoutId: String(COMBAT_ID),
        loadoutName: 'Combat',
        signature: 'sig-now',
        encountersPerHour: 250,
        profitPerHour: null,
        xpPerHour: null,
        hours: 24,
        savedAt: NOW - HOUR,
        ...overrides,
    };
}

describe('estimateCombatQueueRow with a single-zone rate', () => {
    test("is preferred over an all-zones run in other gear, and names the row's own loadout", () => {
        const result = estimate({
            snapshot: snapshot({ loadout: { source: 'loadout', name: 'Tank' } }),
            rowLoadout: { known: true, name: 'Combat', signature: 'sig-now' },
            zoneRate: zoneRate(),
        });
        expect(result.source).toBe('zone');
        // 500 waves left at 250 an hour
        expect(result.seconds).toBe(7200);
        expect(result.flags).toEqual([]);
        expect(result.text).toBe('[~2h 00m 00s · sim]');
        expect(result.title).toContain('Estimated, not measured');
        expect(result.title).toContain('250 waves/h, from a 24h solo simulation of Gobo Planet T3 1h ago');
        expect(result.title).toContain('your Combat loadout, the loadout this action uses');
    });

    test('times a row with no all-zones run at all', () => {
        const result = estimate({ snapshot: null, zoneRate: zoneRate() });
        expect(result.kind).toBe('estimate');
        expect(result.seconds).toBe(7200);
    });

    test('a newer all-zones run in the same gear still wins', () => {
        const result = estimate({ snapshot: snapshot({ ageMs: 60_000 }), zoneRate: zoneRate() });
        expect(result.source).toBe('allZones');
        expect(result.seconds).toBe(3600);
    });

    test('an older all-zones run in the same gear gives way', () => {
        const result = estimate({ snapshot: snapshot({ ageMs: 2 * HOUR }), zoneRate: zoneRate() });
        expect(result.source).toBe('zone');
    });

    test('a loadout edited since the run is flagged', () => {
        const result = estimate({
            rowLoadout: { known: true, name: 'Combat', signature: 'sig-edited' },
            zoneRate: zoneRate(),
            snapshot: null,
        });
        expect(result.flags).toEqual(['gear changed']);
        expect(result.text).toBe('[~2h 00m 00s · sim, gear changed]');
        expect(result.title).toContain('edited since');
    });

    test('a stale single-zone rate is flagged like any other', () => {
        const result = estimate({ snapshot: null, zoneRate: zoneRate({ savedAt: NOW - 9 * 24 * HOUR }) });
        expect(result.flags).toEqual(['stale']);
    });

    test('a run for a row with no loadout says it was worn gear', () => {
        const result = estimate({
            actionObj: combatAction(1, { loadoutId: 0 }),
            rowLoadout: { known: true, name: null, signature: null },
            snapshot: null,
            zoneRate: zoneRate({ loadoutId: '0', loadoutName: null, signature: null }),
        });
        expect(result.flags).toEqual([]);
        expect(result.title).toContain('gear worn when the run started');
    });

    test('with neither reading, the unknown points at the button', () => {
        const result = estimate({ snapshot: null });
        expect(result.text).toBe('[? · no sim rate]');
        expect(result.title).toContain('sim 24h');
    });
});

describe('the panel\u2019s "sim 24h" button', () => {
    /** A simulator whose run finishes when the test says so */
    function deferredSim() {
        const calls = [];
        const sim = {
            calls,
            simulateZoneRate: vi.fn(
                (request, options) =>
                    new Promise((resolve) => {
                        calls.push({ request, options, resolve });
                    })
            ),
        };
        return sim;
    }

    const flush = async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
    };

    const header = (root) => root.querySelector('.mwi-queue-sim-all-button');

    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        document.body.innerHTML = '';
        game.actionDetails = { [GOBO]: gobo, [DEN]: den };
        game.loadoutMap = { [COMBAT_ID]: { name: 'Combat' }, [TANK_ID]: { name: 'Tank' } };
        game.snapshot = snapshot({ loadout: { source: 'loadout', name: 'Combat' } });
        game.rates = {};
        game.combatSim = true;
        game.simUI = deferredSim();
        await actionTimeDisplay.refreshCombatSnapshot();
    });

    afterEach(() => {
        vi.useRealTimers();
        actionTimeDisplay._combatSnapshotCache = null;
        actionTimeDisplay._zoneSimRuns.clear();
        actionTimeDisplay._zoneSimErrors.clear();
        actionTimeDisplay._zoneSimSweep = null;
        actionTimeDisplay._lastQueueMenu = null;
        game.characterId = 'char1';
        game.combatSim = false;
        game.simUI = null;
        game.rates = {};
    });

    test('is one button on the panel, not one on every row', () => {
        game.currentActions = [
            combatAction(1, { loadoutId: TANK_ID }),
            combatAction(2, { maxCount: 0, loadoutId: TANK_ID }),
            combatAction(3, { hrid: DEN, tier: 0 }),
            coinifyAction(4),
        ];
        const menu = queueMenu(['Gobo Planet (T3)', 'Gobo Planet (T3)', 'Chimerical Den', 'Coinify']);
        actionTimeDisplay.injectQueueTimes(menu);

        expect(menu.querySelectorAll('.mwi-queue-zone-sim-button')).toHaveLength(0);
        expect(menu.querySelectorAll('.mwi-queue-sim-all-button')).toHaveLength(1);
        expect(header(menu).textContent).toBe('sim 24h');
        expect(header(menu).disabled).toBe(false);
        // The rows' own time text is untouched by the header above them
        expect(rowTexts(menu)[0]).toMatch(/^\[~1h 00m 00s · sim, other gear\]/);
    });

    test('sits inside the panel title, beside its text', () => {
        game.actions = [combatAction(1, { hrid: GOBO, tier: 3 }), coinifyAction(2)];
        const menu = queueMenu(['Gobo Planet (T3)', 'Coinify'], { withTitle: true });
        actionTimeDisplay.injectQueueTimes(menu);

        const title = menu.querySelector('[class*="QueuedActions_label"]');
        expect(title.contains(header(menu))).toBe(true);
        // The title text survives alongside it, and is laid out to seat the button
        expect(title.textContent).toContain('Queued Actions (2/6)');
        expect(title.style.display).toBe('flex');
        // And it is no longer a line of its own above the first row
        expect(menu.firstElementChild).toBe(title);
    });

    test('falls back to its own line when the title cannot be found', () => {
        game.actions = [combatAction(1, { hrid: GOBO, tier: 3 }), coinifyAction(2)];
        const menu = queueMenu(['Gobo Planet (T3)', 'Coinify']);
        actionTimeDisplay.injectQueueTimes(menu);

        expect(menu.querySelector('[class*="QueuedActions_label"]')).toBeNull();
        expect(menu.querySelectorAll('.mwi-queue-sim-all-button')).toHaveLength(1);
        expect(menu.firstElementChild.classList.contains('mwi-queue-sim-header')).toBe(true);
    });

    test('redrawing with a title present still leaves one button', () => {
        game.actions = [combatAction(1, { hrid: GOBO, tier: 3 }), coinifyAction(2)];
        const menu = queueMenu(['Gobo Planet (T3)', 'Coinify'], { withTitle: true });
        actionTimeDisplay.injectQueueTimes(menu);
        actionTimeDisplay.injectQueueTimes(menu);

        expect(menu.querySelectorAll('.mwi-queue-sim-all-button')).toHaveLength(1);
    });

    test('is not offered with the Combat Simulator switched off', () => {
        game.combatSim = false;
        game.currentActions = [combatAction(1)];
        const menu = queueMenu(['Gobo Planet (T3)']);
        actionTimeDisplay.injectQueueTimes(menu);
        expect(header(menu)).toBeNull();
    });

    test('is not offered on a queue with no fight in it', () => {
        game.currentActions = [coinifyAction(1)];
        const menu = queueMenu(['Coinify']);
        actionTimeDisplay.injectQueueTimes(menu);
        expect(header(menu)).toBeNull();
    });

    test('says so when every queued fight already has a fresh rate', () => {
        game.currentActions = [combatAction(1)];
        const menu = queueMenu(['Gobo Planet (T3)']);
        actionTimeDisplay.injectQueueTimes(menu);

        expect(header(menu).disabled).toBe(true);
        expect(menu.querySelector('.mwi-queue-sim-all-note').textContent).toBe(
            'every queued fight already has a fresh rate'
        );
    });

    test('simulates only the fights that are not fresh, one at a time, counting as it goes', async () => {
        // Row 1 reads clean against the all-zones run; rows 2 and 3 do not
        game.currentActions = [
            combatAction(1),
            combatAction(2, { loadoutId: TANK_ID }),
            combatAction(3, { maxCount: 0, loadoutId: TANK_ID, tier: 2 }),
        ];
        const menu = queueMenu(['Gobo Planet (T3)', 'Gobo Planet (T3)', 'Gobo Planet (T2)']);
        actionTimeDisplay.injectQueueTimes(menu);

        const sweep = actionTimeDisplay.runQueueSimSweep();
        await flush();

        const sim = game.simUI;
        expect(sim.simulateZoneRate).toHaveBeenCalledTimes(1);
        expect(sim.calls[0].request.loadoutId).toBe(TANK_ID);
        expect(header(menu).disabled).toBe(true);
        expect(header(menu).textContent).toBe('simulating\u2026 1/2 0%');

        sim.calls[0].options.onProgress(42.4);
        expect(header(menu).textContent).toBe('simulating\u2026 1/2 42%');

        sim.calls[0].resolve({
            ok: true,
            entry: zoneRate({ loadoutId: String(TANK_ID), loadoutName: 'Tank', signature: null, savedAt: NOW }),
        });
        await flush();

        // The second run only starts once the first has finished
        expect(sim.simulateZoneRate).toHaveBeenCalledTimes(2);
        expect(header(menu).textContent).toBe('simulating\u2026 2/2 0%');
        sim.calls[1].resolve({
            ok: true,
            entry: zoneRate({
                difficultyTier: 2,
                loadoutId: String(TANK_ID),
                loadoutName: 'Tank',
                signature: null,
                savedAt: NOW,
            }),
        });

        expect(await sweep).toEqual({ ok: true, simulated: 2 });
        expect(header(menu).textContent).toBe('sim 24h');
    });

    test('a second press while a sweep runs starts nothing', async () => {
        game.currentActions = [combatAction(1, { loadoutId: TANK_ID })];
        const menu = queueMenu(['Gobo Planet (T3)']);
        actionTimeDisplay.injectQueueTimes(menu);

        const first = actionTimeDisplay.runQueueSimSweep();
        await flush();
        expect(await actionTimeDisplay.runQueueSimSweep()).toBeNull();
        header(menu).disabled = false;
        header(menu).click();
        await flush();
        expect(game.simUI.simulateZoneRate).toHaveBeenCalledTimes(1);

        game.simUI.calls[0].resolve({ ok: true, entry: zoneRate({ loadoutId: String(TANK_ID), savedAt: NOW }) });
        expect(await first).toEqual({ ok: true, simulated: 1 });
    });

    test('a character switch part-way through stops the sweep where it stands', async () => {
        game.currentActions = [
            combatAction(1, { loadoutId: TANK_ID }),
            combatAction(2, { loadoutId: TANK_ID, tier: 2 }),
        ];
        const menu = queueMenu(['Gobo Planet (T3)', 'Gobo Planet (T2)']);
        actionTimeDisplay.injectQueueTimes(menu);

        const sweep = actionTimeDisplay.runQueueSimSweep();
        await flush();
        expect(game.simUI.simulateZoneRate).toHaveBeenCalledTimes(1);

        // Somebody else logs in while the first run is still going
        game.characterId = 'char2';
        game.simUI.calls[0].resolve({ ok: true, entry: zoneRate({ loadoutId: String(TANK_ID), savedAt: NOW }) });

        expect(await sweep).toEqual({ ok: true, simulated: 1 });
        // The second fight is never started for a character that did not ask for it
        expect(game.simUI.simulateZoneRate).toHaveBeenCalledTimes(1);
        expect(actionTimeDisplay._zoneSimSweep).toBeNull();
    });

    test('the panel closing part-way through stops the sweep too', async () => {
        game.currentActions = [
            combatAction(1, { loadoutId: TANK_ID }),
            combatAction(2, { loadoutId: TANK_ID, tier: 2 }),
        ];
        const menu = queueMenu(['Gobo Planet (T3)', 'Gobo Planet (T2)']);
        actionTimeDisplay.injectQueueTimes(menu);

        const sweep = actionTimeDisplay.runQueueSimSweep();
        await flush();
        menu.parentElement.remove();
        game.simUI.calls[0].resolve({ ok: true, entry: zoneRate({ loadoutId: String(TANK_ID), savedAt: NOW }) });

        expect(await sweep).toEqual({ ok: true, simulated: 1 });
        expect(game.simUI.simulateZoneRate).toHaveBeenCalledTimes(1);
    });

    test('an unresolvable loadout is reported on the row', async () => {
        game.currentActions = [combatAction(1, { loadoutId: TANK_ID })];
        const menu = queueMenu(['Gobo Planet (T3)']);
        actionTimeDisplay.injectQueueTimes(menu);

        const started = actionTimeDisplay.startZoneSim(game.currentActions[0]);
        await flush();
        game.simUI.calls[0].resolve({ ok: false, error: 'Could not read the loadout this fight uses.' });
        await started;

        expect(menu.querySelector('.mwi-queue-zone-sim-error').textContent).toBe(
            'Could not read the loadout this fight uses.'
        );
    });

    test('a simulator that is not loaded says so instead of doing nothing', async () => {
        game.simUI = null;
        game.currentActions = [combatAction(1, { loadoutId: TANK_ID })];
        const menu = queueMenu(['Gobo Planet (T3)']);
        actionTimeDisplay.injectQueueTimes(menu);

        const outcome = await actionTimeDisplay.startZoneSim(game.currentActions[0]);
        expect(outcome.ok).toBe(false);
        expect(menu.querySelector('.mwi-queue-zone-sim-error').textContent).toMatch(/not loaded/);
    });

    test('a Fight ∞ row shows the rate its sim fetched, marked as simulated', async () => {
        game.rates = { [`${GOBO}|3|${COMBAT_ID}`]: zoneRate() };
        await actionTimeDisplay.refreshCombatSnapshot();
        game.currentActions = [combatAction(1, { maxCount: 0 })];
        const menu = queueMenu(['Gobo Planet (T3)']);
        actionTimeDisplay.injectQueueTimes(menu);

        expect(rowTexts(menu)).toEqual(['[∞]']);
        const note = menu.querySelector('.mwi-queue-zone-sim-rate');
        expect(note.textContent).toBe('~250 waves/h · sim');
        expect(note.title).toContain('your Combat loadout');
        expect(total()).toBe('Total time: [∞]');
    });

    test('a redraw leaves one header', () => {
        game.currentActions = [combatAction(1)];
        const menu = queueMenu(['Gobo Planet (T3)']);
        actionTimeDisplay.injectQueueTimes(menu);
        actionTimeDisplay.injectQueueTimes(menu);
        expect(menu.querySelectorAll('.mwi-queue-sim-all-button')).toHaveLength(1);
    });
});

/** The edit menu as the game draws it, one row per label. */
function queueMenu(labels, { withTitle = false } = {}) {
    const parent = document.createElement('div');
    const menu = document.createElement('div');
    menu.className = 'QueuedActions_queuedActionsEditMenu__x';
    if (withTitle) {
        // The real panel opens with its own title line; the class carries a build
        // hash in game (`QueuedActions_label__1lTOW`), hence the prefix match.
        const title = document.createElement('div');
        title.className = 'QueuedActions_label__x';
        title.textContent = `Queued Actions (${labels.length}/6)`;
        menu.appendChild(title);
    }
    menu.innerHTML += labels
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

function rowTexts(root) {
    // The time's own text, without the sim controls that sit inline after it
    return [...root.querySelectorAll('.mwi-queue-action-time')].map((el) =>
        [...el.childNodes]
            .filter((node) => !node.classList?.contains('mwi-queue-zone-sim'))
            .map((node) => node.textContent)
            .join('')
    );
}

function total() {
    return document.querySelector('#mwi-queue-total-time')?.textContent;
}

describe('the Queued Actions panel', () => {
    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        document.body.innerHTML = '';
        game.actionDetails = {
            [GOBO]: gobo,
            [COINIFY]: {
                hrid: COINIFY,
                name: 'Coinify',
                type: '/action_types/alchemy',
                inputItems: [],
                outputItems: [],
            },
        };
        game.loadoutMap = { [COMBAT_ID]: { name: 'Combat' }, [TANK_ID]: { name: 'Tank' } };
        game.snapshot = snapshot();
        await actionTimeDisplay.refreshCombatSnapshot();
    });

    afterEach(() => {
        vi.useRealTimers();
        actionTimeDisplay._combatSnapshotCache = null;
    });

    test('a counted combat row shows a marked estimate, and the total is marked too', () => {
        game.currentActions = [coinifyAction(1), combatAction(2)];
        const menu = queueMenu(['Coinify', 'Gobo Planet (T3)']);
        actionTimeDisplay.injectQueueTimes(menu);

        const [coinify, fight] = rowTexts(menu);
        expect(coinify).toMatch(/^\[30s\] \d/);
        expect(fight).toMatch(/^\[~1h 00m 00s · sim\] ~/);
        expect(menu.querySelectorAll('.mwi-queue-action-time')[1].title).toContain('500 waves/h');
        expect(total()).toBe('Total time: ~1h 00m 30s');
    });

    test('a mismatched loadout is said on the row', () => {
        game.currentActions = [combatAction(1, { loadoutId: TANK_ID })];
        const menu = queueMenu(['Gobo Planet (T3)']);
        actionTimeDisplay.injectQueueTimes(menu);
        expect(rowTexts(menu)[0]).toMatch(/^\[~1h 00m 00s · sim, other gear\]/);
    });

    test('an unknown row stays unknown, and the total says it is incomplete', async () => {
        game.snapshot = snapshot({ rate: null });
        await actionTimeDisplay.refreshCombatSnapshot();
        game.currentActions = [combatAction(1), coinifyAction(2)];
        const menu = queueMenu(['Gobo Planet (T3)', 'Coinify']);
        actionTimeDisplay.injectQueueTimes(menu);

        const [fight, coinify] = rowTexts(menu);
        expect(fight).toBe('[? · no sim rate]');
        // Nothing after an unknown can be given a clock
        expect(coinify).toBe('[30s]');
        expect(total()).toBe('Total time: 30s + [?]');
    });

    test('before the snapshot has been read, a counted combat row is unknown', () => {
        actionTimeDisplay._combatSnapshotCache = null;
        game.currentActions = [combatAction(1)];
        const menu = queueMenu(['Gobo Planet (T3)']);
        actionTimeDisplay.injectQueueTimes(menu);
        expect(rowTexts(menu)).toEqual(['[? · no sim rate]']);
        expect(total()).toBe('Total time: [?]');
    });

    test('Fight ∞ stays [∞] and the total stays infinite', () => {
        game.currentActions = [combatAction(1, { maxCount: 0 })];
        const menu = queueMenu(['Gobo Planet (T3)']);
        actionTimeDisplay.injectQueueTimes(menu);
        expect(rowTexts(menu)).toEqual(['[∞]']);
        expect(total()).toBe('Total time: [∞]');
    });

    test('a non-combat queue is drawn exactly as before', () => {
        game.currentActions = [coinifyAction(1), coinifyAction(2, 6)];
        const menu = queueMenu(['Coinify', 'Coinify']);
        actionTimeDisplay.injectQueueTimes(menu);
        // Recorded from the build before combat rows were timed
        expect(menu.parentElement.innerHTML).toMatchInlineSnapshot(`
          "<div class="QueuedActions_queuedActionsEditMenu__x">
                  <div class="QueuedActions_action__item">
                      <div class="QueuedActions_actionText__y">
                          <div class="QueuedActions_text__z">#1Coinify</div>
                      <div class="mwi-queue-action-time" style="color: var(--text-color-secondary, undefined); font-size: 0.85em; margin-top: 2px;">[30s] 12:00:30</div><div class="mwi-queue-action-profit" data-div-index="0" style="color: var(--text-color-secondary, undefined); font-size: 0.85em; margin-top: 2px;"></div></div>
                  </div>
                  <div class="QueuedActions_action__item">
                      <div class="QueuedActions_actionText__y">
                          <div class="QueuedActions_text__z">#2Coinify</div>
                      <div class="mwi-queue-action-time" style="color: var(--text-color-secondary, undefined); font-size: 0.85em; margin-top: 2px;">[0h 01m 00s] 12:01:30</div><div class="mwi-queue-action-profit" data-div-index="1" style="color: var(--text-color-secondary, undefined); font-size: 0.85em; margin-top: 2px;"></div></div>
                  </div></div><div id="mwi-queue-total-time" style="color: var(--text-color-primary, undefined); font-weight: bold; margin-top: 12px; padding: 8px; text-align: center; border-top-width: var(--border-color, undefined); border-top-style: var(--border-color, undefined); border-top-color: var(--border-color, undefined);">Total time: 0h 01m 30s</div>"
        `);
    });
});

describe('the queue hover tooltip', () => {
    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        document.body.innerHTML = '';
        game.actionDetails = { [GOBO]: gobo };
        game.loadoutMap = { [COMBAT_ID]: { name: 'Combat' } };
        game.snapshot = snapshot();
        await actionTimeDisplay.refreshCombatSnapshot();
    });

    afterEach(() => {
        vi.useRealTimers();
        actionTimeDisplay._combatSnapshotCache = null;
    });

    test('a counted combat row shows the same marked estimate', () => {
        game.currentActions = [combatAction(1)];
        const tooltip = document.createElement('div');
        tooltip.innerHTML = `
            <div class="QueuedActions_actions__c">
                <div class="QueuedActions_action__item">
                    <div class="QueuedActions_actionText__y"><div class="QueuedActions_text__z">#1Gobo Planet (T3)</div></div>
                </div>
            </div>`;
        document.body.appendChild(tooltip);
        actionTimeDisplay.injectQueueTimesTooltip(tooltip);

        expect(rowTexts(tooltip)[0]).toMatch(/^\[~1h 00m 00s · sim\] ~/);
        expect(tooltip.querySelector('.mwi-queue-tooltip-total').textContent).toBe('Total: ~1h 00m 00s');
    });
});
