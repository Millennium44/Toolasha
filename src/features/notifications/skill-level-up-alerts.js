/**
 * Skill Level-Up Alerts
 *
 * Says so when the game broadcasts one of your own skill milestones — the
 * "<Name> has reached level <N> <Skill>!" line it posts to guild chat at the
 * levels worth announcing (100, 105, …), not every single level.
 *
 * ## Why the chat broadcast, not `skills_updated`
 *
 * The point of this alert is the milestone, and the game already decides what a
 * milestone is: it sends a `chat_message_received` with the system key
 * `systemChatMessage.characterLeveledUp` exactly for the levels it broadcasts,
 * and stays silent for the ones in between. Keying off that message means the
 * alert fires on precisely those milestones with no threshold table to keep in
 * sync — where an earlier version read `skills_updated` and fired on every
 * level, which is not what the game announces and not what was wanted.
 *
 * The system message is structured, not prose: `systemMetadata` carries
 * `{ name, skillHrid, level }`, so nothing here parses a localized sentence.
 *
 * ## Only your own
 *
 * The same broadcast arrives for every guildmate who hits a milestone. Only the
 * one whose `name` matches the logged-in character is announced — that is the
 * whole request, "tell me when *I* am the subject" — and the metadata's own
 * name field is matched rather than a sentence scraped for a leading token.
 *
 * ## Depends on the guild broadcast
 *
 * This is the guild-chat milestone, so it needs that broadcast to arrive: a
 * character in a guild, with guild chat coming over the socket. A solo
 * character the game never announces is a character this cannot announce.
 *
 * ## Repeats
 *
 * The announced level is baked into the notification service's event key, so
 * each milestone is distinct. A light timestamp guard drops any history the
 * client replays on load — only broadcasts at or after the feature came up are
 * announced, with a minute of slack for clock skew so a genuine live milestone
 * is never dropped.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import notificationService from './notification-service.js';
import { skillName } from '../../utils/skill-progress.js';

/** Master switch; nothing below it is consulted while this is off */
export const MASTER_SETTING = 'notifications_skillLevelUp';

/** The system-message key the game sends for a broadcast milestone level */
export const LEVEL_UP_MESSAGE_KEY = 'systemChatMessage.characterLeveledUp';

/** Prefix for the notification service's event keys */
const EVENT_KEY_PREFIX = 'skill-levelup';

/**
 * How far before startup a broadcast may be timestamped and still count as live.
 * Live milestones carry a current time; replayed history is minutes or hours
 * old. The slack only has to swallow client/server clock skew.
 */
const REPLAY_GRACE_MS = 60 * 1000;

class SkillLevelUpAlerts {
    constructor() {
        /** When watching began, so replayed chat history can be told from live */
        this.startedAt = 0;
        this.unregisterHandlers = [];
        this.characterSwitchingHandler = null;
    }

    /**
     * Start watching for broadcast milestone levels.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (!config.getSetting(MASTER_SETTING)) {
            return;
        }

        this.startedAt = Date.now();
        this.registerWebSocketListeners();

        this.characterSwitchingHandler = () => {
            this.disable();
        };
        dataManager.on('character_switching', this.characterSwitchingHandler);
    }

    /** Listen for the chat message that carries a milestone broadcast. */
    registerWebSocketListeners() {
        const handler = (data) => {
            try {
                this.check(data);
            } catch (error) {
                console.error('[SkillLevelUpAlerts] Reading a chat message failed:', error);
            }
        };

        webSocketHook.on('chat_message_received', handler);
        this.unregisterHandlers.push(() => webSocketHook.off('chat_message_received', handler));
    }

    /**
     * Announce a milestone broadcast for the logged-in character.
     * @param {Object} data - `chat_message_received` payload
     */
    check(data) {
        if (!config.getSetting(MASTER_SETTING)) return;

        const message = data?.message;
        if (!message || !message.isSystemMessage) return;
        if (message.m !== LEVEL_UP_MESSAGE_KEY) return;

        // History the client replays on load is old; a live milestone is not
        const when = Date.parse(message.t ?? '');
        if (Number.isFinite(when) && when < this.startedAt - REPLAY_GRACE_MS) return;

        let meta;
        try {
            meta = JSON.parse(message.systemMetadata ?? '{}');
        } catch (error) {
            console.error('[SkillLevelUpAlerts] Malformed level-up metadata:', error);
            return;
        }

        // Only the broadcast whose subject is the logged-in character
        const characterName = dataManager.getCurrentCharacterName();
        if (!characterName || meta.name !== characterName) return;

        const level = Number(meta.level);
        if (!meta.skillHrid || !Number.isFinite(level)) return;

        const name = skillName(meta.skillHrid);
        notificationService.notify(
            `${EVENT_KEY_PREFIX}:${meta.skillHrid}:${level}`,
            `You reached level ${level} ${name}!`,
            { title: 'Level up' }
        );
    }

    /**
     * Cleanup
     */
    disable() {
        if (this.characterSwitchingHandler) {
            dataManager.off('character_switching', this.characterSwitchingHandler);
            this.characterSwitchingHandler = null;
        }

        this.unregisterHandlers.forEach((unregister) => unregister());
        this.unregisterHandlers = [];
        this.startedAt = 0;
    }
}

const skillLevelUpAlerts = new SkillLevelUpAlerts();

export default skillLevelUpAlerts;
