/**
 * Behavior of `ExtensionRunner.emitBeforeIdleRecap`: prompt combining, skip veto,
 * abort suppression, and fail-closed handler errors and timeouts.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	ExtensionRunner,
	testSetExtensionHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	BeforeIdleRecapEvent,
	BeforeIdleRecapEventResult,
	Extension,
	ExtensionError,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

type IdleRecapHandler = (
	event: BeforeIdleRecapEvent,
) => BeforeIdleRecapEventResult | undefined | Promise<BeforeIdleRecapEventResult | undefined>;

describe("ExtensionRunner.emitBeforeIdleRecap", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-idle-recap-");
	});

	afterEach(() => {
		testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
		tempDir.removeSync();
	});

	const extensionWith = (name: string, handlers: IdleRecapHandler[]): Extension => {
		const extensionPath = path.join(tempDir.path(), `${name}.ts`);
		return {
			path: extensionPath,
			resolvedPath: extensionPath,
			handlers: new Map([
				[
					"before_idle_recap",
					handlers.map(
						handler =>
							async (...args: unknown[]) =>
								handler(args[0] as BeforeIdleRecapEvent),
					),
				],
			]),
			tools: new Map(),
			assistantThinkingRenderers: [],
			fileWriteFallbackHandlers: [],
			fileDeleteFallbackHandlers: [],
			messageRenderers: new Map(),
			composerShapes: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};
	};

	const runnerFor = (extensions: Extension[]): ExtensionRunner => {
		// The runner only forwards the registry into handler contexts; these handlers never read it.
		const modelRegistry = {} as unknown as ModelRegistry;
		return new ExtensionRunner(
			extensions,
			new ExtensionRuntime(),
			tempDir.path(),
			SessionManager.inMemory(),
			modelRegistry,
		);
	};

	it("returns an empty result when no extension subscribes", async () => {
		const runner = runnerFor([]);

		expect(await runner.emitBeforeIdleRecap({ signal: new AbortController().signal })).toEqual({});
	});

	it("joins non-empty prompts from every handler in order and drops blank ones", async () => {
		const runner = runnerFor([
			extensionWith("first", [() => ({ prompt: "Run the capture-context skill now." }), () => ({ prompt: "   " })]),
			extensionWith("second", [() => undefined, () => ({ prompt: "Second prompt" })]),
		]);

		expect(await runner.emitBeforeIdleRecap({ signal: new AbortController().signal })).toEqual({
			prompt: "Run the capture-context skill now.\nSecond prompt",
		});
	});

	it("does not treat skip: false as a veto", async () => {
		const runner = runnerFor([extensionWith("keep", [() => ({ skip: false, prompt: "Keep going" })])]);

		expect(await runner.emitBeforeIdleRecap({ signal: new AbortController().signal })).toEqual({
			prompt: "Keep going",
		});
	});

	it("passes the dispatch signal to each handler on the event", async () => {
		const controller = new AbortController();
		const seen: BeforeIdleRecapEvent[] = [];
		const runner = runnerFor([
			extensionWith("observer", [
				event => {
					seen.push(event);
					return undefined;
				},
			]),
		]);

		expect(await runner.emitBeforeIdleRecap({ signal: controller.signal })).toEqual({});
		expect(seen).toHaveLength(1);
		expect(seen[0]?.type).toBe("before_idle_recap");
		expect(seen[0]?.signal).toBe(controller.signal);
	});

	it("lets any skip veto the recap, discarding collected prompts and short-circuiting later handlers", async () => {
		let laterCalled = false;
		const runner = runnerFor([
			extensionWith("prompter", [() => ({ prompt: "dropped" })]),
			extensionWith("vetoer", [() => ({ skip: true, prompt: "also dropped" })]),
			extensionWith("later", [
				() => {
					laterCalled = true;
					return { prompt: "never delivered" };
				},
			]),
		]);

		expect(await runner.emitBeforeIdleRecap({ signal: new AbortController().signal })).toEqual({ skip: true });
		expect(laterCalled).toBe(false);
	});

	it("skips without running any handler when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		let called = false;
		const runner = runnerFor([
			extensionWith("unreached", [
				() => {
					called = true;
					return { prompt: "should not run" };
				},
			]),
		]);

		expect(await runner.emitBeforeIdleRecap({ signal: controller.signal })).toEqual({ skip: true });
		expect(called).toBe(false);
	});

	it("skips and reports no error when the signal aborts while a handler is pending", async () => {
		const controller = new AbortController();
		// Never resolved: the abort must settle the race, not the handler finishing.
		const pending = Promise.withResolvers<never>();
		let laterCalled = false;
		const runner = runnerFor([
			extensionWith("aborter", [
				async () => {
					controller.abort();
					return pending.promise;
				},
			]),
			extensionWith("later", [
				() => {
					laterCalled = true;
					return { prompt: "never delivered" };
				},
			]),
		]);
		const errors: ExtensionError[] = [];
		runner.onError(error => errors.push(error));

		expect(await runner.emitBeforeIdleRecap({ signal: controller.signal })).toEqual({ skip: true });
		expect(laterCalled).toBe(false);
		expect(errors).toEqual([]);
	});

	it("fails closed and reports the error when a handler throws", async () => {
		let laterCalled = false;
		const runner = runnerFor([
			extensionWith("boom", [
				() => {
					throw new Error("recap probe failed");
				},
			]),
			extensionWith("later", [
				() => {
					laterCalled = true;
					return { prompt: "never delivered" };
				},
			]),
		]);
		const errors: ExtensionError[] = [];
		runner.onError(error => errors.push(error));

		expect(await runner.emitBeforeIdleRecap({ signal: new AbortController().signal })).toEqual({ skip: true });
		expect(laterCalled).toBe(false);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ event: "before_idle_recap", error: "recap probe failed" });
	});

	it("fails closed and reports the error when a handler exceeds its budget", async () => {
		testSetExtensionHandlerTimeoutMs(10);
		const runner = runnerFor([extensionWith("stuck", [() => Promise.withResolvers<never>().promise])]);
		const errors: ExtensionError[] = [];
		runner.onError(error => errors.push(error));

		expect(await runner.emitBeforeIdleRecap({ signal: new AbortController().signal })).toEqual({ skip: true });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ event: "before_idle_recap", error: "handler timed out after 10ms" });
	});
});
