import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { frontmatter, maskArgs, maskJson, maskText, maskUrl } from "./config.ts";
import { parseSize } from "./docker.ts";
import { encodeProjectDir } from "./projects.ts";
import { mentionsFolder } from "./tasks.ts";

describe("secret masking", () => {
  it("masks values after secret-looking flags and token-like args", () => {
    assert.equal(maskArgs(["npx", "server", "--api-key", "abc123", "--port", "80"]), "npx server --api-key •••••• --port 80");
    assert.equal(maskArgs(["run", "--token=supersecret"]), "run --token=••••••");
    assert.equal(maskArgs(["x", "ghp_abcdefghijklmnopqrstuvwxyz0123"]), "x ••••••");
    assert.equal(maskArgs(["node", "D:\\mcp\\index.js", "--project-from-cwd"]), "node D:\\mcp\\index.js --project-from-cwd");
  });
  it("masks env, headers and secret-named keys in JSON, keeping structure", () => {
    const out = maskJson({ mcpServers: { a: { command: "x", env: { API_KEY: "s3cret" }, headers: { Authorization: "Bearer t" } } }, apiKeyHelper: "/bin/key", model: "opus" }) as { mcpServers: { a: { env: unknown; headers: unknown } }; apiKeyHelper: string; model: string };
    assert.deepEqual(out.mcpServers.a.env, { API_KEY: "••••••" });
    assert.deepEqual(out.mcpServers.a.headers, { Authorization: "••••••" });
    assert.equal(out.apiKeyHelper, "••••••");
    assert.equal(out.model, "opus");
  });
});

describe("front matter", () => {
  it("reads plain and folded values", () => {
    const fm = frontmatter("---\nname: seo\ndescription: >-\n  SSR-first SEO\n  engine\npaths:\n  - \"**/*.tsx\"\n---\n# body");
    assert.equal(fm.name, "seo");
    assert.equal(fm.description, "SSR-first SEO engine");
  });
  it("returns nothing without front matter", () => {
    assert.deepEqual(frontmatter("# just a heading"), {});
  });
});

describe("docker sizes", () => {
  it("parses docker's SI sizes", () => {
    assert.equal(parseSize("8.19kB (virtual 828MB)"), 8190);
    assert.equal(parseSize("1.5GB"), 1_500_000_000);
    assert.equal(parseSize("0B"), 0);
    assert.equal(parseSize("n/a"), 0);
  });
});

describe("project folder encoding", () => {
  it("matches Claude Code's session folder names", () => {
    assert.equal(encodeProjectDir("C:\\Users\\me\\.claude"), "C--Users-me--claude");
    assert.equal(encodeProjectDir("D:\\Projects\\shop.com\\dev"), "D--Projects-shop-com-dev");
    assert.equal(encodeProjectDir("/home/me/my app"), "-home-me-my-app");
  });
});

describe("masking hardening (review fixes)", () => {
  it("masks URL credentials and secret query params", () => {
    assert.equal(maskUrl("https://user:pw@host/mcp?access_token=abc&x=1"), "https://••••••@host/mcp?access_token=••••••&x=1");
    assert.equal(maskUrl("https://h/mcp?client_secret=s&page=2"), "https://h/mcp?client_secret=••••••&page=2");
  });
  it("masks bearer headers, KEY=value and JWTs, but keeps paths", () => {
    assert.equal(maskText("curl -H 'Authorization: Bearer abc.def'"), "curl -H 'Authorization: ••••••'");
    assert.equal(maskText("API_KEY=xyz node hook.js"), "API_KEY=•••••• node hook.js");
    assert.equal(maskArgs(["x", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"]), "x ••••••");
    assert.equal(maskArgs(["node", "/usr/local/lib/node_modules/some-long-package-name/dist/index.js"]), "node /usr/local/lib/node_modules/some-long-package-name/dist/index.js");
  });
  it("masks args arrays and non-string secret values inside JSON", () => {
    const out = maskJson({ mcpServers: { a: { args: ["--api-key", "sk-live-123"], url: "https://h?token=t" } }, password: 1234 }) as { mcpServers: { a: { args: string[]; url: string } }; password: unknown };
    assert.deepEqual(out.mcpServers.a.args, ["--api-key", "••••••"]);
    assert.equal(out.mcpServers.a.url, "https://h?token=••••••");
    assert.equal(out.password, "••••••");
  });
});

describe("process ↔ folder matching", () => {
  it("matches the folder and its children, not siblings, across slash styles", () => {
    assert.equal(mentionsFolder('node "D:\\Projects\\app\\server.js"', "D:\\Projects\\app"), true);
    assert.equal(mentionsFolder("node D:/Projects/app/server.js", "D:\\Projects\\app"), true);
    assert.equal(mentionsFolder("node D:\\Projects\\app-two\\server.js", "D:\\Projects\\app"), false);
    assert.equal(mentionsFolder("cmd /c cd /d D:\\Projects\\app", "D:\\Projects\\app\\"), true);
  });
});
