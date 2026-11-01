import { describe, test, expect } from 'vitest';
import { buildSkillsUpdated } from './skills-updated.js';
import { buildActionCompleted } from './action-completed.js';
import { buildQuestDiscarded } from './quests-updated.js';
import { buildCollectionsUpdated } from './collections-updated.js';
import { buildCharacterAction } from './character-actions.js';
import { buildGuildMember } from './guild-members.js';
import {
    buildCharacterInfo,
    buildLabyrinthSkipSettings,
    ABILITY_SLOTS_LEVEL_REQUIREMENT_LIST,
    LABYRINTH_ACTION,
} from './character-info.js';

/**
 * Provenance: every shape here was captured live on the TEST server (never the live site)
 * on 2026-10-31 / 2026-11-01 from MillenniumTest, MillenniumIC2 and MillenniumIC3. Ids and
 * names are synthetic. The assertions pin the field names so a casual edit cannot rename them.
 */
describe('wire fixtures keep the captured field names', () => {
    test('skills_updated carries endCharacterSkills, not characterSkills', () => {
        const m = buildSkillsUpdated();
        expect(m).toHaveProperty('endCharacterSkills');
        expect(m).toHaveProperty('endCharacterAbilities');
        expect(m).not.toHaveProperty('characterSkills');
        expect(m.endCharacterSkills.map((s) => s.skillHrid)).toContain('/skills/total_level');
    });

    test('action_completed carries the end* family', () => {
        expect(Object.keys(buildActionCompleted())).toEqual(
            expect.arrayContaining([
                'endCharacterAction',
                'endCharacterItems',
                'endCharacterAbilities',
                'endCharacterSkills',
                'endCharacterQuests',
            ])
        );
    });

    test('a discarded task keeps its id and changes status', () => {
        const [q] = buildQuestDiscarded().endCharacterQuests;
        expect(q.status).toBe('/quest_status/discarded');
        expect(q).toHaveProperty('id');
        expect(q).toHaveProperty('actionHrid');
    });

    test('collections_updated is a list of rows keyed by itemHrid', () => {
        const [row] = buildCollectionsUpdated().collections;
        expect(Object.keys(row)).toEqual(['characterID', 'itemHrid', 'count', 'enhancementData']);
    });

    test('a characterActions entry has the full captured key set', () => {
        expect(Object.keys(buildCharacterAction()).sort()).toEqual(
            [
                'id',
                'characterID',
                'partyID',
                'actionHrid',
                'difficultyTier',
                'hasMaxCount',
                'maxCount',
                'currentCount',
                'wave',
                'primaryItemHash',
                'secondaryItemHash',
                'enhancingMaxLevel',
                'characterLoadoutID',
                'ordinal',
                'isDone',
                'createdAt',
                'updatedAt',
            ].sort()
        );
        expect(buildCharacterAction().characterLoadoutID).toBe(0);
    });

    test('guild members carry both sign-up hrids and the week stamp', () => {
        const m = buildGuildMember();
        expect(m).toHaveProperty('signedUpCombatTrialHrid');
        expect(m).toHaveProperty('signedUpSkillingTrialHrid');
        expect(m).toHaveProperty('signupWeekStartAt');
    });

    test('client and character pieces', () => {
        expect(buildCharacterInfo()).toHaveProperty('offlineHourCap');
        expect(buildLabyrinthSkipSettings()).toEqual({
            labyrinthSkipMilking: 100,
            labyrinthSkipImp: 100,
            labyrinthSkipGiantShoeBird: 100,
        });
        expect(ABILITY_SLOTS_LEVEL_REQUIREMENT_LIST).toEqual([0, 1, 1, 20, 50, 90]);
        expect(LABYRINTH_ACTION).toEqual({ hrid: '/actions/labyrinth/explore', typeHrid: '/action_types/labyrinth' });
    });
});
