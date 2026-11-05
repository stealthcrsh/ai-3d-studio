import { buildGarment } from './garment.ts';
import type { Skeleton } from './avatar.ts';
import { FABRICS, PARAM_META, PART_IDS, validateParams, type HoodieParams, type NumericParam, type PartId } from './params.ts';

/**
 * Rule-based edit interpreter. It is a deterministic command parser, not a language model.
 * Anything it cannot map to named parameters is refused rather than guessed.
 */
export interface EditOp {
  param: keyof HoodieParams;
  from: number | string | boolean;
  to: number | string | boolean;
  label: string;
}

export interface EditProposal {
  ok: boolean;
  interpreter: 'rule-based-v1';
  understood: string;
  ops: EditOp[];
  patch: Partial<HoodieParams>;
  affectedParts: PartId[];
  unchangedParts: PartId[];
  needsResimulation: boolean;
  warnings: string[];
  refusal?: string;
  suggestions?: string[];
}

const COLORS: Record<string, string> = {
  black: '#1b1c1e', white: '#e9e7e1', cream: '#e6dfcd', ecru: '#dcd5c1', grey: '#7d8187', gray: '#7d8187', charcoal: '#3a3d42',
  navy: '#1f2a44', blue: '#2f5aa8', 'sky blue': '#8db4d8', teal: '#1f6f73', green: '#3f7a4d', forest: '#27452f', olive: '#5c6238',
  sage: '#8b9a7f', yellow: '#d9b53a', mustard: '#c49a2c', orange: '#d4702a', rust: '#9c4a26', red: '#b3302f', burgundy: '#5e1f2a',
  maroon: '#5e1f2a', pink: '#d990a8', lilac: '#a99bc8', purple: '#5b3f8c', brown: '#5a4131', tan: '#b49a78', beige: '#c8b89a',
};

const NUMERIC_TARGETS: { re: RegExp; params: NumericParam[]; noun: string }[] = [
  { re: /\bsleeves?\b.*\bwid(e|th)|\bwid(e|th).*\bsleeves?\b|\b(baggier|fuller)\b.*\bsleeves?\b/, params: ['sleeveWidth'], noun: 'sleeve width' },
  { re: /\bsleeves?\b|\barms?\b/, params: ['sleeveLength'], noun: 'sleeve length' },
  { re: /\bcuffs?\b.*\b(height|tall|deep|long|short)|\b(tall|deep)\w*\b.*\bcuffs?\b/, params: ['cuffHeight'], noun: 'cuff height' },
  { re: /\bcuffs?\b/, params: ['cuffWidth'], noun: 'cuff width' },
  { re: /\b(hem|waistband)\b.*\b(height|tall|deep)/, params: ['hemHeight'], noun: 'hem rib height' },
  { re: /\b(hem|waistband)\b/, params: ['hemWidth'], noun: 'hem rib width' },
  { re: /\bhood\b.*\b(depth|deep)|\b(deep)\w*\b.*\bhood\b/, params: ['hoodDepth'], noun: 'hood depth' },
  { re: /\bhood\b/, params: ['hoodHeight'], noun: 'hood height' },
  { re: /\bpocket\b.*\b(tall|height|deep)/, params: ['pocketHeight'], noun: 'pocket height' },
  { re: /\bpocket\b/, params: ['pocketWidth'], noun: 'pocket width' },
  { re: /\bshoulders?\b/, params: ['shoulderWidth'], noun: 'shoulder width' },
  { re: /\b(body|torso|chest)\b.*\b(wid|narrow|slim|broad)|\b(wid|narrow|slim|broad)\w*\b.*\b(body|torso|chest)\b/, params: ['bodyWidth'], noun: 'body width' },
  { re: /\b(body|torso|hoodie|garment)\b/, params: ['bodyLength'], noun: 'body length' },
];

const INCREASE = /\b(longer|lengthen|extend|taller|bigger|larger|wider|widen|broader|looser|loosen|deeper|increase|fuller|baggier|more)\b/;
const DECREASE = /\b(shorter|shorten|crop|smaller|narrower|narrow|slimmer|slim|tighter|tighten|reduce|decrease|less)\b/;

const cm = (v: number) => `${(v * 100).toFixed(1).replace(/\.0$/, '')} cm`;

export function partsForPatch(patch: Partial<HoodieParams>): Set<PartId> {
  const parts = new Set<PartId>();
  for (const k of Object.keys(patch) as (keyof HoodieParams)[]) {
    if (k in PARAM_META) for (const p of PARAM_META[k as NumericParam].parts) parts.add(p);
    if (k === 'baseColor') for (const p of ['Body_Front', 'Body_Back', 'Sleeve_L', 'Sleeve_R', 'Hood_L', 'Hood_R', 'Pocket'] as PartId[]) parts.add(p);
    if (k === 'ribColor') for (const p of ['Cuff_L', 'Cuff_R', 'Hem_Rib'] as PartId[]) parts.add(p);
    if (k === 'cordColor') for (const p of ['Drawcord_L', 'Drawcord_R'] as PartId[]) parts.add(p);
    if (k === 'fabric') for (const p of PART_IDS) parts.add(p);
    if (k === 'pocket') parts.add('Pocket');
    if (k === 'drawcords') {
      parts.add('Drawcord_L');
      parts.add('Drawcord_R');
    }
  }
  return parts;
}

