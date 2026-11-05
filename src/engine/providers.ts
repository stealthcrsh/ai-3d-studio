import { DEFAULT_PARAMS, PARAM_META, type HoodieParams, type NumericParam } from '../core/params.ts';
import { clamp } from '../core/math.ts';
import { colorDistance, type ImageAnalysis } from '../core/vision.ts';
import type { ParamNote, Project, Reference } from './store.ts';

/**
 * Provider contract. A real reconstruction service plugs in here without changing the UI or pipeline.
 * The only working provider is a classical silhouette fit over a parametric pattern, labelled DEMO BASELINE.
 */
export interface ReconstructionResult {
  params: HoodieParams;
  notes: Record<string, ParamNote>;
  warnings: string[];
  provider: { id: string; kind: 'baseline'; requested: string; fallbackReason?: string };
}

export interface ReconstructionProvider {
  id: string;
  label: string;
  kind: 'baseline' | 'ai';
  status: 'available' | 'not-configured';
  note: string;
  available(): { ok: boolean; reason?: string };
}

export const PROVIDERS: ReconstructionProvider[] = [
  {
    id: 'silhouette-parametric', label: 'Silhouette fit + parametric pattern', kind: 'baseline', status: 'available',
    note: 'Local and free. Classical image measurement fits a hoodie pattern, then cloth simulation drapes it. This is not AI reconstruction.',
    available: () => ({ ok: true }),
  },
  {
    id: 'remote-ai', label: 'Remote AI reconstruction', kind: 'ai', status: 'not-configured',
    note: 'Contract only. No vendor is connected and no vendor call has been tested.',
    available: () => ({ ok: false, reason: 'No remote AI provider is configured, so the run used the local baseline instead.' }),
  },
];

const cmS = (v: number) => `${(v * 100).toFixed(1)} cm`;

export function inferParams(project: Project, analyses: Partial<Record<'front' | 'back', ImageAnalysis>>): ReconstructionResult {
  const requested = project.setup.provider;
  const chosen = PROVIDERS.find((p) => p.id === requested) ?? PROVIDERS[0];
  const avail = chosen.available();
  const warnings: string[] = [];
  const provider: ReconstructionResult['provider'] = { id: 'silhouette-parametric', kind: 'baseline', requested };
  if (!avail.ok) {
    provider.fallbackReason = avail.reason;
    warnings.push(avail.reason!);
  }
  const p: HoodieParams = { ...DEFAULT_PARAMS };
  const notes: Record<string, ParamNote> = {};
  for (const k of Object.keys(PARAM_META) as NumericParam[]) notes[k] = { source: 'default', note: `Size L template value, ${cmS(p[k])}.` };
  notes.baseColor = { source: 'default', note: 'Template colour. No reference image was used.' };
  notes.ribColor = { source: 'default', note: 'Template colour.' };
  notes.fabric = { source: 'default', note: 'Fabric cannot be read from an image. Heavy fleece is assumed.' };

  const m = project.measurements;
  const L = m.bodyLength ?? p.bodyLength;
  if (m.bodyLength) {
    p.bodyLength = m.bodyLength;
    notes.bodyLength = { source: 'measured', note: 'Entered by you.' };
  } else {
    notes.bodyLength = { source: 'default', note: `Absolute scale cannot be read from one image. ${cmS(L)} is assumed, and every other inferred size scales from it.` };
  }
  const front = analyses.front?.ok ? analyses.front : undefined;
  const back = analyses.back?.ok ? analyses.back : undefined;
  const source = front ?? back;
  if (analyses.front && !analyses.front.ok) warnings.push(`Front image: ${analyses.front.warnings.at(-1)}`);
  if (analyses.back && !analyses.back.ok) warnings.push(`Back image: ${analyses.back.warnings.at(-1)}`);
  if (source) {
    const conf = source.confidence;
    const set = (k: NumericParam, value: number, note: string) => {
      const meta = PARAM_META[k];
      const v = clamp(value, meta.min, meta.max);
      p[k] = Math.round(v * 1000) / 1000;
      notes[k] = { source: 'inferred', note: value !== v ? `${note} The measured value was outside the supported range and was clamped.` : note, confidence: conf };
    };
    const width = source.ratios.widthToLength * L;
    set('bodyWidth', width, 'From the width-to-length ratio of the outline.');
    set('shoulderWidth', p.bodyWidth * 0.92, 'Estimated as a fixed share of body width.');
    set('sleeveWidth', p.bodyWidth * 0.41, 'Estimated as a fixed share of body width.');
    set('hemWidth', p.bodyWidth * 0.83, 'Estimated as a fixed share of body width.');
    if (source.ratios.sleeveToLength > 0.25) set('sleeveLength', source.ratios.sleeveToLength * L, 'From the longest sleeve in the outline. Pose affects this.');
    const c = source.medianColor;
    p.baseColor = c;
    p.ribColor = colorDistance(source.lowerBandColor, c) > 22 ? source.lowerBandColor : c;
    notes.baseColor = { source: 'inferred', note: 'Median colour inside the outline. Lighting affects this.', confidence: conf };
    notes.ribColor = { source: 'inferred', note: 'Colour near the hem of the outline.', confidence: conf };
    warnings.push(...source.warnings);
    notes.hoodHeight = { source: 'default', note: source.hoodDetected ? 'A hood was detected, but its true size is hidden when lying flat, so the template value is used.' : 'No hood was detected in the image. The hood is a template guess.' };
    notes.hoodDepth = { source: 'default', note: 'Hidden geometry. Template value.' };
    if (!analyses.back) warnings.push('No back image, so the back and hood are inferred from the template and the front colour. Add a back view to improve this.');
  } else {
    warnings.push('No usable reference image. This is the unmodified parametric template, not a reconstruction.');
  }
  if (front && back) {
    const diff = Math.abs(front.ratios.widthToLength - back.ratios.widthToLength) / Math.max(0.01, front.ratios.widthToLength);
    if (diff > 0.15) warnings.push(`Front and back images disagree on proportions by ${(diff * 100).toFixed(0)}%. The front image was used.`);
    const cd = colorDistance(front.medianColor, back.medianColor);
    if (cd > 60) warnings.push('Front and back images have very different colours. They may show different garments. Each image is projected onto its own panel, and the front sets the base colour.');
  }
  for (const k of ['bodyWidth', 'sleeveLength', 'shoulderWidth'] as const) {
    const v = m[k];
    if (v) {
      if (source && k === 'bodyWidth') {
        const predicted = source.ratios.widthToLength * L;
        if (Math.abs(predicted - v) / v > 0.2) warnings.push(`Your chest width of ${cmS(v)} differs from the image estimate of ${cmS(predicted)}. Your measurement was used.`);
      }
      p[k] = clamp(v, PARAM_META[k].min, PARAM_META[k].max);
      notes[k] = { source: 'measured', note: 'Entered by you.' };
    }
  }
  return { params: p, notes, warnings: [...new Set(warnings)], provider };
}

export const pickReferences = (project: Project) => {
  const usable = (v: 'front' | 'back'): Reference | undefined => project.references.find((r) => r.view === v && r.usage === 'used-by-pipeline' && r.analysisDir);
  return { front: usable('front'), back: usable('back') };
};
