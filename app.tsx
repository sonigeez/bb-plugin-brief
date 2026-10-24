// bb-plugin-brief — frontend. Tasks are the main view: lanes of tasks, a task
// page, Done so far, and the docs library. In a thread, the side panel shows
// the thread's current task and its earlier ones. Everything refetches on the
// server's "brief-changed" signal.
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Markdown, definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { DocMeta, ItemStatus, PlanItem, Task, TaskEvent, TaskThread, Untracked, rpcContract } from "./server";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const BRIEF_CHANGED = "brief-changed";
const PANEL_ACTION_ID = "brief";
const PANEL_PATH = "board";

// ------------------------------------------------------------------ data

function useLive<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    load().then(
      (result) => {
        setData(result);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [load]);
  useEffect(refetch, [refetch]);
  useRealtime(BRIEF_CHANGED, refetch);
  return { data, error };
}

function useBrief() {
  return useRpc<typeof rpcContract>();
}

/** Re-render every 30 s so "x ago" labels stay right. */
function useTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
}

// --------------------------------------------------------------- helpers

function leaves(items: PlanItem[]): PlanItem[] {
  return items.flatMap((item) => (item.children.length ? leaves(item.children) : [item]));
}

function progress(task: Task) {
  const all = leaves(task.plan);
  return { done: all.filter((i) => i.status === "done" || i.status === "skipped").length, total: all.length };
}

/** The deepest items in progress, for the card's "Now" lines. */
function currentItems(items: PlanItem[]): PlanItem[] {
  return items.flatMap((item) => {
    const nested = currentItems(item.children);
    if (nested.length) return nested;
    return item.status === "doing" ? [item] : [];
  });
}

function activeThreads(task: Task) {
  return task.threads.filter((t) => !t.left);
}

function needsYou(task: Task): TaskThread[] {
  return activeThreads(task).filter((t) => t.needsYou || t.runStatus === "error");
}

function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function dayLabel(iso: string): string {
  const day = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return "Today";
  if (day.toDateString() === yesterday.toDateString()) return "Yesterday";
  return day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function isToday(iso: string | null) {
  return iso !== null && new Date(iso).toDateString() === new Date().toDateString();
}

const STATUS_ICON: Record<ItemStatus, { name: string; className: string }> = {
  todo: { name: "Circle", className: "text-muted-foreground" },
  doing: { name: "CircleDot", className: "text-primary" },
  done: { name: "CircleCheck", className: "text-emerald-500" },
  blocked: { name: "CircleAlert", className: "text-destructive" },
  skipped: { name: "CircleMinus", className: "text-muted-foreground" },
};

// ------------------------------------------------------------ primitives

function RunDot({ status, title }: { status: string; title?: string }) {
  const color =
    status === "error"
      ? "bg-destructive"
      : status === "idle" || status === "gone"
        ? "bg-muted-foreground/40"
        : "bg-emerald-500 animate-pulse";
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", color)} title={title ?? status} />;
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  if (total === 0) return null;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${(done / total) * 100}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">
        {done}/{total}
      </span>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function SectionTitle({ children, tone }: { children: ReactNode; tone?: "alert" }) {
  return (
    <h2 className={cn("mb-2 text-xs font-medium uppercase tracking-wide", tone === "alert" ? "text-destructive" : "text-muted-foreground")}>
      {children}
    </h2>
  );
}

function StatusBadge({ task }: { task: Task }) {
  if (task.status === "open") return null;
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[11px] font-medium",
        task.status === "done" ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground",
      )}
    >
      {task.status === "done" ? "Done" : "Closed early"}
    </span>
  );
}

function ErrorText({ children }: { children: ReactNode }) {
  return <p className="text-sm text-destructive">{children}</p>;
}

// ------------------------------------------------------------- plan tree

