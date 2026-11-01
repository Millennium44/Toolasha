/**
 * `party_updated` fixture. Shape from the game handler (handleMessagePartyUpdated) and the login payload's
 * `partyInfo`, NOT a captured message yet -- replace with a capture when one exists.
 */
export function buildPartyUpdated({ status = 'idle', actionHrid = '/actions/combat/fly', members = [] } = {}) {
    const partySlotMap = {};
    members.forEach((member, index) => {
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
            sharableCharacterMap: {},
        },
    };
}
