import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  builtinPlugins,
  resolveBuiltinPluginsRoot,
} from "../packages/server/dist/server/server/plugins/builtin/index.js";
import { compileDirectoryPlugin } from "../packages/server/dist/server/server/plugins/compiler-build.js";

const { version } = JSON.parse(await readFile("package.json", "utf8"));
const root = resolveBuiltinPluginsRoot();
for (const id of builtinPlugins) {
  const directory = path.join(root, id);
  const bundles = await compileDirectoryPlugin(directory, version, id);
  await writeFile(
    path.join(directory, "nix-bundles.json"),
    JSON.stringify({ version, ...bundles }),
  );
  console.log(`Precompiled built-in plugin: ${id}`);
}
