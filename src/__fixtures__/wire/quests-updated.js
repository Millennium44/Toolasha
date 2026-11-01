/**
 * `quests_updated`. Captured on the test server (MillenniumIC3), 2026-10-31.
 * Discarding a task sends the SAME id with `status: '/quest_status/discarded'`; the
 * server does not drop the id from the list.
 */

/** A task row; only the fields the capture established. */
export function buildQuest(overrides = {}) {
    return { id: 900101, status: '/quest_status/in_progress', actionHrid: '/actions/milking/cow', ...overrides };
}

/** The message sent when a task is discarded. */
export function buildQuestDiscarded(overrides = {}) {
    return {
        type: 'quests_updated',
        endCharacterQuests: [buildQuest({ status: '/quest_status/discarded' })],
        ...overrides,
    };
}
