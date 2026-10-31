import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 'c1', getCurrentCharacterGameMode: () => 'standard' },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => null } }));
vi.mock('../profile/score-calculator.js', () => ({ calculateCombatScore: async () => ({ equipment: 1, ability: 1 }) }));
const stamp = vi.hoisted(() => ({ value: 'a|1' }));
vi.mock('../profile/build-score-row.js', () => ({
    ensureOwnScore: async () => null,
    scorePricingStamp: () => stamp.value,
}));

const {
    OFFSET_MIN,
    OFFSET_MAX,
    mainStatKey,
    matchCombatLevels,
    applyOffset,
    profileDataFor,
    comparableScore,
    solveOffset,
    tuneTemplate,
    clearTunerCache,
    liveDeps,
} = await import('./party-template-tuner.js');
const { PARTY_TEMPLATES } = await import('./party-templates.js');

const smash = PARTY_TEMPLATES.find((t) => t.id === 'melee-smash');
const nature = PARTY_TEMPLATES.find((t) => t.id === 'magic-nature');

/** A live-typical character: melee 136, a low magic */
const LEVELS = {
    staminaLevel: 125,
    intelligenceLevel: 115,
    attackLevel: 135,
    meleeLevel: 136,
    defenseLevel: 125,
    rangedLevel: 114,
    magicLevel: 112,
};

/** A strictly rising score in k, as the real one is: 100 per step */
const linear = (k) => 1000 + 100 * (k - OFFSET_MIN);

describe('combat levels follow the character, the main stat its best style', () => {
    test('a melee template takes the character stats, melee its highest style stat', () => {
        const dto = matchCombatLevels(smash.playerDto, smash.role, { ...LEVELS, defenseLevel: 140 });
        expect(dto).toMatchObject({
            staminaLevel: 125,
            intelligenceLevel: 115,
            attackLevel: 135,
            defenseLevel: 140,
            rangedLevel: 114,
            magicLevel: 112,
            meleeLevel: 140,
        });
    });

    test('a nature template on a melee player is not left with their low magic', () => {
        const dto = matchCombatLevels(nature.playerDto, nature.role, LEVELS);
        expect(dto.magicLevel).toBe(136);
        expect(dto.meleeLevel).toBe(136);
        expect(dto.rangedLevel).toBe(114);
    });

    test('main stat by role, and the template itself is not changed', () => {
        expect(mainStatKey('tank')).toBe('defenseLevel');
        expect(mainStatKey('ranged')).toBe('rangedLevel');
        expect(mainStatKey('fire_mage')).toBe('magicLevel');
        expect(mainStatKey('melee_slash')).toBe('meleeLevel');
        const before = JSON.stringify(smash.playerDto);
        matchCombatLevels(smash.playerDto, smash.role, LEVELS);
        expect(JSON.stringify(smash.playerDto)).toBe(before);
    });

    test('missing levels read as 1', () => {
        const dto = matchCombatLevels(smash.playerDto, smash.role, {});
        expect(dto.meleeLevel).toBe(1);
        expect(dto.staminaLevel).toBe(1);
    });
});

