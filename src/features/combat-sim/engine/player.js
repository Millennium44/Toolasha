// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import Ability from './ability.js';
import CombatUnit from './combat-unit.js';
import Consumable from './consumable.js';
import Equipment from './equipment.js';
import HouseRoom from './house-room.js';
import { computeTalismanCombat } from './talisman-combat.js';
import { getGameData } from './game-data.js';

/**
 * Every combat stat that comes from worn equipment.
 *
 * Module scope because the list itself was being allocated on every call, and
 * the call happens on every fury stack change — which is most swings.
 */
const BELT_TYPE = '/equipment_types/belt';

const EQUIPMENT_STATS = [
    'stabAccuracy',
    'slashAccuracy',
    'smashAccuracy',
    'rangedAccuracy',
    'magicAccuracy',
    'stabDamage',
    'slashDamage',
    'smashDamage',
    'rangedDamage',
    'magicDamage',
    'defensiveDamage',
    'taskDamage',
    'physicalAmplify',
    'waterAmplify',
    'natureAmplify',
    'fireAmplify',
    'healingAmplify',
    'stabEvasion',
    'slashEvasion',
    'smashEvasion',
    'rangedEvasion',
    'magicEvasion',
    'armor',
    'waterResistance',
    'natureResistance',
    'fireResistance',
    'maxHitpoints',
    'maxManapoints',
    'lifeSteal',
    'hpRegenPer10',
    'mpRegenPer10',
    'physicalThorns',
    'elementalThorns',
    'combatDropRate',
    'combatRareFind',
    'combatDropQuantity',
    'combatExperience',
    'criticalRate',
    'criticalDamage',
    'armorPenetration',
    'waterPenetration',
    'naturePenetration',
    'firePenetration',
    'abilityHaste',
    'tenacity',
    'manaLeech',
    'castSpeed',
    'threat',
    'parry',
    'mayhem',
    'pierce',
    'curse',
    'fury',
    'weaken',
    'ripple',
    'bloom',
    'blaze',
    'attackSpeed',
    'foodHaste',
    'drinkConcentration',
    'autoAttackDamage',
    'abilityDamage',
    'staminaExperience',
    'intelligenceExperience',
    'attackExperience',
    'defenseExperience',
    'meleeExperience',
    'rangedExperience',
    'magicExperience',
    'retaliation',
    'maxHitpointsRatio',
    'maxManapointsRatio',
    // A belt's own stats: the server lists them in combatStats
    'talismanSlots',
    'talismanPower',
];

/** The stats a talisman line can feed: the gear stats, and damageTaken (kept apart, see CombatUnit) */
export const TALISMAN_MODELED_STATS = new Set([...EQUIPMENT_STATS, 'damageTaken']);

class Player extends CombatUnit {
    equipment = {
        '/equipment_types/head': null,
        '/equipment_types/body': null,
        '/equipment_types/legs': null,
        '/equipment_types/feet': null,
        '/equipment_types/hands': null,
        '/equipment_types/main_hand': null,
        '/equipment_types/two_hand': null,
        '/equipment_types/off_hand': null,
        '/equipment_types/pouch': null,
        '/equipment_types/back': null,
        '/equipment_types/neck': null,
        '/equipment_types/earrings': null,
        '/equipment_types/ring': null,
        '/equipment_types/charm': null,
    };

    /**
     * The talismans this player wears (unscaled `{slotIndex, modifiers}`), from the DTO. Their combat lines are
     * scaled by the belt in `equipment` when the stats are built.
     */
    talismans = [];

    /**
     * The talisman-only mechanics (echo, smite, shatter, fortify, overkill) as scaled values. Carried for a later
     * change; nothing in the fight reads them yet.
     */
    talismanMechanics = {};

    constructor() {
        super();

        this.isPlayer = true;
        this.hrid = 'player';
    }

