/**
 * Guild trial sign-up fields beyond the trial itself.
 *
 * Each `guildCharacterMap` member (login payload and `guild_characters_updated`) carries, next to the trial
 * hrids the guild code already reads: `signedUpCombatRoleHrid` (a bare `damage_dealer`, `support` or `tank`,
 * `""` for none), `signedUpCombatLoadoutID` and `signedUpSkillingLoadoutID` (a number, 0 for none),
 * `trialRolePrefs` (trial hrid → role) and `trialLoadoutPrefs` (trial hrid → loadout id), the last two as
 * JSON strings. Measured on the test server, 2026-11-02: eleven of 128 members had a combat trial and no
 * role, so a sign-up without a role is a real state, and no role is inferred for it.
 *
 * Everything here is pure and defensive: a malformed value reads as "none", never as an error.
 */

/** Combat roles the game lists, in display order */
export const COMBAT_ROLES = Object.freeze(['damage_dealer', 'support', 'tank']);

const ROLE_LABELS = Object.freeze({ damage_dealer: 'Damage', support: 'Support', tank: 'Tank' });

/**
 * A role as stored: a lowercase word string. The three known roles pass; any other plain word string is
 * kept (the game may add roles); anything else, including an empty string, is "no role".
 * @param {*} raw
 * @returns {string} The role, or '' for none
 */
export function parseSignupRole(raw) {
    if (typeof raw !== 'string') return '';
    const role = raw.trim().toLowerCase();
    return /^[a-z_]{1,40}$/.test(role) ? role : '';
}

/**
 * A role's label.
 * @param {string} role - From {@link parseSignupRole}
 * @returns {string}
 */
export function roleLabel(role) {
    if (!role) return '';
    return ROLE_LABELS[role] || role.replace(/_/g, ' ');
}

/**
 * A loadout id as the game sends it: a positive whole number, 0 for none.
 * @param {*} raw
 * @returns {number} The id, or 0 for none or unreadable
 */
