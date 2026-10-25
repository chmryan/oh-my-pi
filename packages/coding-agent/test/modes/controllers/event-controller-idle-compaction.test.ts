import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { Component } from "@oh-my-pi/pi-tui";
import { RecapNotice } from "@oh-my-pi/pi-tui/chat/recap-notice";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

import { cfgCompactionIdleEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { cfgRecapEnabled, cfgRecapIdleSeconds } from "@oh-my-pi/pi-coding-agent/modes/settings";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 50; i++) {
		await Promise.resolve();
	}
}

/** `present` stand-in for spies: the controller only hands content over. */
function recordPresented(_content: Component | readonly Component[]): void {}

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 200,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 210,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createContext(
	options: {
		goalObjective?: string;
		isCompacting?: boolean;
		isStreaming?: boolean;
		runIdleCompaction?: AgentSession["runIdleCompaction"];
		promptCacheEntry?: AgentSession["promptCacheEntry"];
		model?: AgentSession["model"];
		runEphemeralTurn?: AgentSession["runEphemeralTurn"];
		prompt?: AgentSession["prompt"];
		extensionRunner?: AgentSession["extensionRunner"];
		lastAssistantMessage?: AssistantMessage;
		present?: InteractiveModeContext["present"];
		sessionName?: string;
		todoPhases?: InteractiveModeContext["todoPhases"];
	} = {},
) {
	const runIdleCompaction = options.runIdleCompaction ?? (async () => {});
	const runEphemeralTurn =
		options.runEphemeralTurn ?? (async () => ({ replyText: "", assistantMessage: createAssistantMessage() }));
	const goalState: GoalModeState | undefined = options.goalObjective
		? {
				enabled: true,
				mode: "active",
				goal: {
					id: "goal-test",
					objective: options.goalObjective,
					status: "active",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: 0,
					updatedAt: 0,
				},
			}
		: undefined;
	return createInteractiveModeContext({
		sessionManager: { getSessionName: () => options.sessionName },
		todoPhases: options.todoPhases ?? [],
		...(options.present ? { present: options.present } : {}),
		session: {
			isCompacting: options.isCompacting ?? false,
			isStreaming: options.isStreaming ?? false,
			runIdleCompaction,
			promptCacheEntry: options.promptCacheEntry,
			runEphemeralTurn,
			...(options.prompt ? { prompt: options.prompt } : {}),
			...(options.extensionRunner ? { extensionRunner: options.extensionRunner } : {}),
			model: options.model ?? { provider: "anthropic", id: "claude-sonnet-4-5" },
			messages: [createAssistantMessage()],
			getContextUsage: () => ({ tokens: 210, contextWindow: 1_000, percent: 21 }),
			getGoalModeState: () => goalState,
			getLastAssistantMessage: () => options.lastAssistantMessage,
		},
	});
}

/** The stub's `isStreaming` is a data property; redefine it since the real type exposes a getter. */
function setStreaming(context: { session: object }, value: boolean): void {
	Object.defineProperty(context.session, "isStreaming", { value, configurable: true });
}

/** Real `before_idle_recap` handlers: the actual ExtensionRunner path, not a stand-in echo. */
const RECAP_ACTION_EXTENSION = `
export default function (pi) {
	pi.on("before_idle_recap", async () => ({ prompt: "Run the capture-context skill now." }));
}
`;
const RECAP_SKIP_EXTENSION = `
export default function (pi) {
	pi.on("before_idle_recap", async () => ({ skip: true }));
}
`;

/** Cleanups for real runners built per test (auth db, temp extension dir). */
const cleanups: Array<() => void> = [];

/**
 * Loads a real ExtensionRunner from a temp extension file. Setup runs on real
 * timers because extension loading does file I/O; fake timers are restored after.
 */
async function createRecapRunner(extensionSource: string): Promise<ExtensionRunner> {
	vi.useRealTimers();
	const dir = TempDir.createSync("@idle-recap-");
	const authStorage = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	cleanups.push(() => {
		authStorage.close();
		dir.removeSync();
	});
	const extensionPath = dir.join("before-idle-recap.ts");
	fs.writeFileSync(extensionPath, extensionSource);
	const loaded = await loadExtensions([extensionPath], dir.path());
	expect(loaded.errors).toEqual([]);
	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		dir.path(),
		SessionManager.inMemory(dir.path()),
		new ModelRegistry(authStorage),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
	);
	vi.useFakeTimers();
	return runner;
}

