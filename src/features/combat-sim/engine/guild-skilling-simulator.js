import EventQueue from './events/event-queue.js';
import {
    skillingPool,
    skillingSuccessAtTier,
    trialRandom,
    summarizeTrialRuns,
    validateTrialScenario,
} from '../guild-trial-model.js';
import { TRIAL_MAX_TIER } from '../../guild/guild-trials-math.js';

/** Simulate a shared work pool, individual action clocks and success/double rolls. */
export function simulateGuildSkilling(input, onProgress = () => {}) {
    const scenario = validateTrialScenario(input);
    const attempts = [];
    for (let run = 0; run < scenario.runs; run++) {
        const random = trialRandom((scenario.seed + run * 0x9e3779b9) >>> 0);
        const queue = new EventQueue();
        scenario.members.forEach((member, index) => queue.addEvent({ time: member.actionSeconds, index }));
        let tier = scenario.startTier;
        let work = 0;
        let tierStart = 0;
        let lastTime = 0;
        const tiers = [];
        while (tier <= TRIAL_MAX_TIER) {
            const event = queue.getNextEvent();
            if (!event || event.time > scenario.seconds) break;
            lastTime = event.time;
            const member = scenario.members[event.index];
            if (random() < skillingSuccessAtTier(member, tier)) {
                work += Math.floor(member.workPower) * (random() < member.doubleChance ? 2 : 1);
            }
            queue.addEvent({ time: event.time + member.actionSeconds, index: event.index });
            if (work >= skillingPool(scenario, tier)) {
                tiers.push({ tier, cleared: true, seconds: event.time - tierStart });
                tier++;
                tierStart = event.time;
                work = 0; // The completing action's surplus is not another tier's work.
            }
        }
        const complete = tier > TRIAL_MAX_TIER;
        if (!complete) tiers.push({ tier, cleared: false, seconds: scenario.seconds - tierStart });
        attempts.push({
            highestTier: tier - 1,
            seconds: complete ? lastTime : scenario.seconds,
            reason: complete ? 'max-tier' : 'timeout',
            tiers,
        });
        onProgress(Math.round(((run + 1) / scenario.runs) * 100));
    }
    return summarizeTrialRuns(scenario, attempts);
}
