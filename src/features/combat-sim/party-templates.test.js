import { describe, test, expect } from 'vitest';
import { PARTY_TEMPLATES, TEMPLATE_ROLE_GROUPS, templatesForGroup, templateTeammateName } from './party-templates.js';
import { validateTeammateDTO, sanitizeTeammateDTO } from './party-roster.js';

describe('party templates', () => {
    test('there are 19 with unique ids', () => {
        expect(PARTY_TEMPLATES).toHaveLength(19);
        expect(new Set(PARTY_TEMPLATES.map((t) => t.id)).size).toBe(19);
    });

    test.each(PARTY_TEMPLATES.map((t) => [t.id, t]))('%s passes validateTeammateDTO and sanitizes whole', (_id, t) => {
        expect(validateTeammateDTO(t.playerDto)).toEqual({ ok: true });
        const clean = sanitizeTeammateDTO(t.playerDto);
        expect(clean.food).toHaveLength(3);
        expect(clean.drinks).toHaveLength(3);
        expect(clean.abilities).toHaveLength(5);
        expect(t.label && t.source && t.tier).toBeTruthy();
        // Equipment is keyed by full hrid
        for (const key of Object.keys(t.playerDto.equipment)) expect(key).toMatch(/^\/equipment_types\//);
        // No game mode: fits either party
        expect(t.playerDto.gameMode).toBeUndefined();
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
        expect(templateTeammateName({ label: 'Tank (Wark), endgame [MillenniumTest lab loadout]' })).toBe(
            'Tank (Wark), endgame'
        );
    });
});
