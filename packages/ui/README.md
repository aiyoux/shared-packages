# Operation Feedback Pipeline

This repository now has a shared operation-feedback pipeline for user-triggered actions.

It exists to solve a specific problem:

- runtime/system faults and user operations are different kinds of feedback
- ad hoc inline strings do not scale across modules
- future agents need a reusable pattern instead of inventing one-off banners

## Two Feedback Lanes

Keep these concepts separate.

- `RuntimeNotice`
  - For infrastructure, auth, SDK, sync, and system-level warnings or errors.
  - Existing app-local store lives in [runtime-notices.svelte.ts](../../../app-build/src/lib/state/runtime-notices.svelte.ts).
- `OperationRecord`
  - For user-triggered actions such as create, move, edit, delete, queue, run, complete, fail, or cancel.
  - Shared store lives in [operation-feed.svelte.ts](src/operation-feed.svelte.ts).

The shell activity center intentionally shows both, but as separate sections.

## Shared Data Model

`OperationRecord` is the normalized payload every module should emit:

- `source`
  - Owning module or subsystem, such as `planner`.
- `scope`
  - Domain-level grouping used for global filters, such as `planner`, `calendar`, or `files`.
- `kind`
  - Stable action identifier. Prefer machine-friendly values like `planner.create` instead of display copy.
- `title`
  - Short user-facing summary of the action.
- `message`
  - Optional secondary text.
- `detail`
  - Optional deeper context.
- `status`
  - One of `queued`, `running`, `succeeded`, `failed`, or `canceled`.
- `surfaces`
  - Where it should render. Current values are `activity-center` and `inline`.
- `context`
  - Local surface grouping for inline feeds. Example: `planner-page`.
- `subjectIds`
  - Optional affected entities.
- `dedupeKey`
  - Optional coalescing key when repeated operations should collapse into one row with an incrementing count.

## Store API

Import from `@modular@shared-packages/ui`.

```ts
import {
  createOperation,
  pushOperation,
  updateOperation,
  completeOperation,
  failOperation,
  getOperations
} from '@modular@shared-packages/ui';
```

Use the APIs this way:

- `pushOperation(...)`
  - Best for one-shot events where the final status is already known.
- `createOperation(...)`
  - Best for lifecycle-aware work. Defaults to `queued`.
- `updateOperation(id, ...)`
  - Use when progress or metadata changes.
- `completeOperation(id, ...)`
  - Mark an active operation as `succeeded`.
- `failOperation(id, ...)`
  - Mark an active operation as `failed`.
- `getOperations(...)`
  - Read filtered slices for global or inline UI.

## UI Building Blocks

Shared renderers live in `@modular@shared-packages/ui`.

- [OperationFeedList.svelte](src/OperationFeedList.svelte)
  - Reusable list renderer for both panel and inline surfaces.
- [OperationStatusBadge.svelte](src/OperationStatusBadge.svelte)
  - Small status chip used by feed rows.

Use them like this:

```svelte
<script lang="ts">
  import { OperationFeedList, getOperations } from '@modular@shared-packages/ui';

  const plannerInlineOperations = $derived(
    getOperations({
      scope: 'planner',
      context: 'planner-page',
      surface: 'inline',
      limit: 4
    })
  );
</script>

<OperationFeedList
  operations={plannerInlineOperations}
  variant="inline"
  emptyMessage="Planner updates will appear here."
/>
```

## Current Integration

The first full consumer is the planner.

- Inline planner feedback now comes from the shared operation feed instead of module-local success and error strings.
- The shell activity center in [+layout.svelte](../../../app-build/src/routes/+layout.svelte) shows:
  - structured operations with stage and scope filters
  - runtime issues in a separate section

This gives future modules one place to plug into without rethinking the pattern.

## Guidance For Future Agents

When adding new action feedback, follow these rules.

- Do not create new local `message` and `error` banner pairs unless the feature has a genuinely unique requirement.
- Prefer a stable `kind` value and keep display copy in `title` and `message`.
- Use `scope` for cross-app filtering. Use `context` only for local inline feeds.
- Emit to both `activity-center` and `inline` when the action matters globally and locally.
- Keep runtime/system failures in `RuntimeNotice`, not in `OperationRecord`.
- If a workflow has real async lifecycle hooks, create the operation once and update it through `queued` or `running` to `succeeded` or `failed`.

## Current Limitation

Planner mutations currently resolve as local terminal operation rows immediately after the optimistic action is accepted by the UI layer.

That means:

- the pipeline supports lifecycle states
- the planner integration does not yet subscribe to sync-engine acceptance or rejection events

When a module has reliable backend completion signals, it should switch from `pushOperation(...)` to `createOperation(...)` plus later `completeOperation(...)` or `failOperation(...)`.
