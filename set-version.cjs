const fs = require("fs");
const input = process.argv[2];

if (!input) { console.error("Usage: node set-version.cjs <version>  (e.g. 1.0.1 or 1.0.1.23)"); process.exit(1); }
if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(input)) {
    console.error("Version must be numeric X.Y.Z or X.Y.Z.BUILD");
    process.exit(1);
}

const parts = input.split(".");
const isFourPart = parts.length === 4;

// semver for package.json is always 3-part
const semver = isFourPart ? parts.slice(0, 3).join(".") : input;
// 4-part for manifest.json — use supplied build number or default to 0
const manifest = isFourPart ? input : input + ".0";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.version = semver;
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

const lockPath = "package-lock.json";
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  lock.version = semver;
  if (lock.packages?.[""]) lock.packages[""].version = semver;
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
}

const mf = JSON.parse(fs.readFileSync("com.slashpaf.audioforge.sdPlugin/manifest.json", "utf8"));
mf.Version = manifest;
fs.writeFileSync("com.slashpaf.audioforge.sdPlugin/manifest.json", JSON.stringify(mf, null, 2) + "\n");

console.log("package.json  → " + semver);
console.log("package-lock.json → " + semver);
console.log("manifest.json → " + manifest);
