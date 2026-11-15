import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { addOpenOptions, resolveOpenFocusMode } from "./open.js";

describe("agent open focus", () => {
  it.each([
    [undefined, true, false],
    [undefined, false, true],
    [true, true, true],
    [true, false, true],
    [false, true, false],
    [false, false, false],
  ])("resolves explicit=%s caller=%s to %s", (explicitFocus, hasCallerAgent, expected) => {
    expect(resolveOpenFocusMode({ explicitFocus, hasCallerAgent })).toBe(expected);
  });
  it.each([
    [[], undefined],
    [["--focus"], true],
    [["--no-focus"], false],
    [["--no-focus", "--focus"], true],
  ])("parses %j", (flags, expected) => {
    const command = addOpenOptions(new Command()).action(() => {});
    command.parse(["agent-id", ...(flags as string[])], { from: "user" });
    expect(command.opts().focus).toBe(expected);
  });
});
