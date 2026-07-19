/**
 * ASR sidecar — invokes the StellarASR Swift binary (FluidAudio, Apache-2.0)
 * and parses its `{meta, utterances:[{speaker,text,startMs,endMs}]}` contract
 * (DESKTOP-D0 gate 1). Memos run ASR-only (`--asr-only`, no diarization pass);
 * speakers are dropped for memo segments. Everything goes through the sidecar
 * lifecycle contract in process.ts (timeout, group-kill, drain, retryable
 * failure), so a hung or malformed ASR pass can never strand a note.
 *
 * The binary path and the whole invocation are overridable by env so the
 * acceptance tests can substitute a fake sidecar (hung child / malformed JSON):
 *   STELLAR_ASR_BIN  — path to the StellarASR executable (default: built binary)
 *   STELLAR_ASR_CMD  — JSON argv array that fully REPLACES the binary invocation
 *                      (the wav path + mode flags are appended); used by tests.
 *   STELLAR_ASR_TIMEOUT_MS — per-invocation timeout (default 300000).
 */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { NewSegment } from '../db';
import { MAX_SPEAKERS_PER_NOTE, validateEmbedding } from '../speakers';
import { runSidecar, SidecarError, type SidecarHandle } from './process';

export interface Utterance {
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}

/** A diarization cluster's L2-normalized centroid embedding (merged mode only;
 *  empty in --asr-only). `speaker` is the raw diarizer id, mapped to "S1/S2…"
 *  on this side (speakers.ts buildLabelMap). */
export interface SpeakerEmbedding {
  speaker: string;
  embedding: number[];
}

export interface AsrOutput {
  utterances: Utterance[];
  speakers: SpeakerEmbedding[];
  meta: Record<string, unknown>;
}

const isWin = process.platform === 'win32';

/** Repo root, derived from the bundled main.js location: dist/ -> desktop/ -> repo. */
function repoRoot(): string {
  // __dirname at runtime is <repo>/desktop/dist
  return resolve(__dirname, '..', '..');
}

/**
 * The StellarASR (FluidAudio) executable.
 *
 * Packaged: electron-builder copies the release binary to
 * `StellarNotes.app/Contents/Resources/StellarASR/StellarASR` (extraResources,
 * DESKTOP-D4-CONTRACT gate 1); it lives OUTSIDE the asar because it is a native
 * Mach-O executable. Dev: the `swift build -c release` output under the repo.
 * `app.isPackaged` is false when tests drive this under a dev Electron, so the
 * acceptance suite keeps hitting the repo build (or its STELLAR_ASR_CMD fake).
 */
function defaultBinary(): string {
  if (isWin) {
    // Windows: a pure-Node CJS wrapper (spawns whisper-cli.exe as a child). It is
    // shipped via extraResources to <resources>/StellarASR/stellar-asr.cjs and run
    // through Electron-as-Node (see invocation()/startAsr()).
    if (app.isPackaged) {
      return join(process.resourcesPath, 'StellarASR', 'stellar-asr.cjs');
    }
    return join(repoRoot(), 'desktop', 'sidecar', 'whisper-win', 'stellar-asr.cjs');
  }
  if (app.isPackaged) {
    return join(process.resourcesPath, 'StellarASR', 'StellarASR');
  }
  return join(
    repoRoot(),
    'desktop',
    'sidecar',
    'StellarASR',
    '.build',
    'release',
    'StellarASR',
  );
}

export function asrBinaryPath(): string {
  return process.env.STELLAR_ASR_BIN ?? defaultBinary();
}

function invocation(wavPath: string, asrOnly: boolean): { command: string; args: string[] } {
  const flags = asrOnly ? ['--asr-only'] : [];
  const override = process.env.STELLAR_ASR_CMD;
  if (override) {
    const argv = JSON.parse(override) as string[];
    const [command, ...rest] = argv;
    return { command, args: [...rest, wavPath, ...flags] };
  }
  if (isWin) {
    // The wrapper is a Node script; run it through Electron-as-Node (execPath +
    // ELECTRON_RUN_AS_NODE in startAsr) so no separate node.exe is required.
    return { command: process.execPath, args: [asrBinaryPath(), wavPath, ...flags] };
  }
  return { command: asrBinaryPath(), args: [wavPath, ...flags] };
}

