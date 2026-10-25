import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repositoryRoot = process.cwd();
const pluginRoot = path.resolve(repositoryRoot, "com.slashpaf.audioforge.sdPlugin");
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const manifestPath = path.join(pluginRoot, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

function fail(message) {
  console.error(`Manifest validation failed: ${message}`);
  process.exit(1);
}

if (manifest.UUID !== "com.slashpaf.audioforge") {
  fail(`unexpected plugin UUID: ${manifest.UUID}`);
}

if (!/^\d+\.\d+\.\d+$/.test(packageJson.version)) {
  fail(`package version must be numeric SemVer X.Y.Z: ${packageJson.version}`);
}
if (!new RegExp(`^${packageJson.version.replaceAll(".", "\\.")}\\.\\d+$`).test(manifest.Version)) {
  fail(`manifest version ${manifest.Version} must be package version ${packageJson.version} plus a numeric build number`);
}

const lockfile = JSON.parse(await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"));
if (lockfile.version !== packageJson.version || lockfile.packages?.[""]?.version !== packageJson.version) {
  fail(`package-lock.json version metadata must match package version ${packageJson.version}`);
}

if (manifest.Nodejs?.Debug === "enabled") {
  fail("Nodejs.Debug must not be enabled in a distributable manifest");
}

async function requireFile(relativePath, context) {
  const fullPath = path.resolve(pluginRoot, relativePath);
  if (!fullPath.startsWith(`${pluginRoot}${path.sep}`)) {
    fail(`${context} points outside the plugin folder: ${relativePath}`);
  }
  try {
    if ((await stat(fullPath)).isFile()) return;
  } catch {}
  fail(`${context} does not exist: ${relativePath}`);
}

async function requireImage(basePath, context) {
  const fullBasePath = path.resolve(pluginRoot, basePath);
  if (!fullBasePath.startsWith(`${pluginRoot}${path.sep}`)) {
    fail(`${context} points outside the plugin folder: ${basePath}`);
  }
  for (const suffix of [".png", ".jpg", ".jpeg", ".svg"]) {
    try {
      if ((await stat(`${fullBasePath}${suffix}`)).isFile()) return;
    } catch {}
  }
  fail(`${context} has no matching image file: ${basePath}`);
}

await requireFile(manifest.CodePath, "CodePath");
await requireImage(manifest.Icon, "Icon");
await requireImage(manifest.CategoryIcon, "CategoryIcon");

for (const [index, action] of manifest.Actions.entries()) {
  await requireImage(action.Icon, `Actions[${index}].Icon`);
  if (action.PropertyInspectorPath) {
    await requireFile(action.PropertyInspectorPath, `Actions[${index}].PropertyInspectorPath`);
  }
  for (const [stateIndex, state] of (action.States ?? []).entries()) {
    await requireImage(state.Image, `Actions[${index}].States[${stateIndex}].Image`);
  }
}

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(fullPath);
    else yield fullPath;
  }
}

for await (const htmlPath of walk(path.join(pluginRoot, "ui"))) {
  if (!htmlPath.endsWith(".html")) continue;
  const html = await readFile(htmlPath, "utf8");
  const scriptSources = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)];
  for (const [, source] of scriptSources) {
    if (/^https?:\/\//i.test(source)) {
      fail(`property inspector loads a remote script: ${path.relative(pluginRoot, htmlPath)} → ${source}`);
    }
    if (!source.startsWith("data:")) {
      const localPath = path.resolve(path.dirname(htmlPath), source);
      try {
        if (!(await stat(localPath)).isFile()) throw new Error("missing");
      } catch {
        fail(`property inspector script is missing: ${path.relative(pluginRoot, htmlPath)} → ${source}`);
      }
    }
  }
}

console.log(`Manifest and local assets valid for ${manifest.UUID} ${manifest.Version}.`);
