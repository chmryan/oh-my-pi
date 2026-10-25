import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgRecapEnabled, cfgRecapIdleSeconds } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgCompactionIdleEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { RecapNotice } from "@oh-my-pi/pi-tui/chat/recap-notice";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import {
	createAssistantMessage,
	createIngressHarness,
	createRecapRunner,
	disposeRecapFixtures,
	flushMicrotasks,
	RECAP_ACTION_EXTENSION,
	setStreaming,
} from "../../helpers/recap-ingress";

describe("InputController recap ingress", () => {
	beforeEach(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "compaction.idleEnabled": false } });
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		disposeRecapFixtures();
		resetSettingsForTest();
	});

	it("a real main-editor submit during the owned pre-recap prompt reopens the cycle; the fresh cycle recaps", async () => {
		cfgRecapEnabled.override(settings, true);
		cfgCompactionIdleEnabled.override(settings, false);
		cfgRecapIdleSeconds.override(settings, 1);
		const runner = await createRecapRunner(RECAP_ACTION_EXTENSION);
		const gate = Promise.withResolvers<void>();
		const steered: string[] = [];
		const present = vi.fn();
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "Captured context.",
			assistantMessage: createAssistantMessage(),
		}));
		const prompt = vi.fn(async (text: string, options?: { streamingBehavior?: string }) => {
			// A human steer goes through the same session.prompt entry point, marked "steer".
			if (options?.streamingBehavior === "steer") {
				steered.push(text);
				return true;
			}
			setStreaming(harness.context, true);
			await harness.events.handleEvent({ type: "agent_start" });
			await gate.promise;
			setStreaming(harness.context, false);
			await harness.events.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
			return true;
		});
		const harness = createIngressHarness({
			prompt,
			runEphemeralTurn,
			present,
			extensionRunner: runner,
			lastAssistantMessage: createAssistantMessage(),
		});
		await harness.events.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(prompt).toHaveBeenCalledTimes(1);

		// The human types and presses Enter while the owned prompt is still running.
		harness.typeDraft("keep going");
		await harness.submit("keep going");
		expect(steered).toEqual(["keep going"]);

		gate.resolve();
		await flushMicrotasks();
		expect(runEphemeralTurn).not.toHaveBeenCalled();

		// The owned action settled after the reset: the fresh cycle recaps once its delay elapses.
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		expect(present.mock.calls.some(([content]) => content instanceof RecapNotice)).toBe(true);
		harness.events.dispose();
	});
});
