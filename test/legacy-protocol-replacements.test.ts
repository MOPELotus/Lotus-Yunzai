import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { matchApprovedProtocolReplacement, selectApprovedProtocolCandidates,
  type ApprovedProtocolReplacement } from "../lib/plugins/legacy-protocol-replacements.ts";

const manifest = JSON.stringify({ name: "fixture-adapter", repository: "https://code.example/old/fixture-adapter" });
const repository = "https://code.example/old/fixture-adapter";
const content = Buffer.from("throw new Error('must never be executed by migration');");
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const replacement: ApprovedProtocolReplacement = {
  id: "fixture-replacement",
  target: { packageName: "next-fixture", packageTreeSha256: "a".repeat(64) },
  legacy: {
    protocol: "fixture",
    packageName: "fixture-adapter",
    gitRemotes: [repository],
    manifestSha256: sha256(manifest),
    sourceFiles: { "index.js": sha256(content) },
  },
};
const identity = { packageName: replacement.legacy.packageName, manifest, gitRemotes: [repository] };

test("recognition requires exact reviewed bytes and repository identity", async () => {
  const paths: string[] = [];
  const readSource = async (path: string) => {
    paths.push(path);
    return content;
  };
  expect(await matchApprovedProtocolReplacement(identity, readSource)).toBeUndefined();
  expect(await matchApprovedProtocolReplacement({ ...identity, manifest: undefined }, readSource, [replacement])).toBeUndefined();
  expect(await matchApprovedProtocolReplacement({ ...identity,
    gitRemotes: ["https://other.example/old/fixture-adapter"],
  }, readSource, [replacement])).toBeUndefined();
  expect(await matchApprovedProtocolReplacement({ ...identity, manifest: manifest + "\n" },
    readSource, [replacement])).toBeUndefined();
  expect(paths).toEqual([]);
  expect(await matchApprovedProtocolReplacement(identity, async () => Buffer.from("modified"), [replacement])).toBeUndefined();
  expect(await matchApprovedProtocolReplacement(identity, readSource, [replacement])).toBe(replacement);
  expect(paths).toEqual(["index.js"]);
  expect(await matchApprovedProtocolReplacement(identity, readSource,
    [replacement, { ...replacement, id: "another" }])).toBeUndefined();
});

test("only unambiguous approved protocol candidates can advance to staging", () => {
  const candidate = {
    path: "plugins/renamed-example",
    status: "protocol-candidate",
    protocol: "fixture",
    replacement: replacement.id,
  } as const;
  const unverified = { ...candidate, path: "plugins/same-protocol", replacement: undefined };
  expect(selectApprovedProtocolCandidates({ plugins: [candidate] })).toEqual([]);
  expect(selectApprovedProtocolCandidates({ plugins: [unverified] }, [replacement])).toEqual([]);
  expect(selectApprovedProtocolCandidates({ plugins: [candidate, unverified] }, [replacement])).toEqual([]);
  expect(selectApprovedProtocolCandidates({ plugins: [candidate] }, [replacement])).toEqual([{ candidate, replacement }]);
});
