import { expect, test } from "bun:test";
import { createKeywords } from "../lib/keywords.ts";
import { delegationSession } from "../lib/command-delegation.ts";
import type { InboundSegment, MessageEvent, MessageReply, ReplyOptions } from "../lib/messages.ts";

type Store = Parameters<typeof createKeywords>[0];
type Scope = Parameters<Store["read"]>[0];
type Settings = ReturnType<Parameters<typeof createKeywords>[1]>;

function fixture(initialSettings: Partial<Settings> = {}, recentStore?: Parameters<typeof createKeywords>[3]) {
  const books = new Map<Scope, Map<string, readonly (readonly InboundSegment[])[]>>();
  const writes: { scope: Scope; word: string; parts: readonly InboundSegment[] }[] = [];
  const removals: [Scope, string, number | undefined][] = [];
  const settings: Settings = { addLimit: 0, addPrivate: true, addReply: true, addAt: false, addRecall: 60, ...initialSettings };
  let time = 0;
  const store: Store = {
    async read(scope) { return books.get(scope) ?? new Map(); },
    async append(scope, word, parts) {
      const book = books.get(scope) ?? new Map();
      const versions = [...(book.get(word) ?? []), parts];
      book.set(word, versions);
      books.set(scope, book);
      writes.push({ scope, word, parts });
      return versions.length;
    },
    async remove(scope, word, index) {
      removals.push([scope, word, index]);
      const book = books.get(scope);
      const versions = book?.get(word);
      if (!book || !versions || (index !== undefined && !versions[index - 1])) return false;
      if (index === undefined || versions.length === 1) return book.delete(word);
      book.set(word, versions.filter((_, i) => i !== index - 1));
      return true;
    },
    async render(parts) { return parts as MessageReply; },
  };
  const keywords = createKeywords(store, () => settings, () => time, recentStore);

  async function send(msg: string, fields: Partial<MessageEvent> = {}, continuing = false) {
    const replies: [MessageReply, boolean | undefined, ReplyOptions | undefined][] = [];
    const handled = await keywords[continuing ? "continue" : "dispatch"]({
      msg, raw_message: msg, message: msg, post_type: "message", message_type: "group",
      self_id: 99, user_id: 42, group_id: 77, isGroup: true, isPrivate: false,
      boundAccount: true, isMaster: false,
      reply(message, quote, options) { replies.push([message, quote, options]); return true; },
      ...fields,
    });
    return { handled, replies, text: replies[0]?.[0] };
  }
  const put = (scope: Scope, word: string, ...variants: string[]) => Promise.all(variants
    .map((text) => store.append(scope, word, [{ type: "text", text }])));
  return { send, put, writes, removals, books, settings, store, advance: (milliseconds: number) => { time += milliseconds; } };
}

const privateChat = { message_type: "private", isPrivate: true, isGroup: false, group_id: undefined } as const;

test("紧连添加命令收录多条消息，只保存可回放段并隔离机器人、用户与会话", async () => {
  const { send, writes } = fixture();
  expect((await send("#添加早安")).text).toContain("#结束添加");
  expect((await send("另一位", { user_id: 43 }, true)).handled).toBe(false);
  expect((await send("另一群", { group_id: 78 }, true)).handled).toBe(false);
  expect((await send("另一个机器人", { self_id: 100 }, true)).handled).toBe(false);
  expect((await send("同一人私聊", privateChat, true)).handled).toBe(false);
  expect((await send("第一段", {}, true)).replies).toEqual([]);
  expect((await send("第二段", {
    message: [
      { type: "at", qq: "99" }, { type: "text", text: "第二段" }, { type: "at", qq: 43 }, { type: "face", id: 0 },
      { type: "image", file: "gateway-cache", url: "https://example.invalid/photo.png" },
      { type: "record", file: "base64://QUJD" },
      { type: "image", file: "/private/qq.png" }, { type: "image", file: "77/image/old.png" },
      { type: "video", url: "https://private:credential@example.invalid/movie.mp4" },
      { type: "file", file: "https://example.invalid/file" },
    ],
  }, true)).replies).toEqual([]);
  expect((await send("#结束添加", {}, true)).text).toBe("添加成功：早安。有 4 个媒体下载失败或超过限额，请重新发送。");
  expect(writes).toEqual([{ scope: 77, word: "早安", parts: [
    { type: "text", text: "第一段" }, { type: "text", text: "第二段" },
    { type: "at", qq: 43 }, { type: "face", id: 0 },
    { type: "record", file: Buffer.from("ABC") },
  ] }]);
  expect((await send("#结束添加", {}, true)).handled).toBe(false);
});

