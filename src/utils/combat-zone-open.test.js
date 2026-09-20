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
import { PANEL_SELECTOR } from './action-panel-helper.js';

/**
 * The character-tracking fields `characterIdentityChanged` reads, reset the
 * same way a fresh session starts — no character, no switch in progress.
 */
function resetCharacterTracking() {
    dataManager.currentCharacterId = null;
    dataManager.isCharacterSwitching = false;
}

/** Matches `ZONE_LIST_TIMEOUT_MS` / `ZONE_LIST_RETRY_TIMEOUT_MS` in combat-zone-open.js. */
const ZONE_LIST_WAIT_MS = 5000;

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

/**
 * The Combat page's own top-level tabs ("Combat Zones", "Find Party", "Combat
 * Sim", "Statistics" on the live client) — `GAME.COMBAT_PAGE_TABS`-shaped,
 * with `aria-selected`/`Mui-selected` marking whichever one is active, the
 * same convention every other MUI tab strip in this codebase uses.
 */
function buildCombatPageTabs(labels, selectedLabel) {
    const container = document.createElement('div');
    container.className = 'CombatPanel_tabsComponentContainer__1a';
    const buttons = {};
    for (const label of labels) {
        const button = document.createElement('button');
        button.className = 'MuiButtonBase-root MuiTab-root';
        button.textContent = label;
        const selected = label === selectedLabel;
        button.setAttribute('aria-selected', selected ? 'true' : 'false');
        if (selected) button.classList.add('Mui-selected');
        container.appendChild(button);
        buttons[label] = button;
    }
    document.body.appendChild(container);
    return buttons;
}

/**
 * The Combat Zones list as the live client actually renders it: a strip of
 * zone-GROUP tabs ("1. Smelly Planet" … "12. Dungeons") over a panels
 * container holding one `TabPanel_tabPanel` per group, all mounted, all but
 * the selected one carrying `TabPanel_hidden`. Clicking a group tab moves the
 * hidden marker and the selection the way the game's own tab component does.
 *
 * `extraTabs` adds decoy tab buttons to the strip so it no longer corresponds
 * one-to-one with the panels — the shape the group resolution must refuse on
 * rather than index into. `labelPanels` wires the `aria-labelledby` /
 * button-id pair MUI normally emits, which is the preferred resolution path.
 */
function buildGroupedZoneList(groups, selectedLabel, { extraTabs = 0, labelPanels = false } = {}) {
    const container = document.createElement('div');
    container.className = 'CombatZones_combatZones__1a';

    const tabList = document.createElement('div');
    tabList.setAttribute('role', 'tablist');
    container.appendChild(tabList);

    const panelsContainer = document.createElement('div');
    panelsContainer.className = 'TabsComponent_tabPanelsContainer__1a';
    container.appendChild(panelsContainer);

    const tiles = {};
    const tabs = {};
    const panels = [];

    const applySelection = (label) => {
        groups.forEach((group, index) => {
            const isSelected = group.label === label;
            tabs[group.label].setAttribute('aria-selected', isSelected ? 'true' : 'false');
            tabs[group.label].classList.toggle('Mui-selected', isSelected);
            panels[index].className = isSelected
                ? 'TabPanel_tabPanel__tXMJF'
                : 'TabPanel_tabPanel__tXMJF TabPanel_hidden__26UM3';
        });
    };

    groups.forEach((group, index) => {
        const button = document.createElement('button');
        button.className = 'MuiButtonBase-root MuiTab-root';
        button.textContent = group.label;
        tabList.appendChild(button);
        tabs[group.label] = button;

        const panel = document.createElement('div');
        if (labelPanels) {
            button.id = `mwi-test-group-tab-${index}`;
            panel.setAttribute('aria-labelledby', button.id);
        }
        for (const z of group.zones) {
            const tile = document.createElement('div');
            tile.className = 'SkillAction_skillAction__1a';
            const name = document.createElement('div');
            name.className = 'SkillAction_name__1a';
            name.textContent = z.name;
            tile.appendChild(name);
            panel.appendChild(tile);
            tiles[z.hrid] = tile;
        }
        panelsContainer.appendChild(panel);
        panels.push(panel);

        button.addEventListener('click', () => applySelection(group.label));
    });

    for (let i = 0; i < extraTabs; i++) {
        const decoy = document.createElement('button');
        decoy.className = 'MuiButtonBase-root MuiTab-root';
        decoy.textContent = `Decoy ${i}`;
        tabList.appendChild(decoy);
    }

    applySelection(selectedLabel);
    document.body.appendChild(container);
    return { container, tiles, tabs, panels, selectGroup: applySelection };
}