describe("EventController idle compaction teardown", () => {
	beforeEach(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": true,
				"compaction.idleThresholdTokens": 100,
				"compaction.idleTimeoutSeconds": 60,
			},
		});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		for (const cleanup of cleanups.splice(0)) cleanup();
		resetSettingsForTest();
	});

	it("cancels scheduled idle compaction when disposed", async () => {
		const runIdleCompaction = vi.fn(async () => {});
		const context = createContext({ runIdleCompaction });

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		controller.dispose();
		vi.advanceTimersByTime(60_000);

		expect(runIdleCompaction).not.toHaveBeenCalled();
	});

	it("arms idle compaction when it is enabled after the turn becomes idle", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleThresholdTokens": 100,
				"compaction.idleTimeoutSeconds": 60,
			},
		});
		const runIdleCompaction = vi.fn();
		const context = createContext({ runIdleCompaction });
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });

		cfgCompactionIdleEnabled.set(settings, true);
		controller.refreshIdleCompactionTimer();
		vi.advanceTimersByTime(60_000);

		expect(runIdleCompaction).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("waits for the prompt cache lifetime instead of the fallback delay when it is known", async () => {
		const runIdleCompaction = vi.fn(async () => {});
		const context = createContext({
			runIdleCompaction,
			promptCacheEntry: { touchedAt: Date.now(), tier: "long", ttlMs: 3_600_000 },
		});
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });

		// The 60s fallback would have fired long ago; the 1h entry is refreshed at 54 min.
		vi.advanceTimersByTime(54 * 60_000 - 5_001);
		expect(runIdleCompaction).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(runIdleCompaction).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("compacts right away when the turn settles past the refresh point but before expiry", async () => {
		const runIdleCompaction = vi.fn(async () => {});
		const context = createContext({
			runIdleCompaction,
			promptCacheEntry: { touchedAt: Date.now() - 59 * 60_000, tier: "long", ttlMs: 3_600_000 },
		});
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });

		// The entry expires in one minute; the 60s fallback would land after it.
		vi.advanceTimersByTime(1);
		expect(runIdleCompaction).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("falls back to the configured delay once the cache entry has lapsed", async () => {
		const runIdleCompaction = vi.fn(async () => {});
		const context = createContext({
			runIdleCompaction,
			promptCacheEntry: { touchedAt: Date.now() - 2 * 3_600_000, tier: "long", ttlMs: 3_600_000 },
		});
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });

		vi.advanceTimersByTime(59_999);
		expect(runIdleCompaction).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(runIdleCompaction).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("ignores a live 5-minute cache entry and keeps the configured delay", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": true,
				"compaction.idleThresholdTokens": 100,
				"compaction.idleTimeoutSeconds": 600,
			},
		});
		const runIdleCompaction = vi.fn(async () => {});
		const context = createContext({
			runIdleCompaction,
			promptCacheEntry: { touchedAt: Date.now(), tier: "short", ttlMs: 300_000 },
		});
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });

		// Cache timing would compact at ~4.4 min; the configured 10 min wins.
		vi.advanceTimersByTime(600_000 - 1);
		expect(runIdleCompaction).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(runIdleCompaction).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("never idle-compacts a logged-in Codex session whose prompt cache does not expire", async () => {
		const runIdleCompaction = vi.fn(async () => {});
		const codex = getBundledModels("openai-codex").find(model => model.api === "openai-codex-responses");
		expect(codex).toBeDefined();
		const context = createContext({ runIdleCompaction, model: codex });
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });

		vi.advanceTimersByTime(3_600_000);
		expect(runIdleCompaction).not.toHaveBeenCalled();
		controller.dispose();
	});

	it("arms the idle recap when enabled mid-idle and never re-delivers a shown recap", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": false,
				"completion.notify": "off",
				"recap.enabled": false,
				"recap.idleSeconds": 60,
			},
		});
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "Recap body.",
			assistantMessage: createAssistantMessage(),
		}));
		const context = createContext({ runEphemeralTurn });
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });

		cfgRecapEnabled.override(settings, true);
		controller.refreshIdleRecapTimer();
		vi.advanceTimersByTime(60_000);
		await flushMicrotasks();
		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);

		// Same idle window: a later setting change must not schedule a second recap.
		cfgRecapIdleSeconds.override(settings, 90);
		controller.refreshIdleRecapTimer();
		vi.advanceTimersByTime(90_000);
		await flushMicrotasks();
		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("emits an LLM-generated recap after the default four-minute delay", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": false,
				"completion.notify": "off",
			},
		});
		const present = vi.fn(recordPresented);
		let capturedPrompt = "";
		const runEphemeralTurn = vi.fn(async (args: { promptText: string; signal?: AbortSignal }) => {
			capturedPrompt = args.promptText;
			return {
				replyText: "Reworking the login flow; auth suite passes. Next: wire the focused token-refresh test.",
				assistantMessage: createAssistantMessage(),
			};
		});
		const context = createContext({
			sessionName: "Fix login flow",
			present,
			runEphemeralTurn,
			todoPhases: [{ name: "Work", tasks: [{ content: "Wire focused tests", status: "pending" }] }],
		});

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(239_999);
		expect(runEphemeralTurn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		await flushMicrotasks();

		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		// Live goal/title and the active todo task anchor the recap prompt the snapshot can't guarantee.
		expect(capturedPrompt).toContain("Fix login flow");
		expect(capturedPrompt).toContain("Wire focused tests");

		const notice = present.mock.calls
			.map(([content]) => content)
			.find((content): content is RecapNotice => content instanceof RecapNotice);
		expect(notice?.render(200).map(line => Bun.stripANSI(line).trim())).toEqual([
			"",
			"※ recap: Reworking the login flow; auth suite passes. Next: wire the focused token-refresh test.",
		]);
		controller.dispose();
	});

	it("runs the pre-recap action as one owned turn, then recaps at once without another delay", async () => {
		cfgRecapEnabled.override(settings, true);
		cfgCompactionIdleEnabled.override(settings, false);
		cfgRecapIdleSeconds.override(settings, 1);
		const runner = await createRecapRunner(RECAP_ACTION_EXTENSION);
		const order: string[] = [];
		const action = Promise.withResolvers<void>();
		const present = vi.fn();
		const runEphemeralTurn = vi.fn(async () => {
			order.push("recap");
			return { replyText: "Captured context.", assistantMessage: createAssistantMessage() };
		});
		const prompt = vi.fn(async () => {
			order.push("action");
			// Real turn shape: the action's own start and settle run through the controller.
			setStreaming(context, true);
			await controller.handleEvent({ type: "agent_start" });
			await action.promise;
			setStreaming(context, false);
			await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
			return true;
		});
		const context = createContext({
			runEphemeralTurn,
			prompt,
			present,
			extensionRunner: runner,
			lastAssistantMessage: createAssistantMessage(),
		});
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(order).toEqual(["action"]);
		expect(runEphemeralTurn).not.toHaveBeenCalled();

		action.resolve();
		await flushMicrotasks();
		expect(order).toEqual(["action", "recap"]);
		expect(present.mock.calls.some(([content]) => content instanceof RecapNotice)).toBe(true);

		// Background settle after the recap: the cycle is consumed, so nothing repeats.
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(10_000);
		await flushMicrotasks();
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("human input during the pre-recap action drops that recap and the next human turn opens a fresh cycle", async () => {
		cfgRecapEnabled.override(settings, true);
		cfgCompactionIdleEnabled.override(settings, false);
		cfgRecapIdleSeconds.override(settings, 1);
		const runner = await createRecapRunner(RECAP_ACTION_EXTENSION);
		const action = Promise.withResolvers<boolean>();
		const present = vi.fn();
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "stale", assistantMessage: createAssistantMessage() }));
		const prompt = vi.fn(() => action.promise);
		const context = createContext({
			runEphemeralTurn,
			prompt,
			present,
			extensionRunner: runner,
			lastAssistantMessage: createAssistantMessage(),
		});
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(prompt).toHaveBeenCalledTimes(1);

		controller.onUserInput();
		action.resolve(true);
		await flushMicrotasks();
		expect(runEphemeralTurn).not.toHaveBeenCalled();

		// The human's own turn settles: that settle arms a fresh window.
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(prompt).toHaveBeenCalledTimes(2);
		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		expect(present.mock.calls.some(([content]) => content instanceof RecapNotice)).toBe(true);
		controller.dispose();
	});

	it("human input while the recap is generating drops the late reply", async () => {
		cfgRecapEnabled.override(settings, true);
		cfgCompactionIdleEnabled.override(settings, false);
		cfgRecapIdleSeconds.override(settings, 1);
		const reply = Promise.withResolvers<{ replyText: string; assistantMessage: AssistantMessage }>();
		const runEphemeralTurn = vi.fn(() => reply.promise);
		const present = vi.fn();
		const context = createContext({ runEphemeralTurn, present });
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);

		controller.onUserInput();
		reply.resolve({ replyText: "stale", assistantMessage: createAssistantMessage() });
		await flushMicrotasks();
		expect(present.mock.calls.some(([content]) => content instanceof RecapNotice)).toBe(false);
		controller.dispose();
	});

	it("a draft present at settle arms nothing, and a draft typed mid-window cancels without rearming", async () => {
		cfgRecapEnabled.override(settings, true);
		cfgCompactionIdleEnabled.override(settings, false);
		cfgRecapIdleSeconds.override(settings, 1);
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "Recap.", assistantMessage: createAssistantMessage() }));
		const context = createContext({ runEphemeralTurn });
		let draft = "half-typed";
		context.editor.getText = () => draft;
		const controller = new EventController(context);

		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();
		expect(runEphemeralTurn).not.toHaveBeenCalled();

		// A new turn settles with an empty editor and arms; typing then cancels it.
		draft = "";
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		draft = "typing";
		controller.cancelIdleRecapForDraft();
		draft = "";
		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();
		expect(runEphemeralTurn).not.toHaveBeenCalled();
		controller.dispose();
	});

	it("a pre-recap action that reports failure consumes the cycle: no recap and no retry from later settles", async () => {
		cfgRecapEnabled.override(settings, true);
		cfgCompactionIdleEnabled.override(settings, false);
		cfgRecapIdleSeconds.override(settings, 1);
		const runner = await createRecapRunner(RECAP_ACTION_EXTENSION);
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "incorrect",
			assistantMessage: createAssistantMessage(),
		}));
		const present = vi.fn();
		const prompt = vi.fn(async () => false);
		const context = createContext({
			runEphemeralTurn,
			prompt,
			present,
			extensionRunner: runner,
			lastAssistantMessage: createAssistantMessage(),
		});
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(prompt).toHaveBeenCalledTimes(1);

		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(10_000);
		await flushMicrotasks();
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(runEphemeralTurn).not.toHaveBeenCalled();
		expect(present.mock.calls.some(([content]) => content instanceof RecapNotice)).toBe(false);
		controller.dispose();
	});

	it("a pre-recap action whose turn ended in error shows no success recap", async () => {
		cfgRecapEnabled.override(settings, true);
		cfgCompactionIdleEnabled.override(settings, false);
		cfgRecapIdleSeconds.override(settings, 1);
		const runner = await createRecapRunner(RECAP_ACTION_EXTENSION);
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "incorrect",
			assistantMessage: createAssistantMessage(),
		}));
		const prompt = vi.fn(async () => true);
		const context = createContext({
			runEphemeralTurn,
			prompt,
			extensionRunner: runner,
			lastAssistantMessage: { ...createAssistantMessage(), stopReason: "error", errorMessage: "boom" },
		});
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(runEphemeralTurn).not.toHaveBeenCalled();
		controller.dispose();
	});

	it("a before_idle_recap skip vetoes both the pre-recap action and the recap", async () => {
		cfgRecapEnabled.override(settings, true);
		cfgCompactionIdleEnabled.override(settings, false);
		cfgRecapIdleSeconds.override(settings, 1);
		const runner = await createRecapRunner(RECAP_SKIP_EXTENSION);
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "vetoed", assistantMessage: createAssistantMessage() }));
		const prompt = vi.fn(async () => true);
		const context = createContext({ runEphemeralTurn, prompt, extensionRunner: runner });
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(prompt).not.toHaveBeenCalled();
		expect(runEphemeralTurn).not.toHaveBeenCalled();
		controller.dispose();
	});

	it("keeps idle-recap cycles per session id, so switching sessions neither fires nor consumes another cycle", async () => {
		cfgRecapEnabled.override(settings, true);
		cfgCompactionIdleEnabled.override(settings, false);
		cfgRecapIdleSeconds.override(settings, 1);
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "Recap.", assistantMessage: createAssistantMessage() }));
		const context = createContext({ runEphemeralTurn });
		let sessionId = "session-a";
		Object.defineProperty(context.sessionManager, "getSessionId", { value: () => sessionId, configurable: true });
		const controller = new EventController(context);

		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);

		// Session B has its own unconsumed cycle and recaps on its own settle.
		sessionId = "session-b";
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(runEphemeralTurn).toHaveBeenCalledTimes(2);

		// Back on A: its cycle was consumed earlier and must stay consumed.
		sessionId = "session-a";
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(10_000);
		await flushMicrotasks();
		expect(runEphemeralTurn).toHaveBeenCalledTimes(2);
		controller.dispose();
	});

	it("a human reset during the owned action arms the fresh cycle even when the action's own settle came first", async () => {
		cfgRecapEnabled.override(settings, true);
		cfgCompactionIdleEnabled.override(settings, false);
		cfgRecapIdleSeconds.override(settings, 1);
		const runner = await createRecapRunner(RECAP_ACTION_EXTENSION);
		const action = Promise.withResolvers<void>();
		const present = vi.fn();
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "Captured context.",
			assistantMessage: createAssistantMessage(),
		}));
		const prompt = vi.fn(async () => {
			setStreaming(context, true);
			await controller.handleEvent({ type: "agent_start" });
			await action.promise;
			setStreaming(context, false);
			// The action's own settle lands before its prompt resolves: the owned guard suppresses it.
			await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
			return true;
		});
		const context = createContext({
			runEphemeralTurn,
			prompt,
			present,
			extensionRunner: runner,
			lastAssistantMessage: createAssistantMessage(),
		});
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(prompt).toHaveBeenCalledTimes(1);

		// The human steers the owned prompt: the window resets while the action still runs.
		controller.onUserInput();
		action.resolve();
		await flushMicrotasks();
		expect(runEphemeralTurn).not.toHaveBeenCalled();

		// The fresh cycle was armed when the action settled; it fires without another settle.
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(prompt).toHaveBeenCalledTimes(2);
		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		expect(present.mock.calls.some(([content]) => content instanceof RecapNotice)).toBe(true);
		controller.dispose();
	});

	it("an owned action guards only its own session: another session's settle still arms its cycle", async () => {
		cfgRecapEnabled.override(settings, true);
		cfgCompactionIdleEnabled.override(settings, false);
		cfgRecapIdleSeconds.override(settings, 1);
		const runner = await createRecapRunner(RECAP_ACTION_EXTENSION);
		const action = Promise.withResolvers<boolean>();
		const prompt = vi.fn(() => action.promise);
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "Recap.", assistantMessage: createAssistantMessage() }));
		const context = createContext({
			runEphemeralTurn,
			prompt,
			extensionRunner: runner,
			lastAssistantMessage: createAssistantMessage(),
		});
		let sessionId = "session-a";
		Object.defineProperty(context.sessionManager, "getSessionId", { value: () => sessionId, configurable: true });
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(prompt).toHaveBeenCalledTimes(1);

		// Session B settles while A's action is still pending: A's guard must not apply to B.
		sessionId = "session-b";
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(prompt).toHaveBeenCalledTimes(2);
		controller.dispose();
	});

	it("does not bill a composer prediction for the owned action's own settle, but still does for ordinary settles", async () => {
		cfgRecapEnabled.override(settings, true);
		cfgCompactionIdleEnabled.override(settings, false);
		cfgRecapIdleSeconds.override(settings, 1);
		const runner = await createRecapRunner(RECAP_ACTION_EXTENSION);
		const prompt = vi.fn(async () => {
			setStreaming(context, true);
			await controller.handleEvent({ type: "agent_start" });
			setStreaming(context, false);
			await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
			return true;
		});
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "Recap.", assistantMessage: createAssistantMessage() }));
		const context = createContext({
			runEphemeralTurn,
			prompt,
			extensionRunner: runner,
			lastAssistantMessage: createAssistantMessage(),
		});
		const controller = new EventController(context);
		const request = vi.spyOn(controller.composerPrediction, "request").mockImplementation(() => {});
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		expect(request).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("aborts the in-flight recap and drops its late reply when disposed", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": false,
				"completion.notify": "off",
			},
		});
		const { promise, resolve } = Promise.withResolvers<{ replyText: string; assistantMessage: AssistantMessage }>();
		let receivedSignal: AbortSignal | undefined;
		const runEphemeralTurn = vi.fn((args: { promptText: string; signal?: AbortSignal }) => {
			receivedSignal = args.signal;
			return promise;
		});
		const present = vi.fn(recordPresented);
		const context = createContext({ sessionName: "Fix login flow", present, runEphemeralTurn });

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(240_000);
		await flushMicrotasks();

		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		expect(receivedSignal?.aborted).toBe(false);

		controller.dispose();
		expect(receivedSignal?.aborted).toBe(true);

		// A reply that lands after cancellation must not paint a stale recap.
		resolve({ replyText: "stale recap", assistantMessage: createAssistantMessage() });
		await flushMicrotasks();
		expect(present.mock.calls.some(([content]) => content instanceof RecapNotice)).toBe(false);
	});
});
