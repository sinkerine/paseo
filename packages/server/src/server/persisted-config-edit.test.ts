import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  editPersistedConfig,
  getPersistedConfigValue,
  readPersistedConfig,
} from "./persisted-config.js";

test("configuration edits validate before writing and preserve unrelated settings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-config-edit-"));
  const home = path.join(root, "home");
  try {
    expect(readPersistedConfig(home)).toEqual({});
    expect(existsSync(home)).toBe(false);
    for (const field of [
      "unknown",
      "daemon.missing",
      "daemon.__proto__.listen",
      "daemon.auth.password",
    ]) {
      expect(() => editPersistedConfig(home, field, { value: "value" })).toThrow();
      expect(existsSync(home)).toBe(false);
    }
    editPersistedConfig(home, "daemon.listen", { value: "127.0.0.1:12345" });
    editPersistedConfig(home, "features.webUi.enabled", { value: true });
    const before = await readFile(path.join(home, "config.json"), "utf8");
    expect(() => editPersistedConfig(home, "features.webUi.enabled", { value: "true" })).toThrow();
    expect(() =>
      editPersistedConfig(home, "daemon", { value: { auth: { password: "plaintext" } } }),
    ).toThrow(/set-password/);
    expect(await readFile(path.join(home, "config.json"), "utf8")).toBe(before);
    editPersistedConfig(home, "features.webUi.enabled", { unset: true });
    const edited = readPersistedConfig(home);
    expect(getPersistedConfigValue(edited, "features.webUi.enabled")).toBeUndefined();
    expect(edited.daemon?.listen).toBe("127.0.0.1:12345");
    await writeFile(path.join(home, "config.json"), "invalid json");
    expect(() => editPersistedConfig(home, "daemon.listen", { value: "12345" })).toThrow();
    expect(await readFile(path.join(home, "config.json"), "utf8")).toBe("invalid json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration paths edit provider overrides without replacing other providers", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-provider-edit-"));
  try {
    editPersistedConfig(home, "agents.providers.claude.enabled", { value: false });
    editPersistedConfig(home, "agents.providers.pi.env.PI_CODING_AGENT_DIR", { value: "/tmp/pi" });
    editPersistedConfig(home, "agents.providers.pi.options.rpcTimeoutMs", { value: 120000 });
    editPersistedConfig(home, "agents.providers.pi.command", { value: ["pi", "--verbose"] });
    const config = readPersistedConfig(home);
    expect(getPersistedConfigValue(config, "agents.providers")).toEqual({
      claude: { enabled: false },
      pi: {
        env: { PI_CODING_AGENT_DIR: "/tmp/pi" },
        options: { rpcTimeoutMs: 120000 },
        command: ["pi", "--verbose"],
      },
    });
    const before = await readFile(path.join(home, "config.json"), "utf8");
    for (const field of [
      "agents.providers.pi.enabled",
      "agents.providers.pi.env.PI_CODING_AGENT_DIR",
      "agents.providers.pi.unknown",
      "agents.providers.Invalid.enabled",
      "agents.providers.pi.options.__proto__",
    ]) {
      expect(() => editPersistedConfig(home, field, { value: 123 })).toThrow();
      expect(await readFile(path.join(home, "config.json"), "utf8")).toBe(before);
    }
    editPersistedConfig(home, "agents.providers.pi.env.PI_CODING_AGENT_DIR", { unset: true });
    editPersistedConfig(home, "agents.providers.claude", { unset: true });
    expect(getPersistedConfigValue(readPersistedConfig(home), "agents.providers")).toEqual({
      pi: { env: {}, options: { rpcTimeoutMs: 120000 }, command: ["pi", "--verbose"] },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("configuration paths edit plugin entries and validate complete plugin definitions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-edit-"));
  try {
    editPersistedConfig(home, "plugins.my-plugin", {
      value: { source: "directory", path: "/tmp/my-plugin" },
    });
    editPersistedConfig(home, "plugins.my-plugin.enabled", { value: false });
    editPersistedConfig(home, "plugins.my-plugin.path", { value: "/tmp/updated-plugin" });
    expect(getPersistedConfigValue(readPersistedConfig(home), "plugins.my-plugin")).toEqual({
      source: "directory",
      path: "/tmp/updated-plugin",
      enabled: false,
    });
    const before = await readFile(path.join(home, "config.json"), "utf8");
    for (const field of [
      "plugins.new-plugin.enabled",
      "plugins.my-plugin.source",
      "plugins.Invalid.path",
    ]) {
      expect(() => editPersistedConfig(home, field, { value: true })).toThrow();
      expect(await readFile(path.join(home, "config.json"), "utf8")).toBe(before);
    }
    editPersistedConfig(home, "plugins.my-plugin", { unset: true });
    expect(readPersistedConfig(home).plugins).toEqual({});
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("configuration edits reject traversal through scalar options and leave missing paths unset", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-option-edit-"));
  try {
    editPersistedConfig(home, "agents.providers.pi.options.rpcTimeoutMs", { unset: true });
    expect(existsSync(path.join(home, "config.json"))).toBe(false);
    editPersistedConfig(home, "agents.providers.pi.options.transport", { value: "stdio" });
    const before = await readFile(path.join(home, "config.json"), "utf8");
    expect(() =>
      editPersistedConfig(home, "agents.providers.pi.options.transport.mode", { value: "rpc" }),
    ).toThrow(/Unknown configuration path/);
    expect(() =>
      editPersistedConfig(home, "agents.providers.pi.command.0", { value: "pi" }),
    ).toThrow(/Unknown configuration path/);
    expect(await readFile(path.join(home, "config.json"), "utf8")).toBe(before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("configuration paths edit fields inside speech provider variants", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-speech-edit-"));
  try {
    editPersistedConfig(home, "features.voiceMode.stt", { value: { provider: "openai" } });
    editPersistedConfig(home, "features.voiceMode.stt.apiKey", { value: "site-secret" });
    const config = readPersistedConfig(home);
    expect(getPersistedConfigValue(config, "features.voiceMode.stt.apiKey")).toBe("site-secret");
    editPersistedConfig(home, "features.voiceMode.stt.apiKey", { unset: true });
    expect(
      getPersistedConfigValue(readPersistedConfig(home), "features.voiceMode.stt.apiKey"),
    ).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
