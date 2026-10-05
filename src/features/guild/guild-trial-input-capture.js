/** A user-driven checklist for the inputs needed to replay a guild trial. */
import dataManager from '../../core/data-manager.js';
import config from '../../core/config.js';
import webSocketHook from '../../core/websocket.js';
import { guildXPTracker } from './guild-xp-tracker.js';
import guildTrialRecorder from './guild-trial-recorder.js';
import {
    captureTrialSimulationInputs,
    startTrialSimulationCapture,
    trialSimulationProfiles,
    trialSimulationLoadouts,
    restoreTrialSimulationInputs,
    loadSavedTrialInputBundles,
    saveTrialInputBundle,
    parseTrialInputBundle,
    trialSignupRoster,
    MAX_TRIAL_INPUT_BYTES,
} from './guild-trial-simulation-inputs.js';
import { createPanel, panelNote } from '../../utils/simple-panel.js';
import { openPlayerProfile } from '../../utils/profile-command.js';
import { fetchLoadout, onLoadoutCaptured, VIEW_LOADOUT_CONTEXT } from '../../utils/view-loadout.js';
import { scriptVersion } from '../../utils/script-version.js';
import { isTestServer } from '../../utils/game-server.js';

const KINDS = ['combat', 'skilling'];
const PROFILE_TIMEOUT_MS = 8000;

/** The current week's participants, with one loadout request per signed-up kind. */
export function trialInputRoster(tracker = guildXPTracker) {
    return trialSignupRoster(tracker);
}

/** Join fresh captures to the signup roster; unrelated or unknown-kind loadouts never satisfy a step. */
export function trialInputCoverage(roster, { owner, since, loadouts = [], profiles = [] }) {
    return roster.map((member) => {
        const captured = {};
        for (const kind of KINDS.filter((entry) => member.trials[entry])) {
            const entry = loadouts
                .filter(
                    (item) =>
                        item.ownerCharacterId === String(owner) &&
                        String(item.characterId) === member.characterId &&
                        item.context === VIEW_LOADOUT_CONTEXT.GuildTrial &&
                        item.kind === kind &&
                        item.capturedAt >= since
                )
                .sort((a, b) => b.capturedAt - a.capturedAt)[0];
            captured[kind] = entry ? (entry.hasLoadout === false ? 'no_loadout' : 'captured') : 'needed';
        }
        const profile = profiles.find(
            (entry) =>
                String(entry.characterID) === member.characterId &&
                entry.timestamp >= since &&
                Array.isArray(entry.profile?.characterSkills) &&
                entry.profile.characterSkills.length > 0
        );
        return { ...member, captured, profile: profile ? 'captured' : 'needed' };
    });
}

function scopeNow() {
    return JSON.stringify([
        dataManager.getCurrentCharacterId?.() ?? null,
        guildXPTracker.getOwnGuildID?.() ?? null,
        guildXPTracker.getOwnGuildSnapshotID?.() ?? null,
        guildXPTracker.getOwnGuildName?.() ?? null,
        guildXPTracker.getCurrentWeekStartAt?.() ?? null,
        guildTrialRecorder.exportScopeVersion,
    ]);
}

function currentGuildReady() {
    const owner = dataManager.getCurrentCharacterId?.() ?? null;
    const guildName = guildXPTracker.getOwnGuildName?.() ?? null;
    const memberGuildID = guildXPTracker.getOwnGuildID?.() ?? null;
    const snapshotGuildID = guildXPTracker.getOwnGuildSnapshotID?.() ?? null;
    // Tracker metadata can lag a character or guild switch while its history loads.
    return Boolean(
        owner !== null &&
        guildName &&
        memberGuildID !== null &&
        snapshotGuildID !== null &&
        String(memberGuildID) === String(snapshotGuildID) &&
        guildTrialRecorder.pendingGuildAdoption === null &&
        String(guildTrialRecorder.characterId) === String(owner) &&
        guildTrialRecorder.guildName === guildName
    );
}

let scope = null;
let since = 0;
let selection = '';
let pending = null;
let notice = '';
let offLoadout = null;
let profileHandler = null;
let saveTimer = null;
let restoredScope = null;
let restoring = false;
let roundVersion = 0;
let savedAt = null;
let saveNotice = '';
const skipped = new Set();

function adoptScope() {
    const next = scopeNow();
    if (next === scope) return;
    cancelPending();
    cancelSave();
    roundVersion++;
    scope = next;
    since = Date.now();
    selection = '';
    notice = '';
    skipped.clear();
    restoredScope = null;
    restoring = false;
    savedAt = null;
    saveNotice = '';
}

function cancelSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
}

function matchesCurrentGuild(bundle) {
    return (
        bundle.guildName === guildXPTracker.getOwnGuildName?.() &&
        bundle.weekStartAt === guildXPTracker.getCurrentWeekStartAt?.() &&
        (bundle.guildID == null || String(bundle.guildID) === String(guildXPTracker.getOwnGuildID?.()))
    );
}

async function restoreSavedCapture() {
    if (config.getSetting('guildTrialKeepInputs') !== true || !currentGuildReady() || restoredScope === scope) return;
    const expected = scope;
    const version = roundVersion;
    restoredScope = expected;
    restoring = true;
    try {
        const saved = await loadSavedTrialInputBundles();
        if (scopeNow() !== expected || roundVersion !== version || !currentGuildReady()) return;
        const bundle = saved.find(matchesCurrentGuild);
        if (bundle) {
            restoreTrialSimulationInputs(bundle);
            since = Math.min(since, bundle.capturedSince);
            savedAt = bundle.exportedAt;
            saveNotice = 'Restored this guild/week’s saved captures. Check their dates and refresh changed loadouts.';
        }
    } catch (error) {
        if (scope === expected && roundVersion === version)
            saveNotice = `Could not restore saved captures: ${error.message}`;
    } finally {
        if (scope === expected && roundVersion === version) {
            restoring = false;
            trialInputCapturePanel.render();
            scheduleSave();
        }
    }
}

async function saveCurrentCapture(automatic = false) {
    const expected = scope;
    const version = roundVersion;
    try {
        const bundle = await buildTrialInputExport();
        if (
            scope !== expected ||
            roundVersion !== version ||
            (automatic && config.getSetting('guildTrialKeepInputs') !== true)
        )
            return;
        await saveTrialInputBundle(bundle);
        if (scope !== expected || roundVersion !== version) return;
        savedAt = bundle.exportedAt;
        saveNotice = 'Captures saved on this browser. Trial Sim can load this guild/week’s signup roster.';
    } catch (error) {
        if (scope === expected && roundVersion === version) saveNotice = `Save failed: ${error.message}`;
    }
    if (scope === expected && roundVersion === version) trialInputCapturePanel.render();
}

function scheduleSave() {
    cancelSave();
    if (config.getSetting('guildTrialKeepInputs') !== true || restoring) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        if (!pending && currentGuildReady()) void saveCurrentCapture(true);
    }, 750);
}

function importCaptureFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.setAttribute('aria-label', 'Trial capture JSON file');
    const expected = scope;
    const version = roundVersion;
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
            if (file.size > MAX_TRIAL_INPUT_BYTES) throw new Error('Capture JSON must be smaller than 20 MB.');
            const bundle = parseTrialInputBundle(await file.text());
            if (scopeNow() !== expected || roundVersion !== version) return;
            await saveTrialInputBundle(bundle);
            if (scopeNow() !== expected || roundVersion !== version) return;
            if (currentGuildReady() && matchesCurrentGuild(bundle)) {
                restoreTrialSimulationInputs(bundle);
                since = Math.min(since, bundle.capturedSince);
            }
            savedAt = bundle.exportedAt;
            saveNotice = `Imported and saved ${bundle.guildName}’s capture from ${new Date(bundle.exportedAt).toLocaleString()}. Load it in Trial Sim.`;
        } catch (error) {
            if (scope === expected && roundVersion === version) saveNotice = `Import failed: ${error.message}`;
        }
        if (scope === expected && roundVersion === version) trialInputCapturePanel.render();
    });
    input.click();
}

function cancelPending() {
    if (pending?.timer) clearTimeout(pending.timer);
    pending = null;
}

function rowsNow() {
    adoptScope();
    if (!currentGuildReady()) return [];
    return trialInputCoverage(trialInputRoster(), {
        owner: dataManager.getCurrentCharacterId?.(),
        since,
        loadouts: trialSimulationLoadouts(),
        profiles: trialSimulationProfiles(),
    });
}

function visibleRows(rows) {
    if (!selection) return rows;
    return rows
        .filter((row) => Object.values(row.trials).includes(selection))
        .map((row) => ({
            ...row,
            trials: Object.fromEntries(Object.entries(row.trials).filter(([, hrid]) => hrid === selection)),
        }));
}

const stepKey = (row, kind) => `${row.characterId}:${kind}`;

