/** The SDK is resolved by the installed Pi loader, never by the daemon's dependency graph. */
export function piSessionForkHelperSource(): string {
  return `
import { readFileSync } from "node:fs";
import { SessionManager, CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
export default function(pi) {
  pi.registerCommand("paseo_fork_branch", {
    description: "Materialize an isolated native branch",
    handler: async (args, ctx) => {
      let result;
      try {
        const p = JSON.parse(Buffer.from(args.trim(), "base64url").toString("utf8"));
        const header = JSON.parse(readFileSync(p.sourceFile, "utf8").split("\\n")[0]);
        if (typeof SessionManager.prototype.createBranchedSession !== "function") {
          result = { ok: false, code: "unsupported", error: "Update Pi to a version with the public native session branching API." };
        } else if (header.type !== "session" || header.version !== CURRENT_SESSION_VERSION) {
          result = { ok: false, code: "source_needs_migration", error: "Update or migrate the source in Pi before forking." };
        } else {
          const manager = SessionManager.open(p.sourceFile, p.stagingDir);
          if (!manager.getEntries().some(entry => entry.id === p.targetEntryId)) throw new Error("Native boundary not found");
          const sessionFile = manager.createBranchedSession(p.targetEntryId);
          result = { ok: true, sessionFile, sessionId: manager.getSessionId() };
        }
      } catch (error) {
        result = { ok: false, code: "materialize_failed", error: String(error) };
      }
      ctx.ui.notify("PASEO_COMMAND_RESULT " + JSON.stringify(result), result.ok ? "info" : "error");
    }
  });
}`;
}
