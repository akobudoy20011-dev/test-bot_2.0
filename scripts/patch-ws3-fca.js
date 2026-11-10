"use strict";

const fs = require("fs");
const path = require("path");

function patchThreadListSource(source) {
  const needle = ".big_image_src.uri";
  const count = source.split(needle).length - 1;
  if (count === 0) {
    if (source.includes(".big_image_src?.uri")) return { source, count: 0, alreadyPatched: true };
    throw new Error("ws3-fca getThreadList formatter changed; refusing to apply an unverified patch.");
  }
  return {
    source: source.split(needle).join(".big_image_src?.uri || null"),
    count,
    alreadyPatched: false
  };
}

function run() {
  const root = path.resolve(__dirname, "..");
  const packagePath = path.join(root, "node_modules", "ws3-fca", "package.json");
  const sourcePath = path.join(root, "node_modules", "ws3-fca", "src", "getThreadList.js");
  if (!fs.existsSync(packagePath) || !fs.existsSync(sourcePath)) {
    console.warn("[ws3-fca patch] Package source not found; skipping compatibility patch.");
    return;
  }
  const installed = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  if (installed.version !== "2.0.1") {
    console.warn("[ws3-fca patch] Expected ws3-fca 2.0.1; found " + installed.version + ". Skipping guarded patch.");
    return;
  }
  const original = fs.readFileSync(sourcePath, "utf8");
  const result = patchThreadListSource(original);
  if (result.alreadyPatched) {
    console.log("[ws3-fca patch] getThreadList image URL guard already present.");
    return;
  }
  fs.writeFileSync(sourcePath, result.source, "utf8");
  console.log("[ws3-fca patch] Guarded " + result.count + " optional participant image URL access(es).");
}

if (require.main === module) run();
module.exports = { patchThreadListSource };