    static createFromDTO(dto) {
        const player = new Player();

        player.staminaLevel = dto.staminaLevel;
        player.intelligenceLevel = dto.intelligenceLevel;
        player.attackLevel = dto.attackLevel;
        player.meleeLevel = dto.meleeLevel;
        player.defenseLevel = dto.defenseLevel;
        player.rangedLevel = dto.rangedLevel;
        player.magicLevel = dto.magicLevel;

        player.hrid = dto.hrid;

        // This player's own combat tasks, resolved live by the adapter and
        // marshalled as plain hrids. Absent for an imported profile or a party
        // member whose task board we cannot see, and absent means nobody's
        // taskDamage pays for them — never the whole party's.
        player.taskMonsterHrids =
            Array.isArray(dto.taskMonsterHrids) && dto.taskMonsterHrids.length > 0
                ? new Set(dto.taskMonsterHrids)
                : null;

        // What each of those tasks still needs. Absent means "no count given",
        // which the engine reads as a task that never finishes — the behavior
        // a DTO built before this field existed already had.
        const remaining = dto.taskMonsterRemaining;
        player.taskMonsterRemaining =
            remaining && typeof remaining === 'object' && Object.keys(remaining).length > 0
                ? new Map(Object.entries(remaining).map(([hrid, count]) => [hrid, Number(count) || 0]))
                : null;

        for (const [key, value] of Object.entries(dto.equipment)) {
            player.equipment[key] = value ? Equipment.createFromDTO(value) : null;
        }

        player.food = dto.food.map((food) => (food ? Consumable.createFromDTO(food) : null));
        player.drinks = dto.drinks.map((drink) => (drink ? Consumable.createFromDTO(drink) : null));
        player.abilities = dto.abilities.map((ability) => (ability ? Ability.createFromDTO(ability) : null));
        Object.entries(dto.houseRooms).forEach((houseRoom) => {
            if (houseRoom[1] > 0) {
                player.houseRooms.push(new HouseRoom(houseRoom[0], houseRoom[1]));
            }
        });

        player.talismans = Array.isArray(dto.talismans) ? dto.talismans : [];

        player.debuffOnLevelGap = dto.debuffOnLevelGap;

        return player;
    }

    /**
     * The equipment's contribution to every combat stat, computed once.
     *
     * This used to run on every call: seventy stats, each one an `Object.values`
     * plus a filter, a map and a reduce over thirteen slots — nine hundred
     * lookups and a couple of hundred throwaway arrays to arrive at numbers that
     * cannot change during a fight. It was 72% of the cost of a stat rebuild,
     * and fury rebuilds on nearly every swing.
     *
     * Keyed on what is actually worn rather than on a flag somebody has to
     * remember to clear: thirteen property reads to decide, against nine hundred
     * to recompute.
     *
     * @returns {Object} Stat name → total from equipment
     * @private
     */
    _equipmentStats() {
        const slots = Object.keys(this.equipment);
        let signature = '';
        for (let i = 0; i < slots.length; i++) {
            const piece = this.equipment[slots[i]];
            signature += piece ? `${slots[i]}=${piece.hrid}+${piece.enhancementLevel || 0};` : `${slots[i]}=;`;
        }
        // Talismans scale by the belt (already in the signature) and are applied only when the game data says so
        signature += `|t=${getGameData()?.talismansEnabled ? this._talismansSignature() : ''}`;
        if (this._equipmentStatsSignature === signature) return this._equipmentStatsCache;

        const pieces = [];
        for (let i = 0; i < slots.length; i++) {
            const piece = this.equipment[slots[i]];
            if (piece) pieces.push(piece);
        }

        const stats = {};
        for (let i = 0; i < EQUIPMENT_STATS.length; i++) {
            const stat = EQUIPMENT_STATS[i];
            let total = 0;
            for (let j = 0; j < pieces.length; j++) total += pieces[j].getCombatStat(stat);
            stats[stat] = total;
        }

        const talisman = computeTalismanCombat({
            talismans: this.talismans,
            belt: this.equipment[BELT_TYPE],
            gameData: getGameData(),
            modeledStats: TALISMAN_MODELED_STATS,
        });
        for (const stat of Object.keys(talisman.stats)) {
            if (stat !== 'damageTaken') stats[stat] += talisman.stats[stat];
        }
        this.talismanDamageTaken = talisman.stats.damageTaken || 0;
        this.talismanMechanics = talisman.mechanics;

        this._equipmentStatsSignature = signature;
        this._equipmentStatsCache = stats;
        return stats;
    }

    /**
     * The talisman part of the equipment-stats cache key. Talismans do not change during a run, and
     * `_equipmentStats` runs on nearly every swing, so the text is made once per talisman list: it is kept
     * against the list it was made from, and a replaced list makes a new one.
     * @returns {string}
     * @private
     */
    _talismansSignature() {
        if (this._talismansSignatureFor !== this.talismans) {
            this._talismansSignatureFor = this.talismans;
            this._talismansSignatureText = JSON.stringify(this.talismans);
        }
        return this._talismansSignatureText;
    }

