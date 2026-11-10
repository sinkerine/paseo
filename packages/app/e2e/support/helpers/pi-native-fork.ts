import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export async function createNativeForkTimelinePlugin(root: string): Promise<string> {
  const directory = await mkdtemp(path.join(root, "turn-actions-plugin-"));
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({
      id: "turn-actions-e2e",
      requirements: { paseo: ">=0.15.3" },
    }),
  );
  await writeFile(
    path.join(directory, "index.client.tsx"),
    `
import React from "react";
import { Text, View } from "react-native";
import { z } from "zod";
function Assistant({ item, turnActions }) {
  return <View><Text>{item.data.text}</Text><View testID="footer-toolbar">{turnActions}</View></View>;
}
export default function contribute(client) {
  client.addTimelineTransformer({ id: "assistant", query: { itemType: "assistant_message" },
    transform({ item }) { return { items: [{ type: "plugin", kind: "assistant", version: 1, data: { text: item.text } }] }; },
  });
  client.addTimelineRenderer({ kind: "assistant", version: 1, turnActions: "inline",
    schema: z.object({ text: z.string() }), Component: Assistant,
  });
  return () => {};
}
`,
  );
  return directory;
}

export async function createPiNativeForkRuntime() {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-pi-native-browser-"));
  const agentDir = path.join(root, "pi-agent");
  await mkdir(agentDir);
  for (const file of ["models.json", "auth.json"])
    await copyFile(path.join(homedir(), ".pi", "agent", file), path.join(agentDir, file));
  const binary = process.env.PASEO_PI_BINARY ?? "pi";
  // A real worker launch is delayed so pending/duplicate UI has a deterministic observation window.
  const wrapper = path.join(root, "pi-launch.cjs");
  await writeFile(
    wrapper,
    `const {spawn}=require("node:child_process");
const args=process.argv.slice(2);let child;
const launch=()=>{child=spawn(${JSON.stringify(binary)},args,{stdio:"inherit"});child.on("exit",(code)=>process.exit(code??1));child.on("error",()=>process.exit(1));};
for(const signal of ["SIGTERM","SIGINT"])process.on(signal,()=>{if(child)child.kill(signal);else process.exit(1);});
if(args.some(arg=>arg.endsWith("fork-helper.ts")))setTimeout(launch,1500);else launch();`,
  );
  const environment = {
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: path.join(root, "sessions"),
  };
  const clear = Object.keys(process.env).filter(
    (key) => key.startsWith("PI_") && !(key in environment),
  );
  const command = ["env", ...clear.flatMap((key) => ["-u", key]), process.execPath, wrapper];
  return {
    root,
    environment,
    daemonConfig: {
      version: 1,
      agents: { idleRuntimeCleanup: false, providers: { pi: { command, env: environment } } },
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}
