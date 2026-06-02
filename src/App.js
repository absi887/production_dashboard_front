
import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import {
  Play, Pause, Square, Trash2, Plus, Zap, LayoutDashboard,
  Settings, FileText, Clock, AlertCircle, Info, Download, ChevronUp, ChevronDown,
  FileSpreadsheet, FileDown, Calendar
} from 'lucide-react';
import './App.css';
import ProductionTimelineAdvisor from './ProductionTimelineAdvisor';

const SERVER_URL = process.env.REACT_APP_API_URL || 'http://localhost:5002';
const FACTORY_LANES = ['door', 'frame', 'arch'];

/** Server (Railway) timestamps are UTC but often omit Z — always parse as UTC. */
const parseServerIso = (iso) => {
  if (iso == null || iso === '') return NaN;
  const s = String(iso).trim();
  if (!s) return NaN;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? NaN : t;
  }
  const t = Date.parse(`${s}Z`);
  return Number.isNaN(t) ? NaN : t;
};

const renderStatusBadge = (status) => {
  const classes = {
    RUNNING: 'badge-running',
    STOPPED: 'badge-stopped',
    PAUSED: 'badge-paused',
    FINISHED: 'badge-finished',
    'IN PROGRESS': 'badge-running',
    QUEUED: 'badge-queued',
    READY: 'badge-running'
  };
  return <span className={`badge ${classes[status] || 'badge-queued'}`}>{status}</span>;
};

const formatMsClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
};

const formatShortTime = (iso) => {
  if (!iso) return null;
  try {
    const t = parseServerIso(iso);
    if (!Number.isFinite(t)) return null;
    return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return null;
  }
};

const laneQueueOrderId = (item) => {
  if (item && typeof item === 'object') return String(item.order_id || '');
  return String(item || '');
};

const laneQueueFirstMachine = (item) => {
  if (item && typeof item === 'object' && item.first_machine) return item.first_machine;
  return null;
};

const formatMins = (mins) => {
  const m = Math.max(0, Math.round(Number(mins) || 0));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r > 0 ? `${h}h ${r}m` : `${h}h`;
};

/** Sub-minute friendly label for paused / short stages (avoids "0 min"). */
const formatElapsedMins = (mins) => {
  const n = Math.max(0, Number(mins) || 0);
  if (n < 1) {
    const sec = Math.max(1, Math.round(n * 60));
    return `${sec} sec`;
  }
  return formatMins(n);
};

const phaseStatusLabel = (phaseStatus, isCompleted, isActive, isPaused) => {
  if (phaseStatus === 'paused' || isPaused) return 'Paused';
  if (phaseStatus === 'completed' || isCompleted) return 'Done';
  if (phaseStatus === 'active' || isActive) return 'In progress';
  if (phaseStatus === 'ready') return 'Ready';
  return 'Up next';
};

const formatNextJobStartMessage = (waitMins) => {
  const w = Number(waitMins);
  if (!Number.isFinite(w) || w <= 0) {
    return { headline: 'Starting now', detail: 'This job will begin automatically at this machine.' };
  }
  if (w <= 1) {
    return { headline: 'Starting in less than 1 min', detail: 'Auto-start is queued — get ready at this machine.' };
  }
  return {
    headline: `Auto-starts in ~${formatMins(w)}`,
    detail: 'Will begin here automatically when the current job clears this stage.',
  };
};

/** All parallel jobs running on a lane (lead job is separate). */
const lineParallelJobs = (state) => {
  if (Array.isArray(state?.parallel_jobs) && state.parallel_jobs.length > 0) {
    return state.parallel_jobs;
  }
  return state?.stage0_job ? [state.stage0_job] : [];
};

/** True when the lane can auto-start the next job at Scale Saw now (parallel). */
const laneStage0SlotOpen = (state) => {
  if (!state?.order_id) return false;
  const parallel = lineParallelJobs(state);
  if (parallel.some((p) => Number(p.current_machine_index ?? 0) === 0)) return false;
  const leadIdx = Number(state.current_machine_index ?? 0);
  const st = String(state.status || '').toUpperCase();
  if (st === 'STOPPED') return false;
  if (leadIdx <= 0 && (st === 'RUNNING' || st === 'PAUSED' || st === 'READY')) return false;
  return st === 'RUNNING' || st === 'PAUSED';
};

const effectiveQueueWaitMins = (state, queueIndex, itemWait) => {
  if (queueIndex === 0 && laneStage0SlotOpen(state)) return 0;
  const w = Number(itemWait);
  if (Number.isFinite(w)) return w;
  return null;
};

/** Lane queue rows — excludes jobs already running as lead or parallel stage-0. */
const collectLaneUpcomingJobs = (state, jobQueue, line, configMachines) => {
  const ln = String(line).toLowerCase();
  const runningHere = new Set(
    [state?.order_id, ...lineParallelJobs(state).map((p) => p.order_id)]
      .filter(Boolean)
      .map((x) => String(x))
  );
  const upcoming = [];
  const seen = new Set();
  const push = (entry) => {
    const oid = laneQueueOrderId(entry);
    if (!oid || seen.has(oid) || runningHere.has(oid)) return;
    seen.add(oid);
    upcoming.push(entry);
  };
  (Array.isArray(state?.lane_queue) ? state.lane_queue : []).forEach(push);
  (jobQueue || []).forEach((job) => {
    const oid = String(job?.order_id || '');
    if (!oid || seen.has(oid) || runningHere.has(oid)) return;
    const ql = (job?.queued_lanes || []).map((x) => String(x).toLowerCase());
    if (!ql.includes(ln)) return;
    const st = String(job?.status || '').toUpperCase();
    const active = (job?.active_lines || []).map((x) => String(x).toLowerCase());
    if (st === 'RUNNING' && active.includes(ln)) return;
    const firstMachine = configMachines?.[0]?.[0] || null;
    push({
      order_id: oid,
      first_machine: firstMachine,
      status: 'STAGED',
    });
  });
  return upcoming.map((item, idx) => ({
    ...item,
    est_wait_mins: effectiveQueueWaitMins(state, idx, item.est_wait_mins),
  }));
};

const PRODUCTION_TABLE_STATUS_RANK = {
  RUNNING: 5,
  PAUSED: 4,
  READY: 3,
  QUEUED: 2,
  FINISHED: 1,
  CANCELLED: 0,
};

/** Per-lane chip state for the unified production table. */
const laneStatusForOrder = (line, orderId, productionState, completions) => {
  const oid = String(orderId || '');
  const ln = String(line).toLowerCase();
  const floor = productionState[ln];
  if (floor && String(floor.order_id || '') === oid) {
    return String(floor.status || 'RUNNING').toUpperCase();
  }
  const done = (completions || []).find(
    (c) => String(c.order_id) === oid && String(c.line).toLowerCase() === ln
  );
  if (done) return 'FINISHED';
  return 'IDLE';
};

/** Single display status — FINISHED only when all three lanes show Done. */
const deriveJobDisplayStatus = (job, productionState, completions) => {
  const base = String(job?.status || 'QUEUED').toUpperCase();
  const laneStates = FACTORY_LANES.map((ln) =>
    laneStatusForOrder(ln, job?.order_id, productionState, completions)
  );
  if (base === 'CANCELLED') return 'CANCELLED';
  if (laneStates.every((s) => s === 'FINISHED')) return 'FINISHED';
  if (laneStates.some((s) => s === 'PAUSED')) return 'PAUSED';
  if (laneStates.some((s) => s === 'RUNNING')) return 'RUNNING';
  if (laneStates.some((s) => s === 'READY')) return 'READY';
  if (laneStates.some((s) => s === 'FINISHED')) return 'IN PROGRESS';
  if (base === 'FINISHED') return 'IN PROGRESS';
  return base || 'QUEUED';
};

/** One row per job: queue + lane completions merged; status is the live field. */
const buildUnifiedProductionRows = (jobQueue, laneCompletions, productionState) => {
  const byOrder = new Map();

  (jobQueue || []).forEach((job) => {
    const oid = String(job.order_id || '');
    if (!oid) return;
    byOrder.set(oid, {
      order_id: oid,
      quantity: job.quantity,
      quantity_done: job.quantity_done,
      imported_at: job.imported_at,
      job,
      completions: [],
    });
  });

  (laneCompletions || []).forEach((c) => {
    const oid = String(c.order_id || '');
    if (!oid) return;
    if (!byOrder.has(oid)) {
      byOrder.set(oid, {
        order_id: oid,
        quantity: c.quantity,
        quantity_done: c.quantity_done,
        imported_at: null,
        job: null,
        completions: [],
      });
    }
    byOrder.get(oid).completions.push(c);
    const latest = c.finished_at;
    const row = byOrder.get(oid);
    if (latest && (!row.last_finished_at || latest > row.last_finished_at)) {
      row.last_finished_at = latest;
    }
  });

  const mergeRowQuantities = (row) => {
    let quantity = Number(row.quantity);
    let quantity_done = Number(row.quantity_done);
    if (row.job) {
      const jq = Number(row.job.quantity);
      const jd = Number(row.job.quantity_done);
      if (Number.isFinite(jq) && jq > 0) quantity = jq;
      if (Number.isFinite(jd)) quantity_done = Math.max(quantity_done || 0, jd);
    }
    (row.completions || []).forEach((c) => {
      const cq = Number(c.quantity);
      const cd = Number(c.quantity_done);
      if (Number.isFinite(cq) && cq > 0) {
        quantity = Number.isFinite(quantity) && quantity > 0 ? Math.max(quantity, cq) : cq;
      }
      if (Number.isFinite(cd)) quantity_done = Math.max(quantity_done || 0, cd);
    });
    if (!Number.isFinite(quantity) || quantity <= 0) quantity = 1;
    if (!Number.isFinite(quantity_done)) quantity_done = 0;
    return { ...row, quantity, quantity_done };
  };

  return Array.from(byOrder.values())
    .map((row) => {
      const status = deriveJobDisplayStatus(
        row.job || { order_id: row.order_id, status: 'QUEUED' },
        productionState,
        row.completions
      );
      const laneStates = Object.fromEntries(
        FACTORY_LANES.map((ln) => [
          ln,
          laneStatusForOrder(ln, row.order_id, productionState, row.completions),
        ])
      );
      const merged = mergeRowQuantities({ ...row, status, laneStates });
      if (merged.status === 'FINISHED' && merged.quantity_done < merged.quantity) {
        merged.quantity_done = merged.quantity;
      }
      return merged;
    })
    .sort((a, b) => {
      const ra = PRODUCTION_TABLE_STATUS_RANK[a.status] ?? 0;
      const rb = PRODUCTION_TABLE_STATUS_RANK[b.status] ?? 0;
      if (rb !== ra) return rb - ra;
      const ta = a.imported_at || a.last_finished_at || '';
      const tb = b.imported_at || b.last_finished_at || '';
      return tb.localeCompare(ta);
    });
};

const laneChipLabel = (laneState) => {
  switch (laneState) {
    case 'RUNNING':
      return 'Run';
    case 'PAUSED':
      return 'Pause';
    case 'READY':
      return 'Ready';
    case 'FINISHED':
      return 'Done';
    default:
      return '—';
  }
};

/** Distinct job IDs active or queued on one lane (lead + parallel + queue). */
const countJobsOnLane = (state, jobQueue, line, configMachines) => {
  const ids = new Set();
  if (state?.order_id) ids.add(String(state.order_id));
  lineParallelJobs(state).forEach((p) => {
    if (p?.order_id) ids.add(String(p.order_id));
  });
  collectLaneUpcomingJobs(state, jobQueue, line, configMachines).forEach((item) => {
    const oid = laneQueueOrderId(item);
    if (oid) ids.add(oid);
  });
  return ids.size;
};

const normalizeLineClientState = (prevLine, incoming, status) => {
  const base = { ...(prevLine || {}), ...(incoming || {}) };
  if (status != null) base.status = status;
  base.lane_queue = Array.isArray(incoming?.lane_queue) ? incoming.lane_queue : [];
  base.parallel_jobs = Array.isArray(incoming?.parallel_jobs) ? incoming.parallel_jobs : [];
  base.stage0_job = incoming?.stage0_job ?? null;
  // Server is authoritative for timing — drop stale client-only offsets when server sends line_timing
  if (incoming?.line_timing) {
    base.line_timing = incoming.line_timing;
    base.stage_elapsed_offset_mins = incoming.line_timing.stage_elapsed_offset_mins ?? 0;
    if (incoming.current_machine_index !== undefined) {
      base.current_machine_index = incoming.current_machine_index;
    }
    if (incoming.current_machine !== undefined) {
      base.current_machine = incoming.current_machine;
    }
    if (incoming.start_time !== undefined) {
      base.start_time = incoming.start_time;
    }
    if (incoming.stage_history !== undefined) {
      base.stage_history = incoming.stage_history;
    }
  }
  return base;
};

const mergeProductionStateFromServer = (prev, serverState, configMachines) => {
  const next = { ...prev };
  Object.entries(serverState || {}).forEach(([line, st]) => {
    if (!st || typeof st !== 'object') return;
    const machines = configMachines?.[line];
    next[line] = normalizeLineClientState(next[line], {
      ...st,
      all_machines: st.all_machines || machines?.map((m) => m[0]) || next[line]?.all_machines || [],
    }, st.status);
  });
  return next;
};

/** Stage duration from Settings machines list (matches backend _stage_expected_mins). */
const stageExpectedMinsFromConfig = (
  minsPerUnit,
  qty,
  stageIndex,
  stageCapMins = 8,
  efficiencyFactor = 1
) => {
  const mpu = Number(minsPerUnit);
  if (!Number.isFinite(mpu) || mpu <= 0) return 0;
  const eff = Number(efficiencyFactor) > 0 ? Number(efficiencyFactor) : 1;
  const raw = (mpu * Math.max(1, parseInt(qty, 10) || 1)) / eff;
  if (Number(stageIndex) === 0) {
    return Math.min(Number(stageCapMins) || 8, raw);
  }
  return raw;
};

