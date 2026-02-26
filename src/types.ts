// ═══════════════════════════════════════════════════════════════════
// CORE TYPES — Rex AST, Shrub interface, transducer contracts
// ═══════════════════════════════════════════════════════════════════

// ── Bracket types ────────────────────────────────────────────────
export type Bracket = 'P' | 'B' | 'C' | 'X';  // Paren, Brack, Curly, Clear

// ── Rex AST — discriminated union over 11 node types ─────────────
export type Rex =
  | { _: 'Wd'; v: string }                           // Word
  | { _: 'Qp'; v: string }                           // Quip
  | { _: 'Td'; v: string }                           // Trad
  | { _: 'Sl'; v: string[] }                         // Slug
  | { _: 'Ug'; v: string }                           // Ugly
  | { _: 'Hr'; h: Rex; t: Rex }                      // Heir
  | { _: 'Tp'; r: string; c: Rex }                   // TightPre
  | { _: 'Ti'; r: string; ch: Rex[] }                // TightInf
  | { _: 'Np'; b: Bracket; r: string; ch: Rex[] }    // NestPre
  | { _: 'Ni'; b: Bracket; r: string; ch: Rex[] }    // NestInf
  | { _: 'Bk'; ch: Rex[] }                           // Block

// ── Expression value — from parser's _val() ──────────────────────
export type ExprValue = {
  expr: string;       // raw expression string (backward compat)
  rex: Rex | null;    // canonical AST node
};

// ── Shrub value — what attributes can hold ───────────────────────
export type ShrubValue =
  | string
  | number
  | boolean
  | ShrubValue[]
  | ExprValue
  | undefined;

// ── Shrub — the transducer-facing node shape ─────────────────────
export interface Shrub {
  type: string;
  name: string | null;
  attrs: Record<string, ShrubValue>;
  children: Shrub[];
  content: string | null;
  _d?: number;       // depth (internal)
  _indent?: number;  // indentation (internal, cleaned after parse)
}

// ── Parse result ─────────────────────────────────────────────────
export interface RexParseResult {
  nodes: Rex[];
  errors: Array<string | { start: number; message: string }>;
}

// ── Transducer contract ──────────────────────────────────────────
export interface Transducer {
  transduce(tree: Shrub, structureChanged?: boolean): void;
  invalidate?(): void;
  destroy?(): void;
}

// ── Optic — compiled path → byte offset ──────────────────────────
export interface Optic {
  heapOffset: number;
  type: FieldType;
  source: 'form' | 'builtin' | 'const';
  key: string;
  fieldName?: string;
  bufferName?: string;
  constVal?: number | string;
}

export type FieldType = 'f32' | 'i32' | 'u32' | 'f32x2' | 'f32x3' | 'f32x4' | 'f32x4x4';

// ── Heap layout entry ────────────────────────────────────────────
export interface HeapEntry {
  offset: number;
  size: number;
  structDef?: StructDef;
  structName?: string;
}

export interface StructDef {
  size: number;
  layout: StructField[];
}

export interface StructField {
  name: string;
  type: FieldType;
  offset: number;
  size: number;
}

// ── Command list ─────────────────────────────────────────────────
export interface PassCommand {
  type: 'pass';
  clearValue: { r: number; g: number; b: number; a: number };
  loadOp: string;
  storeOp: string;
  depth: boolean;
  draws: DrawCommand[];
  target: string | null;
  targets: string[] | null;
  depthTarget: string | null;
}

export interface DrawCommand {
  pipelineKey: string;
  vertices: number;
  instances: number;
  binds: BindDef[];
  vertexBuffer: string | null;
  indexBuffer: string | null;
  indexCount: number;
  indirect: boolean;
  indirectBuffer: string | null;
  indirectOffset: number;
}

export interface DispatchCommand {
  type: 'dispatch';
  pipelineKey: string;
  grid: [number, number, number];
  binds: BindDef[];
}

export type Command = PassCommand | DispatchCommand;

export interface BindDef {
  group: number;
  buffer?: string;
  texture?: string;
  sampler?: string;
  storage?: string | string[];
}

// ── Barrier schedule ─────────────────────────────────────────────
export interface Barrier {
  afterPass: string;
  beforePass: string;
  before: string;
  after: string;
  hazards: string;
  details: Array<{ resource: string; type: string }>;
}

// ── Behaviour types ──────────────────────────────────────────────
export interface BehaviourSlotSchema {
  type: 'string' | 'number' | 'boolean' | 'date';
  default?: ShrubValue;
}

export interface BehaviourKidsSchema {
  slots: Map<string, BehaviourSlotSchema>;
}

export interface BehaviourSchema {
  slots: Map<string, BehaviourSlotSchema>;
  kids: Map<string, BehaviourKidsSchema>;
  deps: Map<string, { path: string }>;
}

export interface BehaviourShrub {
  schema: BehaviourSchema;
  slots: Map<string, ShrubValue>;
  kids: Map<string, Map<string, Map<string, ShrubValue>>>;
  nextAutoKey: Map<string, number>;
}

export interface TalkDef {
  shrub: string;
  inputs: Array<{ name: string; type: string }>;
  guard: ExprValue | string | null;
  mutations: Shrub[];
}

export interface Channel {
  name: string;
  from: { shrub: string; slot: string };
  to: { buffer: string; field: string };
  mode: 'on-change' | 'every-frame';
  lastValue: ShrubValue;
}

// ── PCN types ────────────────────────────────────────────────────
export interface PCNAgent {
  slot: number;
  name: string;
  description: string;
  affordances: unknown[];
  confidence: number;
  energyPool: number;
  state: 'alive' | 'dormant' | 'retired';
  sourceShrubs: string[];
  born: number;
  lastConfirmed: number;
}

export interface PCNEpisode {
  source: string;
  shrub: string;
  path: string;
  talk?: string | null;
  mode: string;
  timestamp: number;
}

export interface CoalitionMember extends PCNAgent {
  energy: number;
  flags: number;
}

// ── PLAN Bridge types ────────────────────────────────────────────
export interface TreeHistoryEntry {
  source: string;
  timestamp: number;
  formState: Record<string, ShrubValue>;
}

export interface PLANEvent {
  source: string;
  shrub: string;
  path: string;
  value?: ShrubValue;
  prev?: ShrubValue;
  talk?: string;
  mode?: string;
  timestamp: number;
}
