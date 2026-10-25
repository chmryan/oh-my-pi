/**
 * Shared scaffolding for idle-recap lifecycle tests: real `ExtensionRunner`s loaded
 * from extension sources, and an ingress harness that wires a real `InputController`
 * and `EventController` over a real `CustomEditor`. Typing and Enter reach the
 * controllers through the editor's own `onChange` / `onSubmit`, as in the TUI.
 */
import { expect, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "./interactive-mode-context";

const ENTER = "\r";

export async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 50; i++) {
		await Promise.resolve();
	}
}

export function createAssistantMessage(): AssistantMessage {
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

/** The stub's `isStreaming` is a data property; redefine it since the real type exposes a getter. */
export function setStreaming(context: { session: object }, value: boolean): void {
	Object.defineProperty(context.session, "isStreaming", { value, configurable: true });
}

/** Real `before_idle_recap` handlers: the actual ExtensionRunner path, not a stand-in echo. */
export const RECAP_ACTION_EXTENSION = `
export default function (pi) {
	pi.on("before_idle_recap", async () => ({ prompt: "Run the capture-context skill now." }));
}
`;
export const RECAP_SKIP_EXTENSION = `
export default function (pi) {
	pi.on("before_idle_recap", async () => ({ skip: true }));
}
`;

/** Cleanups for real runners built per test (auth db, temp extension dir). */
const cleanups: Array<() => void> = [];

export function disposeRecapFixtures(): void {
	for (const cleanup of cleanups.splice(0)) cleanup();
}

/**
 * Loads a real ExtensionRunner from a temp extension file. Setup runs on real
 * timers because extension loading does file I/O; fake timers are restored after.
 */
export async function createRecapRunner(extensionSource: string): Promise<ExtensionRunner> {
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

export interface IngressHarness {
	readonly context: InteractiveModeContext;
	readonly events: EventController;
	/** Replaces the editor text. The real editor fires `onChange` with the new draft. */
	typeDraft(text: string): void;
	/** Types the text and presses Enter through the real editor; resolves once the submit handler settles. */
	submit(text: string): Promise<void>;
}

export interface IngressHarnessOptions {
	prompt?: AgentSession["prompt"];
	runEphemeralTurn?: AgentSession["runEphemeralTurn"];
	extensionRunner?: ExtensionRunner;
	lastAssistantMessage?: AssistantMessage;
	present?: InteractiveModeContext["present"];
}

/**
 * Builds a real InputController and EventController over one context, with a real
 * CustomEditor as the composer. Recap work runs under fake timers the caller owns.
 */
export function createIngressHarness(options: IngressHarnessOptions = {}): IngressHarness {
	const editor = new CustomEditor(getEditorTheme());
	const context = createInteractiveModeContext({
		editor,
		ui: {
			addInputListener: vi.fn(),
			addStartListener: vi.fn(),
			getFocused: () => editor,
		},
		dictationSpaceHold: vi.fn(),
		withLocalSubmission: async <T>(_text: string, run: () => Promise<T>) => run(),
		...(options.present ? { present: options.present } : {}),
		session: {
			prewarmModelConnection: vi.fn(),
			prompt: options.prompt,
			runEphemeralTurn:
				options.runEphemeralTurn ?? (async () => ({ replyText: "", assistantMessage: createAssistantMessage() })),
			extensionRunner: options.extensionRunner,
			getLastAssistantMessage: () => options.lastAssistantMessage,
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			messages: [createAssistantMessage()],
		},
	});
	const events = new EventController(context);
	context.eventController = events;
	const input = new InputController(context);
	input.setupKeyHandlers();
	input.setupEditorSubmitHandler();

	// Capture the async submit so a test can await the real dispatch. An Enter that
	// never reaches onSubmit throws, so a submit can never pass vacuously.
	const onSubmit = editor.onSubmit;
	let pendingSubmit: Promise<void> | undefined;
	editor.onSubmit = text => {
		pendingSubmit = Promise.resolve(onSubmit?.(text));
		return pendingSubmit;
	};

	return {
		context,
		events,
		typeDraft(text: string): void {
			editor.setText(text);
		},
		async submit(text: string): Promise<void> {
			pendingSubmit = undefined;
			editor.setText(text);
			editor.handleInput(ENTER);
			if (!pendingSubmit) throw new Error("The editor did not dispatch the submit key");
			await pendingSubmit;
		},
	};
}
