import { stableStringify, fnv1a } from './math.ts';

export type Quality = 'preview' | 'standard' | 'high';
export type BodyShapeId = 'slim' | 'regular' | 'broad';
export type ClipId = 'walk' | 'jog' | 'armlift' | 'idle';
export type PinGroup = 'collar' | 'cuffs' | 'hem';
export type Provenance = 'measured' | 'inferred' | 'default' | 'edited';

export interface FabricPreset {
  id: string;
  label: string;
  gsm: number;
  /** XPBD compliance. Larger is softer. Tuned visually, not measured from real fabric. */
  stretchCompliance: number;
  bendCompliance: number;
  friction: number;
  damping: number;
  roughness: number;
  noiseScale: number;
  note: string;
}

export const FABRICS: Record<string, FabricPreset> = {
  fleece: { id: 'fleece', label: 'Heavy fleece', gsm: 380, stretchCompliance: 2e-4, bendCompliance: 0.35, friction: 0.45, damping: 0.5, roughness: 0.95, noiseScale: 1, note: 'Approximate. 380 g/m² is typical of heavyweight loopback; stiffness is hand-tuned.' },
  jersey: { id: 'jersey', label: 'Light jersey', gsm: 180, stretchCompliance: 8e-4, bendCompliance: 3, friction: 0.35, damping: 0.35, roughness: 0.88, noiseScale: 0.55, note: 'Approximate. Soft, more small wrinkles.' },
  denim: { id: 'denim', label: 'Denim', gsm: 400, stretchCompliance: 2e-5, bendCompliance: 0.04, friction: 0.5, damping: 0.6, roughness: 0.8, noiseScale: 0.75, note: 'Approximate. Stiff, large folds.' },
  nylon: { id: 'nylon', label: 'Slick nylon', gsm: 90, stretchCompliance: 5e-5, bendCompliance: 1.2, friction: 0.12, damping: 0.25, roughness: 0.42, noiseScale: 0.2, note: 'Unusual-fabric test preset. Approximate.' },
};

export interface HoodieParams {
  /** Flat half-chest width, metres. */
  bodyWidth: number;
  /** High-point-shoulder to hem including rib, metres. */
  bodyLength: number;
  /** Shoulder point to shoulder point, metres. */
  shoulderWidth: number;
  /** Shoulder point to cuff end, metres. */
  sleeveLength: number;
  /** Flat bicep width, metres. */
  sleeveWidth: number;
  /** Flat cuff width, metres. */
  cuffWidth: number;
  cuffHeight: number;
  hemHeight: number;
  /** Flat rib width at hem, metres. */
  hemWidth: number;
  hoodHeight: number;
  hoodDepth: number;
  pocket: boolean;
  drawcords: boolean;
  pocketWidth: number;
  pocketHeight: number;
  fabric: string;
  baseColor: string;
  ribColor: string;
  cordColor: string;
}

export type NumericParam = {
  [K in keyof HoodieParams]: HoodieParams[K] extends number ? K : never;
}[keyof HoodieParams];

export const DEFAULT_PARAMS: HoodieParams = {
  bodyWidth: 0.66,
  bodyLength: 0.72,
  shoulderWidth: 0.6,
  sleeveLength: 0.53,
  sleeveWidth: 0.27,
  cuffWidth: 0.115,
  cuffHeight: 0.075,
  hemHeight: 0.075,
  hemWidth: 0.55,
  hoodHeight: 0.37,
  hoodDepth: 0.26,
  pocket: true,
  drawcords: true,
  pocketWidth: 0.4,
  pocketHeight: 0.22,
  fabric: 'fleece',
  baseColor: '#5f6670',
  ribColor: '#565d67',
  cordColor: '#e6e3da',
};

