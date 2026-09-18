/**
 * @vitest-environment happy-dom
 *
 * `openCombatZoneAtTier` / `ensureZoneAndTier` / `selectDifficultyTier`: the
 * shared "navigate to a combat zone, confirm it, set its Difficulty combobox,
 * optionally fill the count" seam three features build their own buttons on
 * (the combat-task Go estimate, the all-zones results table, the Bestiary
 * plan). Never presses Start Now / Add Queue — only navigates and types into
 * the game's own inputs.
 *
 * `navigateToAction` lands on the Combat Zones *list*, not the zone's own
 * panel (measured live — see the module doc-comment), so
 * `openCombatZoneAtTier`'s own tests drive a list → tile click → panel
 * sequence rather than assuming a panel is already there once navigation
 * "succeeds".
 */

import { describe, test, expect, afterEach, vi } from 'vitest';
import dataManager from '../core/data-manager.js';
import * as itemNavigation from './item-navigation.js';
import { openCombatZoneAtTier, ensureZoneAndTier, selectDifficultyTier } from './combat-zone-open.js';

let comboboxIdSeq = 0;

/** A MUI-shaped Difficulty combobox, portalled listbox included, as measured live. */
function buildDifficultyCombobox(panel, tier, availableTiers = [0, 1, 2, 3, 4, 5]) {
    const id = `mwi-test-listbox-${comboboxIdSeq++}`;
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

/** A mounted action detail panel with a Loadout-style decoy combobox and a Difficulty one. */
function buildPanel(zoneName, tier, { withDecoyCombobox = false, withDifficultyCombobox = true } = {}) {
    const panel = document.createElement('div');
    panel.className = 'SkillActionDetail_skillActionDetail__1a';

    const name = document.createElement('div');
    name.className = 'SkillActionDetail_name__1a';
    name.textContent = zoneName;
    panel.appendChild(name);

    if (withDecoyCombobox) {
        const loadout = document.createElement('div');
        loadout.setAttribute('role', 'combobox');
        loadout.textContent = 'My Loadout';
        panel.appendChild(loadout);
    }

    const combobox = withDifficultyCombobox ? buildDifficultyCombobox(panel, tier) : null;

    const inputContainer = document.createElement('div');
    inputContainer.className = 'maxActionCountInput__1a';
    const input = document.createElement('input');
    inputContainer.appendChild(input);
    panel.appendChild(inputContainer);

    document.body.appendChild(panel);
    return { panel, input, combobox };
}

function buildGameData(zones) {
    const actionDetailMap = {};
    for (const z of zones) {
        actionDetailMap[z.hrid] = { type: '/action_types/combat', name: z.name };
    }
    return { actionDetailMap };
}

/**
 * The Combat Zones list `navigateToAction` actually lands on — a grid of
 * zone tiles, none of them a detail panel. Callers wire up their own click
 * listener on the tile they care about (or none, to simulate a tile that
 * does not open anything) before handing control back to the code under
 * test, the same way the old tests wired `navigateToAction` itself.
 */
function buildZoneList(zones) {
    const container = document.createElement('div');
    container.className = 'CombatZones_combatZones__1a';
    const tiles = {};
    for (const z of zones) {
        const tile = document.createElement('div');
        tile.className = 'SkillAction_skillAction__1a';
        const name = document.createElement('div');
        name.className = 'SkillAction_name__1a';
        name.textContent = z.name;
        tile.appendChild(name);
        container.appendChild(tile);
        tiles[z.hrid] = tile;
    }
    document.body.appendChild(container);
    return { container, tiles };
}

/** Drive an in-progress `selectDifficultyTier`/`openCombatZoneAtTier` call through its three settle waits. */
async function pickTierOption(tier) {
    await vi.advanceTimersByTimeAsync(300); // combobox popup opens
    const option = Array.from(document.querySelectorAll('[role="option"]')).find((o) => o.textContent === `T${tier}`);
    if (option) option.click();
    await vi.advanceTimersByTimeAsync(300); // readback settle
}

afterEach(() => {
    dataManager.initClientData = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('selectDifficultyTier', () => {
    test('returns true immediately when the combobox already reads the target tier', async () => {
        const { panel, combobox } = buildPanel('Aqua Planet', 2);
        const result = await selectDifficultyTier(panel, 2);
        expect(result).toBe(true);
        expect(combobox.textContent).toBe('T2');
    });

    test('opens the popup, picks the matching option, and confirms the readback', async () => {
        vi.useFakeTimers();
        const { panel, combobox } = buildPanel('Aqua Planet', 0);

        const resultPromise = selectDifficultyTier(panel, 3);
        combobox.click();
        await pickTierOption(3);

        expect(await resultPromise).toBe(true);
        expect(combobox.textContent).toBe('T3');
    });

    test('finds the Difficulty combobox by its own T-shaped value, not the first combobox in the panel', async () => {
        vi.useFakeTimers();
        const { panel, combobox } = buildPanel('Aqua Planet', 0, { withDecoyCombobox: true });

        const resultPromise = selectDifficultyTier(panel, 1);
        combobox.click();
        await pickTierOption(1);

        expect(await resultPromise).toBe(true);
    });

    test('refuses when no Difficulty combobox is present', async () => {
        const { panel } = buildPanel('Aqua Planet', 0, { withDifficultyCombobox: false });
        expect(await selectDifficultyTier(panel, 1)).toBe(false);
    });

    test('refuses when the popup never opens (aria-controls points nowhere, no listbox on the page)', async () => {
        vi.useFakeTimers();
        const panel = document.createElement('div');
        const combobox = document.createElement('div');
        combobox.setAttribute('role', 'combobox');
        combobox.setAttribute('aria-controls', 'nowhere');
        combobox.textContent = 'T0';
        panel.appendChild(combobox);

        const resultPromise = selectDifficultyTier(panel, 1);
        await vi.advanceTimersByTimeAsync(300);

        expect(await resultPromise).toBe(false);
    });

    test('refuses when no option in the popup reads the target tier', async () => {
        vi.useFakeTimers();
        const { panel, combobox } = buildPanel('Aqua Planet', 0, { withDifficultyCombobox: false });
        buildDifficultyCombobox(panel, 0, [0, 1]); // no T5 option
        const target = Array.from(panel.querySelectorAll('[role="combobox"]'))[0];

        const resultPromise = selectDifficultyTier(panel, 5);
        target.click();
        await vi.advanceTimersByTimeAsync(300);

        expect(await resultPromise).toBe(false);
        void combobox;
    });
});

describe('ensureZoneAndTier', () => {
    test('refuses without checking tier when the panel is null', async () => {
        expect(await ensureZoneAndTier(null, '/actions/combat/x', 0)).toBe(false);
    });

    test('refuses when the panel resolves to a different action than expected', async () => {
        dataManager.initClientData = buildGameData([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
        const { panel } = buildPanel('Not Aqua Planet', 0);
        expect(await ensureZoneAndTier(panel, '/actions/combat/aqua', 0)).toBe(false);
    });

    test('confirms zone and tier together', async () => {
        dataManager.initClientData = buildGameData([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
        const { panel } = buildPanel('Aqua Planet', 2);
        expect(await ensureZoneAndTier(panel, '/actions/combat/aqua', 2)).toBe(true);
    });
});

describe('openCombatZoneAtTier', () => {
    test('navigates, clicks the zone tile, confirms the tier, and fills nothing when no count is given', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
        vi.spyOn(itemNavigation, 'navigateToAction').mockImplementation(() => {
            const { tiles } = buildZoneList([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
            tiles['/actions/combat/aqua'].addEventListener('click', () => buildPanel('Aqua Planet', 3));
            return true;
        });

        const resultPromise = openCombatZoneAtTier('/actions/combat/aqua', 3);
        await vi.advanceTimersByTimeAsync(0); // list already present, tile click, panel already present

        const result = await resultPromise;
        expect(result).toEqual({ opened: true, tierConfirmed: true, filled: false });
        expect(document.querySelector('.maxActionCountInput__1a input').value).toBe('');
    });

    test('navigates, clicks the zone tile, confirms the tier, and fills the given count exactly — never recomputing it', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
        let input;
        vi.spyOn(itemNavigation, 'navigateToAction').mockImplementation(() => {
            const { tiles } = buildZoneList([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
            tiles['/actions/combat/aqua'].addEventListener('click', () => {
                ({ input } = buildPanel('Aqua Planet', 3));
            });
            return true;
        });

        const resultPromise = openCombatZoneAtTier('/actions/combat/aqua', 3, { count: 4667 });
        await vi.advanceTimersByTimeAsync(0);

        const result = await resultPromise;
        expect(result).toEqual({ opened: true, tierConfirmed: true, filled: true });
        expect(input.value).toBe('4667');
    });

    test('picks the right tile out of several, ignoring the others', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([
            { hrid: '/actions/combat/aqua', name: 'Aqua Planet' },
            { hrid: '/actions/combat/fly', name: 'Fly Plains' },
        ]);
        vi.spyOn(itemNavigation, 'navigateToAction').mockImplementation(() => {
            const { tiles } = buildZoneList([
                { hrid: '/actions/combat/aqua', name: 'Aqua Planet' },
                { hrid: '/actions/combat/fly', name: 'Fly Plains' },
            ]);
            tiles['/actions/combat/fly'].addEventListener('click', () => buildPanel('Fly Plains', 0));
            tiles['/actions/combat/aqua'].addEventListener('click', () => buildPanel('Aqua Planet', 1));
            return true;
        });

        const result = await openCombatZoneAtTier('/actions/combat/fly', 0);
        expect(result).toEqual({ opened: true, tierConfirmed: true, filled: false });
        expect(document.querySelector('[class*="SkillActionDetail_name"]').textContent).toBe('Fly Plains');
    });

    test('opens and picks the tier when the panel was left on a different one, then fills', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
        let panel;
        let input;
        vi.spyOn(itemNavigation, 'navigateToAction').mockImplementation(() => {
            const { tiles } = buildZoneList([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
            tiles['/actions/combat/aqua'].addEventListener('click', () => {
                ({ panel, input } = buildPanel('Aqua Planet', 0));
            });
            return true;
        });

        const resultPromise = openCombatZoneAtTier('/actions/combat/aqua', 4, { count: 10 });
        await vi.advanceTimersByTimeAsync(0); // list present, tile click opens the panel
        panel.querySelector('[role="combobox"]').click();
        await pickTierOption(4);

        const result = await resultPromise;
        expect(result).toEqual({ opened: true, tierConfirmed: true, filled: true });
        expect(input.value).toBe('10');
    });

    test('refuses to fill when navigateToAction fails', async () => {
        dataManager.initClientData = buildGameData([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
        vi.spyOn(itemNavigation, 'navigateToAction').mockReturnValue(false);

        const result = await openCombatZoneAtTier('/actions/combat/aqua', 1, { count: 10 });
        expect(result).toEqual({ opened: false, tierConfirmed: false, filled: false });
    });

    test('refuses for a zoneHrid the game has no name for', async () => {
        dataManager.initClientData = buildGameData([]);
        const navSpy = vi.spyOn(itemNavigation, 'navigateToAction');

        const result = await openCombatZoneAtTier('/actions/combat/gone', 1, { count: 10 });
        expect(result).toEqual({ opened: false, tierConfirmed: false, filled: false });
        expect(navSpy).not.toHaveBeenCalled();
    });

    test('refuses when the Combat Zones list never renders after navigateToAction', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
        vi.spyOn(itemNavigation, 'navigateToAction').mockReturnValue(true); // "succeeds" but nothing renders

        const resultPromise = openCombatZoneAtTier('/actions/combat/aqua', 1, { count: 10 });
        await vi.advanceTimersByTimeAsync(5000); // exhaust the list wait

        const result = await resultPromise;
        expect(result).toEqual({ opened: false, tierConfirmed: false, filled: false });
    });

    test('refuses when the zone list renders without a tile for this zone', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
        vi.spyOn(itemNavigation, 'navigateToAction').mockImplementation(() => {
            // Only some other zone's tile is present, not aqua's
            buildZoneList([{ hrid: '/actions/combat/fly', name: 'Fly Plains' }]);
            return true;
        });

        const result = await openCombatZoneAtTier('/actions/combat/aqua', 1, { count: 10 });
        expect(result).toEqual({ opened: false, tierConfirmed: false, filled: false });
    });

    test('refuses when the tile click never opens a detail panel', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
        vi.spyOn(itemNavigation, 'navigateToAction').mockImplementation(() => {
            buildZoneList([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]); // no click listener wired
            return true;
        });

        const resultPromise = openCombatZoneAtTier('/actions/combat/aqua', 1, { count: 10 });
        await vi.advanceTimersByTimeAsync(5000); // exhaust the panel wait

        const result = await resultPromise;
        expect(result).toEqual({ opened: true, tierConfirmed: false, filled: false });
    });

    test('refuses when the tile click opens the wrong zone panel', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([
            { hrid: '/actions/combat/aqua', name: 'Aqua Planet' },
            { hrid: '/actions/combat/fly', name: 'Fly Plains' },
        ]);
        vi.spyOn(itemNavigation, 'navigateToAction').mockImplementation(() => {
            const { tiles } = buildZoneList([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
            // Simulate a stale panel for a different zone left mounted from before
            tiles['/actions/combat/aqua'].addEventListener('click', () => buildPanel('Fly Plains', 0));
            return true;
        });

        const result = await openCombatZoneAtTier('/actions/combat/aqua', 1, { count: 10 });
        expect(result).toEqual({ opened: true, tierConfirmed: false, filled: false });
    });

    test('never fills when the tier cannot be confirmed, even with a count given', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
        let input;
        vi.spyOn(itemNavigation, 'navigateToAction').mockImplementation(() => {
            const { tiles } = buildZoneList([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
            tiles['/actions/combat/aqua'].addEventListener('click', () => {
                ({ input } = buildPanel('Aqua Planet', 0, { withDifficultyCombobox: false }));
            });
            return true;
        });

        const resultPromise = openCombatZoneAtTier('/actions/combat/aqua', 3, { count: 10 });
        await vi.advanceTimersByTimeAsync(0);

        const result = await resultPromise;
        expect(result).toEqual({ opened: true, tierConfirmed: false, filled: false });
        expect(input.value).toBe('');
    });
});
