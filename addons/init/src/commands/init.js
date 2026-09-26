"use strict";

const fs = require("fs");
const path = require("path");

const HELP_TEXT = `
sof run init - Scaffold a Sof-ready Roblox project

USAGE:
  sof run init [project-name] [options]

OPTIONS:
  --name <project-name>       Project name (overrides positional)
  --force                     Overwrite generated files if they exist
  --non-interactive           Do not prompt for missing values
  --install                   Run "sof run package install" after scaffold
  -h, --help                  Show this help message
`;

function parseArgs(argv) {
  const output = {
    projectName: null,
    force: false,
    nonInteractive: false,
    install: false,
    help: false,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      output.help = true;
      continue;
    }
    if (arg === "--force") {
      output.force = true;
      continue;
    }
    if (arg === "--non-interactive") {
      output.nonInteractive = true;
      continue;
    }
    if (arg === "--install") {
      output.install = true;
      continue;
    }
    if (arg === "--name") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--name requires a value.");
      }
      output.projectName = value.trim();
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new Error("init accepts at most one positional argument: [project-name].");
  }
  if (!output.projectName && positional.length === 1) {
    output.projectName = positional[0].trim();
  }

  return output;
}

function promptLine(question) {
  const buffer = Buffer.alloc(2048);
  process.stdout.write(question);
  const bytesRead = fs.readSync(0, buffer, 0, buffer.length, null);
  if (bytesRead <= 0) {
    return "";
  }
  return buffer.toString("utf8", 0, bytesRead).trim();
}

function promptYesNo(question) {
  const answer = promptLine(question).toLowerCase();
  return answer === "y" || answer === "yes";
}

function normalizeProjectName(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\s+/g, " ");
}

function writeFileSafely(filePath, content, force) {
  if (fs.existsSync(filePath) && !force) {
    throw new Error(`File already exists (use --force to overwrite): ${filePath}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function buildSofToml() {
  return [
    "[[auto-types]]",
    'name = "Controllers"',
    'include = ["src/ServerStorage/Controllers"]',
    'output = "src/ReplicatedStorage/Types/ControllerTypes.luau"',
    "recursive = true",
    "exclude_private = true",
    "",
    "[[auto-types]]",
    'name = "Services"',
    'include = ["src/ServerStorage/Services"]',
    'output = "src/ReplicatedStorage/Types/ServiceTypes.luau"',
    "recursive = true",
    "exclude_private = true",
    "",
  ].join("\n");
}

function buildDefaultProjectJson(projectName) {
  return `${JSON.stringify(
    {
      name: projectName,
      tree: {
        $className: "DataModel",
        ReplicatedFirst: {
          $path: "src/ReplicatedFirst",
        },
        ReplicatedStorage: {
          $path: "src/ReplicatedStorage",
        },
        ServerScriptService: {
          $path: "src/ServerScriptService",
        },
        ServerStorage: {
          $path: "src/ServerStorage",
        },
        StarterPlayer: {
          StarterPlayerScripts: {
            $path: "src/StarterPlayerScripts",
          },
        },
      },
    },
    null,
    2
  )}\n`;
}

function runInstallCommand() {
  const childProcess = require("child_process");
  try {
    childProcess.execFileSync(
      process.execPath,
      [path.join(__dirname, "..", "..", "bin", "sof.js"), "run", "package", "install"],
      {
        stdio: "inherit",
      }
    );
  } catch (err) {
    throw new Error(`Scaffold succeeded, but package install failed: ${err.message}`);
  }
}

function runInit(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  let projectName = normalizeProjectName(args.projectName);
  if (!projectName && !args.nonInteractive && process.stdin.isTTY) {
    projectName = normalizeProjectName(promptLine("Project name: "));
  }
  if (!projectName) {
    throw new Error("Project name is required. Pass it as an argument or --name.");
  }

  if (!args.force && !args.nonInteractive && process.stdin.isTTY) {
    const cwdEntries = fs.readdirSync(process.cwd());
    const hasPotentialCollisions = cwdEntries.some((entry) =>
      ["sof.toml", "default.project.json", "src"].includes(entry)
    );
    if (hasPotentialCollisions) {
      const proceed = promptYesNo(
        "Existing scaffold files were detected in this directory. Continue? [y/N]: "
      );
      if (!proceed) {
        throw new Error("Initialization cancelled.");
      }
    }
  }

  const directories = [
    "src/ReplicatedFirst",
    "src/ReplicatedStorage/Packages",
    "src/ReplicatedStorage/Shared",
    "src/ReplicatedStorage/Types",
    "src/ServerScriptService",
    "src/ServerStorage/Controllers",
    "src/ServerStorage/Services",
    "src/StarterPlayerScripts",
  ];

  for (const directory of directories) {
    fs.mkdirSync(path.resolve(directory), { recursive: true });
  }

  writeFileSafely(path.resolve("sof.toml"), buildSofToml(), args.force);
  writeFileSafely(path.resolve("default.project.json"), buildDefaultProjectJson(projectName), args.force);
  writeFileSafely(
    path.resolve("src/StarterPlayerScripts/Client.local.luau"),
    "--!strict\n\nreturn {}\n",
    args.force
  );
  writeFileSafely(
    path.resolve("src/ServerScriptService/Server.server.luau"),
    "--!strict\n\nreturn {}\n",
    args.force
  );

  console.log(`Initialized Sof scaffold for "${projectName}".`);
  console.log("Created:");
  console.log("  ✓ sof.toml");
  console.log("  ✓ default.project.json");
  console.log("  ✓ src/* baseline directories and starter scripts");

  if (args.install) {
    console.log("Running package install...");
    runInstallCommand();
  }
}

module.exports = {
  runInit,
};
