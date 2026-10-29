/**
 * @vitest-environment happy-dom
 *
 * Go on a Zone-mode combat estimate whose picked zone is not the zone the
 * game's own Go landed on: Toolasha opens the picked zone at the estimate's
 * tier and fills the padded count. Solo mode and an already-correct landing
 * keep the fill-only behavior.
 */

import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import taskProfitDisplay from './task-profit-display.js';
import dataManager from '../../core/data-manager.js';
import { openCombatZoneAtTierSequence } from '../../utils/combat-zone-open.js';

vi.mock('../../utils/combat-zone-open.js', async (importOriginal) => {
    const original = await importOriginal();
    return { ...original, openCombatZoneAtTierSequence: vi.fn() };
});

const PLANET = '/actions/combat/planet';
const OWN = '/actions/combat/own_zone';

function buildGameData() {
    const actionDetailMap = {};
    for (const [hrid, name] of [
        [PLANET, 'Planet'],
        [OWN, 'Own Zone'],
    ]) {
        actionDetailMap[hrid] = {
            type: '/action_types/combat',
            name,
            combatZoneInfo: { isDungeon: false, fightInfo: { randomSpawnInfo: { spawns: [] }, bossSpawns: [] } },
        };
    }
    return { actionDetailMap, actionCategoryDetailMap: {} };
}

function buildDetailPanel(zoneName, tier = 0) {
    const panel = document.createElement('div');
    panel.className = 'SkillActionDetail_skillActionDetail__1a';
    const name = document.createElement('div');
    name.className = 'SkillActionDetail_name__1a';
    name.textContent = zoneName;
    panel.appendChild(name);
    const combobox = document.createElement('div');
    combobox.setAttribute('role', 'combobox');
    combobox.textContent = `T${tier}`;
    panel.appendChild(combobox);
    const inputContainer = document.createElement('div');
    inputContainer.className = 'maxActionCountInput__1a';
    const input = document.createElement('input');
    inputContainer.appendChild(input);
    panel.appendChild(inputContainer);
    document.body.appendChild(panel);
    return { panel, input };
}

beforeEach(() => {
    dataManager.initClientData = buildGameData();
    dataManager.currentCharacterId = 'char-a';
    openCombatZoneAtTierSequence.mockReset();
    openCombatZoneAtTierSequence.mockResolvedValue({ opened: true, tierConfirmed: true, filled: true });
});

afterEach(() => {
    dataManager.initClientData = null;
    dataManager.currentCharacterId = null;
    dataManager.isCharacterSwitching = false;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('_applyGoEstimate: Zone mode picks a zone Go did not land on', () => {
    test('opens the picked zone at the estimate tier with the padded count', async () => {
        const { input } = buildDetailPanel('Own Zone', 0);

        await taskProfitDisplay._applyGoEstimate({ zoneHrid: PLANET, predictedFights: 100, tier: 2, mode: 'zone' });

        expect(openCombatZoneAtTierSequence).toHaveBeenCalledTimes(1);
        // 105 = 100 + the default 5% flat buffer (no kill rate on the estimate)
        expect(openCombatZoneAtTierSequence).toHaveBeenCalledWith(PLANET, 2, { count: 105 }, 'char-a');
        // The landed panel is never filled by hand
        expect(input.value).toBe('');
    });

    test('already on the picked zone: fills only, no navigation', async () => {
        const { input } = buildDetailPanel('Planet', 0);

        await taskProfitDisplay._applyGoEstimate({ zoneHrid: PLANET, predictedFights: 100, mode: 'zone' });

        expect(openCombatZoneAtTierSequence).not.toHaveBeenCalled();
        expect(input.value).toBe('105');
    });

    test('Solo mode keeps today: no navigation, nothing filled on another zone', async () => {
        const { input } = buildDetailPanel('Own Zone', 0);

        await taskProfitDisplay._applyGoEstimate({ zoneHrid: PLANET, predictedFights: 100, mode: 'solo' });

        expect(openCombatZoneAtTierSequence).not.toHaveBeenCalled();
        expect(input.value).toBe('');
    });

    test('an estimate with no mode keeps today as well', async () => {
        buildDetailPanel('Own Zone', 0);

        await taskProfitDisplay._applyGoEstimate({ zoneHrid: PLANET, predictedFights: 100 });

        expect(openCombatZoneAtTierSequence).not.toHaveBeenCalled();
    });

    test('a character switch before the work starts does nothing', async () => {
        buildDetailPanel('Own Zone', 0);
        dataManager.currentCharacterId = 'char-b';

        await taskProfitDisplay._applyGoEstimate({ zoneHrid: PLANET, predictedFights: 100, mode: 'zone' }, 'char-a');

        expect(openCombatZoneAtTierSequence).not.toHaveBeenCalled();
    });

    test('the zone cannot be opened: logged, nothing else is touched', async () => {
        const { input } = buildDetailPanel('Own Zone', 0);
        openCombatZoneAtTierSequence.mockResolvedValue({ opened: false, tierConfirmed: false, filled: false });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await taskProfitDisplay._applyGoEstimate({ zoneHrid: PLANET, predictedFights: 100, mode: 'zone' });

        expect(warn).toHaveBeenCalled();
        expect(input.value).toBe('');
    });

    test('a switch during the open stays silent', async () => {
        buildDetailPanel('Own Zone', 0);
        openCombatZoneAtTierSequence.mockImplementation(async () => {
            dataManager.currentCharacterId = 'char-b';
            return { opened: true, tierConfirmed: false, filled: false };
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await taskProfitDisplay._applyGoEstimate({ zoneHrid: PLANET, predictedFights: 100, mode: 'zone' });

        expect(warn).not.toHaveBeenCalled();
    });
});

describe('_storeCardEstimate carries the mode', () => {
    test('the stored record names the mode the estimate was run in', () => {
        const node = document.createElement('div');
        taskProfitDisplay._storeCardEstimate(
            node,
            PLANET,
            '/monsters/x',
            1,
            { predictedFights: 10, remaining: 5, killsPerFight: 0.5 },
            'zone'
        );
        expect(taskProfitDisplay._cardEstimates.get(node)).toMatchObject({ zoneHrid: PLANET, mode: 'zone' });
    });
});