function PlanTree({
  task,
  items,
  highlightItemId,
  depth = 0,
}: {
  task: Task;
  items: PlanItem[];
  highlightItemId?: string | null;
  depth?: number;
}) {
  const rpc = useBrief();
  const toggle = (item: PlanItem) => {
    const status: ItemStatus = item.status === "done" ? "todo" : "done";
    void rpc.call("item_set_status", { taskId: task.id, itemId: item.id, status });
  };
  const threadsById = new Map(task.threads.map((t) => [t.threadId, t]));
  return (
    <ul className={cn("space-y-0.5", depth > 0 && "ml-5 border-l border-border pl-2")}>
      {items.map((item) => {
        const icon = STATUS_ICON[item.status];
        const leaf = item.children.length === 0;
        const workers = item.threadIds.map((id) => threadsById.get(id)).filter((t): t is TaskThread => t !== undefined);
        return (
          <li key={item.id}>
            <div className={cn("flex items-start gap-2 rounded py-0.5 text-sm", item.id === highlightItemId && "bg-primary/10 px-1")}>
              <button
                type="button"
                disabled={!leaf}
                onClick={() => toggle(item)}
                className="mt-0.5 shrink-0 disabled:cursor-default"
                aria-label={`${item.text}: ${item.status}`}
              >
                <Icon name={icon.name} fallback="Circle" className={cn("size-4", icon.className)} />
              </button>
              <div className="min-w-0 flex-1">
                <span
                  className={cn(
                    (item.status === "done" || item.status === "skipped") && "text-muted-foreground line-through",
                    item.status === "doing" && "font-medium",
                  )}
                >
                  {item.text}
                </span>
                {workers.map((worker) => (
                  <span key={worker.threadId} className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <RunDot status={worker.runStatus} />
                    {worker.title}
                  </span>
                ))}
                {item.note ? <p className="text-xs text-muted-foreground">{item.note}</p> : null}
              </div>
            </div>
            {item.children.length ? (
              <PlanTree task={task} items={item.children} highlightItemId={highlightItemId} depth={depth + 1} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function DocList({ docs }: { docs: DocMeta[] }) {
  const navigate = useBbNavigate();
  return (
    <ul className="space-y-1">
      {docs.map((doc) => (
        <li key={doc.id}>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-muted"
            onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: `doc/${doc.id}` })}
          >
            <Icon name="FileText" className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{doc.title}</span>
            <span className="text-xs text-muted-foreground">
              {doc.kind} · v{doc.versions}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ThreadRows({ task }: { task: Task }) {
  const rpc = useBrief();
  const navigate = useBbNavigate();
  return (
    <ul className="space-y-2">
      {task.threads.map((thread) => (
        <li key={thread.threadId} className={cn("text-sm", thread.left && "opacity-60")}>
          <div className="flex items-center gap-2">
            <RunDot status={thread.runStatus} />
            <button type="button" className="min-w-0 truncate text-left hover:underline" onClick={() => navigate.toThread(thread.threadId)}>
              {thread.title}
            </button>
            <span className="shrink-0 text-xs text-muted-foreground">
              {thread.role}
              {thread.itemId ? ` · ${thread.itemId}` : ""}
              {thread.left ? " · moved on" : ""}
            </span>
          </div>
          {thread.now ? <p className="ml-4 text-xs text-muted-foreground">{thread.now}</p> : null}
          {thread.needsYou ? (
            <div className="ml-4 mt-1 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2">
              <Icon name="Hand" className="mt-0.5 size-4 shrink-0 text-destructive" />
              <span className="flex-1">{thread.needsYou}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => void rpc.call("needs_you_clear", { taskId: task.id, threadId: thread.threadId })}
              >
                Clear
              </Button>
            </div>
          ) : null}
          {thread.runStatus === "error" && !thread.left ? <p className="ml-4 text-xs text-destructive">Thread failed</p> : null}
        </li>
      ))}
    </ul>
  );
}

/** Goal, progress, threads, checklist and docs: shared by the task page and the thread panel. */
function TaskBody({ task, highlightItemId }: { task: Task; highlightItemId?: string | null }) {
  const { done, total } = progress(task);
  return (
    <div className="space-y-5">
      {task.goal ? <p className="text-sm">{task.goal}</p> : null}
      <ProgressBar done={done} total={total} />
      <section>
        <SectionTitle>Threads · {task.threads.length}</SectionTitle>
        <ThreadRows task={task} />
      </section>
      {task.plan.length ? (
        <section>
          <SectionTitle>Plan</SectionTitle>
          <PlanTree task={task} items={task.plan} highlightItemId={highlightItemId} />
        </section>
      ) : null}
      {task.docs.length ? (
        <section>
          <SectionTitle>Documents</SectionTitle>
          <DocList docs={task.docs} />
        </section>
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------------- tasks

function TaskCard({ task }: { task: Task }) {
  const navigate = useBbNavigate();
  const { done, total } = progress(task);
  const waiting = needsYou(task);
  const now = currentItems(task.plan).slice(0, 2);
  return (
    <button
      type="button"
      onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: `task/${task.id}` })}
      className={cn(
        "w-full space-y-2 rounded-lg border bg-card p-3 text-left text-card-foreground hover:bg-muted/40",
        waiting.length ? "border-destructive/50" : "border-border",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{task.title}</div>
          <div className="truncate text-xs text-muted-foreground">
            {task.projectName} · {ago(task.updatedAt)}
          </div>
        </div>
        <StatusBadge task={task} />
        <div className="flex shrink-0 items-center gap-1 pt-1" aria-label={`${activeThreads(task).length} threads`}>
          {activeThreads(task).map((t) => (
            <RunDot key={t.threadId} status={t.runStatus} title={`${t.title} · ${t.runStatus}`} />
          ))}
        </div>
      </div>
      {waiting.map((t) => (
        <p key={t.threadId} className="flex items-start gap-1.5 text-sm text-destructive">
          <Icon name="Hand" className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">
            {t.needsYou ?? "Thread failed"}
            {activeThreads(task).length > 1 ? <span className="text-xs opacity-75"> · {t.title}</span> : null}
          </span>
        </p>
      ))}
      {now.map((item) => (
        <p key={item.id} className="truncate text-sm">
          <span className="text-muted-foreground">Now: </span>
          {item.text}
        </p>
      ))}
      <ProgressBar done={done} total={total} />
    </button>
  );
}

function UntrackedStrip({ threads }: { threads: Untracked[] }) {
  const navigate = useBbNavigate();
  if (threads.length === 0) return null;
  return (
    <section>
      <SectionTitle>Untracked · {threads.length}</SectionTitle>
      <div className="flex flex-wrap gap-1.5">
        {threads.map((t) => (
          <button
            key={t.threadId}
            type="button"
            onClick={() => navigate.toThread(t.threadId)}
            className="flex max-w-xs items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            <RunDot status={t.runStatus} />
            <span className="truncate">{t.title}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function ProjectFilter({
  names,
  value,
  onChange,
}: {
  names: [string, string][];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  if (names.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {[[null, "All"] as const, ...names].map(([id, name]) => (
        <Button key={id ?? "all"} size="sm" variant={value === id ? "default" : "outline"} className="h-7 text-xs" onClick={() => onChange(id)}>
          {name || "Untitled"}
        </Button>
      ))}
    </div>
  );
}

function projectsOf(tasks: Task[]): [string, string][] {
  return [...new Map(tasks.map((t) => [t.projectId, t.projectName])).entries()];
}

function TasksView() {
  const rpc = useBrief();
  const load = useCallback(() => rpc.call("board"), [rpc]);
  const { data, error } = useLive(load);
  const [project, setProject] = useState<string | null>(null);
  useTick();
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <EmptyState>Loading…</EmptyState>;
  const tasks = data.tasks.filter((t) => project === null || t.projectId === project);
  const lanes = [
    { id: "needs", title: "Needs you", tasks: tasks.filter((t) => t.status === "open" && needsYou(t).length > 0) },
    { id: "progress", title: "In progress", tasks: tasks.filter((t) => t.status === "open" && needsYou(t).length === 0) },
    { id: "today", title: "Done today", tasks: tasks.filter((t) => t.status !== "open" && isToday(t.finishedAt)) },
  ];
  const empty = lanes.every((lane) => lane.tasks.length === 0);
  return (
    <div className="space-y-5">
      <ProjectFilter names={projectsOf(data.tasks)} value={project} onChange={setProject} />
      {empty ? <EmptyState>No open tasks. Agents start one when they plan multi-step work.</EmptyState> : null}
      {lanes.map((lane) =>
        lane.tasks.length ? (
          <section key={lane.id}>
            <SectionTitle tone={lane.id === "needs" ? "alert" : undefined}>
              {lane.title} · {lane.tasks.length}
            </SectionTitle>
            <div className="grid gap-2 md:grid-cols-2">
              {lane.tasks.map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
            </div>
          </section>
        ) : null,
      )}
      <UntrackedStrip threads={data.untracked} />
    </div>
  );
}

function TaskPage({ taskId }: { taskId: string }) {
  const rpc = useBrief();
  const load = useCallback(() => rpc.call("task_get", { taskId }), [rpc, taskId]);
  const { data, error } = useLive(load);
  useTick();
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <EmptyState>Loading…</EmptyState>;
  const { task, events } = data;
  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-base font-medium">{task.title}</h2>
          <StatusBadge task={task} />
        </div>
        <p className="text-xs text-muted-foreground">
          {task.projectName} · started {ago(task.createdAt)}
          {task.finishedAt ? ` · finished ${ago(task.finishedAt)}` : ""}
        </p>
      </div>
      <TaskBody task={task} />
      <ActivityFeed task={task} events={events} />
    </div>
  );
}

function ActivityFeed({ task, events }: { task: Task; events: TaskEvent[] }) {
  if (events.length === 0) return null;
  const titles = new Map(task.threads.map((t) => [t.threadId, t.title]));
  const many = task.threads.length > 1;
  return (
    <section>
      <SectionTitle>Activity</SectionTitle>
      <ul className="space-y-1 text-xs text-muted-foreground">
        {events.map((event, index) => (
          <li key={`${event.at}-${index}`} className="flex gap-2">
            <span className="w-14 shrink-0 tabular-nums">{ago(event.at)}</span>
            <span className="min-w-0">
              {event.text}
              {many && event.threadId ? <span className="opacity-75"> · {titles.get(event.threadId) ?? "thread"}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------- done so far

const DONE_PAGE = 50;

function DoneSoFar() {
  const rpc = useBrief();
  const navigate = useBbNavigate();
  const [limit, setLimit] = useState(DONE_PAGE);
  const load = useCallback(() => rpc.call("done_list", { limit, offset: 0 }), [rpc, limit]);
  const { data, error } = useLive(load);
  const [project, setProject] = useState<string | null>(null);
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <EmptyState>Loading…</EmptyState>;
  if (data.tasks.length === 0) return <EmptyState>Nothing finished yet. Finished and closed tasks collect here.</EmptyState>;
  const tasks = data.tasks.filter((t) => project === null || t.projectId === project);
  const days: [string, Task[]][] = [];
  for (const task of tasks) {
    const label = dayLabel(task.finishedAt ?? task.updatedAt);
    const last = days[days.length - 1];
    if (last && last[0] === label) last[1].push(task);
    else days.push([label, [task]]);
  }
  return (
    <div className="space-y-5">
      <ProjectFilter names={projectsOf(data.tasks)} value={project} onChange={setProject} />
      {days.map(([label, dayTasks]) => (
        <section key={label}>
          <SectionTitle>
            {label} · {dayTasks.length}
          </SectionTitle>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {dayTasks.map((task) => {
              const { done, total } = progress(task);
              return (
                <li key={task.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted"
                    onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: `task/${task.id}` })}
                  >
                    <Icon
                      name={task.status === "done" ? "CircleCheck" : "CircleMinus"}
                      className={cn("size-4 shrink-0", task.status === "done" ? "text-emerald-500" : "text-muted-foreground")}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{task.title}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {task.projectName}
                        {task.goal ? ` · ${task.goal}` : ""}
                      </div>
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {total ? `${done}/${total}` : ""}
                      {` · ${task.threads.length} thread${task.threads.length === 1 ? "" : "s"}`}
                      {task.docs.length ? ` · ${task.docs.length} doc${task.docs.length === 1 ? "" : "s"}` : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {data.more ? (
        <Button variant="outline" size="sm" onClick={() => setLimit(limit + DONE_PAGE)}>
          Show more
        </Button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ docs

function DocsLibrary() {
  const rpc = useBrief();
  const navigate = useBbNavigate();
  const load = useCallback(() => rpc.call("docs_list").then((r) => r.docs), [rpc]);
  const { data, error } = useLive(load);
  const [kind, setKind] = useState<string | null>(null);
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <EmptyState>Loading…</EmptyState>;
  if (data.length === 0) return <EmptyState>No documents yet. Agents publish plans and reports here.</EmptyState>;
  const kinds = [...new Set(data.map((d) => d.kind))];
  const visible = data.filter((d) => kind === null || d.kind === kind);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {[null, ...kinds].map((k) => (
          <Button key={k ?? "all"} size="sm" variant={kind === k ? "default" : "outline"} className="h-7 text-xs" onClick={() => setKind(k)}>
            {k ?? "All"}
          </Button>
        ))}
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {visible.map((doc) => (
          <li key={doc.id}>
            <button
              type="button"
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted"
              onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: `doc/${doc.id}` })}
            >
              <Icon name="FileText" className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{doc.title}</div>
                <div className="truncate text-xs text-muted-foreground">{doc.taskTitle}</div>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {doc.kind} · v{doc.versions} · {ago(doc.updatedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DocView({ docId }: { docId: string }) {
  const rpc = useBrief();
  const navigate = useBbNavigate();
  const [version, setVersion] = useState<number | null>(null);
  const load = useCallback(() => rpc.call("doc_get", { docId, version }), [rpc, docId, version]);
  const { data, error } = useLive(load);
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <EmptyState>Loading…</EmptyState>;
  const { doc } = data;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-base font-medium">{doc.title}</h2>
        <select
          className="h-7 rounded-md border border-border bg-background px-2 text-xs"
          value={data.version.version}
          onChange={(event) => setVersion(Number(event.target.value))}
          aria-label="Version"
        >
          {Array.from({ length: doc.versions }, (_, i) => doc.versions - i).map((v) => (
            <option key={v} value={v}>
              v{v}
              {v === doc.versions ? " (latest)" : ""}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: `task/${doc.taskId}` })}
        >
          Open task
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {doc.taskTitle} · {doc.kind} · {doc.path} · saved {ago(data.version.savedAt)}
      </p>
      <div className="rounded-lg border border-border bg-card p-4">
        <Markdown content={data.version.content} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ page

const TABS = [
  { id: "tasks", label: "Tasks", subPath: "" },
  { id: "done", label: "Done so far", subPath: "done" },
  { id: "docs", label: "Docs", subPath: "docs" },
] as const;

function BriefPage({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const [section, id] = subPath.split("/");
  const tab = section === "done" ? "done" : section === "docs" || section === "doc" ? "docs" : "tasks";
  const content =
    section === "task" && id ? (
      <TaskPage taskId={id} />
    ) : section === "doc" && id ? (
      <DocView docId={id} />
    ) : tab === "done" ? (
      <DoneSoFar />
    ) : tab === "docs" ? (
      <DocsLibrary />
    ) : (
      <TasksView />
    );
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-5xl space-y-4 p-4 md:p-5">
        <div className="flex gap-1.5">
          {TABS.map((t) => (
            <Button
              key={t.id}
              size="sm"
              variant={tab === t.id ? "default" : "ghost"}
              className="h-7 text-xs"
              onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: t.subPath })}
            >
              {t.label}
            </Button>
          ))}
        </div>
        {content}
      </div>
    </div>
  );
}

// ------------------------------------------------------- thread surfaces

function useThreadTasks(threadId: string) {
  const rpc = useBrief();
  const load = useCallback(() => rpc.call("thread_tasks", { threadId }), [rpc, threadId]);
  return useLive(load);
}

function JoinPicker({ threadId, tasks }: { threadId: string; tasks: Task[] }) {
  const rpc = useBrief();
  if (tasks.length === 0) return null;
  return (
    <section>
      <SectionTitle>Join a task</SectionTitle>
      <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
        {tasks.map((task) => {
          const { done, total } = progress(task);
          return (
            <li key={task.id} className="flex items-center gap-2 px-2 py-1.5 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate">{task.title}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {task.projectName}
                  {total ? ` · ${done}/${total}` : ""} · {activeThreads(task).length} thread{activeThreads(task).length === 1 ? "" : "s"}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 shrink-0 text-xs"
                onClick={() =>
                  void rpc.call("thread_join", { threadId, taskId: task.id }).catch((cause: unknown) => toast.error(String(cause)))
                }
              >
                Join
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ThreadBriefPanel({ threadId }: { threadId: string }) {
  const rpc = useBrief();
  const { data, error } = useThreadTasks(threadId);
  const navigate = useBbNavigate();
  const [openId, setOpenId] = useState<string | null>(null);
  useTick();
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return <EmptyState>Loading…</EmptyState>;
  const { current, earlier } = data;
  const own = current?.threads.find((t) => t.threadId === threadId);
  return (
    <div className="space-y-6">
      {current ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-base font-medium hover:underline"
              onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: `task/${current.id}` })}
            >
              {current.title}
            </button>
            <StatusBadge task={current} />
            {own?.role === "helper" ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 text-xs text-muted-foreground"
                onClick={() => void rpc.call("thread_leave", { threadId }).catch((cause: unknown) => toast.error(String(cause)))}
              >
                Leave task
              </Button>
            ) : null}
          </div>
          <TaskBody task={current} highlightItemId={own?.itemId ?? null} />
        </div>
      ) : (
        <div className="space-y-3">
          <EmptyState>This thread is on no task. The agent starts one when it plans multi-step work, or join one below.</EmptyState>
          <JoinPicker threadId={threadId} tasks={data.joinable} />
        </div>
      )}
      {earlier.length ? (
        <section>
          <SectionTitle>Earlier tasks · {earlier.length}</SectionTitle>
          <ul className="space-y-1">
            {earlier.map((task) => {
              const { done, total } = progress(task);
              const open = openId === task.id;
              return (
                <li key={task.id} className="rounded-md border border-border">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => setOpenId(open ? null : task.id)}
                  >
                    <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{task.title}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {total ? `${done}/${total}` : ""} · {ago(task.finishedAt ?? task.updatedAt)}
                    </span>
                  </button>
                  {open ? (
                    <div className="border-t border-border p-2">
                      <PlanTree task={task} items={task.plan} />
                      {task.docs.length ? (
                        <div className="mt-2">
                          <DocList docs={task.docs} />
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function HeaderPill({ threadId }: { threadId: string }) {
  const { data } = useThreadTasks(threadId);
  const navigate = useBbNavigate();
  const task = data?.current;
  if (!task) return null;
  const { done, total } = progress(task);
  const waiting = needsYou(task).length > 0;
  return (
    <button
      type="button"
      className={cn("flex h-7 items-center gap-1.5 rounded-md px-2 text-xs hover:bg-muted", waiting ? "text-destructive" : "text-muted-foreground")}
      aria-label={`Task ${task.title}: ${done} of ${total} done${waiting ? ", needs you" : ""}`}
      title={task.title}
      onClick={() => navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title: "Brief" })}
    >
      <Icon name={waiting ? "Hand" : "ListTodo"} className="size-4" />
      {total > 0 ? (
        <span className="tabular-nums">
          {done}/{total}
        </span>
      ) : null}
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Brief",
    icon: "LayoutDashboard",
    path: PANEL_PATH,
    component: BriefPage,
  });
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Brief",
    component: ThreadBriefPanel,
  });
  app.slots.experimental_threadHeaderAction({
    id: "brief-pill",
    title: "Brief",
    component: HeaderPill,
  });
});
