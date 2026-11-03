import { describe, test, expect } from 'vitest';
import { buildSkillsUpdated } from './skills-updated.js';
import { buildActionCompleted } from './action-completed.js';
import { buildQuestDiscarded } from './quests-updated.js';
import { buildCollectionsUpdated } from './collections-updated.js';
import { buildCombatActionCompleted } from './action-completed-combat.js';
import { buildNewBattle } from './new-battle.js';
import { buildBattleUpdated, BATTLE_UPDATED_SHAPES } from './battle-updated.js';
import { buildBattleConsumableAbilityUpdated } from './battle-consumable-ability-updated.js';
import { buildItemsUpdated } from './items-updated.js';
import { buildListingPlaced, buildListingCancelled, buildOrderBooksUpdated } from './market.js';
import { buildCharacterAction } from './character-actions.js';
import { buildGuildMember, buildSignedUpGuildMember } from './guild-members.js';
import {
    buildEndGuildBattle,
    buildGuildBattleUpdated,
    buildGuildTrialStatsUpdated,
    buildGuildUpdated,
    buildNewGuildBattle,
    FIXTURE_GUILD_ID,
} from './guild-trial.js';
import {
    buildLabyrinthUpdated,
    buildLabyrinthRoomProgress,
    buildLabyrinthNewBattle,
    buildInfoNotices,
    LABYRINTH_UPDATED_NAMES,
} from './labyrinth.js';
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

    test('a combat action_completed carries null quests and full database rows', () => {
        const m = buildCombatActionCompleted();
        expect(m.endCharacterQuests).toBeNull();
        expect(m.endCharacterAction.characterLoadoutID).not.toBe(0);
        expect(m.endCharacterSkills[0]).toHaveProperty('offlineExperience');
        expect(m.endCharacterAbilities[0]).toHaveProperty('slotNumber');
    });

    test('new_battle lists players and monsters whole', () => {
        const m = buildNewBattle();
        expect(Object.keys(m).sort()).toEqual(
            ['battleId', 'combatStartTime', 'monsters', 'players', 'type', 'wave'].sort()
        );
        const [player] = m.players;
        // The kit, consumables, buffs and loot sit on the unit itself; combatDetails holds only stats.
        expect(player.combatAbilities.length).toBeGreaterThan(0);
        expect(player.combatDetails).not.toHaveProperty('combatAbilities');
        expect(player.combatDetails).toHaveProperty('combatStats');
        expect(Object.keys(player.combatBuffMap)[0]).toMatch(/^\/buff_uniques\//);
        expect(Object.keys(player.totalLootMap)[0]).toContain(String(player.character.id));
        expect(m.monsters.length).toBeGreaterThan(1);
        // Monsters carry a zeroed character block and null player-only maps.
        expect(m.monsters[0].character.id).toBe(0);
        expect(m.monsters[0].combatConsumables).toBeNull();
        expect(m.monsters[0].totalLootMap).toBeNull();
    });

    test('battle_updated is a delta keyed by unit index, and an empty mMap is real', () => {
        for (let i = 0; i < BATTLE_UPDATED_SHAPES; i++) {
            const m = buildBattleUpdated(i);
            expect(m.battleId).toBe(buildNewBattle().battleId);
            expect(Object.keys(m.pMap)).toEqual(['0']);
            expect(m.pMap[0]).toEqual(expect.objectContaining({ cHP: expect.any(Number), cMP: expect.any(Number) }));
        }
        expect(buildBattleUpdated(1).mMap).toEqual({});
        expect(Object.keys(buildBattleUpdated(0).mMap)).toEqual(['2']);
    });

    test('battle_consumable_ability_updated carries an ability object, not a bare hrid', () => {
        const { ability } = buildBattleConsumableAbilityUpdated();
        expect(Object.keys(ability).sort()).toEqual(['abilityHrid', 'availableTime', 'experience', 'level']);
    });

    test('items_updated rows are whole inventory rows', () => {
        const [row] = buildItemsUpdated().endCharacterItems;
        expect(Object.keys(row).sort()).toEqual(
            [
                'id',
                'characterID',
                'itemLocationHrid',
                'itemHrid',
                'enhancementLevel',
                'count',
                'offlineCount',
                'hash',
                'createdAt',
                'updatedAt',
            ].sort()
        );
    });

    test('a listing is placed and cancelled with different timestamp precision', () => {
        const [placed] = buildListingPlaced().endMarketListings;
        const [cancelled] = buildListingCancelled().endMarketListings;
        expect(placed.status).toBe('/market_listing_status/active');
        expect(cancelled.status).toBe('/market_listing_status/cancelled');
        expect(placed).toHaveProperty('characterID');
        expect(placed.id).toBe(cancelled.id);
        expect(placed.createdTimestamp).toMatch(/\.\d{9}Z$/);
        expect(cancelled.createdTimestamp).toMatch(/\.\d{2}Z$/);
    });

    test('an order book is arrays indexed by enhancement level, and bids may be empty', () => {
        const { marketItemOrderBooks: b } = buildOrderBooksUpdated();
        expect(Object.keys(b).sort()).toEqual(
            ['itemHrid', 'marketValues', 'orderBooks', 'priceBandMaxs', 'priceBandMins'].sort()
        );
        expect(Object.keys(b.orderBooks[0].asks[0]).sort()).toEqual(['listingId', 'price', 'quantity']);
        expect(b.orderBooks[0].bids).toEqual([]);
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
        // Role is a bare word, loadout ids are numbers with 0 for none, prefs are JSON strings
        expect(m.signedUpCombatRoleHrid).toBe('');
        expect(m.signedUpCombatLoadoutID).toBe(0);
        const full = buildSignedUpGuildMember();
        expect(['damage_dealer', 'support', 'tank']).toContain(full.signedUpCombatRoleHrid);
        expect(typeof full.trialRolePrefs).toBe('string');
        expect(JSON.parse(full.trialLoadoutPrefs)['/guild_combat/swarm']).toBe(full.signedUpCombatLoadoutID);
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

    test('labyrinth_updated keeps supplies as flat Item/Count pairs and strings for path and loot', () => {
        for (const name of LABYRINTH_UPDATED_NAMES) {
            const l = buildLabyrinthUpdated(name).labyrinth;
            expect(l.beaconItemHrid).toBe('/items/expert_beacon');
            expect(typeof l.beaconCount).toBe('number');
            expect(typeof l.torchCount).toBe('number');
            expect(typeof l.shroudCount).toBe('number');
            expect(typeof l.pathData).toBe('string');
            expect(typeof l.lootedItemsData).toBe('string');
            expect(l).not.toHaveProperty('supplies');
        }
    });

    test('labyrinth_updated rooms: null until revealed, a cleared room loses its type, the exit has no grid', () => {
        const { roomData } = buildLabyrinthUpdated('beaconReveal').labyrinth;
        const cells = roomData.flat();
        expect(cells).toContain(null);
        expect(cells.find((c) => c?.isCleared)).toEqual({ roomType: '', recommendedLevel: 0, isCleared: true });
        expect(cells.find((c) => c?.monsterHrid)).toHaveProperty('roomType', '/labyrinth_room_types/combat');
        const exit = buildLabyrinthUpdated('exit').labyrinth;
        expect(exit.isActive).toBe(false);
        expect(exit.roomData).toEqual([]);
        expect(exit.beaconCount).toBe(0);
    });

    test('a room clear can reveal rooms without spending a beacon; a beacon spends one', () => {
        const shown = (name) =>
            buildLabyrinthUpdated(name)
                .labyrinth.roomData.flat()
                .filter((c) => c).length;
        const entry = buildLabyrinthUpdated('entry').labyrinth;
        const clear = buildLabyrinthUpdated('roomClearReveal').labyrinth;
        expect(shown('roomClearReveal') - shown('entry')).toBeGreaterThanOrEqual(2);
        expect(clear.beaconCount).toBe(entry.beaconCount);
        expect(buildLabyrinthUpdated('beaconReveal').labyrinth.beaconCount).toBe(
            buildLabyrinthUpdated('torchSpent').labyrinth.beaconCount - 1
        );
    });

    test('labyrinth_room_progress is a flat progress record, a labyrinth new_battle is battle 1 wave 1', () => {
        const p = buildLabyrinthRoomProgress('last');
        expect(Object.keys(p)).toEqual(
            expect.arrayContaining(['currentProgress', 'successRate', 'progressPerAction', 'actionCounter'])
        );
        const b = buildLabyrinthNewBattle();
        expect([b.battleId, b.wave, b.monsters.length, b.monsters[0].isBoss]).toEqual([1, 1, 1, true]);
        for (const n of buildInfoNotices()) {
            expect(n).toEqual({ type: 'info', message: expect.stringMatching(/^infoNotification\./), variables: null });
        }
    });
});

/**
 * Provenance: a skilling then a combat guild trial on the TEST server, 2026-11-02. Nothing was measured on
 * the live server; the same shapes are assumed there.
 */
describe('guild trial wire fixtures keep the captured shapes', () => {
    test('guild_trial_stats_updated carries a numeric guildId and rows for every trial of the week', () => {
        const m = buildGuildTrialStatsUpdated();
        expect(Object.keys(m)).toEqual(['type', 'guildId', 'guildTrialStatList']);
        expect(typeof m.guildId).toBe('number');
        expect(m.guildId).toBe(FIXTURE_GUILD_ID);
        expect(m.guildTrialStatList).toHaveLength(170);
        for (const row of m.guildTrialStatList) {
            expect(Object.keys(row)).toEqual([
                'characterId',
                'trialHrid',
                'damageDealt',
                'healingDone',
                'premitigatedDamageTaken',
                'workDone',
            ]);
        }
        const hrids = new Set(m.guildTrialStatList.map((row) => row.trialHrid));
        expect([...hrids].filter((h) => h.startsWith('/guild_combat/')).sort()).toEqual([
            '/guild_combat/jellyfish',
            '/guild_combat/swarm',
        ]);
        // Combat rows carry no work, skilling rows no damage: one message, two kinds of row
        for (const row of m.guildTrialStatList) {
            if (row.trialHrid.startsWith('/guild_combat/')) expect(row.workDone).toBe(0);
            else expect(row.damageDealt).toBe(0);
        }
        // Both combat parties are in it, so it names people who were not in the fight you watched
        const combatIds = (hrid) =>
            new Set(m.guildTrialStatList.filter((row) => row.trialHrid === hrid).map((row) => row.characterId));
        expect(combatIds('/guild_combat/swarm').size).toBeGreaterThan(0);
        expect(combatIds('/guild_combat/jellyfish').size).toBeGreaterThan(0);
    });

    test('the stats builder can drop the guild id, keep chosen rows and swap the guild', () => {
        expect(buildGuildTrialStatsUpdated({ guildId: null })).not.toHaveProperty('guildId');
        expect(buildGuildTrialStatsUpdated({ guildId: 12 }).guildId).toBe(12);
        const swarm = buildGuildTrialStatsUpdated({ keep: (row) => row.trialHrid === '/guild_combat/swarm' });
        expect(swarm.guildTrialStatList.length).toBeGreaterThan(0);
        expect(swarm.guildTrialStatList.length).toBeLessThan(170);
    });

    test('new_guild_battle opens a tier with the roster, the boss and its pack', () => {
        const m = buildNewGuildBattle();
        expect(Object.keys(m)).toEqual(['type', 'combatStartTime', 'battleId', 'wave', 'tier', 'players', 'monsters']);
        expect([m.battleId, m.wave, m.tier]).toEqual([1, 1, 1]);
        expect(Object.keys(m.players[0])).toEqual([
            'isPlayer',
            'character',
            'hrid',
            'name',
            'currentHitpoints',
            'maxHitpoints',
            'currentManapoints',
            'maxManapoints',
            'isActive',
            'leftCombat',
            'difficultyTier',
        ]);
        expect(m.players[0].character).toHaveProperty('previousName');
        expect(m.players[0].character.id).toBe(900001);
        expect(m.players[0].character.name).toBe('FixtureCharacter');
        expect(m.monsters).toHaveLength(4);
        expect(m.monsters[0].isBoss).toBe(true);
        expect(m.monsters.map((monster) => monster.hrid)).toContain('/monsters/trial_beetle');
        // The monsters' character block is the game's zeroed placeholder
        expect(m.monsters[0].character.id).toBe(0);
    });

    test('the stats rows and the roster name the same synthetic people', () => {
        const roster = new Set(buildNewGuildBattle().players.map((p) => p.character.id));
        const swarm = buildGuildTrialStatsUpdated().guildTrialStatList.filter(
            (row) => row.trialHrid === '/guild_combat/swarm'
        );
        const named = swarm.filter((row) => roster.has(row.characterId));
        expect(named.length).toBe(roster.size);
        expect(Math.min(...swarm.map((row) => row.characterId))).toBe(900001);
    });

    test('end_guild_battle carries only the battle and the trial', () => {
        expect(buildEndGuildBattle()).toEqual({
            type: 'end_guild_battle',
            battleId: 1,
            trialHrid: '/guild_combat/swarm',
        });
    });

    test('guild_battle_updated: the opening tick has every slot, a late one is a delta with one monster', () => {
        const opening = buildGuildBattleUpdated('opening');
        expect(Object.keys(opening)).toEqual(['type', 'battleId', 'tier', 'pMap', 'mMap']);
        expect(opening.mMap).toEqual({});
        expect(Object.keys(opening.pMap['0'])).toEqual([
            'cHP',
            'mHP',
            'cMP',
            'mMP',
            'isActive',
            'leftCombat',
            'atkCounter',
            'abilityHrid',
            'int',
            'dmgCounter',
            'critCounter',
        ]);
        const late = buildGuildBattleUpdated('late');
        expect(late.tier).toBe(21);
        expect(Object.keys(late.mMap)).toHaveLength(1);
    });

    test('guild_updated carries the guild id and its trial status as a JSON string', () => {
        const m = buildGuildUpdated();
        expect(Object.keys(m)).toEqual([
            'type',
            'guild',
            'guildWeeklyTrialSet',
            'guildBuildingLevelMap',
            'guildTrialScheduleHourOffset',
        ]);
        expect(m.guild.id).toBe(FIXTURE_GUILD_ID);
        expect(m.guild.name).toBe('FixtureGuild');
        expect(typeof m.guild.currentTrialsData).toBe('string');
        const trials = JSON.parse(m.guild.currentTrialsData);
        expect(trials.combat.status).toBe('completed');
        expect(Object.keys(trials.combat.parties).sort()).toEqual(['/guild_combat/jellyfish', '/guild_combat/swarm']);
        expect(m.guildWeeklyTrialSet.combatHrids.sort()).toEqual(['/guild_combat/jellyfish', '/guild_combat/swarm']);
    });
});
