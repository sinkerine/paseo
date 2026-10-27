import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runIconGetCommand, runIconSetCommand, runIconResetCommand } from "./icon.js";
import { runCreateCommand } from "./create.js";
import { runDeleteCommand } from "./delete.js";
import { runLsCommand } from "./ls.js";
import { runRenameCommand } from "./rename.js";

export function createProjectCommand(): Command {
  const project = new Command("project").description("Manage projects");

  addJsonAndDaemonHostOptions(
    project
      .command("create")
      .description("Register a project directory")
      .argument("[path]", "Project directory (default: current directory)"),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(project.command("ls").description("List projects")).action(
    withOutput(runLsCommand),
  );

  addJsonAndDaemonHostOptions(
    project
      .command("rename")
      .description("Set a project's user-visible name")
      .argument("<project-id>", "Project id")
      .argument("[name]", "New project name")
      .option("--reset", "Clear the custom name and use the directory name")
      .allowExcessArguments(false),
  ).action(withOutput(runRenameCommand));

  addJsonAndDaemonHostOptions(
    project
      .command("delete")
      .description("Delete a project and its workspaces")
      .argument("<project-id>", "Project id"),
  ).action(withOutput(runDeleteCommand));

  const icon = project.command("icon").description("Read, set, or reset a project's icon");
  addJsonAndDaemonHostOptions(
    icon.command("get <project-id>").description("Read the effective icon as base64 image data"),
  ).action(withOutput(runIconGetCommand));
  addJsonAndDaemonHostOptions(
    icon
      .command("set <project-id> <source>")
      .description("Set an icon from a local image file or website/image URL"),
  ).action(withOutput(runIconSetCommand));
  addJsonAndDaemonHostOptions(
    icon.command("reset <project-id>").description("Restore the automatic project icon"),
  ).action(withOutput(runIconResetCommand));

  return project;
}
