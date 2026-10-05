/** Preserve simulator inputs already collected by the user's game/profile clicks. */
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import webSocketHook from '../../core/websocket.js';
import { getLoadouts, VIEW_LOADOUT_CONTEXT } from '../../utils/view-loadout.js';
import { VALID_PLAYER_NAME_RE } from '../../utils/profile-command.js';
import { COMBAT_ENCOUNTERS, TRIAL_SKILLS } from './guild-trials-math.js';

const MAX_TRIAL_PROFILES = 300;
const openedProfiles = new Map();
let restoredLoadouts = [];
let profileHandler = null;
let profileOwner = null;

export const MAX_TRIAL_INPUT_BYTES = 20_000_000;
const MAX_SAVED_CAPTURES = 8;

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value) =>
    (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
    (typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)));
const validTime = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const sameCaptureSet = (left, right) =>
    left.weekStartAt === right.weekStartAt &&
    left.host === right.host &&
    (left.guildID != null && right.guildID != null
        ? String(left.guildID) === String(right.guildID)
        : left.guildName === right.guildName);
const storageKey = (owner) => `guild_trial_inputs_${owner}`;

function newest(entries, key, time) {
    const result = new Map();
    for (const entry of entries) {
        const id = key(entry);
        if (!result.has(id) || time(entry) >= time(result.get(id))) result.set(id, entry);
    }
    return [...result.values()];
}

/**
 * The current week's trial signups, with the trial each one signed up for per kind.
 *
 * Takes the guild XP tracker as an argument rather than importing it: this module
 * is shared through the utils bundle, the tracker lives in the combat bundle.
 * @param {Object} tracker - The guild XP tracker (member list, member metas, current week)
 * @returns {Array<{characterId: string, name: string, trials: {combat?: string, skilling?: string}}>}
 *   Sorted by name; empty until the tracker knows the week
 */
export function trialSignupRoster(tracker) {
    const week = tracker?.getCurrentWeekStartAt?.();
    if (!week) return [];
    const roster = [];
    for (const member of tracker.getMemberList?.() || []) {
        const meta = tracker.getMemberMeta?.(member.characterID) || member;
        if (meta.signupWeekStartAt !== week || !VALID_PLAYER_NAME_RE.test(meta.name || '')) continue;
        const trials = {};
        if (meta.signedUpCombatTrialHrid) trials.combat = meta.signedUpCombatTrialHrid;
        if (meta.signedUpSkillingTrialHrid) trials.skilling = meta.signedUpSkillingTrialHrid;
        if (Object.keys(trials).length && member.characterID != null)
            roster.push({ characterId: String(member.characterID), name: meta.name, trials });
    }
    return roster.sort((a, b) => a.name.localeCompare(b.name));
}

/** Trial captures restored explicitly from this character's saved input set, plus newer live responses. */
export function trialSimulationLoadouts() {
    const owner = dataManager.getCurrentCharacterId();
    return newest(
        [...(owner != null && String(owner) === profileOwner ? restoredLoadouts : []), ...getLoadouts()],
        (entry) => JSON.stringify([entry.ownerCharacterId, entry.characterId ?? entry.name, entry.context, entry.kind]),
        (entry) => entry.capturedAt || 0
    );
}

/** Session profiles available to the capture helper. Treat their contents as read-only. */
export function trialSimulationProfiles() {
    const owner = dataManager.getCurrentCharacterId();
    return owner != null && String(owner) === profileOwner ? [...openedProfiles.values()] : [];
}

/** Forget the departing character/guild's in-memory profile copies. */
export function clearTrialSimulationProfiles() {
    openedProfiles.clear();
    restoredLoadouts = [];
    profileOwner = dataManager.getCurrentCharacterId() == null ? null : String(dataManager.getCurrentCharacterId());
}

