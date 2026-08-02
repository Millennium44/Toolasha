/**
 * Enhancement overlay row
 *
 * What is on the anvil, what it has cost, and how far through it is.
 *
 * An enhancement run is the one activity where the interesting figure is not on
 * screen: the game shows the item and the level, and says nothing about how many
 * attempts in you are, what you have spent, or whether this is going better or
 * worse than it should. All of that is already tracked by the enhancement
 * feature — this is that state, one glance wide.
 *
 * ## Progress against expectation, not against the level
 *
 * The bar is attempts made over attempts expected, not current level over target
 * level. Levels are not evenly spaced: +1 to +2 is most of the way through
 * nothing and +14 to +15 can be the whole session, so a bar drawn on levels sits
 * at 90% for hours. Over 100% the bar stays full and the figure keeps counting,
 * because "this has taken twice what it should" is exactly the thing you want it
 * to be able to say.
 *
 * ## Not MCS's EWatch, despite the similar name
 *
 * This is Toolasha's own Equipment Watch tile and shows an enhancement run in
 * progress. MCS's EWatch is a different tool — what you are **saving up for** —
 * and is ported separately as Equipment Savings, in
 * `features/inventory/equipment-savings-row.js`.
 */

import { registerRow } from '../../utils/overlay-rows.js';
import { formatLargeNumber } from '../../utils/formatters.js';
import { drawLine, blank, shortDuration, ROW_COLORS } from '../../utils/overlay-format.js';
import enhancementTracker from './enhancement-tracker.js';

/** Under this many attempts a rate says nothing about how long the rest will take */
const MIN_ATTEMPTS_FOR_ESTIMATE = 5;

/**
 * What the running session looks like, or null when nothing is being enhanced.
 * @returns {Object|null} `{ name, level, target, cost, attempts, expected, progress, remainingSeconds }`
 */
export function enhancementProgress() {
    const session = enhancementTracker.getCurrentSession?.();
    if (!session) return null;

    const attempts = session.totalAttempts || 0;
    const expected = session.predictions?.expectedAttempts || 0;

    // Elapsed over attempts, rather than a fixed action time: the real rate
    // includes everything that actually stops you, which a nominal one does not
    const elapsed = (Date.now() - (session.startTime || Date.now())) / 1000;
    const perAttempt = attempts >= MIN_ATTEMPTS_FOR_ESTIMATE ? elapsed / attempts : null;
    const left = expected > attempts ? expected - attempts : 0;

    return {
        name: session.itemName || session.itemHrid || 'Enhancing',
        level: session.currentLevel ?? session.startLevel ?? 0,
        target: session.targetLevel ?? 0,
        cost: session.totalCost || 0,
        attempts,
        expected,
        progress: expected > 0 ? attempts / expected : null,
        remainingSeconds: perAttempt && left ? perAttempt * left : null,
    };
}

registerRow({
    key: 'equipmentWatch',
    name: 'Equipment Watch',
    defaultSize: { width: 280, height: 50 },
    render: (container) => {
        const run = enhancementProgress();
        if (!run) return blank(container);

        container.replaceChildren();
        Object.assign(container.style, {
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: '3px',
            lineHeight: '1.3',
            overflow: 'hidden',
        });

        const top = document.createElement('div');
        drawLine(top, [
            { text: `${run.name} +${run.level}`, color: ROW_COLORS.gold, bold: true, ellipsis: true },
            { text: formatLargeNumber(Math.round(run.cost)), push: true },
            { text: run.remainingSeconds ? shortDuration(run.remainingSeconds) : '—', color: ROW_COLORS.gold },
        ]);
        container.appendChild(top);

        if (run.progress !== null) {
            const line = document.createElement('div');
            Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '6px' });
            line.appendChild(progressBar(run.progress));

            const percent = document.createElement('span');
            percent.textContent = `${(run.progress * 100).toFixed(1)}%`;
            Object.assign(percent.style, { color: ROW_COLORS.dim, flex: '0 0 auto', fontSize: '90%' });
            line.appendChild(percent);
            container.appendChild(line);
        }

        container.title =
            `${run.attempts} attempts of about ${Math.round(run.expected)} expected, aiming for +${run.target}.\n` +
            'Progress is attempts against expectation, not levels — levels are not evenly spaced.';
    },
});

/**
 * A bar reading attempts made against attempts owed.
 * @param {number} fraction - Attempts ÷ expected; may exceed 1
 * @returns {HTMLElement} The bar
 */
function progressBar(fraction) {
    const track = document.createElement('div');
    Object.assign(track.style, {
        flex: '1',
        height: '4px',
        background: 'rgba(255, 255, 255, 0.12)',
        borderRadius: '2px',
        overflow: 'hidden',
        marginTop: '1px',
    });

    const fill = document.createElement('div');
    Object.assign(fill.style, {
        height: '100%',
        width: `${Math.min(100, fraction * 100).toFixed(1)}%`,
        // Past expectation the bar can say no more, so the colour carries it:
        // this run has cost more than it should have
        background: fraction > 1 ? '#f87171' : '#4ade80',
        transition: 'width 0.3s',
    });

    track.appendChild(fill);
    return track;
}
