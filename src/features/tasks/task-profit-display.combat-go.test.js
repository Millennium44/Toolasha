/**
 * @vitest-environment happy-dom
 *
 * The combat task card's Zone toggle, and Go's zone+count pre-fill.
 *
 * Ask 1 (zone honored with a single task monster in a zone): `_pickZoneForMonster`'s
 * tie-break needs a task from a DIFFERENT monster to say anything — this
 * monster's own task is a member of every zone that qualified it as a
 * candidate in the first place, so counting it can never break a tie between
 * them. "One monster from a zone as a task" is exactly that no-signal case,
 * and it used to fall through to `candidates[0]`: the first zone in
 * `Object.entries(actionMap)` order, which is JSON key order and has no
 * relationship to the game world. These pin a deterministic tie-break by the
 * zone's own `sortIndex` instead.
 *
 * Ask 2/3 (Go opens the estimate's zone and pre-fills fights + buffer):
 * `_applyGoEstimate` reads a per-card `{zoneHrid, predictedFights}` set only
 * by a completed sim, never guesses one, and never presses anything itself —
 * it fills the game's own count input, the same way `findActionInput` +
 * `setReactInputValue` already do for the existing Go-merge feature.
 *
 * A combat task estimate simulates at the tier `_resolveEstimateTier` finds
 * for the zone in the player's own action queue (`lastUsedTierForZone`,
 * `utils/combat-actions.js`) — T0 only as the no-recorded-tier fallback — and
 * Go must land on that same tier, through `ensureZoneAndTier`
 * (`utils/combat-zone-open.js`), which reads the zone panel's own Difficulty
 * combobox rather than a "zone tab" that measurement on the live game showed
 * never existed (that selector matched the Combat page's top-level tabs —
 * Combat Zones/Find Party/Combat Sim/Statistics — never a per-zone entry, so
 * the old fallback here was dead code and is gone, not merely unused).
 *
 * Ask 4 (the tier travels on the estimate, and honors the last-used tier):
 * `_resolveEstimateTier` reads the queue once, up front, and the result rides
 * on the same `_cardEstimates` record as `zoneHrid`/`predictedFights` —
 * `_applyGoEstimate` never re-reads the queue, so a queue change between the
 * estimate finishing and Go being clicked cannot change which tier Go opens.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';
import taskProfitDisplay from './task-profit-display.js';
import dataManager from '../../core/data-manager.js';
import config from '../../core/config.js';
import { runSimulation } from '../combat-sim/combat-sim-runner.js';
import { buildAllPlayerDTOs, buildGameDataPayload } from '../combat-sim/combat-sim-adapter.js';
import { fightsForKillConfidence } from '../../utils/fight-confidence.js';

vi.mock('../combat-sim/combat-sim-runner.js', () => ({
    runSimulation: vi.fn(),
}));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    buildAllPlayerDTOs: vi.fn(),
    buildGameDataPayload: vi.fn(),
    getCommunityBuffs: vi.fn(() => ({})),
    applyLoadoutSnapshotToDTO: vi.fn(),
    calculateSimRevenue: vi.fn(() => ({ netPerHour: 0, dropEntries: [], consumableEntries: [] })),
}));

/**
 * A minimal set of combat zone actions, as `dataManager.getInitClientData()`
 * would hold them: enough for `_pickZoneForMonster` (spawns/bosses/category)
 * and for `_applyGoEstimate`'s name lookup (`actionDetailMap[...].name`).
 * @param {Array<Object>} zones - {hrid, name, category, sortIndex, monsters, bosses, isDungeon}
 */
function buildGameData(zones) {
    const actionDetailMap = {};
    const actionCategoryDetailMap = {};
    for (const z of zones) {
        actionDetailMap[z.hrid] = {
            type: '/action_types/combat',
            name: z.name,
            category: z.category,
            combatZoneInfo: {
                isDungeon: !!z.isDungeon,
                fightInfo: {
                    randomSpawnInfo: { spawns: (z.monsters || []).map((m) => ({ combatMonsterHrid: m })) },
                    bossSpawns: (z.bosses || []).map((m) => ({ combatMonsterHrid: m })),
                },
            },
        };
        if (z.category && z.sortIndex !== undefined) {
            actionCategoryDetailMap[z.category] = { sortIndex: z.sortIndex };
        }
    }
    return { actionDetailMap, actionCategoryDetailMap };
}

