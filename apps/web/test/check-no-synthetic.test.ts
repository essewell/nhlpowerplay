import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanForSynthetic } from "../scripts/check-no-synthetic.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/check-no-synthetic.ts", import.meta.url));

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pp-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

test("clean directory passes (CLI exit 0)", (t) => {
  const dir = tempDir(t);
  write(path.join(dir, "data", "base_rates.json"), '[{"scope":"all"}]');
  write(path.join(dir, "data", "manifest.json"), '{"synthetic_count":0,"synthetic":false}');
  write(path.join(dir, "robots.txt"), "User-agent: *");
  const r = runCli([dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK \(3 file\(s\) scanned\)/);
});

test("*.synthetic.json is flagged by name even if the content is clean", (t) => {
  const dir = tempDir(t);
  write(path.join(dir, "scenario.synthetic.json"), "{}");
  const report = scanForSynthetic([dir]);
  assert.deepEqual(report.offenders.map((o) => [path.basename(o.file), o.reason]),
    [["scenario.synthetic.json", "synthetic filename"]]);
  const r = runCli([dir]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /scenario\.synthetic\.json \(synthetic filename\)/);
});

test("filename check is case-insensitive", (t) => {
  const dir = tempDir(t);
  write(path.join(dir, "Rates.SYNTHETIC.JSON"), "[]");
  assert.equal(scanForSynthetic([dir]).offenders.length, 1);
});

test("embedded marker is flagged in both spacing forms and in bundled JS", (t) => {
  const dir = tempDir(t);
  write(path.join(dir, "a.json"), '{"synthetic":true,"x":1}');
  write(path.join(dir, "b.json"), '{\n  "synthetic": true\n}');
  write(path.join(dir, "chunk.js"), 'var d=JSON.parse(\'{"id":"x","synthetic" :true}\');');
  const names = scanForSynthetic([dir]).offenders.map((o) => `${path.basename(o.file)}:${o.reason}`);
  assert.deepEqual(names, ["a.json:synthetic marker", "b.json:synthetic marker", "chunk.js:synthetic marker"]);
});

test("look-alikes are not flagged: false value, other keys, prefix words", (t) => {
  const dir = tempDir(t);
  write(path.join(dir, "a.json"), '{"synthetic":false}');
  write(path.join(dir, "b.json"), '{"is_synthetic":true}');
  write(path.join(dir, "c.json"), '{"synthetic":"true"}');
  write(path.join(dir, "d.json"), '{"synthetic":trueish}');
  write(path.join(dir, "synthetic.json"), "{}");
  assert.deepEqual(scanForSynthetic([dir]).offenders, []);
});

test("nested directories are scanned", (t) => {
  const dir = tempDir(t);
  write(path.join(dir, "a", "b", "c", "d", "deep.json"), '{"synthetic": true}');
  write(path.join(dir, "a", "x", "y.synthetic.json"), "{}");
  const report = scanForSynthetic([dir]);
  assert.equal(report.offenders.length, 2);
  assert.equal(report.scannedFiles, 2);
});

test("multiple roots: offenders reported from each", (t) => {
  const a = tempDir(t);
  const b = tempDir(t);
  write(path.join(a, "one.synthetic.json"), "{}");
  write(path.join(b, "two.json"), '{"synthetic":true}');
  const r = runCli([a, b]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /2 synthetic file\(s\)/);
});

test("missing directory is reported clearly and skipped (exit 0)", (t) => {
  const dir = tempDir(t);
  const gone = path.join(dir, "does-not-exist");
  const r = runCli([gone]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /does-not-exist does not exist, skipped/);
  assert.deepEqual(scanForSynthetic([gone]).missing, [gone]);
});

test("missing dir does not hide offenders in another dir", (t) => {
  const dir = tempDir(t);
  write(path.join(dir, "x.synthetic.json"), "{}");
  const r = runCli([path.join(dir, "nope"), dir]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /nope does not exist, skipped/);
});

test("binary files are not read; build caches are skipped", (t) => {
  const dir = tempDir(t);
  write(path.join(dir, "img.png"), '"synthetic":true');
  write(path.join(dir, "cache", "webpack", "pack.json"), '{"synthetic":true}');
  assert.deepEqual(scanForSynthetic([dir]).offenders, []);
});

test("a single file path can be scanned directly", (t) => {
  const dir = tempDir(t);
  const f = path.join(dir, "one.json");
  write(f, '{"synthetic": true}');
  assert.equal(scanForSynthetic([f]).offenders.length, 1);
});

test("empty directory passes", (t) => {
  const dir = tempDir(t);
  const report = scanForSynthetic([dir]);
  assert.deepEqual(report, { offenders: [], missing: [], scannedFiles: 0 });
});