/** Restore validated inputs without changing the game's loadouts or the general profile cache. */
export function restoreTrialSimulationInputs(bundle) {
    const checked = validateTrialInputBundle(bundle);
    if (!profileHandler) startTrialSimulationCapture();
    const profiles = newest(
        [...checked.simulationInputs.profiles, ...trialSimulationProfiles()],
        (entry) => String(entry.characterID),
        (entry) => entry.timestamp || 0
    );
    for (const profile of profiles) openedProfiles.set(String(profile.characterID), structuredClone(profile));
    while (openedProfiles.size > MAX_TRIAL_PROFILES) openedProfiles.delete(openedProfiles.keys().next().value);
    restoredLoadouts = newest(
        [...restoredLoadouts, ...checked.simulationInputs.viewLoadouts],
        (entry) => JSON.stringify([entry.characterId ?? entry.name, entry.kind]),
        (entry) => entry.capturedAt || 0
    );
}

/** Keep up to one guild's opened public profiles while Guild Trials is enabled. No requests are sent. */
export function startTrialSimulationCapture() {
    if (profileHandler) return;
    clearTrialSimulationProfiles();
    profileHandler = (message) => {
        const current = dataManager.getCurrentCharacterId();
        if (current == null) return;
        if (String(current) !== profileOwner) clearTrialSimulationProfiles();
        const profile = message?.profile;
        const id =
            profile?.sharableCharacter?.id || profile?.characterSkills?.[0]?.characterID || profile?.character?.id;
        if (!profile || id == null) return;
        const key = String(id);
        openedProfiles.delete(key);
        openedProfiles.set(key, {
            characterID: id,
            characterName: profile.sharableCharacter?.name || 'Unknown',
            timestamp: Date.now(),
            profile: structuredClone(profile),
        });
        while (openedProfiles.size > MAX_TRIAL_PROFILES) openedProfiles.delete(openedProfiles.keys().next().value);
    };
    webSocketHook.on('profile_shared', profileHandler);
}

/** Stop passive collection and discard in-memory copies; explicitly saved captures stay in the library. */
export function stopTrialSimulationCapture() {
    if (profileHandler) webSocketHook.off('profile_shared', profileHandler);
    profileHandler = null;
    clearTrialSimulationProfiles();
}

/**
 * Export dated trial loadouts, matching cached profiles, and the current building definitions/levels.
 * No requests are made. Captures can predate the run; their timestamps remain authoritative.
 * @param {string|number|null} characterId - The exporting character
 * @param {Array<{characterID?: *, name?: string}>} roster - Current guild, when known
 * @returns {Promise<Object|null>} A snapshot, or null if the character changed during the read
 */
export async function captureTrialSimulationInputs(characterId, roster = []) {
    if (characterId == null) return null;
    const owner = String(characterId);
    if (String(dataManager.getCurrentCharacterId()) !== owner) return null;
    const memberIds = new Set(
        roster.filter((member) => member.characterID != null).map((member) => String(member.characterID))
    );
    const memberNames = new Set(roster.map((member) => String(member.name || '').toLowerCase()).filter(Boolean));
    const viewLoadouts = structuredClone(
        trialSimulationLoadouts().filter(
            (entry) =>
                entry.context === VIEW_LOADOUT_CONTEXT.GuildTrial &&
                entry.ownerCharacterId === owner &&
                roster.length > 0 &&
                (entry.characterId != null
                    ? memberIds.has(String(entry.characterId))
                    : memberNames.has(String(entry.name || '').toLowerCase()))
        )
    );
    const clientData = dataManager.getInitClientData();
    const snapshot = {
        version: 1,
        capturedAt: Date.now(),
        ownerCharacterId: owner,
        viewLoadouts,
        guildBuildingLevelMap: structuredClone(dataManager.guildBuildingLevelMap || {}),
        guildBuildingDetailMap: structuredClone(clientData?.guildBuildingDetailMap || {}),
        guildBuffDetailMap: structuredClone(clientData?.guildBuffDetailMap || {}),
        guildTrialDetailMap: structuredClone(clientData?.guildTrialDetailMap || {}),
        buffTypeDetailMap: structuredClone(clientData?.buffTypeDetailMap || {}),
        profiles: [],
        profileCacheRead: true,
        rosterKnown: roster.length > 0,
    };
    let profiles;
    try {
        profiles = await storage.getJSON('profile_list', 'combatExport', []);
    } catch {
        snapshot.profileCacheRead = false;
        profiles = [];
    }
    if (String(dataManager.getCurrentCharacterId()) !== owner) return null;
    const combined = new Map();
    for (const profile of [
        ...(Array.isArray(profiles) ? profiles : []),
        ...(profileOwner === owner ? openedProfiles.values() : []),
    ]) {
        if (profile?.characterID == null) continue;
        const key = String(profile.characterID);
        if (!combined.has(key) || (profile.timestamp || 0) >= (combined.get(key).timestamp || 0))
            combined.set(key, profile);
    }
    snapshot.profiles = structuredClone(
        [...combined.values()].filter((profile) => roster.length > 0 && memberIds.has(String(profile.characterID)))
    );
    return snapshot;
}