afterEach(() => {
    dataManager.initClientData = null;
    dataManager.characterQuests = [];
    dataManager.characterActions = [];
    dataManager.currentCharacterId = null;
    dataManager.isCharacterSwitching = false;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('_pickZoneForMonster', () => {
    test('a single task from a multi-zone monster honors zone deterministically', () => {
        // Panda spawns in both zones; the Tasks panel is closed (or panda is
        // the only tracked Defeat task either way), so nothing disambiguates
        // them by shared tasks. Zone A has the lower sortIndex and must win —
        // not Zone Z, which was inserted first and is what the old
        // `candidates[0]` fallback would have returned.
        dataManager.initClientData = buildGameData([
            {
                hrid: '/actions/combat/zone_z',
                name: 'Zone Z',
                category: '/categories/z',
                sortIndex: 9,
                monsters: ['/monsters/panda'],
            },
            {
                hrid: '/actions/combat/zone_a',
                name: 'Zone A',
                category: '/categories/a',
                sortIndex: 1,
                monsters: ['/monsters/panda'],
            },
        ]);

        expect(taskProfitDisplay._pickZoneForMonster('/monsters/panda')).toBe('/actions/combat/zone_a');
    });

    test('this is the same result with the Tasks panel actually mounted and only this one task tracked', () => {
        dataManager.initClientData = buildGameData([
            {
                hrid: '/actions/combat/zone_z',
                name: 'Zone Z',
                category: '/categories/z',
                sortIndex: 9,
                monsters: ['/monsters/panda'],
            },
            {
                hrid: '/actions/combat/zone_a',
                name: 'Zone A',
                category: '/categories/a',
                sortIndex: 1,
                monsters: ['/monsters/panda'],
            },
        ]);

        const list = document.createElement('div');
        list.className = 'TasksPanel_taskList__1a';
        list.appendChild(buildTaskCard('Defeat - Panda', 0, 100));
        document.body.appendChild(list);

        expect(taskProfitDisplay._pickZoneForMonster('/monsters/panda')).toBe('/actions/combat/zone_a');
    });

    test('a genuinely shared farming zone still wins on real signal from other tasks', () => {
        // Both zones spawn panda; only Zone Z also spawns fly, and fly has an
        // active task too — that is real disambiguating signal and must still
        // decide it, regardless of sortIndex.
        dataManager.initClientData = buildGameData([
            {
                hrid: '/actions/combat/zone_z',
                name: 'Zone Z',
                category: '/categories/z',
                sortIndex: 9,
                monsters: ['/monsters/panda', '/monsters/fly'],
            },
            {
                hrid: '/actions/combat/zone_a',
                name: 'Zone A',
                category: '/categories/a',
                sortIndex: 1,
                monsters: ['/monsters/panda'],
            },
        ]);
        // _getActiveDefeatMonsters resolves task names back to hrids through
        // this map — it needs entries to give the tie-break real signal
        dataManager.initClientData.combatMonsterDetailMap = {
            '/monsters/panda': { name: 'Panda' },
            '/monsters/fly': { name: 'Fly' },
        };

        const list = document.createElement('div');
        list.className = 'TasksPanel_taskList__1a';
        list.appendChild(buildTaskCard('Defeat - Panda', 0, 100));
        list.appendChild(buildTaskCard('Defeat - Fly', 0, 50));
        document.body.appendChild(list);

        expect(taskProfitDisplay._pickZoneForMonster('/monsters/panda')).toBe('/actions/combat/zone_z');
    });

    test('a single-zone monster returns that zone directly, no tie-break involved', () => {
        dataManager.initClientData = buildGameData([
            {
                hrid: '/actions/combat/fly',
                name: 'Fly Zone',
                category: '/categories/fly',
                sortIndex: 1,
                monsters: ['/monsters/fly'],
            },
        ]);

        expect(taskProfitDisplay._pickZoneForMonster('/monsters/fly')).toBe('/actions/combat/fly');
    });

    test('no candidate zone returns null', () => {
        dataManager.initClientData = buildGameData([
            {
                hrid: '/actions/combat/fly',
                name: 'Fly Zone',
                category: '/categories/fly',
                sortIndex: 1,
                monsters: ['/monsters/fly'],
            },
        ]);
        expect(taskProfitDisplay._pickZoneForMonster('/monsters/nothing_here')).toBe(null);
    });
});

/**
 * A minimal parseable "Defeat - X" task card: a name div, a Progress line and
 * an (empty) rewards node — the three things `parseTaskData` requires.
 */
function buildTaskCard(description, progress, quantity) {
    const info = document.createElement('div');
    info.className = 'RandomTask_taskInfo__1a';

    const name = document.createElement('div');
    name.className = 'RandomTask_name__1a';
    name.textContent = description;
    info.appendChild(name);

    const progressDiv = document.createElement('div');
    progressDiv.textContent = `Progress: ${progress} / ${quantity}`;
    info.appendChild(progressDiv);

    const rewards = document.createElement('div');
    rewards.className = 'RandomTask_rewards__1a';
    info.appendChild(rewards);

    return info;
}

/**
 * A MUI-shaped Difficulty combobox, as measured on the live game: a
 * `[role="combobox"]` reading its current value (`T0`, `T1`, …), whose
 * `aria-controls` names a `[role="listbox"]` of `[role="option"]` entries —
 * portalled to `document.body`, the way MUI's own popovers render, not
 * nested under the panel.
 */
let comboboxIdSeq = 0;
function buildDifficultyCombobox(panel, tier, availableTiers = [0, 1, 2, 3, 4, 5]) {
    const id = `mwi-test-difficulty-listbox-${comboboxIdSeq++}`;
    const combobox = document.createElement('div');
    combobox.setAttribute('role', 'combobox');
    combobox.setAttribute('aria-controls', id);
    combobox.textContent = `T${tier}`;
    panel.appendChild(combobox);

    const listbox = document.createElement('ul');
    listbox.id = id;
    listbox.setAttribute('role', 'listbox');
    for (const t of availableTiers) {
        const option = document.createElement('li');
        option.setAttribute('role', 'option');
        option.textContent = `T${t}`;
        option.addEventListener('click', () => {
            combobox.textContent = `T${t}`;
        });
        listbox.appendChild(option);
    }
    document.body.appendChild(listbox);

    return combobox;
}

/**
 * A mounted action detail panel, as `resolveDetailPanel`/`findActionInput` read
 * it, with a Difficulty combobox already showing `tier` (default T0, the tier
 * every combat task estimate simulates at).
 */
function buildDetailPanel(zoneName, tier = 0) {
    const panel = document.createElement('div');
    panel.className = 'SkillActionDetail_skillActionDetail__1a';

    const name = document.createElement('div');
    name.className = 'SkillActionDetail_name__1a';
    name.textContent = zoneName;
    panel.appendChild(name);

    const combobox = buildDifficultyCombobox(panel, tier);

    const inputContainer = document.createElement('div');
    inputContainer.className = 'maxActionCountInput__1a';
    const input = document.createElement('input');
    inputContainer.appendChild(input);
    panel.appendChild(inputContainer);

    document.body.appendChild(panel);
    return { panel, input, combobox };
}

describe('_applyGoEstimate (Go opens the estimate zone and fills the count)', () => {
    test('fills predicted fights + the buffer when the estimate zone and T0 are already showing', async () => {
        dataManager.initClientData = buildGameData([
            {
                hrid: '/actions/combat/bear_with_it',
                name: 'Bear With It',
                category: '/categories/bear',
                sortIndex: 1,
                monsters: ['/monsters/panda'],
            },
        ]);
        const { input } = buildDetailPanel('Bear With It', 0);
        vi.spyOn(config, 'getSettingValue').mockImplementation((key, fallback) =>
            key === 'taskCombatGoBuffer' ? 10 : fallback
        );

        await taskProfitDisplay._applyGoEstimate({ zoneHrid: '/actions/combat/bear_with_it', predictedFights: 100 });

        expect(input.value).toBe('110');
    });

    test('defaults the buffer to 5% when the setting has never been changed', async () => {
        dataManager.initClientData = buildGameData([
            {
                hrid: '/actions/combat/fly',
                name: 'Fly Zone',
                category: '/categories/fly',
                sortIndex: 1,
                monsters: ['/monsters/fly'],
            },
        ]);
        const { input } = buildDetailPanel('Fly Zone', 0);

        await taskProfitDisplay._applyGoEstimate({ zoneHrid: '/actions/combat/fly', predictedFights: 200 });

        // ceil(200 * 1.05) = 210
        expect(input.value).toBe('210');
    });

    test('switches the Difficulty combobox to T0 first, then fills, when the panel was left on another tier', async () => {
        vi.useFakeTimers();
        try {
            dataManager.initClientData = buildGameData([
                {
                    hrid: '/actions/combat/bear_with_it',
                    name: 'Bear With It',
                    category: '/categories/bear',
                    sortIndex: 1,
                    monsters: ['/monsters/panda'],
                },
            ]);
            // The estimate's zone is already open, but at T3 from an earlier
            // combat-sim session — Go must not fill against T3
            const { input, combobox } = buildDetailPanel('Bear With It', 3);

            const applyPromise = taskProfitDisplay._applyGoEstimate({
                zoneHrid: '/actions/combat/bear_with_it',
                predictedFights: 40,
            });

            // Not filled yet — opening and picking from the combobox is asynchronous
            expect(input.value).toBe('');

            await vi.advanceTimersByTimeAsync(300); // combobox opens
            combobox.click();
            await vi.advanceTimersByTimeAsync(300); // popup renders
            const option = Array.from(document.querySelectorAll('[role="option"]')).find((o) => o.textContent === 'T0');
            option.click();
            await vi.advanceTimersByTimeAsync(300); // readback settle

            await applyPromise;

            expect(combobox.textContent).toBe('T0');
            expect(input.value).toBe('42'); // ceil(40 * 1.05)
        } finally {
            vi.useRealTimers();
        }
    });

    test('refuses when a different zone panel is showing — never fills the wrong zone', async () => {
        dataManager.initClientData = buildGameData([
            {
                hrid: '/actions/combat/bear_with_it',
                name: 'Bear With It',
                category: '/categories/bear',
                sortIndex: 1,
                monsters: ['/monsters/panda'],
            },
        ]);
        const { input } = buildDetailPanel('Somewhere Else', 0);

        await taskProfitDisplay._applyGoEstimate({ zoneHrid: '/actions/combat/bear_with_it', predictedFights: 40 });

        expect(input.value).toBe('');
    });

    test('refuses when the estimate names a zoneHrid the game no longer has', async () => {
        dataManager.initClientData = buildGameData([]);
        const { input } = buildDetailPanel('Bear With It', 0);

        await taskProfitDisplay._applyGoEstimate({ zoneHrid: '/actions/combat/gone', predictedFights: 40 });

        expect(input.value).toBe('');
    });

    test('refuses to fill when the character switches away while the tier is being confirmed', async () => {
        // Go's own copy of the "confirm zone, confirm tier, then fill"
        // sequence (`ensureZoneAndTier` is awaited the same as in
        // `openCombatZoneAtTier`) — a character switch landing during that
        // await must not let a stale estimate fill the new character's panel.
        dataManager.initClientData = buildGameData([
            {
                hrid: '/actions/combat/bear_with_it',
                name: 'Bear With It',
                category: '/categories/bear',
                sortIndex: 1,
                monsters: ['/monsters/panda'],
            },
        ]);
        dataManager.currentCharacterId = 'char-a';
        const { input } = buildDetailPanel('Bear With It', 0);

        const applyPromise = taskProfitDisplay._applyGoEstimate({
            zoneHrid: '/actions/combat/bear_with_it',
            predictedFights: 100,
        });
        // The switch lands in the window between capturing identity and the
        // tier readback resolving — no real timer needed since the fast path
        // (tier already matches) only crosses a microtask, not a setTimeout.
        dataManager.currentCharacterId = 'char-b';

        await applyPromise;

        expect(input.value).toBe('');
    });

    test('refuses when no Difficulty combobox is found — never fills against an unconfirmed tier', async () => {
        dataManager.initClientData = buildGameData([
            {
                hrid: '/actions/combat/bear_with_it',
                name: 'Bear With It',
                category: '/categories/bear',
                sortIndex: 1,
                monsters: ['/monsters/panda'],
            },
        ]);
        const panel = document.createElement('div');
        panel.className = 'SkillActionDetail_skillActionDetail__1a';
        const name = document.createElement('div');
        name.className = 'SkillActionDetail_name__1a';
        name.textContent = 'Bear With It';
        panel.appendChild(name);
        const inputContainer = document.createElement('div');
        inputContainer.className = 'maxActionCountInput__1a';
        const input = document.createElement('input');
        inputContainer.appendChild(input);
        panel.appendChild(inputContainer);
        document.body.appendChild(panel);

        await taskProfitDisplay._applyGoEstimate({ zoneHrid: '/actions/combat/bear_with_it', predictedFights: 40 });

        expect(input.value).toBe('');
    });
});

describe('_resolveGoEstimate: what a Go click on this card would do', () => {
    test('a card with no completed estimate leaves Go exactly as it behaves today', () => {
        // No `_cardEstimates` entry was ever set for this node
        const taskNode = document.createElement('div');
        expect(taskProfitDisplay._resolveGoEstimate(taskNode)).toBe(null);
    });

    test('an unknown (null) prediction is never dressed up as a count', () => {
        const taskNode = document.createElement('div');
        taskProfitDisplay._cardEstimates.set(taskNode, {
            zoneHrid: '/actions/combat/fly',
            predictedFights: null,
            monsterHrid: '/monsters/fly',
        });
        expect(taskProfitDisplay._resolveGoEstimate(taskNode)).toBe(null);
    });

    test('a completed estimate is returned as-is for Go to act on', () => {
        const taskNode = document.createElement('div');
        const estimate = { zoneHrid: '/actions/combat/fly', predictedFights: 42, monsterHrid: '/monsters/fly' };
        taskProfitDisplay._cardEstimates.set(taskNode, estimate);
        vi.spyOn(config, 'getSetting').mockImplementation((key) => key === 'taskCombatEstimate'); // taskGoMerge off

        expect(taskProfitDisplay._resolveGoEstimate(taskNode)).toBe(estimate);
    });

    test('a stored estimate is ignored once taskCombatEstimate is switched off', () => {
        const taskNode = document.createElement('div');
        const estimate = { zoneHrid: '/actions/combat/fly', predictedFights: 12 };
        taskProfitDisplay._cardEstimates.set(taskNode, estimate);
        vi.spyOn(config, 'getSetting').mockImplementation((key) => key !== 'taskCombatEstimate');

        expect(taskProfitDisplay._resolveGoEstimate(taskNode)).toBe(null);
    });

    test("defers to taskGoMerge's exact total when it is about to combine several in-progress tasks", () => {
        const taskNode = document.createElement('div');
        taskProfitDisplay._cardEstimates.set(taskNode, {
            zoneHrid: '/actions/combat/fly',
            predictedFights: 42,
            monsterHrid: '/monsters/fly',
        });
        vi.spyOn(config, 'getSetting').mockReturnValue(true); // taskGoMerge and taskCombatEstimate on
        dataManager.characterQuests = [
            {
                status: '/quest_status/in_progress',
                category: '/quest_category/random_task',
                monsterHrid: '/monsters/fly',
            },
            {
                status: '/quest_status/in_progress',
                category: '/quest_category/random_task',
                monsterHrid: '/monsters/fly',
            },
        ];

        expect(taskProfitDisplay._resolveGoEstimate(taskNode)).toBe(null);
    });

    test('a single matching task does not defer, even with taskGoMerge on', () => {
        const taskNode = document.createElement('div');
        const estimate = { zoneHrid: '/actions/combat/fly', predictedFights: 42, monsterHrid: '/monsters/fly' };
        taskProfitDisplay._cardEstimates.set(taskNode, estimate);
        vi.spyOn(config, 'getSetting').mockReturnValue(true);
        dataManager.characterQuests = [
            {
                status: '/quest_status/in_progress',
                category: '/quest_category/random_task',
                monsterHrid: '/monsters/fly',
            },
        ];

        expect(taskProfitDisplay._resolveGoEstimate(taskNode)).toBe(estimate);
    });
});

describe('_resolveEstimateTier: the tier a combat estimate simulates at, and Go later opens', () => {
    test('a zone queued (or running) at a non-zero tier is honored, not T0', () => {
        dataManager.characterActions = [
            { actionHrid: '/actions/combat/gobo_planet', difficultyTier: 3, isDone: false, ordinal: 0 },
        ];

        expect(taskProfitDisplay._resolveEstimateTier('/actions/combat/gobo_planet')).toEqual({
            tier: 3,
            known: true,
        });
    });

    test('a zone the player queues at T0 is a known T0, not "unknown"', () => {
        dataManager.characterActions = [{ actionHrid: '/actions/combat/fly_zone', isDone: false, ordinal: 0 }];

        expect(taskProfitDisplay._resolveEstimateTier('/actions/combat/fly_zone')).toEqual({ tier: 0, known: true });
    });

    test('the zone is nowhere in the queue: falls back to T0 and says so, never a guessed tier', () => {
        dataManager.characterActions = [
            { actionHrid: '/actions/combat/pirate_cove', difficultyTier: 4, isDone: false, ordinal: 0 },
        ];

        expect(taskProfitDisplay._resolveEstimateTier('/actions/combat/gobo_planet')).toEqual({
            tier: 0,
            known: false,
        });
    });
});

describe('Go honors the tier the estimate actually simulated', () => {
    test('a non-zero estimate.tier moves the Difficulty combobox off T0', async () => {
        vi.useFakeTimers();
        try {
            dataManager.initClientData = buildGameData([
                {
                    hrid: '/actions/combat/gobo_planet',
                    name: 'Gobo Planet',
                    category: '/categories/gobo',
                    sortIndex: 1,
                    monsters: ['/monsters/gobo'],
                },
            ]);
            // Starting tier (T1) is neither the old hardcoded fallback (T0)
            // nor the target (T3) — only reading `estimate.tier` can land on
            // T3; a stray fallback to T0 would stop there instead, and a
            // no-op would leave the combobox at T1. Also left un-clicked by
            // this test: `selectDifficultyTier` (`utils/combat-zone-open.js`)
            // opens the combobox and clicks the matching option itself —
            // this only drives the fake clock past its two internal
            // `wait(300ms)` calls.
            const { input, combobox } = buildDetailPanel('Gobo Planet', 1);

            const applyPromise = taskProfitDisplay._applyGoEstimate({
                zoneHrid: '/actions/combat/gobo_planet',
                predictedFights: 40,
                tier: 3,
            });

            await vi.advanceTimersByTimeAsync(300); // combobox opens
            await vi.advanceTimersByTimeAsync(300); // option picked, readback settle

            await applyPromise;

            expect(combobox.textContent).toBe('T3');
            expect(input.value).toBe('42'); // ceil(40 * 1.05)
        } finally {
            vi.useRealTimers();
        }
    });

    test('an estimate with no tier field (older/foreign record) still falls back to T0', async () => {
        dataManager.initClientData = buildGameData([
            {
                hrid: '/actions/combat/bear_with_it',
                name: 'Bear With It',
                category: '/categories/bear',
                sortIndex: 1,
                monsters: ['/monsters/panda'],
            },
        ]);
        const { input } = buildDetailPanel('Bear With It', 0);

        await taskProfitDisplay._applyGoEstimate({ zoneHrid: '/actions/combat/bear_with_it', predictedFights: 40 });

        expect(input.value).toBe('42'); // ceil(40 * 1.05), filled at the already-showing T0
    });

    test('the tier travels on the estimate record — Go uses it even after the queue has since changed', async () => {
        // The estimate ran while Gobo Planet sat in the queue at T3 (what
        // `_resolveEstimateTier` would have read then). By the time Go is
        // clicked the player has re-queued the same zone at T5 — Go must
        // still open T3, the tier this exact estimate simulated, never a
        // tier recomputed from the queue's current state.
        dataManager.initClientData = buildGameData([
            {
                hrid: '/actions/combat/gobo_planet',
                name: 'Gobo Planet',
                category: '/categories/gobo',
                sortIndex: 1,
                monsters: ['/monsters/gobo'],
            },
        ]);
        const { input, combobox } = buildDetailPanel('Gobo Planet', 3);
        const estimate = { zoneHrid: '/actions/combat/gobo_planet', predictedFights: 40, tier: 3 };

        // The queue now disagrees with the estimate's stamped tier
        dataManager.characterActions = [
            { actionHrid: '/actions/combat/gobo_planet', difficultyTier: 5, isDone: false, ordinal: 0 },
        ];

        await taskProfitDisplay._applyGoEstimate(estimate);

        expect(combobox.textContent).toBe('T3');
        expect(input.value).toBe('42'); // ceil(40 * 1.05)
    });
});

describe('_runCombatSimEstimate: the estimate itself simulates at the last-used tier', () => {
    test('a zone queued at T3 is simulated at T3, and the estimate + card carry T3', async () => {
        dataManager.initClientData = {
            ...buildGameData([
                {
                    hrid: '/actions/combat/gobo_planet',
                    name: 'Gobo Planet',
                    category: '/categories/gobo',
                    sortIndex: 1,
                    monsters: ['/monsters/gobo'],
                },
            ]),
            combatMonsterDetailMap: { '/monsters/gobo': { name: 'Gobo' } },
        };
        // This is the honest source `_resolveEstimateTier` reads: the player
        // has this zone queued at T3 right now.
        dataManager.characterActions = [
            { actionHrid: '/actions/combat/gobo_planet', difficultyTier: 3, isDone: false, ordinal: 0 },
        ];

        buildGameDataPayload.mockReturnValue(dataManager.initClientData);
        buildAllPlayerDTOs.mockResolvedValue({ players: [{ hrid: 'player1' }] });
        runSimulation.mockResolvedValue({ deaths: { '/monsters/gobo': 10 }, encounters: 10 });

        const cardTaskNode = document.createElement('div');
        cardTaskNode.className = 'RandomTask_taskInfo__1a';
        const container = document.createElement('div');
        cardTaskNode.appendChild(container);
        document.body.appendChild(cardTaskNode);

        const taskData = {
            description: 'Defeat - Gobo',
            quantity: 100,
            currentProgress: 0,
            coinReward: 0,
            taskTokenReward: 0,
        };

        await taskProfitDisplay._runCombatSimEstimate(container, taskData, '', 'solo');

        expect(runSimulation).toHaveBeenCalledWith(expect.objectContaining({ difficultyTier: 3 }));

        const estimate = taskProfitDisplay._cardEstimates.get(cardTaskNode);
        expect(estimate).toMatchObject({ zoneHrid: '/actions/combat/gobo_planet', predictedFights: 100, tier: 3 });

        // The card says which tier its numbers are for
        expect(container.innerHTML).toContain('T3');
    });

    test('a task-card estimate counts the task however the general setting is set', async () => {
        // The Tasks panel is a task sim by definition: it must not lose the
        // task bonus because a general zone sim is set not to pay it. The
        // setting is pinned Off here and the estimate asks for it anyway.
        const settingSpy = vi.spyOn(config, 'getSettingValue').mockReturnValue('off');
        dataManager.initClientData = {
            ...buildGameData([
                {
                    hrid: '/actions/combat/gobo_planet',
                    name: 'Gobo Planet',
                    category: '/categories/gobo',
                    sortIndex: 1,
                    monsters: ['/monsters/gobo'],
                },
            ]),
            combatMonsterDetailMap: { '/monsters/gobo': { name: 'Gobo' } },
        };
        dataManager.characterActions = [];

        buildGameDataPayload.mockReturnValue(dataManager.initClientData);
        buildAllPlayerDTOs.mockResolvedValue({ players: [{ hrid: 'player1' }] });
        runSimulation.mockResolvedValue({ deaths: { '/monsters/gobo': 10 }, encounters: 10 });

        const cardTaskNode = document.createElement('div');
        cardTaskNode.className = 'RandomTask_taskInfo__1a';
        const container = document.createElement('div');
        cardTaskNode.appendChild(container);
        document.body.appendChild(cardTaskNode);

        const taskData = {
            description: 'Defeat - Gobo',
            quantity: 100,
            currentProgress: 0,
            coinReward: 0,
            taskTokenReward: 0,
        };

        // Both modes: solo has already narrowed the spawn table to this card's
        // monster, and zone covers the whole table, where forcing the bonus on
        // every fight would credit it against monsters that are nobody's task
        await taskProfitDisplay._runCombatSimEstimate(container, taskData, '', 'solo');
        expect(runSimulation).toHaveBeenCalledWith(expect.objectContaining({ taskDamageMode: 'perMonster' }));

        runSimulation.mockClear();
        await taskProfitDisplay._runCombatSimEstimate(container, taskData, '', 'zone');
        expect(runSimulation).toHaveBeenCalledWith(expect.objectContaining({ taskDamageMode: 'perMonster' }));

        settingSpy.mockRestore();
    });

    test('a zone nowhere in the queue simulates at T0 and the card says the tier is not recorded', async () => {
        dataManager.initClientData = {
            ...buildGameData([
                {
                    hrid: '/actions/combat/gobo_planet',
                    name: 'Gobo Planet',
                    category: '/categories/gobo',
                    sortIndex: 1,
                    monsters: ['/monsters/gobo'],
                },
            ]),
            combatMonsterDetailMap: { '/monsters/gobo': { name: 'Gobo' } },
        };
        dataManager.characterActions = []; // Nothing queued for this zone at all

        buildGameDataPayload.mockReturnValue(dataManager.initClientData);
        buildAllPlayerDTOs.mockResolvedValue({ players: [{ hrid: 'player1' }] });
        runSimulation.mockResolvedValue({ deaths: { '/monsters/gobo': 10 }, encounters: 10 });

        const cardTaskNode = document.createElement('div');
        cardTaskNode.className = 'RandomTask_taskInfo__1a';
        const container = document.createElement('div');
        cardTaskNode.appendChild(container);
        document.body.appendChild(cardTaskNode);

        const taskData = {
            description: 'Defeat - Gobo',
            quantity: 100,
            currentProgress: 0,
            coinReward: 0,
            taskTokenReward: 0,
        };

        await taskProfitDisplay._runCombatSimEstimate(container, taskData, '', 'solo');

        expect(runSimulation).toHaveBeenCalledWith(expect.objectContaining({ difficultyTier: 0 }));

        const estimate = taskProfitDisplay._cardEstimates.get(cardTaskNode);
        expect(estimate).toMatchObject({ zoneHrid: '/actions/combat/gobo_planet', tier: 0 });

        expect(container.innerHTML).toContain('no recorded tier');
    });
});

/**
 * Ask 5 (the pre-filled count is sized by confidence, and a boss is not
 * padded at all): the prediction Go fills is a median — fill it verbatim and
 * you fall short about half the time, which is the second trip the pre-fill
 * exists to save. The padding is now a binomial quantile on the kill count
 * (`utils/fight-confidence.js`) rather than a flat percentage, because the
 * spread that strands you shrinks as 1/sqrt(n): six more kills wants half
 * again as many fights, three thousand wants two percent more.
 *
 * The boss case is a bug fix, not a tuning. `dataManager.isBossMonster` was
 * already consulted by the multi-task merge above (`isBoss ? total * 10 :
 * total`) and never by this path, so the same plugin treated a boss spawn as
 * deterministic in one place and as RNG in the other — and pre-fix a boss
 * estimate of 100 fights filled 105, padding against variance a fixed spawn
 * wave does not have.
 */
describe('_applyGoEstimate (confidence padding and the boss exception)', () => {
    const FLY_ZONE = [
        {
            hrid: '/actions/combat/fly',
            name: 'Fly Zone',
            category: '/categories/fly',
            sortIndex: 1,
            monsters: ['/monsters/fly'],
        },
    ];

    /** Settings, without touching anything else `getSettingValue` answers. */
    function settings({ buffer = 5, confidence = 90 } = {}) {
        vi.spyOn(config, 'getSettingValue').mockImplementation((key, fallback) => {
            if (key === 'taskCombatGoBuffer') return buffer;
            if (key === 'combatFightConfidence') return confidence;
            return fallback;
        });
    }

    test('a boss estimate fills the bare prediction — no quantile, no flat buffer', async () => {
        dataManager.initClientData = buildGameData(FLY_ZONE);
        const { input } = buildDetailPanel('Fly Zone', 0);
        settings();
        vi.spyOn(dataManager, 'isBossMonster').mockReturnValue(true);

        await taskProfitDisplay._applyGoEstimate({
            zoneHrid: '/actions/combat/fly',
            monsterHrid: '/monsters/fly',
            predictedFights: 100,
            killsNeeded: 10,
            killsPerFight: 0.1,
        });

        // Pre-fix this filled ceil(100 * 1.05) = 105.
        expect(input.value).toBe('100');
    });

    test('the same estimate from the spawn table pads to the confidence quantile', async () => {
        dataManager.initClientData = buildGameData(FLY_ZONE);
        const { input } = buildDetailPanel('Fly Zone', 0);
        settings();
        vi.spyOn(dataManager, 'isBossMonster').mockReturnValue(false);

        await taskProfitDisplay._applyGoEstimate({
            zoneHrid: '/actions/combat/fly',
            monsterHrid: '/monsters/fly',
            predictedFights: 60,
            killsNeeded: 6,
            killsPerFight: 0.1,
        });

        // Six kills at one in ten: 91 fights clear it nine times in ten, where
        // the old flat 5% quoted 63 and cleared it barely half the time.
        expect(input.value).toBe('91');
    });

    test('a large target pads by a couple of percent, not by half again', async () => {
        dataManager.initClientData = buildGameData(FLY_ZONE);
        const { input } = buildDetailPanel('Fly Zone', 0);
        settings({ buffer: 0 });
        vi.spyOn(dataManager, 'isBossMonster').mockReturnValue(false);

        await taskProfitDisplay._applyGoEstimate({
            zoneHrid: '/actions/combat/fly',
            monsterHrid: '/monsters/fly',
            predictedFights: 13_832,
            killsNeeded: 3833,
            killsPerFight: 3833 / 13_832,
        });

        expect(input.value).toBe('14076');
    });

    test('the flat buffer still binds where the quantile asks for less', async () => {
        dataManager.initClientData = buildGameData(FLY_ZONE);
        const { input } = buildDetailPanel('Fly Zone', 0);
        settings({ buffer: 10 });
        vi.spyOn(dataManager, 'isBossMonster').mockReturnValue(false);

        await taskProfitDisplay._applyGoEstimate({
            zoneHrid: '/actions/combat/fly',
            monsterHrid: '/monsters/fly',
            predictedFights: 100_000,
            killsNeeded: 50_000,
            killsPerFight: 0.5,
        });

        expect(input.value).toBe('110000');
    });

    test('confidence at 0 leaves exactly the old flat-buffer behavior', async () => {
        dataManager.initClientData = buildGameData(FLY_ZONE);
        const { input } = buildDetailPanel('Fly Zone', 0);
        settings({ confidence: 0 });
        vi.spyOn(dataManager, 'isBossMonster').mockReturnValue(false);

        await taskProfitDisplay._applyGoEstimate({
            zoneHrid: '/actions/combat/fly',
            monsterHrid: '/monsters/fly',
            predictedFights: 60,
            killsNeeded: 6,
            killsPerFight: 0.1,
        });

        expect(input.value).toBe('63');
    });

    test('an estimate with no kill rate falls back to the flat buffer, never a guess', async () => {
        dataManager.initClientData = buildGameData(FLY_ZONE);
        const { input } = buildDetailPanel('Fly Zone', 0);
        settings();
        vi.spyOn(dataManager, 'isBossMonster').mockReturnValue(false);

        await taskProfitDisplay._applyGoEstimate({
            zoneHrid: '/actions/combat/fly',
            monsterHrid: '/monsters/fly',
            predictedFights: 200,
            killsNeeded: 20,
            killsPerFight: null,
        });

        expect(input.value).toBe('210');
    });
});

/**
 * Ask 5b (a fight that hands out more than one kill is still random): an
 * encounter fills up to `maxSpawnCount` monster slots, so a zone the task
 * monster dominates can average more than one kill a fight. Pre-fix
 * `killsPerFight >= 1` took the deterministic branch in `padFightCount` and
 * the estimate was filled verbatim — no quantile and no flat buffer — on a
 * count that is every bit as random as a rare monster's. The zone's slot count
 * comes from the game data, so the padding can model the batch instead of
 * mistaking its mean for certainty.
 */
describe('_applyGoEstimate (a fight worth more than one kill)', () => {
    const CROWD_ZONE = [
        {
            hrid: '/actions/combat/crowd',
            name: 'Crowd Zone',
            category: '/categories/crowd',
            sortIndex: 1,
            monsters: ['/monsters/fly'],
        },
    ];

    /** Game data whose encounters hold `slots` monsters. */
    function crowdedGameData(slots) {
        const data = buildGameData(CROWD_ZONE);
        data.actionDetailMap['/actions/combat/crowd'].combatZoneInfo.fightInfo.randomSpawnInfo.maxSpawnCount = slots;
        return data;
    }

    function settings({ buffer = 5, confidence = 90 } = {}) {
        vi.spyOn(config, 'getSettingValue').mockImplementation((key, fallback) => {
            if (key === 'taskCombatGoBuffer') return buffer;
            if (key === 'combatFightConfidence') return confidence;
            return fallback;
        });
    }

    test('a three-slot encounter averaging 1.5 kills is padded, not filled verbatim', async () => {
        dataManager.initClientData = crowdedGameData(3);
        const { input } = buildDetailPanel('Crowd Zone', 0);
        settings();
        vi.spyOn(dataManager, 'isBossMonster').mockReturnValue(false);

        await taskProfitDisplay._applyGoEstimate({
            zoneHrid: '/actions/combat/crowd',
            monsterHrid: '/monsters/fly',
            predictedFights: 40,
            killsNeeded: 60,
            killsPerFight: 1.5,
        });

        // Pre-fix this filled the bare 40. Sixty kills at 1.5 a fight over
        // three slots wants more than that nine times in ten.
        expect(Number(input.value)).toBe(
            fightsForKillConfidence({
                killsNeeded: 60,
                killsPerFight: 1.5,
                slotsPerFight: 3,
                confidencePercent: 90,
            })
        );
        expect(Number(input.value)).toBeGreaterThan(42);
    });

    test('a boss in such a zone is still filled verbatim', async () => {
        dataManager.initClientData = crowdedGameData(3);
        const { input } = buildDetailPanel('Crowd Zone', 0);
        settings();
        vi.spyOn(dataManager, 'isBossMonster').mockReturnValue(true);

        await taskProfitDisplay._applyGoEstimate({
            zoneHrid: '/actions/combat/crowd',
            monsterHrid: '/monsters/fly',
            predictedFights: 100,
            killsNeeded: 10,
            killsPerFight: 0.1,
        });

        expect(input.value).toBe('100');
    });
});
