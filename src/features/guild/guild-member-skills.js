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
import guildLoadoutCapture from './guild-loadout-capture.js';
import { guildXPTracker } from './guild-xp-tracker.js';
import { fillProfileCommand, findChatInput } from '../../utils/profile-command.js';

/** Object store the captures live in — shared with the rest of the guild history */
const STORE_NAME = 'guildHistory';

/** Key prefix; the guild name is appended, as the trial record's key is */
const KEY_PREFIX = 'guildMemberSkills';

/** A capture older than this is offered for refreshing */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a requested profile is given to arrive before it is offered again.
 *
 * Clicking asks the game for a profile; only the game's reply proves anything.
 * The first version marked a member as dealt with on the *click*, so a click
 * that went nowhere — chat hidden, the fallback filling an input nobody could
 * see — skipped that member for the session and left the roster reading "every
 * member logged" with seven of eight actually captured.
 */
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * A combat sheet captured longer ago than this is worth re-clicking mid-fight.
 *
 * The weekly staleness that suits skill levels is far too slow for a fight on
 * screen right now — gear and abilities are what they are *today*, and the
 * whole point of clicking during a trial is a sheet from this trial.
 */
export const UNIT_FRESH_MS = 15 * 60 * 1000;

/**
 * The subtree the spectated fight is drawn in, found by its boss.
 *
 * The In Progress tab draws the skilling instance and the combat fight side by
 * side, and the skilling panel's participant units are inert — clicking one
 * opens nothing, which is how the button came to offer somebody who was off
 * foraging while a fight was on screen. The one thing only the fight view has
 * is the encounter itself, so the boss's own "Trial …" name is the anchor: the
 * fight is the smallest subtree holding both the boss and at least one roster
 * member.
 *
 * @param {Map<string, string>} wanted - lowercased name → display name
 * @param {Document|Element} root - Where to look
 * @returns {Element|null} The fight subtree, or null when no fight is on screen
 */
function findFightArea(wanted, root) {
    for (const leaf of root.querySelectorAll('div, span')) {
        if (leaf.childElementCount) continue;
        if (!/^trial\s+\S/i.test((leaf.textContent || '').trim())) continue;

        let area = leaf;
        for (let up = 0; up < 8 && area.parentElement; up += 1) {
            area = area.parentElement;
            for (const inner of area.querySelectorAll('div, span')) {
                if (inner.childElementCount) continue;
                if (wanted.has((inner.textContent || '').trim().toLowerCase())) return area;
            }
        }
    }
    return null;
}

/**
 * Player unit boxes in a spectated guild fight, matched to roster names.
 *
 * The fight view draws each participant as a small box: the member's name as
 * its own text line with an `n/m` health reading nearby. Clicking the box opens
 * the game's Battle Info popup, which is what makes the game send that member's
 * stat sheet (`battle_unit_fetched`) — the only source a combat loadout has;
 * `/profile` carries skills but no sheet. The boss is drawn the same way but is
 * not a member, so only roster names are matched and it can never be offered.
 *
 * Only units inside the fight's own subtree count — see {@link findFightArea};
 * the skilling panel beside it draws members too, and those boxes are inert.
 *
 * @param {Array} members - Roster, `{name}` each
 * @param {Document|Element|null} [root] - Injectable for tests
 * @returns {Array<{name: string, el: Element, dead: boolean}>} Clickable units
 */
export function findBattleUnits(members, root = typeof document === 'undefined' ? null : document) {
    if (!root) return [];
    const wanted = new Map();
    for (const member of members || []) {
        const name = String(member?.name || '').trim();
        if (name) wanted.set(name.toLowerCase(), name);
    }
    if (!wanted.size) return [];

    const fight = findFightArea(wanted, root);
    if (!fight) return [];

    const units = [];
    const taken = new Set();
    for (const leaf of fight.querySelectorAll('div, span')) {
        if (leaf.childElementCount) continue;
        const name = wanted.get((leaf.textContent || '').trim().toLowerCase());
        if (!name || taken.has(name)) continue;

        // The unit is the smallest ancestor that also shows a health reading —
        // climbing further would grab the whole grid, whose click means nothing
        let box = leaf;
        for (let up = 0; up < 4 && box.parentElement; up += 1) {
            box = box.parentElement;
            if (!/\d[\d,]*\s*\/\s*\d[\d,]*/.test(box.textContent || '')) continue;
            taken.add(name);
            units.push({ name, el: box });
            break;
        }
    }
    return units;
}

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
 * @param {Object} [requests] - name (lowercased) → when their profile was asked for
 * @param {number} [dueBefore] - Captures at or before this are due again
 * @returns {{next: Object|null, pending: Object|null, logged: number, total: number,
 *   stale: number}} Where the walk is
 */
export function nextMemberToLog(members, captures = {}, now = Date.now(), requests = {}, dueBefore = 0) {
    const roster = (members || []).filter((member) => member?.name);
    // A capture taken before the last "redo" is due again, however fresh it is
    const held = (name) => {
        const capture = captures?.[String(name).toLowerCase()] || null;
        if (!capture) return null;
        return (capture.at || 0) <= dueBefore ? null : capture;
    };
    const awaiting = (name) => now - (Number(requests?.[String(name).toLowerCase()]) || 0) < REQUEST_TIMEOUT_MS;

    let logged = 0;
    let stale = 0;
    const never = [];
    const old = [];
    let pending = null;

    for (const member of roster) {
        const capture = held(member.name);
        if (!capture) {
            // Asked for a moment ago and still in flight: not offered again yet,
            // and not counted as done either
            if (awaiting(member.name)) pending = pending || member;
            else never.push(member);
            continue;
        }
        if (now - (capture.at || 0) > STALE_AFTER_MS) {
            stale += 1;
            old.push(member);
        }
        logged += 1;
    }

    return {
        // Nothing else to ask for while one is in flight — but it is offered
        // again the moment the window passes, because a click that went nowhere
        // is not a capture
        next: never[0] || old[0] || (pending && !never.length && !old.length ? pending : null),
        pending,
        logged,
        total: roster.length,
        stale,
    };
}