function nextStep(rows) {
    for (const row of rows) {
        for (const kind of [...KINDS.filter((entry) => row.trials[entry]), 'profile']) {
            const status = kind === 'profile' ? row.profile : row.captured[kind];
            if (status === 'needed' && !skipped.has(stepKey(row, kind))) return { row, kind };
        }
    }
    return null;
}

function statusLabel(status, row, kind) {
    if (status === 'captured') return 'Captured';
    if (status === 'no_loadout') return 'No trial loadout';
    return skipped.has(stepKey(row, kind)) ? 'Skipped — still missing' : 'Needed';
}

function button(label, action, disabled = false) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.disabled = disabled;
    element.style.cssText =
        'padding:5px 8px;margin:3px;border:1px solid #8fb4ff66;border-radius:5px;background:#222b3c;color:#e8ecf5;cursor:pointer;';
    element.addEventListener('click', action);
    return element;
}

async function requestStep(row, kind) {
    adoptScope();
    if (pending) return;
    // A stale button cannot ask for a member who left the current signup roster.
    const current = rowsNow().find((entry) => entry.characterId === row.characterId);
    if (!current || (kind !== 'profile' && !current.trials[kind])) return;
    // The standard panel shell can restore directly through show(), bypassing the manual opener.
    listenForInputs();
    const request = { scope, row: current, kind };
    pending = request;
    skipped.delete(stepKey(row, kind));
    notice = '';
    try {
        if (kind === 'profile') {
            request.timer = setTimeout(() => {
                if (pending !== request) return;
                cancelPending();
                notice = `No profile reply for ${row.name}. Retry or skip this step.`;
                trialInputCapturePanel.render();
            }, PROFILE_TIMEOUT_MS);
            // Called synchronously from the user's click. Nothing queues another request.
            if (!openPlayerProfile(current.name, { logPrefix: 'TrialInputCapture' })) {
                cancelPending();
                notice = 'The profile could not be opened. Open it from the game roster, or retry.';
            }
        } else {
            // Capture keys use strings, but the game's View Loadout request uses a numeric member id.
            const loadoutMember = { ...current, characterId: Number(current.characterId) };
            const result = await fetchLoadout(loadoutMember, VIEW_LOADOUT_CONTEXT.GuildTrial, kind);
            if (pending !== request || scopeNow() !== request.scope) return;
            cancelPending();
            if (result.status !== 'done') notice = `Loadout not captured (${result.status}). Retry or skip this step.`;
            else if (result.entry?.hasLoadout === false) notice = `${row.name} has no ${kind} trial loadout.`;
        }
    } catch (error) {
        if (pending === request) {
            cancelPending();
            notice = `Capture failed: ${error.message}. Retry this step.`;
        }
    } finally {
        trialInputCapturePanel.render();
        scheduleSave();
    }
}

/** Build a standalone input export, rejecting a character, guild or week change during the storage read. */
export async function buildTrialInputExport() {
    if (!currentGuildReady())
        throw new Error('Guild or character changed. Wait for current Guild data and export again.');
    const rows = rowsNow();
    const expected = scope;
    if (!rows.length) throw new Error('No current trial signups are available. Open Guild first.');
    const owner = dataManager.getCurrentCharacterId();
    const roster = rows.map((row) => ({ characterID: row.characterId, name: row.name }));
    const guildName = guildXPTracker.getOwnGuildName?.() ?? null;
    const weekStartAt = guildXPTracker.getCurrentWeekStartAt?.() ?? null;
    const capturedSince = since;
    const simulationInputs = await captureTrialSimulationInputs(owner, roster);
    if (!simulationInputs || !currentGuildReady() || scopeNow() !== expected || scope !== expected)
        throw new Error('Guild, character or capture round changed. Export again.');
    const coverage = trialInputCoverage(rows, {
        owner,
        since: capturedSince,
        loadouts: simulationInputs.viewLoadouts,
        profiles: simulationInputs.profiles,
    });
    const host = typeof location === 'undefined' ? null : location.hostname;
    return {
        format: 'toolasha-guild-trial-inputs',
        version: 1,
        toolashaVersion: scriptVersion(),
        exportedAt: new Date().toISOString(),
        host,
        isTestServer: host ? isTestServer(host) : null,
        guildName,
        guildID: guildXPTracker.getOwnGuildID?.() ?? null,
        weekStartAt,
        capturedSince,
        coverage,
        simulationInputs,
    };
}

