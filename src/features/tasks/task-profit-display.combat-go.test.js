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
 * Every combat task estimate simulates at T0 (`difficultyTier: 0`), so Go
 * must land on T0 too — through `ensureZoneAndTier` (`utils/combat-zone-open.js`),
 * which reads the zone panel's own Difficulty combobox rather than a "zone
 * tab" that measurement on the live game showed never existed (that selector
 * matched the Combat page's top-level tabs — Combat Zones/Find Party/Combat
 * Sim/Statistics — never a per-zone entry, so the old fallback here was dead
 * code and is gone, not merely unused).
 */

import { describe, test, expect, afterEach, vi } from 'vitest';
import taskProfitDisplay from './task-profit-display.js';
import dataManager from '../../core/data-manager.js';
import config from '../../core/config.js';

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
        vi.spyOn(config, 'getSetting').mockReturnValue(false); // taskGoMerge off

        expect(taskProfitDisplay._resolveGoEstimate(taskNode)).toBe(estimate);
    });

    test("defers to taskGoMerge's exact total when it is about to combine several in-progress tasks", () => {
        const taskNode = document.createElement('div');
        taskProfitDisplay._cardEstimates.set(taskNode, {
            zoneHrid: '/actions/combat/fly',
            predictedFights: 42,
            monsterHrid: '/monsters/fly',
        });
        vi.spyOn(config, 'getSetting').mockReturnValue(true); // taskGoMerge on
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
