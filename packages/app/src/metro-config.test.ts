import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const config = require("../metro.config.cjs") as {
  resolver: { blockList: RegExp | RegExp[] };
};
const appRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(appRoot, "../..");
const patterns = Array.isArray(config.resolver.blockList)
  ? config.resolver.blockList
  : [config.resolver.blockList];
const blocked = (file: string) => patterns.some((pattern) => pattern.test(file));

describe("Metro file-map boundaries", () => {
  it.each([
    ".dev/android/gradle/caches/package.json",
    ".dev/android/tmp/metro-cache/transform.js",
    "artifacts/android-nix/tuning/recipe.json",
  ])("excludes local tool state and evidence: %s", (file) => {
    expect(blocked(path.join(repositoryRoot, file))).toBe(true);
  });

  it("retains Expo's native build directory exclusions", () => {
    expect(blocked("android/app/build")).toBe(true);
    expect(blocked("android/.gradle")).toBe(true);
    expect(blocked("ios/Pods")).toBe(true);
  });

  it("keeps compiled workspace packages and app source available", () => {
    expect(blocked(path.join(repositoryRoot, "packages/client/dist/index.js"))).toBe(false);
    expect(blocked(path.join(repositoryRoot, "node_modules/react-native/index.js"))).toBe(false);
    expect(blocked(path.join(appRoot, "src/app/index.tsx"))).toBe(false);
  });

  it("retains the app test-file exclusion", () => {
    expect(blocked(path.join(appRoot, "src/example.test.tsx"))).toBe(true);
  });
});
