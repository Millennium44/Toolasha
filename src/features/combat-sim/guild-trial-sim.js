/** Opt-in, local Guild Trial Simulator. Its setup stays in memory for this character. */
import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import webSocketHook from '../../core/websocket.js';
import { createPanel, panelCard, panelNote, panelLine } from '../../utils/simple-panel.js';
import { registerCommand, unregisterCommand } from '../../utils/command-registry.js';
import { VIEW_LOADOUT_CONTEXT } from '../../utils/view-loadout.js';
import { guildXpTracker } from '../../utils/bundle-bridge.js';
import {
    buildPlayerDTO,
    buildPlayerDTOFromLoadout,
    parseShykaiImport,
    getCommunityBuffs,
} from './combat-sim-adapter.js';
import { buildExtraBuffs } from './combat-sim-runner.js';
import { runGuildTrialSimulation } from './guild-trial-runner.js';
import {
    buildTrialGameData,
    trialBuildingBuffs,
    memberFromSkillingReading,
    baseWorkFromSkillingReading,
} from './guild-trial-adapter.js';
import { validateTrialScenario, skillingWorkPerSecond, anchorSkillingSuccessCurve } from './guild-trial-model.js';
import { COMBAT_ENCOUNTERS, TRIAL_SKILLS, levelFromTier } from '../guild/guild-trials-math.js';
import {
    trialSimulationProfiles,
    trialSimulationLoadouts,
    parseTrialInputBundle,
    validateTrialInputBundle,
    loadSavedTrialInputBundles,
    saveTrialInputBundle,
    MAX_TRIAL_INPUT_BYTES,
} from '../guild/guild-trial-simulation-inputs.js';
import { TrialAssignPlanner } from './guild-trial-assign-ui.js';

const ACCENT = '#b9a6ff';
const BUTTON_CLASS = 'toolasha-guild-trial-sim-button';
const EXTRA_BUFFS = [
    ['damage', 'Damage %', true],
    ['attack_speed', 'Attack speed %', true],
    ['cast_speed', 'Cast speed %', false],
    ['max_hitpoints', 'HP %', true],
    ['max_manapoints', 'MP %', true],
    ['armor', 'Armor %', true],
    ['ability_haste', 'Ability haste', false],
];

function button(parent, label, handler, disabled = false) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.disabled = disabled;
    element.style.cssText =
        'padding:5px 9px;border:1px solid #655881;border-radius:5px;background:#302941;color:#eee;cursor:pointer;';
    element.addEventListener('click', handler);
    parent.appendChild(element);
    return element;
}

function row(parent) {
    const element = document.createElement('div');
    element.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin:8px 0;';
    parent.appendChild(element);
    return element;
}

function field(parent, label, value, change, { type = 'number', min, max, step = 'any', disabled = false } = {}) {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;flex-direction:column;gap:3px;flex:1;min-width:85px;';
    const caption = document.createElement('span');
    caption.textContent = label;
    const input = document.createElement('input');
    input.type = type;
    input.value =
        type === 'number' && typeof value === 'number' && Number.isFinite(value)
            ? Number(value.toPrecision(12))
            : value;
    input.disabled = disabled;
    input.style.cssText =
        'width:100%;box-sizing:border-box;background:#1b2030;color:#eee;border:1px solid #495268;border-radius:4px;padding:5px;';
    if (type === 'number') {
        input.step = step;
        if (min !== undefined) input.min = min;
        if (max !== undefined) input.max = max;
    }
    input.addEventListener('input', () => change(type === 'number' ? Number(input.value) : input.value));
    wrapper.append(caption, input);
    parent.appendChild(wrapper);
    return input;
}

function select(parent, label, value, options, change, disabled = false) {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;flex-direction:column;gap:3px;flex:1;min-width:140px;';
    wrapper.appendChild(document.createTextNode(label));
    const input = document.createElement('select');
    input.style.cssText = 'background:#1b2030;color:#eee;border:1px solid #495268;border-radius:4px;padding:5px;';
    input.disabled = disabled;
    for (const [key, text] of options) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = text;
        input.appendChild(option);
    }
    input.value = value;
    input.addEventListener('change', () => change(input.value));
    wrapper.appendChild(input);
    parent.appendChild(wrapper);
}

/** Payout buildings, matched by letters as the trials store does (`/guild_buildings/builders_hall`). */
const PAYOUT_BUILDINGS = { hall: 'buildershall', treasury: 'treasury' };

function clampBuildingLevel(value) {
    const level = Math.floor(Number(value));
    return Number.isFinite(level) ? Math.max(0, Math.min(20, level)) : 0;
}

/** A payout building's level from a `guildBuildingLevelMap`, 0 when the guild has not built it. */
function payoutBuildingLevel(levelMap, letters) {
    for (const [hrid, level] of Object.entries(levelMap || {})) {
        if (
            hrid
                .toLowerCase()
                .replace(/[^a-z]/g, '')
                .endsWith(letters)
        )
            return clampBuildingLevel(level);
    }
    return 0;
}

/** Skilling inputs that replace a capped reading's lower-bound curve once edited. */
const SUCCESS_INPUTS = new Set([
    'effectiveLevel',
    'successBonus',
    'referenceTier',
    'successRate',
    'successLossPerTier',
]);

