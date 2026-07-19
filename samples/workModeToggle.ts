/**
 * Per-note Work-mode toggle (DESKTOP-D3-CONTRACT deliverable 6). Flipping Work
 * mode ON is the doctrine's hard switch: the note may never touch a cloud service
 * again, so we (1) persist work_mode=1, (2) ABORT any cloud call already in
 * flight for the note — closing the iOS audit's MINOR-1 — and (3) clear any cloud
 * engine opt-in so a later (re)summary resolves on-device. Flipping OFF just
 * clears work_mode; it does not silently re-enable cloud (the engine stays local
 * until the user explicitly opts back into cloud).
 */
import { setNoteEngine, setNoteWorkMode } from './db';
import { abortCloudCalls } from './cloudCalls';

export function toggleWorkMode(noteId: string, on: boolean): void {
  setNoteWorkMode(noteId, on);
  if (on) {
    // Cut off bytes already streaming for a note that just became work-mode, and
    // drop the cloud opt-in so the choke-point can't route it to cloud again.
    abortCloudCalls(noteId);
    setNoteEngine(noteId, 'local');
  }
}