test("群管理权限按级别校验，私聊通过目标群查询并在结束时复查", async () => {
  const { send, writes, settings } = fixture({ addLimit: 1 });
  const roleLookups: number[] = [];
  let role: "admin" | "member" = "admin";
  const privateMember = { ...privateChat, member: { is_admin: true, is_owner: true }, getGroupRole: async (group: number) => {
    roleLookups.push(group);
    return role;
  } };
  expect((await send("#添加私聊词条", privateMember)).text).toContain("先在群内");
  expect((await send("日常闲聊")).handled).toBe(false);
  expect((await send("#添加私聊词条", { ...privateMember, self_id: 100 })).text).toContain("先在群内");
  expect((await send("#添加词条")).text).toContain("群管理员");
  expect((await send("#添加词条", { ...privateMember, getGroupRole: undefined })).text).toContain("无法确认管理员权限");
  expect((await send("#添加词条", privateMember)).text).toContain("#结束添加");
  await send("私聊消息", privateMember, true);
  role = "member";
  expect((await send("#结束添加", privateMember, true)).text).toContain("群管理员");
  expect(roleLookups).toEqual([77, 77]);
  expect(writes).toEqual([]);

  Object.assign(settings, { addLimit: 0, addPrivate: false });
  expect((await send("#添加词条", privateChat)).text).toContain("禁止私聊");
  expect((await send("#全局添加 公告", privateChat)).text).toContain("只有主人");
  expect((await send("#全局添加 公告", { ...privateChat, isMaster: true, boundAccount: false })).text).toContain("已绑定");
  Object.assign(settings, { addLimit: 2 });
  expect((await send("#添加词条", { member: { is_admin: true, is_owner: true } })).text).toContain("只有主人");
  const master = { ...privateChat, isMaster: true };
  expect((await send("#全局添加 公告", master)).text).toContain("#结束添加");
  await send("主人消息", master, true);
  expect((await send("#结束添加", master, true)).text).toBe("添加成功：公告");
  expect(writes[0]?.scope).toBe("global");
});

test("群、全局词条按旧顺序编号，精确命中优先，编号删除只改指定范围", async () => {
  const { send, put, removals } = fixture({ addReply: false, addAt: true, addRecall: 15 });
  await put(77, "早安", "群内一", "群内二");
  await put("global", "早安", "全局一", "全局二");
  await put(77, "早安2", "精确词条");
  expect((await send("早安2")).text).toEqual([{ type: "text", text: "精确词条" }]);
  expect((await send("早安3")).replies).toEqual([
    [[{ type: "text", text: "全局一" }], false, { at: true, recallMsg: 15 }],
  ]);
  const drawn = (await send("早安")).text;
  const variants: (MessageReply | undefined)[] = ["群内一", "群内二", "全局一", "全局二"]
    .map((text) => [{ type: "text", text }]);
  expect(variants).toContainEqual(drawn);
  expect((await send("#删除早安2")).text).toBe("删除成功：早安2");
  expect((await send("#删除 早安2")).text).toBe("删除成功：早安(2)");
  expect(removals).toEqual([[77, "早安2", undefined], [77, "早安", 2]]);
  expect((await send("早安2", privateChat)).text).toEqual([{ type: "text", text: "全局一" }]);
  expect((await send("早安9")).handled).toBe(false);
});

