// Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { type Task } from "./server.ts";

const owner = { threadId: "thr_owner", projectId: "proj_a" };
const helper = { threadId: "thr_helper", projectId: "proj_a" };

const threads = [
  makeThreadResponse({ id: "thr_owner", projectId: "proj_a", title: "Lead", status: "active", environmentId: "env_a" }),
  makeThreadResponse({ id: "thr_helper", projectId: "proj_a", title: "UI helper", status: "active", parentThreadId: "thr_owner", environmentId: "env_a" }),
  makeThreadResponse({ id: "thr_other", projectId: "proj_a", title: "Loose", status: "active" }),
];

const sent: { threadId: string; text: string }[] = [];

async function setup(seed?: (kv: Map<string, unknown>) => void) {
  const kvSeed = new Map<string, unknown>();
  seed?.(kvSeed);
  const { bb, harness } = createFakePluginHost({
    pluginId: "brief",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => threads.find((t) => t.id === threadId)!,
        list: async () => threads,
        send: async ({ threadId, input }: { threadId: string; input: { text: string }[] }) => {
          sent.push({ threadId, text: input[0]!.text });
          return {};
        },
      },
      environments: { get: async () => ({ id: "env_a", hostId: "host_a", path: "/work" }) },
      files: { read: async ({ path }: { path: string }) => ({ content: `# ${path}`, contentEncoding: "utf8" }) },
      projects: { list: async () => [{ id: "proj_a", name: "Project A" }] },
    } as never,
  });
  for (const [key, value] of kvSeed) await bb.storage.kv.set(key, value);
  await plugin(bb);
  return harness.behavior;
}

const text = (result: unknown) =>
  typeof result === "string" ? result : (result as { content: { text: string }[] }).content[0]!.text;

test("owner plans, helper joins, claims and sub-plans, task finishes", async () => {
  const b = await setup();
  const started = await b.callAgentTool(
    "brief_plan",
    { title: "Ship v2", goal: "Tasks on the board", items: [{ text: "Server" }, { text: "UI", children: [{ text: "Board" }] }] },
    owner,
  );
  assert.match(text(started), /Started task "Ship v2"/);

  // The helper was spawned by the owner, so its first tool call joins it.
  const unclaimed = (await b.callAgentTool("brief_plan", { items: [{ text: "x" }] }, helper)) as { isError: boolean };
  assert.equal(unclaimed.isError, true);
  await b.callAgentTool("brief_claim", { item: "2.1" }, helper);
  const sub = await b.callAgentTool("brief_plan", { items: [{ text: "Cards" }, { text: "Lanes" }] }, helper);
  assert.match(text(sub), /2\.1\.2 \[ \] Lanes/);
  await b.callAgentTool("brief_status", { now: "Building lanes", needs_you: "Pick a color" }, helper);
  await b.callAgentTool("brief_doc", { path: "ui.md", title: "UI notes", kind: "design" }, helper);
  await b.callAgentTool("brief_doc", { path: "ui.md", title: "UI notes", kind: "design" }, helper);

  let board = (await b.callRpc("board", null)) as { tasks: Task[]; untracked: { threadId: string }[] };
  assert.equal(board.tasks.length, 1);
  const task = board.tasks[0]!;
  assert.equal(task.threads.length, 2);
  assert.equal(task.threads.find((t) => t.threadId === "thr_helper")!.needsYou, "Pick a color");
  assert.deepEqual(task.plan[1]!.children[0]!.threadIds, ["thr_helper"]);
  assert.equal(task.docs[0]!.versions, 2);
  assert.deepEqual(board.untracked.map((u) => u.threadId), ["thr_other"]);

  // Replying to the helper clears its flag.
  await b.emitThreadEvent("thread.active", { thread: threads[1]! });
  board = (await b.callRpc("board", null)) as typeof board;
  assert.equal(board.tasks[0]!.threads.find((t) => t.threadId === "thr_helper")!.needsYou, null);

  // Finishing every leaf marks the task done.
  await b.callAgentTool("brief_item", { updates: [{ id: "1", status: "done" }, { id: "2.1.1", status: "done" }, { id: "2.1.2", status: "skipped" }] }, owner);
  const done = (await b.callRpc("done_list", { limit: 10, offset: 0 })) as { tasks: Task[] };
  assert.equal(done.tasks[0]!.status, "done");
  assert.ok(done.tasks[0]!.finishedAt);
});