function download(name, value) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class GuildTrialSim {
    constructor() {
        this.initialized = false;
        this.handlers = [];
        this.panel = null;
        this.controller = null;
        this.generation = 0;
        this.resetSetup();
    }

    resetSetup() {
        this.kind = 'combat';
        this.combatTrial = '/guild_combat/badger';
        this.skillingTrial = '/guild_skilling/crafting';
        this.combatMembers = [];
        this.skillingMembers = [];
        this.settings = { startTier: 1, seconds: 3600, runs: 50, seed: 1, baseWork: 40000, resetBetweenTiers: true };
        this.readings = {};
        this.successReadings = {};
        this.extra = {};
        this.includeHouses = true;
        // null follows the current guild's buildings; a number is a typed, captured or imported level.
        this.hallLevel = null;
        this.treasuryLevel = null;
        this.result = null;
        this.resultScenario = null;
        this.error = '';
        this.notice = '';
        this.progress = 0;
        this.runButton = null;
        this.importText = null;
        this.contextOverrides = null;
        this.loading = false;
        this.inputCapture = null;
        this.savedCaptures = [];
        this.selectedSavedCapture = '-1';
        this.participantCount = null;
        this.skillingParticipantCount = null;
        if (this.assign) this.assign.reset();
        else this.assign = new TrialAssignPlanner(this);
    }

    /** Builder's Hall and Treasury levels for payouts: an entered level, else the current guild's. */
    payoutLevels() {
        const levels = dataManager.guildBuildingLevelMap;
        return {
            hall: this.hallLevel ?? payoutBuildingLevel(levels, PAYOUT_BUILDINGS.hall),
            treasury: this.treasuryLevel ?? payoutBuildingLevel(levels, PAYOUT_BUILDINGS.treasury),
        };
    }

    /** Signups that scale skilling work: the recorded signup count, never fewer than the roster. */
    skillingParticipants() {
        return Math.max(Number(this.skillingParticipantCount) || 0, this.skillingMembers.length);
    }

    initialize() {
        if (this.initialized || !config.getSetting('guildTrialSim')) return;
        this.initialized = true;
        this.panel = createPanel({
            id: 'toolasha-guild-trial-sim',
            title: 'Guild Trial Simulator · Experimental',
            size: { width: 760, height: 660 },
            accent: ACCENT,
            refreshMs: 3_600_000,
            draw: (body) => this.draw(body),
        });
        registerCommand({
            name: 'Guild Trial Simulator',
            hint: 'Simulate skilling or combat with a chosen roster',
            run: () => this.panel?.toggle(),
        });
        const inject = () => {
            const root =
                document.querySelector('[class*="GuildPanel_tabsComponentContainer"] [role="tablist"]') ||
                document.querySelector('[class*="GuildPanel_guildPanel"] [class*="GuildPanel_title"]');
            if (!root || root.querySelector(`.${BUTTON_CLASS}`)) return;
            const control = button(root, 'Trial Sim', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.panel?.toggle();
            });
            control.className = BUTTON_CLASS;
            const tab = root.querySelector('[role="tab"]');
            if (tab) {
                // Use the game's tab styling while keeping this an independent panel button.
                control.classList.add(...Array.from(tab.classList).filter((name) => name !== 'Mui-selected'));
                control.style.cssText = 'flex-shrink:0;min-width:auto;cursor:pointer;';
            } else {
                control.style.alignSelf = 'center';
                control.style.flexShrink = '0';
                control.style.margin = '0 6px';
            }
        };
        this.handlers.push(domObserver.onClass('GuildTrialSimulator', 'GuildPanel_', inject));
        this.handlers.push(domObserver.onReady('GuildTrialSimulatorCatchUp', inject));
        // Every input the Assign view reads tells it here. Deferred a tick and coalesced: other
        // modules (the guild XP tracker, the member skill store) read the same messages, and the
        // view must look after they have, whatever order the handlers were added in.
        let pendingInputs = null;
        const notifyInputs = () => {
            clearTimeout(pendingInputs);
            pendingInputs = setTimeout(() => {
                pendingInputs = null;
                this.assign.inputsChanged();
            }, 0);
        };
        this.handlers.push(() => clearTimeout(pendingInputs));
        const capture = (data, context) => {
            if (dataManager.isFromActiveSocket?.(context) === false) return;
            if (!data?.trialHrid?.startsWith('/guild_skilling/')) return;
            const previous = this.readings[data.trialHrid];
            const newAttempt =
                typeof previous?.timeoutAt === 'string' &&
                typeof data.timeoutAt === 'string' &&
                previous.timeoutAt !== data.timeoutAt;
            if (previous && (data.tier < previous.tier || newAttempt)) delete this.successReadings[data.trialHrid];
            this.readings[data.trialHrid] = { ...data, at: Date.now() };
            if (Number.isInteger(data.tier) && data.tier >= 1 && data.tier <= 21 && Number.isFinite(data.successRate)) {
                const readings = (this.successReadings[data.trialHrid] ||= {});
                readings[data.tier] = { tier: data.tier, successRate: data.successRate };
            }
            notifyInputs();
        };
        webSocketHook.on('guild_skilling_updated', capture);
        this.handlers.push(() => webSocketHook.off('guild_skilling_updated', capture));
        // The cycle's drawn trials, for the assignment view; the login payload covers the time before one arrives
        const trialSet = (data, context) => {
            if (dataManager.isFromActiveSocket?.(context) === false) return;
            if (Array.isArray(data?.guildWeeklyTrialSet?.skillHrids))
                this.assign.setWeeklyTrialSet(data.guildWeeklyTrialSet);
            if (typeof data?.guild?.trialMinLevelsData === 'string')
                this.assign.trialMinLevelsData = data.guild.trialMinLevelsData;
            // Minimums, the draw, the week and the building levels behind the slot cap all ride here
            notifyInputs();
        };
        webSocketHook.on('guild_updated', trialSet);
        this.handlers.push(() => webSocketHook.off('guild_updated', trialSet));
        // The roster, sign-ups and week, once the guild XP tracker has written them — after any storage
        // read it waits on, which a tick-later look at its messages could beat. Without the tracker
        // (its bundle absent) its messages are watched instead.
        const offTracker = guildXpTracker()?.onMetaChanged?.(notifyInputs);
        if (offTracker) this.handlers.push(offTracker);
        // Opened profiles (the member skill store updates its in-memory captures synchronously) and level-ups
        const relayed = (_data, context) => {
            if (dataManager.isFromActiveSocket?.(context) === false) return;
            notifyInputs();
        };
        for (const type of [
            ...(offTracker ? [] : ['guild_trial_signup_updated', 'guild_characters_updated']),
            'profile_shared',
            'action_completed',
        ]) {
            webSocketHook.on(type, relayed);
            this.handlers.push(() => webSocketHook.off(type, relayed));
        }
        // The player's own base levels and the guild's building levels, as the data manager holds them
        for (const event of ['skills_updated', 'guild_shrine_levels_updated']) {
            dataManager.on(event, notifyInputs);
            this.handlers.push(() => dataManager.off(event, notifyInputs));
        }
        const switched = () => {
            this.generation++;
            this.controller?.abort();
            this.controller = null;
            this.resetSetup();
            this.panel?.render();
        };
        dataManager.on('character_switched', switched);
        this.handlers.push(() => dataManager.off('character_switched', switched));
    }

    disable() {
        this.generation++;
        this.controller?.abort();
        this.controller = null;
        for (const off of this.handlers) off();
        this.handlers = [];
        unregisterCommand('Guild Trial Simulator');
        document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((control) => control.remove());
        this.panel?.destroy();
        this.panel = null;
        this.initialized = false;
        this.resetSetup();
    }

    changed() {
        this.result = null;
        this.resultScenario = null;
        this.error = '';
        document.querySelector('#toolasha-guild-trial-sim [data-trial-sim-results]')?.remove();
    }

    makeScenario() {
        const buildingBuffs = structuredClone(
            this.contextOverrides?.buildingBuffs ??
                trialBuildingBuffs(dataManager.getInitClientData(), dataManager.guildBuildingLevelMap)
        );
        for (const [type, , ratio] of EXTRA_BUFFS) {
            const value = Number(this.extra[type]) || 0;
            if (!value) continue;
            const boost = type === 'ability_haste' ? value : value / 100;
            buildingBuffs.push({
                uniqueHrid: `/buff_uniques/trial_sim_extra_${type}`,
                typeHrid: `/buff_types/${type}`,
                flatBoost: ratio ? 0 : boost,
                ratioBoost: ratio ? boost : 0,
            });
        }
        return validateTrialScenario({
            ...this.settings,
            kind: this.kind,
            trialHrid: this.kind === 'combat' ? this.combatTrial : this.skillingTrial,
            participantCount:
                this.kind === 'combat'
                    ? (this.participantCount ?? this.combatMembers.length)
                    : this.skillingParticipants(),
            members: structuredClone(this.kind === 'combat' ? this.combatMembers : this.skillingMembers).map((m) => {
                if (this.kind === 'combat' && !this.includeHouses) m.dto.houseRooms = {};
                return m;
            }),
            sharedBuffs: this.contextOverrides?.sharedBuffs ?? buildExtraBuffs(getCommunityBuffs()),
            buildingBuffs,
        });
    }

    async run() {
        if (this.controller || this.loading) return;
        this.error = '';
        const generation = this.generation;
        try {
            const scenario = this.makeScenario();
            const gameData = buildTrialGameData();
            if (!gameData) throw new Error('Game data is not ready.');
            const controller = new AbortController();
            this.controller = controller;
            this.progress = 0;
            this.result = null;
            this.panel?.render();
            const result = await runGuildTrialSimulation(
                {
                    type: 'start_guild_trial_simulation',
                    taskId: `guild-trial-${Date.now()}-${generation}`,
                    gameData,
                    scenario,
                },
                (progress) => {
                    if (generation !== this.generation || controller.signal.aborted) return;
                    this.progress = progress;
                    if (this.runButton) this.runButton.textContent = `Simulating… ${progress}%`;
                },
                { signal: controller.signal }
            );
            if (generation !== this.generation || controller.signal.aborted) return;
            this.result = result;
            this.resultScenario = scenario;
        } catch (error) {
            if (generation === this.generation) this.error = error.message;
        } finally {
            if (generation === this.generation) {
                this.controller = null;
                this.panel?.render();
            }
        }
    }

    addCurrentBuild() {
        const dto = buildPlayerDTO();
        if (!dto) {
            this.error = 'Current build is not available yet.';
            return;
        }
        const id = String(dataManager.getCurrentCharacterId());
        const member = {
            id,
            name: dataManager.characterData?.character?.name || 'Current character',
            dto,
            source: 'Current equipped build; not the saved trial loadout',
            capturedAt: Date.now(),
        };
        this.combatMembers = [...this.combatMembers.filter((m) => m.id !== id), member];
        this.changed();
    }

    async addCapturedBuilds() {
        if (this.loading || this.controller) return;
        const generation = this.generation;
        this.loading = true;
        this.panel?.render();
        try {
            const entries = trialSimulationLoadouts().filter(
                (entry) =>
                    entry.context === VIEW_LOADOUT_CONTEXT.GuildTrial && entry.kind === 'combat' && entry.hasLoadout
            );
            let added = 0;
            let missing = 0;
            const profiles = trialSimulationProfiles();
            for (const entry of entries) {
                const built = await buildPlayerDTOFromLoadout(entry, profiles);
                if (generation !== this.generation) return;
                if (!built?.levelsFrom) {
                    missing++;
                    continue;
                }
                const id = String(entry.characterId || entry.name);
                const member = {
                    id,
                    name: entry.name,
                    dto: built.dto,
                    source: 'Captured trial loadout + cached profile levels',
                    capturedAt: entry.capturedAt,
                    profileCapturedAt: built.profileCapturedAt,
                };
                this.combatMembers = [...this.combatMembers.filter((m) => m.id !== id), member];
                added++;
            }
            this.changed();
            this.notice = `${added} trial builds added. ${missing ? `${missing} skipped because their skill levels have not been captured. ` : ''}Use View Loadout on the trial roster and view each player’s profile to supply both.`;
        } catch (error) {
            if (generation === this.generation) this.error = error.message;
        } finally {
            if (generation === this.generation) {
                this.loading = false;
                this.panel?.render();
            }
        }
    }

    /** Adopt the selected boss's signup members, using the export's own dated profiles. */
    async useInputCapture(value) {
        if (this.loading || this.controller) return;
        const generation = this.generation;
        this.loading = true;
        this.error = '';
        this.panel?.render();
        try {
            const bundle = validateTrialInputBundle(value);
            const inputs = bundle.simulationInputs;
            const signedUp = bundle.coverage.filter((member) => member.trials.combat === this.combatTrial);
            if (!signedUp.length)
                throw new Error('This capture has no signups for the selected combat trial. Choose its boss first.');
            const members = [];
            let noLoadout = 0;
            let missing = 0;
            const profiles = inputs.profiles.filter(
                (entry) =>
                    Array.isArray(entry.profile?.characterSkills) &&
                    ['stamina', 'intelligence', 'attack', 'defense', 'melee', 'ranged', 'magic'].every((skill) =>
                        entry.profile.characterSkills.some(
                            (row) =>
                                row.skillHrid === `/skills/${skill}` &&
                                typeof row.level === 'number' &&
                                Number.isFinite(row.level) &&
                                row.level >= 1 &&
                                row.level <= 1000
                        )
                    )
            );
            for (const member of signedUp) {
                const entry = inputs.viewLoadouts
                    .filter(
                        (item) =>
                            item.kind === 'combat' &&
                            (item.characterId != null
                                ? String(item.characterId) === String(member.characterId)
                                : String(item.name || '').toLowerCase() === member.name.toLowerCase())
                    )
                    .sort((a, b) => b.capturedAt - a.capturedAt)[0];
                if (entry?.hasLoadout === false) {
                    noLoadout++;
                    continue;
                }
                if (
                    !entry?.hasLoadout ||
                    !profiles.some((profile) => String(profile.characterID) === String(member.characterId))
                ) {
                    missing++;
                    continue;
                }
                const built = await buildPlayerDTOFromLoadout({ ...entry, characterId: member.characterId }, profiles, {
                    onlyProvidedProfiles: true,
                });
                if (generation !== this.generation) return;
                if (!built?.levelsFrom) {
                    missing++;
                    continue;
                }
                members.push({
                    id: String(member.characterId),
                    name: member.name,
                    dto: built.dto,
                    source: `Trial capture · ${bundle.guildName}`,
                    capturedAt: entry.capturedAt,
                    profileCapturedAt: built.profileCapturedAt,
                });
            }
            if (generation !== this.generation) return;
            this.kind = 'combat';
            this.combatMembers = members;
            this.inputCapture = bundle;
            this.participantCount = signedUp.length;
            this.contextOverrides = {
                buildingBuffs: trialBuildingBuffs(inputs, inputs.guildBuildingLevelMap),
                sharedBuffs: buildExtraBuffs(getCommunityBuffs()),
            };
            this.extra = {};
            this.includeHouses = true;
            this.hallLevel = payoutBuildingLevel(inputs.guildBuildingLevelMap, PAYOUT_BUILDINGS.hall);
            this.treasuryLevel = payoutBuildingLevel(inputs.guildBuildingLevelMap, PAYOUT_BUILDINGS.treasury);
            this.changed();
            this.notice = `${members.length}/${signedUp.length} signup members loaded for this boss. ${noLoadout} have no selected trial loadout; ${missing} lack a usable combat capture or profile. All ${signedUp.length} signups count toward boss scaling; only loaded builds contribute damage and healing. Captured guild building buffs and current community buffs are used.`;
        } catch (error) {
            if (generation === this.generation) this.error = `Capture import failed: ${error.message}`;
        } finally {
            if (generation === this.generation) {
                this.loading = false;
                this.panel?.render();
            }
        }
    }

    async loadSavedCaptures() {
        if (this.loading || this.controller) return;
        const generation = this.generation;
        this.loading = true;
        this.panel?.render();
        try {
            const saved = await loadSavedTrialInputBundles();
            if (generation !== this.generation) return;
            this.savedCaptures = saved;
            this.selectedSavedCapture = '-1';
            this.notice = saved.length
                ? 'Choose a saved capture, then load the selected boss’s signup roster.'
                : 'No captures saved for this character yet. Save captures in the capture helper or import your JSON file.';
        } catch (error) {
            if (generation === this.generation) this.error = `Could not read saved captures: ${error.message}`;
        } finally {
            if (generation === this.generation) {
                this.loading = false;
                this.panel?.render();
            }
        }
    }

    /** Choose a captured boss without mixing its signup roster with another trial. */
    async selectInputCapture(value) {
        if (this.loading || this.controller) return;
        try {
            const bundle = validateTrialInputBundle(value);
            const trials = bundle.coverage.map((member) => member.trials.combat).filter(Boolean);
            if (trials.length) {
                if (!trials.includes(this.combatTrial)) this.combatTrial = trials[0];
                await this.useInputCapture(bundle);
            } else {
                this.inputCapture = bundle;
                this.kind = 'skilling';
                this.changed();
                this.notice =
                    'Skilling capture loaded. Personal trial readings are still needed; equipment and profile levels alone do not supply work power or work time.';
                this.panel?.render();
            }
        } catch (error) {
            this.error = `Capture import failed: ${error.message}`;
            this.panel?.render();
        }
    }

    importCaptureFile() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.setAttribute('aria-label', 'Trial capture JSON file');
        const generation = this.generation;
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file || generation !== this.generation || this.loading || this.controller) return;
            this.loading = true;
            this.panel?.render();
            try {
                if (file.size > MAX_TRIAL_INPUT_BYTES) throw new Error('Capture JSON must be smaller than 20 MB.');
                const bundle = parseTrialInputBundle(await file.text());
                if (generation !== this.generation) return;
                await saveTrialInputBundle(bundle);
                if (generation !== this.generation) return;
                this.loading = false;
                await this.selectInputCapture(bundle);
            } catch (error) {
                if (generation === this.generation) this.error = `Capture import failed: ${error.message}`;
            } finally {
                if (generation === this.generation) {
                    this.loading = false;
                    this.panel?.render();
                }
            }
        });
        input.click();
    }

    addReading() {
        const reading = this.readings[this.skillingTrial];
        const member = memberFromSkillingReading(
            reading,
            dataManager.characterData?.character?.name || 'Current character',
            Object.values(this.successReadings[this.skillingTrial] || {})
        );
        const base = baseWorkFromSkillingReading(reading);
        if (!member || base === null) {
            this.error =
                'No personal reading captured for this trial. Watch it in In Progress, or enter the footer values by hand.';
            return;
        }
        member.id = String(dataManager.getCurrentCharacterId());
        member.capturedAt = reading.at;
        this.skillingMembers = [...this.skillingMembers.filter((m) => m.id !== member.id), member];
        this.settings.baseWork = base;
        this.settings.startTier = member.referenceTier;
        this.skillingParticipantCount = reading.participantIds.length;
        this.changed();
        this.notice = `One personal reading imported from ${new Date(reading.at).toLocaleString()}; observed with ${reading.participantIds.length} participants. Add the other members to simulate that roster.`;
    }

    async importSetup(text) {
        if (this.loading || this.controller) return;
        const generation = this.generation;
        try {
            if (text.length > MAX_TRIAL_INPUT_BYTES) throw new Error('Import must be smaller than 20 MB.');
            const input = JSON.parse(text);
            if (input.format === 'toolasha-guild-trial-inputs') {
                const bundle = parseTrialInputBundle(text);
                this.loading = true;
                this.panel?.render();
                await saveTrialInputBundle(bundle);
                if (generation !== this.generation) return;
                this.loading = false;
                await this.selectInputCapture(bundle);
                if (generation === this.generation) this.importText = null;
                return;
            }
            if (text.length > 2_000_000) throw new Error('Build or setup import must be smaller than 2 MB.');
            if (input.toolashaGuildTrialSimulation === 1) {
                const scenario = validateTrialScenario(input.scenario);
                this.kind = scenario.kind;
                if (scenario.kind === 'combat') {
                    this.combatTrial = scenario.trialHrid;
                    this.combatMembers = scenario.members;
                    this.participantCount = scenario.participantCount;
                } else {
                    this.skillingTrial = scenario.trialHrid;
                    this.skillingMembers = scenario.members;
                    this.skillingParticipantCount = scenario.participantCount;
                }
                for (const key of ['startTier', 'seconds', 'runs', 'seed', 'baseWork', 'resetBetweenTiers']) {
                    if (scenario[key] !== undefined) this.settings[key] = scenario[key];
                }
                this.contextOverrides = {
                    sharedBuffs: scenario.sharedBuffs || [],
                    buildingBuffs: scenario.buildingBuffs || [],
                };
                this.extra = {};
                this.includeHouses = true;
                this.hallLevel = input.hallLevel == null ? null : clampBuildingLevel(input.hallLevel);
                this.treasuryLevel = input.treasuryLevel == null ? null : clampBuildingLevel(input.treasuryLevel);
                this.notice = 'Setup imported with its saved buff context. Check the snapshot dates before using it.';
            } else {
                const imported = parseShykaiImport(text);
                if (!imported?.players.length)
                    throw new Error('Paste a Trial Sim setup or a combat simulator build export.');
                if (imported.skipped?.length)
                    throw new Error(
                        `${imported.skipped.length} items could not be recognized. Update the export before importing.`
                    );
                this.kind = 'combat';
                const members = imported.players.map((dto, i) => ({
                    name: imported.names[i],
                    dto,
                    source: 'Imported combat build; verify against trial snapshot',
                }));
                if (this.combatMembers.length + members.length > 100)
                    throw new Error('A scenario can have at most 100 members.');
                this.combatMembers.push(...members);
                this.participantCount = null;
                this.notice = `${members.length} combat builds added. Food, drinks and Labyrinth scrolls are excluded when simulating.`;
            }
            this.inputCapture = null;
            this.changed();
            this.importText = null;
        } catch (error) {
            if (generation === this.generation) this.error = `Import failed: ${error.message}`;
        } finally {
            if (generation === this.generation) {
                this.loading = false;
                this.panel?.render();
            }
        }
    }

    exportSetup() {
        try {
            download('toolasha-trial-sim-setup.json', {
                toolashaGuildTrialSimulation: 1,
                scenario: this.makeScenario(),
                hallLevel: this.payoutLevels().hall,
                treasuryLevel: this.payoutLevels().treasury,
            });
        } catch (error) {
            this.error = error.message;
            this.panel?.render();
        }
    }

    draw(body) {
        // Let setup sections keep their content height; the panel body handles scrolling.
        body.style.display = 'block';
        body.style.backgroundColor = '#0e1016';
        // The planner's search or check counts too: switching mode mid-run would orphan it
        const busy = Boolean(this.controller || this.loading || this.assign.controller);
        body.appendChild(
            panelNote(
                'Experimental planning model. Results depend on the entered roster and the assumptions below. Runs are local and do not sign up members or change loadouts.'
            )
        );
        const controls = row(body);
        select(
            controls,
            'Mode',
            this.kind,
            [
                ['combat', 'Combat'],
                ['skilling', 'Skilling'],
                ['assign', 'Assign skilling'],
            ],
            (kind) => {
                this.kind = kind;
                this.changed();
                this.panel?.render();
            },
            busy
        );
        if (this.kind === 'assign') {
            this.assign.draw(body, { button, row, field, select });
            for (const section of body.children) section.style.marginBottom = '7px';
            return;
        }
        const title = (name) => name[0].toUpperCase() + name.slice(1);
        const trials =
            this.kind === 'combat'
                ? COMBAT_ENCOUNTERS.map((name) => [`/guild_combat/${name}`, `Trial ${title(name)}`])
                : TRIAL_SKILLS.map((name) => [`/guild_skilling/${name}`, title(name)]);
        select(
            controls,
            'Trial',
            this.kind === 'combat' ? this.combatTrial : this.skillingTrial,
            trials,
            (hrid) => {
                if (this.kind === 'combat') this.combatTrial = hrid;
                else {
                    this.skillingTrial = hrid;
                    this.skillingMembers = [];
                    this.notice = 'Enter readings for the selected skill; the previous skill’s roster was cleared.';
                }
                this.changed();
                this.panel?.render();
                if (this.kind === 'combat' && this.inputCapture) void this.useInputCapture(this.inputCapture);
            },
            busy
        );
        const captures = row(body);
        button(captures, 'Import capture JSON', () => this.importCaptureFile(), busy);
        button(
            captures,
            'Paste capture JSON',
            () => {
                this.importText = this.importText === null ? '' : null;
                this.panel?.render();
            },
            busy
        );
        button(captures, 'Load saved captures', () => this.loadSavedCaptures(), busy);
        if (this.savedCaptures.length) {
            select(
                captures,
                'Saved capture',
                this.selectedSavedCapture,
                [
                    ['-1', 'Choose a capture…'],
                    ...this.savedCaptures.map((capture, i) => [
                        String(i),
                        `${capture.guildName} · ${new Date(capture.exportedAt).toLocaleString()} · ${capture.coverage.length} signups`,
                    ]),
                ],
                (value) => {
                    this.selectedSavedCapture = value;
                    this.panel?.render();
                },
                busy
            );
            button(
                captures,
                'Use saved capture',
                () => this.selectInputCapture(this.savedCaptures[Number(this.selectedSavedCapture)]),
                busy || this.selectedSavedCapture === '-1'
            );
        }
        if (this.inputCapture) {
            body.appendChild(
                panelNote(
                    `${this.inputCapture.guildName} · capture ${new Date(this.inputCapture.exportedAt).toLocaleString()} · trial week ${this.inputCapture.weekStartAt}. Rosters and profiles come from this dated capture.`
                )
            );
            if (this.kind === 'combat')
                button(captures, 'Reload captured signup roster', () => this.useInputCapture(this.inputCapture), busy);
        }
        const settings = row(body);
        for (const [key, label, min, max, factor] of [
            ['startTier', 'Starting tier', 1, 21, 1],
            ['seconds', 'Time budget (min)', 1 / 60, 60, 60],
            ['runs', 'Runs', 1, 200, 1],
            ['seed', 'Seed', 0, 4294967295, 1],
        ]) {
            field(
                settings,
                label,
                this.settings[key] / factor,
                (v) => {
                    this.settings[key] = v * factor;
                    this.changed();
                },
                { min, max, disabled: busy }
            );
        }
        body.appendChild(
            panelNote(
                'Starting above tier 1 assumes the earlier tiers are banked. Enter only the remaining time budget.'
            )
        );
        if (this.kind === 'combat') this.drawCombat(body, busy);
        else this.drawSkilling(body, busy);
        const imports = row(body);
        button(
            imports,
            'Import builds / setup',
            () => {
                this.importText = this.importText === null ? '' : null;
                this.panel?.render();
            },
            busy
        );
        button(imports, 'Export setup', () => this.exportSetup(), busy);
        if (this.contextOverrides)
            button(
                imports,
                'Use current guild buffs',
                () => {
                    this.contextOverrides = null;
                    this.changed();
                    this.panel?.render();
                },
                busy
            );
        if (this.importText !== null) {
            const area = document.createElement('textarea');
            area.setAttribute('aria-label', 'Capture, build or setup JSON');
            area.value = this.importText;
            area.style.cssText = 'width:100%;box-sizing:border-box;min-height:80px;background:#1b2030;color:#eee;';
            area.disabled = busy;
            area.addEventListener('input', () => {
                this.importText = area.value;
            });
            body.appendChild(area);
            button(row(body), 'Apply import', () => this.importSetup(this.importText), busy);
        }
        const payout = row(body);
        const levels = this.payoutLevels();
        const hallInput = field(
            payout,
            'Builder’s Hall level',
            levels.hall,
            (v) => {
                this.hallLevel = clampBuildingLevel(v);
            },
            { min: 0, max: 20, disabled: busy }
        );
        const treasuryInput = field(
            payout,
            'Treasury level',
            levels.treasury,
            (v) => {
                this.treasuryLevel = clampBuildingLevel(v);
            },
            { min: 0, max: 20, disabled: busy }
        );
        hallInput.addEventListener('change', () => this.panel?.render());
        treasuryInput.addEventListener('change', () => this.panel?.render());
        const actions = row(body);
        this.runButton = button(
            actions,
            this.loading ? 'Loading builds…' : busy ? `Simulating… ${this.progress}%` : 'Simulate trial',
            () => this.run(),
            busy
        );
        if (this.controller) button(actions, 'Cancel', () => this.controller?.abort());
        if (this.notice) body.appendChild(panelNote(this.notice));
        if (this.error) {
            const note = panelNote(this.error);
            note.style.color = '#ffb0a9';
            note.setAttribute('role', 'alert');
            body.appendChild(note);
        }
        if (this.result) this.drawResult(body);
        for (const section of body.children) section.style.marginBottom = '7px';
    }

    drawCombat(body, busy) {
        const roster = panelCard(
            body,
            `Combat roster · ${this.combatMembers.length} ${this.combatMembers.length === 1 ? 'member' : 'members'}`,
            ACCENT
        );
        roster.style.maxHeight = '260px';
        roster.style.overflowY = 'auto';
        roster.style.display = 'block';
        const add = row(roster);
        button(
            add,
            'Add current build',
            () => {
                this.addCurrentBuild();
                this.panel?.render();
            },
            busy
        );
        button(add, 'Add captured trial builds', () => this.addCapturedBuilds(), busy);
        for (const [i, member] of this.combatMembers.entries()) {
            const line = row(roster);
            field(
                line,
                `Member ${i + 1} name`,
                member.name,
                (name) => {
                    member.name = name;
                    this.changed();
                },
                { type: 'text', disabled: busy }
            );
            const gear = Object.values(member.dto.equipment).filter(Boolean).length;
            line.appendChild(panelNote(`${gear} pieces · ${member.dto.abilities.filter(Boolean).length} abilities`));
            button(
                line,
                `Remove ${member.name}`,
                () => {
                    this.combatMembers.splice(i, 1);
                    this.changed();
                    this.panel?.render();
                },
                busy
            );
            roster.appendChild(
                panelNote(
                    `${member.source || 'Imported build'}${member.capturedAt ? ` · ${new Date(member.capturedAt).toLocaleString()}` : ''}${member.profileCapturedAt ? ` · profile ${new Date(member.profileCapturedAt).toLocaleString()}` : ''}`
                )
            );
        }
        if (!this.combatMembers.length)
            roster.appendChild(
                panelNote(
                    'Add your current build, captured trial loadouts with known profile levels, or imported combat builds. Missing members are not substituted with level 1 characters.'
                )
            );
        const rules = panelCard(body, 'Combat assumptions and buffs', ACCENT);
        field(
            row(rules),
            'Participants for boss scaling',
            this.participantCount ?? this.combatMembers.length,
            (value) => {
                this.participantCount = value;
                this.changed();
            },
            { min: this.combatMembers.length, max: 100, step: 1, disabled: busy }
        );
        rules.appendChild(
            panelNote(
                'Includes signed-up members with missing builds. Only roster builds contribute damage and healing; missing builds make this an incomplete prediction.'
            )
        );
        select(
            row(rules),
            'Between tiers',
            String(this.settings.resetBetweenTiers),
            [
                ['true', 'Reset HP, MP, buffs and cooldowns'],
                ['false', 'Carry surviving HP, MP, buffs and cooldowns'],
            ],
            (v) => {
                this.settings.resetBetweenTiers = v === 'true';
                this.changed();
            },
            busy
        );
        select(
            row(rules),
            'House buffs from build',
            String(this.includeHouses),
            [
                ['true', 'Include'],
                ['false', 'Exclude'],
            ],
            (v) => {
                this.includeHouses = v === 'true';
                this.changed();
            },
            busy
        );
        rules.appendChild(
            panelNote(
                'Post-rebalance recordings confirm boss stat scaling, initial ability cooldowns, HP/MP refills and revivals between tiers, and enrage beginning at 600 seconds. Later enrage stacks, status resets and parry selection still need replay validation. Carry mode is a hypothetical comparison.'
            )
        );
        rules.appendChild(
            panelNote(
                'Participant scaling: +1% boss HP, +2% attack/cast speed and +2 ability haste per member. No consumables, no party level penalty; +3% HP/MP regeneration is added.'
            )
        );
        const detected = trialBuildingBuffs(dataManager.getInitClientData(), dataManager.guildBuildingLevelMap);
        rules.appendChild(
            panelNote(
                this.contextOverrides
                    ? 'Using imported building and shared buffs.'
                    : `${detected.length} combat-scoped building buffs detected. Additional bonuses below are added on top; leave them at zero when already included.`
            )
        );
        const extras = row(rules);
        for (const [type, label] of EXTRA_BUFFS)
            field(
                extras,
                label,
                this.extra[type] || 0,
                (v) => {
                    this.extra[type] = v;
                    this.changed();
                },
                { min: 0, max: 1000, disabled: busy }
            );
    }

    drawSkilling(body, busy) {
        field(
            row(body),
            'Tier 1 base work (before participants)',
            this.settings.baseWork,
            (v) => {
                this.settings.baseWork = v;
                this.changed();
            },
            { min: 1, max: 1e9, disabled: busy }
        );
        body.appendChild(
            panelNote(
                '40,000 base work matches recorded Milking, Alchemy, Cheesesmithing and Enhancing pools. Use a trial reading to calibrate other skills and your personal stats.'
            )
        );
        const roster = panelCard(
            body,
            `Skilling roster · ${this.skillingMembers.length} ${this.skillingMembers.length === 1 ? 'member' : 'members'}`,
            ACCENT
        );
        roster.style.maxHeight = '300px';
        roster.style.overflowY = 'auto';
        roster.style.display = 'block';
        const add = row(roster);
        button(
            add,
            'Add member',
            () => {
                this.skillingMembers.push({
                    name: `Member ${this.skillingMembers.length + 1}`,
                    referenceTier: 1,
                    successRate: 0.8,
                    successLossPerTier: 0.08,
                    effectiveLevel: 100,
                    successBonus: 0,
                    workPower: 0,
                    actionSeconds: 10,
                    doubleChance: 0,
                    source: 'Manual inputs',
                });
                this.changed();
                this.panel?.render();
            },
            busy
        );
        button(
            add,
            'Use latest trial reading',
            () => {
                this.addReading();
                this.panel?.render();
            },
            busy
        );
        for (const [i, member] of this.skillingMembers.entries()) {
            const card = panelCard(roster, '', ACCENT);
            const identity = row(card);
            field(
                identity,
                `Member ${i + 1} name`,
                member.name,
                (v) => {
                    member.name = v;
                    this.changed();
                },
                { type: 'text', disabled: busy }
            );
            button(
                identity,
                `Remove ${member.name}`,
                () => {
                    this.skillingMembers.splice(i, 1);
                    this.changed();
                    this.panel?.render();
                },
                busy
            );
            const stats = row(card);
            select(
                row(card),
                'Success model',
                member.effectiveLevel == null ? 'reading' : 'curve',
                [
                    ['curve', 'Game success curve'],
                    ['reading', 'Measured linear estimate'],
                ],
                (value) => {
                    if (value === 'curve') {
                        // Keep the curve through the member's measured success, not a flat 80%.
                        const anchored = anchorSkillingSuccessCurve({
                            tier: member.referenceTier,
                            successRate: member.successRate,
                            trialHrid: this.skillingTrial,
                        });
                        Object.assign(
                            member,
                            anchored ?? {
                                effectiveLevel: levelFromTier(member.referenceTier),
                                successBonus: 0,
                                successLowerBound: false,
                            }
                        );
                    } else {
                        delete member.effectiveLevel;
                        delete member.successBonus;
                    }
                    this.changed();
                    this.panel?.render();
                },
                busy
            );
            const successFields =
                member.effectiveLevel == null
                    ? [
                          ['referenceTier', 'Reference tier', 1, 1, 21],
                          ['successRate', 'Success at reference (%)', 100, 5, 100],
                          ['successLossPerTier', 'Success loss / tier (pp)', 100, 0, 100],
                      ]
                    : [
                          ['effectiveLevel', 'Effective skill level', 1, 1, 1000],
                          ['successBonus', 'Success bonus (%)', 100, -100, 1000],
                      ];
            for (const [key, label, factor, min, max] of [
                ['workPower', 'Work power', 1, 0, 1e7],
                ['actionSeconds', 'Work time (s)', 1, 0.1, 3600],
                ['doubleChance', 'Double progress (%)', 100, 0, 100],
                ...successFields,
            ]) {
                field(
                    stats,
                    label,
                    member[key] * factor,
                    (v) => {
                        member[key] = v / factor;
                        // An entered success input replaces the capped-reading bound.
                        if (SUCCESS_INPUTS.has(key)) member.successLowerBound = false;
                        this.changed();
                    },
                    { min, max, disabled: busy }
                );
            }
            card.appendChild(panelNote(member.source || 'Manual inputs'));
        }
        roster.appendChild(
            panelNote(
                'Use Work Power and Work Time from the trial footer; Work Power already includes efficiency. Effective skill level includes equipment and building levels. Success falls 4 percentage points per tier while the trial level is below your effective level, and 8 above it, clamped to 5–100%. Success bonuses apply before the 80% base factor. Multiple uncapped readings spanning the slope change calibrate the curve; a single reading anchors it on that reading, assuming no success bonus. A capped 100% reading only bounds success from below, so its results are lower bounds.'
            )
        );
        field(
            row(body),
            'Participants for work scaling',
            this.skillingParticipants(),
            (value) => {
                this.skillingParticipantCount = value;
                this.changed();
            },
            { min: this.skillingMembers.length, max: 100, step: 1, disabled: busy }
        );
        body.appendChild(
            panelNote(
                'Every signed-up member adds 1% to each tier’s work, including members not in this roster. A trial reading sets this to the signups it observed.'
            )
        );
        roster.appendChild(
            panelNote(
                'Action clocks continue between tiers; excess work on a clearing action is discarded. Double progress rolls independently on a success. These timing assumptions still need replay validation.'
            )
        );
    }

    drawResult(body) {
        const result = this.result;
        const card = panelCard(body, 'Simulation results', ACCENT);
        card.dataset.trialSimResults = 'true';
        const format = (n, digits = 1) => Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
        const bound = result.lowerBound ? ' (lower bound)' : '';
        const { hall, treasury } = this.payoutLevels();
        if (result.lowerBound) {
            const note = panelNote(
                'Lower bound: a capped reading. A 100% success reading only shows success is at least 100% at that tier, so the curve uses the lowest effective level consistent with it. Tiers and points may be higher; enter the effective level or add a reading below 100% to tighten it.'
            );
            note.style.color = '#ffd27a';
            card.appendChild(note);
        }
        card.appendChild(panelLine('Median highest banked tier', `T${result.medianHighestTier}${bound}`));
        card.appendChild(
            panelLine('10th–90th percentile', `T${result.lowHighestTier}–T${result.highHighestTier}${bound}`)
        );
        card.appendChild(panelLine('Mean highest banked tier', `${format(result.meanHighestTier, 2)}${bound}`));
        card.appendChild(
            panelLine('Mean Guild Points', `${format(result.meanBasePoints * (1 + 0.02 * hall))}${bound}`)
        );
        card.appendChild(panelLine('Mean base points from unfinished tier', format(result.meanPartialBasePoints)));
        card.appendChild(
            panelLine('Eligible member token contribution', format(result.meanBasePoints * 0.5 * (1 + 0.02 * treasury)))
        );
        card.appendChild(
            panelLine('With weekly participation bonus', format(result.meanBasePoints * 0.75 * (1 + 0.02 * treasury)))
        );
        card.appendChild(
            panelNote(
                'Point and token estimates include up to 50% of the unfinished tier’s rewards, proportional to progress. Token figures are this trial’s contribution to the weekly payout, including earlier banked tiers when starting above tier 1. Every eligible member gets the same base payout; the participation bonus applies once to the whole week.'
            )
        );
        card.appendChild(
            panelNote(
                `${result.runs} runs · seed ${result.seed} · ${result.participants} ${result.participants === 1 ? 'member' : 'members'}${result.kind === 'combat' ? ` simulated / ${result.bossParticipants ?? result.participants} signups for boss scaling` : ` simulated / ${result.workParticipants ?? result.participants} signups for work scaling`} · ${result.outcomes.defeat} defeats / ${result.outcomes.timeout} timeouts / ${result.outcomes['max-tier']} full clears. Percentiles describe simulation randomness, not model accuracy.`
            )
        );
        if (result.kind === 'skilling')
            card.appendChild(
                panelLine(
                    'Expected work / second at starting tier',
                    format(skillingWorkPerSecond(this.resultScenario.members, result.startTier), 2)
                )
            );
        const table = document.createElement('table');
        table.style.cssText = 'width:100%;border-collapse:collapse;text-align:right;margin-top:8px;';
        const head = document.createElement('tr');
        for (const title of ['Tier / level', 'Reached', 'Cleared', 'Mean clear time']) {
            const cell = document.createElement('th');
            cell.textContent = title;
            head.appendChild(cell);
        }
        table.appendChild(head);
        for (const tier of result.tiers) {
            const tr = document.createElement('tr');
            for (const text of [
                `T${tier.tier} / ${tier.level}`,
                `${format(tier.reachChance * 100)}%`,
                `${format(tier.clearChance * 100)}%`,
                tier.meanClearSeconds === null ? '—' : `${format(tier.meanClearSeconds)}s`,
            ]) {
                const cell = document.createElement('td');
                cell.textContent = text;
                cell.style.padding = '3px 5px';
                tr.appendChild(cell);
            }
            table.appendChild(tr);
        }
        card.appendChild(table);
        card.appendChild(
            panelNote(
                'Clear odds include runs that failed an earlier tier. Mean clear time includes only successful clears of that tier.'
            )
        );
        for (const warning of result.warnings) card.appendChild(panelNote(`Engine warning: ${warning}`));
        button(row(card), 'Export result', () =>
            download('toolasha-trial-sim-result.json', {
                toolashaGuildTrialSimulation: 1,
                scenario: this.resultScenario,
                result,
                hallLevel: this.payoutLevels().hall,
                treasuryLevel: this.payoutLevels().treasury,
            })
        );
    }
}

const guildTrialSim = new GuildTrialSim();
export default guildTrialSim;
