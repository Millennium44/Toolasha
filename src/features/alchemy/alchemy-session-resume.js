/**
 * Carrying one alchemy run across a page reload.
 *
 * ## What a reload loses
 *
 * The game keeps acting while the client is away. A batch that completes
 * during the few seconds a reload takes is never delivered as an
 * `action_completed` — no socket is open to deliver it to — and the login
 * snapshot the new page starts from already contains it. Measured live on
 * coinify: the page before the reload recorded counts up to 18, the new page's
 * snapshot said 21, and the three attempts between were in nobody's record.
 * Starting a fresh session from the snapshot, as a queue start does, therefore
 * split the run in two and dropped the batch in the gap. The read-time merge
 * (`alchemy-session-merge.js`) rightly refused to rejoin the halves: a
 * completed action had hidden in the gap, which is exactly what its threshold
 * exists to catch.
 *
 * ## The resume point
 *
 * Every recorded message leaves a resume point on its session: the queue
 * action's id and `currentCount`, and the totals of every stack the tracker
 * measures, as the inventory stood once that message had been applied. After a
 * reload, if the same queue action is still running — the same id, its count
 * not gone backwards — the session is resumed rather than replaced, and the
 * gap is read as one more message: attempts from the counts, gains from the
 * stacks, against the stored point. The run stays one record and the batch in
 * the gap is counted exactly.
 *
 * ## When it is not safe
 *
 * The gap bridge credits every change to the measured stacks since the resume
 * point to this action. That holds across a reload, where nothing else can have
 * run, and stops holding the longer the tab was away — the player can trade or
 * play from another device meanwhile. So a session is resumed only when it is
 * the tracker's latest, its last activity is recent, and the queue action is
 * the same one; anything else starts a new session as before.
 */

/** A session last active longer ago than this is not resumed. */
export const MAX_RESUME_GAP_MS = 10 * 60 * 1000;

/**
 * Where a session stands after a message: enough to measure the next one against.
 *
 * Only sound when `inventory` already reflects the message — a tracker reading
 * `action_completed` after dataManager has applied it.
 *
 * @param {Array<Object>|null} inventory - dataManager's cached `characterItems`
 * @param {Iterable<string|null>} itemHrids - The items the tracker measures
 * @param {*} actionId - The queue action's id
 * @param {number} currentCount - The action's count after the message
 * @param {number} [now] - Clock
 * @returns {Object|null} The resume point, or null when it cannot be taken
 */
export function captureResumePoint(inventory, itemHrids, actionId, currentCount, now = Date.now()) {
    if (!Array.isArray(inventory) || actionId === undefined || actionId === null) return null;
    if (!Number.isFinite(Number(currentCount))) return null;

    const hrids = [...new Set([...(itemHrids || [])].filter(Boolean))];
    const wanted = new Set(hrids);
    const stacks = [];
    for (const row of inventory) {
        if (!row || !wanted.has(row.itemHrid) || row.id === undefined || row.id === null) continue;
        const count = Number(row.count);
        if (!Number.isFinite(count)) continue;
        stacks.push({ id: row.id, itemHrid: row.itemHrid, count });
    }

    return { actionId, currentCount: Number(currentCount), at: now, hrids, stacks };
}

/**
 * The stored session a fresh page should carry on, if any.
 *
 * @param {Array<Object>} sessions - This tracker's stored sessions for the character
 * @param {Object} running - What is running now
 * @param {*} running.actionId - The queue action's id
 * @param {number} running.currentCount - Its count now
 * @param {string} running.inputItemHrid - The item in its primary slot
 * @param {number} [running.enhancementLevel] - The item's level, for coinify and decompose
 * @param {number} [now] - Clock
 * @returns {Object|null} The session to resume, or null to start a new one
 */
export function findResumableSession(sessions, running, now = Date.now()) {
    const list = Array.isArray(sessions) ? sessions.filter(Boolean) : [];
    if (list.length === 0 || running?.actionId === undefined || running?.actionId === null) return null;

    // Only the latest: a later session means something else was recorded in between
    const latest = list.reduce((a, b) => ((Number(b.startTime) || 0) > (Number(a.startTime) || 0) ? b : a));
    const point = latest.resumePoint;
    if (!point || point.actionId !== running.actionId) return null;
    if (latest.inputItemHrid !== running.inputItemHrid) return null;
    if (running.enhancementLevel !== undefined && (latest.enhancementLevel ?? 0) !== running.enhancementLevel) {
        return null;
    }
    if (!(Number(running.currentCount) >= Number(point.currentCount))) return null;

    const lastSeen = Number(latest.lastActivityTime ?? point.at);
    if (!Number.isFinite(lastSeen) || now - lastSeen > MAX_RESUME_GAP_MS || now < lastSeen) return null;

    return latest;
}

/**
 * The rows that read the gap since a resume point as one message.
 *
 * Every stack the point recorded is included at its total now — zero when it
 * has left the inventory — and every current stack of a measured item the point
 * did not know is included too, to be measured from zero.
 *
 * @param {Object} point - A resume point
 * @param {Array<Object>|null} inventory - dataManager's cached `characterItems`
 * @returns {Array<Object>} `endCharacterItems`-shaped rows
 */
export function gapRows(point, inventory) {
    const current = Array.isArray(inventory) ? inventory : [];
    const byId = new Map();
    for (const row of current) {
        if (row && row.id !== undefined && row.id !== null) byId.set(row.id, row);
    }

    const rows = [];
    const seen = new Set();
    for (const stack of point?.stacks || []) {
        const now = byId.get(stack.id);
        rows.push({ id: stack.id, itemHrid: stack.itemHrid, count: now ? Number(now.count) || 0 : 0 });
        seen.add(stack.id);
    }
    const hrids = new Set(point?.hrids || []);
    for (const row of current) {
        if (!row || seen.has(row.id) || !hrids.has(row.itemHrid)) continue;
        rows.push({ id: row.id, itemHrid: row.itemHrid, count: Number(row.count) || 0 });
    }
    return rows;
}

export default { MAX_RESUME_GAP_MS, captureResumePoint, findResumableSession, gapRows };
