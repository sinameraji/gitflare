import { describe, it, expect } from "vitest";
import {
  planRemoteAdd,
  planRemoteRemove,
  regexLiteral,
  parseCredentialInput,
  formatCredentialOutput,
  stripTokenExpiry,
  requestMatchesRemote,
  credentialSection,
} from "../src/git-config.js";

const ORIGIN = "https://github.com/o/r.git";
const MIRROR = "https://acct.artifacts.cloudflare.net/git/gitflare/o--r.git";
const HELPER = '!"/usr/local/bin/node" "/x/dist/index.js" credential --repo o--r';

describe("planRemoteAdd", () => {
  it("with no pushurl yet: adds GitHub FIRST, then the mirror, then the helper", () => {
    const { ops, alreadyConfigured } = planRemoteAdd({ originUrl: ORIGIN, artifactsRemote: MIRROR, existingPushUrls: [], helperCommand: HELPER });
    expect(alreadyConfigured).toBe(false);
    expect(ops[0]).toEqual(["config", "--add", "remote.origin.pushurl", ORIGIN]);
    expect(ops[1]).toEqual(["config", "--add", "remote.origin.pushurl", MIRROR]);
    expect(ops[2]).toEqual(["config", `${credentialSection(MIRROR)}.helper`, HELPER]);
    expect(ops[3]).toEqual(["config", `${credentialSection(MIRROR)}.useHttpPath`, "true"]);
    expect(ops[4]).toEqual(["config", `${credentialSection(MIRROR)}.username`, "x"]);
  });
  it("with an existing pushurl: only appends the mirror", () => {
    const { ops } = planRemoteAdd({ originUrl: ORIGIN, artifactsRemote: MIRROR, existingPushUrls: [ORIGIN], helperCommand: HELPER });
    expect(ops.filter((o) => o[1] === "--add")).toEqual([["config", "--add", "remote.origin.pushurl", MIRROR]]);
  });
  it("is idempotent: mirror already present → no pushurl ops, helper refreshed", () => {
    const { ops, alreadyConfigured } = planRemoteAdd({ originUrl: ORIGIN, artifactsRemote: MIRROR, existingPushUrls: [ORIGIN, MIRROR], helperCommand: HELPER });
    expect(alreadyConfigured).toBe(true);
    expect(ops.some((o) => o[1] === "--add")).toBe(false);
    expect(ops.some((o) => o[1]?.endsWith(".helper"))).toBe(true);
  });
});

describe("planRemoteRemove", () => {
  it("removes the mirror and, when only our GitHub pushurl remains, that too; drops the credential section", () => {
    const { ops } = planRemoteRemove({ originUrl: ORIGIN, artifactsRemote: MIRROR, existingPushUrls: [ORIGIN, MIRROR] });
    expect(ops[0]).toEqual(["config", "--unset-all", "remote.origin.pushurl", regexLiteral(MIRROR)]);
    expect(ops[1]).toEqual(["config", "--unset-all", "remote.origin.pushurl", regexLiteral(ORIGIN)]);
    expect(ops[2]).toEqual(["config", "--remove-section", credentialSection(MIRROR)]);
  });
  it("leaves a user's own extra pushurls alone", () => {
    const { ops } = planRemoteRemove({ originUrl: ORIGIN, artifactsRemote: MIRROR, existingPushUrls: [ORIGIN, "https://other/x.git", MIRROR] });
    expect(ops.filter((o) => o[1] === "--unset-all")).toHaveLength(1);
  });
  it("nothing to remove → still clears the credential section", () => {
    const { ops, alreadyConfigured } = planRemoteRemove({ originUrl: ORIGIN, artifactsRemote: MIRROR, existingPushUrls: [] });
    expect(alreadyConfigured).toBe(false);
    expect(ops).toEqual([["config", "--remove-section", credentialSection(MIRROR)]]);
  });
});

describe("regexLiteral", () => {
  it("anchors and escapes URL metacharacters", () => {
    expect(regexLiteral("https://a.b/c.git")).toBe("^https:\\/\\/a\\.b\\/c\\.git$");
  });
});

describe("credential helper protocol", () => {
  it("parses key=value lines up to the blank line", () => {
    expect(parseCredentialInput("protocol=https\nhost=acct.artifacts.cloudflare.net\npath=git/gitflare/o--r.git\n\nignored=1\n")).toEqual({
      protocol: "https",
      host: "acct.artifacts.cloudflare.net",
      path: "git/gitflare/o--r.git",
    });
  });
  it("formats username/password lines", () => {
    expect(formatCredentialOutput("x", "art_v2_abc")).toBe("username=x\npassword=art_v2_abc\n");
  });
  it("strips the ?expires= suffix Artifacts appends", () => {
    expect(stripTokenExpiry("art_v2_abc?expires=1700000000")).toBe("art_v2_abc");
    expect(stripTokenExpiry("art_v2_abc")).toBe("art_v2_abc");
  });
  it("only answers for the mirror it was installed for", () => {
    expect(requestMatchesRemote({ protocol: "https", host: "acct.artifacts.cloudflare.net", path: "git/gitflare/o--r.git" }, MIRROR)).toBe(true);
    expect(requestMatchesRemote({ protocol: "https", host: "acct.artifacts.cloudflare.net", path: "git/gitflare/o--r" }, MIRROR)).toBe(true);
    expect(requestMatchesRemote({ protocol: "https", host: "github.com", path: "o/r.git" }, MIRROR)).toBe(false);
    expect(requestMatchesRemote({ protocol: "https", host: "acct.artifacts.cloudflare.net", path: "git/gitflare/other.git" }, MIRROR)).toBe(false);
    expect(requestMatchesRemote({ protocol: "https", host: "acct.artifacts.cloudflare.net" }, MIRROR)).toBe(true);
  });
});