test("分页及搜索在成功转发时静默，失败降级文本，未知结果不重发列表", async () => {
  const { send, books } = fixture();
  const entries = new Map<string, readonly (readonly InboundSegment[])[]>();
  for (let i = 1; i < 102; i++) entries.set(`词${i}`, [[{ type: "text", text: "内容" }]]);
  books.set(77, entries);
  books.set("global", entries);
  let forwarded: readonly MessageReply[] = [];
  const listing = await send("#消息列表", { forward: async (part) => { forwarded = part; return true; } });
  expect(listing.replies).toEqual([]);
  expect(forwarded[0]).toBe("消息列表：第1页，共101条");
  expect(forwarded[1]).toContain("101. 词101(1)");
  expect(forwarded[1]).not.toContain("1. 词1(1)");
  expect(forwarded[2]).toContain("#消息列表2");
  expect((await send("#词条 列表 2", { ...privateChat, forward: async () => false })).text).toBe(
    "消息列表：第2页，共101条\n1. 词1(1)",
  );
  expect((await send("#全局词条 词83", privateChat)).text).toContain("词83(1)");
  const unknown = await send("#词条列表", { forward: async () => { throw new Error("sample"); } });
  expect(unknown.text).toBe("词条列表转发结果未确认，请在聊天中核对。");
  expect((await send("#词条列表0")).text).toContain("大于 0");
});

test("旧全局表情别名与合并词条目录可读，本群覆盖同名，其他目录与词条回放保持原义", async () => {
  const { send, put, removals, writes } = fixture();
  await put("global", "同名", "全局甲", "全局乙");
  await put("global", "全局独有", "全局");
  await put(77, "同名", "群版本");
  await put(77, "本群独有", "群");
  await put(88, "别群独有", "其他群");
  const writesBefore = writes.length;
  expect((await send("#合并词条列表")).text).toBe("消息列表：第1页，共3条\n3. 本群独有(1)\n2. 全局独有(1)\n1. 同名(1)");
  expect((await send("#合并词条 同名")).text).toBe("消息同名：共1条\n1. 同名(1)");
  expect((await send("#合并词条 别群独有")).text).toBe("暂无消息。");
  expect((await send("#词条列表")).text).toBe("消息列表：第1页，共2条\n2. 本群独有(1)\n1. 同名(1)");
  expect((await send("#全局表情列表", privateChat)).text).toBe((await send("#全局词条列表", privateChat)).text);
  expect((await send("#全部表情列表")).handled).toBe(false);
  expect((await send("#表情列表")).handled).toBe(false);
  expect((await send("同名2")).text).toEqual([{ type: "text", text: "全局甲" }]);
  expect((await send("#合并词条列表", { ...privateChat, self_id: 100 })).text).toContain("所属群");
  expect((await send("#合并词条列表", { ...privateChat, getGroupRole: async () => undefined })).text).toContain("所属群");
  expect((await send("#合并词条列表", { ...privateChat, getGroupRole: async id => id === 77 ? "member" : undefined }))
    .text).toContain("本群独有(1)");
  expect(writes).toHaveLength(writesBefore);
  expect(removals).toEqual([]);
});

test("合并词条目录撤回会话时不发送，未知的转发结果不重发内容", async () => {
  const { put, send, store } = fixture();
  await put(77, "本群词条", "群");
  const overlay = new AbortController();
  const session = { signal: overlay.signal } as NonNullable<MessageEvent[typeof delegationSession]>;
  const read = store.read;
  store.read = async scope => {
    if (scope === "global") overlay.abort();
    return read(scope);
  };
  let forwards = 0;
  expect((await send("#合并词条列表", { [delegationSession]: session,
    forward: async () => { forwards++; return true; },
  })).replies).toEqual([]);
  expect(forwards).toBe(0);
  expect((await send("#合并词条列表", { forward: async () => { throw new Error("合并回执未知"); } })).text)
    .toBe("词条列表转发结果未确认，请在聊天中核对。");
});

