/**
 * A real live-server melee smash (flail) character export, in the Shykai shape Toolasha imports, carried through
 * the import, the roster and the party finder as a live-typical teammate (main stat ~136, abilities 50-86).
 */

import { describe, test, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({ clientData: null }));
const db = vi.hoisted(() => ({ value: undefined }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => mocks.clientData,
        getCurrentCharacterGameMode: () => 'standard',
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (_key, _store, fallback) => (db.value === undefined ? fallback : structuredClone(db.value)),
        update: async (_key, mutate) => {
            const next = mutate(db.value === undefined ? undefined : structuredClone(db.value), db.value !== undefined);
            if (next === undefined) return { written: false, value: db.value };
            db.value = structuredClone(next);
            return { written: true, value: structuredClone(next) };
        },
    },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => null, getSettingValue: (_k, d) => d } }));
vi.mock('../combat/loadout-snapshot.js', () => ({ default: {} }));
vi.mock('../../api/marketplace.js', () => ({ default: {} }));
vi.mock('../market/expected-value-calculator.js', () => ({ default: {} }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: () => 0, getItemPrices: () => ({}) }));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({ getProductionCost: () => 0 }));
vi.mock('../../utils/view-loadout.js', () => ({
    VIEW_LOADOUT_CONTEXT: { Party: 'party', GuildTrial: 'guild_trial' },
    getLoadout: () => null,
}));

const { parseShykaiImport, buildShykaiExportPlayer } = await import('./combat-sim-adapter.js');
const { addTeammates, loadRoster, validateTeammateDTO, sanitizeTeammateDTO } = await import('./party-roster.js');
const { planSweep, buildCompositionParty, applyAura } = await import('./party-finder.js');
const { PARTY_TEMPLATES } = await import('./party-templates.js');

const exportText = readFileSync(new URL('./__fixtures__/endgame/melee-smash.json', import.meta.url), 'utf8');
const exported = JSON.parse(exportText);

/** Item sheet for the export's gear: the slot is the tail of the export's location */
function itemSheet() {
    const itemDetailMap = {};
    for (const eq of exported.player.equipment) {
        const slot = eq.itemLocationHrid.replace('/item_locations/', '');
        itemDetailMap[eq.itemHrid] = { name: eq.itemHrid, equipmentDetail: { type: `/equipment_types/${slot}` } };
    }
    return { itemDetailMap };
}

const gameData = {
    abilityDetailMap: {
        '/abilities/fierce_aura': { name: 'Fierce Aura', isSpecialAbility: true },
        '/abilities/mystic_aura': { name: 'Mystic Aura', isSpecialAbility: true },
        '/abilities/frenzy': { name: 'Frenzy', isSpecialAbility: false },
    },
    levelExperienceTable: Array.from({ length: 201 }, (_, i) => i * 10),
};
const ZONE = { zoneHrid: '/actions/combat/fly', difficultyTier: 0, isDungeon: false, name: 'Fly' };

describe('a live melee smash export as a party member', () => {
    mocks.clientData = itemSheet();

    test('the import accepts it whole: levels, gear by canonical slot, consumables, abilities and triggers', () => {
        const result = parseShykaiImport(exportText);
        expect(result.skipped).toEqual([]);
        const dto = result.players[0];
        expect(dto).toMatchObject({ attackLevel: 135, meleeLevel: 136, defenseLevel: 125, magicLevel: 112 });
        expect(Object.keys(dto.equipment)).toHaveLength(14);
        expect(dto.equipment['/equipment_types/main_hand']).toEqual({
            hrid: '/items/chaotic_flail_refined',
            enhancementLevel: 10,
        });
        expect(dto.abilities.map((a) => [a.hrid.split('/').pop(), a.level])).toEqual([
            ['fierce_aura', 50],
            ['frenzy', 62],
            ['berserk', 64],
            ['fracturing_impact', 86],
            ['sweep', 81],
        ]);
        expect(dto.abilities[4].triggers).toEqual(exported.triggerMap['/abilities/sweep']);
        expect(dto.food[2].triggers[0].value).toBe(350);
        expect(validateTeammateDTO(dto)).toEqual({ ok: true });
    });

    test('it round-trips through export, the roster and sanitizing without losing a slot', async () => {
        const dto = parseShykaiImport(exportText).players[0];
        const again = parseShykaiImport(JSON.stringify(buildShykaiExportPlayer(dto, 'x'))).players[0];
        expect(again.equipment).toEqual(dto.equipment);
        const result = await addTeammates([{ name: 'Smasher', dto, source: 'editor', gameMode: 'standard' }]);
        expect(result.ok).toBe(true);
        const stored = (await loadRoster()).entries.find((e) => e.name === 'Smasher');
        const clean = sanitizeTeammateDTO(stored.dto);
        expect(clean.abilities).toHaveLength(5);
        expect(clean.abilities[3].level).toBe(86);
        expect(Object.keys(clean.equipment)).toHaveLength(14);
    });

    test('in a party it keeps its own levels beside templates, an aura swaps only slot 0 and others stay', () => {
        const member = parseShykaiImport(exportText).players[0];
        const template = PARTY_TEMPLATES.find((t) => t.id === 'melee-smash');
        const roster = [
            { id: 'a', name: 'Live', dto: member, auras: [{ hrid: '/abilities/mystic_aura', level: 60 }] },
            { id: 'b', name: 'Tpl', dto: structuredClone(template.playerDto) },
        ];
        const plan = planSweep({ zones: [ZONE], roster, gameData, selfMode: 'market' });
        // Live as built and with Mystic Aura, Tpl: solo, 2 + 1 singles, 2 pairs
        expect(plan.total).toBe(1 + 3 + 2);
        const withAura = plan.tasks.find((t) => t.comp.members.some((m) => m.aura?.hrid === '/abilities/mystic_aura'));
        const party = buildCompositionParty(member, withAura.comp.members.slice(0, 1));
        expect(party[1].meleeLevel).toBe(136);
        expect(party[1].abilities[0]).toMatchObject({ hrid: '/abilities/mystic_aura', level: 60, triggers: null });
        expect(party[1].abilities.slice(1)).toEqual(member.abilities.slice(1));
        expect(applyAura(member, { hrid: '/abilities/fierce_aura', level: 50 }).replaced).toBeNull();
    });
});