test("new_task closes the current task and starts another", async () => {
  const b = await setup();
  await b.callAgentTool("brief_plan", { title: "First", items: [{ text: "a" }, { text: "b", status: "done" }] }, owner);
  await b.callAgentTool("brief_plan", { title: "Second", new_task: true, items: [{ text: "c" }] }, owner);
  const tasks = (await b.callRpc("thread_tasks", { threadId: "thr_owner" })) as { current: Task; earlier: Task[] };
  assert.equal(tasks.current.title, "Second");
  assert.equal(tasks.earlier[0]!.title, "First");
  assert.equal(tasks.earlier[0]!.status, "dropped");
});

test("v1 briefs convert to tasks", async () => {
  const b = await setup((kv) => {
    kv.set("brief:thr_owner", {
      threadId: "thr_owner",
      projectId: "proj_a",
      goal: "Old goal. More words",
      plan: [{ id: "1", text: "x", status: "done", note: null, children: [] }],
      now: "busy",
      needsYou: null,
      docs: [{ id: "d1", title: "Design", kind: "design", path: "/a.md", versions: 1, updatedAt: "2026-10-24T00:00:00.000Z" }],
      log: [],
      updatedAt: "2026-10-24T00:00:00.000Z",
    });
    kv.set("doc:d1:1", { version: 1, content: "# hi", savedAt: "2026-10-24T00:00:00.000Z" });
    kv.set("docthread:d1", "thr_owner");
  });
  const tasks = (await b.callRpc("thread_tasks", { threadId: "thr_owner" })) as { current: Task };
  assert.equal(tasks.current.title, "Old goal");
  assert.equal(tasks.current.status, "done");
  const doc = (await b.callRpc("doc_get", { docId: "d1", version: null })) as { version: { content: string } };
  assert.equal(doc.version.content, "# hi");
});

test("a thread you start yourself joins an existing task", async () => {
  const b = await setup();
  const loose = { threadId: "thr_other", projectId: "proj_a" };
  await b.callAgentTool("brief_plan", { title: "Ship v2", items: [{ text: "Server" }, { text: "UI" }] }, owner);

  const none = (await b.callAgentTool("brief_join", { task: "nothing like it" }, loose)) as { isError: boolean };
  assert.equal(none.isError, true);
  assert.match(text(none), /Ship v2/);

  const joined = await b.callAgentTool("brief_join", { task: "ship" }, loose);
  assert.match(text(joined), /Joined task "Ship v2"/);
  await b.callAgentTool("brief_claim", { item: "2" }, loose);
  let mine = (await b.callRpc("thread_tasks", { threadId: "thr_other" })) as { current: Task; joinable: Task[] };
  assert.equal(mine.current.title, "Ship v2");
  assert.equal(mine.current.threads.find((t) => t.threadId === "thr_other")!.role, "helper");

  // An owner of an open task cannot join another one.
  await b.callAgentTool("brief_plan", { title: "Other", new_task: true, items: [{ text: "x" }] }, helper);
  const blocked = (await b.callAgentTool("brief_join", { task: "ship" }, helper)) as { isError: boolean };
  assert.equal(blocked.isError, true);

  // Leaving from the panel puts the thread back on no task; joining from the panel works too.
  await b.callRpc("thread_leave", { threadId: "thr_other" });
  mine = (await b.callRpc("thread_tasks", { threadId: "thr_other" })) as typeof mine;
  assert.equal(mine.current, null);
  assert.deepEqual(mine.joinable.map((t) => t.title).sort(), ["Other", "Ship v2"]);
  await b.callRpc("thread_join", { threadId: "thr_other", taskId: mine.joinable.find((t) => t.title === "Other")!.id });
  mine = (await b.callRpc("thread_tasks", { threadId: "thr_other" })) as typeof mine;
  assert.equal(mine.current.title, "Other");
});