    /**
     * The three loot stats as they stand at `time`, without touching any state.
     *
     * A downed unit has no buff-expiry checks queued (death sweeps them), and
     * nothing prunes a buff until the unit is revived, so its folded
     * `combatStats` keep a drink that lapsed while it was down. The loot record
     * reads this instead for a downed player: the equipment base folded with
     * only the buffs still running at `time`, by the same formula
     * `updateCombatDetails` uses.
     *
     * @param {number} time - Simulation time in nanoseconds
     * @returns {{combatDropRate: number, combatRareFind: number, combatDropQuantity: number}}
     */
    lootStatsAt(time) {
        const equipmentStats = this._equipmentStats();
        const live = [];
        for (const key in this.combatBuffs) {
            const buff = this.combatBuffs[key];
            const sources = this.buffSources.get(buff.uniqueHrid);
            if (sources) {
                const active = sources.filter((b) => b.startTime + b.duration > time);
                if (active.length > 0) live.push(this.strongestBuff(active));
            } else if (!(buff.startTime + buff.duration <= time)) {
                live.push(buff);
            }
        }
        const fold = (stat, typeHrid) => {
            let ratio = 0;
            let flat = 0;
            for (const buff of live) {
                if (buff.typeHrid !== typeHrid) continue;
                ratio += buff.ratioBoost;
                flat += buff.flatBoost;
            }
            const base = equipmentStats[stat];
            return base + (1 + base) * ratio + flat;
        };
        return {
            combatDropRate: fold('combatDropRate', '/buff_types/combat_drop_rate'),
            combatRareFind: fold('combatRareFind', '/buff_types/rare_find'),
            combatDropQuantity: fold('combatDropQuantity', '/buff_types/combat_drop_quantity'),
        };
    }

    updateCombatDetails() {
        if (this.equipment['/equipment_types/main_hand']) {
            this.combatDetails.combatStats.combatStyleHrid =
                this.equipment['/equipment_types/main_hand'].getCombatStyle();
            this.combatDetails.combatStats.damageType = this.equipment['/equipment_types/main_hand'].getDamageType();
            this.combatDetails.combatStats.attackInterval =
                this.equipment['/equipment_types/main_hand'].getCombatStat('attackInterval');
            this.combatDetails.combatStats.primaryTraining =
                this.equipment['/equipment_types/main_hand'].getPrimaryTraining();
        } else if (this.equipment['/equipment_types/two_hand']) {
            this.combatDetails.combatStats.combatStyleHrid =
                this.equipment['/equipment_types/two_hand'].getCombatStyle();
            this.combatDetails.combatStats.damageType = this.equipment['/equipment_types/two_hand'].getDamageType();
            this.combatDetails.combatStats.attackInterval =
                this.equipment['/equipment_types/two_hand'].getCombatStat('attackInterval');
            this.combatDetails.combatStats.primaryTraining =
                this.equipment['/equipment_types/two_hand'].getPrimaryTraining();
        } else {
            this.combatDetails.combatStats.combatStyleHrid = '/combat_styles/smash';
            this.combatDetails.combatStats.damageType = '/damage_types/physical';
            this.combatDetails.combatStats.attackInterval = 3000000000;
            this.combatDetails.combatStats.primaryTraining = '/skills/melee';
        }

        if (this.equipment['/equipment_types/charm']) {
            this.combatDetails.combatStats.focusTraining = this.equipment['/equipment_types/charm'].getFocusTraining();
        } else {
            this.combatDetails.combatStats.focusTraining = '';
        }

        const equipmentStats = this._equipmentStats();
        for (let i = 0; i < EQUIPMENT_STATS.length; i++) {
            const stat = EQUIPMENT_STATS[i];
            this.combatDetails.combatStats[stat] = equipmentStats[stat];
        }

        if (this.equipment['/equipment_types/pouch']) {
            this.combatDetails.combatStats.foodSlots =
                1 + this.equipment['/equipment_types/pouch'].getCombatStat('foodSlots');
            this.combatDetails.combatStats.drinkSlots =
                1 + this.equipment['/equipment_types/pouch'].getCombatStat('drinkSlots');
        } else {
            this.combatDetails.combatStats.foodSlots = 1;
            this.combatDetails.combatStats.drinkSlots = 1;
        }

        super.updateCombatDetails();
    }
}

export default Player;
