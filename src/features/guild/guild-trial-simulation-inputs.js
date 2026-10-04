/** Preserve simulator inputs already collected by the user's game/profile clicks. */
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { getLoadouts, VIEW_LOADOUT_CONTEXT } from '../../utils/view-loadout.js';

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
                (!roster.length ||
                    (entry.characterId != null && memberIds.has(String(entry.characterId))) ||
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
    };
    let profiles;
    try {
        profiles = await storage.getJSON('profile_list', 'combatExport', []);
    } catch {
        snapshot.profileCacheRead = false;
        profiles = [];
    }
    if (String(dataManager.getCurrentCharacterId()) !== owner) return null;
    snapshot.profiles = structuredClone(
        (Array.isArray(profiles) ? profiles : []).filter((profile) =>
            viewLoadouts.some((entry) =>
                entry.characterId != null
                    ? String(profile?.characterID) === String(entry.characterId)
                    : String(entry.name || '').toLowerCase() === String(profile?.characterName || '').toLowerCase()
            )
        )
    );
    return snapshot;
}
