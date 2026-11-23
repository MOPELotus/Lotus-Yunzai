import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", ...args], {
    cwd: root, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

test("OneBot 和 Milky 主人检查实时上游，分支、索引和工作区保持原样", async () => {
  const upstream = await mkdtemp(join(tmpdir(), "lotus-update-check-upstream-"));
  let current = "", candidate = "";
  try {
    await withDualGatewayFixture("update-check-fixture", 'master: ["99:42", "100:43"]\ndisablePrivate: true\n',
      async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
        const gitHead = () => git(root, "rev-parse", "HEAD");
        const refs = () => git(root, "for-each-ref", "--format=%(refname) %(objectname)");
        const initialRefs = refs();
        const tracked = join(root, "version.txt");
        const gitIndex = join(root, ".git", "index");
        const initialIndex = await readFile(gitIndex);
        const fetchHead = Bun.file(join(root, ".git", "FETCH_HEAD"));
        expect(await fetchHead.exists()).toBe(false);

        sendOneBot("#检查更新", { user_id: 71, message_type: "group", group_id: 77 });
        const deniedOneBot = await onebot.next("send_msg");
        expect(deniedOneBot.params.message).toBe("暂无权限，只有主人才能操作");
        deniedOneBot.respond({ message_id: 71 });
        expect((await sendMilky("#检查更新", { message_scene: "group", sender_id: 72, peer_id: 77 })).status).toBe(200);
        const deniedMilky = await milky.next("send_group_message");
        expect(deniedMilky.params.message).toEqual([{ type: "text", data: { text: "暂无权限，只有主人才能操作" } }]);
        deniedMilky.respond({ message_seq: 72 });
        expect(refs()).toBe(initialRefs);
        expect(Bun.spawnSync(["git", "cat-file", "-t", candidate], { cwd: root, stderr: "ignore" }).exitCode).not.toBe(0);

        sendOneBot("#检查更新");
        const startingOneBot = await onebot.next("send_msg");
        expect(startingOneBot.params.message).toBe("正在检查上游更新。");
        startingOneBot.respond({ message_id: 1 });
        const resultOneBot = await onebot.next("send_msg");
        expect(resultOneBot.params.message).toBe([
          "Lotus-Yunzai 更新检查", "检测到上游有 1 个新提交。", "分支：main", "上游：origin/main",
          "领先 0 个提交 · 落后 1 个提交", `当前提交：${current}`, `上游提交：${candidate}`,
        ].join("\n"));
        resultOneBot.respond({ message_id: 2 });

        await writeFile(tracked, "dirty local content\n");
        expect((await sendMilky("#检查更新")).status).toBe(200);
        const startingMilky = await milky.next("send_private_message");
        expect(startingMilky.params.message).toEqual([{ type: "text", data: { text: "正在检查上游更新。" } }]);
        startingMilky.respond({ message_seq: 3 });
        const resultMilky = await milky.next("send_private_message");
        expect(resultMilky.params.message).toEqual([{
          type: "text", data: { text: `${resultOneBot.params.message}\n工作区有未提交的修改。` },
        }]);
        resultMilky.respond({ message_seq: 4 });
        expect(gitHead()).toBe(current);
        expect(git(root, "branch", "--show-current")).toBe("main");
        expect(refs()).toBe(initialRefs);
        expect(await fetchHead.exists()).toBe(false);
        expect(await readFile(gitIndex)).toEqual(initialIndex);
        expect(await readFile(tracked, "utf8")).toBe("dirty local content\n");
      }, 3_000, undefined, async root => {
        git(root, "init", "--quiet", "--initial-branch=main");
        await writeFile(join(root, "version.txt"), "local content\n");
        git(root, "add", "version.txt");
        git(root, "commit", "--quiet", "-m", "local");
        current = git(root, "rev-parse", "HEAD");
        git(upstream, "clone", "--quiet", "--no-local", root, ".");
        git(upstream, "commit", "--quiet", "--allow-empty", "-m", "upstream");
        candidate = git(upstream, "rev-parse", "HEAD");
        git(root, "remote", "add", "origin", upstream);
        git(root, "update-ref", "refs/remotes/origin/main", current);
        git(root, "branch", "--set-upstream-to=origin/main", "main");
      });
  } finally {
    await rm(upstream, { recursive: true, force: true });
  }
}, 12_000);