/** Validate a capture export before it can enter the local library or simulator. */
export function validateTrialInputBundle(value, { owner = dataManager.getCurrentCharacterId(), host } = {}) {
    if (host === undefined) host = typeof location === 'undefined' ? null : location.hostname;
    if (!record(value) || value.format !== 'toolasha-guild-trial-inputs' || value.version !== 1)
        throw new Error('Choose a Trial Input Capture JSON export (version 1).');
    const inputs = value.simulationInputs;
    if (!record(inputs) || inputs.version !== 1 || !validId(inputs.ownerCharacterId))
        throw new Error('The capture has invalid simulation inputs.');
    if (!validId(owner) || String(inputs.ownerCharacterId) !== String(owner))
        throw new Error('This capture belongs to a different exporting character. Switch to that character first.');
    if (host && value.host !== host) throw new Error('This capture belongs to a different game server.');
    if (
        typeof value.guildName !== 'string' ||
        !value.guildName.trim() ||
        value.guildName.length > 200 ||
        (value.guildID != null && !validId(value.guildID)) ||
        typeof value.weekStartAt !== 'string' ||
        !Number.isFinite(Date.parse(value.weekStartAt)) ||
        typeof value.exportedAt !== 'string' ||
        !Number.isFinite(Date.parse(value.exportedAt)) ||
        !validTime(value.capturedSince) ||
        !Array.isArray(value.coverage) ||
        !value.coverage.length ||
        value.coverage.length > MAX_TRIAL_PROFILES
    )
        throw new Error('The capture has invalid guild, date or signup information.');
    const ids = new Set();
    const names = new Set();
    for (const member of value.coverage) {
        if (
            !record(member) ||
            !validId(member.characterId) ||
            ids.has(String(member.characterId)) ||
            typeof member.name !== 'string' ||
            !member.name.trim() ||
            member.name.length > 100 ||
            !record(member.trials) ||
            (!member.trials.combat && !member.trials.skilling) ||
            Object.keys(member.trials).some((kind) => !['combat', 'skilling'].includes(kind)) ||
            (member.trials.combat != null &&
                !COMBAT_ENCOUNTERS.some((name) => member.trials.combat === `/guild_combat/${name}`)) ||
            (member.trials.skilling != null &&
                !TRIAL_SKILLS.some((name) => member.trials.skilling === `/guild_skilling/${name}`))
        )
            throw new Error('The capture has invalid or duplicate signup members.');
        ids.add(String(member.characterId));
        names.add(member.name.toLowerCase());
    }
    if (
        !Array.isArray(inputs.viewLoadouts) ||
        inputs.viewLoadouts.length > MAX_TRIAL_PROFILES * 2 ||
        !Array.isArray(inputs.profiles) ||
        inputs.profiles.length > MAX_TRIAL_PROFILES
    )
        throw new Error('The capture has invalid loadout or profile lists.');
    for (const entry of inputs.viewLoadouts) {
        if (
            !record(entry) ||
            String(entry.ownerCharacterId) !== String(owner) ||
            entry.context !== VIEW_LOADOUT_CONTEXT.GuildTrial ||
            (entry.kind != null && !['combat', 'skilling'].includes(entry.kind)) ||
            !validTime(entry.capturedAt) ||
            typeof entry.hasLoadout !== 'boolean' ||
            (entry.hasLoadout && !record(entry.loadout)) ||
            (entry.characterId != null
                ? !validId(entry.characterId) || !ids.has(String(entry.characterId))
                : !names.has(String(entry.name || '').toLowerCase()))
        )
            throw new Error('The capture contains a loadout outside its signup roster or with invalid data.');
    }
    for (const entry of inputs.profiles) {
        const profileId = entry?.profile?.sharableCharacter?.id;
        if (
            !record(entry) ||
            !validId(entry.characterID) ||
            !ids.has(String(entry.characterID)) ||
            !validTime(entry.timestamp) ||
            !record(entry.profile) ||
            (profileId != null && String(profileId) !== String(entry.characterID)) ||
            (Array.isArray(entry.profile.characterSkills) &&
                entry.profile.characterSkills.some(
                    (skill) =>
                        !record(skill) ||
                        (skill.characterID != null && String(skill.characterID) !== String(entry.characterID))
                ))
        )
            throw new Error('The capture contains an invalid or mismatched player profile.');
    }
    for (const key of [
        'guildBuildingLevelMap',
        'guildBuildingDetailMap',
        'guildBuffDetailMap',
        'guildTrialDetailMap',
        'buffTypeDetailMap',
    ]) {
        if (!record(inputs[key])) throw new Error(`The capture is missing ${key}.`);
    }
    if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_TRIAL_INPUT_BYTES)
        throw new Error('Capture JSON must be smaller than 20 MB.');
    const checked = structuredClone(value);
    if (checked.guildID == null && inputs.profiles.length) {
        const guildIds = new Set(inputs.profiles.map((entry) => String(entry.profile.guildId)));
        if (
            guildIds.size === 1 &&
            inputs.profiles.every(
                (entry) => validId(entry.profile.guildId) && entry.profile.guildName === checked.guildName
            )
        )
            checked.guildID = inputs.profiles[0].profile.guildId;
    }
    return checked;
}

