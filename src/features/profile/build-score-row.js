/**
 * Build Score overlay row
 *
 * Your own combat score, without opening your own profile.
 *
 * Toolasha already computes this — it is the figure on the profile card, the
 * coin cost of the build split into house, abilities and equipment. It is only
 * ever shown for a profile you have opened, which means the one profile you
 * cannot casually see it for is your own.
 *
 * ## Assembling a profile for yourself
 *
 * `calculateCombatScore` takes a `profile_shared` payload, and reads exactly
 * three things out of it: the house rooms, the equipped abilities, and the worn
 * items. All three are already known for the current character, so rather than
 * waiting for the game to share your profile with you, the same shape is built
 * from what the client already holds. The same function then gives the same
 * answer as the card.
 *
 * ## When it recalculates
 *
 * Not on the overlay's timer. Scoring a build prices every worn item, and prices
 * a +13 by simulating what it cost to get there — a worker-pool job, not
 * something to repeat once a second for a figure that changes when you change
 * gear. So it recomputes on equipment and house changes, debounced, and holds
 * the last answer in between.
 *
 * It also starts working only once something asks: the listeners are attached by
 * the first render, so a row nobody has switched on costs nothing at all.
 */

import config from '../../core/config.js';
import webSocketHook from '../../core/websocket.js';
import dataManager from '../../core/data-manager.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { calculateCombatScore } from './score-calculator.js';
import { buildScorePanel, setScoreSource } from './build-score-panel.js';

/** Equipment changes arrive in bursts — a loadout swap is one event per slot */
const DEBOUNCE_MS = 3000;

/** However often changes arrive, the score is not worth recomputing faster than this */
const MIN_INTERVAL_MS = 30000;

/**
 * The current character in the shape `calculateCombatScore` reads.
 *
 * Exported because it is the part worth checking against a real profile: if the
 * row and the card ever disagree, it is this assembly that is wrong, not the
 * scoring.
 *
 * @returns {Object|null} A `profile_shared`-shaped object, or null before the
 *   character has loaded
 */
export function ownProfileData() {
    const characterData = dataManager.characterData;
    const combined = dataManager.getCombinedData();
    if (!characterData || !combined) return null;

    const wearableItemMap = {};
    for (const [slot, item] of dataManager.getEquipment()) {
        if (!item?.itemHrid) continue;
        wearableItemMap[slot] = {
            itemLocationHrid: slot,
            itemHrid: item.itemHrid,
            enhancementLevel: item.enhancementLevel || 0,
        };
    }

    // Levels are character-scoped and the equipped list is not, so the two are
    // read separately: `combatAbilities` says which are slotted, and
    // `characterAbilities` says what level each has actually reached
    const levels = {};
    for (const ability of characterData.characterAbilities || []) {
        if (ability?.abilityHrid) levels[ability.abilityHrid] = ability.level || 1;
    }
    const equippedAbilities = (characterData.combatUnit?.combatAbilities || [])
        .filter((ability) => ability?.abilityHrid)
        .map((ability) => ({
            abilityHrid: ability.abilityHrid,
            level: levels[ability.abilityHrid] || ability.level || 1,
        }));

    return {
        profile: {
            characterHouseRoomMap: combined.characterHouseRoomMap || {},
            equippedAbilities,
            wearableItemMap,
            // Not part of a shared profile — the game never tells you what
            // another player has put into their guild's shrines — so this is the
            // one place the guild-shrine component can be scored at all
            characterGuildBuffMap: dataManager.characterGuildBuffMap || {},
            // Your own equipment is never hidden from you, whatever the profile
            // privacy setting says about showing it to other people
            hideWearableItems: false,
        },
    };
}

class BuildScore {
    constructor() {
        this.watching = false;
        this.score = null;
        this.computedAt = 0;
        this.pending = null;
        this.running = false;
    }

    /**
     * Start listening, the first time anyone asks for the figure.
     *
     * Called from `render` rather than from a feature's `initialize`, so the
     * cost is paid by switching the row on and by nothing else.
     */
    ensureWatching() {
        if (this.watching) return;
        if (!config.getSetting('combatScore')) return;
        this.watching = true;

        const onChange = () => this.schedule();
        webSocketHook.on('items_updated', onChange);
        webSocketHook.on('house_rooms_updated', onChange);
        this.detach = () => {
            webSocketHook.off('items_updated', onChange);
            webSocketHook.off('house_rooms_updated', onChange);
        };

        this.refresh();
    }

    /** Recompute soon, once the burst of changes has settled */
    schedule() {
        clearTimeout(this.pending);
        this.pending = setTimeout(() => this.refresh(), DEBOUNCE_MS);
    }

    /** Recompute now, unless one is already running or the last is still fresh */
    async refresh() {
        if (this.running) return;
        if (this.score && Date.now() - this.computedAt < MIN_INTERVAL_MS) return;

        const profileData = ownProfileData();
        if (!profileData) return;

        this.running = true;
        try {
            const result = await calculateCombatScore(profileData);
            // A score of zero means the pricing came back empty, not that the
            // build is worthless — keeping the last real answer beats replacing
            // it with a wrong one
            if (result?.total > 0) {
                this.score = result;
                this.computedAt = Date.now();
            }
        } catch (error) {
            console.error('[BuildScore] Scoring the build failed:', error);
        } finally {
            this.running = false;
        }
    }

    disable() {
        clearTimeout(this.pending);
        this.detach?.();
        this.detach = null;
        this.watching = false;
        this.score = null;
    }
}

const buildScore = new BuildScore();

// The panel behind the tile reads the same figure the tile does, and asking for
// it is what starts the watcher — so opening the panel on a character whose
// score has never been computed computes it, rather than showing an empty shell.
setScoreSource(() => {
    buildScore.ensureWatching();
    return buildScore.score;
});

registerRow({
    key: 'buildScore',
    empty: 'No build score yet',
    name: 'Build Score',
    defaultSize: { width: 180, height: 30 },
    render: (container) => {
        buildScore.ensureWatching();

        const score = buildScore.score;
        if (!score) {
            container.replaceChildren();
            return;
        }

        container.replaceChildren();
        Object.assign(container.style, { display: 'flex', justifyContent: 'space-between', gap: '10px' });

        const label = document.createElement('span');
        label.textContent = 'Build score';

        const value = document.createElement('span');
        value.textContent = score.total.toFixed(1);
        value.style.color = '#4ade80';
        value.style.whiteSpace = 'nowrap';

        container.append(label, value);
        // Guild shrines are shown on their own line rather than inside the total:
        // nobody else's card can carry the figure, so adding it would make this
        // score mean something different from every score it gets compared with
        const shrineLine =
            score.guildShrine > 0
                ? `Guild shrines ${score.guildShrine.toFixed(1)} (+${score.guildShrineTokens} tokens, unpriced)\n`
                : '';
        container.title =
            `Equipment ${score.equipment.toFixed(1)} · Abilities ${score.ability.toFixed(1)} · ` +
            `House ${score.house.toFixed(1)}\n` +
            `Skiller ${score.skillerTotal.toFixed(1)}\n` +
            shrineLine +
            'The same score as your profile card: the build’s cost in millions of coins.\n' +
            'Double-click for what the score is made of.';
    },
    onOpen: () => buildScorePanel.toggle(),
});

export default buildScore;
