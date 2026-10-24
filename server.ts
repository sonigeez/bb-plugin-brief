// bb-plugin-brief — tasks are the main object; threads are workers on a task.
// A task has a goal, a nested checklist, docs and an activity feed. Each
// thread on a task keeps its own "now" line and "needs you" flag. Threads a
// task thread spawns join the same task automatically. See DESIGN-tasks.md.
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const statusSchema = z.enum(["todo", "doing", "done", "blocked", "skipped"]);
export type ItemStatus = z.infer<typeof statusSchema>;

export type PlanItem = {
  /** Position path, "2" or "2.1"; stable as long as the plan keeps its shape. */
  id: string;
  text: string;
  status: ItemStatus;
  note: string | null;
  /** Helper threads working on this item. */
  threadIds: string[];
  children: PlanItem[];
};
const planItemSchema: z.ZodType<PlanItem> = z.lazy(() =>
  z.object({
    id: z.string(),
    text: z.string(),
    status: statusSchema,
    note: z.string().nullable(),
    threadIds: z.array(z.string()),
    children: z.array(planItemSchema),
  }),
);

const taskStatusSchema = z.enum(["open", "done", "dropped"]);
const docKindSchema = z.enum(["plan", "design", "findings", "report", "notes", "other"]);

const docSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  publishedBy: z.string(),
  title: z.string(),
  kind: docKindSchema,
  path: z.string().nullable(),
  versions: z.number(),
  updatedAt: z.string(),
});
export type DocMeta = z.infer<typeof docSchema>;

const taskThreadSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  /** Live bb status (active, idle, error, ...) or "gone" for deleted threads. */
  runStatus: z.string(),
  role: z.enum(["owner", "helper"]),
  itemId: z.string().nullable(),
  now: z.string().nullable(),
  needsYou: z.string().nullable(),
  left: z.boolean(),
});
export type TaskThread = z.infer<typeof taskThreadSchema>;

const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  title: z.string(),
  goal: z.string().nullable(),
  status: taskStatusSchema,
  ownerThreadId: z.string(),
  plan: z.array(planItemSchema),
  threads: z.array(taskThreadSchema),
  docs: z.array(docSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type Task = z.infer<typeof taskSchema>;

const commentKindSchema = z.enum(["update", "decision", "finding", "question"]);
export type CommentKind = z.infer<typeof commentKindSchema>;

/**
 * One line of the task's activity. `author: "system"` lines are written by the
 * plugin itself (item ticked, thread joined); "agent" and "user" lines are
 * comments, with a markdown `text`, a `kind`, and optionally the item they are about.
 */
const eventSchema = z.object({
  id: z.number(),
  at: z.string(),
  threadId: z.string().nullable(),
  author: z.enum(["system", "agent", "user"]),
  kind: commentKindSchema.nullable(),
  itemId: z.string().nullable(),
  text: z.string(),
});
export type TaskEvent = z.infer<typeof eventSchema>;

const untrackedSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  projectName: z.string(),
  runStatus: z.string(),
});
export type Untracked = z.infer<typeof untrackedSchema>;

const docVersionSchema = z.object({ version: z.number(), content: z.string(), savedAt: z.string() });