function timeoutMs(): number {
  const n = Number(process.env.STELLAR_ASR_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 300_000;
}

/**
 * stderr lines FluidAudio/StellarASR emit while fetching or loading its models
 * on first run. A match both (a) surfaces a "downloading models" phase to the
 * caller and (b) resets the sidecar deadline, so a slow first-run download that
 * legitimately outlasts the base timeout is not killed mid-fetch.
 */
export function isModelDownloadLine(line: string): boolean {
  return /\b(download|downloading)\b|loading\s+\w*\s*models/i.test(line);
}

/**
 * Start an ASR pass. Returns a cancellable handle whose promise resolves with
 * the parsed, shape-checked output. A binary that isn't present fails fast as a
 * retryable sidecar error rather than a confusing spawn crash.
 *
 * `onProgress` is called (best-effort) when the sidecar reports it is fetching
 * or loading models, so the caller can surface a "downloading models" state and
 * the first-run download can outlast the base timeout without being killed.
 */
export function startAsr(
  wavPath: string,
  opts?: { asrOnly?: boolean; onProgress?: (phase: 'downloading_models') => void },
): {
  handle: SidecarHandle;
  result: Promise<AsrOutput>;
} {
  const asrOnly = opts?.asrOnly ?? true;
  if (!process.env.STELLAR_ASR_CMD && !existsSync(asrBinaryPath())) {
    // Surface as a retryable sidecar error via a pre-rejected handle.
    const err = new SidecarError(
      'spawn_error',
      `ASR binary not found at ${asrBinaryPath()} (build desktop/sidecar/StellarASR or set STELLAR_ASR_BIN)`,
      null,
      '',
    );
    return {
      handle: { promise: Promise.reject(err), cancel() {} },
      result: Promise.reject(err),
    };
  }

  const { command, args } = invocation(wavPath, asrOnly);
  const isOverride = !!process.env.STELLAR_ASR_CMD;
  // Windows (non-test): run the wrapper via Electron-as-Node and point its model
  // cache at the app's real userData dir. Under the test override we keep the
  // existing env passthrough (opts.env undefined → the test's process.env flows).
  const env =
    isWin && !isOverride
      ? {
          ELECTRON_RUN_AS_NODE: '1',
          STELLAR_WHISPER_MODEL_DIR: join(app.getPath('userData'), 'models'),
        }
      : undefined;
  // cwd: the sidecar's own directory (so it can resolve sibling resources). On
  // POSIX non-override `command` IS the binary; otherwise (win32 Electron-as-Node,
  // or the test override where command is 'node') the real target is asrBinaryPath().
  const cwd = dirname(!isWin && command.startsWith('/') ? command : asrBinaryPath());
  // On win32 the whisper-cli sidecar emits "...progress = 42%" lines during a long
  // CPU transcription; count those as activity too so the wall-clock deadline keeps
  // resetting. (The exported isModelDownloadLine + the onProgress downloading_models
  // gating below are unchanged — this only widens the deadline-reset predicate.)
  const isProgress = isWin
    ? (line: string): boolean => isModelDownloadLine(line) || /progress\s*=\s*\d+\s*%/i.test(line)
    : isModelDownloadLine;
  let sawDownload = false;
  const handle = runSidecar(command, args, {
    timeoutMs: timeoutMs(),
    cwd,
    env,
    isProgressLine: isProgress,
    onStderrLine: (line) => {
      if (opts?.onProgress && !sawDownload && isModelDownloadLine(line)) {
        sawDownload = true;
        opts.onProgress('downloading_models');
      }
    },
  });

  const result = handle.promise.then(({ stdout }) => parseAsrOutput(stdout));
  return { handle, result };
}

/** Parse + shape-check the ASR stdout. Malformed => retryable sidecar error. */
export function parseAsrOutput(stdout: string): AsrOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new SidecarError('malformed', 'ASR stdout was not valid JSON', 0, stdout.slice(0, 400));
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as AsrOutput).utterances)) {
    throw new SidecarError('malformed', 'ASR output missing utterances[]', 0, stdout.slice(0, 400));
  }
  const raw = (parsed as { utterances: unknown[] }).utterances;
  const utterances: Utterance[] = [];
  for (const u of raw) {
    if (
      typeof u !== 'object' ||
      u === null ||
      typeof (u as Utterance).text !== 'string' ||
      typeof (u as Utterance).startMs !== 'number' ||
      typeof (u as Utterance).endMs !== 'number'
    ) {
      throw new SidecarError('malformed', 'ASR utterance had an invalid shape', 0, JSON.stringify(u).slice(0, 200));
    }
    const utt = u as Utterance;
    utterances.push({
      speaker: typeof utt.speaker === 'string' ? utt.speaker : 'unknown',
      text: utt.text,
      startMs: utt.startMs,
      endMs: utt.endMs,
    });
  }
  const speakers = parseSpeakers((parsed as { speakers?: unknown }).speakers);
  const meta = (parsed as { meta?: Record<string, unknown> }).meta ?? {};
  return { utterances, speakers, meta };
}

