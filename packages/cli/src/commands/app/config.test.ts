import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { startAppConfigServer } from "../../../../desktop/src/settings/app-config-server.js";
import { requestAppConfig } from "./config.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) await cleanup();
  cleanups.length = 0;
});

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-app-config-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

it("reads and writes through the authenticated local desktop endpoint", async () => {
  const directory = await setup();
  let preference: unknown = false;
  const stop = await startAppConfigServer({
    userDataPath: directory,
    execute: async (request) => {
      if (request.operation === "set") preference = request.value;
      if (request.operation === "unset") preference = false;
      return { ok: true, data: { value: preference } };
    },
  });
  cleanups.push(stop);
  expect(
    await requestAppConfig({ operation: "get", path: "settings.vimKeybindings" }, directory),
  ).toEqual({ value: false });
  expect(
    await requestAppConfig(
      { operation: "set", path: "settings.vimKeybindings", value: true },
      directory,
    ),
  ).toEqual({ value: true });
  expect(
    await requestAppConfig({ operation: "unset", path: "settings.vimKeybindings" }, directory),
  ).toEqual({ value: false });
  const endpointPath = path.join(directory, "app-config-endpoint.json");
  const endpoint = JSON.parse(await readFile(endpointPath, "utf8"));
  if (process.platform !== "win32") expect((await stat(endpointPath)).mode & 0o777).toBe(0o600);
  for (const headers of [
    {},
    { Authorization: "Bearer incorrect" },
    { Authorization: `Bearer ${endpoint.token}`, Origin: "https://example.com" },
  ]) {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({ operation: "get" }),
    });
    expect(response.status).toBe(403);
  }
  const invalid = await fetch(`http://127.0.0.1:${endpoint.port}/config`, {
    method: "POST",
    headers: { Authorization: `Bearer ${endpoint.token}` },
    body: JSON.stringify({ operation: "execute", script: "arbitrary code" }),
  });
  expect(invalid.status).toBe(400);
});

it("reports app-side failures and missing desktop endpoints", async () => {
  const directory = await setup();
  await expect(requestAppConfig({ operation: "get" }, directory)).rejects.toThrow(
    /Start an updated Paseo Desktop/,
  );
  const stop = await startAppConfigServer({
    userDataPath: directory,
    execute: async () => ({ ok: false, error: "Disk full" }),
  });
  cleanups.push(stop);
  await expect(
    requestAppConfig({ operation: "set", path: "settings.vimKeybindings", value: true }, directory),
  ).rejects.toThrow("Disk full");
});
