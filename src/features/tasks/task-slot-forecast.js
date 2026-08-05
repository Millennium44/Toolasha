/**
 * When the task board runs out of room.
 *
 * Tasks arrive on a fixed cadence into a fixed number of slots, and a task that
 * arrives with nowhere to go is gone — there is no queue behind the board. So
 * the one number worth knowing is when the last free slot fills, because that is
 * the deadline for clearing something.
 *
 * ## Where the numbers come from
 *
 * All four are on `characterInfo`, which the server sends with
 * `init_character_data` and re-sends on `character_info_updated` whenever any of
 * them moves:
 *
 * - `taskSlotCap` — how many tasks the board holds
 * - `taskCooldownHours` — the arrival cadence, as the server currently computes
 *   it for this character (a MooPass or a buff shortens it, and the server
 *   re-sends the new value rather than leaving it to be inferred)
 * - `lastTaskTimestamp` — when the most recent task arrived, which is what the
 *   cadence is measured from
 * - `unreadTaskCount` — tasks that have arrived and not yet been looked at
 *
 * Nothing here reads the board's "Next Task: 3h 3m" countdown. That string is
 * the same arithmetic done by the game, it is only on screen while the task
 * panel is open, and a projection that needs a panel open is a projection that
 * cannot warn anybody who is away — which is the entire case for having one.
 *
 * ## What it cannot know
 *
 * It is a projection, not an observation. It assumes the cadence holds and that
 * nothing frees a slot in the meantime; completing, claiming or discarding a
 * task moves the answer, and the answer is therefore recomputed rather than
 * remembered. And it can only be as fresh as the last message from the server:
 * a page that has been open through a disconnect is projecting from whatever it
 * was last told.
 */

/** Milliseconds in an hour */
const HOUR_MS = 3_600_000;

/**
 * How many of the character's quests are tasks currently sitting on the board.
 *
 * Counted rather than taken from a field because there is no field: the board's
 * occupancy is `unreadTaskCount` plus however many in-progress random tasks the
 * quest list holds.
 *
 * @param {Array<Object>|null|undefined} characterQuests - `dataManager.characterQuests`
 * @returns {number} Tasks on the board
 */
export function countActiveTasks(characterQuests) {
    if (!Array.isArray(characterQuests)) return 0;
    return characterQuests.filter(
        (quest) => quest?.category === '/quest_category/random_task' && quest?.status === '/quest_status/in_progress'
    ).length;
}

/**
 * When the task board fills, and when it starts wasting tasks.
 *
 * Two instants rather than one, because they are a cooldown apart and they mean
 * different things. The board is *full* when the last free slot takes a task —
 * that is the deadline for doing something about it. The first task is *wasted*
 * one cadence later, when another one arrives with nowhere to go.
 *
 * @param {Object} input - What the server last said
 * @param {Object} input.characterInfo - `characterData.characterInfo`
 * @param {number} [input.activeTaskCount=0] - Tasks on the board right now
 * @param {number} [input.now=Date.now()] - Clock, injectable for tests
 * @returns {{ok: boolean, reason?: string, slotCap?: number, usedSlots?: number,
 *   freeSlots?: number, isFull?: boolean, cooldownMs?: number, cooldownHours?: number,
 *   lastTaskAt?: number, fillsAt?: number, msUntilFull?: number, wastesAt?: number,
 *   msUntilWaste?: number}} The forecast, or why there isn't one
 */
export function forecastTaskSlots({ characterInfo, activeTaskCount = 0, now = Date.now() } = {}) {
    if (!characterInfo) return { ok: false, reason: 'no character info' };

    const slotCap = Math.floor(Number(characterInfo.taskSlotCap));
    const cooldownHours = Number(characterInfo.taskCooldownHours);
    const lastTaskAt = Date.parse(characterInfo.lastTaskTimestamp ?? '');

    // Each of the three is load-bearing, and a missing one is reported rather
    // than defaulted: a forecast built on a guessed cadence would announce a
    // deadline that is not the player's
    if (!(slotCap > 0)) return { ok: false, reason: 'no task slot cap' };
    if (!(cooldownHours > 0)) return { ok: false, reason: 'no task cooldown' };
    if (!Number.isFinite(lastTaskAt)) return { ok: false, reason: 'no last task time' };

    const unread = Math.max(0, Math.floor(Number(characterInfo.unreadTaskCount) || 0));
    const active = Math.max(0, Math.floor(Number(activeTaskCount) || 0));

    // Clamped both ways: a board cannot hold more than its cap, and a count that
    // says otherwise is a message read mid-update rather than a negative number
    // of free slots
    const usedSlots = Math.min(slotCap, unread + active);
    const freeSlots = Math.max(0, slotCap - usedSlots);
    const cooldownMs = cooldownHours * HOUR_MS;

    const fillsAt = lastTaskAt + freeSlots * cooldownMs;
    const wastesAt = fillsAt + cooldownMs;

    return {
        ok: true,
        slotCap,
        usedSlots,
        freeSlots,
        isFull: freeSlots === 0,
        cooldownMs,
        cooldownHours,
        lastTaskAt,
        fillsAt,
        msUntilFull: fillsAt - now,
        wastesAt,
        msUntilWaste: wastesAt - now,
    };
}
