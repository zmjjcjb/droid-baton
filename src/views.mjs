// Compact projections of a run for the supervisor (Codex).
//
// A raw run carries everything Droid ever did: `work.tools` keeps up to 100 tool
// calls with their full inputs, and `recent_events` keeps the last 30 events with
// their full payloads. Serialised, that is >200 KB per status call. A supervisor
// polls that run dozens of times, so the same bytes are paid for again and again.
//
// The views below cut the payload down to what a supervisor actually acts on:
// progress counters, the last few events as one-line digests, and outstanding work.
// The full record stays on disk (events/<run_id>.jsonl) and stays reachable through
// `detail: 'full'` or `droid_read_session`.

// The digests here follow the upstream dsh-baton shape: the newest item is shown
// in full, older ones collapse to one line. A supervisor reads the latest state
// carefully and the history only to detect a change of direction.

export const LIMITS = {
  // Tool calls kept in `work.tools` projection. Older ones are dropped; the
  // count of dropped ones is reported so nothing silently disappears.
  tools: 8,
  // Tool input characters kept per call. Enough to see the command that ran.
  toolInput: 400,
  // Recent events kept in the projection.
  events: 12,
  // Characters kept per event field.
  eventText: 600,
  // Characters kept from the delegated task message and Droid's final report.
  message: 800,
  finalText: 2000,
  // Characters kept per steer message.
  steer: 300,
  // Characters kept from a pending question or permission option.
  question: 600,
}

const clip = (text, max) => {
  if (typeof text !== 'string') return text ?? null
  return text.length > max ? `${text.slice(0, max)}…[截断]` : text
}
const oneLine = (text, max) => clip(String(text ?? '').replace(/\s+/g, ' ').trim(), max)

/**
 * The events a supervisor needs to see: what happened, not what it looked like.
 *
 * `since_seq` returns only the events newer than that sequence number, which is
 * how an incremental poll avoids re-reading events it has already seen. The
 * broker assigns a monotonic `seq` to every event, so a caller can pass the
 * last seq it saw and get the delta only.
 */
export function projectEvents(events = [], { since_seq = -1, limit = LIMITS.events } = {}) {
  const all = Array.isArray(events) ? events : []
  const fresh = since_seq >= 0 ? all.filter(e => (e.seq ?? 0) > since_seq) : all
  const kept = fresh.slice(-limit)
  const dropped = fresh.length - kept.length
  return {
    events: kept.map(e => ({
      seq: e.seq,
      time: e.time,
      type: e.type,
      ...(e.name ? { name: e.name } : {}),
      ...(e.input ? { input: oneLine(e.input, LIMITS.eventText) } : {}),
      ...(e.text ? { text: oneLine(e.text, LIMITS.eventText) } : {}),
      ...(e.detail ? { detail: oneLine(e.detail, LIMITS.eventText) } : {}),
      ...(e.error ? { error: oneLine(e.error, LIMITS.eventText) } : {}),
    })),
    ...(dropped ? { events_not_shown: dropped } : {}),
    last_seq: all.length ? (all[all.length - 1].seq ?? 0) : 0,
  }
}

/**
 * Outstanding work, as counts plus the entries that are still running.
 *
 * The raw `work.jobs` and `work.workers` maps also carry the tool input and the
 * full command text of every finished job; a supervisor only needs to know that
 * something is still running and which PID to look at.
 */
export function projectWork(work = {}) {
  const jobs = Object.values(work?.jobs || {})
  const workers = Object.values(work?.workers || {})
  const tools = Object.values(work?.tools || {})
  const done = ['completed', 'failed', 'cancelled', 'exited', 'done', 'success', 'error', 'stopped']
  const running = jobs.filter(j => !done.includes(j.status))
  const runningWorkers = workers.filter(w => !done.includes(w.status))
  const recentTools = tools.slice(-LIMITS.tools).map(t => ({
    name: t.name,
    status: t.ended_at ? (t.is_error ? 'failed' : 'completed') : 'running',
    ...(t.started_at ? { started_at: t.started_at } : {}),
    ...(t.input && Object.keys(t.input).length ? { input: oneLine(JSON.stringify(t.input), LIMITS.toolInput) } : {}),
  }))
  return {
    active: running.length > 0 || runningWorkers.length > 0,
    running_jobs: running.slice(0, LIMITS.tools).map(j => ({ id: j.id, source: j.source, status: j.status, ...(j.pid ? { pid: j.pid } : {}) })),
    running_workers: runningWorkers.slice(0, LIMITS.tools).map(w => ({ id: w.id, status: w.status, source: w.source })),
    recent_tools: recentTools,
    counts: { tools: tools.length, jobs: jobs.length, workers: workers.length },
    ...(tools.length > recentTools.length ? { tools_not_shown: tools.length - recentTools.length } : {}),
  }
}

/**
 * The compact supervisor view of one run.
 *
 * This is what `droid_status` and `droid_wait` return by default. It carries the
 * state, the counters, the outstanding work and the recent events as digests —
 * enough to decide whether to keep waiting, steer the run, or accept it — without
 * re-sending Droid's whole transcript on every poll.
 */