/** Read capture JSON as data; this also accepts exports created before saved captures were added. */
export function parseTrialInputBundle(text) {
    if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_TRIAL_INPUT_BYTES)
        throw new Error('Capture JSON must be smaller than 20 MB.');
    return validateTrialInputBundle(JSON.parse(text));
}

/**
 * Game-data maps a capture carries for its file but the simulator never reads
 * back out of one. A saved copy leaves them empty and is given the client's
 * current maps again on load.
 */
const UNREAD_GAME_MAPS = ['guildBuffDetailMap', 'guildTrialDetailMap'];

/**
 * The stored form of a capture: no repeated copies of static game data.
 *
 * `guildBuildingDetailMap` stays whole, because the simulator turns it into the
 * guild's building buffs and its values are what the game said on the capture's
 * date. `buffTypeDetailMap` is read only for those buffs' `isCombat` flags, so
 * it keeps just the buff types the buildings name, still as dated.
 * @param {Object} bundle - A validated capture
 * @returns {Object} A shallow copy holding the compacted inputs
 */
function compactForStorage(bundle) {
    const inputs = bundle.simulationInputs;
    const used = new Set();
    for (const detail of Object.values(inputs.guildBuildingDetailMap || {})) {
        for (const buff of detail?.buffs || []) if (buff?.typeHrid) used.add(buff.typeHrid);
    }
    const compact = {
        ...inputs,
        buffTypeDetailMap: Object.fromEntries(
            Object.entries(inputs.buffTypeDetailMap || {}).filter(([hrid]) => used.has(hrid))
        ),
    };
    for (const key of UNREAD_GAME_MAPS) compact[key] = {};
    return { ...bundle, simulationInputs: compact };
}