test("合并列表在私聊遵从群词条开关，并在阅读后再次检查权限", async () => {
  let enabled = true;
  const { put, send, store } = fixture({}, {
    async read() { return; },
    async write() {},
    legacy: { async read() { return; }, allows: (_event, group) => enabled && group === 77 },
  });
  await put(77, "本群词条", "群");
  await send("群内消息");
  const chat = { ...privateChat, getGroupRole: async () => "member" as const };
  enabled = false;
  expect((await send("#合并词条列表", chat)).text).toContain("所属群");
  enabled = true;
  const read = store.read;
  store.read = async scope => { enabled = false; return read(scope); };
  expect((await send("#合并词条列表", chat)).replies).toEqual([]);
});

test("群名片预览查询途中撤销会话时，目录既不转发也不退发明文", async () => {
  const { put, send } = fixture();
  await put(77, "{at:12345}", "群");
  const controller = new AbortController();
  const started = Promise.withResolvers<void>(), result = Promise.withResolvers<string>();
  const session = { signal: controller.signal } as NonNullable<MessageEvent[typeof delegationSession]>;
  let forwarded = false;
  const pending = send("#合并词条列表", {
    [delegationSession]: session,
    async readKeywordGroupMemberName(group, id) {
      expect({ group, id }).toEqual({ group: 77, id: 12345 });
      started.resolve();
      return result.promise;
    },
    async forward() { forwarded = true; return false; },
  });
  await started.promise;
  controller.abort();
  result.resolve("已撤销");
  expect((await pending).replies).toEqual([]);
  expect(forwarded).toBe(false);
});

test("添加会话到期或没有合法内容时不写入", async () => {
  const { send, advance, writes } = fixture();
  await send("#添加 过期词条");
  await send("过期内容", {}, true);
  advance(120_000);
  expect((await send("#结束添加", {}, true)).text).toContain("已失效");
  await send("#添加 附件");
  await send("", { message: [{ type: "image", file: "file:///private.png" }] }, true);
  expect((await send("#结束添加", {}, true)).text).toContain("没有添加内容");
  expect(writes).toEqual([]);
});

test("最近群按机器人和用户读取，持久化失败时使用内存，同一会话的写入保持次序", async () => {
  const groups: [string, number][] = [];
  const firstStarted = Promise.withResolvers<void>();
  const firstDone = Promise.withResolvers<void>();
  const { send, put } = fixture({}, {
    async read(actor) { return actor === "99:42" ? 76 : undefined; },
    async write(actor, group) {
      groups.push([actor, group]);
      if (group === 77) {
        firstStarted.resolve();
        await firstDone.promise;
        throw new Error("存储不可用");
      }
    },
  });
  await put(76, "位置", "持久化位置");
  await put(77, "位置", "上一个群");
  await put(78, "位置", "最新位置");
  expect((await send("位置", privateChat)).text).toEqual([{ type: "text", text: "持久化位置" }]);
  expect((await send("位置", { ...privateChat, self_id: 100 })).handled).toBe(false);
  const first = send("日常消息");
  await firstStarted.promise;
  const second = send("日常消息", { group_id: 78 });
  expect((await send("位置", privateChat)).text).toEqual([{ type: "text", text: "最新位置" }]);
  expect(groups).toEqual([["99:42", 77]]);
  firstDone.resolve();
  await Promise.all([first, second]);
  expect(groups).toEqual([["99:42", 77], ["99:42", 78]]);
});

test("单个作用域的数据读取失败时仍能触发另一侧词条", async () => {
  const { send, put, store } = fixture();
  await put(77, "群词条", "群消息");
  await put("global", "全局词条", "全局消息");
  const read = store.read;
  let unavailable: Scope = 77;
  store.read = async (scope) => {
    if (scope === unavailable) throw new Error("样本读取失败");
    return read(scope);
  };
  expect((await send("全局词条")).text).toEqual([{ type: "text", text: "全局消息" }]);
  unavailable = "global";
  expect((await send("群词条")).text).toEqual([{ type: "text", text: "群消息" }]);
});
