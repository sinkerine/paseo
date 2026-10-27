import type { AppConfigRequest } from "@getpaseo/protocol/app-config";
import equal from "fast-deep-equal";
import { z } from "zod";
import {
  DEFAULT_CLIENT_SETTINGS,
  normalizeAppSettings,
  type AppSettings,
} from "@/hooks/use-settings/storage";
import {
  DEFAULT_BINDINGS,
  buildEffectiveBindings,
  type ShortcutOverrides,
  normalizeCapturedShortcutCombo,
  isShortcutCaptureComplete,
} from "@/keyboard/keyboard-shortcuts";
import { agentProfileShortcutBinding } from "@/agent-profiles/shortcuts";
import { parseChordString } from "@/keyboard/shortcut-string";

export interface AppConfigOwner {
  readSettings(): Promise<AppSettings>;
  writeSettings(settings: AppSettings): Promise<void>;
  readShortcuts(): Promise<ShortcutOverrides>;
  writeShortcut(id: string, value: string | null | undefined): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function partsOf(path: string): string[] {
  const parts = path.split(".");
  if (parts.some((part) => !part || ["__proto__", "constructor", "prototype"].includes(part))) {
    throw new Error(`Invalid app configuration path: ${path}`);
  }
  return parts;
}

function readPath(root: unknown, parts: string[]): unknown {
  return parts.reduce<unknown>((value, part) => (record(value) ? value[part] : undefined), root);
}

function settingsParts(parts: string[]): string[] {
  let template: unknown = DEFAULT_CLIENT_SETTINGS;
  for (const part of parts) {
    if (!record(template)) throw new Error("Replace arrays and scalar preferences as a whole.");
    if (Object.keys(template).length === 0) return parts;
    if (!Object.hasOwn(template, part))
      throw new Error(`Unknown app preference: ${parts.join(".")}`);
    template = template[part];
  }
  return parts;
}

function validateKeys(value: unknown, template: unknown): void {
  if (!record(value) || !record(template) || Object.keys(template).length === 0) return;
  for (const [key, child] of Object.entries(value)) {
    if (!Object.hasOwn(template, key)) throw new Error(`Unknown app preference: ${key}`);
    validateKeys(child, template[key]);
  }
}

function shortcutId(parts: string[]): string {
  const id = parts.join(".");
  const knownBinding = DEFAULT_BINDINGS.some((binding) => binding.id === id);
  if (!knownBinding && !agentProfileShortcutBinding(id)) {
    throw new Error(`Unknown shortcut: ${id}. Use paseo app config shortcuts to list binding IDs.`);
  }
  return id;
}

function shortcutValue(
  request: Extract<AppConfigRequest, { operation: "set" | "unset" }>,
  id: string,
): string | null | undefined {
  if (request.operation === "unset") return undefined;
  const value = z.string().nullable().parse(request.value);
  if (value === null) return null;
  if (!value.trim())
    throw new Error("A shortcut must contain a key combination; use null to unassign it.");
  parseChordString(value);
  if (!isShortcutCaptureComplete(id, value.split(" ")))
    throw new Error("This shortcut must end with a number key.");
  return normalizeCapturedShortcutCombo(id, value);
}

function editableSettings(current: AppSettings): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const key of Object.keys(next)) {
    if (!Object.hasOwn(DEFAULT_CLIENT_SETTINGS, key)) delete next[key];
  }
  return structuredClone(next);
}

export function createAppConfigHandler(owner: AppConfigOwner) {
  let tail: Promise<unknown> = Promise.resolve();

  async function execute(request: AppConfigRequest): Promise<Record<string, unknown>> {
    if (request.operation === "shortcuts") {
      const overrides = await owner.readShortcuts();
      const defaults = new Map(DEFAULT_BINDINGS.map((binding) => [binding.id, binding.combo]));
      return {
        shortcuts: buildEffectiveBindings(overrides).map((binding) => ({
          id: binding.id,
          action: binding.action,
          default: defaults.get(binding.id) ?? null,
          effective: binding.combo || null,
          override: overrides[binding.id],
          platform: binding.when ?? {},
        })),
      };
    }
    const parts = request.path ? partsOf(request.path) : [];
    const [section, ...fields] = parts;
    if (section !== undefined && section !== "settings" && section !== "shortcuts") {
      throw new Error("App configuration paths start with settings or shortcuts.");
    }
    if (section === "settings") settingsParts(fields);
    if (section === "shortcuts" && fields.length > 0) shortcutId(fields);
    if (request.operation === "get") {
      const root = { settings: await owner.readSettings(), shortcuts: await owner.readShortcuts() };
      const value = readPath(root, parts);
      return { source: "desktop", path: request.path ?? null, set: value !== undefined, value };
    }
    if (!section || fields.length === 0)
      throw new Error("Select an individual preference or shortcut to edit.");
    if (section === "shortcuts") {
      const id = shortcutId(fields);
      await owner.writeShortcut(id, shortcutValue(request, id));
    } else {
      const current = await owner.readSettings();
      const next = editableSettings(current);
      let parent: Record<string, unknown> = next;
      for (const part of fields.slice(0, -1)) {
        const child = parent[part];
        if (!record(child)) throw new Error(`Cannot traverse preference: ${part}`);
        parent = child;
      }
      const key = fields.at(-1)!;
      if (request.operation === "unset") {
        const fallback = readPath(DEFAULT_CLIENT_SETTINGS, fields);
        if (fallback === undefined) delete parent[key];
        else parent[key] = structuredClone(fallback);
      } else parent[key] = request.value;
      validateKeys(next, DEFAULT_CLIENT_SETTINGS);
      const validated = normalizeAppSettings(next);
      if (!equal(validated, next))
        throw new Error("Invalid app preference value or value outside its supported range.");
      await owner.writeSettings(validated);
    }
    return { action: "saved", applied: true, path: request.path };
  }

  return (request: AppConfigRequest): Promise<Record<string, unknown>> => {
    const run = tail.then(() => execute(request));
    tail = run.catch(() => undefined);
    return run;
  };
}
