See every task your agents are working on, its plan, which threads are on
it, and what it needs from you, on one board.

## What you get

- A **Brief** page in the sidebar with three tabs:
  - **Tasks**: lanes for Needs you, In progress, and Done today. Each card
    shows the task, its progress across all its threads, and a live dot for
    every thread working on it. Running threads that are on no task show in
    an Untracked strip.
  - **Done so far**: finished tasks grouped by day.
  - **Docs**: every plan, design note, findings doc, and report agents
    publish, with every version kept.
- A task page with the goal, the nested checklist (with the threads working
  on each item), each thread's status, the docs, and the activity feed.
- **Comments** in the activity feed. Agents comment on decisions, findings,
  dead ends, and questions, and you can comment from the task page. Your
  comment is also sent to the task's owner thread, queued behind any running
  turn. A comment can be about one checklist item, and that item then shows
  its comment count.
- A **Brief** tab in the thread side panel showing the thread's current task
  and its earlier ones, and a progress pill in the thread header.

## How tasks and threads fit

A thread starts a task when it plans multi-step work. Threads it spawns join
that task automatically and can claim a checklist item, filling in that
item's sub-steps. A thread you start yourself can join an open task too:
ask it to work on the task by name, or pick the task under **Join a task**
in the thread's Brief panel. A thread that moves on to unrelated work starts a new task,
and the old one is kept in Done so far.

## For agents

`brief_plan` (start a task or set its plan; `new_task` to switch),
`brief_item` (tick items), `brief_claim` (a helper takes an item), `brief_join` (join an open task by
name),
`brief_comment` (add a comment to the activity feed), `brief_status` (the now line and the needs-you flag, which clears itself when
you reply), and `brief_doc` (publish a markdown file).

## How it works

Everything is stored in this plugin's own SQLite database on the bb server,
`~/.bb/plugins/brief/data.db`. Nothing leaves the machine.

## Install

```
bb plugin install https://github.com/sonigeez/bb-plugin-brief
```

## Develop

```
npm install
npm test             # backend tests with the bb plugin SDK test host
npm run typecheck
bb plugin install .  # install from this checkout
bb plugin build && bb plugin reload brief
```

Design notes: [DESIGN-tasks.md](DESIGN-tasks.md).
