import EventQueue from './events/event-queue.js';
import {
    skillingPool,
    skillingSuccessAtTier,
    trialRandom,
    summarizeTrialRuns,
    validateTrialScenario,
} from '../guild-trial-model.js';
import { TRIAL_MAX_TIER } from '../../guild/guild-trials-math.js';

const SECOND_NANOSECONDS = 1e9;

/** Simulate a shared work pool, individual action clocks and success/double rolls. */
export function simulateGuildSkilling(input, onProgress = () => {}) {
    const scenario = validateTrialScenario(input);
    const deadlineNs = Math.round(scenario.seconds * SECOND_NANOSECONDS);
    const attempts = [];
    for (let run = 0; run < scenario.runs; run++) {
        const random = trialRandom((scenario.seed + run * 0x9e3779b9) >>> 0);
        const queue = new EventQueue();
        scenario.members.forEach((member, index) =>
            queue.addEvent({ time: Math.round(member.actionSeconds * SECOND_NANOSECONDS), index, actionNumber: 1 })
        );
        let tier = scenario.startTier;
        let work = 0;
        let tierStartNs = 0;
        let lastTimeNs = 0;
        const tiers = [];
        while (tier <= TRIAL_MAX_TIER) {
            const event = queue.getNextEvent();
            if (!event || event.time > deadlineNs) break;
            lastTimeNs = event.time;
            const member = scenario.members[event.index];
            if (random() < skillingSuccessAtTier(member, tier)) {
                work += Math.floor(member.workPower) * (random() < member.doubleChance ? 2 : 1);
            }
            // Derive timestamps from the action count on an integer-nanosecond
            // timeline to avoid decimal-second drift at the deadline.
            const actionNumber = event.actionNumber + 1;
            const actionDuration = Math.round(member.actionSeconds * SECOND_NANOSECONDS);
            queue.addEvent({ time: actionNumber * actionDuration, index: event.index, actionNumber });
            if (work >= skillingPool(scenario, tier)) {
                tiers.push({
                    tier,
                    cleared: true,
                    seconds: (event.time - tierStartNs) / SECOND_NANOSECONDS,
                    progressFraction: 1,
                });
                tier++;
                tierStartNs = event.time;
                work = 0; // The completing action's surplus is not another tier's work.
            }
        }
        const complete = tier > TRIAL_MAX_TIER;
        if (!complete)
            tiers.push({
                tier,
                cleared: false,
                seconds: (deadlineNs - tierStartNs) / SECOND_NANOSECONDS,
                progressFraction: Math.min(1, work / skillingPool(scenario, tier)),
            });
        attempts.push({
            highestTier: tier - 1,
            seconds: complete ? lastTimeNs / SECOND_NANOSECONDS : scenario.seconds,
            reason: complete ? 'max-tier' : 'timeout',
            tiers,
        });
        onProgress(Math.round(((run + 1) / scenario.runs) * 100));
    }
    return summarizeTrialRuns(scenario, attempts);
}