export const PARAM_META: Record<NumericParam, { label: string; min: number; max: number; parts: PartId[] }> = {
  bodyWidth: { label: 'Body width', min: 0.42, max: 0.85, parts: ['Body_Front', 'Body_Back', 'Hem_Rib', 'Pocket', 'Sleeve_L', 'Sleeve_R', 'Cuff_L', 'Cuff_R', 'Hood_L', 'Hood_R', 'Drawcord_L', 'Drawcord_R'] },
  bodyLength: { label: 'Body length', min: 0.5, max: 1.0, parts: ['Body_Front', 'Body_Back', 'Hem_Rib', 'Pocket', 'Drawcord_L', 'Drawcord_R'] },
  shoulderWidth: { label: 'Shoulder width', min: 0.42, max: 0.82, parts: ['Body_Front', 'Body_Back', 'Hem_Rib', 'Sleeve_L', 'Sleeve_R', 'Cuff_L', 'Cuff_R', 'Pocket', 'Drawcord_L', 'Drawcord_R'] },
  sleeveLength: { label: 'Sleeve length', min: 0.28, max: 0.8, parts: ['Sleeve_L', 'Sleeve_R', 'Cuff_L', 'Cuff_R'] },
  sleeveWidth: { label: 'Sleeve width', min: 0.16, max: 0.38, parts: ['Sleeve_L', 'Sleeve_R', 'Cuff_L', 'Cuff_R', 'Body_Front', 'Body_Back', 'Hem_Rib', 'Pocket', 'Drawcord_L', 'Drawcord_R', 'Hood_L', 'Hood_R'] },
  cuffWidth: { label: 'Cuff width', min: 0.07, max: 0.16, parts: ['Cuff_L', 'Cuff_R', 'Sleeve_L', 'Sleeve_R'] },
  cuffHeight: { label: 'Cuff height', min: 0.03, max: 0.14, parts: ['Cuff_L', 'Cuff_R', 'Sleeve_L', 'Sleeve_R'] },
  hemHeight: { label: 'Hem rib height', min: 0.03, max: 0.14, parts: ['Hem_Rib', 'Body_Front', 'Body_Back', 'Pocket', 'Drawcord_L', 'Drawcord_R', 'Sleeve_L', 'Sleeve_R', 'Cuff_L', 'Cuff_R'] },
  hemWidth: { label: 'Hem rib width', min: 0.38, max: 0.8, parts: ['Hem_Rib'] },
  hoodHeight: { label: 'Hood height', min: 0.26, max: 0.48, parts: ['Hood_L', 'Hood_R'] },
  hoodDepth: { label: 'Hood depth', min: 0.18, max: 0.34, parts: ['Hood_L', 'Hood_R'] },
  pocketWidth: { label: 'Pocket width', min: 0.2, max: 0.56, parts: ['Pocket'] },
  pocketHeight: { label: 'Pocket height', min: 0.12, max: 0.32, parts: ['Pocket'] },
};

export const PART_IDS = [
  'Body_Front',
  'Body_Back',
  'Sleeve_L',
  'Sleeve_R',
  'Cuff_L',
  'Cuff_R',
  'Hem_Rib',
  'Hood_L',
  'Hood_R',
  'Pocket',
  'Drawcord_L',
  'Drawcord_R',
] as const;
export type PartId = (typeof PART_IDS)[number];

export const PART_LABEL: Record<PartId, string> = {
  Body_Front: 'Front body',
  Body_Back: 'Back body',
  Sleeve_L: 'Left sleeve',
  Sleeve_R: 'Right sleeve',
  Cuff_L: 'Left cuff',
  Cuff_R: 'Right cuff',
  Hem_Rib: 'Hem rib',
  Hood_L: 'Hood, left',
  Hood_R: 'Hood, right',
  Pocket: 'Kangaroo pocket',
  Drawcord_L: 'Drawcord, left',
  Drawcord_R: 'Drawcord, right',
};

export const QUALITY: Record<Quality, { ds: number; texture: number; substeps: number; selfCollide: boolean; label: string }> = {
  preview: { ds: 0.042, texture: 1024, substeps: 14, selfCollide: false, label: 'Preview' },
  standard: { ds: 0.02, texture: 2048, substeps: 18, selfCollide: true, label: 'Standard' },
  high: { ds: 0.013, texture: 4096, substeps: 24, selfCollide: true, label: 'High' },
};

const GEOM_KEYS: (keyof HoodieParams)[] = [
  'bodyWidth', 'bodyLength', 'shoulderWidth', 'sleeveLength', 'sleeveWidth', 'cuffWidth', 'cuffHeight',
  'hemHeight', 'hemWidth', 'hoodHeight', 'hoodDepth', 'pocket', 'drawcords', 'pocketWidth', 'pocketHeight',
];

const pick = (p: HoodieParams, keys: (keyof HoodieParams)[]) => Object.fromEntries(keys.map((k) => [k, p[k]]));
export const hashOf = (v: unknown) => fnv1a(stableStringify(v));
export const geometryKey = (p: HoodieParams) => hashOf(pick(p, GEOM_KEYS));
/** Physics depends on geometry and fabric, but never on colour. */
export const physicsKey = (p: HoodieParams) => {
  const f = FABRICS[p.fabric] ?? FABRICS.fleece;
  return hashOf({ g: geometryKey(p), gsm: f.gsm, s: f.stretchCompliance, b: f.bendCompliance, fr: f.friction, d: f.damping });
};
export const appearanceKey = (p: HoodieParams) => hashOf({ g: geometryKey(p), c: [p.baseColor, p.ribColor, p.cordColor], f: p.fabric });

export function validateParams(p: HoodieParams): string[] {
  const issues: string[] = [];
  for (const [k, m] of Object.entries(PARAM_META) as [NumericParam, (typeof PARAM_META)[NumericParam]][]) {
    if (!Number.isFinite(p[k]) || p[k] < m.min || p[k] > m.max) issues.push(`${m.label} must be between ${Math.round(m.min * 100)} and ${Math.round(m.max * 100)} cm`);
  }
  if (!FABRICS[p.fabric]) issues.push(`Unknown fabric ${p.fabric}`);
  for (const c of ['baseColor', 'ribColor', 'cordColor'] as const) if (!/^#[0-9a-f]{6}$/i.test(p[c])) issues.push(`${c} must be a #rrggbb colour`);
  return issues;
}