export const rpcContract = defineRpcContract({
  /** Open tasks, tasks finished in the last 7 days, and untracked running threads. */
  board: {
    input: z.null(),
    output: z.object({ tasks: z.array(taskSchema), untracked: z.array(untrackedSchema) }),
  },
  /** Finished and dropped tasks, newest first. */
  done_list: {
    input: z.object({ limit: z.number().int().min(1).max(200), offset: z.number().int().min(0) }),
    output: z.object({ tasks: z.array(taskSchema), more: z.boolean() }),
  },
  task_get: {
    input: z.object({ taskId: z.string() }),
    output: z.object({ task: taskSchema, events: z.array(eventSchema) }),
  },
  /** Your comment on a task; it is also sent to the task's owner thread. */
  comment_add: {
    input: z.object({
      taskId: z.string(),
      text: z.string().trim().min(1).max(4000),
      itemId: z.string().nullable(),
    }),
    output: z.object({ delivered: z.boolean(), error: z.string().nullable() }),
  },
  /** The thread's current task and its earlier ones. */
  thread_tasks: {
    input: z.object({ threadId: z.string() }),
    output: z.object({
      current: taskSchema.nullable(),
      earlier: z.array(taskSchema),
      /** Open tasks this thread could join, its own project first. */
      joinable: z.array(taskSchema),
    }),
  },
  thread_join: {
    input: z.object({ threadId: z.string(), taskId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  /** A helper leaves its task. */
  thread_leave: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  item_set_status: {
    input: z.object({ taskId: z.string(), itemId: z.string(), status: statusSchema }),
    output: z.object({ ok: z.boolean() }),
  },
  needs_you_clear: {
    input: z.object({ taskId: z.string(), threadId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  docs_list: {
    input: z.null(),
    output: z.object({ docs: z.array(docSchema.extend({ taskTitle: z.string() })) }),
  },
  doc_get: {
    input: z.object({ docId: z.string(), version: z.number().nullable() }),
    output: z.object({ doc: docSchema.extend({ taskTitle: z.string() }), version: docVersionSchema }),
  },
});

/** Realtime channel the app listens on. */
export const BRIEF_CHANGED = "brief-changed";

const DOC_MAX_BYTES = 200_000;
const BOARD_DONE_WINDOW_MS = 7 * 24 * 3600 * 1000;

// What the agent sends: up to three levels, ids assigned by position.
const inputLeaf = z.object({
  text: z.string().min(1).max(300),
  status: statusSchema.default("todo"),
  note: z.string().max(500).optional(),
});
const inputMid = inputLeaf.extend({ children: z.array(inputLeaf).max(30).optional() });
const inputTop = inputLeaf.extend({ children: z.array(inputMid).max(30).optional() });
type InputItem = z.infer<typeof inputLeaf> & { children?: InputItem[] };

function numberItems(items: InputItem[], prefix = ""): PlanItem[] {
  return items.map((item, index) => {
    const id = `${prefix}${index + 1}`;
    return {
      id,
      text: item.text,
      status: item.status,
      note: item.note ?? null,
      threadIds: [],
      children: numberItems(item.children ?? [], `${id}.`),
    };
  });
}

function walk(items: PlanItem[], visit: (item: PlanItem) => void) {
  for (const item of items) {
    visit(item);
    walk(item.children, visit);
  }
}

function findItem(items: PlanItem[], id: string): PlanItem | null {
  let found: PlanItem | null = null;
  walk(items, (item) => {
    if (item.id === id) found = item;
  });
  return found;
}

function leaves(items: PlanItem[]): PlanItem[] {
  return items.flatMap((item) => (item.children.length ? leaves(item.children) : [item]));
}

function isFinished(item: PlanItem) {
  return item.status === "done" || item.status === "skipped";
}

function renderPlan(items: PlanItem[], depth = 0): string {
  const mark: Record<ItemStatus, string> = {
    todo: "[ ]",
    doing: "[>]",
    done: "[x]",
    blocked: "[!]",
    skipped: "[-]",
  };
  return items
    .map((item) => {
      const line = `${"  ".repeat(depth)}${item.id} ${mark[item.status]} ${item.text}`;
      return item.children.length ? `${line}\n${renderPlan(item.children, depth + 1)}` : line;
    })
    .join("\n");
}

function progressLine(plan: PlanItem[]): string {
  const all = leaves(plan);
  return `${all.filter(isFinished).length}/${all.length} done`;
}

const MIGRATIONS = [
  `CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    goal TEXT,
    status TEXT NOT NULL,
    owner_thread_id TEXT NOT NULL,
    plan TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE TABLE task_threads (
    task_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL,
    item_id TEXT,
    now TEXT,
    needs_you TEXT,
    joined_at TEXT NOT NULL,
    left_at TEXT,
    PRIMARY KEY (task_id, thread_id)
  );
  CREATE INDEX task_threads_thread ON task_threads (thread_id, left_at);
  CREATE TABLE docs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    published_by TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    path TEXT,
    versions INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE doc_versions (
    doc_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    saved_at TEXT NOT NULL,
    PRIMARY KEY (doc_id, version)
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    thread_id TEXT,
    at TEXT NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX events_task ON events (task_id, id);`,
  // Comments live in the same timeline as the plugin's own activity lines.
  `ALTER TABLE events ADD COLUMN author TEXT NOT NULL DEFAULT 'system';
  ALTER TABLE events ADD COLUMN kind TEXT;
  ALTER TABLE events ADD COLUMN item_id TEXT;`,
];

type TaskRow = {
  id: string;
  project_id: string;
  title: string;
  goal: string | null;
  status: "open" | "done" | "dropped";
  owner_thread_id: string;
  plan: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};
type TaskThreadRow = {
  task_id: string;
  thread_id: string;
  role: "owner" | "helper";
  item_id: string | null;
  now: string | null;
  needs_you: string | null;
  joined_at: string;
  left_at: string | null;
};
type DocRow = {
  id: string;
  task_id: string;
  published_by: string;
  title: string;
  kind: z.infer<typeof docKindSchema>;
  path: string | null;
  versions: number;
  updated_at: string;
};

type LiveThread = { title: string; projectId: string; status: string; parentThreadId: string | null };

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  const nowIso = () => new Date().toISOString();
  const changed = () => bb.realtime.publish(BRIEF_CHANGED, {});

  // ------------------------------------------------------------- queries

  const q = {
    task: db.prepare<[string], TaskRow>("SELECT * FROM tasks WHERE id = ?"),
    currentLink: db.prepare<[string], TaskThreadRow>(
      "SELECT * FROM task_threads WHERE thread_id = ? AND left_at IS NULL",
    ),
    links: db.prepare<[string], TaskThreadRow>("SELECT * FROM task_threads WHERE task_id = ? ORDER BY joined_at"),
    docs: db.prepare<[string], DocRow>("SELECT * FROM docs WHERE task_id = ? ORDER BY updated_at DESC"),
    insertTask: db.prepare(
      `INSERT INTO tasks (id, project_id, title, goal, status, owner_thread_id, plan, created_at, updated_at, finished_at)
       VALUES (@id, @project_id, @title, @goal, @status, @owner_thread_id, @plan, @created_at, @updated_at, @finished_at)`,
    ),
    insertLink: db.prepare(
      `INSERT INTO task_threads (task_id, thread_id, role, item_id, now, needs_you, joined_at, left_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, ?, NULL)
       ON CONFLICT (task_id, thread_id) DO UPDATE SET left_at = NULL`,
    ),
    event: db.prepare("INSERT INTO events (task_id, thread_id, at, text) VALUES (?, ?, ?, ?)"),
    comment: db.prepare(
      "INSERT INTO events (task_id, thread_id, at, text, author, kind, item_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ),
  };

  function addEvent(taskId: string, threadId: string | null, text: string) {
    q.event.run(taskId, threadId, nowIso(), text);
  }

  /** Save a plan and move the task between open and done to match it. */
  function savePlan(task: TaskRow, plan: PlanItem[]) {
    const all = leaves(plan);
    const complete = all.length > 0 && all.every(isFinished);
    let status = task.status;
    let finishedAt = task.finished_at;
    if (complete && status === "open") {
      status = "done";
      finishedAt = nowIso();
      addEvent(task.id, null, "Task done");
    } else if (!complete && status === "done") {
      status = "open";
      finishedAt = null;
      addEvent(task.id, null, "Task reopened");
    }
    db.prepare("UPDATE tasks SET plan = ?, status = ?, finished_at = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(plan),
      status,
      finishedAt,
      nowIso(),
      task.id,
    );
  }

  function touch(taskId: string) {
    db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(nowIso(), taskId);
  }

  function createTask(threadId: string, projectId: string, title: string, goal: string | null): TaskRow {
    const at = nowIso();
    const row: TaskRow = {
      id: randomUUID().slice(0, 12),
      project_id: projectId,
      title,
      goal,
      status: "open",
      owner_thread_id: threadId,
      plan: "[]",
      created_at: at,
      updated_at: at,
      finished_at: null,
    };
    q.insertTask.run(row);
    q.insertLink.run(row.id, threadId, "owner", at);
    addEvent(row.id, threadId, `Task started: ${title}`);
    return row;
  }

  /** Close the thread's current task when it moves on (done if complete, else dropped). */
  function leaveCurrent(threadId: string) {
    const link = q.currentLink.get(threadId);
    if (!link) return;
    db.prepare("UPDATE task_threads SET left_at = ?, needs_you = NULL WHERE task_id = ? AND thread_id = ?").run(
      nowIso(),
      link.task_id,
      threadId,
    );
    const task = q.task.get(link.task_id);
    if (link.role === "owner" && task?.status === "open") {
      db.prepare("UPDATE tasks SET status = 'dropped', finished_at = ?, updated_at = ? WHERE id = ?").run(
        nowIso(),
        nowIso(),
        task.id,
      );
      addEvent(task.id, threadId, `Task closed at ${progressLine(JSON.parse(task.plan))}`);
    }
  }

  // ------------------------------------------------------- live thread info

  async function liveThreads(): Promise<Map<string, LiveThread>> {
    const threads = await bb.sdk.threads.list({ includeHidden: true });
    return new Map(
      threads.map((t) => [
        t.id,
        {
          title: t.title ?? t.titleFallback ?? "Untitled thread",
          projectId: t.projectId,
          status: t.status,
          parentThreadId: t.parentThreadId ?? null,
        },
      ]),
    );
  }

  async function projectNames(): Promise<Map<string, string>> {
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    return new Map(projects.map((p) => [p.id, p.name]));
  }

  type Context = { threads: Map<string, LiveThread>; projects: Map<string, string> };
  async function context(): Promise<Context> {
    const [threads, projects] = await Promise.all([liveThreads(), projectNames()]);
    return { threads, projects };
  }

  function toTask(row: TaskRow, ctx: Context): Task {
    return {
      id: row.id,
      projectId: row.project_id,
      projectName: ctx.projects.get(row.project_id) ?? "",
      title: row.title,
      goal: row.goal,
      status: row.status,
      ownerThreadId: row.owner_thread_id,
      plan: JSON.parse(row.plan) as PlanItem[],
      threads: q.links.all(row.id).map((link) => {
        const live = ctx.threads.get(link.thread_id);
        return {
          threadId: link.thread_id,
          title: live?.title ?? "Archived or deleted thread",
          runStatus: live?.status ?? "gone",
          role: link.role,
          itemId: link.item_id,
          now: link.now,
          needsYou: link.needs_you,
          left: link.left_at !== null,
        };
      }),
      docs: q.docs.all(row.id).map(toDoc),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
    };
  }

  function toDoc(row: DocRow): DocMeta {
    return {
      id: row.id,
      taskId: row.task_id,
      publishedBy: row.published_by,
      title: row.title,
      kind: row.kind,
      path: row.path,
      versions: row.versions,
      updatedAt: row.updated_at,
    };
  }

  /**
   * The thread's current task link. A thread that is on no task but whose
   * parent is joins the parent's task as a helper — this also covers spawns
   * that happened while the plugin was not loaded.
   */
  async function linkFor(threadId: string): Promise<TaskThreadRow | null> {
    const link = q.currentLink.get(threadId);
    if (link) return link;
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.parentThreadId) return joinParentTask(threadId, thread.parentThreadId);
    return null;
  }

  function joinParentTask(threadId: string, parentThreadId: string): TaskThreadRow | null {
    const parent = q.currentLink.get(parentThreadId);
    if (!parent) return null;
    q.insertLink.run(parent.task_id, threadId, "helper", nowIso());
    addEvent(parent.task_id, threadId, "Helper thread joined");
    touch(parent.task_id);
    return q.currentLink.get(threadId) ?? null;
  }

  /**
   * Join an open task as a helper, leaving the thread's current task. A
   * thread that owns an open task must finish or close it first, so joining
   * never silently drops someone's work.
   */
  function joinTask(threadId: string, taskId: string): { task: TaskRow } | { error: string } {
    const task = q.task.get(taskId);
    if (!task || task.status !== "open") return { error: "That task is not open." };
    const current = q.currentLink.get(threadId);
    if (current?.task_id === taskId) return { task };
    if (current?.role === "owner" && q.task.get(current.task_id)?.status === "open") {
      return { error: "This thread owns an open task. Finish it, or start fresh with brief_plan new_task, before joining another." };
    }
    if (current) leaveCurrent(threadId);
    q.insertLink.run(taskId, threadId, "helper", nowIso());
    addEvent(taskId, threadId, "Thread joined");
    touch(taskId);
    return { task };
  }

  function openTasks(): TaskRow[] {
    return db.prepare<[], TaskRow>("SELECT * FROM tasks WHERE status = 'open' ORDER BY updated_at DESC").all();
  }

  // ------------------------------------------------------- v1 migration

  for (const key of await bb.storage.kv.list("brief:")) {
    type V1Item = Omit<PlanItem, "threadIds" | "children"> & { children: V1Item[] };
    type V1Doc = { id: string; title: string; kind: DocRow["kind"]; path: string | null; versions: number; updatedAt: string };
    const brief = await bb.storage.kv.get<{
      threadId: string;
      projectId: string;
      goal: string | null;
      plan: V1Item[];
      now: string | null;
      needsYou: string | null;
      docs: V1Doc[];
      updatedAt: string;
    }>(key);
    if (!brief) continue;
    const toPlan = (items: V1Item[]): PlanItem[] =>
      items.map((item) => ({ ...item, threadIds: [], children: toPlan(item.children) }));
    const versions: { doc: V1Doc; content: { version: number; content: string; savedAt: string }[] }[] = [];
    for (const doc of brief.docs) {
      const content = [];
      for (let v = 1; v <= doc.versions; v++) {
        const saved = await bb.storage.kv.get<{ version: number; content: string; savedAt: string }>(`doc:${doc.id}:${v}`);
        if (saved) content.push(saved);
      }
      versions.push({ doc, content });
    }
    db.transaction(() => {
      if (q.currentLink.get(brief.threadId)) return;
      const title = (brief.goal ?? "Untitled task").split(/[.\n]/)[0]!.slice(0, 80);
      const task = createTask(brief.threadId, brief.projectId, title, brief.goal);
      savePlan(task, toPlan(brief.plan));
      db.prepare("UPDATE task_threads SET now = ?, needs_you = ? WHERE task_id = ? AND thread_id = ?").run(
        brief.now,
        brief.needsYou,
        task.id,
        brief.threadId,
      );
      for (const { doc, content } of versions) {
        db.prepare(
          "INSERT INTO docs (id, task_id, published_by, title, kind, path, versions, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(doc.id, task.id, brief.threadId, doc.title, doc.kind, doc.path, content.length, doc.updatedAt);
        content.forEach((saved, index) => {
          db.prepare("INSERT INTO doc_versions (doc_id, version, content, saved_at) VALUES (?, ?, ?, ?)").run(
            doc.id,
            index + 1,
            saved.content,
            saved.savedAt,
          );
        });
      }
      addEvent(task.id, null, "Converted from a v1 brief");
    })();
    for (const { doc } of versions) {
      for (let v = 1; v <= doc.versions; v++) await bb.storage.kv.delete(`doc:${doc.id}:${v}`);
      await bb.storage.kv.delete(`docthread:${doc.id}`);
    }
    await bb.storage.kv.delete(key);
    bb.log.info(`migrated v1 brief for ${brief.threadId}`);
  }

  // ---------------------------------------------------------------- agents

  const instructions = [
    "Keep the task brief current with the brief_* tools. The user follows work as tasks on one board instead of reading transcripts.",
    "- For any task with more than two steps, call brief_plan with a short title, the goal and a nested todo list, and call it again when the plan changes shape.",
    "- When the user moves this thread to unrelated work, call brief_plan with new_task: true; that closes the current task and starts a new one.",
    "- Tick progress with brief_item: doing when you start a step, done when it is finished.",
    "- Threads you spawn join your task automatically. In a spawned helper thread, call brief_claim with the item you are working on first; your brief_plan then fills in that item's sub-items.",
    "- When the user asks this thread to work on an existing task, call brief_join with its name, then brief_claim.",
    "- Call brief_status with needs_you whenever you stop to wait for the user. It clears itself when the user replies.",
    "- Use brief_comment for what is worth remembering: decisions and why, results and findings, dead ends, and questions. Do not comment on every small step; ticking items covers that.",
    "- A user message starting with 'Comment on task' came from the user's comment on the board; answer it with brief_comment as well as in chat.",
    "- When you write a plan, design note, findings or report as markdown, publish it with brief_doc; publish again after edits to save a new version.",
    "Skip all of this for one-shot questions.",
  ].join("\n");

  const noTask = (hint: string) => ({
    content: [{ type: "text" as const, text: `This thread is not on a task yet. ${hint}` }],
    isError: true,
  });

  bb.agents.registerTool({
    name: "brief_plan",
    description:
      "Set the task's goal and nested todo plan (up to three levels; ids are assigned by position: 1, 2, 2.1, 2.1.1). On the task's owner thread this replaces the whole plan; on a helper thread it replaces the sub-items of the item the helper claimed. A thread on no task starts one (title required). Pass new_task: true to close the current task and start a new one.",
    instructions,
    presentation: { label: { pending: "Updating plan", completed: "Updated plan" }, icon: { glyph: "ListTodo" } },
    parameters: z.object({
      title: z.string().min(1).max(80).optional().describe("Short task name, a few words. Required when starting a task."),
      goal: z.string().max(500).optional().describe("One or two sentences: what done looks like."),
      items: z.array(inputTop).max(40),
      new_task: z.boolean().optional().describe("Close the current task and start a new one."),
    }),
    async execute({ title, goal, items, new_task }, { threadId, projectId }) {
      const link = new_task ? null : await linkFor(threadId);
      if (!link && !title) {
        return { content: [{ type: "text", text: "Starting a task needs a title." }], isError: true };
      }
      const result = db.transaction((): { text: string; isError?: boolean } => {
        if (!link) {
          leaveCurrent(threadId);
          const task = createTask(threadId, projectId, title!, goal ?? null);
          const plan = numberItems(items);
          savePlan(task, plan);
          return { text: `Started task "${task.title}" (${progressLine(plan)}):\n${renderPlan(plan)}` };
        }
        const task = q.task.get(link.task_id)!;
        const plan = JSON.parse(task.plan) as PlanItem[];
        if (link.role === "owner") {
          const next = numberItems(items);
          // Keep helper assignments on items whose position did not change.
          walk(next, (item) => {
            item.threadIds = findItem(plan, item.id)?.threadIds ?? [];
          });
          if (title) db.prepare("UPDATE tasks SET title = ? WHERE id = ?").run(title, task.id);
          if (goal !== undefined) db.prepare("UPDATE tasks SET goal = ? WHERE id = ?").run(goal, task.id);
          savePlan(task, next);
          addEvent(task.id, threadId, "Plan updated");
          return { text: `Plan saved (${progressLine(next)}):\n${renderPlan(next)}` };
        }
        const claimed = link.item_id ? findItem(plan, link.item_id) : null;
        if (!claimed) {
          return {
            text: `You are a helper on task "${task.title}". Call brief_claim with the item you are working on first, or pass new_task: true to start your own task. Current plan:\n${renderPlan(plan)}`,
            isError: true,
          };
        }
        claimed.children = numberItems(items, `${claimed.id}.`);
        savePlan(task, plan);
        addEvent(task.id, threadId, `Sub-plan for ${claimed.id} updated`);
        return { text: `Sub-items of ${claimed.id} saved (${progressLine(claimed.children)}):\n${renderPlan([claimed])}` };
      })();
      changed();
      return { content: [{ type: "text", text: result.text }], isError: result.isError ?? false };
    },
  });

  bb.agents.registerTool({
    name: "brief_item",
    description:
      "Update one or more items on the task's plan by id: set status (todo, doing, done, blocked, skipped) and optionally a short note, such as a result or why it is blocked.",
    presentation: { label: { pending: "Updating plan item", completed: "Updated plan item" }, icon: { glyph: "ListChecks" }, suppress: true },
    parameters: z.object({
      updates: z
        .array(z.object({ id: z.string(), status: statusSchema, note: z.string().max(500).optional() }))
        .min(1)
        .max(20),
    }),
    async execute({ updates }, { threadId }) {
      const link = await linkFor(threadId);
      if (!link) return noTask("Call brief_plan with a title to start one.");
      const result = db.transaction(() => {
        const task = q.task.get(link.task_id)!;
        const plan = JSON.parse(task.plan) as PlanItem[];
        const missing: string[] = [];
        for (const update of updates) {
          const item = findItem(plan, update.id);
          if (!item) {
            missing.push(update.id);
            continue;
          }
          item.status = update.status;
          if (update.note !== undefined) item.note = update.note;
          addEvent(task.id, threadId, `${item.id} ${update.status}: ${item.text}`);
        }
        savePlan(task, plan);
        return { missing, plan };
      })();
      changed();
      if (result.missing.length) {
        return {
          content: [{ type: "text", text: `No plan item ${result.missing.join(", ")}. Current plan:\n${renderPlan(result.plan)}` }],
          isError: true,
        };
      }
      return `Updated (${progressLine(result.plan)}).`;
    },
  });

  bb.agents.registerTool({
    name: "brief_claim",
    description:
      "In a helper thread, attach yourself to the plan item you are working on. Your thread then shows on that item, and your brief_plan calls fill in its sub-items.",
    presentation: { label: { pending: "Claiming plan item", completed: "Claimed plan item" }, icon: { glyph: "UserCheck" } },
    parameters: z.object({ item: z.string().describe("Item id, such as 2.1") }),
    async execute({ item: itemId }, { threadId }) {
      const link = await linkFor(threadId);
      if (!link) return noTask("Only threads spawned from a task thread can claim items; call brief_plan with a title to start your own task.");
      const result = db.transaction(() => {
        const task = q.task.get(link.task_id)!;
        const plan = JSON.parse(task.plan) as PlanItem[];
        const item = findItem(plan, itemId);
        if (!item) return { error: `No plan item ${itemId}. Current plan:\n${renderPlan(plan)}` };
        walk(plan, (other) => {
          other.threadIds = other.threadIds.filter((id) => id !== threadId);
        });
        item.threadIds.push(threadId);
        if (item.status === "todo") item.status = "doing";
        savePlan(task, plan);
        db.prepare("UPDATE task_threads SET item_id = ? WHERE task_id = ? AND thread_id = ?").run(itemId, task.id, threadId);
        addEvent(task.id, threadId, `Claimed ${item.id}: ${item.text}`);
        return { text: `Claimed ${item.id} "${item.text}" on task "${task.title}".` };
      })();
      changed();
      return "error" in result ? { content: [{ type: "text", text: result.error! }], isError: true } : result.text!;
    },
  });

  bb.agents.registerTool({
    name: "brief_join",
    description:
      "Join an existing open task as a helper, when the user asks this thread to work on it. Pass the task id or words from its title. With no match, or several, it lists the open tasks to choose from.",
    presentation: { label: { pending: "Joining task", completed: "Joined task" }, icon: { glyph: "UserPlus" } },
    parameters: z.object({ task: z.string().min(1).describe("Task id or words from its title") }),
    async execute({ task: query }, { threadId, projectId }) {
      const open = openTasks();
      const words = query.toLowerCase();
      const byId = open.filter((t) => t.id === query);
      const matches = byId.length ? byId : open.filter((t) => t.title.toLowerCase().includes(words));
      // Prefer this project's tasks when a title matches in several projects.
      const local = matches.filter((t) => t.project_id === projectId);
      const picked = local.length === 1 ? local : matches;
      const list = (rows: TaskRow[]) =>
        rows.map((t) => `- ${t.id}  ${t.title} (${progressLine(JSON.parse(t.plan))})`).join("\n") || "(no open tasks)";
      if (picked.length !== 1) {
        const why = picked.length === 0 ? `No open task matches "${query}".` : `Several open tasks match "${query}"; pass an id.`;
        return { content: [{ type: "text", text: `${why} Open tasks:\n${list(picked.length ? picked : open)}` }], isError: true };
      }
      const result = db.transaction(() => joinTask(threadId, picked[0]!.id))();
      if ("error" in result) return { content: [{ type: "text", text: result.error }], isError: true };
      changed();
      const plan = JSON.parse(result.task.plan) as PlanItem[];
      return `Joined task "${result.task.title}". Claim the item you work on with brief_claim. Plan:\n${renderPlan(plan)}`;
    },
  });

  bb.agents.registerTool({
    name: "brief_comment",
    description:
      "Add a comment to the task's activity: a decision and why, a finding or result, a dead end worth remembering, an update for the user, or a question. Markdown, a few lines. Optionally attach it to a plan item.",
    presentation: { label: { pending: "Commenting on task", completed: "Commented on task" }, icon: { glyph: "MessageSquare" } },
    parameters: z.object({
      text: z.string().min(1).max(4000),
      kind: commentKindSchema.default("update"),
      item: z.string().optional().describe("Plan item id the comment is about, such as 2.1"),
    }),
    async execute({ text, kind, item }, { threadId }) {
      const link = await linkFor(threadId);
      if (!link) return noTask("Call brief_plan with a title to start one.");
      if (item) {
        const plan = JSON.parse(q.task.get(link.task_id)!.plan) as PlanItem[];
        if (!findItem(plan, item)) {
          return { content: [{ type: "text", text: `No plan item ${item}. Current plan:\n${renderPlan(plan)}` }], isError: true };
        }
      }
      q.comment.run(link.task_id, threadId, nowIso(), text, "agent", kind, item ?? null);
      touch(link.task_id);
      changed();
      return "Comment added.";
    },
  });

  bb.agents.registerTool({
    name: "brief_status",
    description:
      "Set this thread's one-line 'now' status (what you are doing right now) and/or its 'needs you' flag (what you are waiting on from the user). Pass needs_you: null to clear it.",
    presentation: { label: { pending: "Updating status", completed: "Updated status" }, icon: { glyph: "Activity" }, suppress: true },
    parameters: z.object({
      now: z.string().max(200).optional(),
      needs_you: z.string().max(300).nullable().optional(),
    }),
    async execute({ now, needs_you }, { threadId }) {
      const link = await linkFor(threadId);
      if (!link) return noTask("Call brief_plan with a title to start one.");
      db.transaction(() => {
        if (now !== undefined) {
          db.prepare("UPDATE task_threads SET now = ? WHERE task_id = ? AND thread_id = ?").run(now, link.task_id, threadId);
        }
        if (needs_you !== undefined) {
          db.prepare("UPDATE task_threads SET needs_you = ? WHERE task_id = ? AND thread_id = ?").run(
            needs_you,
            link.task_id,
            threadId,
          );
          if (needs_you) addEvent(link.task_id, threadId, `Needs you: ${needs_you}`);
        }
        touch(link.task_id);
      })();
      changed();
      return "Status saved.";
    },
  });

  // Tools run on the server, so the file lives on the thread's host: resolve
  // it through the thread's environment and read it with bb.sdk.files.
  async function readThreadFile(threadId: string, path: string): Promise<string> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) throw new Error("This thread has no environment to read files from.");
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    const result = await bb.sdk.files.read({
      hostId: environment.hostId,
      // Absolute paths read as given; relative ones resolve in the workspace.
      ...(path.startsWith("/") ? {} : { rootPath: environment.path ?? undefined }),
      path,
    });
    if (!("content" in result) || typeof result.content !== "string") {
      throw new Error(`Could not read ${path}.`);
    }
    return "contentEncoding" in result && result.contentEncoding === "base64"
      ? Buffer.from(result.content, "base64").toString("utf8")
      : result.content;
  }

  bb.agents.registerTool({
    name: "brief_doc",
    description:
      "Publish a markdown document (plan, design, findings, report, notes) to the task's docs. Give a path to a markdown file (relative to the workspace root, or absolute); its current content is saved as a new version. Publishing the same path again on the same task adds a version.",
    presentation: { label: { pending: "Publishing document", completed: "Published document" }, icon: { glyph: "FileText" } },
    parameters: z.object({
      path: z.string().min(1),
      title: z.string().min(1).max(120),
      kind: docKindSchema.default("notes"),
    }),
    async execute({ path, title, kind }, { threadId }) {
      const link = await linkFor(threadId);
      if (!link) return noTask("Call brief_plan with a title to start one, then publish.");
      const content = await readThreadFile(threadId, path);
      if (Buffer.byteLength(content) > DOC_MAX_BYTES) {
        return { content: [{ type: "text", text: `${path} is over ${DOC_MAX_BYTES} bytes; publish a shorter document.` }], isError: true };
      }
      const version = db.transaction(() => {
        const at = nowIso();
        let doc = db.prepare<[string, string], DocRow>("SELECT * FROM docs WHERE task_id = ? AND path = ?").get(link.task_id, path);
        if (!doc) {
          const id = randomUUID().slice(0, 12);
          db.prepare(
            "INSERT INTO docs (id, task_id, published_by, title, kind, path, versions, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
          ).run(id, link.task_id, threadId, title, kind, path, at);
          doc = db.prepare<[string], DocRow>("SELECT * FROM docs WHERE id = ?").get(id)!;
        }
        const next = doc.versions + 1;
        db.prepare("UPDATE docs SET title = ?, kind = ?, versions = ?, updated_at = ? WHERE id = ?").run(title, kind, next, at, doc.id);
        db.prepare("INSERT INTO doc_versions (doc_id, version, content, saved_at) VALUES (?, ?, ?, ?)").run(doc.id, next, content, at);
        addEvent(link.task_id, threadId, `Published ${kind}: ${title} (v${next})`);
        touch(link.task_id);
        return next;
      })();
      changed();
      return `Published "${title}" as v${version}.`;
    },
  });

  // ------------------------------------------------------- lifecycle events

  // Spawned threads join their parent's task.
  bb.events.on("thread.created", ({ thread }) => {
    if (thread.parentThreadId && !q.currentLink.get(thread.id)) {
      db.transaction(() => joinParentTask(thread.id, thread.parentThreadId!))();
    }
    changed();
  });
  // A new turn means the user answered: this thread's "needs you" is stale.
  bb.events.on("thread.active", ({ thread }) => {
    db.prepare("UPDATE task_threads SET needs_you = NULL WHERE thread_id = ? AND left_at IS NULL").run(thread.id);
    changed();
  });
  for (const event of ["thread.idle", "thread.failed", "thread.archived", "thread.unarchived", "thread.deleted"] as const) {
    bb.events.on(event, () => changed());
  }

  // -------------------------------------------------------------------- rpc

  bb.rpc.register(rpcContract, {
    board: async () => {
      const ctx = await context();
      const since = new Date(Date.now() - BOARD_DONE_WINDOW_MS).toISOString();
      const rows = db
        .prepare<[string], TaskRow>(
          "SELECT * FROM tasks WHERE status = 'open' OR finished_at >= ? ORDER BY updated_at DESC",
        )
        .all(since);
      const onTask = new Set(
        db.prepare<[], { thread_id: string }>("SELECT thread_id FROM task_threads WHERE left_at IS NULL").all().map((r) => r.thread_id),
      );
      const untracked: Untracked[] = [];
      for (const [threadId, live] of ctx.threads) {
        if (onTask.has(threadId) || live.status === "idle") continue;
        untracked.push({
          threadId,
          title: live.title,
          projectName: ctx.projects.get(live.projectId) ?? "",
          runStatus: live.status,
        });
      }
      return { tasks: rows.map((row) => toTask(row, ctx)), untracked };
    },
    done_list: async ({ limit, offset }) => {
      const ctx = await context();
      const rows = db
        .prepare<[number, number], TaskRow>(
          "SELECT * FROM tasks WHERE status != 'open' ORDER BY finished_at DESC LIMIT ? OFFSET ?",
        )
        .all(limit + 1, offset);
      return { tasks: rows.slice(0, limit).map((row) => toTask(row, ctx)), more: rows.length > limit };
    },
    task_get: async ({ taskId }) => {
      const row = q.task.get(taskId);
      if (!row) throw new Error("Task not found.");
      const events = db
        .prepare<
          [string],
          { id: number; at: string; thread_id: string | null; text: string; author: TaskEvent["author"]; kind: CommentKind | null; item_id: string | null }
        >("SELECT id, at, thread_id, text, author, kind, item_id FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 300")
        .all(taskId)
        .map((e) => ({ id: e.id, at: e.at, threadId: e.thread_id, author: e.author, kind: e.kind, itemId: e.item_id, text: e.text }));
      return { task: toTask(row, await context()), events };
    },
    comment_add: async ({ taskId, text, itemId }) => {
      const task = q.task.get(taskId);
      if (!task) throw new Error("Task not found.");
      const plan = JSON.parse(task.plan) as PlanItem[];
      const item = itemId ? findItem(plan, itemId) : null;
      if (itemId && !item) throw new Error(`No plan item ${itemId}.`);
      q.comment.run(taskId, null, nowIso(), text, "user", null, itemId);
      touch(taskId);
      changed();
      // Queue it for the owner so it never interrupts a running turn.
      const about = item ? ` (item ${item.id}: ${item.text})` : "";
      try {
        await bb.sdk.threads.send({
          threadId: task.owner_thread_id,
          mode: "queue-if-active",
          input: [{ type: "text", mentions: [], text: `Comment on task "${task.title}"${about}:\n\n${text}` }],
        });
        return { delivered: true, error: null };
      } catch (cause) {
        return { delivered: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    thread_tasks: async ({ threadId }) => {
      const ctx = await context();
      const rows = db
        .prepare<[string], TaskRow & { left_at: string | null }>(
          `SELECT tasks.*, task_threads.left_at FROM tasks
           JOIN task_threads ON task_threads.task_id = tasks.id
           WHERE task_threads.thread_id = ? ORDER BY task_threads.joined_at DESC`,
        )
        .all(threadId);
      const current = rows.find((row) => row.left_at === null) ?? null;
      const projectId = ctx.threads.get(threadId)?.projectId;
      const joinable = openTasks()
        .filter((task) => task.id !== current?.id)
        .sort((a, b) => Number(b.project_id === projectId) - Number(a.project_id === projectId));
      return {
        current: current ? toTask(current, ctx) : null,
        earlier: rows.filter((row) => row !== current).map((row) => toTask(row, ctx)),
        joinable: joinable.map((row) => toTask(row, ctx)),
      };
    },
    thread_join: async ({ threadId, taskId }) => {
      const result = db.transaction(() => joinTask(threadId, taskId))();
      if ("error" in result) throw new Error(result.error);
      changed();
      return { ok: true };
    },
    thread_leave: async ({ threadId }) => {
      const link = q.currentLink.get(threadId);
      if (!link) return { ok: true };
      if (link.role === "owner") throw new Error("The owner thread cannot leave its task; start a new task from it instead.");
      db.transaction(() => {
        leaveCurrent(threadId);
        addEvent(link.task_id, threadId, "Thread left");
      })();
      changed();
      return { ok: true };
    },
    item_set_status: async ({ taskId, itemId, status }) => {
      db.transaction(() => {
        const task = q.task.get(taskId);
        if (!task) throw new Error("Task not found.");
        const plan = JSON.parse(task.plan) as PlanItem[];
        const item = findItem(plan, itemId);
        if (!item) throw new Error(`No plan item ${itemId}.`);
        item.status = status;
        savePlan(task, plan);
        addEvent(task.id, null, `${item.id} ${status} (by you): ${item.text}`);
      })();
      changed();
      return { ok: true };
    },
    needs_you_clear: async ({ taskId, threadId }) => {
      db.prepare("UPDATE task_threads SET needs_you = NULL WHERE task_id = ? AND thread_id = ?").run(taskId, threadId);
      changed();
      return { ok: true };
    },
    docs_list: async () => {
      const rows = db
        .prepare<[], DocRow & { task_title: string }>(
          "SELECT docs.*, tasks.title AS task_title FROM docs JOIN tasks ON tasks.id = docs.task_id ORDER BY docs.updated_at DESC",
        )
        .all();
      return { docs: rows.map((row) => ({ ...toDoc(row), taskTitle: row.task_title })) };
    },
    doc_get: async ({ docId, version }) => {
      const row = db
        .prepare<[string], DocRow & { task_title: string }>(
          "SELECT docs.*, tasks.title AS task_title FROM docs JOIN tasks ON tasks.id = docs.task_id WHERE docs.id = ?",
        )
        .get(docId);
      if (!row) throw new Error("Document not found.");
      const wanted = version ?? row.versions;
      const saved = db
        .prepare<[string, number], { version: number; content: string; saved_at: string }>(
          "SELECT version, content, saved_at FROM doc_versions WHERE doc_id = ? AND version = ?",
        )
        .get(docId, wanted);
      if (!saved) throw new Error(`Version ${wanted} not found.`);
      return {
        doc: { ...toDoc(row), taskTitle: row.task_title },
        version: { version: saved.version, content: saved.content, savedAt: saved.saved_at },
      };
    },
  });
}
