import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PARTY_TEMPLATES, TEMPLATE_ROLE_GROUPS, templatesForGroup, templateTeammateName } from './party-templates.js';
import { validateTeammateDTO, sanitizeTeammateDTO } from './party-roster.js';

describe('party templates', () => {
    test('there are 8 with unique ids', () => {
        expect(PARTY_TEMPLATES).toHaveLength(8);
        expect(new Set(PARTY_TEMPLATES.map((t) => t.id)).size).toBe(8);
    });

    test.each(PARTY_TEMPLATES.map((t) => [t.id, t]))('%s passes validateTeammateDTO and sanitizes whole', (_id, t) => {
        expect(validateTeammateDTO(t.playerDto)).toEqual({ ok: true });
        const clean = sanitizeTeammateDTO(t.playerDto);
        expect(clean.food).toHaveLength(3);
        expect(clean.drinks).toHaveLength(3);
        expect(clean.abilities).toHaveLength(5);
        expect(t.label).toBeTruthy();
        expect(t).not.toHaveProperty('source');
        // Equipment is keyed by full hrid
        for (const key of Object.keys(t.playerDto.equipment)) expect(key).toMatch(/^\/equipment_types\//);
        // No game mode: fits either party
        expect(t.playerDto.gameMode).toBeUndefined();
    });

    const ENDGAME_FILES = {
        'melee-smash': 'melee-smash',
        'melee-spear': 'melee-spear',
        'melee-slash': 'melee-slash',
        'ranged-cursed-bow': 'ranged-cursed-bow',
        'magic-nature': 'magic-nature',
        'magic-fire': 'magic-fire',
        'magic-water': 'magic-water',
        'tank-bulwark': 'tank-bulwark',
    };

    test('every endgame template keeps its anonymized live export: items, consumables, abilities, triggers, rooms, shrines', () => {
        const endgame = PARTY_TEMPLATES;
        expect(endgame.map((t) => t.id).sort()).toEqual(Object.keys(ENDGAME_FILES).sort());
        for (const t of endgame) {
            const file = new URL('./__fixtures__/endgame/' + ENDGAME_FILES[t.id] + '.json', import.meta.url);
            const j = JSON.parse(readFileSync(file, 'utf8'));
            const d = t.playerDto;
            const trig = (hrid) => (Array.isArray(j.triggerMap?.[hrid]) ? j.triggerMap[hrid] : null);
            expect(Object.keys(d.equipment).length, t.id).toBe(j.player.equipment.length);
            for (const e of j.player.equipment) {
                const key = e.itemLocationHrid.replace('/item_locations/', '/equipment_types/');
                expect(d.equipment[key]?.hrid, t.id + ' ' + key).toBe(e.itemHrid);
            }
            const consumables = (list, rows) =>
                expect(list.map((x) => x && [x.hrid, x.triggers])).toEqual(
                    rows.map((r) => r.itemHrid && [r.itemHrid, trig(r.itemHrid)])
                );
            consumables(d.food, j.food['/action_types/combat']);
            consumables(d.drinks, j.drinks['/action_types/combat']);
            expect(d.abilities.map((a) => a && [a.hrid, a.triggers])).toEqual(
                j.abilities.map((a) => [a.abilityHrid, trig(a.abilityHrid)])
            );
            expect(d.houseRooms).toEqual(j.houseRooms);
            expect(t.guildCombatBuffLevels).toEqual(j.guildCombatBuffLevels);
        }
    });

    test('every endgame template is standardized: main stat 150, others 125, abilities 75, gear by slot', () => {
        const MAIN = {
            melee_stab: 'melee',
            melee_slash: 'melee',
            melee_smash: 'melee',
            ranged: 'ranged',
            nature_mage: 'magic',
            fire_mage: 'magic',
            water_mage: 'magic',
            tank: 'defense',
        };
        const ENH = {
            main_hand: 12,
            two_hand: 12,
            off_hand: 10,
            head: 10,
            body: 10,
            legs: 10,
            feet: 10,
            hands: 10,
            earrings: 7,
            ring: 7,
            neck: 5,
            charm: 5,
            pouch: 5,
            back: 5,
            trinket: 5,
        };
        for (const t of PARTY_TEMPLATES) {
            for (const k of ['stamina', 'intelligence', 'attack', 'melee', 'defense', 'ranged', 'magic']) {
                expect(t.playerDto[k + 'Level'], t.id + ' ' + k).toBe(k === MAIN[t.role] ? 150 : 125);
            }
            for (const a of t.playerDto.abilities) expect(a.level, t.id + ' ' + a.hrid).toBe(75);
            for (const [key, item] of Object.entries(t.playerDto.equipment)) {
                const slot = key.replace('/equipment_types/', '');
                expect(item.enhancementLevel, t.id + ' ' + slot).toBe(ENH[slot]);
            }
        }
    });

    test('no template carries a player name', () => {
        for (const t of PARTY_TEMPLATES) {
            expect(JSON.stringify([t.id, t.label])).not.toMatch(/Millennium|lab loadout|bWarkb/i);
        }
    });

    test('the list is frozen all the way down, so a copy cannot leak back', () => {
        expect(Object.isFrozen(PARTY_TEMPLATES)).toBe(true);
        expect(Object.isFrozen(PARTY_TEMPLATES[0].playerDto.equipment)).toBe(true);
        const clean = sanitizeTeammateDTO(PARTY_TEMPLATES[0].playerDto);
        clean.equipment = {};
        expect(Object.keys(PARTY_TEMPLATES[0].playerDto.equipment).length).toBeGreaterThan(0);
    });

    test('every template falls in exactly one role group', () => {
        const seen = TEMPLATE_ROLE_GROUPS.flatMap((g) => templatesForGroup(g).map((t) => t.id));
        expect(seen.sort()).toEqual(PARTY_TEMPLATES.map((t) => t.id).sort());
    });

    test('teammate names fit the roster, drop the source tag and never end mid-punctuation', () => {
        for (const t of PARTY_TEMPLATES) {
            const name = templateTeammateName(t);
            expect(name.length).toBeGreaterThan(0);
            expect(name.length).toBeLessThanOrEqual(40);
            expect(name).not.toContain('[');
            expect(name).not.toMatch(/[\s,;:(]$/);
        }
        expect(templateTeammateName({ label: 'Tank (Bulwark) [live export]' })).toBe('Tank (Bulwark)');
    });
});