export function proposalFromPatch(current: HoodieParams, patch: Partial<HoodieParams>, understood: string): EditProposal {
  const next = { ...current, ...patch };
  const issues = validateParams(next);
  const ops: EditOp[] = (Object.keys(patch) as (keyof HoodieParams)[])
    .filter((k) => patch[k] !== current[k])
    .map((k) => ({ param: k, from: current[k], to: patch[k] as never, label: k in PARAM_META ? PARAM_META[k as NumericParam].label : k }));
  const affected = partsForPatch(Object.fromEntries(ops.map((o) => [o.param, o.to])) as Partial<HoodieParams>);
  const geometryOrFabric = ops.some((o) => !['baseColor', 'ribColor', 'cordColor'].includes(o.param));
  if (issues.length) {
    return { ok: false, interpreter: 'rule-based-v1', understood, ops, patch, affectedParts: [...affected], unchangedParts: PART_IDS.filter((p) => !affected.has(p)), needsResimulation: geometryOrFabric, warnings: [], refusal: issues.join(' ') };
  }
  if (!ops.length) {
    return { ok: false, interpreter: 'rule-based-v1', understood, ops, patch: {}, affectedParts: [], unchangedParts: [...PART_IDS], needsResimulation: false, warnings: [], refusal: 'That would not change anything.' };
  }
  const warnings: string[] = [];
  if (geometryOrFabric) warnings.push('The garment will be draped again. Unedited parts can move slightly because the fabric is physically connected. Their pattern shape stays the same.');
  return { ok: true, interpreter: 'rule-based-v1', understood, ops, patch: Object.fromEntries(ops.map((o) => [o.param, o.to])), affectedParts: [...affected], unchangedParts: PART_IDS.filter((p) => !affected.has(p)), needsResimulation: geometryOrFabric, warnings };
}

const SUGGESTIONS = ['Make the sleeves 3 cm shorter', 'Set sleeve length to 58 cm', 'Make the body wider', 'Change the colour to navy', 'Make the cuffs white', 'Switch to denim', 'Remove the pocket'];

