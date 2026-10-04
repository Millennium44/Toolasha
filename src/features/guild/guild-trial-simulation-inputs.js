/** Preserve simulator inputs already collected by the user's game/profile clicks. */
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import webSocketHook from '../../core/websocket.js';
import { getLoadouts, VIEW_LOADOUT_CONTEXT } from '../../utils/view-loadout.js';

const MAX_TRIAL_PROFILES = 100;
const openedProfiles = new Map();
let profileHandler = null;
let profileOwner = null;

/** Forget the departing character/guild's in-memory profile copies. */
export function clearTrialSimulationProfiles() {
    openedProfiles.clear();
    profileOwner = dataManager.getCurrentCharacterId() == null ? null : String(dataManager.getCurrentCharacterId());
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

/** Stop passive collection and discard the session-only profiles. Export before refreshing. */
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
        getLoadouts().filter(
            (entry) =>
                entry.context === VIEW_LOADOUT_CONTEXT.GuildTrial &&
                entry.ownerCharacterId === owner &&
                roster.length > 0 &&
                ((entry.characterId != null && memberIds.has(String(entry.characterId))) ||
                    memberNames.has(String(entry.name || '').toLowerCase()))
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
        [...combined.values()].filter((profile) =>
            viewLoadouts.some((entry) =>
                entry.characterId != null
                    ? String(profile?.characterID) === String(entry.characterId)
                    : String(entry.name || '').toLowerCase() === String(profile?.characterName || '').toLowerCase()
            )
        )
    );
    return snapshot;
}
