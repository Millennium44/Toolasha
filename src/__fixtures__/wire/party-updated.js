/**
 * `party_updated` fixture. Shape from the game handler (handleMessagePartyUpdated) and the login payload's
 * `partyInfo`, NOT a captured message yet -- replace with a capture when one exists.
 */
export function buildPartyUpdated({ status = 'recruiting', actionHrid = '/actions/combat/fly', members = [] } = {}) {
    const partySlotMap = {};
    const sharableCharacterMap = {};
    members.forEach((member, index) => {
        sharableCharacterMap[member.id] = { name: member.name ?? `Name ${member.id}` };
        partySlotMap[String(index + 1)] = {
            characterID: member.id,
            characterLoadoutID: member.loadoutId ?? 0,
            isLeader: index === 0,
        };
    });
    return {
        type: 'party_updated',
        partyInfo: {
            party: { id: 5001, actionHrid, difficultyTier: 0, status },
            partySlotMap,
            sharableCharacterMap,
        },
    };
}