const MachineStepper = ({
  machinesList,
  current,
  currentIndex: explicitIndex,
  quantity,
  status,
  startTime,
  stageElapsedOffsetMins,
  timingUpdatedAt,
  lineKey,
  phaseRows,
  laneNextMins,
  queuedJobs,
  parallelJobs: parallelJobsProp,
  stage0Job,
  stage0SlotOpen,
  stageCapMins = 8,
  efficiencyFactor = 1,
  autoAdvanceStages = true,
  onAdvanceStage,
  canAdvanceStage,
}) => {
  const machines = machinesList || [];
  const names = machines.map((m) => m[0]);
  const currentIndex =
    explicitIndex !== undefined && explicitIndex >= 0
      ? explicitIndex
      : names.indexOf(current);

  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  const parallelJobs =
    Array.isArray(parallelJobsProp) && parallelJobsProp.length > 0
      ? parallelJobsProp
      : stage0Job
        ? [stage0Job]
        : [];
  const parallelOccupying = parallelJobs.filter((p) => {
    const st = String(p.status || '').toUpperCase();
    return st === 'RUNNING' || st === 'PAUSED';
  });
  const activeParallel = parallelJobs.filter(
    (p) => String(p.status || '').toUpperCase() === 'RUNNING'
  );
  const hasParallelAtStage0 = parallelOccupying.some(
    (p) => Number(p.current_machine_index ?? 0) === 0
  );
  const [, setTick] = useState(0);

  const activeForTimer =
    currentIndex >= 0 && status === 'RUNNING' && Boolean(startTime);
  const anyParallelTimer = activeParallel.some((p) => Boolean(p.start_time));

  const pausedOffsetMinsRef = useRef(0);
  const prevStatusRef = useRef(status);
  const prevIndexRef = useRef(currentIndex);
  const stageAutoAdvanceKeyRef = useRef(null);

  // When we change stages, any paused offset from the old stage should not carry over.
  useEffect(() => {
    if (currentIndex !== prevIndexRef.current) {
      pausedOffsetMinsRef.current = 0;
      stageAutoAdvanceKeyRef.current = null;
      prevIndexRef.current = currentIndex;
    }
  }, [currentIndex]);

  // Fallback: if backend doesn't send stage_elapsed_offset_mins, remember the elapsed time when the lane is paused.
  useEffect(() => {
    const prev = prevStatusRef.current;
    if (prev !== status && status === 'PAUSED') {
      const phase = phaseRows && phaseRows[currentIndex];
      const elapsed = Number(phase?.elapsed_mins);
      if (Number.isFinite(elapsed)) pausedOffsetMinsRef.current = elapsed;
    }
    prevStatusRef.current = status;
  }, [status, currentIndex, phaseRows]);

  useEffect(() => {
    if (!activeForTimer && !anyParallelTimer) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [activeForTimer, anyParallelTimer, startTime, currentIndex, lineKey, current, parallelJobs]);

  const explicitOffsetMins =
    stageElapsedOffsetMins != null && Number.isFinite(Number(stageElapsedOffsetMins))
      ? Number(stageElapsedOffsetMins)
      : null;
  const offsetMinsForClock = explicitOffsetMins != null ? explicitOffsetMins : pausedOffsetMinsRef.current;
  const offsetMs = Math.max(0, offsetMinsForClock) * 60 * 1000;

  function stageElapsedMs() {
    const phase = phaseRows && phaseRows[currentIndex];
    const serverBaseMins = Number(phase?.elapsed_mins);
    const syncAt = parseServerIso(timingUpdatedAt);
    if (
      status === 'RUNNING' &&
      Number.isFinite(serverBaseMins) &&
      Number.isFinite(syncAt)
    ) {
      return Math.max(0, serverBaseMins * 60 * 1000 + Math.max(0, Date.now() - syncAt));
    }
    const t = parseServerIso(startTime);
    if (!Number.isFinite(t)) return offsetMs;
    return offsetMs + Math.max(0, Date.now() - t);
  }

  const elapsedMs = activeForTimer ? stageElapsedMs() : 0;

  useEffect(() => {
    if (!autoAdvanceStages || !canAdvanceStage || !onAdvanceStage || !activeForTimer) {
      return undefined;
    }
    if (currentIndex < 0 || !startTime) return undefined;
    const id = setInterval(() => {
      const phase = phaseRows && phaseRows[currentIndex];
      const mpu = machines[currentIndex] ? parseFloat(machines[currentIndex][1]) : NaN;
      const expMins =
        phase?.expected_mins != null && Number.isFinite(Number(phase.expected_mins))
          ? Number(phase.expected_mins)
          : stageExpectedMinsFromConfig(
              mpu,
              qty,
              currentIndex,
              stageCapMins,
              efficiencyFactor
            );
      const expMs = expMins * 60 * 1000;
      if (expMs <= 0) return;
      const elapsed = stageElapsedMs();
      if (elapsed < expMs) return;
      const key = `${lineKey}-${currentIndex}-${startTime}`;
      if (stageAutoAdvanceKeyRef.current === key) return;
      stageAutoAdvanceKeyRef.current = key;
      onAdvanceStage('primary');
    }, 1000);
    return () => clearInterval(id);
  }, [
    autoAdvanceStages,
    canAdvanceStage,
    onAdvanceStage,
    activeForTimer,
    currentIndex,
    startTime,
    lineKey,
    phaseRows,
    qty,
    stageCapMins,
    efficiencyFactor,
    machines,
    timingUpdatedAt,
    status,
    stageElapsedOffsetMins,
  ]);

  function parallelElapsedMs(pj) {
    const pStatus = String(pj?.status || '').toUpperCase();
    if (pStatus === 'PAUSED') {
      const off = Number(pj.stage_elapsed_offset_mins);
      if (Number.isFinite(off)) return Math.max(0, off * 60 * 1000);
    }
    if (!pj?.start_time) return 0;
    const t = parseServerIso(pj.start_time);
    if (!Number.isFinite(t)) return 0;
    return Math.max(0, Date.now() - t);
  }

  if (machines.length === 0) return null;

  const doneCount =
    currentIndex >= 0 ? Math.max(0, Math.min(machines.length, currentIndex)) : 0;

  const nextQueued =
    Array.isArray(queuedJobs) && queuedJobs.length > 0 ? queuedJobs[0] : null;
  const nextQueuedId = nextQueued ? laneQueueOrderId(nextQueued) : null;
  const nextQueuedMachine = nextQueued ? laneQueueFirstMachine(nextQueued) : null;
  const nextQueuedWait = nextQueued
    ? stage0SlotOpen
      ? 0
      : nextQueued.est_wait_mins != null && Number.isFinite(Number(nextQueued.est_wait_mins))
        ? Number(nextQueued.est_wait_mins)
        : null
    : null;
  const nextStartMsg = nextQueuedId ? formatNextJobStartMessage(nextQueuedWait) : null;
  const nextStartingSoon =
    nextQueuedWait == null || !Number.isFinite(Number(nextQueuedWait)) || Number(nextQueuedWait) <= 1;

  return (
    <div className="pipeline">
      <div className="pipeline-header">
        <span className="pipeline-title">
          Production stages
          {activeParallel.length > 0 && !nextQueuedId ? (
            <span className="pipeline-subtitle">
              {' '}
              · {activeParallel.length} parallel:{' '}
              <strong>{activeParallel.map((p) => p.order_id).join(', ')}</strong>
            </span>
          ) : nextQueuedId ? (
            <span className="pipeline-subtitle">
              {' '}
              · Next job: <strong>{nextQueuedId}</strong>
              {nextQueuedWait != null && Number.isFinite(Number(nextQueuedWait)) && Number(nextQueuedWait) <= 0
                ? ' · starting now'
                : nextQueuedWait != null && Number.isFinite(Number(nextQueuedWait))
                  ? ` · auto-starts in ${formatMins(nextQueuedWait)}`
                  : stage0SlotOpen
                    ? ' · starting now'
                    : ''}
            </span>
          ) : null}
        </span>
        <span className="pipeline-progress-pill">
          {doneCount} / {machines.length} complete
        </span>
      </div>
      <ol className="pipeline-list">
        {machines.map((entry, i) => {
          const name = entry[0];
          const minsPerUnit = parseFloat(entry[1]);
          const phase = phaseRows && phaseRows[i];
          const perMachineMins =
            phase?.expected_mins != null && Number.isFinite(Number(phase.expected_mins))
              ? Number(phase.expected_mins)
              : stageExpectedMinsFromConfig(
                  minsPerUnit,
                  qty,
                  i,
                  stageCapMins,
                  efficiencyFactor
                );
          const expectedMs = perMachineMins * 60 * 1000;
          const phaseStatus = phase?.status;
          const onCurrentStage = i === currentIndex;
          const parallelOnStage = parallelOccupying.filter((pj) => {
            const idx =
              pj.current_machine_index !== undefined ? Number(pj.current_machine_index) : 0;
            return idx === i;
          });
          const s0OnThisStage = parallelOnStage.length > 0;
          const lanePaused = status === 'PAUSED';
          const isPaused = lanePaused && onCurrentStage;
          const isActive = status === 'RUNNING' && onCurrentStage;
          const isReady = status === 'READY' && onCurrentStage;
          const isCompleted = currentIndex >= 0 && i < currentIndex;
          const showLive = isActive && activeForTimer && !s0OnThisStage;
          const showQueuedOnStage0 = i === 0 && nextQueuedId && nextStartMsg && !hasParallelAtStage0;
          const phaseElapsedMins = phase?.elapsed_mins;
          const frozenElapsedMs = Math.round(
            Math.max(0, Number(phaseElapsedMins) || 0) * 60 * 1000
          );
          const displayElapsedMs = showLive ? elapsedMs : isPaused ? frozenElapsedMs : 0;
          const stageComplete = showLive && expectedMs > 0 && displayElapsedMs >= expectedMs;
          const overdue = showLive && expectedMs > 0 && displayElapsedMs > expectedMs;
          const progress =
            expectedMs > 0 ? Math.min(100, (displayElapsedMs / expectedMs) * 100) : 0;
          const stateClass = isCompleted && !s0OnThisStage
            ? 'is-done'
            : isPaused
              ? 'is-paused'
              : isActive || s0OnThisStage
                ? 'is-active'
                : isReady
                  ? 'is-active'
                  : 'is-pending';
          const badge =
            s0OnThisStage && parallelOnStage.length === 1
              ? `PARALLEL · ${parallelOnStage[0].order_id}`
              : s0OnThisStage
                ? `PARALLEL · ${parallelOnStage.length} jobs`
                : phaseStatusLabel(phaseStatus, isCompleted, isActive, isPaused);

          return (
            <li
              key={`${lineKey || 'line'}-${name}-${i}`}
              className={`pipeline-item ${stateClass}`}
            >
              <div className="pipeline-rail" aria-hidden>
                <span className="pipeline-index">{i + 1}</span>
                {i < machines.length - 1 ? <span className="pipeline-connector" /> : null}
              </div>
              <div className="pipeline-card">
                <div className="pipeline-card-top">
                  <h4 className="pipeline-machine">{name}</h4>
                  <span className={`pipeline-badge ${stateClass}`}>{badge}</span>
                </div>
                {(!s0OnThisStage || onCurrentStage) ? (
                  <p className="pipeline-estimate">
                    {qty} unit{qty !== 1 ? 's' : ''} × {Number.isFinite(minsPerUnit) ? minsPerUnit : '—'} min
                    {perMachineMins > 0 && !s0OnThisStage ? (
                      <span className="pipeline-estimate-total"> · {Math.round(perMachineMins)} min stage</span>
                    ) : onCurrentStage && perMachineMins > 0 ? (
                      <span className="pipeline-estimate-total"> · {Math.round(perMachineMins)} min stage</span>
                    ) : null}
                  </p>
                ) : null}
                {parallelOnStage.map((pj) => {
                  const pQty = Math.max(1, parseInt(pj.quantity, 10) || 1);
                  const pIdx = Number(pj.current_machine_index ?? 0);
                  const pMinsPerUnit =
                    pj.mins_per_unit != null && Number.isFinite(Number(pj.mins_per_unit))
                      ? Number(pj.mins_per_unit)
                      : Number.isFinite(minsPerUnit)
                        ? minsPerUnit
                        : 0;
                  const pStageMins =
                    pj.expected_stage_mins != null && Number.isFinite(Number(pj.expected_stage_mins))
                      ? Number(pj.expected_stage_mins)
                      : pMinsPerUnit > 0
                        ? stageExpectedMinsFromConfig(
                            pMinsPerUnit,
                            pQty,
                            pIdx,
                            stageCapMins,
                            efficiencyFactor
                          )
                        : 0;
                  const pExpectedMs = pStageMins > 0 ? pStageMins * 60 * 1000 : 0;
                  const pElapsedMs = parallelElapsedMs(pj);
                  const pRemainingMs = Math.max(0, pExpectedMs - pElapsedMs);
                  const pOverdueMs = pExpectedMs > 0 && pElapsedMs > pExpectedMs ? pElapsedMs - pExpectedMs : 0;
                  const pWaitingForLead = Boolean(pj.waiting_for_lead);
                  const pCanAdvance = Boolean(pj.can_advance_now);
                  const pStageComplete =
                    Boolean(pj.stage_time_complete) || (pExpectedMs > 0 && pElapsedMs >= pExpectedMs);
                  const pFinishAt =
                    formatShortTime(pj.stage_finish_at) ||
                    (pj.start_time && pExpectedMs > 0
                      ? formatShortTime(
                          new Date(parseServerIso(pj.start_time) + pExpectedMs).toISOString()
                        )
                      : null);
                  const pProgress =
                    pExpectedMs > 0
                      ? Math.min(100, (Math.min(pElapsedMs, pExpectedMs) / pExpectedMs) * 100)
                      : 0;
                  const pStatusLine = (() => {
                    if (pWaitingForLead) {
                      return pj.stage_blocked_reason === 'stage_busy'
                        ? 'Stage time complete · next machine occupied by another job'
                        : `Stage time complete · waiting for lead job to clear stage ${pIdx + 2}`;
                    }
                    if (pStageComplete && pCanAdvance) {
                      return 'Stage time complete · moving to next stage now';
                    }
                    if (pStageComplete) {
                      return 'Stage time complete';
                    }
                    return null;
                  })();
                  return (
                    <div key={`${lineKey}-parallel-${pj.order_id}-${i}`} className="pipeline-parallel-block">
                      <p className="pipeline-detail pipeline-detail--stage0">
                        <strong>{pj.order_id}</strong>
                        {' · '}
                        {pQty} unit{pQty !== 1 ? 's' : ''} × {pMinsPerUnit || '—'} min
                        {pStageMins > 0 ? (
                          <span className="pipeline-estimate-total">
                            {' '}
                            · {Math.round(pStageMins)} min{pIdx === 0 ? ' slot' : ' stage'}
                          </span>
                        ) : null}
                      </p>
                      {pj.start_time ? (
                        <div className="pipeline-live">
                          <div
                            className={`pipeline-timer${pWaitingForLead ? ' is-waiting' : ''}${pStageComplete && !pWaitingForLead ? ' is-done' : ''}`}
                          >
                            <span className="pipeline-timer-label">{name} — {pj.order_id}</span>
                            <span className="pipeline-timer-value">
                              {pStageComplete ? (
                                <>
                                  Stage done
                                  <span className="pipeline-timer-target">
                                    {' '}
                                    ({formatMsClock(pExpectedMs)} target
                                    {pOverdueMs > 0 ? ` · ${formatMsClock(pOverdueMs)} past` : ''})
                                  </span>
                                </>
                              ) : (
                                <>
                                  {formatMsClock(pElapsedMs)} elapsed
                                  {pExpectedMs > 0 ? (
                                    <span className="pipeline-timer-target">
                                      {' '}
                                      / {formatMsClock(pExpectedMs)} stage
                                    </span>
                                  ) : null}
                                </>
                              )}
                            </span>
                          </div>
                          {pExpectedMs > 0 ? (
                            <p className="pipeline-parallel-timing">
                              {pStatusLine ? (
                                <span
                                  className={
                                    pWaitingForLead
                                      ? 'pipeline-parallel-wait'
                                      : 'pipeline-parallel-done'
                                  }
                                >
                                  {pStatusLine}
                                </span>
                              ) : (
                                <>
                                  <span>
                                    <strong>{formatMsClock(pRemainingMs)}</strong> remaining
                                  </span>
                                  {pFinishAt ? (
                                    <span className="pipeline-parallel-finish">
                                      {' '}
                                      · done ~{pFinishAt}
                                    </span>
                                  ) : null}
                                </>
                              )}
                            </p>
                          ) : null}
                          {pExpectedMs > 0 ? (
                            <div className="pipeline-bar" aria-hidden>
                              <div
                                className="pipeline-bar-fill"
                                style={{ width: `${pProgress}%` }}
                              />
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {isPaused ? (
                  <p className="pipeline-detail pipeline-detail--paused">
                    Paused at {formatElapsedMins(phaseElapsedMins)}
                  </p>
                ) : null}
                {isCompleted && !lanePaused && phaseElapsedMins > 0 && !s0OnThisStage ? (
                  <p className="pipeline-detail pipeline-detail--success">
                    Finished in {formatElapsedMins(phaseElapsedMins)}
                  </p>
                ) : null}
                {phase?.quantity_in_stage > 0 ? (
                  <p className="pipeline-detail">~{phase.quantity_in_stage} units in this stage</p>
                ) : null}
                {isPaused && expectedMs > 0 ? (
                  <div className="pipeline-live pipeline-live--frozen">
                    <div className="pipeline-bar" aria-hidden>
                      <div className="pipeline-bar-fill" style={{ width: `${progress}%` }} />
                    </div>
                  </div>
                ) : null}
                {showLive ? (
                  <div className="pipeline-live">
                    <div className={`pipeline-timer ${overdue ? 'is-overdue' : ''}`}>
                      <span className="pipeline-timer-label">Elapsed</span>
                      <span className="pipeline-timer-value">
                        {formatMsClock(displayElapsedMs)}
                        {expectedMs > 0 ? (
                          <span className="pipeline-timer-target"> / {formatMsClock(expectedMs)} stage</span>
                        ) : null}
                      </span>
                    </div>
                    {expectedMs > 0 ? (
                      <p className="pipeline-parallel-timing">
                        {stageComplete ? (
                          <span className="pipeline-parallel-done">
                            {autoAdvanceStages
                              ? 'Stage complete — moving to next stage…'
                              : 'Stage complete'}
                          </span>
                        ) : (
                          <>
                            <span>
                              <strong>{formatMsClock(expectedMs - displayElapsedMs)}</strong> remaining
                            </span>
                            {startTime ? (
                              <span className="pipeline-parallel-finish">
                                {' '}
                                · done ~
                                {formatShortTime(
                                  new Date(parseServerIso(startTime) + expectedMs).toISOString()
                                )}
                              </span>
                            ) : null}
                          </>
                        )}
                      </p>
                    ) : null}
                    {expectedMs > 0 ? (
                      <div className="pipeline-bar" aria-hidden>
                        <div className="pipeline-bar-fill" style={{ width: `${progress}%` }} />
                      </div>
                    ) : null}
                    {overdue ? (
                      <p className="pipeline-detail pipeline-detail--warn">
                        {formatMsClock(displayElapsedMs - expectedMs)} over target
                      </p>
                    ) : null}
                  </div>
                ) : (onCurrentStage && (status === 'READY' || status === 'STOPPED')) ? (
                  <p className="pipeline-detail">Waiting for start</p>
                ) : null}
                {onCurrentStage && canAdvanceStage && onAdvanceStage && !s0OnThisStage && !stageComplete ? (
                  <button
                    type="button"
                    className="pipeline-stage-advance"
                    onClick={() => onAdvanceStage('primary')}
                    title="Move the lead job to the next production stage on this lane"
                  >
                    <Zap size={16} /> Move to next stage
                  </button>
                ) : null}
                {showQueuedOnStage0 ? (
                  <div className={`pipeline-queued-slot${nextStartingSoon ? ' is-starting-soon' : ''}`}>
                    <div className="pipeline-queued-top">
                      <span className="pipeline-queued-label">Up next — starting on this lane</span>
                      <span className="pipeline-queued-badge">AUTO-START</span>
                    </div>
                    <strong className="pipeline-queued-id">{nextQueuedId}</strong>
                    {nextQueuedMachine ? (
                      <span className="pipeline-queued-machine">First stage: {nextQueuedMachine}</span>
                    ) : null}
                    <span className={`pipeline-queued-eta${nextStartingSoon ? ' pipeline-queued-eta--soon' : ''}`}>
                      {nextStartMsg.headline}
                    </span>
                    <span className="pipeline-queued-detail">{nextStartMsg.detail}</span>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
};

const LogView = () => {
  const [logs, setLogs] = useState([]);
  useEffect(() => {
    axios.get(`${SERVER_URL}/api/activity/logs`).then(res => setLogs(res.data));
  }, []);

  return (
    <div className="logs-view">
      <div className="section-header">
        <h2>System Activity Logs</h2>
        <p>Full audit trail of production events</p>
      </div>
      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Source</th>
              <th>Line</th>
              <th>Machine</th>
              <th>Action</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log, i) => (
              <tr key={i}>
                <td className="log-time">{new Date(log.timestamp).toLocaleString()}</td>
                <td><span className={`source-badge ${log.source?.toLowerCase()}`}>{log.source || 'Arduino'}</span></td>
                <td>{log.line?.toUpperCase()}</td>
                <td>{log.machine || '---'}</td>
                <td><span className="log-event">{log.event}</span></td>
                <td>{renderStatusBadge(log.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const AllLanesControlStrip = ({
  productionState,
  jobQueue,
  configMachines,
  selectedLanes,
  onToggleLane,
  onSelectAllLanes,
  onDeploy,
  onStart,
  onResume,
  onPause,
  onEnd,
  onAdvance,
  onClear,
  canDeploy,
  canStart,
  canResume,
  canPause,
  canEnd,
  canAdvance,
  autoScheduling,
}) => {
  const pauseResumeMode = canResume && !canPause;
  const selectedCount = selectedLanes.length;
  const selectedRunning = selectedLanes.filter(
    (ln) => productionState[ln]?.status === 'RUNNING'
  ).length;
  const selectedPaused = selectedLanes.filter(
    (ln) => productionState[ln]?.status === 'PAUSED'
  ).length;
  return (
  <div className="all-lanes-control-strip">
    <div className="all-lanes-control-header">
      <h2>Production controls</h2>
      <button type="button" className="all-lanes-select-all" onClick={onSelectAllLanes}>
        Select all
      </button>
    </div>
    <p className="all-lanes-auto-hint">
      Deploy Next sends the same job to <strong>door, frame, and arch</strong> every time — idle lanes
      start immediately; busy lanes queue or auto-start at Scale Saw.
      {autoScheduling ? ' Background auto-scheduling is on.' : ''}
      {' '}
      Bulk Start / Pause / Resume / End apply only to <strong>checked lanes below</strong> ({selectedCount} selected).
      Use each lane card&apos;s own buttons to control a single line.
    </p>
    <div className="all-lanes-targets">
      <span className="all-lanes-targets-label">Apply to:</span>
      {FACTORY_LANES.map((lane) => {
        const st = productionState[lane];
        const checked = selectedLanes.includes(lane);
        const upcoming = collectLaneUpcomingJobs(st, jobQueue, lane, configMachines?.[lane]);
        const nextUp = upcoming[0];
        const jobCount = countJobsOnLane(st, jobQueue, lane, configMachines?.[lane]);
        return (
          <label key={lane} className={`lane-target-chip${checked ? ' is-on' : ''}`}>
            <input
              type="checkbox"
              checked={checked}
              onChange={() => onToggleLane(lane)}
            />
            <span className="lane-target-name">{lane.toUpperCase()}</span>
            {jobCount > 0 ? (
              <span className="lane-target-job-count" title={`${jobCount} job${jobCount !== 1 ? 's' : ''} on this lane`}>
                {jobCount} job{jobCount !== 1 ? 's' : ''}
              </span>
            ) : null}
            {st?.order_id ? (
              <span className="lane-target-job" title={st.order_id}>{st.order_id}</span>
            ) : null}
            {nextUp ? (
              <span
                className="lane-target-queue"
                title={`Next: ${laneQueueOrderId(nextUp)}${upcoming.length > 1 ? ` (+${upcoming.length - 1} more)` : ''}`}
              >
                →{laneQueueOrderId(nextUp)}
              </span>
            ) : null}
            {upcoming.length > 1 ? (
              <span className="lane-target-queue-count" title={upcoming.map(laneQueueOrderId).join(', ')}>
                +{upcoming.length - 1} queued
              </span>
            ) : null}
            {lineParallelJobs(st).map((pj) => {
              const idx = Number(pj.current_machine_index ?? 0);
              const machines = configMachines?.[lane];
              const mname = machines?.[idx]?.[0] || (idx === 0 ? 'saw' : `stg ${idx + 1}`);
              return (
                <span
                  key={`${lane}-p-${pj.order_id}`}
                  className="lane-target-stage0"
                  title={`Parallel job at ${mname}`}
                >
                  +{pj.order_id} @ {mname}
                </span>
              );
            })}
            {st && <span className="lane-target-status">{st.status || '—'}</span>}
          </label>
        );
      })}
    </div>
    <div className="all-lanes-actions">
      <button
        type="button"
        className="btn-deploy-next all-lanes-btn"
        onClick={onDeploy}
        disabled={!canDeploy}
        title="Deploy the next queue job to all lanes (door, frame, arch)"
      >
        <Download size={18} /> Deploy Next
      </button>
      <button
        type="button"
        className="btn-deploy-next all-lanes-btn all-lanes-btn-start"
        onClick={onStart}
        disabled={!canStart}
        title="Start selected lanes that are READY (each lane runs its own job)"
      >
        <Play size={18} /> Start
      </button>
      <button
        type="button"
        className={`all-lanes-btn ${pauseResumeMode ? 'all-lanes-btn-resume' : 'btn-pause'}`}
        onClick={pauseResumeMode ? onResume : onPause}
        disabled={!canPause && !canResume}
        title={
          pauseResumeMode
            ? `Resume ${selectedPaused} selected PAUSED lane${selectedPaused !== 1 ? 's' : ''}`
            : `Pause ${selectedRunning} selected RUNNING lane${selectedRunning !== 1 ? 's' : ''}`
        }
      >
        {pauseResumeMode ? (
          <>
            <Play size={18} /> Resume{selectedPaused > 0 ? ` (${selectedPaused})` : ''}
          </>
        ) : (
          <>
            <Pause size={18} /> Pause{selectedRunning > 0 ? ` (${selectedRunning})` : ''}
          </>
        )}
      </button>
      <button
        type="button"
        className="btn-stop all-lanes-btn"
        onClick={onEnd}
        disabled={!canEnd}
        title="End selected active lanes"
      >
        <Square size={18} /> End
      </button>
      <button
        type="button"
        className="btn-deploy-next all-lanes-btn all-lanes-btn-advance"
        onClick={onAdvance}
        disabled={!canAdvance}
        title="Move selected RUNNING lanes to next stage"
      >
        <Zap size={18} /> Move to Next Stage
      </button>
      <button
        type="button"
        className="btn-stop all-lanes-btn all-lanes-btn-clear"
        onClick={onClear}
        title="Reset selected lanes to idle (keeps queue jobs)"
      >
        <Trash2 size={18} /> Clear Lanes
      </button>
    </div>
  </div>
  );
};

const ProductionLineView = ({
  line,
  state,
  configMachines,
  laneStageCapMins = 8,
  autoAdvanceStages = true,
  onQuantityDoneChange,
  onAdvanceStage,
  onLaneCommand,
  activeJob,
  jobQueue,
  timelineAnalysis,
  isSelected,
}) => {
  const machines = configMachines ? configMachines.map(m => m[0]) : [];
  const timing = state.line_timing || {};
  const qtyDone = timing.quantity_done ?? state.quantity_done ?? 0;
  const qtyTotal = timing.quantity || state.quantity || 0;
  const upcomingJobs = collectLaneUpcomingJobs(state, jobQueue, line, configMachines);
  const laneNextMins =
    upcomingJobs.length > 0
      ? effectiveQueueWaitMins(state, 0, upcomingJobs[0].est_wait_mins)
      : null;

  // Calculate expected time for current stage
  let currentStageTime = 0;
  if (state.current_machine && configMachines) {
    const match = configMachines.find(m => m[0] === state.current_machine);
    if (match) currentStageTime = match[1];
  }

  const orderTiming = activeJob?.order_timing;
  const orderLaneEntry =
    orderTiming?.lanes && orderTiming.lanes[line] ? orderTiming.lanes[line] : null;

  const laneStatus = String(state.status || 'STOPPED').toUpperCase();
  const canAdvanceStage = laneStatus === 'RUNNING' || laneStatus === 'PAUSED';
  const jobsOnLane = countJobsOnLane(state, jobQueue, line, configMachines);
  const canStartLane = laneStatus === 'READY';
  const canPauseLane = laneStatus === 'RUNNING';
  const canResumeLane = laneStatus === 'PAUSED';

  return (
    <div className={`line-focus-view stacked${isSelected ? ' line-focus-view--selected' : ''}`}>
      <div className="line-card focus">
        <div className="line-header">
          <div className="line-header-title">
            <h3>{line.toUpperCase()} LINE</h3>
            {jobsOnLane > 0 ? (
              <span className="line-job-count-pill" title="Lead, parallel, and queued jobs on this lane">
                {jobsOnLane} job{jobsOnLane !== 1 ? 's' : ''}
              </span>
            ) : null}
          </div>
          <div className="line-header-actions">
            <div className="line-lane-controls">
              {canStartLane ? (
                <button
                  type="button"
                  className="line-lane-btn line-lane-btn-start"
                  onClick={() => onLaneCommand(line, 'START')}
                  title={`Start ${line.toUpperCase()} only`}
                >
                  <Play size={14} /> Start
                </button>
              ) : null}
              {canPauseLane ? (
                <button
                  type="button"
                  className="line-lane-btn line-lane-btn-pause"
                  onClick={() => onLaneCommand(line, 'PAUSE')}
                  title={`Pause ${line.toUpperCase()} only`}
                >
                  <Pause size={14} /> Pause
                </button>
              ) : null}
              {canResumeLane ? (
                <button
                  type="button"
                  className="line-lane-btn line-lane-btn-resume"
                  onClick={() => onLaneCommand(line, 'RESUME')}
                  title={`Resume ${line.toUpperCase()} only`}
                >
                  <Play size={14} /> Resume
                </button>
              ) : null}
            </div>
            <div className="line-header-status">
              {renderStatusBadge(state.status)}
              {state.decision && <span style={{ fontSize: '0.75rem', color: 'var(--accent)', fontWeight: '600' }}>{state.decision}</span>}
            </div>
          </div>
        </div>

        <div className="line-info-grid">
          <div className="info-box">
            <label>Quantity done</label>
            <div className="qty-done-row">
              <button
                type="button"
                className="qty-step-btn"
                disabled={!state.order_id || qtyDone <= 0}
                onClick={() => onQuantityDoneChange(line, Math.max(0, qtyDone - 1))}
              >
                −
              </button>
              <span className="value-large">{qtyDone}</span>
              <span className="qty-slash">/</span>
              <span className="value-large muted-qty">{qtyTotal}</span>
              <button
                type="button"
                className="qty-step-btn"
                disabled={!state.order_id || qtyDone >= qtyTotal}
                onClick={() => onQuantityDoneChange(line, Math.min(qtyTotal, qtyDone + 1))}
              >
                +
              </button>
            </div>
          </div>
          <div className="info-box">
            <label>Active Job ID</label>
            <div className="value-large">{state.order_id || 'IDLE'}</div>
            {lineParallelJobs(state).length > 0 ? (
              <div className="info-sub info-sub--stage0">
                + {lineParallelJobs(state).length} parallel:{' '}
                <strong>
                  {lineParallelJobs(state)
                    .map((p) => p.order_id)
                    .join(', ')}
                </strong>
              </div>
            ) : null}
          </div>
          <div className="info-box">
            <label>Current phase</label>
            <div className="value-large">{state.current_machine || '---'}</div>
            {currentStageTime > 0 && (
              <div className="info-sub">
                Stage est. {currentStageTime * (state.quantity || 1)} min
                {timing?.remaining_mins != null ? ` · Lane left ${formatMins(timing.remaining_mins)}` : ''}
              </div>
            )}
          </div>
        </div>

        {upcomingJobs.length > 0 ? (
          <div className="lane-queue-panel">
            <span className="lane-queue-label">
              Scheduled to start on this lane
              {(() => {
                const wait = effectiveQueueWaitMins(state, 0, upcomingJobs[0]?.est_wait_mins);
                const msg = formatNextJobStartMessage(wait);
                return (
                  <span className="lane-queue-wait">
                    {' '}
                    · {msg.headline.toLowerCase()}
                  </span>
                );
              })()}
            </span>
            <ol className="lane-queue-list">
              {upcomingJobs.map((item, idx) => {
                const oid = laneQueueOrderId(item);
                const step1 = laneQueueFirstMachine(item);
                const waitMins = effectiveQueueWaitMins(state, idx, item.est_wait_mins);
                const startMsg = formatNextJobStartMessage(waitMins);
                const isFirst = idx === 0;
                return (
                <li key={`${line}-q-${oid}`} className={isFirst ? 'lane-queue-item--next' : ''}>
                  <span className="lane-queue-pos">{idx + 1}</span>
                  <span className="lane-queue-id">{oid}</span>
                  {isFirst ? <span className="lane-queue-auto-badge">AUTO-START</span> : null}
                  {step1 ? (
                    <span className="lane-queue-step" title="Will begin at first step">
                      starts at: {step1}
                    </span>
                  ) : null}
                  <span className={`lane-queue-eta${Number(waitMins) <= 1 ? ' lane-queue-eta--soon' : ''}`}>
                    {startMsg.headline}
                  </span>
                </li>
              );
              })}
            </ol>
          </div>
        ) : lineParallelJobs(state).length > 0 ? (
          <div className="lane-queue-panel lane-queue-panel--stage0">
            <span className="lane-queue-label">
              {lineParallelJobs(state).length} parallel job
              {lineParallelJobs(state).length !== 1 ? 's' : ''} running with{' '}
              <strong>{state.order_id}</strong>
            </span>
          </div>
        ) : null}

        {timing && state.order_id && (
          <div className="lane-timing-panel">
            <div className="lane-timing-metric">
              <span className="lt-label">Lane elapsed</span>
              <strong>{formatElapsedMins(timing.actual_mins)}</strong>
            </div>
            <div className="lane-timing-metric">
              <span className="lt-label">AI remaining</span>
              <strong>{formatMins(timing.remaining_mins)}</strong>
            </div>
            <div className="lane-timing-metric">
              <span className="lt-label">Lane estimate</span>
              <strong>{formatMins(timing.expected_total_mins)}</strong>
            </div>
            {activeJob?.live_timeline && (
              <div className="lane-timing-metric highlight">
                <span className="lt-label">Order finish (AI)</span>
                <strong>{activeJob.live_timeline.expected_finish_days ?? '—'}d</strong>
              </div>
            )}
          </div>
        )}

        {orderTiming && state.order_id && orderTiming.lanes && (
          <div className="order-timing-total">
            <Clock size={14} />
            <span>
              <strong>{state.order_id}</strong> on {line.toUpperCase()} — actual{' '}
              {formatMins(orderLaneEntry?.actual_mins ?? timing?.actual_mins)}{' '}
              · remaining {formatMins(orderLaneEntry?.remaining_mins ?? timing?.remaining_mins)}{' '}
              · est. {formatMins(orderLaneEntry?.expected_total_mins ?? timing?.expected_total_mins)}
              {orderTiming.counting_lanes && orderTiming.counting_lanes.length > 1 ? (
                <span className="order-timing-hint">
                  {' '}
                  (order total {formatMins(orderTiming.total_remaining_mins)} left across{' '}
                  {orderTiming.counting_lanes.map((l) => String(l).toUpperCase()).join(', ')})
                </span>
              ) : null}
            </span>
          </div>
        )}

        <MachineStepper
          lineKey={line}
          machinesList={configMachines}
          current={state.current_machine}
          currentIndex={state.order_id ? (state.current_machine_index !== undefined ? state.current_machine_index : machines.indexOf(state.current_machine)) : -1}
          quantity={state.quantity}
          quantityDone={qtyDone}
          status={state.status}
          startTime={state.start_time}
          stageElapsedOffsetMins={
            timing?.stage_elapsed_offset_mins ?? state.stage_elapsed_offset_mins
          }
          timingUpdatedAt={timing?.updated_at}
          phaseRows={state.order_id ? timing?.phases : undefined}
          laneNextMins={laneNextMins}
          queuedJobs={upcomingJobs}
          parallelJobs={lineParallelJobs(state)}
          stage0Job={state.stage0_job}
          stage0SlotOpen={laneStage0SlotOpen(state)}
          stageCapMins={laneStageCapMins}
          efficiencyFactor={timing?.efficiency_factor ?? 1}
          autoAdvanceStages={autoAdvanceStages}
          onAdvanceStage={(track) => onAdvanceStage(line, track)}
          canAdvanceStage={canAdvanceStage}
        />
      </div>
    </div>
  );
};

const FACTORY_WEEKDAYS = [
  { id: 0, label: 'Sun' },
  { id: 1, label: 'Mon' },
  { id: 2, label: 'Tue' },
  { id: 3, label: 'Wed' },
  { id: 4, label: 'Thu' },
  { id: 5, label: 'Fri' },
  { id: 6, label: 'Sat' },
];

const WorkCalendarEditor = ({
  hoursPerDay,
  setHoursPerDay,
  workingWeekdays,
  setWorkingWeekdays,
  nonWorkingDates,
  setNonWorkingDates,
}) => {
  const [viewMonth, setViewMonth] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });

  const toggleWeekday = (id) => {
    setWorkingWeekdays((prev) => {
      const next = prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id];
      return next.sort((a, b) => a - b);
    });
  };

  const isoDate = (y, m, d) =>
    `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  const toggleHoliday = (iso) => {
    setNonWorkingDates((prev) =>
      prev.includes(iso) ? prev.filter((x) => x !== iso) : [...prev, iso].sort()
    );
  };

  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const firstDow = viewMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(d);

  const monthLabel = viewMonth.toLocaleString(undefined, { month: 'long', year: 'numeric' });

  return (
    <div className="work-calendar-editor">
      <div className="work-calendar-hours">
        <label>
          Hours per work day
          <input
            type="number"
            min={1}
            max={24}
            step={0.5}
            value={hoursPerDay}
            onChange={(e) => setHoursPerDay(Math.max(1, parseFloat(e.target.value) || 9))}
          />
        </label>
        <p className="settings-hint">
          Timeline math uses this many hours per working day (default 9h). Sunday = 0, Saturday = 6.
        </p>
      </div>

      <div className="work-week-toggles">
        <span className="work-week-label">Working weekdays</span>
        <div className="work-week-row">
          {FACTORY_WEEKDAYS.map((wd) => (
            <button
              key={wd.id}
              type="button"
              className={`work-day-toggle ${workingWeekdays.includes(wd.id) ? 'on' : ''}`}
              onClick={() => toggleWeekday(wd.id)}
              title={`${wd.label} (${wd.id})`}
            >
              <span className="work-day-num">{wd.id}</span>
              {wd.label}
            </button>
          ))}
        </div>
      </div>

      <div className="work-month-calendar">
        <div className="work-month-header">
          <button type="button" className="work-month-nav" onClick={() => setViewMonth(new Date(year, month - 1, 1))}>
            ‹
          </button>
          <span>{monthLabel}</span>
          <button type="button" className="work-month-nav" onClick={() => setViewMonth(new Date(year, month + 1, 1))}>
            ›
          </button>
        </div>
        <div className="work-month-dow">
          {FACTORY_WEEKDAYS.map((wd) => (
            <span key={wd.id}>{wd.label}</span>
          ))}
        </div>
        <div className="work-month-grid">
          {cells.map((day, idx) => {
            if (!day) return <span key={`empty-${idx}`} className="work-month-cell empty" />;
            const iso = isoDate(year, month, day);
            const dt = new Date(year, month, day);
            const userDow = dt.getDay();
            const isWorkWeek = workingWeekdays.includes(userDow);
            const isHoliday = nonWorkingDates.includes(iso);
            return (
              <button
                key={iso}
                type="button"
                className={`work-month-cell ${isWorkWeek ? 'work-week' : 'off-week'} ${isHoliday ? 'holiday' : ''}`}
                onClick={() => toggleHoliday(iso)}
                title={isHoliday ? 'Remove holiday' : 'Mark as non-working (holiday)'}
              >
                {day}
              </button>
            );
          })}
        </div>
        <p className="settings-hint">
          Click a date to mark extra days off (holidays). Green = normal work week; amber = holiday / closed.
        </p>
        {nonWorkingDates.length > 0 && (
          <div className="holiday-chips">
            {nonWorkingDates.map((iso) => (
              <button key={iso} type="button" className="holiday-chip" onClick={() => toggleHoliday(iso)}>
                {iso} ×
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const SettingsView = ({ config, onSave, onResetAll, serverUrl }) => {
  const [timelineBusinessDays, setTimelineBusinessDays] = useState(
    config.timeline_uses_business_days !== false
  );
  const [autoPullNext, setAutoPullNext] = useState(Boolean(config.auto_pull_next_job));
  const [autoStartDeployed, setAutoStartDeployed] = useState(
    config.auto_start_deployed_jobs !== false
  );
  const [hoursPerDay, setHoursPerDay] = useState(config.hours_per_day ?? 9);
  const [workingWeekdays, setWorkingWeekdays] = useState(
    Array.isArray(config.working_weekdays) && config.working_weekdays.length
      ? [...config.working_weekdays].sort((a, b) => a - b)
      : [0, 1, 2, 3, 4]
  );
  const [nonWorkingDates, setNonWorkingDates] = useState(
    Array.isArray(config.non_working_dates) ? [...config.non_working_dates] : []
  );

  const [machines, setMachines] = useState(() => {
    const m = { ...config.machines };
    Object.keys(m).forEach(line => {
      m[line] = m[line].map((arr) => ({ id: Math.random().toString(36).substr(2, 9), name: arr[0], time: arr[1] }));
    });
    return m;
  });

  const [materials, setMaterials] = useState(() =>
    Object.entries(config.materials || {}).map(([name, lead]) => ({ id: Math.random().toString(36).substr(2, 9), name, lead }))
  );

  const handleAddMachine = (line) => {
    setMachines(prev => ({
      ...prev,
      [line]: [...prev[line], { id: Math.random().toString(36).substr(2, 9), name: "New Machine", time: 5 }]
    }));
  };

  const handleUpdateMachine = (line, id, field, value) => {
    setMachines(prev => ({
      ...prev,
      [line]: prev[line].map(m => m.id === id ? { ...m, [field]: value } : m)
    }));
  };

  const handleRemoveMachine = (line, id) => {
    setMachines(prev => ({
      ...prev,
      [line]: prev[line].filter(m => m.id !== id)
    }));
  };

  const handleMoveMachine = (line, index, direction) => {
    setMachines(prev => {
      const list = [...prev[line]];
      if (direction === 'up' && index > 0) {
        [list[index], list[index - 1]] = [list[index - 1], list[index]];
      } else if (direction === 'down' && index < list.length - 1) {
        [list[index], list[index + 1]] = [list[index + 1], list[index]];
      }
      return { ...prev, [line]: list };
    });
  };

  const handleAddMaterial = () => {
    setMaterials(prev => [...prev, { id: Math.random().toString(36).substr(2, 9), name: "New Material", lead: 10 }]);
  };

  const handleUpdateMaterial = (id, field, value) => {
    setMaterials(prev => prev.map(m => m.id === id ? { ...m, [field]: value } : m));
  };

  const handleRemoveMaterial = (id) => {
    setMaterials(prev => prev.filter(m => m.id !== id));
  };

  const saveSettings = () => {
    const formattedMachines = {};
    Object.keys(machines).forEach(line => {
      formattedMachines[line] = machines[line].map(m => [m.name, parseInt(m.time) || 0]);
    });

    const formattedMaterials = {};
    materials.forEach(m => {
      if (m.name.trim()) formattedMaterials[m.name.trim()] = parseInt(m.lead) || 0;
    });

    onSave({
      ...config,
      machines: formattedMachines,
      materials: formattedMaterials,
      hours_per_day: hoursPerDay,
      working_weekdays: workingWeekdays,
      non_working_dates: nonWorkingDates,
      days_per_week: workingWeekdays.length,
      timeline_uses_business_days: timelineBusinessDays,
      auto_pull_next_job: autoPullNext,
      auto_start_deployed_jobs: autoStartDeployed,
    });
  };

  const handleResetAll = () => {
    if (!onResetAll) return;
    onResetAll();
  };

  return (
    <div className="settings-view" style={{ maxWidth: '1400px', margin: '0 auto' }}>
      <div className="settings-card" style={{ marginBottom: '1.5rem', maxWidth: '1400px' }}>
        <div className="card-header">
          <h3>Data &amp; timeline</h3>
          <p>Where jobs live, and how days are counted</p>
        </div>
        <p className="settings-hint" style={{ margin: '0 0 1rem', color: 'var(--text-dim)', lineHeight: 1.5 }}>
          Jobs and line state are stored on the server ({serverUrl || 'API'}), not on the Arduino. The ESP32 only keeps
          <strong> batch numbers in EEPROM</strong> and a temporary offline <strong>event queue</strong> (START/END telemetry).
          After a full reset here, use serial <code>STATUS</code> on the device if you need to confirm batch IDs — they are not cleared by this button.
        </p>
        <WorkCalendarEditor
          hoursPerDay={hoursPerDay}
          setHoursPerDay={setHoursPerDay}
          workingWeekdays={workingWeekdays}
          setWorkingWeekdays={setWorkingWeekdays}
          nonWorkingDates={nonWorkingDates}
          setNonWorkingDates={setNonWorkingDates}
        />
        <label className="settings-check" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.75rem', marginTop: '1rem' }}>
          <input
            type="checkbox"
            checked={timelineBusinessDays}
            onChange={(e) => setTimelineBusinessDays(e.target.checked)}
          />
          Show timeline counts as business days (work-week); calendar span and finish date always use the schedule above
        </label>
        <label className="settings-check" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.75rem' }}>
          <input
            type="checkbox"
            checked={autoPullNext}
            onChange={(e) => setAutoPullNext(e.target.checked)}
          />
          Auto-deploy jobs to lanes (idle lanes start immediately; busy lanes queue at step 1)
        </label>
        <label className="settings-check" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '1rem' }}>
          <input
            type="checkbox"
            checked={autoStartDeployed}
            onChange={(e) => setAutoStartDeployed(e.target.checked)}
          />
          Auto-start deployed jobs (no manual Start button needed)
        </label>
        <button
          type="button"
          className="btn-stop"
          style={{ marginRight: '0.75rem' }}
          onClick={handleResetAll}
        >
          <Trash2 size={16} /> Clear all server data
        </button>
        <span className="settings-hint" style={{ color: 'var(--text-dim)', fontSize: '0.9rem' }}>
          Removes jobs, activity logs, and line assignments. Saves factory config when you click Save Configuration.
        </span>
      </div>
      <div className="settings-grid">
        <div className="settings-card">
          <div className="card-header">
            <h3>Production Sequences</h3>
            <p>Customize the workflow for each line</p>
          </div>
          {Object.entries(machines).map(([line, list]) => (
            <div key={line} className="config-section">
              <div className="section-header">
                <h4>{line.toUpperCase()} LINE SEQUENCE</h4>
                <button className="btn-add-mat" onClick={() => handleAddMachine(line)}>
                  <Plus size={14} /> Add Machine
                </button>
              </div>
              <div className="machine-list-edit">
                {list.map((m, i) => (
                  <div key={m.id} className="machine-row-edit">
                    <div className="seq-controls">
                      <button onClick={() => handleMoveMachine(line, i, 'up')} disabled={i === 0}>
                        <ChevronUp size={16} />
                      </button>
                      <button onClick={() => handleMoveMachine(line, i, 'down')} disabled={i === list.length - 1}>
                        <ChevronDown size={16} />
                      </button>
                    </div>
                    <input
                      placeholder="Machine Name"
                      value={m.name}
                      onChange={(e) => handleUpdateMachine(line, m.id, 'name', e.target.value)}
                    />
                    <div className="input-with-unit">
                      <input
                        type="number"
                        value={m.time}
                        onChange={(e) => handleUpdateMachine(line, m.id, 'time', e.target.value)}
                      />
                      <span>mins</span>
                    </div>
                    <button className="btn-del-mat" onClick={() => handleRemoveMachine(line, m.id)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="settings-card">
          <div className="card-header">
            <h3>Material Database</h3>
            <p>Manage lead times and availability</p>
          </div>
          <div className="section-header">
            <h4>MATERIALS & LEAD TIMES</h4>
            <button className="btn-add-mat" onClick={handleAddMaterial}>
              <Plus size={14} /> Add Material
            </button>
          </div>
          <div className="material-list-edit">
            {materials.map(m => (
              <div key={m.id} className="material-row-edit">
                <input
                  placeholder="Material Name"
                  value={m.name}
                  onChange={(e) => handleUpdateMaterial(m.id, 'name', e.target.value)}
                />
                <div className="input-with-unit">
                  <input
                    type="number"
                    value={m.lead}
                    onChange={(e) => handleUpdateMaterial(m.id, 'lead', e.target.value)}
                  />
                  <span>bus. days</span>
                </div>
                <button className="btn-del-mat" onClick={() => handleRemoveMaterial(m.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="settings-footer">
        <button className="btn-primary large" onClick={saveSettings}>Save Configuration</button>
      </div>
    </div>
  );
};

const ModernDialog = ({ isOpen, title, message, type = 'info', onConfirm, onCancel, confirmText = 'OK', cancelText = 'Cancel' }) => {
  if (!isOpen) return null;
  return (
    <div className="modal-overlay" style={{ zIndex: 2000 }}>
      <div className="modal-content dialog-modal" style={{ maxWidth: '400px' }}>
        <div className="modal-header" style={{ borderBottom: 'none', paddingBottom: '0.5rem' }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1.4rem', color: type === 'error' ? 'var(--danger)' : type === 'warning' ? 'var(--warning)' : 'var(--primary)' }}>
            {type === 'error' ? <AlertCircle size={22} /> : type === 'warning' ? <AlertCircle size={22} /> : <Info size={22} />}
            {title}
          </h2>
        </div>
        <div className="modal-body" style={{ padding: '0.5rem 2rem 2rem 2rem', color: 'var(--text-dim)', fontSize: '1.05rem', lineHeight: '1.5' }}>
          {message}
        </div>
        <div className="modal-footer" style={{ padding: '1rem 2rem', background: 'transparent', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
          {onCancel && <button className="btn-secondary" onClick={onCancel} style={{ padding: '0.6rem 1.2rem', fontSize: '0.95rem' }}>{cancelText}</button>}
          <button
            className="btn-primary"
            style={{
              padding: '0.6rem 1.2rem',
              fontSize: '0.95rem',
              background: type === 'error' || type === 'warning' ? 'var(--danger)' : 'var(--primary)',
              boxShadow: type === 'error' || type === 'warning' ? '0 4px 12px rgba(239, 68, 68, 0.2)' : '0 4px 12px rgba(48, 84, 150, 0.3)'
            }}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};

// --- Main App Component ---

function App() {
  const [socket, setSocket] = useState(null);
  const [productionState, setProductionState] = useState({
    door: { status: 'STOPPED', current_machine: null, batch_id: 0, quantity: 0, order_id: null, all_machines: [] },
    frame: { status: 'STOPPED', current_machine: null, batch_id: 0, quantity: 0, order_id: null, all_machines: [] },
    arch: { status: 'STOPPED', current_machine: null, batch_id: 0, quantity: 0, order_id: null, all_machines: [] },
  });
  const [jobQueue, setJobQueue] = useState([]);
  const [laneCompletions, setLaneCompletions] = useState([]);
  const [activeTab, setActiveTab] = useState('summary');
  const [config, setConfig] = useState({ machines: { door: [], frame: [], arch: [] }, materials: {} });
  const [showPlanner, setShowPlanner] = useState(false);
  const [plannerData, setPlannerData] = useState({
    order_id: `JOB-${Math.floor(Math.random() * 1000000)}`,
    quantity: 1,
    materials: []
  });
  /** Single payload from GET /api/predictions or POST /api/analyze-job (banner + modal). */
  const [timelineAnalysis, setTimelineAnalysis] = useState(null);
  /** True after "Analyze Timeline" for the open planner — same numbers shown on the summary banner. */
  const [plannerAnalysisSynced, setPlannerAnalysisSynced] = useState(false);
  const showPlannerRef = useRef(false);
  const [systemStatus, setSystemStatus] = useState({ db: 'checking', esp32: 'checking', server: 'checking' });
  const [dialogConfig, setDialogConfig] = useState({ isOpen: false, title: '', message: '', type: 'info', onConfirm: null, onCancel: null, confirmText: 'OK', cancelText: 'Cancel' });
  const [showReportModal, setShowReportModal] = useState(false);
  const currentYear = new Date().getFullYear();
  const currentQuarter = Math.floor(new Date().getMonth() / 3) + 1;
  const [reportConfig, setReportConfig] = useState({ year: currentYear, quarter: currentQuarter, format: 'xlsx' });
  const [exporting, setExporting] = useState(false);

  const showDialog = (config) => {
    setDialogConfig({ ...config, isOpen: true });
  };

  const closeDialog = () => {
    setDialogConfig(prev => ({ ...prev, isOpen: false }));
  };

  useEffect(() => {
    showPlannerRef.current = showPlanner;
  }, [showPlanner]);

  const closePlanner = () => {
    showPlannerRef.current = false;
    setShowPlanner(false);
    setPlannerAnalysisSynced(false);
    axios
      .get(`${SERVER_URL}/api/predictions`)
      .then((res) => setTimelineAnalysis(res.data))
      .catch(() => {});
  };

  useEffect(() => {
    const newSocket = io(SERVER_URL);
    setSocket(newSocket);

    // Initial fetch
    axios.get(`${SERVER_URL}/api/config`).then(res => {
      setConfig(res.data);
      setProductionState(prev => {
        const next = { ...prev };
        Object.keys(res.data.machines).forEach(line => {
          next[line] = {
            ...next[line],
            all_machines: res.data.machines[line].map(m => m[0])
          };
        });
        return next;
      });
      axios.get(`${SERVER_URL}/api/state`).then((stateRes) => {
        setProductionState((prev) =>
          mergeProductionStateFromServer(prev, stateRes.data, res.data.machines)
        );
      }).catch(() => {});
    });

    axios.get(`${SERVER_URL}/api/jobs`).then((res) => {
      setJobQueue(res.data.jobs || []);
    }).catch(() => {});

    axios.get(`${SERVER_URL}/api/lane-completions?limit=200`).then((res) => {
      setLaneCompletions(res.data?.completions || []);
    }).catch(() => {});

    newSocket.on('connect', () => {
      console.log('✓ Socket Connected');
      newSocket.emit('request_update');
      axios.get(`${SERVER_URL}/api/predictions`).then((res) => {
        if (!showPlannerRef.current) setTimelineAnalysis(res.data);
      });
    });

    newSocket.on('line_update', (data) => {
      setProductionState(prev => ({
        ...prev,
        [data.line]: normalizeLineClientState(prev[data.line], data.state, data.status),
      }));
    });

    newSocket.on('jobs_imported', (payload) => {
      if (payload?.jobs) {
        setJobQueue(payload.jobs);
      } else {
        axios.get(`${SERVER_URL}/api/jobs`).then(res => setJobQueue(res.data.jobs || [])).catch(() => {});
      }
      axios.get(`${SERVER_URL}/api/predictions`).then((res) => {
        if (!showPlannerRef.current) setTimelineAnalysis(res.data);
      });
    });

    newSocket.on('job_progress', () => {
      axios.get(`${SERVER_URL}/api/jobs`).then(res => setJobQueue(res.data.jobs || [])).catch(() => {});
    });

    newSocket.on('lane_completion', (row) => {
      if (!row?.order_id) return;
      setLaneCompletions((prev) => {
        const id = row.id || `${row.order_id}-${row.line}-${row.finished_at}`;
        if (prev.some((r) => (r.id || `${r.order_id}-${r.line}-${r.finished_at}`) === id)) {
          return prev;
        }
        return [row, ...prev].slice(0, 500);
      });
    });

    newSocket.on('stats_update', (data) => {
      // Fetch global analysis whenever stats update
      axios.get(`${SERVER_URL}/api/predictions`).then((res) => {
        if (!showPlannerRef.current) setTimelineAnalysis(res.data);
      });
    });

    newSocket.on('config_update', (cfg) => {
      if (!cfg || typeof cfg !== 'object') return;
      setConfig((prev) => ({ ...prev, ...cfg }));
      axios.get(`${SERVER_URL}/api/state`).then((stateRes) => {
        setProductionState((prev) =>
          mergeProductionStateFromServer(prev, stateRes.data, cfg.machines)
        );
      }).catch(() => {});
    });

    // Status polling
    const fetchStatus = () => {
      axios.get(`${SERVER_URL}/api/server/status`)
        .then(res => {
          setSystemStatus({
            db: res.data.db_connected ? 'online' : 'offline',
            esp32: res.data.esp32_online ? 'online' : 'offline',
            server: 'online'
          });
        })
        .catch(() => {
          setSystemStatus({ db: 'offline', esp32: 'offline', server: 'offline' });
        });
    };

    fetchStatus();
    const statusInterval = setInterval(fetchStatus, 5000);

    const syncFromServer = () => {
      if (newSocket.connected) {
        newSocket.emit('request_update');
      }
      axios.get(`${SERVER_URL}/api/state`).then((stateRes) => {
        setProductionState((prev) => mergeProductionStateFromServer(prev, stateRes.data, config.machines));
      }).catch(() => {});
      axios.get(`${SERVER_URL}/api/predictions`).then((res) => {
        if (!showPlannerRef.current) setTimelineAnalysis(res.data);
      });
    };
    const dataSyncInterval = setInterval(syncFromServer, 20000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        syncFromServer();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      newSocket.close();
      clearInterval(statusInterval);
      clearInterval(dataSyncInterval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const setQuantityDone = (line, quantityDone) => {
    axios
      .post(`${SERVER_URL}/api/lines/quantity-done`, { line, quantity_done: quantityDone })
      .then(() => socket?.emit('request_update'))
      .catch((err) =>
        showDialog({
          title: 'Update failed',
          message: err.response?.data?.error || err.message,
          type: 'error',
          onConfirm: closeDialog,
        })
      );
  };

  const advanceLane = (line, track = 'primary') => {
    axios
      .post(`${SERVER_URL}/api/jobs/advance`, { line, track })
      .then(() => refreshTimelineAndLanes())
      .catch((err) =>
        showDialog({
          title: 'Advance failed',
          message: err.response?.data?.error || err.message,
          type: 'error',
          onConfirm: closeDialog,
        })
      );
  };

  const refreshTimelineAndLanes = () => {
    socket?.emit('request_update');
    axios.get(`${SERVER_URL}/api/predictions`).then((res) => {
      if (!showPlannerRef.current) setTimelineAnalysis(res.data);
    }).catch(() => {});
    axios.get(`${SERVER_URL}/api/jobs`).then((res) => setJobQueue(res.data.jobs || [])).catch(() => {});
    axios.get(`${SERVER_URL}/api/lane-completions?limit=200`).then((res) => {
      setLaneCompletions(res.data?.completions || []);
    }).catch(() => {});
  };

  const formatBulkResults = (results) => {
    if (!Array.isArray(results) || results.length === 0) return 'No lanes updated.';
    return results
      .map((r) => {
        const lane = String(r.line || '').toUpperCase();
        const job = r.order_id ? ` (${r.order_id})` : '';
        if (r.success) return `${lane}${job}: ${r.message || 'OK'}`;
        return `${lane}: ${r.message || 'skipped'}`;
      })
      .join('\n');
  };

  /** Bulk lane API with fallback to per-lane /api/command (older backend without pause-all/end-all). */
  const runBulkLaneAction = async (bulkPath, command, laneFilter, skipLabel) => {
    const lanes = selectedLanes;
    try {
      return await axios.post(
        `${SERVER_URL}${bulkPath}`,
        { lines: lanes },
        { timeout: 120000 }
      );
    } catch (err) {
      const status = err.response?.status;
      const useFallback =
        !err.response || err.code === 'ERR_NETWORK' || status === 404 || status === 405;
      if (!useFallback) throw err;

      const results = [];
      let anyOk = false;
      for (const line of lanes) {
        const st = productionState[line]?.status;
        if (!laneFilter(st)) {
          results.push({
            line,
            success: false,
            message: skipLabel(st),
          });
          continue;
        }
        try {
          await axios.post(
            `${SERVER_URL}/api/command`,
            { line, command },
            { timeout: 60000 }
          );
          results.push({ line, success: true, message: `${command} applied` });
          anyOk = true;
        } catch (cmdErr) {
          const msg =
            cmdErr.response?.data?.error ||
            cmdErr.response?.data?.message ||
            cmdErr.message ||
            'Command failed';
          results.push({ line, success: false, message: msg });
        }
      }
      return { data: { success: anyOk, results, fallback: true } };
    }
  };

  const [selectedLanes, setSelectedLanes] = useState([...FACTORY_LANES]);

  const toggleSelectedLane = (lane) => {
    setSelectedLanes((prev) => {
      if (prev.includes(lane)) {
        const next = prev.filter((l) => l !== lane);
        return next.length > 0 ? next : prev;
      }
      return [...prev, lane];
    });
  };

  const selectAllLanes = () => setSelectedLanes([...FACTORY_LANES]);

  const jobPlacedOnLane = (job, lane) => {
    const ln = String(lane).toLowerCase();
    const oid = job?.order_id;
    if (oid && String(productionState[ln]?.order_id || '') === String(oid)) return true;
    const active = (job?.active_lines || []).map((x) => String(x).toLowerCase());
    if (active.includes(ln)) return true;
    const queued = (job?.queued_lanes || []).map((x) => String(x).toLowerCase());
    if (queued.includes(ln)) return true;
    const lq = productionState[ln]?.lane_queue;
    if (Array.isArray(lq) && lq.some((item) => laneQueueOrderId(item) === String(oid))) return true;
    const parallel = lineParallelJobs(productionState[ln]);
    if (parallel.some((p) => String(p.order_id) === String(oid))) return true;
    return false;
  };

  const jobsWaitingDeploy = jobQueue.filter((j) => {
    const st = String(j.status || '').toUpperCase();
    if (st === 'FINISHED' || st === 'CANCELLED') return false;
    return FACTORY_LANES.some((ln) => !jobPlacedOnLane(j, ln));
  });
  const uniqueOnFloor = new Set(
    FACTORY_LANES.flatMap((ln) => [
      productionState[ln]?.order_id,
      ...lineParallelJobs(productionState[ln]).map((p) => p.order_id),
    ]).filter(Boolean)
  ).size;
  const laneAssignments = FACTORY_LANES.map((ln) => ({
    line: ln,
    orderId: productionState[ln]?.order_id || null,
    status: productionState[ln]?.status || 'STOPPED',
  }));

  const laneCanDeploy = (lane) => {
    const st = String(productionState[lane]?.status || 'STOPPED').toUpperCase();
    return st !== 'RUNNING' && st !== 'PAUSED' && st !== 'READY';
  };
  const laneCanQueueJob = (lane) => {
    const st = String(productionState[lane]?.status || 'STOPPED').toUpperCase();
    return st === 'RUNNING' || st === 'PAUSED' || st === 'READY';
  };
  const jobNeedsMoreSelectedLanes = (job) => {
    const targets = selectedLanes.length > 0 ? selectedLanes : FACTORY_LANES;
    return targets.some((ln) => !jobPlacedOnLane(job, ln));
  };

  const laneCanStart = (lane) => productionState[lane]?.status === 'READY';
  const laneCanResume = (lane) => productionState[lane]?.status === 'PAUSED';
  const laneCanPause = (lane) => productionState[lane]?.status === 'RUNNING';
  const laneCanEnd = (lane) => {
    const st = productionState[lane]?.status;
    return st === 'RUNNING' || st === 'PAUSED' || st === 'READY';
  };
  const laneCanAdvance = (lane) => productionState[lane]?.status === 'RUNNING';

  const canDeploySelected =
    jobsWaitingDeploy.length > 0 &&
    selectedLanes.some((ln) => laneCanDeploy(ln) || laneCanQueueJob(ln));
  const canStartSelected = selectedLanes.some(laneCanStart);
  const canResumeSelected = selectedLanes.some(laneCanResume);
  const canPauseSelected = selectedLanes.some(laneCanPause);
  const canEndSelected = selectedLanes.some(laneCanEnd);
  const canAdvanceSelected = selectedLanes.some(laneCanAdvance);

  const deployJobToAllLanes = async (orderId) => {
    if (!orderId) return;
    const lines = selectedLanes.length > 0 ? selectedLanes : [...FACTORY_LANES];
    try {
      const res = await axios.post(
        `${SERVER_URL}/api/lines/deploy-all`,
        { lines, order_id: orderId },
        { timeout: 120000 }
      );
      const results = res.data?.results || [];
      if (
        !res.data?.success ||
        results.some((r) => !r.success && !r.skipped)
      ) {
        showDialog({
          title: 'Deploy to all lanes',
          message: formatBulkResults(results),
          type: 'info',
          onConfirm: closeDialog,
        });
      }
      refreshTimelineAndLanes();
    } catch (err) {
      const resultList = err.response?.data?.results;
      if (err.response?.status === 400 && Array.isArray(resultList)) {
        showDialog({
          title: 'Deploy to all lanes',
          message: formatBulkResults(resultList),
          type: 'info',
          onConfirm: closeDialog,
        });
        refreshTimelineAndLanes();
        return;
      }
      showDialog({
        title: 'Deploy to all lanes',
        message: err.response?.data?.error || err.message || 'Deploy failed',
        type: 'error',
        onConfirm: closeDialog,
      });
    }
  };

  const deployAllLanes = async () => {
    const targetLanes = [...FACTORY_LANES];
    if (targetLanes.length === 0) return;
    if (jobsWaitingDeploy.length === 0) {
      showDialog({
        title: 'Deploy next',
        message:
          'Every job is already on all selected lanes. Add a new job to the queue or clear a lane first.',
        type: 'info',
        onConfirm: closeDialog,
      });
      return;
    }
    try {
      const res = await axios.post(
        `${SERVER_URL}/api/lines/deploy-all`,
        { lines: targetLanes },
        { timeout: 120000 }
      );
      const summary = formatBulkResults(res.data?.results);
      const results = res.data?.results || [];
      const anyQueued = results.some(
        (r) => r.success && String(r.message || '').toLowerCase().includes('queued')
      );
      const anyStarted = results.some(
        (r) => r.success && String(r.message || '').toLowerCase().includes('started')
      );
      if (
        anyQueued ||
        anyStarted ||
        !res.data?.success ||
        results.some((r) => !r.success && !r.skipped)
      ) {
        showDialog({
          title: anyStarted ? 'Deployed and started' : anyQueued ? 'Queued for lane' : 'Deploy next',
          message: summary,
          type: 'info',
          onConfirm: closeDialog,
        });
      }
      refreshTimelineAndLanes();
    } catch (err) {
      const resultList = err.response?.data?.results;
      if (err.response?.status === 400 && Array.isArray(resultList)) {
        showDialog({
          title: 'Deploy next',
          message: formatBulkResults(resultList),
          type: 'info',
          onConfirm: closeDialog,
        });
        refreshTimelineAndLanes();
        return;
      }
      const msg = err.code === 'ECONNABORTED'
        ? 'Server took too long. Restart the backend and try again.'
        : (err.response?.data?.error || err.message || 'Deployment failed');
      showDialog({
        title: 'Deploy next',
        message: msg,
        type: 'error',
        onConfirm: closeDialog,
      });
    }
  };

  const startAllLanes = async () => {
    if (selectedLanes.length === 0) return;
    const readyLanes = selectedLanes.filter(laneCanStart);
    if (readyLanes.length === 0) {
      showDialog({
        title: 'Start lanes',
        message: 'No READY lanes selected. Deploy a job first, or use Pause/Resume for paused lanes.',
        type: 'info',
        onConfirm: closeDialog,
      });
      return;
    }
    try {
      const res = await axios.post(
        `${SERVER_URL}/api/lines/start-all`,
        { lines: readyLanes },
        { timeout: 120000 }
      );
      if (!res.data?.success) {
        showDialog({
          title: 'Start all lanes',
          message: formatBulkResults(res.data?.results),
          type: 'info',
          onConfirm: closeDialog,
        });
      } else if (res.data?.arduino_updated) {
        showDialog({
          title: 'Lanes started',
          message:
            'Server state updated and batch.ino was synced (WiFi / server IP). Re-upload firmware to the ESP32 if it is not already on this network.',
          type: 'info',
          onConfirm: closeDialog,
        });
      }
      refreshTimelineAndLanes();
    } catch (err) {
      showDialog({
        title: 'Start all lanes',
        message: err.response?.data?.error || err.message || 'Start failed',
        type: 'error',
        onConfirm: closeDialog,
      });
    }
  };

  const resumeAllLanes = async () => {
    if (selectedLanes.length === 0) return;
    try {
      const res = await runBulkLaneAction(
        '/api/lines/resume-all',
        'RESUME',
        (st) => st === 'PAUSED',
        (st) => `Skipped (${st || 'idle'})`
      );
      if (!res.data?.success) {
        showDialog({
          title: 'Resume lanes',
          message: formatBulkResults(res.data?.results),
          type: 'info',
          onConfirm: closeDialog,
        });
      }
      refreshTimelineAndLanes();
    } catch (err) {
      const msg =
        err.response?.data?.error ||
        err.message ||
        'Resume failed';
      showDialog({
        title: 'Resume lanes',
        message: msg,
        type: 'error',
        onConfirm: closeDialog,
      });
    }
  };


  const runLaneCommand = async (line, command) => {
    try {
      await axios.post(
        `${SERVER_URL}/api/command`,
        { line, command: String(command).toUpperCase() },
        { timeout: 60000 }
      );
      refreshTimelineAndLanes();
    } catch (err) {
      showDialog({
        title: `${String(command).toUpperCase()} ${String(line).toUpperCase()}`,
        message: err.response?.data?.error || err.response?.data?.message || err.message || 'Command failed',
        type: 'error',
        onConfirm: closeDialog,
      });
    }
  };

  const pauseAllLanes = async () => {
    if (selectedLanes.length === 0) return;
    const runningSelected = selectedLanes.filter((ln) => productionState[ln]?.status === 'RUNNING');
    if (runningSelected.length === 0) {
      showDialog({
        title: 'Pause lanes',
        message: 'No RUNNING lanes are checked. Uncheck lanes you do not want to pause, or use Pause on a single lane card.',
        type: 'info',
        onConfirm: closeDialog,
      });
      return;
    }
    try {
      const res = await runBulkLaneAction(
        '/api/lines/pause-all',
        'PAUSE',
        (st) => st === 'RUNNING',
        (st) => `Skipped (${st || 'idle'})`
      );
      if (!res.data?.success) {
        showDialog({
          title: 'Pause lanes',
          message: formatBulkResults(res.data?.results),
          type: 'info',
          onConfirm: closeDialog,
        });
      }
      refreshTimelineAndLanes();
    } catch (err) {
      const msg =
        err.response?.data?.error ||
        (typeof err.response?.data === 'string' ? '' : null) ||
        err.message ||
        'Pause failed';
      showDialog({
        title: 'Pause lanes',
        message: msg.includes('Network') ? `${msg} — Is the backend running on ${SERVER_URL}? Restart server after updates.` : msg,
        type: 'error',
        onConfirm: closeDialog,
      });
    }
  };

  const endAllLanes = async () => {
    if (selectedLanes.length === 0) return;
    try {
      const res = await runBulkLaneAction(
        '/api/lines/end-all',
        'END',
        (st) => st === 'RUNNING' || st === 'PAUSED' || st === 'READY',
        (st) => `Skipped (${st || 'idle'})`
      );
      if (!res.data?.success) {
        showDialog({
          title: 'End lanes',
          message: formatBulkResults(res.data?.results),
          type: 'info',
          onConfirm: closeDialog,
        });
      }
      refreshTimelineAndLanes();
    } catch (err) {
      showDialog({
        title: 'End lanes',
        message: err.response?.data?.error || err.message || 'End failed',
        type: 'error',
        onConfirm: closeDialog,
      });
    }
  };

  const advanceAllLanes = async () => {
    if (selectedLanes.length === 0) return;
    try {
      const res = await axios.post(
        `${SERVER_URL}/api/lines/advance-all`,
        { lines: selectedLanes },
        { timeout: 120000 }
      );
      if (!res.data?.success) {
        showDialog({
          title: 'Advance all lanes',
          message: formatBulkResults(res.data?.results),
          type: 'info',
          onConfirm: closeDialog,
        });
      }
      refreshTimelineAndLanes();
    } catch (err) {
      showDialog({
        title: 'Advance all lanes',
        message: err.response?.data?.error || err.message || 'Advance failed',
        type: 'error',
        onConfirm: closeDialog,
      });
    }
  };

  const clearSelectedLanes = () => {
    if (selectedLanes.length === 0) return;
    showDialog({
      title: 'Clear selected lanes?',
      message:
        'Resets the chosen lanes to idle (no job on the line, stepper cleared). Jobs stay in the queue.',
      type: 'warning',
      confirmText: 'Clear lanes',
      cancelText: 'Cancel',
      onConfirm: () => {
        closeDialog();
        axios
          .post(`${SERVER_URL}/api/lines/clear`, { lines: selectedLanes }, { timeout: 60000 })
          .then((res) => {
            if (!res.data?.success) {
              showDialog({
                title: 'Clear lanes',
                message: formatBulkResults(res.data?.results),
                type: 'info',
                onConfirm: closeDialog,
              });
            }
            refreshTimelineAndLanes();
          })
          .catch((err) =>
            showDialog({
              title: 'Clear lanes',
              message: err.response?.data?.error || err.message || 'Clear failed',
              type: 'error',
              onConfirm: closeDialog,
            })
          );
      },
    });
  };

  const resetAllServerData = () => {
    showDialog({
      title: 'Clear all server data?',
      message:
        'This deletes every job, activity log, and line assignment on the server. Factory machine/material settings are kept until you save them. Arduino batch numbers on the device are not cleared.',
      type: 'warning',
      confirmText: 'Clear everything',
      cancelText: 'Cancel',
      onConfirm: () => {
        closeDialog();
        axios
          .post(`${SERVER_URL}/api/admin/reset-all`)
          .then(() => {
            setJobQueue([]);
            setProductionState({
              door: { status: 'STOPPED', current_machine: null, batch_id: 0, quantity: 0, order_id: null, all_machines: config.machines?.door?.map((m) => m[0]) || [] },
              frame: { status: 'STOPPED', current_machine: null, batch_id: 0, quantity: 0, order_id: null, all_machines: config.machines?.frame?.map((m) => m[0]) || [] },
              arch: { status: 'STOPPED', current_machine: null, batch_id: 0, quantity: 0, order_id: null, all_machines: config.machines?.arch?.map((m) => m[0]) || [] },
            });
            return axios.get(`${SERVER_URL}/api/predictions`);
          })
          .then((res) => setTimelineAnalysis(res.data))
          .catch((err) =>
            showDialog({
              title: 'Reset failed',
              message: err.response?.data?.error || err.message,
              type: 'error',
              onConfirm: closeDialog,
            })
          );
      },
      onCancel: closeDialog,
    });
  };

  const deleteJob = (orderId) => {
    showDialog({
      title: 'Confirm Deletion',
      message: `Are you sure you want to delete job ${orderId}? This action cannot be undone.`,
      type: 'warning',
      confirmText: 'Delete',
      onConfirm: () => {
        axios.post(`${SERVER_URL}/api/jobs/delete`, { order_id: orderId })
          .then(() => socket?.emit('request_update'));
        closeDialog();
      },
      onCancel: closeDialog
    });
  };


  const handleShowPlanner = () => {
    showPlannerRef.current = true;
    setPlannerData(prev => ({
      ...prev,
      order_id: `JOB-${Math.floor(Math.random() * 1000000)}`,
      materials: [],
      quantity: 1,
      line: 'door'
    }));
    setPlannerAnalysisSynced(false);
    setShowPlanner(true);
  };

  const handleToggleMaterial = (matName) => {
    setPlannerData(prev => {
      const exists = prev.materials.some(m => m.name === matName);
      if (exists) {
        return { ...prev, materials: prev.materials.filter(m => m.name !== matName) };
      } else {
        return { ...prev, materials: [...prev.materials, { name: matName }] };
      }
    });
  };

  const analyzeJob = () => {
    return axios.post(`${SERVER_URL}/api/analyze-job`, plannerData)
      .then(res => {
        setTimelineAnalysis(res.data);
        setPlannerAnalysisSynced(true);
        return res.data;
      })
      .catch(err => {
        showDialog({ title: 'Analysis Error', message: err.response?.data?.error || "Analysis failed", type: 'error', onConfirm: closeDialog });
        return null;
      });
  };

  const submitJob = async () => {
    let analysis = null;
    if (plannerAnalysisSynced && timelineAnalysis) {
      analysis = timelineAnalysis;
    } else {
      try {
        const res = await axios.post(`${SERVER_URL}/api/analyze-job`, plannerData);
        analysis = res.data;
        setTimelineAnalysis(res.data);
        setPlannerAnalysisSynced(true);
      } catch (e) {
        analysis = null;
      }
    }

    const payload = {
      ...plannerData,
      decision: analysis?.decision,
      start_days: analysis?.new_order_start_days,
      finish_days: analysis?.expected_finish_days,
    };
    try {
      await axios.post(`${SERVER_URL}/api/add-job`, payload);
      closePlanner();
      socket?.emit('request_update');
    } catch (err) {
      showDialog({ title: 'Failed to add job', message: err.response?.data?.error || err.message || 'Could not save the job.', type: 'error', onConfirm: closeDialog });
    }
  };

  const downloadFile = (url, fallbackName) => {
    setExporting(true);
    axios.get(url, { responseType: 'blob' })
      .then(res => {
        const blob = new Blob([res.data], { type: res.headers['content-type'] });
        const disp = res.headers['content-disposition'] || '';
        const match = /filename="?([^";]+)"?/i.exec(disp);
        const name = match ? match[1] : fallbackName;
        const link = document.createElement('a');
        link.href = window.URL.createObjectURL(blob);
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(link.href);
      })
      .catch(err => {
        const msg = err.response?.data?.error || err.message || 'Export failed';
        showDialog({ title: 'Export Error', message: msg, type: 'error', onConfirm: closeDialog });
      })
      .finally(() => setExporting(false));
  };

  const exportJobs = (format = 'csv', scope = 'active') => {
    if (scope === 'active' && jobQueue.length === 0) {
      showDialog({ title: 'Nothing to Export', message: 'The active job queue is empty.', type: 'info', onConfirm: closeDialog });
      return;
    }
    const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    downloadFile(
      `${SERVER_URL}/api/jobs/export?format=${format}&scope=${scope}`,
      `job_orders_${ts}.${format === 'xlsx' ? 'xlsx' : 'csv'}`
    );
  };

  const exportProductionLog = (format = 'xlsx') => {
    const rows = buildUnifiedProductionRows(jobQueue, laneCompletions, productionState);
    if (rows.length === 0) {
      showDialog({
        title: 'Nothing to Export',
        message: 'No jobs in the production log yet.',
        type: 'info',
        onConfirm: closeDialog,
      });
      return;
    }
    const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    downloadFile(
      `${SERVER_URL}/api/production-log/export?format=${format}`,
      `production_log_${ts}.${format === 'xlsx' ? 'xlsx' : 'csv'}`
    );
  };

  const formatCompletionTime = (iso) => {
    if (!iso) return '—';
    const d = parseServerIso(iso);
    if (!Number.isFinite(d)) return String(iso);
    return new Date(d).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const exportQuarterlyReport = () => {
    const { year, quarter, format } = reportConfig;
    const ext = format === 'csv' ? 'zip' : 'xlsx';
    downloadFile(
      `${SERVER_URL}/api/reports/quarterly?year=${year}&quarter=${quarter}&format=${format}`,
      `quarterly_report_Q${quarter}_${year}.${ext}`
    );
    setShowReportModal(false);
  };

  return (
    <div className="app-container">
      <aside className="sidebar">
        <div className="logo">
          <Zap size={24} color="#ffb800" fill="#ffb800" />
        </div>

        <nav className="side-nav">
          <button className={activeTab === 'summary' ? 'active' : ''} onClick={() => setActiveTab('summary')}>
            <LayoutDashboard size={20} /> Dashboard
          </button>
          <button className={activeTab === 'logs' ? 'active' : ''} onClick={() => setActiveTab('logs')}>
            <FileText size={20} /> Activity Logs
          </button>
          <button className={activeTab === 'settings' ? 'active' : ''} onClick={() => setActiveTab('settings')}>
            <Settings size={20} /> Settings
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="status-group">
            <div className="status-item">
              <div className={`status-dot ${systemStatus.server}`}></div>
              <span>System</span>
            </div>
            <div className="status-item">
              <div className={`status-dot ${systemStatus.db}`}></div>
              <span>Database</span>
            </div>
            <div className="status-item">
              <div className={`status-dot ${systemStatus.esp32}`}></div>
              <span>ESP32 Hub</span>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="top-bar">
          <div className="search-bar">
            <h1>{activeTab.toUpperCase()}</h1>
          </div>
          <div className="user-profile">
            <button
              className="btn-secondary btn-report"
              onClick={() => setShowReportModal(true)}
              title="Generate quarterly factory report"
            >
              <Calendar size={18} /> Quarterly Report
            </button>
            <button className="btn-planner" onClick={handleShowPlanner}>
              <Plus size={18} /> New Job
            </button>
          </div>
        </header>

        <div className="dashboard-content">
          {activeTab === 'summary' && (
            <div className="all-lines-stack">
              {timelineAnalysis && (
                <ProductionTimelineAdvisor analysis={timelineAnalysis} variant="banner" />
              )}

              {(() => {
                const queued = jobQueue.filter((j) => String(j.status || '').toUpperCase() === 'QUEUED');
                const queuedUnassigned = queued.filter((j) => !j.line && !(Array.isArray(j.active_lines) && j.active_lines.length > 0));
                const rawEff = Number(timelineAnalysis?.factory_efficiency);
                const eff = Number.isFinite(rawEff) ? rawEff : 0;
                const nextAvailableDays =
                  (timelineAnalysis?.show_new_order_timeline === false
                    || (timelineAnalysis?.committed_order_count ?? 1) <= 1)
                    ? 0
                    : Number(timelineAnalysis?.new_order_start_days || 0);

                return (
              <div className="stats-grid">
                <div className="stat-card kpi-premium">
                  <div className="kpi-icon queue"><LayoutDashboard size={24} /></div>
                  <div className="kpi-content">
                    <div className="stat-label">Queue Backlog</div>
                    <div className="stat-value">{queued.length} <small>Jobs</small></div>
                    <div className="kpi-trend">
                      {queuedUnassigned.length} waiting for allocation
                    </div>
                  </div>
                </div>

                <div className="stat-card kpi-premium">
                  <div className="kpi-icon efficiency"><Zap size={24} /></div>
                  <div className="kpi-content">
                    <div className="stat-label">Factory Efficiency</div>
                    <div className="stat-value">{eff.toFixed(1)}<small>%</small></div>
                    <div className="kpi-trend positive">Real-time performance</div>
                  </div>
                </div>

                <div className="stat-card kpi-premium">
                  <div className="kpi-icon timeline"><Clock size={24} /></div>
                  <div className="kpi-content">
                    <div className="stat-label">Next Available</div>
                    <div className="stat-value">{Math.max(0, Math.round(nextAvailableDays))}<small>days</small></div>
                    <div className="kpi-trend">Projected readiness</div>
                  </div>
                </div>


              </div>
                );
              })()}

              <AllLanesControlStrip
                productionState={productionState}
                jobQueue={jobQueue}
                configMachines={config.machines}
                selectedLanes={selectedLanes}
                onToggleLane={toggleSelectedLane}
                onSelectAllLanes={selectAllLanes}
                onDeploy={deployAllLanes}
                onStart={startAllLanes}
                onResume={resumeAllLanes}
                onPause={pauseAllLanes}
                onEnd={endAllLanes}
                onAdvance={advanceAllLanes}
                onClear={clearSelectedLanes}
                canDeploy={canDeploySelected}
                canStart={canStartSelected}
                canResume={canResumeSelected}
                canPause={canPauseSelected}
                canEnd={canEndSelected}
                canAdvance={canAdvanceSelected}
                autoScheduling={Boolean(config.auto_pull_next_job && config.auto_start_deployed_jobs !== false)}
              />

              <div className="lines-vertical-stack">
                {Object.entries(productionState).map(([line, state]) => (
                  <ProductionLineView
                    key={line}
                    line={line}
                    state={state}
                    configMachines={config.machines && config.machines[line]}
                    laneStageCapMins={config.lane_queue_stage_cap_mins ?? 8}
                    autoAdvanceStages={config.auto_advance_stages !== false}
                    jobQueue={jobQueue}
                    onQuantityDoneChange={setQuantityDone}
                    onAdvanceStage={advanceLane}
                    onLaneCommand={runLaneCommand}
                    activeJob={jobQueue.find((j) => String(j.order_id) === String(state.order_id))}
                    timelineAnalysis={timelineAnalysis}
                    isSelected={selectedLanes.includes(line)}
                  />
                ))}
              </div>

              {(() => {
                const productionRows = buildUnifiedProductionRows(
                  jobQueue,
                  laneCompletions,
                  productionState
                );
                const activeCount = productionRows.filter(
                  (r) => r.status !== 'FINISHED' && r.status !== 'CANCELLED'
                ).length;
                const finishedCount = productionRows.filter(
                  (r) => r.status === 'FINISHED'
                ).length;
                const partialCount = productionRows.filter(
                  (r) => r.status === 'IN PROGRESS'
                ).length;
                return (
              <div className="queue-section">
                <div className="queue-section-header">
                  <div className="queue-title-row">
                    <div className="queue-title-group">
                      <h2>Production jobs</h2>
                      <span className="queue-count-pill">
                        {productionRows.length}{' '}
                        {productionRows.length === 1 ? 'job' : 'jobs'}
                      </span>
                    </div>
                    <div className="queue-export-group">
                      <button
                        type="button"
                        className="btn-export csv"
                        onClick={() => exportProductionLog('csv')}
                        disabled={exporting}
                        title="Export production log (CSV)"
                      >
                        <FileDown size={16} /> CSV
                      </button>
                      <button
                        type="button"
                        className="btn-export xlsx"
                        onClick={() => exportProductionLog('xlsx')}
                        disabled={exporting}
                        title="Export production log (Excel)"
                      >
                        <FileSpreadsheet size={16} /> Excel
                      </button>
                    </div>
                  </div>
                  <p className="queue-subtitle">
                    {jobsWaitingDeploy.length} waiting for a lane · {uniqueOnFloor} on the floor ·{' '}
                    {activeCount} active
                    {partialCount > 0 ? ` · ${partialCount} partial` : ''}
                    {finishedCount > 0 ? ` · ${finishedCount} finished` : ''}
                    {' '}
                    — FINISHED only when door, frame, and arch are all Done
                  </p>
                </div>
                <div className="queue-lane-map" aria-label="Lane assignments">
                  {laneAssignments.map(({ line, orderId, status }) => (
                    <span
                      key={line}
                      className={`queue-lane-map-chip${orderId ? ' has-job' : ''}`}
                      title={orderId ? `${orderId} (${status})` : 'Idle'}
                    >
                      <strong>{line.toUpperCase()}</strong>
                      <span>{orderId || 'idle'}</span>
                    </span>
                  ))}
                </div>
                <div className="table-container queue-table production-table-4col">
                  <table>
                    <thead>
                      <tr>
                        <th>Order</th>
                        <th>Lanes (door · frame · arch)</th>
                        <th style={{ textAlign: 'center' }}>Qty</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {productionRows.length === 0 ? (
                        <tr className="queue-empty-row">
                          <td colSpan="4">
                            <div className="queue-empty-state">
                              <LayoutDashboard size={32} />
                              <h4>No jobs yet</h4>
                              <p>Add a job or finish one on a lane to see it here.</p>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        productionRows.map((row) => {
                          const job = row.job;
                          const importedAt = row.imported_at ? new Date(row.imported_at) : null;
                          const importedLabel =
                            importedAt && !isNaN(importedAt)
                              ? importedAt.toLocaleString(undefined, {
                                  month: 'short',
                                  day: 'numeric',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })
                              : null;
                          const finishedLabel = row.last_finished_at
                            ? formatCompletionTime(row.last_finished_at)
                            : null;
                          const st = String(row.status || '').toUpperCase();
                          const canDeployJob =
                            job &&
                            jobNeedsMoreSelectedLanes(job) &&
                            st !== 'FINISHED' &&
                            st !== 'CANCELLED';
                          return (
                            <tr
                              key={row.order_id}
                              className={`queue-row${st === 'FINISHED' ? ' queue-row--finished' : ''}`}
                            >
                              <td className="cell-order">
                                <div className="cell-stack">
                                  <span className="job-id">{row.order_id}</span>
                                  {importedLabel ? (
                                    <span className="cell-sub">
                                      <Clock size={11} /> Added {importedLabel}
                                    </span>
                                  ) : null}
                                  {finishedLabel ? (
                                    <span className="cell-sub">Finished {finishedLabel}</span>
                                  ) : null}
                                </div>
                                {(job || st === 'IN PROGRESS') ? (
                                  <div className="production-table-actions">
                                    {(canDeployJob ||
                                      (st === 'IN PROGRESS' &&
                                        FACTORY_LANES.some(
                                          (ln) => row.laneStates[ln] === 'IDLE'
                                        ))) ? (
                                      <button
                                        type="button"
                                        className="btn-deploy-queue"
                                        title="Deploy to remaining lanes"
                                        onClick={() => deployJobToAllLanes(row.order_id)}
                                      >
                                        <Download size={14} /> Deploy
                                      </button>
                                    ) : null}
                                    {job ? (
                                      <button
                                        type="button"
                                        className="btn-delete"
                                        title="Delete job"
                                        onClick={() => deleteJob(job.order_id)}
                                      >
                                        <Trash2 size={14} />
                                      </button>
                                    ) : null}
                                  </div>
                                ) : null}
                              </td>
                              <td>
                                <div className="lane-status-row" role="group" aria-label="Lane status">
                                  {FACTORY_LANES.map((ln) => {
                                    const ls = row.laneStates[ln] || 'IDLE';
                                    return (
                                      <span
                                        key={`${row.order_id}-${ln}`}
                                        className={`lane-status-chip lane-status-chip--${ls.toLowerCase().replace(/\s+/g, '-')}`}
                                        title={`${ln}: ${ls}`}
                                      >
                                        <span className="lane-status-chip-name">{ln}</span>
                                        <span className="lane-status-chip-val">
                                          {laneChipLabel(ls)}
                                        </span>
                                      </span>
                                    );
                                  })}
                                </div>
                              </td>
                              <td style={{ textAlign: 'center' }}>
                                <span className="qty-pill">
                                  {row.quantity_done != null && row.quantity_done !== ''
                                    ? row.quantity_done
                                    : '—'}
                                  <span className="cell-sub" style={{ display: 'block' }}>
                                    / {row.quantity ?? '—'}
                                  </span>
                                </span>
                              </td>
                              <td className="production-table-status-cell">
                                {renderStatusBadge(row.status)}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
                );
              })()}
            </div>
          )}

          {activeTab === 'logs' && <LogView />}
          {activeTab === 'settings' && (
            <SettingsView
              config={config}
              serverUrl={SERVER_URL}
              onResetAll={resetAllServerData}
              onSave={(c) => {
                axios.post(`${SERVER_URL}/api/config`, c).then(() => {
                  setConfig(c);
                  refreshTimelineAndLanes();
                  axios.get(`${SERVER_URL}/api/predictions`).then((res) => {
                    if (!showPlannerRef.current) setTimelineAnalysis(res.data);
                  });
                });
              }}
            />
          )}
        </div>
      </main>

      {showPlanner && (
        <div className="modal-overlay">
          <div className="modal-content planner-modal">
            <div className="modal-header">
              <h2>Add New Production Job</h2>
              <button className="btn-close" onClick={closePlanner}>&times;</button>
            </div>
            <div className="modal-body">
              <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
                <div className="form-group">
                  <label>Order ID</label>
                  <input value={plannerData.order_id} onChange={(e) => setPlannerData({ ...plannerData, order_id: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>Production Line</label>
                  <select
                    value={plannerData.line}
                    disabled
                    style={{ width: '100%', padding: '0.75rem', background: 'rgba(0,0,0,0.05)', border: '1px solid var(--border)', color: 'rgba(0,0,0,0.5)', borderRadius: '8px', cursor: 'not-allowed' }}
                  >
                    <option value="door">Door Line (Start)</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Quantity</label>
                  <input type="number" min="1" value={plannerData.quantity} onChange={(e) => setPlannerData({ ...plannerData, quantity: parseInt(e.target.value) })} />
                </div>
              </div>

              <div className="materials-section" style={{ marginTop: '1.5rem' }}>
                <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3>Required Materials</h3>
                  <button
                    onClick={() => setPlannerData(prev => {
                      const allMats = Object.keys(config.materials || {});
                      return {
                        ...prev,
                        materials: prev.materials.length === allMats.length ? [] : allMats.map(name => ({ name }))
                      };
                    })}
                    style={{
                      background: 'rgba(56, 189, 248, 0.1)',
                      border: '1px solid rgba(56, 189, 248, 0.2)',
                      color: 'var(--accent)',
                      padding: '0.4rem 0.8rem',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '0.9rem',
                      fontWeight: '600'
                    }}
                  >
                    {plannerData.materials.length === Object.keys(config.materials || {}).length ? "Deselect All" : "Select All"}
                  </button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '1rem' }}>
                  {Object.entries(config.materials || {}).map(([mat, lead]) => {
                    const isSelected = plannerData.materials.some(m => m.name === mat);
                    return (
                      <div
                        key={mat}
                        onClick={() => handleToggleMaterial(mat)}
                        style={{
                          padding: '0.75rem 1rem',
                          borderRadius: '12px',
                          border: isSelected ? '1px solid var(--primary)' : '1px solid var(--border)',
                          background: isSelected ? 'rgba(48, 84, 150, 0.1)' : 'rgba(0, 0, 0, 0.03)',
                          color: isSelected ? 'var(--text)' : 'var(--text-dim)',
                          cursor: 'pointer',
                          fontSize: '1rem',
                          fontWeight: isSelected ? '600' : '400',
                          transition: 'all 0.2s',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                          <div style={{
                            width: '16px', height: '16px', borderRadius: '4px',
                            border: '1px solid var(--border)', background: isSelected ? 'var(--primary)' : 'transparent',
                            display: 'flex', alignItems: 'center', justifyContent: 'center'
                          }}>
                            {isSelected && <div style={{ width: '8px', height: '8px', borderRadius: '2px', background: 'var(--text)' }}></div>}
                          </div>
                          <span>{mat}</span>
                        </div>
                        <span style={{ fontSize: '0.85rem', color: isSelected ? 'var(--accent)' : 'var(--text-dim)', background: 'rgba(0,0,0,0.2)', padding: '2px 8px', borderRadius: '10px' }}>
                          {lead} days lead
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {plannerAnalysisSynced && timelineAnalysis && (
                <ProductionTimelineAdvisor
                  analysis={timelineAnalysis}
                  variant="modal"
                />
              )}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={analyzeJob} title="Preview timeline analysis before adding">
                <Zap size={16} /> Analyze Timeline
              </button>
              <button className="btn-primary" onClick={submitJob} title="Adds the job and auto-analyzes the timeline">
                <Plus size={16} /> Add to Production Queue
              </button>
            </div>
          </div>
        </div>
      )}

      {showReportModal && (
        <div className="modal-overlay" onClick={() => setShowReportModal(false)}>
          <div className="modal-content report-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2><Calendar size={22} /> Quarterly Factory Report</h2>
              <button className="btn-close" onClick={() => setShowReportModal(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <p className="report-intro">
                Generate a comprehensive report for the selected quarter. The report
                includes summary KPIs, job orders, completed batches, and a full event log.
              </p>

              <div className="report-grid">
                <div className="form-group">
                  <label>Year</label>
                  <select
                    value={reportConfig.year}
                    onChange={(e) => setReportConfig({ ...reportConfig, year: parseInt(e.target.value) })}
                  >
                    {[0, 1, 2, 3, 4].map(offset => {
                      const y = currentYear - offset;
                      return <option key={y} value={y}>{y}</option>;
                    })}
                  </select>
                </div>

                <div className="form-group">
                  <label>Quarter</label>
                  <div className="quarter-picker">
                    {[1, 2, 3, 4].map(q => (
                      <button
                        key={q}
                        type="button"
                        className={`quarter-btn ${reportConfig.quarter === q ? 'active' : ''}`}
                        onClick={() => setReportConfig({ ...reportConfig, quarter: q })}
                      >
                        Q{q}
                        <span className="quarter-months">
                          {q === 1 && 'Jan – Mar'}
                          {q === 2 && 'Apr – Jun'}
                          {q === 3 && 'Jul – Sep'}
                          {q === 4 && 'Oct – Dec'}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="form-group">
                  <label>Format</label>
                  <div className="format-picker">
                    <button
                      type="button"
                      className={`format-btn ${reportConfig.format === 'xlsx' ? 'active' : ''}`}
                      onClick={() => setReportConfig({ ...reportConfig, format: 'xlsx' })}
                    >
                      <FileSpreadsheet size={18} />
                      <div>
                        <strong>Excel (.xlsx)</strong>
                        <span>Multi-sheet workbook</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      className={`format-btn ${reportConfig.format === 'csv' ? 'active' : ''}`}
                      onClick={() => setReportConfig({ ...reportConfig, format: 'csv' })}
                    >
                      <FileDown size={18} />
                      <div>
                        <strong>CSV (.zip)</strong>
                        <span>Separate files in zip</span>
                      </div>
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowReportModal(false)} disabled={exporting}>
                Cancel
              </button>
              <button className="btn-primary" onClick={exportQuarterlyReport} disabled={exporting}>
                <Download size={16} /> {exporting ? 'Generating…' : `Download Q${reportConfig.quarter} ${reportConfig.year}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {dialogConfig.isOpen && (
        <ModernDialog
          {...dialogConfig}
          onConfirm={() => { if (dialogConfig.onConfirm) dialogConfig.onConfirm(); else closeDialog(); }}
          onCancel={dialogConfig.onCancel}
        />
      )}
    </div>
  );
}

export default App;