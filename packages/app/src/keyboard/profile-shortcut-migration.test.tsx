/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { getShortcutOverrideStore, QUERY_KEY } from "@/hooks/use-keyboard-shortcut-overrides";
import type { ShortcutOverrides } from "@/keyboard/keyboard-shortcuts";
import { ProfileShortcutMigration } from "./profile-shortcut-migration";

// Keep the hook, query cache and serialized store real; isolate host profiles and storage I/O.
const boundary = vi.hoisted(() => ({
  profiles: new Map<string, AgentProfile[] | null>(),
  omittedProfiles: new Set<string>(),
  unsupported: new Set<string>(),
  subscribed: new Set<string>(),
  useAgentProfiles: vi.fn(),
  entries: new Map<string, string>(),
  read: null as Promise<string | null> | null,
  write: vi.fn(),
}));
vi.mock("@/agent-profiles", () => ({
  useAgentProfiles: (serverId: string) => {
    boundary.useAgentProfiles(serverId);
    React.useEffect(() => {
      boundary.subscribed.add(serverId);
      return () => {
        boundary.subscribed.delete(serverId);
      };
    }, [serverId]);
    return {
      profiles: boundary.omittedProfiles.has(serverId)
        ? []
        : (boundary.profiles.get(serverId) ?? null),
      isSupported: !boundary.unsupported.has(serverId),
    };
  },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => boundary.read ?? Promise.resolve(boundary.entries.get(key) ?? null),
    setItem: async (key: string, value: string) => {
      await boundary.write(key, value);
      boundary.entries.set(key, value);
    },
    removeItem: async (key: string) => {
      boundary.entries.delete(key);
    },
  },
}));

const STORAGE_KEY = "@paseo:keyboard-shortcut-overrides";
const legacyA = JSON.stringify(["agent-profile.select", "host-a", "profile-a"]);
const legacyB = JSON.stringify(["agent-profile.select", "host-b", "profile-b"]);
const shared = JSON.stringify(["agent-profile.select", "saved"]);
const profilesA: AgentProfile[] = [{ id: "profile-a", name: "Saved", provider: "claude" }];
const profilesB: AgentProfile[] = [{ id: "profile-b", name: " saved ", provider: "pi" }];
let queryClient: QueryClient;

function TestMigration({ hosts = ["host-a"] }: { hosts?: string[] }) {
  return (
    <QueryClientProvider client={queryClient}>
      {hosts.map((serverId) => (
        <ProfileShortcutMigration key={serverId} serverId={serverId} />
      ))}
    </QueryClientProvider>
  );
}

function seed(overrides: ShortcutOverrides) {
  boundary.entries.set(STORAGE_KEY, JSON.stringify(overrides));
}
function persisted(): ShortcutOverrides {
  return JSON.parse(boundary.entries.get(STORAGE_KEY) ?? "{}");
}
async function expectPersisted(overrides: ShortcutOverrides) {
  await waitFor(() => expect(persisted()).toEqual(overrides));
  expect(queryClient.getQueryData(QUERY_KEY)).toEqual(overrides);
}