describe('the offset', () => {
    test('moves weapons and armor by k, the rest by half, abilities by 5, inside the clamps', () => {
        const up = applyOffset(smash.playerDto, 4);
        expect(up.equipment['/equipment_types/main_hand'].enhancementLevel).toBe(16);
        expect(up.equipment['/equipment_types/body'].enhancementLevel).toBe(14);
        expect(up.equipment['/equipment_types/ring'].enhancementLevel).toBe(9);
        expect(up.abilities[0].level).toBe(95);
        const top = applyOffset(smash.playerDto, OFFSET_MAX);
        expect(top.equipment['/equipment_types/main_hand'].enhancementLevel).toBe(20);
        expect(top.abilities[0].level).toBe(150);
        const bottom = applyOffset(smash.playerDto, OFFSET_MIN);
        expect(bottom.equipment['/equipment_types/main_hand'].enhancementLevel).toBe(0);
        expect(bottom.abilities[0].level).toBe(1);
        expect(applyOffset(smash.playerDto, 0)).toEqual(smash.playerDto);
    });

    test('the score profile uses item locations and carries no house or shrines', () => {
        const { profile } = profileDataFor(smash.playerDto);
        expect(Object.keys(profile.wearableItemMap)[0]).toMatch(/^\/item_locations\//);
        expect(profile.equippedAbilities).toHaveLength(5);
        expect(profile.characterHouseRoomMap).toEqual({});
        expect(profile.characterGuildBuffMap).toBeUndefined();
    });

    test('only equipment plus abilities is compared; nothing priced is no figure', () => {
        expect(comparableScore({ equipment: 10, ability: 5, house: 99, guildShrineCombat: 99 })).toBe(15);
        expect(comparableScore({ equipment: 0, ability: 0 })).toBeNull();
        expect(comparableScore(null)).toBeNull();
    });
});

describe('solveOffset', () => {
    const solve = (target, extra = {}) => solveOffset({ scoreAt: async (k) => linear(k), target, ...extra });

    test.each([-3, 0, 7, 14])('hits the offset %i exactly when the target is on a step', async (k) => {
        const result = await solve(linear(k));
        expect(result).toMatchObject({ status: 'ok', k });
    });

    test('lands within one step of an off-step target, on the closer side', async () => {
        const result = await solve(linear(5) + 30);
        expect(result.k).toBe(5);
        const near = await solve(linear(5) + 70);
        expect(near.k).toBe(6);
    });

    test('stays inside the evaluation cap', async () => {
        const result = await solve(linear(9) + 10);
        expect(result.evals).toBeLessThanOrEqual(15);
    });

    test('finds the exact offset when the score is not monotonic (one expensive listing above the target)', async () => {
        // A binary search probes 0, then 7: the 9999 at 7 reads as "too high" and it never looks at 8
        const spiky = async (k) => (k === 7 ? 9999 : linear(k));
        const result = await solveOffset({ scoreAt: spiky, target: linear(8) });
        expect(result).toMatchObject({ status: 'ok', k: 8, score: linear(8) });
        expect(result.evals).toBeLessThanOrEqual(15);
    });

    test('a target below the lowest reachable clamps low, above the highest clamps high', async () => {
        expect(await solve(10)).toMatchObject({ status: 'clampedLow', k: OFFSET_MIN });
        expect(await solve(1e9)).toMatchObject({ status: 'clampedHigh', k: OFFSET_MAX });
    });

    test('an unscorable build fails; a character switch aborts', async () => {
        expect((await solveOffset({ scoreAt: async () => null, target: 5000 })).status).toBe('failed');
        let current = true;
        const result = await solveOffset({
            scoreAt: async (k) => {
                current = false;
                return linear(k);
            },
            target: 5000,
            stillCurrent: () => current,
        });
        expect(result.status).toBe('aborted');
    });
});

describe('tuneTemplate', () => {
    beforeEach(() => clearTunerCache());

    const world = (over = {}) => {
        const state = {
            id: 'c1',
            score: { total: 9999, equipment: 1900, ability: 0 },
            mode: 'standard',
            calls: 0,
            ...over,
        };
        return {
            state,
            deps: {
                getCharacterId: () => state.id,
                getOwnScore: () => state.score,
                getPricingKey: () => state.mode,
                // The template's score: 1000 plus 100 per weapon enhancement level
                scoreProfile: async (profileData) => {
                    state.calls += 1;
                    const weapon = profileData.profile.wearableItemMap['/item_locations/main_hand'].enhancementLevel;
                    return { equipment: 1000 + 100 * weapon, ability: 0 };
                },
            },
        };
    };

    test('solves the offset that matches the character and tunes levels, gear and abilities together', async () => {
        const { deps } = world();
        const result = await tuneTemplate(smash, LEVELS, deps);
        // Weapon base +12, so 12 + k = 9 scores 1900
        expect(result).toMatchObject({ status: 'ok', ownScore: 1900, templateScore: 1900, k: -3, cached: false });
        expect(result.dto.equipment['/equipment_types/main_hand'].enhancementLevel).toBe(9);
        expect(result.dto.abilities[0].level).toBe(60);
        expect(result.dto.meleeLevel).toBe(136);
    });

    test('is cached per template, character score stamp and pricing mode', async () => {
        const { deps, state } = world();
        await tuneTemplate(smash, LEVELS, deps);
        const first = state.calls;
        const again = await tuneTemplate(smash, LEVELS, deps);
        expect(again.cached).toBe(true);
        expect(state.calls).toBe(first);
        // Another score stamp, another pricing mode, another character, another template: each solves afresh
        state.score = { total: 9999, equipment: 2300, ability: 0 };
        expect((await tuneTemplate(smash, LEVELS, deps)).cached).toBe(false);
        state.mode = 'ironcow';
        expect((await tuneTemplate(smash, LEVELS, deps)).cached).toBe(false);
        state.id = 'c2';
        expect((await tuneTemplate(smash, LEVELS, deps)).cached).toBe(false);
        expect((await tuneTemplate(nature, LEVELS, deps)).cached).toBe(false);
    });

    test('no score loaded: the standard template with matched levels, and says so', async () => {
        const { deps, state } = world({ score: null });
        const result = await tuneTemplate(smash, LEVELS, deps);
        expect(result.status).toBe('noScore');
        expect(state.calls).toBe(0);
        expect(result.dto.equipment).toEqual(smash.playerDto.equipment);
        expect(result.dto.abilities).toEqual(smash.playerDto.abilities);
        expect(result.dto.meleeLevel).toBe(136);
    });

    test('unpriced gear in the template score or in the character score is never reported as a match', async () => {
        const a = world();
        const inner = a.deps.scoreProfile;
        a.deps.scoreProfile = async (p) => ({ ...(await inner(p)), equipmentUnpriced: 1 });
        const templateSide = await tuneTemplate(smash, LEVELS, a.deps);
        expect(templateSide.status).toBe('partial');
        expect(templateSide.k).toBe(-3);
        clearTunerCache();
        const b = world({ score: { total: 1, equipment: 1900, ability: 0, equipmentUnpriced: 2 } });
        expect((await tuneTemplate(smash, LEVELS, b.deps)).status).toBe('partial');
        // A cached answer keeps its partial status
        expect((await tuneTemplate(smash, LEVELS, b.deps)).status).toBe('partial');
    });

    test('every scoring yields to the browser first, and progress is reported from the wait through each probe', async () => {
        const { deps } = world();
        let yields = 0;
        deps.yieldToBrowser = async () => {
            yields += 1;
        };
        const events = [];
        const result = await tuneTemplate(smash, LEVELS, deps, { onProgress: (p) => events.push(p) });
        expect(result.status).toBe('ok');
        expect(events[0]).toEqual({ phase: 'score', done: 0, max: 15 });
        const solves = events.filter((p) => p.phase === 'solve');
        expect(solves.map((p) => p.done)).toEqual(solves.map((_, i) => i + 1));
        expect(solves.length).toBeGreaterThan(10);
        expect(solves.length).toBeLessThanOrEqual(15);
        expect(yields).toBe(solves.length);
    });

    test('an unpriced ability book is an unpriced score too, in the template or the character', async () => {
        const a = world();
        const inner = a.deps.scoreProfile;
        a.deps.scoreProfile = async (p) => ({ ...(await inner(p)), breakdown: { abilities: [{ unpriced: true }] } });
        expect((await tuneTemplate(smash, LEVELS, a.deps)).status).toBe('partial');
        clearTunerCache();
        const b = world({
            score: { total: 1, equipment: 1900, ability: 0, breakdown: { abilities: [{ unpriced: true }] } },
        });
        expect((await tuneTemplate(smash, LEVELS, b.deps)).status).toBe('partial');
        clearTunerCache();
        const c = world({
            score: { total: 1, equipment: 1900, ability: 0, breakdown: { abilities: [{ unpriced: false }] } },
        });
        expect((await tuneTemplate(smash, LEVELS, c.deps)).status).toBe('ok');
    });

    test('a character below the lowest or above the highest reachable score is clamped', async () => {
        const low = await tuneTemplate(smash, LEVELS, world({ score: { equipment: 5, ability: 0 } }).deps);
        expect(low).toMatchObject({ status: 'clampedLow', k: OFFSET_MIN });
        clearTunerCache();
        const high = await tuneTemplate(smash, LEVELS, world({ score: { equipment: 1e7, ability: 0 } }).deps);
        expect(high.status).toBe('clampedHigh');
    });

    test('a clamp is reported beside unpriced gear, not hidden by it, and a cached answer keeps both', async () => {
        const unpriced = (w) => {
            const inner = w.deps.scoreProfile;
            w.deps.scoreProfile = async (p) => ({ ...(await inner(p)), equipmentUnpriced: 1 });
            return w;
        };
        const low = await tuneTemplate(smash, LEVELS, unpriced(world({ score: { equipment: 5, ability: 0 } })).deps);
        expect(low).toMatchObject({ status: 'partial', clamp: 'clampedLow', k: OFFSET_MIN });
        const high = unpriced(world({ score: { equipment: 1e7, ability: 0 } }));
        clearTunerCache();
        expect(await tuneTemplate(smash, LEVELS, high.deps)).toMatchObject({ status: 'partial', clamp: 'clampedHigh' });
        expect(await tuneTemplate(smash, LEVELS, high.deps)).toMatchObject({ status: 'partial', clamp: 'clampedHigh' });
        // Priced and reachable: neither
        clearTunerCache();
        expect(await tuneTemplate(smash, LEVELS, world().deps)).toMatchObject({ status: 'ok', clamp: null });
    });

    test('a character switch while scoring gives the standard template, and nothing is cached', async () => {
        const { deps, state } = world();
        const inner = deps.scoreProfile;
        deps.scoreProfile = async (p) => {
            const r = await inner(p);
            state.id = 'c2';
            return r;
        };
        const result = await tuneTemplate(smash, LEVELS, deps);
        expect(result.status).toBe('aborted');
        expect(result.dto.equipment).toEqual(smash.playerDto.equipment);
        state.id = 'c1';
        deps.scoreProfile = inner;
        expect((await tuneTemplate(smash, LEVELS, deps)).cached).toBe(false);
    });
});

describe('the live pricing key', () => {
    test('moves with the pricing stamp, so a price or pricing setting change does not reuse a solved offset', () => {
        const deps = liveDeps();
        stamp.value = 'a|1';
        const before = deps.getPricingKey();
        stamp.value = 'a|2';
        expect(deps.getPricingKey()).not.toBe(before);
        stamp.value = 'b|1';
        expect(deps.getPricingKey()).not.toBe(before);
        stamp.value = 'a|1';
        expect(deps.getPricingKey()).toBe(before);
    });
});