async function exportInputs() {
    try {
        const bundle = await buildTrialInputExport();
        if (config.getSetting('guildTrialKeepInputs') === true) {
            try {
                await saveTrialInputBundle(bundle);
                savedAt = bundle.exportedAt;
                saveNotice = 'Captures saved on this browser.';
            } catch (error) {
                saveNotice = `Local save failed: ${error.message}`;
            }
        }
        const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `toolasha-trial-inputs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        notice = 'Inputs exported. The file includes missing-input coverage.';
    } catch (error) {
        notice = `Export failed: ${error.message}`;
    }
    trialInputCapturePanel.render();
}

function trialName(hrid) {
    const name = String(hrid).split('/').pop().replace(/_/g, ' ');
    return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The helper serves the Trial Simulator from inside Guild Trials, so it needs both. */
function captureAllowed() {
    return config.getSetting('guildTrialsInfo') === true && config.getSetting('guildTrialSim') === true;
}

function draw(body) {
    if (!captureAllowed()) {
        // A panel restored from a page left with it open, after either setting
        // was switched off. Nothing is read or started for it, and once this
        // character's settings are in hand it is closed for good.
        body.appendChild(panelNote('Trial Input Capture needs Guild Trials and the Guild Trial Simulator turned on.'));
        if (config.characterSettingsLoaded) queueMicrotask(closeIfDisallowed);
        return;
    }
    const allRows = rowsNow();
    void restoreSavedCapture();
    const trials = [...new Set(allRows.flatMap((row) => Object.values(row.trials)))];
    if (selection && !trials.includes(selection)) selection = '';
    const rows = visibleRows(allRows);
    const controls = document.createElement('div');
    controls.style.cssText = 'position:sticky;top:0;background:#10141e;padding-bottom:8px;z-index:1;';
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Trial to capture');
    for (const hrid of ['', ...trials]) {
        const option = document.createElement('option');
        option.value = hrid;
        option.textContent = hrid ? trialName(hrid) : 'All signed-up trials';
        option.selected = selection === hrid;
        select.appendChild(option);
    }
    select.addEventListener('change', () => {
        selection = select.value;
        notice = '';
        trialInputCapturePanel.render();
    });
    controls.appendChild(select);
    const step = nextStep(rows);
    controls.appendChild(
        button(
            pending
                ? `Waiting for ${pending.row.name}…`
                : step
                  ? `Capture next: ${step.row.name} · ${step.kind === 'profile' ? 'profile' : `${step.kind} loadout`}`
                  : 'No unskipped steps left',
            () => requestStep(step.row, step.kind),
            Boolean(pending) || !step
        )
    );
    controls.appendChild(
        button(
            'Skip for now',
            () => {
                skipped.add(stepKey(step.row, step.kind));
                notice = '';
                trialInputCapturePanel.render();
            },
            Boolean(pending) || !step
        )
    );
    controls.appendChild(button('Export inputs', exportInputs, Boolean(pending) || !allRows.length));
    controls.appendChild(
        button('Save captures', () => saveCurrentCapture(), Boolean(pending) || restoring || !allRows.length)
    );
    controls.appendChild(button('Import capture JSON', importCaptureFile, Boolean(pending) || restoring));
    controls.appendChild(
        button(
            'Start fresh captures',
            () => {
                roundVersion++;
                cancelSave();
                restoredScope = scope;
                restoring = false;
                since = Date.now();
                skipped.clear();
                notice = 'Older captures stay in the export, but each step now needs a fresh response.';
                trialInputCapturePanel.render();
                scheduleSave();
            },
            Boolean(pending)
        )
    );
    body.appendChild(controls);
    const keepLabel = document.createElement('label');
    const keep = document.createElement('input');
    keep.type = 'checkbox';
    keep.checked = config.getSetting('guildTrialKeepInputs') === true;
    keep.disabled = Boolean(pending) || restoring;
    keep.addEventListener('change', async () => {
        config.setSetting('guildTrialKeepInputs', keep.checked);
        if (keep.checked) {
            await restoreSavedCapture();
            await saveCurrentCapture(true);
        } else cancelSave();
        trialInputCapturePanel.render();
    });
    keepLabel.append(keep, document.createTextNode(' Keep captures on this browser'));
    body.appendChild(keepLabel);
    body.appendChild(
        panelNote(
            'Saved locally: latest capture per guild/week, up to eight sets per character. Older captures retain their dates.'
        )
    );
    if (restoring) body.appendChild(panelNote('Restoring saved captures…'));
    if (savedAt) body.appendChild(panelNote(`Saved capture date: ${new Date(savedAt).toLocaleString()}`));
    if (saveNotice) body.appendChild(panelNote(saveNotice));
    const loadoutStatuses = rows.flatMap((row) => Object.keys(row.trials).map((kind) => row.captured[kind]));
    body.appendChild(
        panelNote(
            `${loadoutStatuses.filter((status) => status === 'captured').length}/${loadoutStatuses.length} loadouts · ` +
                `${rows.filter((row) => row.profile === 'captured').length}/${rows.length} profiles captured this round.`
        )
    );
    body.appendChild(
        panelNote(
            'One click requests one loadout or profile. Close a profile popup to continue. Save or export before refreshing.'
        )
    );
    if (notice) body.appendChild(panelNote(notice));
    if (!rows.length)
        body.appendChild(
            panelNote(
                currentGuildReady()
                    ? 'No current trial signups found. Open Guild to load the roster and current week.'
                    : 'Waiting for current character and guild data. Open Guild after the switch completes.'
            )
        );
    for (const row of rows) {
        const card = document.createElement('div');
        card.style.cssText = 'padding:8px 0;border-top:1px solid #ffffff22;';
        const heading = document.createElement('strong');
        heading.textContent = `${row.name} — ${Object.values(row.trials).map(trialName).join(', ')}`;
        card.appendChild(heading);
        for (const kind of [...KINDS.filter((entry) => row.trials[entry]), 'profile']) {
            const line = document.createElement('div');
            const status = kind === 'profile' ? row.profile : row.captured[kind];
            const label = kind === 'profile' ? 'Profile' : `${kind === 'combat' ? 'Combat' : 'Skilling'} loadout`;
            line.textContent = `${label}: ${statusLabel(status, row, kind)} `;
            line.style.color = status === 'captured' ? '#8bd99b' : '#edc785';
            const control = button(
                status === 'captured' ? 'Refresh' : 'Capture',
                () => requestStep(row, kind),
                Boolean(pending)
            );
            control.setAttribute('aria-label', `${row.name}: capture ${kind}`);
            line.appendChild(control);
            card.appendChild(line);
        }
        body.appendChild(card);
    }
}

export const trialInputCapturePanel = createPanel({
    id: 'trialInputCapture',
    title: 'Trial Input Capture',
    size: { width: 620, height: 560 },
    draw,
});

/** Attach the response listeners for either a manually opened or restored checklist. */
function listenForInputs() {
    startTrialSimulationCapture();
    if (!offLoadout)
        offLoadout = onLoadoutCaptured(() => {
            trialInputCapturePanel.render();
            scheduleSave();
        });
    if (!profileHandler) {
        profileHandler = (message) => {
            const request = pending;
            if (request?.kind === 'profile' && scopeNow() === request.scope) {
                const profile = message?.profile;
                const id =
                    profile?.sharableCharacter?.id ||
                    profile?.characterSkills?.[0]?.characterID ||
                    profile?.character?.id;
                if (String(id) === request.row.characterId) {
                    cancelPending();
                    notice =
                        Array.isArray(profile.characterSkills) && profile.characterSkills.length
                            ? 'Profile captured. Close the game popup to continue.'
                            : 'The profile reply has no skill levels. Close the popup and retry.';
                }
            }
            trialInputCapturePanel.render();
            scheduleSave();
        };
        webSocketHook.on('profile_shared', profileHandler);
    }
}

/** Open the checklist; listeners record responses, never send requests by themselves. */
export function openTrialInputCapture() {
    adoptScope();
    listenForInputs();
    trialInputCapturePanel.show();
}

/**
 * Release the helper when Guild Trials is disabled or the character changes.
 * @param {Object} [options]
 * @param {boolean} [options.remember=false] - Record the panel as closed, so a reload
 *   does not bring it back; for a setting being switched off, not a character switch
 */
export function closeTrialInputCapture({ remember = false } = {}) {
    cancelPending();
    cancelSave();
    roundVersion++;
    restoredScope = null;
    restoring = false;
    offLoadout?.();
    offLoadout = null;
    if (profileHandler) webSocketHook.off('profile_shared', profileHandler);
    profileHandler = null;
    scope = null;
    since = 0;
    skipped.clear();
    trialInputCapturePanel.hide({ remember });
}

/** Close the panel for good when a setting it needs is off. */
function closeIfDisallowed() {
    if (!captureAllowed() && trialInputCapturePanel.isOpen()) closeTrialInputCapture({ remember: true });
}

// Page-lifetime, like the panel itself: a panel left open is reopened by the
// shell on load and on every character switch, before or after that
// character's settings arrive, and either setting can be switched off while it
// is open.
for (const key of ['guildTrialSim', 'guildTrialsInfo']) config.onSettingChange?.(key, closeIfDisallowed);
config.onSettingsLoaded?.(closeIfDisallowed);
