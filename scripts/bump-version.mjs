import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// The version lives in exactly one authority — package.json — because this
// package has no second manifest to keep in step (no Cargo.toml, no Tauri
// config). The release workflow re-reads it from the tag and refuses to build
// when the two disagree, so a forgotten bump fails before anything is
// published rather than after.

export const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

export function normalizeVersion(input) {
  if (!input) {
    return "";
  }

  return input.replace(/^v/, "");
}

/**
 * Write the given version into package.json.
 * @param {string} rawVersion - version with or without a leading `v`.
 * @returns {string} the normalized version that was written.
 * @throws {Error} when the version is missing or not semver-shaped.
 */
export function setVersion(rawVersion) {
  const nextVersion = normalizeVersion(rawVersion);

  if (!nextVersion) {
    throw new Error("A version argument is required.");
  }

  if (!semverPattern.test(nextVersion)) {
    throw new Error(
      `Invalid version: ${nextVersion}. Expected a semver value like 0.1.1 or 1.0.0-beta.1`,
    );
  }

  const packageJsonPath = path.join(process.cwd(), "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  packageJson.version = nextVersion;
  fs.writeFileSync(
    packageJsonPath,
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );

  return nextVersion;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (!normalizeVersion(process.argv[2])) {
    console.error("Usage: pnpm version:set <version>");
    process.exit(1);
  }

  try {
    const version = setVersion(process.argv[2]);
    console.log(`Updated project version to ${version}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