export function parseEdit(text: string, current: HoodieParams): EditProposal {
  const t = ` ${text.toLowerCase().trim()} `;
  const refuse = (why: string): EditProposal => ({ ok: false, interpreter: 'rule-based-v1', understood: text, ops: [], patch: {}, affectedParts: [], unchangedParts: [...PART_IDS], needsResimulation: false, warnings: [], refusal: why, suggestions: SUGGESTIONS });

  // Requests the model cannot honour honestly.
  if (/\b(logo|print|graphic|embroider|zip|zipper|button|tear|rip|distress|patch)\b/.test(t)) {
    return refuse('This baseline has no reliable way to add or edit that detail. Nothing was changed. A reference image can carry a print onto the front and back.');
  }

  for (const [id, f] of Object.entries(FABRICS)) {
    if (new RegExp(`\\b${id}\\b`).test(t)) return proposalFromPatch(current, { fabric: id }, `Switch the fabric preset to ${f.label}.`);
  }
  if (/\b(heavier|thicker)\b.*\b(fabric|material|cloth)\b/.test(t)) return proposalFromPatch(current, { fabric: 'denim' }, 'Switch to a stiffer preset, Denim.');
  if (/\b(lighter|thinner|softer)\b.*\b(fabric|material|cloth)\b/.test(t)) return proposalFromPatch(current, { fabric: 'jersey' }, 'Switch to a softer preset, Light jersey.');

  if (/\b(remove|delete|no|without|hide)\b.*\bpocket\b/.test(t)) return proposalFromPatch(current, { pocket: false }, 'Remove the kangaroo pocket.');
  if (/\b(add|restore|show)\b.*\bpocket\b/.test(t)) return proposalFromPatch(current, { pocket: true }, 'Add the kangaroo pocket.');
  if (/\b(remove|delete|no|without|hide)\b.*\b(cord|cords|drawcord|drawcords|string|strings|drawstring|drawstrings)\b/.test(t)) return proposalFromPatch(current, { drawcords: false }, 'Remove the drawcords.');
  if (/\b(add|restore|show)\b.*\b(cord|cords|drawcord|drawcords|string|strings|drawstring|drawstrings)\b/.test(t)) return proposalFromPatch(current, { drawcords: true }, 'Add the drawcords.');

  const hexMatch = t.match(/#[0-9a-f]{6}\b/);
  const nameMatch = Object.keys(COLORS).sort((a, b) => b.length - a.length).find((c) => new RegExp(`\\b${c}\\b`).test(t));
  if (hexMatch || nameMatch) {
    const color = hexMatch ? hexMatch[0] : COLORS[nameMatch!];
    const label = hexMatch ? hexMatch[0] : nameMatch!;
    if (/\b(cord|cords|drawcord|drawcords|string|strings|drawstring|drawstrings)\b/.test(t)) return proposalFromPatch(current, { cordColor: color }, `Colour the drawcords ${label}.`);
    if (/\b(cuff|cuffs|hem|rib|ribs|ribbing|waistband)\b/.test(t)) return proposalFromPatch(current, { ribColor: color }, `Colour the rib parts ${label}. Cuffs and hem share one colour.`);
    if (/\b(sleeve|sleeves|hood|pocket|front|back|body|torso)\b/.test(t) && !/\b(all|whole|entire|hoodie)\b/.test(t)) {
      return refuse(`Colouring one body part alone is not supported yet, because the main fabric shares one colour. Nothing was changed. "Make the hoodie ${label}" recolours all of it. Rib and cord colours can be set separately.`);
    }
    return proposalFromPatch(current, { baseColor: color, ribColor: color }, `Change the main fabric and ribs to ${label}.`);
  }

  const target = NUMERIC_TARGETS.find((n) => n.re.test(t));
  if (!target) return refuse('I could not match that to a named part and measurement, so nothing was changed.');
  const param = target.params[0];
  const meta = PARAM_META[param];
  const m = t.match(/(-?\d+(?:\.\d+)?)\s*(cm|centimet(?:er|re)s?|mm|millimet(?:er|re)s?|m\b|metres?|meters?|in\b|inch(?:es)?|")/);
  const amount = m ? parseFloat(m[1]) * (m[2].startsWith('cm') || m[2].startsWith('cent') ? 0.01 : m[2].startsWith('mm') || m[2].startsWith('mil') ? 0.001 : m[2].startsWith('in') || m[2] === '"' ? 0.0254 : 1) : null;
  const inc = INCREASE.test(t);
  const dec = DECREASE.test(t);
  let value: number;
  if (amount !== null && /\b(to|at|set|exactly|=)\b/.test(t) && !/\bby\b/.test(t)) {
    value = amount;
  } else if (inc || dec) {
    const delta = amount ?? (current[param] as number) * 0.08;
    value = (current[param] as number) + (inc && !dec ? delta : -delta);
  } else if (amount !== null) {
    value = amount;
  } else {
    return refuse(`I found the ${target.noun} but not what to do to it. Say, for example, "3 cm shorter" or "set to 58 cm". Nothing was changed.`);
  }
  value = Math.round(value * 1000) / 1000;
  if (value < meta.min || value > meta.max) return refuse(`${meta.label} of ${cm(value)} is outside the supported range of ${cm(meta.min)} to ${cm(meta.max)}. Nothing was changed.`);
  const prop = proposalFromPatch(current, { [param]: value }, `Change ${target.noun} from ${cm(current[param] as number)} to ${cm(value)}.`);
  if (amount === null) prop.warnings.unshift('No amount was given, so I assumed about 8%. Check the preview before applying.');
  return prop;
}

/** Compare rest-pattern geometry part by part. This is the check that edits stay local. */
export function restLocality(before: HoodieParams, after: HoodieParams, sk: Skeleton) {
  const a = buildGarment(before, 'preview', sk);
  const b = buildGarment(after, 'preview', sk);
  const allowed = partsForPatch(Object.fromEntries((Object.keys(after) as (keyof HoodieParams)[]).filter((k) => after[k] !== before[k]).map((k) => [k, after[k]])) as Partial<HoodieParams>);
  const perPart: { part: PartId; changed: boolean; maxMoveMm: number | null; allowed: boolean }[] = [];
  for (const part of PART_IDS) {
    const x = a.restParts[part];
    const y = b.restParts[part];
    let changed = false;
    let maxMove: number | null = 0;
    if (!x || !y || x.length !== y.length) {
      changed = Boolean(x) !== Boolean(y) || Boolean(x && y);
      maxMove = null;
    } else {
      for (let i = 0; i < x.length; i += 3) {
        const d = Math.hypot(x[i] - y[i], x[i + 1] - y[i + 1], x[i + 2] - y[i + 2]);
        if (d > maxMove!) maxMove = d;
      }
      changed = maxMove! > 1e-6;
      maxMove = maxMove! * 1000;
    }
    perPart.push({ part, changed, maxMoveMm: maxMove, allowed: allowed.has(part) });
  }
  const unexpected = perPart.filter((p) => p.changed && !p.allowed).map((p) => p.part);
  return { perPart, unexpected, passed: unexpected.length === 0 };
}