export function projectRun(run, { since_seq = -1, detail = 'summary' } = {}) {
  if (detail === 'full') return run
  const events = projectEvents(run?.recent_events || [], { since_seq })
  const work = projectWork(run?.work || {})
  return {
    run_id: run?.run_id,
    session_id: run?.session_id,
    state: run?.state,
    cwd: run?.cwd,
    ...(run?.model ? { model: run.model } : {}),
    ...(run?.error ? { error: run.error } : {}),
    ...(run?.created_at ? { created_at: run.created_at } : {}),
    ...(run?.started_at ? { started_at: run.started_at } : {}),
    ...(run?.ended_at ? { ended_at: run.ended_at } : {}),
    ...(run?.revision !== undefined ? { revision: run.revision } : {}),
    ...(run?.event_seq !== undefined ? { event_seq: run.event_seq } : {}),
    // The supervisor already knows what it asked for; the delegated message is
    // returned only as a short prefix so the run stays identifiable.
    ...(run?.message ? { message_preview: oneLine(run.message, LIMITS.message) } : {}),
    ...(run?.final_text ? { final_text: clip(run.final_text, LIMITS.finalText) } : {}),
    ...(run?.partial_text ? { partial_text: clip(run.partial_text, LIMITS.finalText) } : {}),
    ...(run?.attention ? { attention: { ...run.attention, message: oneLine(run.attention.message, LIMITS.eventText) } } : {}),
    ...(run?.pending ? { pending: projectPending(run.pending) } : {}),
    ...(run?.supervisor ? { supervisor: { round: run.supervisor.round, repairs: run.supervisor.repairs, total_tokens: run.supervisor.total_tokens, ...(run.supervisor.current_kind ? { current_kind: run.supervisor.current_kind } : {}) } } : {}),
    ...(run?.checks?.length ? { checks: run.checks } : {}),
    ...(run?.supervision ? { supervision: { interval_s: run.supervision.interval_s, stall_s: run.supervision.stall_s, max_rounds: run.supervision.max_rounds, max_repairs: run.supervision.max_repairs } } : {}),
    ...(run?.activity ? { activity: { tool_calls: run.activity.tool_calls, tool_results: run.activity.tool_results, progress_events: run.activity.progress_events, ...(run.activity.repeated ? { repeated: run.activity.repeated } : {}), ...(run.activity.last_tool ? { last_tool: run.activity.last_tool } : {}) } } : {}),
    ...(run?.usage ? { usage: run.usage } : {}),
    ...(run?.steers?.length ? { steers: run.steers.map(s => ({ time: s.time, sender: s.sender, message: oneLine(s.message, LIMITS.steer) })) } : {}),
    ...(run?.checkpoint ? { checkpoint: projectCheckpoint(run.checkpoint) } : {}),
    outstanding_work: work,
    events: events.events,
    last_seq: events.last_seq,
    ...(events.events_not_shown ? { events_not_shown: events.events_not_shown } : {}),
    ...(run?.evidence ? { evidence: projectEvidence(run.evidence) } : {}),
    ...(run?.acceptance ? { acceptance: run.acceptance } : {}),
  }
}

/** The pending question or permission request, trimmed to what a supervisor must answer. */
export function projectPending(pending) {
  if (!pending) return null
  return {
    request_id: pending.request_id,
    kind: pending.kind,
    ...(pending.questions ? { questions: pending.questions.map(q => ({ index: q.index, question: clip(q.question, LIMITS.question) })) } : {}),
    ...(pending.options ? { options: pending.options.map(o => ({ value: o.value, label: oneLine(o.label ?? o.description ?? o.value, 200) })) } : {}),
    ...(pending.rows ? { rows: pending.rows.map(r => ({ id: r.id, label: oneLine(r.label ?? r.title ?? r.id, 200) })) } : {}),
  }
}

/** The structured goal report a supervised round produced. */
export function projectCheckpoint(checkpoint) {
  if (!checkpoint) return null
  return {
    status: checkpoint.status,
    summary: clip(checkpoint.summary, LIMITS.finalText),
    ...(checkpoint.remaining?.length ? { remaining: checkpoint.remaining.map(x => oneLine(x, 300)) } : {}),
  }
}

/**
 * The independent-check evidence.
 *
 * The changed-file list is kept (the supervisor needs to know what was touched),
 * but per-check output is trimmed to its tail: the exit code and the last lines
 * are what a reviewer reads.
 */
export function projectEvidence(evidence) {
  if (!evidence) return null
  return {
    all_checks_passed: evidence.all_checks_passed,
    ...(evidence.checks ? { checks: evidence.checks.map(c => ({ name: c.name ?? c.command, exit_code: c.exit_code, ok: c.ok, ...(c.output_tail ? { output_tail: clip(c.output_tail, 600) } : {}) })) } : {}),
    ...(evidence.changes ? { changes: evidence.changes } : {}),
    ...(evidence.evidence_sha256 ? { evidence_sha256: evidence.evidence_sha256 } : {}),
    ...(evidence.workspace_stamp ? { workspace_stamp: evidence.workspace_stamp } : {}),
  }
}
