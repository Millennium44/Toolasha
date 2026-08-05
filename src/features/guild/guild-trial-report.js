/**
 * The trial, written down for the guild to read.
 *
 * The per-player panel already copies a summary; this is the other thing people
 * do with it, which is paste it where the guild can see. That is a different
 * medium with different rules:
 *
 * - **No fixed-width font.** Discord renders plain messages proportionally, so
 *   columns padded with spaces do not line up and only look worse for having
 *   tried. Fields are separated by a consistent ` · ` instead, which reads as a
 *   column whatever the font does with it.
 * - **Short lines.** A line that wraps in a chat window has lost its shape
 *   anyway, so each player is one compact line and nothing is padded out to a
 *   width.
 * - **No markup.** Nothing here is HTML, and nothing assumes a code block —
 *   somebody will paste it without one.
 *
 * ## What it says that the panel does not
 *
 * How close the party came. A trial that ends is either "we cleared T5" or "we
 * cleared T5 and were four fifths of the way through T6 when the hour went",
 * and those are very different pieces of news for a guild deciding whether to
 * sign one more person up. The panel has never said it because it is only
 * interesting once the trial is over; the report is written at exactly that
 * moment.
 *
 * Everything here is pure — it takes a breakdown and some numbers and returns a
 * string — so what the guild is shown can be tested without a socket, a clock or
 * a panel.
 */

import { formatWithSeparator } from '../../utils/formatters.js';

/** Longest player list a report will print before it summarises the tail */
export const MAX_REPORT_PLAYERS = 12;

/**
 * A duration as a person would say it.
 * @param {number} ms - Milliseconds
 * @returns {string} e.g. `4m`, `35s`
 */
function shortTime(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '0s';
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
}

/** @param {number} value - A number @returns {string} With separators, rounded */
const whole = (value) => formatWithSeparator(Math.round(Number(value) || 0));

/**
 * How far into the next tier the party got before the hour ended.
 *
 * The interesting half of a trial result and the one nothing has reported. Given
 * the tier that was in progress, what was left on it and what it needed, this is
 * the fraction actually done — and it is stated as both, because "83%" and
 * "112,000 of 669,500 left" answer different questions and a guild asks both.
 *
 * @param {Object} input - Inputs
 * @param {number|null} input.tier - The tier that was in progress when it stopped
 * @param {number|null} input.remaining - What was left of it
 * @param {number|null} input.total - What it needed in full
 * @param {string} [input.unit] - `HP` or `work`
 * @returns {string|null} One line, or null when it cannot be said
 */
export function describeShortfall({ tier, remaining, total, unit = 'HP' } = {}) {
    if (!Number.isFinite(tier) || !Number.isFinite(total) || total <= 0) return null;
    if (!Number.isFinite(remaining) || remaining < 0) return null;

    if (remaining === 0) return `T${tier} finished exactly as the hour ended.`;

    const done = Math.max(0, Math.min(1, 1 - remaining / total));
    return `Stopped ${Math.round(done * 100)}% into T${tier} — ${whole(remaining)} of ${whole(total)} ${unit} left.`;
}

/**
 * One player's line.
 *
 * Damage first because that is what the list is ranked by, then the things that
 * are only mentioned when they happened: a player who healed nothing has no
 * healing on their line, and one who never died has no deaths. A line of zeroes
 * for every field reads as a report full of failures rather than a report of
 * what people did.
 *
 * @param {Object} player - A row from the breakdown
 * @param {Object} [support] - Their support row
 * @param {number} rank - Their position
 * @returns {string} The line
 */
export function playerLine(player, support, rank) {
    const parts = [`${rank}. ${player.name}`, `${whole(player.damage)} dmg`];

    if (Number.isFinite(player.share)) parts.push(`${player.share.toFixed(0)}%`);
    if (Number.isFinite(player.dps)) parts.push(`${whole(player.dps)}/s`);

    const healed = support?.healingDone || 0;
    if (healed > 0) parts.push(`healed ${whole(healed)}`);

    const taken = support?.damageTaken || 0;
    if (taken > 0) parts.push(`took ${whole(taken)}`);

    // Both of these are only ever mentioned because they happened
    if (player.deaths > 0) parts.push(`died ${player.deaths}×`);

    const outs = support?.manaOuts || 0;
    if (outs > 0) {
        const empty = support?.emptyManaMs || 0;
        parts.push(`ran dry ${outs}×${empty > 0 ? ` (~${shortTime(empty)})` : ''}`);
    }

    return parts.join(' · ');
}

