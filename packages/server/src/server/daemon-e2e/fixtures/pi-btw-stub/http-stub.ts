import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { z } from "zod";

const RequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(
      z.object({ role: z.string(), content: z.unknown().optional() }).passthrough(),
    ),
  })
  .passthrough();
export type BtwCapturedRequest = z.infer<typeof RequestSchema>;

/** Real Pi speaks HTTP to this scripted model; these captures prove routing, not live-provider behavior. */
export async function startBtwHttpStub() {
  const requests: BtwCapturedRequest[] = [];
  const held = new Map<string, Set<() => void>>();
  let requestNumber = 0;
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = RequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      requests.push(body);
      const messages = body.messages.map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      );
      const question = messages.at(-1) ?? "";
      const isBtw = messages.some((text) => text?.includes("<btw>"));
      if (isBtw && question.includes("FAIL_BTW")) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "BTW fixture provider failed", type: "server_error" },
          }),
        );
        return;
      }
      const id = `btw-http-${++requestNumber}`;
      const btwAnswer = question.includes("AFTER_B") ? "AFTER_B" : "CONTEXT_A";
      let text = question.includes("HOLD_PARENT") ? "PARENT_B_FINISHED" : "PARENT_A_FINISHED";
      if (isBtw) text = `BTW_REPLY ${btwAnswer}`;
      let marker: "btw" | "parent" | null = null;
      if (isBtw && question.includes("HOLD_BTW")) marker = "btw";
      if (!isBtw && question.includes("HOLD_PARENT")) marker = "parent";
      const reply = () => sendAnswer(response, id, body.model, text);
      if (marker) {
        const gates = held.get(marker) ?? new Set<() => void>();
        gates.add(reply);
        held.set(marker, gates);
        response.on("close", () => gates.delete(reply));
      } else reply();
    } catch {
      response.writeHead(400);
      response.end("Invalid fixture request");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture HTTP port");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    release(marker: "parent" | "btw") {
      const gates = held.get(marker);
      held.delete(marker);
      for (const reply of gates ?? []) reply();
    },
    pending(marker: "parent" | "btw") {
      return held.get(marker)?.size ?? 0;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }),
      );
    },
  };
}
function sendAnswer(response: ServerResponse, id: string, model: string, text: string) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const chunk = (delta: object, finish_reason: string | null = null) => ({
    id,
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason }],
  });
  response.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: text }))}\n\n`);
  response.write(
    `data: ${JSON.stringify({ ...chunk({}, "stop"), usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104 } })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}
