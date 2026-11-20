import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { HttpError } from "./http-error.ts";
import { configDirFromScript, samePath, setInstance } from "./instance.ts";

const HOME = os.homedir();
const tmp = mkdtempSync(path.join(os.tmpdir(), "ella-instance-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("wrapper scripts pinning a config folder", () => {
  it("reads sh wrappers", () => {
    assert.equal(configDirFromScript('#!/bin/sh\nCLAUDE_CONFIG_DIR="$HOME/.claude-work" exec claude "$@"\n'), path.normalize(`${HOME}/.claude-work`));
    assert.equal(configDirFromScript('#!/bin/bash\nexport CLAUDE_CONFIG_DIR=~/.claude2\nexec claude "$@"\n'), path.normalize(`${HOME}/.claude2`));
  });
  it("reads cmd and PowerShell wrappers", () => {
    assert.equal(configDirFromScript("@echo off\r\nset CLAUDE_CONFIG_DIR=%USERPROFILE%\\.claude-two\r\nclaude %*\r\n"), path.normalize(`${HOME}\\.claude-two`));
    assert.equal(configDirFromScript('$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\\.claude-alt"\nclaude @args\n'), path.normalize(`${HOME}\\.claude-alt`));
  });
  it("skips commented lines and relative or unexpanded values", () => {
    assert.equal(configDirFromScript("#!/bin/sh\n# CLAUDE_CONFIG_DIR=/nope\nexec claude\n"), null);
    assert.equal(configDirFromScript("@echo off\r\nREM set CLAUDE_CONFIG_DIR=C:\\nope\r\n"), null);
    assert.equal(configDirFromScript('CLAUDE_CONFIG_DIR="$(dirname "$0")/x" exec claude'), null);
    assert.equal(configDirFromScript("export CLAUDE_CONFIG_DIR=relative/dir"), null);
  });
  it("ignores scripts that don't set it", () => {
    assert.equal(configDirFromScript('powershell -File "D:\\start.ps1"'), null);
  });
});

describe("path comparison", () => {
  it("ignores trailing separators (and case on Windows)", () => {
    assert.equal(samePath(`${tmp}${path.sep}`, tmp), true);
    if (process.platform === "win32") assert.equal(samePath(tmp.toUpperCase(), tmp.toLowerCase()), true);
  });
});

describe("switching Claude is validated", () => {
  const rejects = async (input: Record<string, unknown>) =>
    assert.rejects(setInstance(input), (err: unknown) => err instanceof HttpError && err.status === 400);

  it("rejects network paths", () => rejects({ name: "Ella", bin: "\\\\evil\\share\\claude.exe", configDir: tmp }));
  it("rejects a bad assistant name", () => rejects({ name: "x".repeat(30), bin: process.execPath, configDir: tmp }));
  it("rejects a binary that was not detected as the Claude CLI", () => rejects({ name: "Ella", bin: process.execPath, configDir: tmp }));
  it("rejects a relative binary", () => rejects({ name: "Ella", bin: "claude", configDir: tmp }));
  it("rejects a look-alike file that was never detected", async () => {
    const fake = path.join(tmp, process.platform === "win32" ? "claude.exe" : "claude");
    writeFileSync(fake, "not a binary");
    await rejects({ name: "Ella", bin: fake, configDir: tmp });
  });
});