/**
 * The whole report, ready to paste.
 *
 * @param {Object} input - Inputs
 * @param {string} [input.trialName] - What was fought
 * @param {number|null} [input.tiersCleared] - Tiers banked
 * @param {number|null} [input.tier] - The tier in progress when it ended
 * @param {Object} input.breakdown - From `guildTrialDamage.breakdown()`
 * @param {Object} [input.shortfall] - `{remaining, total, unit}` for the tier in progress
 * @param {Object} [input.estimate] - From `estimateDamageSplit`, used when nothing was measured
 * @returns {string} The report
 */
export function buildGuildReport({
    trialName = 'Guild trial',
    tiersCleared = null,
    tier = null,
    breakdown,
    shortfall,
    estimate = null,
} = {}) {
    const players = breakdown?.players || [];
    const support = breakdown?.support?.players || [];
    const supportFor = (index) => support.find((row) => row.index === index) || null;

    const headline = Number.isFinite(tiersCleared)
        ? `${trialName} — cleared ${tiersCleared} tier${tiersCleared === 1 ? '' : 's'}`
        : trialName;

    if (!players.length) {
        const close = describeShortfall({ tier, ...(shortfall || {}) });
        // A trial is simulated by the game from the members' builds, so there is
        // never a measurement to paste — but there is an estimate, and a guild
        // arguing about who to sign up wants it. Labelled at the top, where
        // somebody skimming a chat message will actually read it
        if (estimate?.players?.length) {
            const lines = [
                headline,
                'Per-player figures below are ESTIMATED FROM BUILDS — the game does not expose real ' +
                    'per-player trial figures.',
                `Est. party · ~${whole(estimate.total)}/s from ${estimate.covered} of ${estimate.of} builds`,
            ];

            estimate.players
                .slice(0, MAX_REPORT_PLAYERS)
                .forEach((player, index) =>
                    lines.push(
                        `${index + 1}. ${player.name} · ~${whole(player.dps)}/s` +
                            (Number.isFinite(player.share) ? ` · ${player.share.toFixed(0)}%` : '')
                    )
                );
            if (estimate.players.length > MAX_REPORT_PLAYERS) {
                lines.push(`…and ${estimate.players.length - MAX_REPORT_PLAYERS} more`);
            }
            if (estimate.unestimated.length) {
                lines.push(`No build captured, so not estimated · ${estimate.unestimated.join(', ')}`);
            }
            if (close) lines.push(close);
            return lines.join('\n');
        }

        // Not "no trial fight seen", which promises a fight that could arrive:
        // the trial is simulated by the game and no client is in it
        const why =
            breakdown?.reason ||
            'the trial is simulated by the game from the signed-up members’ builds, so no client fights it';
        return [headline, `Nothing was measured here — ${why}.`, ...(close ? [close] : [])].join('\n');
    }

    const lines = [headline];

    const seconds = breakdown.seconds || 0;
    const total = breakdown.totalDamage || 0;
    lines.push(
        `Party · ${whole(total)} dmg` +
            (seconds > 0 ? ` in ${shortTime(seconds * 1000)} · ${whole(total / seconds)}/s` : '')
    );

    const ranked = players.slice(0, MAX_REPORT_PLAYERS);
    ranked.forEach((player, index) => lines.push(playerLine(player, supportFor(player.index), index + 1)));
    if (players.length > ranked.length) {
        lines.push(`…and ${players.length - ranked.length} more`);
    }

    const healed = breakdown?.support?.totals?.healingDone || 0;
    const unattributed = breakdown?.support?.unattributedHealing || 0;
    if (healed > 0 || unattributed > 0) {
        lines.push(
            `Healing · ${whole(healed)} attributed` +
                (unattributed > 0 ? ` · ${whole(unattributed)} unattributed (regen, or two healers at once)` : '')
        );
    }

    const close = describeShortfall({ tier, ...(shortfall || {}) });
    if (close) lines.push(close);

    // Said once, at the bottom, because a guild reading a table of numbers
    // should know the game did not produce them
    lines.push('(estimated from the battle feed — only fights this client took part in are counted)');

    return lines.join('\n');
}