/**
 * A stored capture as the simulator expects one: the maps left out on save come
 * from the client's current game data, and the dated buff types win over it.
 * @param {Object} bundle - A capture read back from storage
 * @returns {Object} A shallow copy with the game-data maps filled in
 */
function expandFromStorage(bundle) {
    const clientData = dataManager.getInitClientData?.() || {};
    const inputs = { ...bundle.simulationInputs };
    for (const key of UNREAD_GAME_MAPS) {
        if (!Object.keys(inputs[key] || {}).length) inputs[key] = clientData[key] || {};
    }
    inputs.buffTypeDetailMap = { ...(clientData.buffTypeDetailMap || {}), ...(inputs.buffTypeDetailMap || {}) };
    return { ...bundle, simulationInputs: inputs };
}

/** Read up to eight locally saved guild/week captures for the current exporting character. */
function checkedSavedBundles(saved, owner) {
    if (!Array.isArray(saved)) return [];
    const result = [];
    for (const bundle of saved.slice(0, MAX_SAVED_CAPTURES)) {
        try {
            result.push(validateTrialInputBundle(bundle, { owner }));
        } catch {
            // An unrelated/corrupt stored record cannot become a simulation input.
        }
    }
    return result.sort((a, b) => Date.parse(b.exportedAt) - Date.parse(a.exportedAt));
}

/** Read up to eight locally saved guild/week captures for the current exporting character. */
export async function loadSavedTrialInputBundles(owner = dataManager.getCurrentCharacterId()) {
    if (!validId(owner)) return [];
    return checkedSavedBundles(await storage.getJSON(storageKey(owner), 'combatExport', []), owner).map(
        expandFromStorage
    );
}

function mergeCapture(previous, incoming) {
    if (!previous) return incoming;
    const recent = Date.parse(previous.exportedAt) > Date.parse(incoming.exportedAt) ? previous : incoming;
    const ids = new Set(recent.coverage.map((member) => String(member.characterId)));
    const names = new Set(recent.coverage.map((member) => member.name.toLowerCase()));
    return {
        ...recent,
        simulationInputs: {
            ...recent.simulationInputs,
            profiles: newest(
                [...previous.simulationInputs.profiles, ...incoming.simulationInputs.profiles],
                (entry) => String(entry.characterID),
                (entry) => entry.timestamp
            ).filter((entry) => ids.has(String(entry.characterID))),
            viewLoadouts: newest(
                [...previous.simulationInputs.viewLoadouts, ...incoming.simulationInputs.viewLoadouts],
                (entry) => JSON.stringify([entry.characterId ?? entry.name, entry.kind]),
                (entry) => entry.capturedAt
            ).filter((entry) =>
                entry.characterId != null
                    ? ids.has(String(entry.characterId))
                    : names.has(String(entry.name || '').toLowerCase())
            ),
        },
    };
}

/** Save the latest inputs per guild/week locally; fresh responses preserve newer captures in the same set. */
export async function saveTrialInputBundle(bundle) {
    const checked = validateTrialInputBundle(bundle);
    const owner = checked.simulationInputs.ownerCharacterId;
    const outcome = await storage.update(
        storageKey(owner),
        (current) => {
            const saved = checkedSavedBundles(current, owner);
            const merged = mergeCapture(
                saved.find((entry) => sameCaptureSet(entry, checked)),
                checked
            );
            return [merged, ...saved.filter((entry) => !sameCaptureSet(entry, checked))]
                .sort((a, b) => Date.parse(b.exportedAt) - Date.parse(a.exportedAt))
                .slice(0, MAX_SAVED_CAPTURES)
                .map(compactForStorage);
        },
        'combatExport'
    );
    if (!outcome?.written) throw new Error('The browser could not save the capture. Keep your exported JSON backup.');
    return expandFromStorage(structuredClone(outcome.value.find((entry) => sameCaptureSet(entry, checked))));
}
