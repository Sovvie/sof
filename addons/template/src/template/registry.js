"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_PROJECT_FILE_NAME = "default.project.json";
const REGISTRY_DIRECTORY = path.join(os.homedir(), ".sof");
const REGISTRY_PATH = path.join(REGISTRY_DIRECTORY, "templates.json");

function createEmptyRegistry() {
  return {
    templates: {},
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripUtf8Bom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function assertTemplateName(name) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("Template name must be a non-empty string.");
  }
}

function assertProjectName(projectName) {
  if (typeof projectName !== "string" || projectName.trim() === "") {
    throw new Error("Project name must be a non-empty string.");
  }
}

function ensureDirectory(directoryPath, label) {
  if (!fs.existsSync(directoryPath)) {
    throw new Error(`${label} does not exist: ${directoryPath}`);
  }

  const stat = fs.statSync(directoryPath);
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${directoryPath}`);
  }
}

function ensureProjectConfigExists(directoryPath) {
  const projectFilePath = path.join(directoryPath, DEFAULT_PROJECT_FILE_NAME);
  if (!fs.existsSync(projectFilePath)) {
    throw new Error(
      `Missing ${DEFAULT_PROJECT_FILE_NAME} in template directory: ${directoryPath}`
    );
  }

  const stat = fs.statSync(projectFilePath);
  if (!stat.isFile()) {
    throw new Error(
      `Expected ${DEFAULT_PROJECT_FILE_NAME} to be a file: ${projectFilePath}`
    );
  }

  return projectFilePath;
}

function isPathInside(parentPath, targetPath) {
  const relative = path.relative(parentPath, targetPath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function shouldExcludePath(sourceRootPath, sourceEntryPath) {
  const relativePath = path.relative(sourceRootPath, sourceEntryPath);
  if (!relativePath) {
    return false;
  }

  const normalized = relativePath.split(path.sep).join("/");
  if (normalized === "sourcemap.json") {
    return true;
  }

  const pathParts = normalized.split("/");
  return pathParts.includes(".git") || pathParts.includes("node_modules");
}

function createCopyFilter(sourceRootPath) {
  return (sourceEntryPath) => !shouldExcludePath(sourceRootPath, sourceEntryPath);
}

function countCopyableFiles(sourceRootPath, sourceEntryPath) {
  if (shouldExcludePath(sourceRootPath, sourceEntryPath)) {
    return 0;
  }

  const stat = fs.statSync(sourceEntryPath);
  if (stat.isDirectory()) {
    let total = 0;
    const entries = fs.readdirSync(sourceEntryPath);
    for (const entryName of entries) {
      const entryPath = path.join(sourceEntryPath, entryName);
      total += countCopyableFiles(sourceRootPath, entryPath);
    }
    return total;
  }

  return 1;
}

function copyTemplateContents(sourcePath, destinationPath) {
  const copyFilter = createCopyFilter(sourcePath);
  const sourceEntries = fs.readdirSync(sourcePath);

  let copiedFileCount = 0;
  for (const entryName of sourceEntries) {
    const sourceEntryPath = path.join(sourcePath, entryName);
    const destinationEntryPath = path.join(destinationPath, entryName);
    if (!copyFilter(sourceEntryPath, destinationEntryPath)) {
      continue;
    }

    copiedFileCount += countCopyableFiles(sourcePath, sourceEntryPath);
    fs.cpSync(sourceEntryPath, destinationEntryPath, {
      recursive: true,
      filter: copyFilter,
    });
  }

  return copiedFileCount;
}

function updateProjectName(destinationPath, projectName) {
  const projectFilePath = ensureProjectConfigExists(destinationPath);

  let projectJson;
  try {
    const projectJsonText = stripUtf8Bom(fs.readFileSync(projectFilePath, "utf8"));
    projectJson = JSON.parse(projectJsonText);
  } catch (err) {
    throw new Error(`Failed to parse ${DEFAULT_PROJECT_FILE_NAME}: ${err.message}`);
  }

  if (!isPlainObject(projectJson)) {
    throw new Error(`${DEFAULT_PROJECT_FILE_NAME} must contain a JSON object.`);
  }

  projectJson.name = projectName;
  fs.writeFileSync(projectFilePath, `${JSON.stringify(projectJson, null, 2)}\n`, "utf8");

  return projectFilePath;
}

function initializeGitRepository(destinationPath) {
  try {
    childProcess.execSync("git init", {
      cwd: destinationPath,
      stdio: "ignore",
    });
  } catch (err) {
    throw new Error(`Failed to initialize git repository: ${err.message}`);
  }
}

function readRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    return createEmptyRegistry();
  }

  const fileText = stripUtf8Bom(fs.readFileSync(REGISTRY_PATH, "utf8")).trim();
  if (!fileText) {
    return createEmptyRegistry();
  }

  let parsed;
  try {
    parsed = JSON.parse(fileText);
  } catch (err) {
    throw new Error(`Template registry JSON is invalid (${REGISTRY_PATH}): ${err.message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`Template registry must be a JSON object: ${REGISTRY_PATH}`);
  }

  if (parsed.templates === undefined) {
    return createEmptyRegistry();
  }

  if (!isPlainObject(parsed.templates)) {
    throw new Error(`Template registry "templates" must be an object: ${REGISTRY_PATH}`);
  }

  return {
    templates: parsed.templates,
  };
}

