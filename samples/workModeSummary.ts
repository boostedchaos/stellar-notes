/**
 * Work-mode on-device summary branch (Phase 6.5 §D), extracted PURE so it is
 * node-testable with a mocked adapter. summarization.ts wires the real deps
 * (db reads/writes, the appleAI adapter, the settings default); the branching
 * policy lives here where it can be exercised without RN/SQLite.
 *
 * Policy (contract §D, do not re-litigate):
 *   - Fires ONLY for a work-mode note (the caller has already checked).
 *   - Adapter unavailable  → land `ready`, no summary, reason 'work_mode'
 *                            (exactly today's behavior — never an error state
 *                            for a missing optional capability).
 *   - No transcript        → land `ready`, no summary, reason 'work_mode'.
 *   - Success              → persist summary (same table/shape as OpenRouter).
 *   - ANY generation error → land `ready`, no summary, reason
 *                            'work_mode_ondevice_failed' (NOT 'summary_failed',
 *                            which would surface a Retry card wired to the cloud).
 */

import type { NoteStatus } from '@/data/types';
import type { SummaryResult, TemplateId } from '@/services/summarizer';

export type WorkModeSummaryReason = 'work_mode' | 'work_mode_ondevice_failed';

export type WorkModeSummaryOutcome =
  | { ok: true }
  | { ok: false; reason: WorkModeSummaryReason };

export interface WorkModeSummaryDeps {
  /** Apple Foundation Models available on this device right now. */
  isAvailable: () => boolean;
  /** The note's transcript as per-segment text lines, or null if none. */
  getSegments: () => string[] | null;
  /** Run the on-device map-reduce summary (appleAI.summarizeSegmentsOnDevice). */
  summarize: (segments: string[], templateId: TemplateId) => Promise<SummaryResult>;
  /** Persist the chosen template before the pass (so a later view is correct). */
  setTemplate: (templateId: TemplateId) => void;
  /** Move the note through its status machine. */
  setStatus: (status: NoteStatus) => void;
  /** Persist the finished summary (lands the note `ready`). */
  saveSummary: (summary: SummaryResult) => void;
}

export async function summarizeWorkModeNote(
  templateId: TemplateId,
  deps: WorkModeSummaryDeps,
): Promise<WorkModeSummaryOutcome> {
  if (!deps.isAvailable()) {
    // No on-device model — today's behavior: ready, no summary. Not an error.
    deps.setStatus('ready');
    return { ok: false, reason: 'work_mode' };
  }

  // Everything after the availability check is inside the try (F4): a DB throw
  // in getSegments/setTemplate/setStatus must not strand the note in
  // `summarizing` until the next-launch crash recovery.
  try {
    const segments = deps.getSegments();
    if (!segments || segments.length === 0) {
      deps.setStatus('ready');
      return { ok: false, reason: 'work_mode' };
    }

    deps.setTemplate(templateId);
    deps.setStatus('summarizing');
    const summary = await deps.summarize(segments, templateId);
    deps.saveSummary(summary);
    return { ok: true };
  } catch {
    // On-device generation (or a DB write around it) failed — keep the note
    // safe and quiet. Reuse the ready state with the work-mode marker; do NOT
    // surface a cloud Retry. setStatus is best-effort in case the DB itself is
    // the thing throwing.
    try {
      deps.setStatus('ready');
    } catch {
      // nothing else we can safely do
    }
    return { ok: false, reason: 'work_mode_ondevice_failed' };
  }
}