test("agents and you comment on a task; your comments reach the owner", async () => {
  const b = await setup();
  await b.callAgentTool("brief_plan", { title: "Ship v2", items: [{ text: "Server" }, { text: "UI" }] }, owner);
  await b.callAgentTool("brief_comment", { text: "Kept **SQLite** for docs.", kind: "decision", item: "1" }, owner);
  const bad = (await b.callAgentTool("brief_comment", { text: "x", item: "9" }, owner)) as { isError: boolean };
  assert.equal(bad.isError, true);

  const board = (await b.callRpc("board", null)) as { tasks: Task[] };
  const taskId = board.tasks[0]!.id;
  const result = (await b.callRpc("comment_add", { taskId, text: "Looks good, ship it", itemId: "2" })) as { delivered: boolean };
  assert.equal(result.delivered, true);
  assert.equal(sent.at(-1)!.threadId, "thr_owner");
  assert.match(sent.at(-1)!.text, /Comment on task "Ship v2" \(item 2: UI\):\n\nLooks good, ship it/);

  const { events } = (await b.callRpc("task_get", { taskId })) as { events: { author: string; kind: string | null; itemId: string | null; text: string }[] };
  const comments = events.filter((e) => e.author !== "system");
  assert.deepEqual(
    comments.map((e) => [e.author, e.kind, e.itemId]),
    [
      ["user", null, "2"],
      ["agent", "decision", "1"],
    ],
  );
  assert.ok(events.some((e) => e.author === "system" && /Task started/.test(e.text)));
});

test("agents read a task as the document the Brief tab shows", async () => {
  const b = await setup();
  await b.callAgentTool("brief_plan", { title: "Ship v2", goal: "Tasks on the board", items: [{ text: "Server", note: "SQLite" }, { text: "UI", children: [{ text: "Board" }] }] }, owner);
  await b.callAgentTool("brief_claim", { item: "2.1" }, helper);
  await b.callAgentTool("brief_status", { now: "Building cards", needs_you: "Pick a color" }, helper);
  await b.callAgentTool("brief_comment", { text: "Cards wrap below 400px.\nUsing a grid.", kind: "finding", item: "2.1" }, helper);
  await b.callAgentTool("brief_doc", { path: "ui.md", title: "UI notes", kind: "design" }, helper);

  // Any thread on the task, here the owner, reads it by default.
  const doc = text(await b.callAgentTool("brief_read", {}, owner));
  assert.match(doc, /^# Ship v2/);
  assert.match(doc, /Goal: Tasks on the board/);
  assert.match(doc, /\*\*UI helper\*\* \(helper on 2\.1, thr_helper, active\)/);
  assert.match(doc, /Needs the user: Pick a color/);
  assert.match(doc, /- \[ \] 1 Server\n  - Note: SQLite/);
  assert.match(doc, /- \[>\] 2\.1 Board \(UI helper; 1 comment\(s\)\)/);
  assert.match(doc, /\*\*UI helper\*\* · finding · on 2\.1\n  > Cards wrap below 400px\.\n  > Using a grid\./);
  assert.match(doc, /Task started: Ship v2/);
  const docId = /doc ([a-f0-9-]{12})/.exec(doc)![1]!;

  const comments = text(await b.callAgentTool("brief_read", { activity: "comments" }, owner));
  assert.doesNotMatch(comments, /Task started/);

  const content = text(await b.callAgentTool("brief_read", { doc: docId }, owner));
  assert.match(content, /^# UI notes\n\ndesign · v1 of 1/);
  assert.match(content, /# ui\.md$/);

  // A thread on no task can read any task by name, finished ones too.
  await b.callAgentTool("brief_item", { updates: [{ id: "1", status: "done" }, { id: "2.1", status: "done" }] }, owner);
  const loose = { threadId: "thr_other", projectId: "proj_a" };
  assert.match(text(await b.callAgentTool("brief_read", { task: "ship" }, loose)), /Task [a-f0-9-]{12} · done/);
  const none = (await b.callAgentTool("brief_read", {}, loose)) as { isError: boolean };
  assert.equal(none.isError, true);
});
