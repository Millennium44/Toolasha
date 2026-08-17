/**
 * Skill Level-Up Alerts
 *
 * Says so when one of your own skills gains a level — the same milestone the
 * game broadcasts to chat as "<Name> has reached level <N> <Skill>!", but read
 * from the character's own skill data rather than out of the chat log.
 *
 * ## Where the levels come from
 *
 * `skills_updated` carries the full `characterSkills` array whenever a level
 * changes, and each entry is `{ skillHrid, level, experience }`. That array is
 * inherently the logged-in character's — there is no name to match, no other
 * player's level to filter out, and no locale-dependent sentence to parse. A
 * chat line is a rendered string in whatever language the client is set to and
 * mixed in with everyone else's levels; the socket message is the fact behind
 * it, so that is what this reads.
 *
 * ## Diffing
 *
 * dataManager overwrites its own `characterSkills` before it re-emits the
 * event, so there is nothing to diff against there. This module keeps its own
 * `skillHrid → level` snapshot, seeded from `getSkills()` in `initialize()` so
 * the levels the character already has do not all fire on login, and updated on
 * every message. A level that is higher than the stored one is announced, once.
 *
 * ## Re-arming
 *
 * The announced level is baked into the notification service's event key, so
 * each level gained is a distinct key and the service's cooldown cannot swallow
 * a real second level-up. The snapshot is updated whether or not a message was
 * delivered, so a level going the other way — a character switch reseeding to a
 * lower level — re-baselines instead of re-announcing.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import notificationService from './notification-service.js';
import { skillName } from '../../utils/skill-progress.js';

/** Master switch; nothing below it is consulted while this is off */
export const MASTER_SETTING = 'notifications_skillLevelUp';

/** Prefix for the notification service's event keys */
const EVENT_KEY_PREFIX = 'skill-levelup';

class SkillLevelUpAlerts {
    constructor() {
        /** skillHrid → the level last seen, so a rise can be spotted */
        this.levels = new Map();
        this.skillsUpdatedHandler = null;
        this.characterSwitchingHandler = null;
    }

    /**
     * Start watching for level-ups.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (!config.getSetting(MASTER_SETTING)) {
            return;
        }

        // Seed from the levels the character already has, so a fresh login does
        // not announce every skill the player has ever trained
        this.seedFromCurrentSkills();

        this.skillsUpdatedHandler = (data) => {
            try {
                this.check(data?.characterSkills);
            } catch (error) {
                console.error('[SkillLevelUpAlerts] Reading a skills update failed:', error);
            }
        };
        dataManager.on('skills_updated', this.skillsUpdatedHandler);

        this.characterSwitchingHandler = () => {
            this.disable();
        };
        dataManager.on('character_switching', this.characterSwitchingHandler);
    }

    /** Take the current levels as the baseline, announcing nothing. */
    seedFromCurrentSkills() {
        const skills = dataManager.getSkills();
        if (!Array.isArray(skills)) return;
        for (const skill of skills) {
            if (skill?.skillHrid) {
                this.levels.set(skill.skillHrid, Number(skill.level) || 0);
            }
        }
    }

    /**
     * Announce any skill whose level has risen since it was last seen.
     * @param {Array<Object>} skills - `characterSkills` from `skills_updated`
     */
    check(skills) {
        if (!config.getSetting(MASTER_SETTING)) return;
        if (!Array.isArray(skills)) return;

        for (const skill of skills) {
            const hrid = skill?.skillHrid;
            if (!hrid) continue;

            const level = Number(skill.level);
            if (!Number.isFinite(level)) continue;

            const previous = this.levels.get(hrid);
            // Record whichever way it moved, so a reseed to a lower level is a
            // new baseline and not a resurrection of an old level-up
            this.levels.set(hrid, level);

            if (previous === undefined || level <= previous) continue;

            const name = skillName(hrid);
            notificationService.notify(`${EVENT_KEY_PREFIX}:${hrid}:${level}`, `You reached level ${level} ${name}!`, {
                title: 'Level up',
            });
        }
    }

    /**
     * Cleanup
     */
    disable() {
        if (this.skillsUpdatedHandler) {
            dataManager.off('skills_updated', this.skillsUpdatedHandler);
            this.skillsUpdatedHandler = null;
        }
        if (this.characterSwitchingHandler) {
            dataManager.off('character_switching', this.characterSwitchingHandler);
            this.characterSwitchingHandler = null;
        }
        this.levels.clear();
    }
}

const skillLevelUpAlerts = new SkillLevelUpAlerts();

export default skillLevelUpAlerts;