/**
 * Parse the optional per-cluster embeddings array at the sidecar trust boundary.
 * Every embedding must pass `validateEmbedding` (exact dimension, all finite,
 * non-zero norm) and is stored L2-normalized; an entry that fails — empty,
 * wrong-dim, NaN/Infinity, or zero vector — is DROPPED (that cluster degrades to
 * "no persistence / unrenameable", never a crash). The count is capped at
 * MAX_SPEAKERS_PER_NOTE so a pathological or crafted payload can't grow the note
 * unbounded.
 */
function parseSpeakers(raw: unknown): SpeakerEmbedding[] {
  if (!Array.isArray(raw)) return [];
  const out: SpeakerEmbedding[] = [];
  let dropped = 0;
  for (const s of raw) {
    if (out.length >= MAX_SPEAKERS_PER_NOTE) {
      dropped += 1;
      continue;
    }
    if (typeof s === 'object' && s !== null && typeof (s as SpeakerEmbedding).speaker === 'string') {
      const embedding = validateEmbedding((s as SpeakerEmbedding).embedding);
      if (embedding) {
        out.push({ speaker: (s as SpeakerEmbedding).speaker, embedding });
        continue;
      }
    }
    dropped += 1;
  }
  if (dropped > 0) {
    // Best-effort job note; a dropped centroid must never break transcription.
    console.warn(`asr: dropped ${dropped} invalid speaker embedding(s)`);
  }
  return out;
}

/** Map ASR utterances to memo segments (speaker dropped — no diarization). */
export function utterancesToMemoSegments(utterances: Utterance[]): NewSegment[] {
  return utterances
    .filter((u) => u.text.trim().length > 0)
    .map((u, idx) => ({
      idx,
      text: u.text.trim(),
      startMs: u.startMs,
      endMs: u.endMs,
      speaker: null,
    }));
}

/**
 * Map merged (diarized) utterances to meeting segments, rewriting each raw
 * diarizer speaker id to its "S1/S2…" label. An "unknown" utterance (the 0-
 * segment fallback) or any id missing from the map carries a null speaker, so it
 * renders speaker-less rather than under a bogus label.
 */
export function utterancesToMeetingSegments(
  utterances: Utterance[],
  labelMap: Map<string, string>,
): NewSegment[] {
  return utterances
    .filter((u) => u.text.trim().length > 0)
    .map((u, idx) => ({
      idx,
      text: u.text.trim(),
      startMs: u.startMs,
      endMs: u.endMs,
      speaker: labelMap.get(u.speaker) ?? null,
    }));
}