/** Count every click on a tile, so a test can prove an unreachable one was never pressed. */
function countClicks(element) {
    const counter = { count: 0 };
    element.addEventListener('click', () => counter.count++);
    return counter;
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
    resetCharacterTracking();
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
    test('opens the menu the way MUI listens for it, not with a bare click', () => {
        // Measured live: MUI's Select opens on mousedown. A combobox that only
        // answers click left the listbox closed, the tier unconfirmed, and every
        // caller refusing to fill — the buttons looked like they did nothing.
        const { panel, combobox } = buildPanel('Aqua Planet', 0);
        const seen = [];
        for (const type of ['mousedown', 'mouseup', 'click']) {
            combobox.addEventListener(type, () => seen.push(type));
        }

        selectDifficultyTier(panel, 3);

        expect(seen).toContain('mousedown');
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

    test('refuses to fill when the character switches away mid-sequence', async () => {
        // A switch landing between the tile click (which opens the panel)
        // and the tier/count being confirmed — the exact window this
        // sequence spends several awaits inside. Without a check, the count
        // meant for the old character lands in the new character's panel,
        // since both characters' zone hrids and DOM shape are identical.
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
        dataManager.currentCharacterId = 'char-a';
        let input;
        vi.spyOn(itemNavigation, 'navigateToAction').mockImplementation(() => {
            const { tiles } = buildZoneList([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
            tiles['/actions/combat/aqua'].addEventListener('click', () => {
                ({ input } = buildPanel('Aqua Planet', 3));
                // Simulate the switch landing here, the way a real
                // `character_switched` event would mid-await.
                dataManager.currentCharacterId = 'char-b';
            });
            return true;
        });

        const resultPromise = openCombatZoneAtTier('/actions/combat/aqua', 3, { count: 999 });
        await vi.advanceTimersByTimeAsync(0);

        const result = await resultPromise;
        expect(result.filled).toBe(false);
        expect(input.value).toBe('');
    });

    test('refuses to fill when a character switch is already in progress at the start', async () => {
        dataManager.initClientData = buildGameData([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
        dataManager.isCharacterSwitching = true;
        const navSpy = vi.spyOn(itemNavigation, 'navigateToAction').mockImplementation(() => {
            const { tiles } = buildZoneList([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
            tiles['/actions/combat/aqua'].addEventListener('click', () => buildPanel('Aqua Planet', 3));
            return true;
        });

        const result = await openCombatZoneAtTier('/actions/combat/aqua', 3, { count: 999 });
        // navigateToAction still fires (harmless — it just reopens the same
        // list) but the sequence must not confirm a tier or fill a count
        // while mid-switch.
        expect(navSpy).toHaveBeenCalled();
        expect(result.filled).toBe(false);
    });
});

describe('openCombatZoneAtTier — in-combat (Battle view, no Combat Zones list)', () => {
    // MEASURED CONTRACT (do not re-derive): on the maintainer's live client,
    // mid-fight, `navigateToAction` fires but the Combat Zones list never
    // renders — the Combat page is showing its Battle view instead. The
    // console read `[DOM] Timeout waiting for: [class*="CombatZones_combatZones"]`
    // and every ▶ button did nothing. A class dump from that same page
    // contained `CombatPanel_tabsComponentContainer` and no `CombatZones_*`
    // at all. `GAME.COMBAT_PAGE_TABS` (`CombatPanel_tabsComponentContainer`
    // + `MuiTab-root`) is itself measured — see selectors.js and the
    // 2026-09-17/18 combat-zone-open.js module doc-comment.
    //
    // ASSUMPTIONS (not measured — see combat-zone-open.js doc-comments):
    // that the previously active tab is marked via `aria-selected`/
    // `Mui-selected` (an inference from this codebase's own convention
    // elsewhere, not verified for the Combat page's specific tabs), and that
    // clicking "Combat Zones" is what makes the list render (this is the fix
    // being built, not something separately measured live yet).

    test('list absent, "Combat Zones" page tab present: clicks it, the list then appears, and the open proceeds', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
        const tabs = buildCombatPageTabs(['Combat Zones', 'Find Party', 'Combat Sim', 'Statistics'], 'Find Party');

        vi.spyOn(itemNavigation, 'navigateToAction').mockImplementation(() => {
            // The list is NOT built here — simulating a player on the Battle
            // view, where navigateToAction fires but nothing Combat-Zones-
            // shaped is in the DOM until the page tab is switched. This is
            // exactly the shape that would time out and fail before this fix.
            tabs['Combat Zones'].addEventListener('click', () => {
                const { tiles } = buildZoneList([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
                tiles['/actions/combat/aqua'].addEventListener('click', () => buildPanel('Aqua Planet', 3));
            });
            return true;
        });

        const resultPromise = openCombatZoneAtTier('/actions/combat/aqua', 3);
        // The first wait for the list has to exhaust before the code looks
        // for a page tab at all — this is what proves the tab click is a
        // *fallback*, not the first thing tried.
        await vi.advanceTimersByTimeAsync(ZONE_LIST_WAIT_MS);

        const result = await resultPromise;
        expect(result).toEqual({ opened: true, tierConfirmed: true, filled: false });
    });

    test('no "Combat Zones" page tab found: refuses cleanly without clicking anything', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
        buildCombatPageTabs(['Find Party', 'Combat Sim', 'Statistics'], 'Find Party'); // no "Combat Zones" tab

        vi.spyOn(itemNavigation, 'navigateToAction').mockReturnValue(true); // list never renders

        const resultPromise = openCombatZoneAtTier('/actions/combat/aqua', 3, { count: 10 });
        await vi.advanceTimersByTimeAsync(ZONE_LIST_WAIT_MS);

        const result = await resultPromise;
        expect(result).toEqual({ opened: false, tierConfirmed: false, filled: false });
    });

    test('matches the tab by label case-insensitively', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
        const tabs = buildCombatPageTabs(['combat ZONES', 'Find Party'], 'Find Party');

        vi.spyOn(itemNavigation, 'navigateToAction').mockImplementation(() => {
            tabs['combat ZONES'].addEventListener('click', () => {
                const { tiles } = buildZoneList([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
                tiles['/actions/combat/aqua'].addEventListener('click', () => buildPanel('Aqua Planet', 0));
            });
            return true;
        });

        const resultPromise = openCombatZoneAtTier('/actions/combat/aqua', 0);
        await vi.advanceTimersByTimeAsync(ZONE_LIST_WAIT_MS);

        expect(await resultPromise).toEqual({ opened: true, tierConfirmed: true, filled: false });
    });

    test('tab found, but the list never appears after clicking it: refuses cleanly and restores the previous tab', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
        const tabs = buildCombatPageTabs(['Combat Zones', 'Find Party'], 'Find Party');
        let zonesTabClicked = 0;
        let battleTabClicked = 0;
        tabs['Combat Zones'].addEventListener('click', () => zonesTabClicked++); // never builds the list
        tabs['Find Party'].addEventListener('click', () => battleTabClicked++);

        vi.spyOn(itemNavigation, 'navigateToAction').mockReturnValue(true);

        const resultPromise = openCombatZoneAtTier('/actions/combat/aqua', 3, { count: 10 });
        await vi.advanceTimersByTimeAsync(ZONE_LIST_WAIT_MS * 2); // first wait + retry wait

        const result = await resultPromise;
        expect(result).toEqual({ opened: false, tierConfirmed: false, filled: false });
        expect(zonesTabClicked).toBe(1);
        // Restored back to the tab that was selected before the switch.
        expect(battleTabClicked).toBe(1);
    });

    test('list already present: never looks for or clicks a page tab', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
        const tabs = buildCombatPageTabs(['Combat Zones', 'Find Party'], 'Find Party');
        let zonesTabClicked = 0;
        tabs['Combat Zones'].addEventListener('click', () => zonesTabClicked++);

        vi.spyOn(itemNavigation, 'navigateToAction').mockImplementation(() => {
            const { tiles } = buildZoneList([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
            tiles['/actions/combat/aqua'].addEventListener('click', () => buildPanel('Aqua Planet', 1));
            return true;
        });

        const result = await openCombatZoneAtTier('/actions/combat/aqua', 1);
        expect(result).toEqual({ opened: true, tierConfirmed: true, filled: false });
        expect(zonesTabClicked).toBe(0);
    });
});

describe('openCombatZoneAtTier — zone groups (the list is itself a tab strip)', () => {
    // MEASURED CONTRACT (do not re-derive): with the Combat Zones tab showing,
    // `GAME.COMBAT_PAGE_TABS` matches the twelve per-zone GROUP tabs ("1.
    // Smelly Planet" … "12. Dungeons") as well as the page's own tabs, and the
    // mounted list's textContent holds every zone's name whichever group is
    // selected — the unselected groups are rendered into `TabPanel_hidden`
    // panels. A tile found by hrid is therefore not necessarily a tile the
    // player can click, which is why ▶ "did nothing" for a zone outside the
    // group the player happened to be looking at.

    const AQUA = { hrid: '/actions/combat/aqua', name: 'Aqua Planet' };
    const SMELLY = { hrid: '/actions/combat/fly', name: 'Fly Plains' };
    const PIRATE = { hrid: '/actions/combat/pirate_cove', name: 'Pirate Cove' };

    /** The three-group list the tests below drive, Dungeons included. */
    function threeGroups() {
        return [
            { label: '1. Smelly Planet', zones: [SMELLY] },
            { label: '3. Aqua Planet', zones: [AQUA] },
            { label: '12. Dungeons', zones: [PIRATE] },
        ];
    }

    test('a tile in a hidden group panel is not treated as reachable: the group tab is selected first, then the tile is clicked', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([AQUA, SMELLY, PIRATE]);
        const list = buildGroupedZoneList(threeGroups(), '1. Smelly Planet');
        const aquaClicks = countClicks(list.tiles[AQUA.hrid]);
        const groupClicks = countClicks(list.tabs['3. Aqua Planet']);
        list.tiles[AQUA.hrid].addEventListener('click', () => buildPanel('Aqua Planet', 2));
        vi.spyOn(itemNavigation, 'navigateToAction').mockReturnValue(true);

        const resultPromise = openCombatZoneAtTier(AQUA.hrid, 2);
        await vi.advanceTimersByTimeAsync(0);

        expect(await resultPromise).toEqual({ opened: true, tierConfirmed: true, filled: false });
        expect(groupClicks.count).toBe(1);
        expect(aquaClicks.count).toBe(1);
        // The group tab was pressed before the tile, not after it
        expect(list.tabs['3. Aqua Planet'].getAttribute('aria-selected')).toBe('true');
    });

    test('a zone in the Dungeons group is reached the same way, with no dungeon special case', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([AQUA, SMELLY, PIRATE]);
        const list = buildGroupedZoneList(threeGroups(), '1. Smelly Planet');
        let input;
        list.tiles[PIRATE.hrid].addEventListener('click', () => {
            ({ input } = buildPanel('Pirate Cove', 0));
        });
        vi.spyOn(itemNavigation, 'navigateToAction').mockReturnValue(true);

        const resultPromise = openCombatZoneAtTier(PIRATE.hrid, 0, { count: 3 });
        await vi.advanceTimersByTimeAsync(0);

        expect(await resultPromise).toEqual({ opened: true, tierConfirmed: true, filled: true });
        expect(input.value).toBe('3');
        expect(list.tabs['12. Dungeons'].getAttribute('aria-selected')).toBe('true');
    });

    test('resolves the group through the panel’s aria-labelledby when the game emits it, even with a strip that does not index-match', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([AQUA, SMELLY, PIRATE]);
        // `extraTabs` breaks the positional fallback on purpose: only the
        // aria pairing can resolve the group here.
        const list = buildGroupedZoneList(threeGroups(), '1. Smelly Planet', { extraTabs: 2, labelPanels: true });
        list.tiles[AQUA.hrid].addEventListener('click', () => buildPanel('Aqua Planet', 1));
        vi.spyOn(itemNavigation, 'navigateToAction').mockReturnValue(true);

        const resultPromise = openCombatZoneAtTier(AQUA.hrid, 1);
        await vi.advanceTimersByTimeAsync(0);

        expect(await resultPromise).toEqual({ opened: true, tierConfirmed: true, filled: false });
        expect(list.tabs['3. Aqua Planet'].getAttribute('aria-selected')).toBe('true');
    });

    test('refuses without clicking anything when the strip and the group panels do not correspond', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([AQUA, SMELLY, PIRATE]);
        const list = buildGroupedZoneList(threeGroups(), '1. Smelly Planet', { extraTabs: 2 });
        const aquaClicks = countClicks(list.tiles[AQUA.hrid]);
        const groupClicks = countClicks(list.tabs['3. Aqua Planet']);
        list.tiles[AQUA.hrid].addEventListener('click', () => buildPanel('Aqua Planet', 2));
        vi.spyOn(itemNavigation, 'navigateToAction').mockReturnValue(true);

        const resultPromise = openCombatZoneAtTier(AQUA.hrid, 2, { count: 10 });
        await vi.advanceTimersByTimeAsync(0);

        expect(await resultPromise).toEqual({ opened: false, tierConfirmed: false, filled: false });
        expect(groupClicks.count).toBe(0);
        expect(aquaClicks.count).toBe(0);
    });

    test('refuses and restores the group tab when the tile never becomes reachable after the group is selected', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([AQUA, SMELLY, PIRATE]);
        // A group tab whose click does not unhide anything — the tile stays
        // buried and the sequence must give the player their group back.
        const list = buildGroupedZoneList(threeGroups(), '1. Smelly Planet');
        list.tabs['3. Aqua Planet'].replaceWith(list.tabs['3. Aqua Planet'].cloneNode(true));
        const deadTab = list.container.querySelectorAll('button')[1];
        const deadClicks = countClicks(deadTab);
        const smellyTabClicks = countClicks(list.tabs['1. Smelly Planet']);
        vi.spyOn(itemNavigation, 'navigateToAction').mockReturnValue(true);

        const resultPromise = openCombatZoneAtTier(AQUA.hrid, 2, { count: 10 });
        await vi.advanceTimersByTimeAsync(5000); // exhaust the reachable-tile wait

        expect(await resultPromise).toEqual({ opened: false, tierConfirmed: false, filled: false });
        expect(deadClicks.count).toBe(1);
        expect(smellyTabClicks.count).toBe(1); // restored to the group the player was on
    });

    test('mid-fight: switches the page tab, then the group tab, and a later failure restores both', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([AQUA, SMELLY, PIRATE]);
        const pageTabs = buildCombatPageTabs(['Combat Zones', 'Find Party', 'My Party', 'Battle #8'], 'Battle #8');
        const battleTabClicks = countClicks(pageTabs['Battle #8']);
        let smellyTabClicks;
        vi.spyOn(itemNavigation, 'navigateToAction').mockImplementation(() => {
            pageTabs['Combat Zones'].addEventListener('click', () => {
                const list = buildGroupedZoneList(threeGroups(), '1. Smelly Planet');
                smellyTabClicks = countClicks(list.tabs['1. Smelly Planet']);
                // The tile opens no panel — the sequence gets as far as the
                // group switch and then has to unwind all of it.
            });
            return true;
        });

        const resultPromise = openCombatZoneAtTier(AQUA.hrid, 2, { count: 10 });
        await vi.advanceTimersByTimeAsync(ZONE_LIST_WAIT_MS); // page tab fallback
        await vi.advanceTimersByTimeAsync(5000); // panel wait exhausts

        expect(await resultPromise).toEqual({ opened: true, tierConfirmed: false, filled: false });
        expect(smellyTabClicks.count).toBe(1);
        expect(battleTabClicks.count).toBe(1);
    });

    test('a tile in the selected group is clicked straight away — no group tab is touched', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([AQUA, SMELLY, PIRATE]);
        const list = buildGroupedZoneList(threeGroups(), '3. Aqua Planet');
        const groupClicks = countClicks(list.tabs['3. Aqua Planet']);
        const otherGroupClicks = countClicks(list.tabs['1. Smelly Planet']);
        list.tiles[AQUA.hrid].addEventListener('click', () => buildPanel('Aqua Planet', 4));
        vi.spyOn(itemNavigation, 'navigateToAction').mockReturnValue(true);

        const result = await openCombatZoneAtTier(AQUA.hrid, 4);
        expect(result).toEqual({ opened: true, tierConfirmed: true, filled: false });
        expect(groupClicks.count).toBe(0);
        expect(otherGroupClicks.count).toBe(0);
    });

    test('refuses to click a group tab for a character that switched away mid-wait', async () => {
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([AQUA, SMELLY, PIRATE]);
        dataManager.currentCharacterId = 'char-a';
        const list = buildGroupedZoneList(threeGroups(), '1. Smelly Planet');
        const smellyTabClicks = countClicks(list.tabs['1. Smelly Planet']);
        list.tabs['3. Aqua Planet'].addEventListener('click', () => {
            // The switch lands while the sequence waits for the group's tiles
            dataManager.currentCharacterId = 'char-b';
        });
        vi.spyOn(itemNavigation, 'navigateToAction').mockReturnValue(true);

        const resultPromise = openCombatZoneAtTier(AQUA.hrid, 2, { count: 10 });
        await vi.advanceTimersByTimeAsync(5000);

        expect(await resultPromise).toEqual({ opened: false, tierConfirmed: false, filled: false });
        // Nothing clicked back either: a tab click on the new character's page
        // is worse than leaving it where it is.
        expect(smellyTabClicks.count).toBe(0);
    });
});

describe('openCombatZoneAtTier — a switch during the QUEUE wait', () => {
    test('a press queued behind another sequence aborts if the character changed while it waited', async () => {
        // The identity guard is only as good as the identity it compares
        // against, and `runZoneOpenExclusive`'s queue wait is itself an await
        // straddling that read. Two ▶ presses, back to back: the second sits
        // in the queue while the first settles, and the player switches
        // character during that wait. Reading the character id when the
        // second sequence finally got its turn read whoever had just been
        // switched TO, so every guard downstream agreed nothing had changed
        // and the second press filled its count into the new character's
        // panel.
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([
            { hrid: '/actions/combat/aqua', name: 'Aqua Planet' },
            { hrid: '/actions/combat/fly', name: 'Fly Plains' },
        ]);
        dataManager.currentCharacterId = 'char-a';

        let flyInput = null;
        const { tiles } = buildZoneList([
            { hrid: '/actions/combat/aqua', name: 'Aqua Planet' },
            { hrid: '/actions/combat/fly', name: 'Fly Plains' },
        ]);
        tiles['/actions/combat/aqua'].addEventListener('click', () => {
            setTimeout(() => {
                buildPanel('Aqua Planet', 0);
                // The switch lands while the SECOND press is still queued
                dataManager.currentCharacterId = 'char-b';
            }, 50);
        });
        tiles['/actions/combat/fly'].addEventListener('click', () => {
            document.querySelectorAll(PANEL_SELECTOR).forEach((el) => el.remove());
            ({ input: flyInput } = buildPanel('Fly Plains', 0));
        });
        vi.spyOn(itemNavigation, 'navigateToAction').mockReturnValue(true);

        const first = openCombatZoneAtTier('/actions/combat/aqua', 0);
        const second = openCombatZoneAtTier('/actions/combat/fly', 0, { count: 999 });

        const [, secondResult] = await Promise.all([vi.advanceTimersByTimeAsync(1000).then(() => first), second]);

        expect(secondResult.filled).toBe(false);
        expect(flyInput?.value ?? '').toBe('');
    });

    test('the tier is not written into the new character’s panel when the switch lands mid-pick', async () => {
        // `selectDifficultyTier` clicks an option — a WRITE — after a 300 ms
        // settle wait, and the callers' guards only run once it has returned.
        // A switch inside that wait leaves the new character's Difficulty set
        // to the old character's tier, sitting there for them to press Start
        // Now against.
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
        dataManager.currentCharacterId = 'char-a';

        let combobox = null;
        vi.spyOn(itemNavigation, 'navigateToAction').mockImplementation(() => {
            const { tiles } = buildZoneList([{ hrid: '/actions/combat/aqua', name: 'Aqua Planet' }]);
            tiles['/actions/combat/aqua'].addEventListener('click', () => {
                ({ combobox } = buildPanel('Aqua Planet', 0));
            });
            return true;
        });

        const resultPromise = openCombatZoneAtTier('/actions/combat/aqua', 5);
        await vi.advanceTimersByTimeAsync(0); // through the list, the tile and the panel
        // The combobox popup is open and the sequence is inside its settle
        // wait — exactly where the switch lands.
        dataManager.currentCharacterId = 'char-b';
        await vi.advanceTimersByTimeAsync(1000);

        const result = await resultPromise;
        expect(result.tierConfirmed).toBe(false);
        expect(combobox.textContent).toBe('T0');
    });
});

describe('openCombatZoneAtTier re-entrancy — runZoneOpenExclusive', () => {
    test('a second call never touches the shared panel until the first has fully settled', async () => {
        // Two ▶ clicks on different rows, back to back. Aqua's own panel
        // mounts on a delay (standing in for the game's own render taking a
        // moment) — without serialization, Fly's sequence would run
        // concurrently during that window and could click Fly's tile, or
        // read/fill Fly's panel, while Aqua's is still being confirmed.
        // Asserted by recording *when* each side effect happens, since a
        // fake-timer `advanceTimersByTimeAsync` call can drain more than one
        // queued microtask chain in a single await, making a mid-flight
        // snapshot an unreliable way to prove ordering.
        vi.useFakeTimers();
        dataManager.initClientData = buildGameData([
            { hrid: '/actions/combat/aqua', name: 'Aqua Planet' },
            { hrid: '/actions/combat/fly', name: 'Fly Plains' },
        ]);
        const order = [];
        // One shared Combat Zones list, the way the real one persists across
        // re-navigating to it — both calls' `waitForElement(ZONE_LIST_SELECTOR)`
        // must find both tiles, not each find a separate stale list holding
        // only the other zone.
        const { tiles } = buildZoneList([
            { hrid: '/actions/combat/aqua', name: 'Aqua Planet' },
            { hrid: '/actions/combat/fly', name: 'Fly Plains' },
        ]);
        tiles['/actions/combat/aqua'].addEventListener('click', () => {
            order.push('aqua-tile-clicked');
            setTimeout(() => {
                order.push('aqua-panel-mounted');
                buildPanel('Aqua Planet', 0);
            }, 50);
        });
        tiles['/actions/combat/fly'].addEventListener('click', () => {
            order.push('fly-tile-clicked');
            // The game swaps the mounted panel rather than stacking a second
            // one — clear aqua's out first the way its own re-render would.
            document.querySelectorAll(PANEL_SELECTOR).forEach((el) => el.remove());
            buildPanel('Fly Plains', 0);
        });
        vi.spyOn(itemNavigation, 'navigateToAction').mockImplementation((hrid) => {
            order.push(`navigate:${hrid}`);
            return true;
        });

        const p1 = openCombatZoneAtTier('/actions/combat/aqua', 0);
        const p2 = openCombatZoneAtTier('/actions/combat/fly', 0);

        const [result1, result2] = await Promise.all([vi.advanceTimersByTimeAsync(1000).then(() => p1), p2]);

        expect(result1).toEqual({ opened: true, tierConfirmed: true, filled: false });
        expect(result2).toEqual({ opened: true, tierConfirmed: true, filled: false });
        // Every one of fly's own steps comes after every one of aqua's — the
        // two sequences never interleaved on the shared panel.
        expect(order).toEqual([
            'navigate:/actions/combat/aqua',
            'aqua-tile-clicked',
            'aqua-panel-mounted',
            'navigate:/actions/combat/fly',
            'fly-tile-clicked',
        ]);
    });
});
