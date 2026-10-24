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

async function setup(seed?: (kv: Map<string, unknown>) => void) {
  const kvSeed = new Map<string, unknown>();
  seed?.(kvSeed);
  const { bb, harness } = createFakePluginHost({
    pluginId: "brief",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => threads.find((t) => t.id === threadId)!,
        list: async () => threads,
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
