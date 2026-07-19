/**
 * Zod mirror of the shared summary schema (Phase 6.5 §C).
 *
 * The OpenRouter path (summarizer.ts) parses free-form model JSON with a
 * strict parse-and-retry contract. The on-device Foundation Models path uses
 * `generateObject` with THIS Zod schema — Apple guided generation enforces it
 * during decoding, so schema-valid output is guaranteed and no parse-retry is
 * needed on-device (BRIEF §3, R9).
 *
 * This schema mirrors summarizer.ts's SCHEMA_RULES key-for-key
 * (title, tldr, key_points, actions, decisions, questions). It is kept
 * PERMISSIVE — missing arrays default to [] and a missing title to '' — so it
 * accepts exactly what the OpenRouter JSON path accepts (a node test asserts
 * this parity). Pure: no RN/Expo imports, node-testable like summarizer.ts.
 */

import { z } from 'zod';

import type { SummaryResult } from './summarizer';

/** Mirror of summarizer.ts's toCleanList — kept local so this module has no
 *  runtime cross-module import (the node --test loader can't resolve those).
 *  Drops blanks and "None"/"N/A" filler and strips leading bullets. */
function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const s = item.replace(/^[\s\-*•]+/, '').trim();
    if (s.length === 0) continue;
    if (/^(none|n\/a|na|n\.a\.)$/i.test(s)) continue;
    out.push(s);
  }
  return out;
}

const stringList = z.array(z.string()).default([]);

export const summarySchema = z.object({
  title: z.string().default(''),
  tldr: z.string(),
  key_points: stringList,
  actions: stringList,
  decisions: stringList,
  questions: stringList,
});

export type SummaryObject = z.infer<typeof summarySchema>;

/**
 * Convert a schema-valid summary object into the app's SummaryResult, applying
 * the same empty/filler normalization the OpenRouter path uses (toCleanList)
 * and the same title trimming as parseSummaryResponse.
 */
export function summaryResultFromObject(obj: SummaryObject): SummaryResult {
  return {
    title: (obj.title ?? '').trim().replace(/[.\s]+$/, ''),
    tldr: obj.tldr.trim(),
    keyPoints: cleanList(obj.key_points),
    actions: cleanList(obj.actions),
    decisions: cleanList(obj.decisions),
    questions: cleanList(obj.questions),
  };
}