beforeEach(() => {
  boundary.entries.clear();
  boundary.profiles.clear();
  boundary.omittedProfiles.clear();
  boundary.unsupported.clear();
  boundary.subscribed.clear();
  boundary.read = null;
  boundary.write.mockReset();
  boundary.useAgentProfiles.mockReset();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("ProfileShortcutMigration", () => {
  it("waits for override hydration before subscribing or writing, preserving the full map", async () => {
    const hydration = Promise.withResolvers<string | null>();
    boundary.read = hydration.promise;
    boundary.profiles.set("host-a", profilesA);
    const original = { [legacyA]: "Mod+1", [legacyB]: "Mod+2", "open-settings": "Mod+3" };
    seed(original);
    render(<TestMigration />);

    await act(async () => {});
    expect(boundary.write).not.toHaveBeenCalled();
    expect(boundary.useAgentProfiles).not.toHaveBeenCalled();
    expect(persisted()).toEqual(original);

    await act(async () => hydration.resolve(JSON.stringify(original)));
    await expectPersisted({ [shared]: "Mod+1", [legacyB]: "Mod+2", "open-settings": "Mod+3" });
  });

  it("opens no profile subscription for a host without legacy keys", async () => {
    const original = { [legacyB]: "Mod+2", [shared]: "Mod+3" };
    seed(original);
    render(<TestMigration />);

    await waitFor(() => expect(queryClient.getQueryData(QUERY_KEY)).toEqual(original));
    expect(boundary.useAgentProfiles).not.toHaveBeenCalled();
    expect(boundary.write).not.toHaveBeenCalled();
    expect(persisted()).toEqual(original);
  });

  it("migrates once profiles arrive and leaves another host's legacy key untouched", async () => {
    seed({ [legacyA]: "Mod+1", [legacyB]: "Mod+2" });
    const view = render(<TestMigration />);
    await waitFor(() => expect(boundary.useAgentProfiles).toHaveBeenCalledWith("host-a"));
    expect(boundary.write).not.toHaveBeenCalled();

    boundary.profiles.set("host-a", profilesA);
    view.rerender(<TestMigration />);
    await expectPersisted({ [shared]: "Mod+1", [legacyB]: "Mod+2" });
    expect(boundary.write).toHaveBeenCalledTimes(1);
  });

  it("does not write when the host does not support profiles", async () => {
    seed({ [legacyA]: "Mod+1" });
    boundary.profiles.set("host-a", profilesA);
    boundary.unsupported.add("host-a");
    render(<TestMigration />);

    await waitFor(() => expect(boundary.useAgentProfiles).toHaveBeenCalledWith("host-a"));
    expect(boundary.write).not.toHaveBeenCalled();
    expect(persisted()).toEqual({ [legacyA]: "Mod+1" });
  });

  it("keeps the first host's binding when two migrations queue while a write is pending", async () => {
    seed({ [legacyA]: "Mod+1", [legacyB]: "Mod+2", "open-settings": "Mod+3" });
    boundary.profiles.set("host-a", profilesA);
    boundary.profiles.set("host-b", profilesB);
    const pending = Promise.withResolvers<void>();
    boundary.write.mockImplementationOnce(() => pending.promise);
    render(<TestMigration hosts={["host-a", "host-b"]} />);

    await waitFor(() => expect(boundary.write).toHaveBeenCalledTimes(1));
    expect(persisted()).toEqual({
      [legacyA]: "Mod+1",
      [legacyB]: "Mod+2",
      "open-settings": "Mod+3",
    });
    await act(async () => pending.resolve());
    await expectPersisted({ [shared]: "Mod+1", "open-settings": "Mod+3" });
    expect(boundary.write).toHaveBeenCalledTimes(2);
  });

  it("keeps a user edit queued before migration", async () => {
    seed({ [legacyA]: "Mod+1" });
    const view = render(<TestMigration />);
    await waitFor(() => expect(boundary.useAgentProfiles).toHaveBeenCalledWith("host-a"));
    const pending = Promise.withResolvers<void>();
    boundary.write.mockImplementationOnce(() => pending.promise);
    const edit = getShortcutOverrideStore(queryClient).set(shared, "Mod+9");
    boundary.profiles.set("host-a", profilesA);
    view.rerender(<TestMigration />);

    await waitFor(() => expect(boundary.write).toHaveBeenCalledTimes(1));
    await act(async () => {
      pending.resolve();
      await edit;
    });
    await expectPersisted({ [shared]: "Mod+9" });
  });

  it("migrates a changed host even when it shares the same profile input", async () => {
    const otherHostLegacy = JSON.stringify(["agent-profile.select", "host-b", "profile-a"]);
    seed({ [legacyA]: "Mod+1", [otherHostLegacy]: "Mod+2" });
    boundary.profiles.set("host-a", profilesA);
    boundary.profiles.set("host-b", profilesA);
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ProfileShortcutMigration serverId="host-a" />
      </QueryClientProvider>,
    );
    await expectPersisted({ [shared]: "Mod+1", [otherHostLegacy]: "Mod+2" });

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <ProfileShortcutMigration serverId="host-b" />
      </QueryClientProvider>,
    );
    await expectPersisted({ [shared]: "Mod+1" });
    expect(boundary.write).toHaveBeenCalledTimes(2);
  });

  it("allows a fresh attempt after the outer component remounts", async () => {
    const error = new Error("storage unavailable");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    seed({ [legacyA]: "Mod+1" });
    boundary.profiles.set("host-a", profilesA);
    boundary.write.mockRejectedValueOnce(error);
    const view = render(<TestMigration />);
    await waitFor(() => expect(logged).toHaveBeenCalledTimes(1));
    await expectPersisted({ [legacyA]: "Mod+1" });
    expect(boundary.write).toHaveBeenCalledTimes(1);
    view.unmount();

    render(<TestMigration />);
    await expectPersisted({ [shared]: "Mod+1" });
    expect(boundary.write).toHaveBeenCalledTimes(2);
  });

  it("does not retry a delayed failure when omitted profiles produce a fresh empty array", async () => {
    const error = new Error("storage unavailable");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = { [legacyA]: "Mod+1", [legacyB]: "Mod+2" };
    seed(original);
    boundary.omittedProfiles.add("host-a");
    const pending = Promise.withResolvers<void>();
    boundary.write.mockImplementationOnce(() => pending.promise);
    const view = render(
      <React.StrictMode>
        <TestMigration />
      </React.StrictMode>,
    );

    await waitFor(() => {
      expect(boundary.write).toHaveBeenCalledTimes(1);
      expect(queryClient.getQueryData(QUERY_KEY)).toEqual({ [legacyB]: "Mod+2" });
      expect(boundary.subscribed.has("host-a")).toBe(false);
    });
    expect(persisted()).toEqual(original);

    await act(async () => pending.reject(error));
    await waitFor(() =>
      expect(logged).toHaveBeenCalledExactlyOnceWith(
        "[KeyboardShortcutOverrides] Failed to save overrides:",
        error,
      ),
    );
    await expectPersisted(original);
    await waitFor(() => expect(boundary.subscribed.has("host-a")).toBe(true));
    expect(boundary.write).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 3; index++) {
      view.rerender(
        <React.StrictMode>
          <TestMigration />
        </React.StrictMode>,
      );
      await act(async () => {});
      expect(boundary.write).toHaveBeenCalledTimes(1);
      await expectPersisted(original);
    }
  });

  it("does not retry a delayed failure after an optimistic unmount until profiles change", async () => {
    const error = new Error("storage unavailable");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    seed({ [legacyA]: "Mod+1", [legacyB]: "Mod+2" });
    boundary.profiles.set("host-a", profilesA);
    const pending = Promise.withResolvers<void>();
    boundary.write.mockImplementationOnce(() => pending.promise);
    const migration = (
      <React.StrictMode>
        <TestMigration />
      </React.StrictMode>
    );
    const view = render(migration);

    await waitFor(() => {
      expect(boundary.write).toHaveBeenCalledTimes(1);
      expect(queryClient.getQueryData(QUERY_KEY)).toEqual({
        [shared]: "Mod+1",
        [legacyB]: "Mod+2",
      });
      expect(boundary.subscribed.has("host-a")).toBe(false);
    });
    expect(persisted()).toEqual({ [legacyA]: "Mod+1", [legacyB]: "Mod+2" });

    await act(async () => pending.reject(error));
    await waitFor(() =>
      expect(logged).toHaveBeenCalledExactlyOnceWith(
        "[KeyboardShortcutOverrides] Failed to save overrides:",
        error,
      ),
    );
    await expectPersisted({ [legacyA]: "Mod+1", [legacyB]: "Mod+2" });
    await waitFor(() => expect(boundary.subscribed.has("host-a")).toBe(true));
    expect(boundary.write).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 3; index++) {
      view.rerender(
        <React.StrictMode>
          <TestMigration />
        </React.StrictMode>,
      );
      await act(async () => {});
      expect(boundary.write).toHaveBeenCalledTimes(1);
    }

    boundary.profiles.set("host-a", [...profilesA]);
    view.rerender(
      <React.StrictMode>
        <TestMigration />
      </React.StrictMode>,
    );
    await expectPersisted({ [shared]: "Mod+1", [legacyB]: "Mod+2" });
    expect(boundary.write).toHaveBeenCalledTimes(2);
  });
});