function writeRegistry(data) {
  if (!isPlainObject(data) || !isPlainObject(data.templates)) {
    throw new Error("Registry data must be an object with a templates object.");
  }

  fs.mkdirSync(REGISTRY_DIRECTORY, { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function saveTemplate(name, sourcePathArgument) {
  assertTemplateName(name);

  const sourcePath = path.resolve(sourcePathArgument || process.cwd());
  ensureDirectory(sourcePath, "Template source path");
  ensureProjectConfigExists(sourcePath);

  const registry = readRegistry();
  const overwritten = Boolean(registry.templates[name]);

  registry.templates[name] = {
    path: sourcePath,
    savedAt: new Date().toISOString(),
  };

  writeRegistry(registry);

  return {
    name,
    sourcePath,
    overwritten,
    registryPath: REGISTRY_PATH,
  };
}

function useTemplate(name, projectName, options = {}) {
  assertTemplateName(name);
  assertProjectName(projectName);

  const destinationPath = path.resolve(options.destinationPath || process.cwd());
  ensureDirectory(destinationPath, "Destination path");

  const registry = readRegistry();
  const templateEntry = registry.templates[name];
  if (!isPlainObject(templateEntry) || typeof templateEntry.path !== "string") {
    throw new Error(`Template "${name}" is not registered.`);
  }

  const sourcePath = path.resolve(templateEntry.path);
  ensureDirectory(sourcePath, `Template source for "${name}"`);
  ensureProjectConfigExists(sourcePath);

  if (sourcePath === destinationPath) {
    throw new Error("Template source and destination cannot be the same directory.");
  }

  if (isPathInside(sourcePath, destinationPath)) {
    throw new Error("Destination cannot be inside the template source directory.");
  }

  const destinationEntries = fs.readdirSync(destinationPath);
  if (destinationEntries.includes(".git")) {
    throw new Error(
      "Destination already contains a .git directory. Use an empty directory for a fresh repository."
    );
  }

  const force = options.force === true;
  if (destinationEntries.length > 0 && !force) {
    if (typeof options.confirmOverwrite !== "function") {
      throw new Error("Destination directory is not empty. Re-run with --force to continue.");
    }

    const shouldContinue = options.confirmOverwrite({
      destinationPath,
      entries: destinationEntries.slice(),
    });

    if (!shouldContinue) {
      throw new Error("Template usage cancelled.");
    }
  }

  const copiedFileCount = copyTemplateContents(sourcePath, destinationPath);
  const projectFilePath = updateProjectName(destinationPath, projectName.trim());
  initializeGitRepository(destinationPath);

  return {
    name,
    sourcePath,
    destinationPath,
    projectFilePath,
    copiedFileCount,
  };
}

function listTemplates() {
  const registry = readRegistry();

  return Object.entries(registry.templates)
    .map(([name, entry]) => {
      const templatePath =
        isPlainObject(entry) && typeof entry.path === "string" ? entry.path : "";
      const savedAt =
        isPlainObject(entry) && typeof entry.savedAt === "string" ? entry.savedAt : null;

      return {
        name,
        path: templatePath,
        savedAt,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function removeTemplate(name) {
  assertTemplateName(name);

  const registry = readRegistry();
  if (!Object.prototype.hasOwnProperty.call(registry.templates, name)) {
    throw new Error(`Template "${name}" is not registered.`);
  }

  const removed = registry.templates[name];
  delete registry.templates[name];
  writeRegistry(registry);

  return {
    name,
    removedPath:
      isPlainObject(removed) && typeof removed.path === "string" ? removed.path : null,
    registryPath: REGISTRY_PATH,
  };
}

module.exports = {
  REGISTRY_PATH,
  listTemplates,
  readRegistry,
  removeTemplate,
  saveTemplate,
  useTemplate,
  writeRegistry,
};
