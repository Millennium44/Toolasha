/**
 * Guild members' skill levels, one profile at a time.
 *
 * ## Why this is a button and not a loop
 *
 * A skilling trial's forecast wants to know what the party can actually do, and
 * the only place a guild member's skill levels appear is their profile —
 * `profile_shared`, which the game sends when a profile is opened and at no
 * other time. There is no roster message carrying levels, so the levels have to
 * be *collected*, one profile at a time, by somebody opening them.
 *
 * So this is one profile per click, and the player does the clicking. That is
 * the shape the feature was asked for, and it is also the only shape worth
 * having: a script that opened twenty-eight profiles by itself would be
 * generating traffic nobody asked for at a rate no person produces. The button
 * remembers where it got to, so "keep clicking" walks the roster and stops when
 * it is done.
 *
 * ## What a profile actually yields
 *
 * Checked against what the codebase already reads from that payload
 * (`combat-sim-export.js` builds a whole simulated player out of one):
 * `profile.characterSkills` is an array of `{skillHrid, level}` covering every
 * skill, which is exactly what a skilling trial's forecast needs, plus
 * `wearableItemMap` and the sharable character. So a profile answers the
 * skilling question outright — it is the combat side that stays estimated,
 * because a stat *sheet* only arrives from `battle_unit_fetched`.
 *
 * Captures are kept per guild member and go stale: a level from three weeks ago
 * is not what that member is now, and the cycler offers those members again
 * rather than reporting the roster as done forever.
 */

import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import webSocketHook from '../../core/websocket.js';
import { guildXPTracker } from './guild-xp-tracker.js';

/** Object store the captures live in — shared with the rest of the guild history */
const STORE_NAME = 'guildHistory';

/** Key prefix; the guild name is appended, as the trial record's key is */
const KEY_PREFIX = 'guildMemberSkills';

/** A capture older than this is offered for refreshing */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Storage key for a guild's captures.
 * @param {string|null} guildName - Guild name, or null before it is known
 * @returns {string} Storage key
 */
export function memberSkillsStorageKey(guildName) {
    return `${KEY_PREFIX}_${guildName || 'default'}`;
}

/**
 * The skills out of a `profile_shared` payload.
 *
 * @param {Object} message - A `profile_shared` message
 * @param {number} [at] - When it arrived
 * @returns {{name: string, characterId: string|number|null, skills: Object, at: number}|null} The capture
 */
export function extractProfileSkills(message, at = Date.now()) {
    const profile = message?.profile || message;
    const skills = Array.isArray(profile?.characterSkills) ? profile.characterSkills : null;
    if (!skills || !skills.length) return null;

    const character = profile.sharableCharacter || profile.character || null;
    const name = character?.name || null;
    const characterId = character?.id ?? skills[0]?.characterID ?? null;
    if (!name && characterId === null) return null;

    const levels = {};
    for (const skill of skills) {
        const hrid = skill?.skillHrid;
        const level = Number(skill?.level);
        if (hrid && Number.isFinite(level)) levels[hrid] = level;
    }
    if (!Object.keys(levels).length) return null;

    return { name: name || String(characterId), characterId, skills: levels, at };
}

/**
 * Who to open next, and how far along the roster this is.
 *
 * Members who have never been captured come first, then those whose capture has
 * gone stale, and a member being offered again after a week is not a failure —
 * it is the only way a level from three weeks ago gets corrected.
 *
 * @param {Array<Object>} members - The roster, from the XP tracker
 * @param {Object} captures - name (lowercased) → capture
 * @param {number} [now] - Clock
 * @returns {{next: Object|null, logged: number, total: number, stale: number}} Where the walk is
 */
export function nextMemberToLog(members, captures = {}, now = Date.now()) {
    const roster = (members || []).filter((member) => member?.name);
    const held = (name) => captures?.[String(name).toLowerCase()] || null;

    let logged = 0;
    let stale = 0;
    const never = [];
    const old = [];

    for (const member of roster) {
        const capture = held(member.name);
        if (!capture) {
            never.push(member);
            continue;
        }
        if (now - (capture.at || 0) > STALE_AFTER_MS) {
            stale += 1;
            old.push(member);
        }
        logged += 1;
    }

    return { next: never[0] || old[0] || null, logged, total: roster.length, stale };
}

class GuildMemberSkills {
    constructor() {
        this.initialized = false;
        this.guildName = null;
        this.captures = {};
        this.onProfile = null;
        /** Names offered this session, so a click moves on even before the reply lands */
        this.offered = new Set();
    }

    /**
     * Start listening for opened profiles.
     * @param {string|null} guildName - The key captures are stored under
     * @returns {Promise<void>}
     */
    async initialize(guildName = null) {
        this.guildName = guildName;
        if (!this.initialized) {
            this.initialized = true;
            this.onProfile = (message) => this._onProfile(message);
            webSocketHook.on('profile_shared', this.onProfile);
        }
        await this.load();
    }

    cleanup() {
        if (this.onProfile) webSocketHook.off('profile_shared', this.onProfile);
        this.onProfile = null;
        this.initialized = false;
    }

    /** Forget this guild's captures; used when the tab changes character */
    forget() {
        this.captures = {};
        this.offered.clear();
    }