export function parseLoadoutId(raw) {
    const id = Number(raw);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

/**
 * A prefs field: a JSON string (or an already parsed object) of trial hrid → value. A malformed string, a
 * non-object or an array is `{}`; only entries whose value passes `keep` survive.
 * @param {*} raw
 * @param {(value: *) => *} normalize - Maps a value to its clean form; a falsy result drops the entry
 * @returns {Object<string, *>}
 */
function parsePrefs(raw, normalize) {
    let parsed = raw;
    if (typeof raw === 'string') {
        if (!raw.trim()) return {};
        try {
            parsed = JSON.parse(raw);
        } catch {
            return {};
        }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [hrid, value] of Object.entries(parsed)) {
        const clean = normalize(value);
        if (hrid && clean) out[hrid] = clean;
    }
    return out;
}

/**
 * `trialRolePrefs`: trial hrid → the role the member prefers for it.
 * @param {*} raw - JSON string as the game sends it
 * @returns {Object<string, string>}
 */
export function parseRolePrefs(raw) {
    return parsePrefs(raw, parseSignupRole);
}

/**
 * `trialLoadoutPrefs`: trial hrid → the loadout id the member prefers for it.
 * @param {*} raw - JSON string as the game sends it
 * @returns {Object<string, number>}
 */
export function parseLoadoutPrefs(raw) {
    return parsePrefs(raw, parseLoadoutId);
}

/**
 * The sign-up fields of one `guildCharacterMap` member, parsed, under the names the guild XP tracker keeps.
 * @param {Object|null|undefined} guildChar
 * @returns {{signedUpCombatRoleHrid: string, signedUpCombatLoadoutID: number, signedUpSkillingLoadoutID: number,
 *   trialRolePrefs: Object<string, string>, trialLoadoutPrefs: Object<string, number>}}
 */
export function signupFieldsFromGuildChar(guildChar) {
    return {
        signedUpCombatRoleHrid: parseSignupRole(guildChar?.signedUpCombatRoleHrid),
        signedUpCombatLoadoutID: parseLoadoutId(guildChar?.signedUpCombatLoadoutID),
        signedUpSkillingLoadoutID: parseLoadoutId(guildChar?.signedUpSkillingLoadoutID),
        trialRolePrefs: parseRolePrefs(guildChar?.trialRolePrefs),
        trialLoadoutPrefs: parseLoadoutPrefs(guildChar?.trialLoadoutPrefs),
    };
}

/**
 * The fields a `guild_trial_signup_updated` message states, on top of a member's held ones.
 *
 * A field the message does not carry keeps its held value, except that a combat trial that changed takes
 * the held role with it unless the message states one: the role belonged to the trial it was chosen for.
 * Loadout ids follow the same rule for their own kind's trial.
 *
 * @param {Object} held - The tracker's meta for the member
 * @param {Object} data - The message
 * @returns {Object} Fields to assign over the held meta
 */
export function signupFieldsFromUpdate(held, data) {
    const out = {};
    const has = (key) => data && Object.hasOwn(data, key) && data[key] !== undefined;
    // The tracker reads an absent trial as none, so an absent one is a change from a held trial
    const moved = (key) => (data?.[key] || '') !== (held?.[key] || '');
    const combatMoved = moved('signedUpCombatTrialHrid');
    const skillingMoved = moved('signedUpSkillingTrialHrid');
    if (has('signedUpCombatRoleHrid')) out.signedUpCombatRoleHrid = parseSignupRole(data.signedUpCombatRoleHrid);
    else if (combatMoved) out.signedUpCombatRoleHrid = '';
    if (has('signedUpCombatLoadoutID')) out.signedUpCombatLoadoutID = parseLoadoutId(data.signedUpCombatLoadoutID);
    else if (combatMoved) out.signedUpCombatLoadoutID = 0;
    if (has('signedUpSkillingLoadoutID'))
        out.signedUpSkillingLoadoutID = parseLoadoutId(data.signedUpSkillingLoadoutID);
    else if (skillingMoved) out.signedUpSkillingLoadoutID = 0;
    if (has('trialRolePrefs')) out.trialRolePrefs = parseRolePrefs(data.trialRolePrefs);
    if (has('trialLoadoutPrefs')) out.trialLoadoutPrefs = parseLoadoutPrefs(data.trialLoadoutPrefs);
    return out;
}

/**
 * Which loadout ids changed between two metas of the same member.
 * @param {Object|null|undefined} before - Held meta; absent means first sight, which is not a change
 * @param {Object} after - New meta
 * @returns {{combat: boolean, skilling: boolean}}
 */
export function loadoutIdChanges(before, after) {
    if (!before) return { combat: false, skilling: false };
    return {
        combat: (before.signedUpCombatLoadoutID || 0) !== (after.signedUpCombatLoadoutID || 0),
        skilling: (before.signedUpSkillingLoadoutID || 0) !== (after.signedUpSkillingLoadoutID || 0),
    };
}

/**
 * A member's sign-up for a cycle, or null when they have none.
 *
 * Counts only when `signupWeekStartAt` is the current cycle, an empty string is not a sign-up, and a role
 * counts only beside a combat trial (a role without one is leftover and is ignored). One member yields one
 * role: the map is keyed by character, and the role is a single string.
 *
 * @param {Object|null} meta - The tracker's member meta
 * @param {string|null} weekStartAt - The current cycle's start stamp
 * @returns {{combatTrial: string, role: string, skillingTrial: string, combatLoadoutId: number,
 *   skillingLoadoutId: number, rolePref: string}|null}
 */
export function currentSignup(meta, weekStartAt) {
    if (!meta || weekStartAt == null || meta.signupWeekStartAt !== weekStartAt) return null;
    const combatTrial = meta.signedUpCombatTrialHrid || '';
    const skillingTrial = meta.signedUpSkillingTrialHrid || '';
    if (!combatTrial && !skillingTrial) return null;
    return {
        combatTrial,
        role: combatTrial ? meta.signedUpCombatRoleHrid || '' : '',
        skillingTrial,
        combatLoadoutId: combatTrial ? meta.signedUpCombatLoadoutID || 0 : 0,
        skillingLoadoutId: skillingTrial ? meta.signedUpSkillingLoadoutID || 0 : 0,
        // The role they usually take for this trial: shown beside a missing role, never used as one
        rolePref: combatTrial ? parseSignupRole(meta.trialRolePrefs?.[combatTrial]) : '',
    };
}

/**
 * Whether a captured trial loadout view still matches what the member has picked.
 *
 * The game's loadout reply carries no loadout id, so the id a view was taken for cannot be read back. What
 * is known is when the tracker saw the member's signed-up id change; a view taken before that is out of date.
 * A member the tracker has not seen, or a view of no known kind, is `unknown`, not `current`.
 *
 * @param {{kind?: string|null, capturedAt?: number}} view - A captured loadout
 * @param {number|null|undefined} changedAt - When that kind's signed-up id last changed, if it was seen to
 * @param {boolean} memberSeen - Whether the tracker holds this member
 * @returns {'stale'|'current'|'unknown'}
 */
export function loadoutViewStatus(view, changedAt, memberSeen) {
    if (!memberSeen || (view?.kind !== 'combat' && view?.kind !== 'skilling')) return 'unknown';
    if (!Number.isFinite(view.capturedAt)) return 'unknown';
    return Number.isFinite(changedAt) && changedAt > view.capturedAt ? 'stale' : 'current';
}
