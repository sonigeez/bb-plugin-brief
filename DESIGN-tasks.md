# Brief v2: tasks, not threads

## The shift

v1 has one brief per thread. v2 makes the **task** the main object, and
threads are the workers on a task.

- One task can have many threads: the lead thread and the helpers it spawns.
- One thread can have many tasks over time, one at a time.

## Data model

```
Task
  id, title (short), goal (1-2 sentences), projectId
  status        open | done | dropped
  ownerThreadId the thread that started it
  plan          nested checklist (below)
  createdAt, finishedAt

PlanItem
  id            position path: 2, 2.1, 2.1.3
  text, status  todo | doing | done | blocked | skipped
  note
  threadIds     helper threads working on this item
  children      PlanItem[]  (up to 4 levels)

TaskThread      one row per thread on a task
  taskId, threadId, role (owner | helper), itemId (claimed item, optional)
  now           one-line status for this thread
  needsYou      what this thread waits on, cleared when you reply to it
  joinedAt, leftAt

Doc
  id, taskId, publishedBy (threadId), title, kind, path
  versions      DocVersion[] (full copy of the markdown each time)

Event           the activity feed
  taskId, threadId, at, text
```

**Needs you** and **progress** are always computed and never stored: a task
needs you if any of its threads has `needsYou` set or has failed, and its
progress counts the done and skipped leaf items across the whole plan.

## How threads join a task

1. **Start**: a thread with no task calls `brief_plan` with a `title`, and a
   task is created with that thread as owner.
2. **Spawn**: when a thread on a task spawns a child thread, the child joins
   the same task as a helper automatically, through bb's parent link on
   `thread.created`. Nothing is needed in the prompt.
3. **Claim**: the helper calls `brief_claim { item: "2.1" }`. Its dot shows
   on that item, and from then on its `brief_plan` call writes the sub-items
   under 2.1 instead of replacing the whole plan.
4. **Switch**: the owner calls `brief_plan { new_task: true, title, ... }`.
   The current task closes (done if every item is done, otherwise dropped
   with its progress recorded), and a new task starts. Helpers stay on the
   old task.
5. **Finish**: a task becomes done when its last item is done, and
   `finishedAt` is set then. Reopening any item clears it again.

## Agent tools

| Tool | Owner thread | Helper thread |
| --- | --- | --- |
| `brief_plan { title?, goal?, items, new_task? }` | sets the whole plan | sets the sub-items under its claimed item |
| `brief_item { updates }` | any item on the task | any item on the task |
| `brief_claim { item }` | | attaches itself to an item |
| `brief_status { now?, needs_you? }` | its own line | its own line |
| `brief_doc { path, title, kind }` | attaches to the task | attaches to the task |

## Views

**Tasks** (default). Lanes: Needs you · In progress · Done today.

```
+--------------------------------------------------------------+
| Brief plugin v2                        my-app            12m |
| Make the board task-centric                                  |
| ######........  6/14                                         |
| Now: 2.1 Board UI            (green) lead (green) ui (grey) srv |
| ! ui: Approve the card layout                                |
+--------------------------------------------------------------+
```

Clicking a card opens it: the full checklist with thread dots on the items,
each thread's now line and needs-you flag, docs, and the activity feed.

**Done so far**: finished tasks grouped by day, newest first. Each row shows
the title, project, progress, the number of threads and the number of docs,
and expands to its checklist.

**Docs**: as in v1, plus the task each doc belongs to.

**Untracked**: a thin strip at the bottom listing running threads that are
on no task, so nothing is invisible.

**In a thread**: the side panel shows the thread's current task, with its
own claimed item highlighted, and earlier tasks of this thread collapsed
below. The header pill shows that task's progress.

## Storage

Move from kv to the plugin's own SQLite database
(`~/.bb/plugins/brief/data.db`), with tables `tasks`, `task_threads`,
`docs`, `doc_versions` and `events`. Reasons: the Done so far and project
filters need queries across tasks, several threads write to one task at
once, and the data no longer lives in bb's main database. The plan stays a
JSON column on `tasks`, and writes go through one transaction per tool call.

The v1 briefs (one so far) convert to tasks on first load.

## Not in v2

Search, export to `docs/`, an outcome summary on finish, editing items from
the UI beyond ticking them, and cross-project tasks.