    /**
     * @param {string|null} guildName - The key captures are stored under
     * @returns {Promise<void>}
     */
    async setGuildName(guildName) {
        if ((guildName || null) === this.guildName) return;
        this.guildName = guildName || null;
        this.forget();
        await this.load();
    }

    /** @returns {Promise<Object>} The captures, read back from storage */
    async load() {
        try {
            const stored = await storage.get(memberSkillsStorageKey(this.guildName), STORE_NAME, null);
            this.captures = stored && typeof stored === 'object' ? stored : {};
        } catch (error) {
            console.error('[GuildMemberSkills] Failed to read captured profiles:', error);
            this.captures = {};
        }
        return this.captures;
    }

    /**
     * A profile was opened.
     * @param {Object} message - `profile_shared`
     */
    _onProfile(message) {
        try {
            const capture = extractProfileSkills(message);
            if (!capture) return;

            this.captures = { ...this.captures, [capture.name.toLowerCase()]: capture };
            storage
                .set(memberSkillsStorageKey(this.guildName), this.captures, STORE_NAME)
                .catch((error) => console.error('[GuildMemberSkills] Failed to store a profile:', error));
        } catch (error) {
            console.error('[GuildMemberSkills] Reading an opened profile failed:', error);
        }
    }

    /**
     * How far along the roster the collection is.
     * @param {number} [now] - Clock
     * @returns {{next: Object|null, logged: number, total: number, stale: number}} Progress
     */
    progress(now = Date.now()) {
        // The roster panel can be opened with the trials feature switched off,
        // and a listener that has never been attached has never read storage —
        // so the first look at the panel is what starts the collection
        if (!this.initialized) this.initialize(this.guildName).catch(() => {});

        const members = guildXPTracker.getMemberList?.() || [];
        const state = nextMemberToLog(members, this.captures, now);

        // A member offered a moment ago is not offered again while the reply is
        // still in flight, or a second click would open the same profile
        if (state.next && this.offered.has(state.next.name.toLowerCase())) {
            const remaining = members.filter((member) => member?.name && !this.offered.has(member.name.toLowerCase()));
            const retry = nextMemberToLog(remaining, this.captures, now);
            return { ...state, next: retry.next };
        }
        return state;
    }

    /**
     * Open the next member's profile.
     *
     * One profile, one click. The member's own row is clicked where the page is
     * showing one — that is the gesture a player would make — and where it is
     * not, the chat command the game already provides is filled in and left for
     * them to send, which is what `guild-xp-display.js` does with member names
     * already. Nothing is sent on the player's behalf.
     *
     * @returns {{opened: string|null, how: string, logged: number, total: number}} What happened
     */
    openNext() {
        const state = this.progress();
        if (!state.next) return { opened: null, how: 'done', logged: state.logged, total: state.total };

        const name = state.next.name;
        this.offered.add(name.toLowerCase());

        const row = this._findMemberRow(name);
        if (row) {
            row.click();
            return { opened: name, how: 'row', logged: state.logged, total: state.total };
        }

        const filled = this._fillProfileCommand(name);
        return { opened: name, how: filled ? 'chat' : 'none', logged: state.logged, total: state.total };
    }

    /**
     * A member's clickable row on the guild Members tab.
     * @param {string} name - Member name
     * @returns {Element|null} Something to click
     */
    _findMemberRow(name) {
        if (typeof document === 'undefined') return null;
        const wanted = String(name).trim().toLowerCase();

        for (const cell of document.querySelectorAll('[class*="GuildPanel"] td, [class*="GuildPanel"] [role="cell"]')) {
            if ((cell.textContent || '').trim().toLowerCase() !== wanted) continue;
            return cell.querySelector('[class*="name"], span, a') || cell;
        }
        return null;
    }

    /**
     * Put `/profile <name>` in the chat box, ready to send.
     * @param {string} name - Member name
     * @returns {boolean} True when the box was filled
     */
    _fillProfileCommand(name) {
        try {
            const input = document.querySelector('[class*="Chat_chatInputContainer"] input');
            if (!input) return false;

            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            setter?.call(input, `/profile ${name}`);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
            return true;
        } catch (error) {
            console.error('[GuildMemberSkills] Could not fill the profile command:', error);
            return false;
        }
    }

    /**
     * What has been collected, for the export and the forecast.
     * @returns {Object} name → `{name, characterId, skills, at}`
     */
    all() {
        return { ...this.captures };
    }

    /**
     * One member's level in one skill, where it has been captured.
     * @param {string} name - Member name
     * @param {string} skillHrid - e.g. `/skills/alchemy`
     * @returns {number|null} The level
     */
    levelFor(name, skillHrid) {
        const capture = this.captures?.[String(name || '').toLowerCase()];
        const level = Number(capture?.skills?.[skillHrid]);
        return Number.isFinite(level) ? level : null;
    }
}

const guildMemberSkills = new GuildMemberSkills();

export default guildMemberSkills;
export { guildMemberSkills };

/** Kept for callers that want the raw character id without the tracker */
export const currentCharacterId = () => dataManager.getCurrentCharacterId?.() ?? null;
