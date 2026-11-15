import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseOpenProjectPathFromArgv } from "./open-project-routing";

describe("open-project-routing", () => {
  const launchDirectories: string[] = [];

  afterEach(() => {
    for (const directory of launchDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([null, "positional", "flagged"])(
    "skips the unpackaged Electron app directory with a %s project argument",
    (projectArgument) => {
      const root = mkdtempSync(path.join(tmpdir(), "paseo-electron-launch-"));
      launchDirectories.push(root);
      const appDirectory = path.join(root, "electron-app");
      const projectDirectory = path.join(root, "my-project");
      mkdirSync(appDirectory);
      mkdirSync(projectDirectory);
      const argv = [
        "/nix/store/electron/bin/electron",
        appDirectory,
        "--no-sandbox",
        "--class=paseo-desktop",
      ];
      if (projectArgument === "flagged") {
        argv.push("--open-project");
      }
      if (projectArgument !== null) {
        argv.push(projectDirectory);
      }

      expect(parseOpenProjectPathFromArgv({ argv, isDefaultApp: true })).toBe(
        projectArgument === null ? null : projectDirectory,
      );
    },
  );

  it("returns a bare absolute path argument", () => {
    const projectPath = mkdtempSync(path.join(tmpdir(), "paseo-open-project-"));

    expect(
      parseOpenProjectPathFromArgv({
        argv: ["/Applications/Paseo.app/Contents/MacOS/Paseo", projectPath],
        isDefaultApp: false,
      }),
    ).toBe(projectPath);
  });

  it("finds a bare absolute path even when Chromium noise args appear first", () => {
    const projectPath = mkdtempSync(path.join(tmpdir(), "paseo-open-project-"));

    expect(
      parseOpenProjectPathFromArgv({
        argv: [
          "/Applications/Paseo.app/Contents/MacOS/Paseo",
          "--allow-file-access-from-files",
          "--no-sandbox",
          projectPath,
        ],
        isDefaultApp: false,
      }),
    ).toBe(projectPath);
  });

  it("does not treat flags as project paths", () => {
    const projectPath = mkdtempSync(path.join(tmpdir(), "paseo-open-project-"));
    const flagLikeDirectory = path.join(projectPath, "--version");
    mkdirSync(flagLikeDirectory);

    expect(
      parseOpenProjectPathFromArgv({
        argv: ["/Applications/Paseo.app/Contents/MacOS/Paseo", "--version", flagLikeDirectory],
        isDefaultApp: false,
      }),
    ).toBe(flagLikeDirectory);

    expect(
      parseOpenProjectPathFromArgv({
        argv: ["/Applications/Paseo.app/Contents/MacOS/Paseo", "--version"],
        isDefaultApp: false,
      }),
    ).toBeNull();
  });

  it("returns the path from an explicit --open-project flag for backward compatibility", () => {
    const projectPath = mkdtempSync(path.join(tmpdir(), "paseo-open-project-"));

    expect(
      parseOpenProjectPathFromArgv({
        argv: ["/Applications/Paseo.app/Contents/MacOS/Paseo", "--open-project", projectPath],
        isDefaultApp: false,
      }),
    ).toBe(projectPath);
  });
});