class GuildMemberSkills {
    constructor() {
        this.initialized = false;
        this.guildName = null;
        this.captures = {};
        this.onProfile = null;
        /** name → when their profile was asked for, so a click in flight is not a click done */
        this.requests = {};
        /** name → when their battle unit was clicked; a sheet in flight is not a sheet held */
        this.unitRequests = {};
        /** Captures taken at or before this are due again; see {@link redoAll} */
        this.dueBefore = 0;
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
        this.requests = {};
        this.dueBefore = 0;
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
     * Walk the roster again, without throwing away what is already held.
     *
     * A capture goes stale on its own after a week, which is right for a roster
     * that drifts slowly and wrong for a player who has just watched half the
     * guild level up. This marks everything captured so far as due again: the
     * button offers each member once more and the counter starts from nothing,
     * while the levels already stored stay exactly where they are until a fresh
     * profile replaces them.
     *
     * It fires no requests of its own. One click, one profile, still.
     *
     * @param {number} [at] - Clock
     * @returns {number} How many captures are now due again
     */
    redoAll(at = Date.now()) {
        this.dueBefore = at;
        this.requests = {};
        return Object.keys(this.captures).length;
    }

    /**
     * Ask for one member's profile again, whatever its age.
     * @param {string} name - Member name
     * @param {number} [at] - Clock
     */
    redoMember(name, at = Date.now()) {
        const key = String(name || '').toLowerCase();
        const capture = this.captures[key];
        if (!capture) return;

        // Dated back out of the fresh window rather than deleted: the levels are
        // still the best answer available until a newer profile arrives
        this.captures = { ...this.captures, [key]: { ...capture, at: 0, redoRequestedAt: at } };
        delete this.requests[key];
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

        // Counted from the captures and nothing else. A click is a request; the
        // game's reply is the only thing that makes somebody logged.
        const members = guildXPTracker.getMemberList?.() || [];
        return nextMemberToLog(members, this.captures, now, this.requests, this.dueBefore);
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
    /**
     * The next fight participant worth clicking, when a fight is on screen.
     *
     * Only the people in the battle matter here — their Battle Info popup is
     * what carries a combat sheet, and a fight on screen is the only time it
     * can be asked for. Dead units are clicked like anyone else: a popup shows
     * whatever the build holds, dead or alive (a unit with no abilities simply
     * has none).
     *
     * @param {number} [now] - Clock
     * @param {Object} [capture] - The loadout store, injectable for tests
     * @returns {{name: string, el: Element}|null}
     */
    nextBattleUnit(now = Date.now(), capture = guildLoadoutCapture) {
        const members = guildXPTracker.getMemberList?.() || [];
        const units = findBattleUnits(members);
        if (!units.length) return null;

        const seen = new Map();
        for (const entry of capture.seen?.() || []) {
            seen.set(String(entry?.name || '').toLowerCase(), Number(entry?.at) || 0);
        }

        for (const unit of units) {
            const key = unit.name.toLowerCase();
            const at = seen.get(key) || 0;
            if (at > this.dueBefore && now - at < UNIT_FRESH_MS) continue;
            if (now - (Number(this.unitRequests[key]) || 0) < REQUEST_TIMEOUT_MS) continue;
            return unit;
        }
        return null;
    }

    openNext(now = Date.now()) {
        const state = this.progress(now);

        // People in the fight first: a battle on screen is the only time a
        // combat sheet can be asked for, and it matters more than the roster
        const unit = this.nextBattleUnit(now);
        if (unit?.el) {
            this.unitRequests[unit.name.toLowerCase()] = now;
            unit.el.click();
            return { opened: unit.name, how: 'unit', logged: state.logged, total: state.total };
        }

        if (!state.next) return { opened: null, how: 'done', logged: state.logged, total: state.total };

        const name = state.next.name;
        const result = (how) => ({ opened: name, how, logged: state.logged, total: state.total });

        const row = this._findMemberRow(name);
        if (row) {
            this.requests[name.toLowerCase()] = now;
            row.click();
            return result('row');
        }

        // The chat command is the only route for a skilling trial's
        // participants — those units were inspected and open nothing — so a
        // chat box that is not there is worth saying rather than filling
        // nothing and calling it done
        const input = this._chatInput();
        if (!input) return result('no-chat');

        this.requests[name.toLowerCase()] = now;
        return result(this._fillProfileCommand(name, input) ? 'chat' : 'no-chat');
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
            // Only the Members tab's own rows. The In Progress tab draws a
            // participant's name in a grid cell too, and those were inspected:
            // for a skilling trial they open nothing at all, so clicking one
            // would record a request that can never be answered
            if (!cell.closest?.('table, [role="table"], [class*="Members"], [class*="membersTab"]')) continue;
            return cell.querySelector('[class*="name"], span, a') || cell;
        }
        return null;
    }

    /**
     * The chat input, if there is one the player can actually use.
     * Delegates to the shared helper in `utils/profile-command.js`.
     * @returns {Element|null} The input
     */
    _chatInput() {
        return findChatInput();
    }

    /**
     * Put `/profile <name>` in the chat box, ready to send.
     * Delegates to the shared helper, keeping this module's log prefix.
     * @param {string} name - Member name
     * @returns {boolean} True when the box was filled
     */
    _fillProfileCommand(name, chatInput = null) {
        return fillProfileCommand(name, chatInput, 'GuildMemberSkills');
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
