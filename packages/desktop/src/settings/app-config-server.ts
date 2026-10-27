import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  AppConfigRequestSchema,
  AppConfigResponseSchema,
  type AppConfigRequest,
  type AppConfigResponse,
} from "@getpaseo/protocol/app-config";

interface AppConfigServerOptions {
  userDataPath: string;
  execute(request: AppConfigRequest): Promise<AppConfigResponse>;
}

export async function startAppConfigServer(
  options: AppConfigServerOptions,
): Promise<() => Promise<void>> {
  const token = randomBytes(32).toString("hex");
  const endpoint = path.join(options.userDataPath, "app-config-endpoint.json");
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    const authorization = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    const authenticated =
      authorization.length === expected.length && timingSafeEqual(authorization, expected);
    if (
      !authenticated ||
      request.headers.origin ||
      request.method !== "POST" ||
      request.url !== "/config"
    ) {
      response.writeHead(403).end(JSON.stringify({ ok: false, error: "Forbidden" }));
      return;
    }
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 65536)
          throw new Error("App configuration request is too large.");
      }
      const input = AppConfigRequestSchema.parse(JSON.parse(body));
      const result = AppConfigResponseSchema.parse(await options.execute(input));
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400).end(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });
  server.requestTimeout = 15000;
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not bind desktop configuration endpoint.");
  await mkdir(options.userDataPath, { recursive: true });
  const temporary = `${endpoint}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, port: address.port, token }), {
      mode: 0o600,
    });
    await rename(temporary, endpoint);
  } catch (error) {
    server.close();
    await rm(temporary, { force: true });
    throw error;
  }
  return async () => {
    server.close();
    server.closeAllConnections();
    await rm(endpoint, { force: true });
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}
