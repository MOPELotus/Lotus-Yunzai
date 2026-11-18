import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "../packages/account/index.ts";

test("旧版多档案按自身账号、角色和设备构建请求上下文", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-account-"));
  const qq = "100001";
  try {
    const first = join(root, `${qq}.yaml`);
    const second = join(root, `${qq}-2.yaml`);
    await writeFile(first, `
version: 1
enabled: true
user: { qq: "100001" }
profile: { id: 1, name: 主档案 }
account:
  ltuid: "400001"
  cookie: fixture-cookie-one
  stoken: fixture-token-one
  game_roles:
    gs: [{ game_uid: "800001", region: cn_gf01 }, { uid: "800002", is_chosen: true }]
  current_uid: { gs: "800001" }
device: { id: fixture-device-one, fp: fixture-fp-one, bound: true }
`);
    await writeFile(second, `
user: { qq: 100001 }
profile: { id: 2, name: 副档案 }
account:
  ltuid: 400002
  cookie: fixture-cookie-two
  stoken_cookie: fixture-token-two
  current_uid: { gs: "800001" }
  game_roles: { gs: ["800004", { uid: "800003", is_chosen: true }] }
device:
  id: fixture-device-two
  fp: fixture-fp-two
  raw: { osVersion: 15 }
`);
    await writeFile(join(root, `${qq}-3.yaml`), "user: { qq: '100002' }\n");
    await writeFile(join(root, `${qq}-7.yaml`), "account: { cookie: example }\n");
    await writeFile(join(root, `${qq}-255.yaml`), "profile: { id: 255 }\n");
    await writeFile(join(root, `${qq}-300.yaml`), "{}");
    await symlink(first, join(root, `${qq}-4.yaml`));

    const profiles = createProfileStore(root);
    expect(await profiles.listIds(qq)).toEqual([1, 2, 3, 7, 255]);
    const summary = await profiles.summary(qq);
    expect(summary).toEqual({ id: 1, name: "主档案", enabled: true, loggedIn: true, deviceBound: true });
    expect(JSON.stringify(summary)).not.toContain("fixture-");
    const [main, alternate] = await Promise.all([
      profiles.requestContext(qq, 1, "gs"), profiles.requestContext(qq, 2, "gs"),
    ]);
    expect(main).toMatchObject({
      profileId: 1, role: { uid: "800001", region: "cn_gf01" },
      account: { ltuid: "400001", stoken: "fixture-token-one" },
      device: { id: "fixture-device-one", fp: "fixture-fp-one" },
    });
    expect(alternate).toMatchObject({
      profileId: 2, role: { uid: "800003" },
      account: { ltuid: "400002", stokenCookie: "fixture-token-two" },
      device: { id: "fixture-device-two", fp: "fixture-fp-two", androidVersion: "15" },
    });
    expect((await profiles.requestContext(qq, 2, "gs", "800004")).role.uid).toBe("800004");
    await expect(profiles.requestContext(qq, 2, "gs", "800001")).rejects.toMatchObject({ code: "role-missing" });
    await expect(profiles.requestContext(qq, 7, "sr")).rejects.toMatchObject({ code: "login-required" });
    await expect(profiles.summary(qq, 3)).rejects.toMatchObject({ code: "invalid" });
    await expect(profiles.summary(qq, 4)).rejects.toMatchObject({ code: "invalid" });
    await expect(profiles.summary(qq, 5)).rejects.toMatchObject({ code: "missing" });
    await expect(profiles.summary("../100001")).rejects.toMatchObject({ code: "invalid" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
