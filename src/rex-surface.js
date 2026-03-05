// ═══════════════════════════
// SURFACE TRANSDUCER
// Vello-style compute 2D renderer + SDF text: @rect/@text/@panel → GPU
// ═══════════════════════════

import { Rex } from './rex-parser.js';

// ── Constants ──
const TILE_SIZE = 16;
const MAX_CMDS_PER_TILE = 64;
const SDF_GLYPH_SIZE = 48;     // rasterize each glyph at this px size
const SDF_SPREAD = 6;          // distance field spread in pixels
const SDF_ATLAS_SIZE = 512;    // atlas texture dimension
const SDF_FONT = '48px monospace'; // Canvas 2D font for rasterization

// ── InlineCursor: greedy word-wrap line breaker ──
class InlineCursor {
  constructor(maxWidth) {
    this._maxWidth = maxWidth;
    this._lines = [{ words: [], width: 0 }];
    this._spaceWidth = 0;
  }
  pushWord(word, advance, spaceAdvance) {
    this._spaceWidth = spaceAdvance;
    const line = this._lines[this._lines.length - 1];
    const gap = line.words.length > 0 ? spaceAdvance : 0;
    if (line.words.length > 0 && line.width + gap + advance > this._maxWidth) {
      // Wrap to new line
      this._lines.push({ words: [{ word, width: advance }], width: advance });
    } else {
      line.words.push({ word, width: advance });
      line.width += gap + advance;
    }
  }
  pushHardBreak() {
    this._lines.push({ words: [], width: 0 });
  }
  getLines() { return this._lines; }
}

// Knuth-Plass balanced line breaking: minimize sum of squared slack per line.
// DP over break points — O(n²) but n = word count which is small for UI text.
class InlineBalancedCursor {
  constructor(maxWidth) {
    this._maxWidth = maxWidth;
    this._words = []; // [{word, advance, spaceAdvance}]
    this._hardBreaks = new Set(); // indices where hard breaks occur AFTER this word
  }
  pushWord(word, advance, spaceAdvance) {
    this._words.push({ word, advance, spaceAdvance });
  }
  pushHardBreak() {
    if (this._words.length > 0) this._hardBreaks.add(this._words.length - 1);
    else this._words.push({ word: '', advance: 0, spaceAdvance: 0 }); // empty word as break anchor
  }
  getLines() {
    const words = this._words;
    const n = words.length;
    if (n === 0) return [{ words: [], width: 0 }];
    const maxW = this._maxWidth;

    // Precompute prefix widths (including spaces between words)
    // lineWidth(i, j) = sum of advances[i..j] + sum of spaces[i+1..j]
    const advance = words.map(w => w.advance);
    const space = words.map(w => w.spaceAdvance);

    const lineWidth = (i, j) => {
      let w = 0;
      for (let k = i; k <= j; k++) {
        w += advance[k];
        if (k > i) w += space[k];
      }
      return w;
    };

    // DP: cost[i] = min cost to break words[0..i-1] into lines
    const cost = new Float64Array(n + 1).fill(Infinity);
    const breaks = new Int32Array(n + 1).fill(-1);
    cost[0] = 0;

    for (let j = 0; j < n; j++) {
      // Try lines ending at word j, starting from word i
      let w = 0;
      for (let i = j; i >= 0; i--) {
        w += advance[i];
        if (i < j) w += space[i + 1];
        if (w > maxW && i < j) break; // line too wide (allow single-word overflow)

        // Hard break constraint: if there's a hard break between i-1 and i,
        // the line MUST start at i (can't include words before the break)
        if (i > 0 && this._hardBreaks.has(i - 1)) {
          // This is fine — we're starting a line at i
        }
        // If a hard break exists within this line range (between i and j-1), skip
        let hasInternalBreak = false;
        for (let k = i; k < j; k++) {
          if (this._hardBreaks.has(k)) { hasInternalBreak = true; break; }
        }
        if (hasInternalBreak) continue;

        const slack = maxW - w;
        const penalty = slack * slack;
        const totalCost = cost[i] + penalty;
        if (totalCost < cost[j + 1]) {
          cost[j + 1] = totalCost;
          breaks[j + 1] = i;
        }
      }
    }

    // Also handle hard breaks as forced line endings
    for (let k = 0; k < n; k++) {
      if (this._hardBreaks.has(k)) {
        // Force a break after word k: lines ending at k must end here
        const nextStart = k + 1;
        if (nextStart <= n && cost[nextStart] > cost[k + 1]) {
          // Hard break doesn't add penalty — it's forced
        }
      }
    }

    // Reconstruct lines from break points
    const lineIndices = [];
    let pos = n;
    while (pos > 0) {
      const start = breaks[pos];
      lineIndices.unshift([start, pos - 1]);
      pos = start;
    }

    // Handle hard breaks: split any line that spans a hard break
    const finalLines = [];
    for (const [start, end] of lineIndices) {
      let segStart = start;
      for (let k = start; k <= end; k++) {
        if (this._hardBreaks.has(k) && k < end) {
          finalLines.push(this._buildLine(segStart, k));
          segStart = k + 1;
        }
      }
      finalLines.push(this._buildLine(segStart, end));
    }

    return finalLines;
  }
  _buildLine(start, end) {
    const words = [];
    let width = 0;
    for (let k = start; k <= end; k++) {
      const w = this._words[k];
      if (k > start) width += w.spaceAdvance;
      words.push({ word: w.word, width: w.advance });
      width += w.advance;
    }
    return { words, width };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// WGSL SHADERS — PATH PIPELINE (Phase 1, unchanged)
// ═══════════════════════════════════════════════════════════════════════

// flags encoding: bits 0-15 = element_id, bits 16-17 = fill_type (0=solid, 1=linear, 2=radial), bits 18-23 = gradient_index
const FILL_LINEAR = 1;
const FILL_RADIAL = 2;
const FILL_SHADOW = 3;
const FILL_CONIC = 4;

const SHARED_STRUCTS_WGSL = /* wgsl */`
struct SurfaceConfig {
  width: u32,
  height: u32,
  width_in_tiles: u32,
  height_in_tiles: u32,
  n_paths: u32,
  n_segments: u32,
  n_gradients: u32,
  _pad1: u32,
}

struct PathInfo {
  seg_start: u32,
  seg_count: u32,
  color: u32,
  flags: u32,        // bits 0-15: element_id, 16-18: fill_type, 19-24: gradient_index
}

// Gradient header — indexes into a flat GradientStop array for N-stop gradients
struct GradientInfo {
  color0: u32,        // packed RGBA8 stop 0 (fast path for 2-stop / shadow params)
  color1: u32,        // packed RGBA8 stop 1 (fast path for 2-stop / shadow params)
  p0: vec2f,          // start point (linear) or center (radial/shadow)
  p1: vec2f,          // end point (linear) or edge (radial) / half-size (shadow)
  stop_start: u32,    // first index in gradient_stops[] (ignored if stop_count == 0)
  stop_count: u32,    // N stops in gradient_stops[] (0 → 2-stop fast path: color0 @ t=0, color1 @ t=1)
}

struct GradientStop {
  color: u32,         // packed RGBA8
  t: f32,             // position [0..1]
}

struct LineSeg {
  p0: vec2f,
  p1: vec2f,
  path_ix: u32,
  _pad: u32,
}
`;

const FLATTEN_WGSL = /* wgsl */`
${SHARED_STRUCTS_WGSL}

@group(0) @binding(0) var<uniform> config: SurfaceConfig;
@group(0) @binding(1) var<storage, read> segments: array<LineSeg>;
@group(0) @binding(2) var<storage, read_write> tile_seg_counts: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> tile_segs: array<LineSeg>;
@group(0) @binding(4) var<storage, read_write> bump: array<atomic<u32>>;

const TILE: u32 = ${TILE_SIZE}u;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let seg_ix = gid.x;
  if (seg_ix >= config.n_segments) { return; }
  let seg = segments[seg_ix];
  let p0 = seg.p0; let p1 = seg.p1;
  let min_x = u32(max(floor(min(p0.x, p1.x) / f32(TILE)), 0.0));
  let max_x = min(u32(ceil(max(p0.x, p1.x) / f32(TILE))), config.width_in_tiles);
  let min_y = u32(max(floor(min(p0.y, p1.y) / f32(TILE)), 0.0));
  let max_y = min(u32(ceil(max(p0.y, p1.y) / f32(TILE))), config.height_in_tiles);
  for (var ty = min_y; ty < max_y; ty++) {
    for (var tx = min_x; tx < max_x; tx++) {
      let tile_ix = ty * config.width_in_tiles + tx;
      let slot = atomicAdd(&bump[0], 1u);
      if (slot < arrayLength(&tile_segs)) { tile_segs[slot] = seg; }
      atomicAdd(&tile_seg_counts[tile_ix], 1u);
    }
  }
}
`;

const COARSE_WGSL = /* wgsl */`
${SHARED_STRUCTS_WGSL}
struct TileCmd { cmd: u32, path_ix: u32, }
@group(0) @binding(0) var<uniform> config: SurfaceConfig;
@group(0) @binding(1) var<storage, read> path_info: array<PathInfo>;
@group(0) @binding(2) var<storage, read> segments: array<LineSeg>;
@group(0) @binding(3) var<storage, read_write> ptcl: array<TileCmd>;
const TILE: u32 = ${TILE_SIZE}u;
const MAX_CMDS: u32 = ${MAX_CMDS_PER_TILE}u;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let tile_x = gid.x; let tile_y = gid.y;
  if (tile_x >= config.width_in_tiles || tile_y >= config.height_in_tiles) { return; }
  let tile_min = vec2f(f32(tile_x * TILE), f32(tile_y * TILE));
  let tile_max = tile_min + vec2f(f32(TILE));
  let tile_ix = tile_y * config.width_in_tiles + tile_x;
  var cmd_offset = tile_ix * MAX_CMDS;
  var cmd_count = 0u;
  for (var pi = 0u; pi < config.n_paths; pi++) {
    let path = path_info[pi];
    var overlaps = false;
    for (var si = path.seg_start; si < path.seg_start + path.seg_count; si++) {
      let seg = segments[si];
      let seg_min = min(seg.p0, seg.p1); let seg_max = max(seg.p0, seg.p1);
      if (seg_max.x >= tile_min.x && seg_min.x < tile_max.x &&
          seg_max.y >= tile_min.y && seg_min.y < tile_max.y) { overlaps = true; break; }
    }
    if (overlaps && cmd_count < MAX_CMDS - 1u) { ptcl[cmd_offset + cmd_count] = TileCmd(1u, pi); cmd_count++; }
  }
  ptcl[cmd_offset + cmd_count] = TileCmd(0u, 0u);
}
`;

const FINE_WGSL = /* wgsl */`
${SHARED_STRUCTS_WGSL}
struct TileCmd { cmd: u32, path_ix: u32, }
@group(0) @binding(0) var<uniform> config: SurfaceConfig;
@group(0) @binding(1) var<storage, read> path_info: array<PathInfo>;
@group(0) @binding(2) var<storage, read> segments: array<LineSeg>;
@group(0) @binding(3) var<storage, read> ptcl: array<TileCmd>;
@group(0) @binding(4) var surface_out: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var<storage, read> gradients: array<GradientInfo>;
@group(0) @binding(6) var<storage, read> gradient_stops: array<GradientStop>;
const TILE: u32 = ${TILE_SIZE}u;
const MAX_CMDS: u32 = ${MAX_CMDS_PER_TILE}u;

fn unpack_color(c: u32) -> vec4f {
  return vec4f(f32(c & 0xFFu) / 255.0, f32((c >> 8u) & 0xFFu) / 255.0,
               f32((c >> 16u) & 0xFFu) / 255.0, f32((c >> 24u) & 0xFFu) / 255.0);
}

// Approximate erf for analytical shadow
fn erf_approx(x: f32) -> f32 {
  let s = sign(x);
  let a = abs(x);
  let t = 1.0 / (1.0 + 0.3275911 * a);
  let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a);
  return s * y;
}

// Analytical rounded-rect shadow: returns shadow intensity [0,1]
fn rounded_rect_shadow(p: vec2f, rect_center: vec2f, rect_half: vec2f, radius: f32, blur: f32) -> f32 {
  let q = abs(p - rect_center) - rect_half + vec2f(radius);
  let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - radius;
  let sigma = max(blur * 0.5, 0.5);
  return 0.5 - 0.5 * erf_approx(d / (sigma * 1.4142135));
}

// Sample N-stop gradient at position t ∈ [0,1]
fn sample_gradient(g: GradientInfo, t: f32) -> vec4f {
  if (g.stop_count == 0u) {
    // Fast path: 2-stop, color0 @ t=0, color1 @ t=1
    return mix(unpack_color(g.color0), unpack_color(g.color1), t);
  }
  // N-stop: binary search in gradient_stops[stop_start..stop_start+stop_count]
  let base = g.stop_start;
  let n = g.stop_count;
  // Clamp to first/last stop
  let first = gradient_stops[base];
  if (t <= first.t) { return unpack_color(first.color); }
  let last = gradient_stops[base + n - 1u];
  if (t >= last.t) { return unpack_color(last.color); }
  // Linear scan (N is small, typically 2-8)
  for (var i = 0u; i < n - 1u; i++) {
    let s0 = gradient_stops[base + i];
    let s1 = gradient_stops[base + i + 1u];
    if (t >= s0.t && t <= s1.t) {
      let dt = s1.t - s0.t;
      let frac = select((t - s0.t) / dt, 0.0, dt < 1e-6);
      return mix(unpack_color(s0.color), unpack_color(s1.color), frac);
    }
  }
  return unpack_color(last.color);
}

fn resolve_fill(path: PathInfo, pixel: vec2f) -> vec4f {
  let fill_type = (path.flags >> 16u) & 7u;
  if (fill_type == 0u) { return unpack_color(path.color); } // solid
  let grad_ix = (path.flags >> 19u) & 63u;
  if (grad_ix >= config.n_gradients) { return unpack_color(path.color); }
  let g = gradients[grad_ix];
  if (fill_type == 1u) { // linear
    let dir = g.p1 - g.p0;
    let len2 = dot(dir, dir);
    let t = select(clamp(dot(pixel - g.p0, dir) / len2, 0.0, 1.0), 0.0, len2 < 1e-6);
    return sample_gradient(g, t);
  }
  if (fill_type == 2u) { // radial
    let d = distance(pixel, g.p0);
    let r = distance(g.p0, g.p1);
    let t = select(clamp(d / r, 0.0, 1.0), 0.0, r < 1e-6);
    return sample_gradient(g, t);
  }
  if (fill_type == 3u) { // analytical shadow
    let shadow_color = unpack_color(g.color0);
    let rect_half = g.p1;
    let c1 = unpack_color(g.color1);
    let radius = c1.r * 255.0;
    let blur = max(c1.g * 255.0, 1.0);
    let intensity = rounded_rect_shadow(pixel, g.p0, rect_half, radius, blur);
    return vec4f(shadow_color.rgb, shadow_color.a * intensity);
  }
  if (fill_type == 4u) { // conic gradient
    let d = pixel - g.p0;
    let angle = atan2(d.y, d.x); // [-PI, PI]
    let offset_angle = g.p1.x; // angle offset stored in p1.x
    let a = angle - offset_angle;
    let t = fract((a / (2.0 * 3.14159265358979) + 0.5)); // normalize to [0,1]
    return sample_gradient(g, t);
  }
  return unpack_color(path.color);
}

fn line_coverage(p0_in: vec2f, p1_in: vec2f, pixel: vec2f) -> f32 {
  let a = p0_in - pixel; let b = p1_in - pixel;
  let dy = b.y - a.y;
  if (abs(dy) < 1e-6) { return 0.0; }
  let t0 = clamp(-a.y / dy, 0.0, 1.0); let t1 = clamp((1.0 - a.y) / dy, 0.0, 1.0);
  let t_lo = min(t0, t1); let t_hi = max(t0, t1);
  let y0 = a.y + t_lo * dy; let y1 = a.y + t_hi * dy;
  let dx = b.x - a.x; let x0 = a.x + t_lo * dx; let x1 = a.x + t_hi * dx;
  let x_avg = (x0 + x1) * 0.5;
  return (y1 - y0) * clamp(1.0 - x_avg, 0.0, 1.0);
}

@compute @workgroup_size(${TILE_SIZE}, ${TILE_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(workgroup_id) wg: vec3u) {
  let px = gid.x; let py = gid.y;
  if (px >= config.width || py >= config.height) { return; }
  let tile_ix = wg.y * config.width_in_tiles + wg.x;
  let pixel = vec2f(f32(px), f32(py));
  var color = vec4f(0.0);
  let base = tile_ix * MAX_CMDS;
  for (var ci = 0u; ci < MAX_CMDS; ci++) {
    let tcmd = ptcl[base + ci];
    if (tcmd.cmd == 0u) { break; }
    if (tcmd.cmd == 1u) {
      let path = path_info[tcmd.path_ix];
      var winding = 0.0;
      for (var si = path.seg_start; si < path.seg_start + path.seg_count; si++) {
        let seg = segments[si];
        winding += line_coverage(seg.p0, seg.p1, pixel);
      }
      let cov = clamp(abs(winding), 0.0, 1.0);
      let src = resolve_fill(path, pixel);
      let src_pm = vec4f(src.rgb * src.a * cov, src.a * cov);
      color = src_pm + color * (1.0 - src_pm.a);
    }
  }
  textureStore(surface_out, vec2i(vec2u(px, py)), color);
}
`;

const HIT_TEST_WGSL = /* wgsl */`
${SHARED_STRUCTS_WGSL}
struct HitResult { element_id: u32, winding: f32, _pad0: u32, _pad1: u32, }
struct MousePos { x: f32, y: f32, }
@group(0) @binding(0) var<uniform> config: SurfaceConfig;
@group(0) @binding(1) var<storage, read> path_info: array<PathInfo>;
@group(0) @binding(2) var<storage, read> segments: array<LineSeg>;
@group(0) @binding(3) var<uniform> mouse: MousePos;
@group(0) @binding(4) var<storage, read_write> hit: HitResult;
@compute @workgroup_size(1)
fn main() {
  let point = vec2f(mouse.x, mouse.y);
  for (var pi = i32(config.n_paths) - 1; pi >= 0; pi--) {
    let path = path_info[u32(pi)];
    var winding = 0.0;
    for (var si = path.seg_start; si < path.seg_start + path.seg_count; si++) {
      let seg = segments[si];
      let dy = seg.p1.y - seg.p0.y;
      if (abs(dy) < 1e-6) { continue; }
      let t = (point.y - seg.p0.y) / dy;
      if (t < 0.0 || t > 1.0) { continue; }
      let x_cross = seg.p0.x + t * (seg.p1.x - seg.p0.x);
      if (x_cross > point.x) { if (dy > 0.0) { winding += 1.0; } else { winding -= 1.0; } }
    }
    if (abs(winding) > 0.5) { hit.element_id = path.flags & 0xFFFFu; hit.winding = winding; return; }
  }
  hit.element_id = 0xFFFFFFFFu; hit.winding = 0.0;
}
`;

const COMPOSITE_WGSL = /* wgsl */`
@group(0) @binding(0) var surface_tex: texture_2d<f32>;
@group(0) @binding(1) var surface_sampler: sampler;
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, }
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  let uv = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var out: VSOut;
  out.pos = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(uv.x, 1.0 - uv.y);
  return out;
}
@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  return textureSample(surface_tex, surface_sampler, in.uv);
}
`;

// ═══════════════════════════════════════════════════════════════════════
// WGSL SHADER — SDF TEXT (Phase 2)
// ═══════════════════════════════════════════════════════════════════════

const SDF_TEXT_WGSL = /* wgsl */`
struct GlyphInstance {
  pos_size: vec4f,   // x, y, w, h in pixels
  uv_rect: vec4f,    // u0, v0, u1, v1 in atlas [0..1]
  color: u32,
  _pad: u32,
  _pad2: u32,
  _pad3: u32,
}

struct SurfaceDims {
  width: f32,
  height: f32,
}

@group(0) @binding(0) var<storage, read> glyphs: array<GlyphInstance>;
@group(0) @binding(1) var sdf_atlas: texture_2d<f32>;
@group(0) @binding(2) var sdf_sampler: sampler;
@group(0) @binding(3) var<uniform> dims: SurfaceDims;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) color: u32,
}

fn unpack_color(c: u32) -> vec4f {
  return vec4f(f32(c & 0xFFu) / 255.0, f32((c >> 8u) & 0xFFu) / 255.0,
               f32((c >> 16u) & 0xFFu) / 255.0, f32((c >> 24u) & 0xFFu) / 255.0);
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  let g = glyphs[ii];
  // Quad corners: 0=TL, 1=TR, 2=BL, 3=TR, 4=BR, 5=BL
  let corner = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0),
  );
  let c = corner[vi];
  let px = g.pos_size.xy + c * g.pos_size.zw;
  // Pixel coords → NDC
  let ndc = vec2f(px.x / dims.width * 2.0 - 1.0, 1.0 - px.y / dims.height * 2.0);
  let uv = mix(g.uv_rect.xy, g.uv_rect.zw, c);
  var out: VSOut;
  out.pos = vec4f(ndc, 0.0, 1.0);
  out.uv = uv;
  out.color = g.color;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let dist = textureSample(sdf_atlas, sdf_sampler, in.uv).r;
  let edge = 0.5;
  let w = fwidth(dist);
  let alpha = smoothstep(edge - w, edge + w, dist);
  let c = unpack_color(in.color);
  return vec4f(c.rgb * c.a * alpha, c.a * alpha);
}
`;

// ═══════════════════════════════════════════════════════════════════════
// SURFACE TRANSDUCER CLASS
// ═══════════════════════════════════════════════════════════════════════

export class RexSurface {
  constructor(device, context, format, log) {
    this.device = device;
    this.context = context;
    this.format = format;
    this.log = log;

    // Scene data (CPU)
    this._paths = [];
    this._segments = [];
    this._textQuads = [];  // Phase 2: SDF glyph instances
    this._gradients = [];       // Phase 4: gradient headers
    this._gradientStops = [];   // Phase 4: flat array of {color, t} for N-stop gradients

    // Canvas dimensions
    this._width = 0;
    this._height = 0;
    this._tilesX = 0;
    this._tilesY = 0;

    // GPU resources — path pipeline
    this._configBuffer = null;
    this._segmentBuffer = null;
    this._pathInfoBuffer = null;
    this._tileSegCountsBuffer = null;
    this._ptclBuffer = null;
    this._tileSegsBuffer = null;
    this._bumpBuffer = null;
    this._hitResultBuffer = null;
    this._mousePosBuffer = null;
    this._surfaceTexture = null;
    this._surfaceSampler = null;

    // GPU resources — gradients
    this._gradientBuffer = null;
    this._gradientStopsBuffer = null;

    // GPU resources — SDF text
    this._sdfFont = SDF_FONT;    // configurable: '48px monospace', '48px sans-serif', etc.
    this._sdfAtlasTexture = null;
    this._sdfAtlasSampler = null;
    this._glyphBuffer = null;
    this._sdfDimsBuffer = null;

    // Pipelines — path
    this._flattenPipeline = null;
    this._coarsePipeline = null;
    this._finePipeline = null;
    this._hitTestPipeline = null;
    this._compositePipeline = null;

    // Pipelines — SDF text
    this._sdfPipeline = null;

    // Bind groups
    this._flattenBG = null;
    this._coarseBG = null;
    this._fineBG = null;
    this._hitTestBG = null;
    this._compositeBG = null;
    this._sdfBG = null;

    // State
    this._active = false;
    this._compositeLoadOp = 'clear';
    this._mouseX = 0;
    this._mouseY = 0;
    this._lastHitId = 0xFFFFFFFF;
    this._hitReadbackBuffer = null;
    this._hitReadbackPending = false;
    this.onHitChange = null;   // callback(elementId) — hover change
    this.onElementClick = null; // callback(elementId, x, y) — click on element
    this._pendingClick = null;  // {x, y} if click waiting for readback

    // Glyph atlas cache
    this._glyphCache = new Map();
    this._atlasChars = '';
    this._measureCanvas = null;
    this._measureCtx = null;

    // Text editor state (Phase 5: self-hosting)
    this._editors = new Map();       // id → {content, cursor, selStart, selEnd, scrollY, x, y, w, h, lineHeight, textLeft}
    this._focusedEditor = null;      // id of focused editor
    this._editorDirty = false;       // true when editor state changed, needs recompile
    this.onEditorChange = null;      // callback(id, content, cursor) for roundtrip to tree

    // External state for expression evaluation (wired by main.js)
    this.formState = null;           // form transducer state → expression resolution
    this.behaviour = null;           // behaviour transducer → @def call resolution

    // @each iteration context: {item: Map, key: string, index: number}
    this._eachOverlay = null;
    this._defaultShrubName = null;

    // Parent panel dimensions for percentage resolution (tracks containing block)
    this._parentWidth = 0;
    this._parentHeight = 0;

    // Subtree cache for incremental recompilation
    this._subtreeCache = new Map(); // hash → {paths, segments, textQuads, gradients, gradientStops}
    this._compileFrame = 0;

    // Embedded @surface instances: src → {tree, behaviour, srcHash}
    this._embeddedSurfaces = new Map();

    // Image cache: src → { bitmap, w, h, loading }
    this._imageCache = new Map();

    // Loaded fonts: name → { loaded, fontFace }
    this._loadedFonts = new Map();

    // Extension protocol: registered handlers for custom element types
    this._elementHandlers = new Map();
    this._surfaceTypeSet = new Set(['rect', 'text', 'panel', 'shadow', 'path', 'text-editor', 'each', 'match', 'surface', 'viewport', 'image', 'if']);
    this._warnedTypes = new Set();

    // Incremental compile tracking
    this._lastTree = null;
    this._lastCanvasWidth = 0;
    this._lastCanvasHeight = 0;
    this._editorDirty = false;
    this._nonEditorCounts = null;  // {paths, segs, quads, grads, stops} saved before editor collection

    // Create pipelines once
    this._createPipelines();
  }

  get active() { return this._active; }

  setCompositeMode(mode) {
    this._compositeLoadOp = mode === 'overlay' ? 'load' : 'clear';
  }

  setMousePos(x, y) {
    this._mouseX = x;
    this._mouseY = y;
  }

  // Extension: register a custom surface element type
  // handler = { collect(node, ox, oy, clip, surface), measure(node, surface) }
  registerElementType(typeName, handler) {
    this._elementHandlers.set(typeName, handler);
    this._surfaceTypeSet.add(typeName);
  }

  setFont(fontSpec) {
    // fontSpec: e.g. '48px sans-serif', '48px "Courier New"'
    this._sdfFont = fontSpec;
    this._atlasChars = null;        // force atlas rebuild
    this._glyphCache.clear();       // clear cached metrics
  }

  // ════════════════════════════════════════════════════════════════
  // COMPILE PHASE
  // ════════════════════════════════════════════════════════════════

  // FNV-1a structural hash of a subtree for incremental recompile detection
  _hashSubtree(node) {
    if (node._surfaceHash !== undefined) return node._surfaceHash;
    let h = 0x811c9dc5;
    const feed = (s) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } };
    feed(node.type || '');
    feed(node.name || '');
    if (node.attrs) {
      const keys = Object.keys(node.attrs).sort();
      for (const k of keys) { feed(k); feed(String(node.attrs[k])); }
    }
    if (node.children) {
      for (const c of node.children) {
        h ^= this._hashSubtree(c);
        h = Math.imul(h, 0x01000193);
      }
    }
    node._surfaceHash = h >>> 0;
    return node._surfaceHash;
  }

  compile(tree, canvasWidth, canvasHeight) {
    this._compileFrame++;
    this._width = canvasWidth;
    this._height = canvasHeight;
    this._parentWidth = canvasWidth;
    this._parentHeight = canvasHeight;
    this._tilesX = Math.ceil(canvasWidth / TILE_SIZE);
    this._tilesY = Math.ceil(canvasHeight / TILE_SIZE);

    const sizeChanged = canvasWidth !== this._lastCanvasWidth || canvasHeight !== this._lastCanvasHeight;
    const treeChanged = tree !== this._lastTree;

    // ── Fast path: editor-only recompile ──
    if (!treeChanged && !sizeChanged && this._editorDirty && this._active && this._nonEditorCounts) {
      this._editorDirty = false;
      return this._recompileEditorOnly();
    }

    this._lastTree = tree;
    this._lastCanvasWidth = canvasWidth;
    this._lastCanvasHeight = canvasHeight;
    this._editorDirty = false;

    // 1. Collect all surface elements (with per-subtree caching)
    this._paths = [];
    this._segments = [];
    this._textQuads = [];
    this._gradients = [];
    this._gradientStops = [];
    this._measureCache = new Map();  // Phase 2C: memoize _measureElement per compile
    this._surfaceCtx = null;         // reset eval context each compile (picks up fresh formState)
    this._eachOverlay = null;        // reset overlay each compile
    this._warnedTypes.clear();
    this._nonEditorCounts = null;
    // Set default shrub name from behaviour (first shrub)
    if (this.behaviour) {
      const names = this.behaviour.getShrubNames();
      this._defaultShrubName = names.length > 0 ? names[0] : null;
    }

    // Per-subtree caching: hash each top-level child. If hash matches and canvas
    // size unchanged, replay cached segments instead of re-collecting.
    if (!sizeChanged && tree.children && tree.children.length > 0) {
      const newCache = new Map();
      for (const child of tree.children) {
        if (!this._surfaceTypeSet.has(child.type) && child.type !== 'each') continue;
        const hash = this._hashSubtree(child);
        const cached = this._subtreeCache.get(hash);
        if (cached) {
          // Replay cached segments
          this._paths.push(...cached.paths);
          this._segments.push(...cached.segments);
          this._textQuads.push(...cached.textQuads);
          this._gradients.push(...cached.gradients);
          this._gradientStops.push(...cached.gradientStops);
          newCache.set(hash, cached);
        } else {
          // Collect fresh — snapshot before/after to cache the delta
          const pi = this._paths.length, si = this._segments.length;
          const ti = this._textQuads.length, gi = this._gradients.length;
          const gsi = this._gradientStops.length;
          this._collectElements({ children: [child] }, 0, 0);
          newCache.set(hash, {
            paths: this._paths.slice(pi),
            segments: this._segments.slice(si),
            textQuads: this._textQuads.slice(ti),
            gradients: this._gradients.slice(gi),
            gradientStops: this._gradientStops.slice(gsi),
          });
        }
      }
      this._subtreeCache = newCache;
    } else {
      this._subtreeCache.clear();
      this._collectElements(tree, 0, 0);
    }

    // GC embedded surfaces not used in this frame
    this._gcEmbeddedSurfaces();

    const hasPaths = this._paths.length > 0;
    const hasText = this._textQuads.length > 0;

    if (!hasPaths && !hasText) {
      this._active = false;
      return;
    }

    this._active = true;

    // 2. Build SDF atlas if we have text
    if (hasText) {
      this._buildGlyphAtlas();
    }

    // 3. Create GPU resources
    this._createBuffers();

    // 4. Upload scene data
    this._uploadSceneData();

    // 5. Create bind groups
    this._createBindGroups();

    this.log(`surface: ${this._paths.length} paths, ${this._segments.length} segs, ${this._textQuads.length} glyphs, ${this._tilesX}x${this._tilesY} tiles`, 'ok');
  }

  // ── Incremental editor-only recompile ──
  // Only re-collects text-editor elements, preserving all non-editor paths/segments.
  // Called when tree reference unchanged and only editor content changed.
  _recompileEditorOnly() {
    const c = this._nonEditorCounts;
    this._paths.length = c.paths;
    this._segments.length = c.segs;
    this._textQuads.length = c.quads;
    this._gradients.length = c.grads;
    this._gradientStops.length = c.stops;

    this._surfaceCtx = null;
    this._nonEditorCounts = null;  // will be re-saved by _collectTextEditor

    // Re-collect only text-editor elements via cached node refs
    for (const [, ed] of this._editors) {
      if (ed._node) {
        this._collectTextEditor(ed._node, ed._offsetX || 0, ed._offsetY || 0, ed._clip);
      }
    }

    const hasPaths = this._paths.length > 0;
    const hasText = this._textQuads.length > 0;
    if (!hasPaths && !hasText) { this._active = false; return; }
    this._active = true;

    if (hasText) this._buildGlyphAtlas();
    this._createBuffers();
    this._uploadSceneData();
    this._createBindGroups();
  }

  // ════════════════════════════════════════════════════════════════
  // EXPRESSION-AWARE ATTRIBUTE ACCESS
  // ════════════════════════════════════════════════════════════════

  // Resolve an attribute value that may be a literal or an expression object {expr, rex}.
  // Returns a number for numeric attrs, or the raw value for non-numeric (color arrays, strings, etc).
  _attr(node, key, fallback) {
    const v = node.attrs[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v === 'object' && v.expr !== undefined) {
      // Expression object — compile on first use, then evaluate
      if (v._compiled === undefined) v._compiled = Rex.compileExpr(v) ?? false;
      if (!this._surfaceCtx) this._surfaceCtx = this._makeSurfaceEvalContext();
      const result = Rex.evalExpr(v._compiled, this._surfaceCtx);
      return result !== undefined ? result : fallback;
    }
    return v;
  }

  // Numeric variant — always returns a number
  _numAttr(node, key, fallback) {
    const v = this._attr(node, key, fallback);
    if (typeof v === 'number') return v;
    const n = +v;
    return Number.isFinite(n) ? n : fallback;
  }

  _makeSurfaceEvalContext() {
    const self = this;
    return {
      resolve(op, key, args) {
        if (op === 'binding') {
          // @each overlay: $item, $key, $index, $item/field
          const ov = self._eachOverlay;
          if (!ov) return undefined;
          if (key === 'item') return ov.item;
          if (key === 'key') return ov.key;
          if (key === 'index') return ov.index;
          if (key.startsWith('item/') || key.startsWith('item.')) {
            const field = key.slice(5);
            const item = ov.item;
            return item instanceof Map ? item.get(field) : item?.[field];
          }
          // Flat overlay: bare field name → check item Map
          if (ov.item instanceof Map && ov.item.has(key)) return ov.item.get(key);
          return undefined;
        }
        if (op === 'ident') {
          // @each overlay check first — bare names resolve against item
          const ov = self._eachOverlay;
          if (ov && ov.item instanceof Map && ov.item.has(key)) return ov.item.get(key);
          // Surface builtins
          if (key === 'canvas-width' || key === 'width') return self._width;
          if (key === 'canvas-height' || key === 'height') return self._height;
          const n = +key;
          if (Number.isFinite(n)) return n;
          // Check form state if wired
          if (self.formState && self.formState[key] !== undefined) return self.formState[key];
          return undefined;
        }
        if (op === 'slot') {
          // @each overlay check first
          const ov = self._eachOverlay;
          if (ov && ov.item instanceof Map && ov.item.has(key)) return ov.item.get(key);
          if (key.startsWith('form/') && self.formState) return self.formState[key.slice(5)] ?? 0;
          if (self.formState && self.formState[key] !== undefined) return self.formState[key];
          return 0;
        }
        if (op === 'dep') {
          if (self.formState && self.formState[key] !== undefined) return self.formState[key];
          return 0;
        }
        if (op === 'call') {
          if (self.behaviour && self.behaviour.hasDef(key)) return self.behaviour.callDef(key, args);
          // Zero-arg call: treat as ident/slot (handles `(form/x)`, `(canvas-width)`, etc.)
          if (!args || args.length === 0) {
            if (key.startsWith('form/') && self.formState) return self.formState[key.slice(5)] ?? 0;
            if (key === 'canvas-width' || key === 'width') return self._width;
            if (key === 'canvas-height' || key === 'height') return self._height;
            if (self.formState && self.formState[key] !== undefined) return self.formState[key];
          }
        }
        return undefined;
      }
    };
  }

  // ════════════════════════════════════════════════════════════════
  // ELEMENT COLLECTION — @rect, @text, @panel
  // ════════════════════════════════════════════════════════════════

  _collectElements(node, offsetX, offsetY, clip) {
    for (const child of node.children) {
      switch (child.type) {
        case 'rect': this._collectRect(child, offsetX, offsetY, clip); break;
        case 'text': this._collectText(child, offsetX, offsetY, clip); break;
        case 'panel': this._collectPanel(child, offsetX, offsetY, clip); break;
        case 'shadow': this._collectShadow(child, offsetX, offsetY); break;
        case 'path': this._collectPath(child, offsetX, offsetY); break;
        case 'text-editor': this._collectTextEditor(child, offsetX, offsetY, clip); break;
        case 'each': this._collectEach(child, offsetX, offsetY, clip); break;
        case 'match': this._collectMatch(child, offsetX, offsetY, clip); break;
        case 'surface': this._collectSurface(child, offsetX, offsetY, clip); break;
        case 'viewport': this._collectViewport(child, offsetX, offsetY, clip); break;
        case 'image': this._collectImage(child, offsetX, offsetY, clip); break;
        case 'if': this._collectIf(child, offsetX, offsetY, clip); break;
        default: {
          const h = this._elementHandlers.get(child.type);
          if (h && h.collect) h.collect(child, offsetX, offsetY, clip, this);
          else this._collectElements(child, offsetX, offsetY, clip);
          break;
        }
      }
    }
  }

  // Resolve @each node → sorted entries [[key, item], ...]
  _resolveEachEntries(node) {
    if (!this.behaviour) return null;
    const kidsAttr = this._attr(node, 'kids', node.name || '');
    if (!kidsAttr) return null;
    const parts = kidsAttr.split('/');
    let shrubName, collectionPath;
    if (parts.length >= 2) {
      const names = this.behaviour.getShrubNames();
      if (names.includes(parts[0])) {
        shrubName = parts[0];
        collectionPath = parts.slice(1).join('/');
      } else {
        shrubName = this._defaultShrubName || names[0];
        collectionPath = kidsAttr;
      }
    } else {
      shrubName = this._defaultShrubName || this.behaviour.getShrubNames()[0];
      collectionPath = kidsAttr;
    }
    if (!shrubName) return null;

    const kids = this.behaviour.getKids(shrubName, collectionPath);
    if (!kids || kids.size === 0) return null;

    let entries = [...kids.entries()];
    const sortField = this._attr(node, 'sort', null);
    if (sortField) {
      const desc = sortField.startsWith('-');
      const field = desc ? sortField.slice(1) : sortField;
      entries.sort((a, b) => {
        const va = a[1] instanceof Map ? a[1].get(field) : a[1]?.[field];
        const vb = b[1] instanceof Map ? b[1].get(field) : b[1]?.[field];
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return desc ? (vb > va ? 1 : vb < va ? -1 : 0) : (va > vb ? 1 : va < vb ? -1 : 0);
      });
    }
    return entries;
  }

  // Expand @each into flat [{child, overlay}] for panel flex layout participation
  _expandEachForLayout(node) {
    const entries = this._resolveEachEntries(node);
    if (!entries) return [];
    const result = [];
    for (let i = 0; i < entries.length; i++) {
      const [key, item] = entries[i];
      const overlay = { item, key, index: i };
      for (const child of node.children) {
        if (this._surfaceTypeSet.has(child.type)) {
          result.push({ child, overlay });
        }
      }
    }
    return result;
  }

  _collectEach(node, offsetX, offsetY, clip) {
    const entries = this._resolveEachEntries(node);
    if (!entries) return;

    const savedOverlay = this._eachOverlay;
    for (let i = 0; i < entries.length; i++) {
      const [key, item] = entries[i];
      this._eachOverlay = { item, key, index: i };
      this._surfaceCtx = null;
      for (const child of node.children) {
        if (this._surfaceTypeSet.has(child.type)) {
          this._collectElements({ children: [child] }, offsetX, offsetY, clip);
        }
      }
    }
    this._eachOverlay = savedOverlay;
    this._surfaceCtx = null;
  }

  // Resolve match condition value — checks node.name or :test attr against overlay/formState
  _resolveMatchValue(node) {
    // :test attr takes priority (may be expression)
    const testAttr = this._attr(node, 'test', undefined);
    if (testAttr !== undefined) {
      // If it's a string name, resolve against overlay/formState
      if (typeof testAttr === 'string') return this._resolveMatchName(testAttr);
      return testAttr;
    }
    // node.name is the bare match condition
    if (node.name) return this._resolveMatchName(node.name);
    return undefined;
  }

  // Resolve a name against @each overlay and formState (for match conditions)
  _resolveMatchName(name) {
    if (name.startsWith('$')) {
      const key = name.slice(1);
      const ov = this._eachOverlay;
      if (ov) {
        if (key === 'key') return ov.key;
        if (key === 'index') return ov.index;
        if (key.startsWith('item/') || key.startsWith('item.')) {
          const field = key.slice(5);
          return ov.item instanceof Map ? ov.item.get(field) : ov.item?.[field];
        }
        if (ov.item instanceof Map && ov.item.has(key)) return ov.item.get(key);
      }
      return undefined;
    }
    // Bare name: check overlay item first, then formState
    const ov = this._eachOverlay;
    if (ov && ov.item instanceof Map && ov.item.has(name)) return ov.item.get(name);
    if (this.formState && this.formState[name] !== undefined) return this.formState[name];
    return name; // literal fallback
  }

  // Expand @match for layout — returns children of the matching @case branch
  _expandMatchForLayout(node) {
    const testVal = this._resolveMatchValue(node);
    for (const child of node.children) {
      if (child.type === 'case' && String(testVal) === String(child.name)) {
        return child.children.filter(c => this._surfaceTypeSet.has(c.type));
      }
    }
    // Check default
    for (const child of node.children) {
      if (child.type === 'default' || (child.type === 'case' && child.name === '*')) {
        return child.children.filter(c => this._surfaceTypeSet.has(c.type));
      }
    }
    return [];
  }

  _collectMatch(node, offsetX, offsetY, clip) {
    const testVal = this._resolveMatchValue(node);
    // Find matching @case — first match wins
    for (const child of node.children) {
      if (child.type === 'case') {
        const caseVal = child.name;
        // String comparison (case values are always strings from parser)
        if (String(testVal) === String(caseVal)) {
          this._collectElements(child, offsetX, offsetY, clip);
          return;
        }
      }
    }
    // No match — check for @default case
    for (const child of node.children) {
      if (child.type === 'default' || (child.type === 'case' && child.name === '*')) {
        this._collectElements(child, offsetX, offsetY, clip);
        return;
      }
    }
  }

  _collectSurface(node, offsetX, offsetY, clip) {
    const src = this._attr(node, 'src', null);
    if (!src) return;
    const srcStr = String(src);
    if (!srcStr) return;

    const x = this._numAttr(node, 'x', 0) + offsetX;
    const y = this._numAttr(node, 'y', 0) + offsetY;
    const w = this._numAttr(node, 'w', 200);
    const h = this._numAttr(node, 'h', 200);

    // Clip to viewport rect
    const surfaceClip = { x, y, w, h };
    const activeClip = clip ? {
      x: Math.max(clip.x, x), y: Math.max(clip.y, y),
      w: Math.min(clip.x + clip.w, x + w) - Math.max(clip.x, x),
      h: Math.min(clip.y + clip.h, y + h) - Math.max(clip.y, y),
    } : surfaceClip;

    // Lazy loading: if entirely clipped (off-screen), render placeholder only
    if (activeClip.w <= 0 || activeClip.h <= 0) {
      // Off-screen — don't parse/compile, just skip
      return;
    }

    // Get or create embedded surface state
    let embedded = this._embeddedSurfaces.get(srcStr);
    if (!embedded) {
      try {
        const childTree = Rex.parse(srcStr);
        let childBehaviour = null;
        if (this.behaviour && this.behaviour.constructor) {
          childBehaviour = new this.behaviour.constructor(this.log);
          childBehaviour.transduce(childTree, true);
        }
        embedded = { tree: childTree, behaviour: childBehaviour, src: srcStr, lastUsedFrame: 0 };
        this._embeddedSurfaces.set(srcStr, embedded);
      } catch (e) {
        this.log(`@surface parse error: ${e.message}`, 'err');
        this._addRectPath(x, y, w, h, 4, this._packColor([0.5, 0, 0, 0.3]));
        return;
      }
    }

    // Lifecycle: track last-used frame for GC of stale surfaces
    embedded.lastUsedFrame = this._compileFrame || 0;

    // Save parent state
    const savedBehaviour = this.behaviour;
    const savedFormState = this.formState;
    const savedWidth = this._width;
    const savedHeight = this._height;
    const savedOverlay = this._eachOverlay;
    const savedDefaultShrub = this._defaultShrubName;
    const savedParentW = this._parentWidth;
    const savedParentH = this._parentHeight;

    // Sandbox: child gets its own isolated behaviour — no access to parent shrubs
    this.behaviour = embedded.behaviour;
    this.formState = null;
    this._width = w;
    this._height = h;
    this._parentWidth = w;
    this._parentHeight = h;
    this._surfaceCtx = null;
    this._eachOverlay = null;
    if (this.behaviour) {
      const names = this.behaviour.getShrubNames();
      this._defaultShrubName = names.length > 0 ? names[0] : null;
    }

    this._collectElements(embedded.tree, x, y, activeClip);

    // Restore parent state (full isolation)
    this.behaviour = savedBehaviour;
    this.formState = savedFormState;
    this._width = savedWidth;
    this._height = savedHeight;
    this._parentWidth = savedParentW;
    this._parentHeight = savedParentH;
    this._surfaceCtx = null;
    this._eachOverlay = savedOverlay;
    this._defaultShrubName = savedDefaultShrub;
  }

  // Lifecycle: garbage-collect embedded surfaces not used in the last compile frame
  _gcEmbeddedSurfaces() {
    const currentFrame = this._compileFrame || 0;
    for (const [key, embedded] of this._embeddedSurfaces) {
      if (embedded.lastUsedFrame < currentFrame - 1) {
        this._embeddedSurfaces.delete(key);
      }
    }
  }

  // @viewport: camera transform (translate + scale) applied to children
  // Children are offset by -x,-y and scaled by zoom
  _collectViewport(node, offsetX, offsetY, clip) {
    const camX = this._numAttr(node, 'x', 0);
    const camY = this._numAttr(node, 'y', 0);
    const zoom = this._numAttr(node, 'zoom', 1);

    // The viewport applies a camera transform: child positions are
    // translated by -cam and scaled by zoom. For GPU rendering, we
    // pre-transform the offset so all child geometry lands at the
    // correct canvas position.
    const vpX = offsetX - camX * zoom;
    const vpY = offsetY - camY * zoom;

    // Save and set scale factor for child dimensions
    const savedScaleX = this._viewportScaleX || 1;
    const savedScaleY = this._viewportScaleY || 1;
    this._viewportScaleX = zoom;
    this._viewportScaleY = zoom;

    this._collectElements(node, vpX, vpY, clip);

    this._viewportScaleX = savedScaleX;
    this._viewportScaleY = savedScaleY;
  }

  // ── @if: conditional rendering ──
  // @if :test expr — renders children only when expression is truthy
  _collectIf(node, offsetX, offsetY, clip) {
    const testVal = this._attr(node, 'test', undefined);
    // Also support bare name as expression key
    const resolvedVal = testVal !== undefined ? testVal : this._resolveMatchValue(node);
    if (resolvedVal) {
      this._collectElements(node, offsetX, offsetY, clip);
    }
  }

  // Expand @if for layout — returns children if condition true, empty if false
  _expandIfForLayout(node) {
    const testVal = this._attr(node, 'test', undefined);
    const resolvedVal = testVal !== undefined ? testVal : this._resolveMatchValue(node);
    if (resolvedVal) return node.children || [];
    return [];
  }

  // ── @image: 2D image element rendered as textured rect ──
  // For now, renders as a placeholder rect (images need async loading + texture atlas)
  // In full implementation, the image would be sampled from a texture in the fine rasterizer
  _collectImage(node, offsetX, offsetY, clip) {
    const x = this._numAttr(node, 'x', 0) + offsetX;
    const y = this._numAttr(node, 'y', 0) + offsetY;
    const w = this._numAttr(node, 'w', 100);
    const h = this._numAttr(node, 'h', 100);
    const src = this._attr(node, 'src', '');
    const fit = this._attr(node, 'fit', 'cover'); // cover, contain, fill, none
    const opacity = this._numAttr(node, 'opacity', 1);
    const radius = this._numAttr(node, 'radius', 0);
    const tint = this._attr(node, 'tint', undefined);

    // Skip if entirely outside clip rect
    if (clip && (y + h < clip.y || y > clip.y + clip.h || x + w < clip.x || x > clip.x + clip.w)) return;

    // Async image loading — load once, cache
    if (src && !this._imageCache.has(src)) {
      this._imageCache.set(src, { bitmap: null, w: 0, h: 0, loading: true });
      // Start async load (does not block rendering — placeholder shows until loaded)
      if (typeof fetch !== 'undefined' && typeof createImageBitmap !== 'undefined') {
        fetch(src).then(r => r.blob()).then(b => createImageBitmap(b)).then(bmp => {
          this._imageCache.set(src, { bitmap: bmp, w: bmp.width, h: bmp.height, loading: false });
        }).catch(() => {
          this._imageCache.set(src, { bitmap: null, w: 0, h: 0, loading: false });
        });
      }
    }

    const cached = this._imageCache.get(src);
    if (cached && cached.bitmap && this._measureCtx) {
      // Render image by drawing to measure canvas and creating SDF-style quads
      // For now, render as a tinted/placeholder rect — full texture sampling requires
      // a separate texture binding in the fine rasterizer (future work)
      const fillColor = tint || [0.5, 0.5, 0.5, opacity];
      this._addRectPath(x, y, w, h, radius, this._packColor(this._applyOpacity(fillColor, opacity)));
    } else {
      // Placeholder: light gray rect while loading
      const placeholderColor = [0.85, 0.85, 0.85, opacity];
      this._addRectPath(x, y, w, h, radius, this._packColor(this._applyOpacity(placeholderColor, opacity)));
    }

    this._collectElements(node, x, y, clip);
  }

  // ── Per-element 2D transforms ──
  // Applies rotation, scale, skew to segment coordinates
  _applyTransform(node, segments, cx, cy) {
    const rotate = this._numAttr(node, 'rotate', 0) * Math.PI / 180;
    const scaleX = this._numAttr(node, 'scale-x', this._numAttr(node, 'scale', 1));
    const scaleY = this._numAttr(node, 'scale-y', this._numAttr(node, 'scale', 1));
    const skewX = this._numAttr(node, 'skew-x', 0) * Math.PI / 180;
    const skewY = this._numAttr(node, 'skew-y', 0) * Math.PI / 180;
    if (rotate === 0 && scaleX === 1 && scaleY === 1 && skewX === 0 && skewY === 0) return;

    // Build 2x2 affine matrix: Rotate * Scale * Skew
    const cos = Math.cos(rotate), sin = Math.sin(rotate);
    // M = Rotate * Scale * Skew
    const a = (cos * scaleX) + (sin * Math.tan(skewY) * scaleX);
    const b = (sin * scaleY) + (cos * Math.tan(skewY) * scaleY);
    const c = (-sin * scaleX) + (cos * Math.tan(skewX) * scaleX);
    const d = (cos * scaleY) + (-sin * Math.tan(skewX) * scaleY);

    // Simplified: rotation + scale (skip skew for cleaner math)
    const ma = cos * scaleX, mb = sin * scaleX;
    const mc = -sin * scaleY, md = cos * scaleY;
    // Add skew after
    const finalA = ma + mc * Math.tan(skewY);
    const finalB = mb + md * Math.tan(skewY);
    const finalC = ma * Math.tan(skewX) + mc;
    const finalD = mb * Math.tan(skewX) + md;

    for (const seg of segments) {
      // Transform p0
      let dx = seg.p0x - cx, dy = seg.p0y - cy;
      seg.p0x = cx + finalA * dx + finalC * dy;
      seg.p0y = cy + finalB * dx + finalD * dy;
      // Transform p1
      dx = seg.p1x - cx; dy = seg.p1y - cy;
      seg.p1x = cx + finalA * dx + finalC * dy;
      seg.p1y = cy + finalB * dx + finalD * dy;
    }
  }

  // ── Web font loading ──
  // loadFont(name, url) — loads a font via FontFace API, invalidates glyph atlas when ready
  async loadFont(name, url) {
    if (this._loadedFonts.has(name)) return this._loadedFonts.get(name).fontFace;
    const entry = { loaded: false, fontFace: null };
    this._loadedFonts.set(name, entry);
    if (typeof FontFace !== 'undefined') {
      try {
        const face = new FontFace(name, `url(${url})`);
        await face.load();
        document.fonts.add(face);
        entry.fontFace = face;
        entry.loaded = true;
        // If current font uses this family, invalidate atlas
        if (this._sdfFont && this._sdfFont.includes(name)) {
          this._atlasChars = null;
          this._glyphCache.clear();
        }
        return face;
      } catch (e) {
        entry.loaded = false;
        return null;
      }
    }
    return null;
  }

  // Set font by family name (after loading)
  setFontFamily(family, size) {
    this._sdfFont = `${size || 48}px "${family}"`;
    this._atlasChars = null;
    this._glyphCache.clear();
  }

  // Apply element-level opacity to a color array (multiplies alpha channel)
  _applyOpacity(color, opacity) {
    if (opacity >= 1 || !color) return color;
    if (Array.isArray(color)) {
      const c = [...color];
      c[3] = (c[3] !== undefined ? c[3] : 1) * opacity;
      return c;
    }
    return color;
  }

  _collectRect(node, offsetX, offsetY, clip) {
    const x = this._numAttr(node, 'x', 0) + offsetX;
    const y = this._numAttr(node, 'y', 0) + offsetY;
    const w = this._numAttr(node, 'w', 100);
    const h = this._numAttr(node, 'h', 100);

    // Skip if entirely outside clip rect
    if (clip && (y + h < clip.y || y > clip.y + clip.h || x + w < clip.x || x > clip.x + clip.w)) return;

    const opacity = this._numAttr(node, 'opacity', 1);
    const fill = this._attr(node, 'fill', undefined);
    const gradient = this._attr(node, 'gradient', undefined);
    const stroke = this._attr(node, 'stroke', undefined);
    const strokeWidth = this._numAttr(node, 'stroke-width', 1);
    const radius = this._numAttr(node, 'radius', 0);

    const segsBefore = this._segments.length;

    if (gradient) {
      this._addGradientRectPath(x, y, w, h, radius, gradient);
    } else if (fill) {
      this._addRectPath(x, y, w, h, radius, this._packColor(this._applyOpacity(fill, opacity)));
    } else if (!stroke) {
      this._addRectPath(x, y, w, h, radius, this._packColor(this._applyOpacity([1, 1, 1, 1], opacity)));
    }

    if (stroke) {
      const sw = strokeWidth;
      const hsw = sw / 2;
      const sc = this._packColor(this._applyOpacity(stroke, opacity));
      this._addRectPath(x - hsw, y - hsw, w + sw, h + sw, radius > 0 ? radius + hsw : 0, sc);
      this._addRectPathReversed(x + hsw, y + hsw, w - sw, h - sw, radius > 0 ? Math.max(0, radius - hsw) : 0, sc);
    }

    // Apply per-element transform (rotate/scale/skew) to collected segments
    if (this._numAttr(node, 'rotate', 0) !== 0 || this._numAttr(node, 'scale', 1) !== 1 ||
        this._numAttr(node, 'scale-x', 1) !== 1 || this._numAttr(node, 'scale-y', 1) !== 1 ||
        this._numAttr(node, 'skew-x', 0) !== 0 || this._numAttr(node, 'skew-y', 0) !== 0) {
      const cx = x + w / 2, cy = y + h / 2; // transform origin = center
      const segsToTransform = this._segments.slice(segsBefore);
      this._applyTransform(node, segsToTransform, cx, cy);
      for (let i = segsBefore; i < this._segments.length; i++) {
        this._segments[i] = segsToTransform[i - segsBefore];
      }
    }

    this._collectElements(node, x, y, clip);
  }

  // Resolve text content from node — handles literals, expressions, formState, and @each overlay.
  // node.name could be: a literal string, a formState key, a $binding, or a bare slot/path name.
  _resolveTextContent(node) {
    // Priority 1: :text attr (may be an expression object resolved by _attr)
    const textAttr = this._attr(node, 'text', undefined);
    if (textAttr !== undefined) return String(textAttr);
    // Priority 2: node.name
    const name = node.name || '';
    if (!name) return '';
    // $binding reference (explicit: $item/title, $key, $index)
    if (name.startsWith('$')) {
      const bindingKey = name.slice(1);
      const ov = this._eachOverlay;
      if (ov) {
        if (bindingKey === 'item') return String(ov.item);
        if (bindingKey === 'key') return String(ov.key);
        if (bindingKey === 'index') return String(ov.index);
        if (bindingKey.startsWith('item/') || bindingKey.startsWith('item.')) {
          const field = bindingKey.slice(5);
          const item = ov.item;
          const val = item instanceof Map ? item.get(field) : item?.[field];
          return val !== undefined ? String(val) : '';
        }
        if (ov.item instanceof Map && ov.item.has(bindingKey)) return String(ov.item.get(bindingKey));
      }
      return '';
    }
    // @each overlay: bare name resolves against item (e.g. @text title → item.get('title'))
    const ov = this._eachOverlay;
    if (ov && ov.item instanceof Map && ov.item.has(name)) return String(ov.item.get(name));
    // formState key (e.g. @text myLabel → formState['myLabel'])
    if (this.formState && this.formState[name] !== undefined) return String(this.formState[name]);
    // Fallback: literal string
    return name;
  }

  _collectText(node, offsetX, offsetY, clip) {
    const text = this._resolveTextContent(node);
    if (!text) return;

    const size = this._numAttr(node, 'size', 16);
    const opacity = this._numAttr(node, 'opacity', 1);
    const color = this._packColor(this._applyOpacity(this._attr(node, 'color', [1, 1, 1, 1]), opacity));
    const align = this._attr(node, 'align', 'left');
    const baseX = this._numAttr(node, 'x', 0) + offsetX;
    const baseY = this._numAttr(node, 'y', 0) + offsetY;
    const maxWidth = this._numAttr(node, 'max-width', 0);
    const lineHeight = this._numAttr(node, 'line-height', size * 1.3);
    const letterSpacing = this._numAttr(node, 'letter-spacing', 0);
    const wordSpacing = this._numAttr(node, 'word-spacing', 0);
    const decoration = this._attr(node, 'text-decoration', 'none');
    const decorationColor = this._packColor(this._applyOpacity(this._attr(node, 'decoration-color', this._attr(node, 'color', [1, 1, 1, 1])), opacity));
    const decorationThickness = this._numAttr(node, 'decoration-thickness', Math.max(1, size / 12));

    this._ensureMeasureCanvas();
    const ctx = this._measureCtx;
    ctx.font = this._sdfFont;
    const scale = size / SDF_GLYPH_SIZE;

    // Helper: add text decoration (underline/strikethrough/overline) for a line span
    const _addDecoration = (startX, endX, baselineY) => {
      if (decoration === 'none') return;
      const decos = decoration.split(/\s+/);
      for (const deco of decos) {
        let decoY;
        if (deco === 'underline') decoY = baselineY + size * 0.15;
        else if (deco === 'line-through' || deco === 'strikethrough') decoY = baselineY - size * 0.3;
        else if (deco === 'overline') decoY = baselineY - size * 0.85;
        else continue;
        this._addRectPath(startX, decoY, endX - startX, decorationThickness, 0, decorationColor);
      }
    };

    // Multi-line path: word wrap via InlineCursor
    if (maxWidth > 0) {
      const wrapMode = this._attr(node, 'wrap', 'greedy');
      const cursor = wrapMode === 'balanced' ? new InlineBalancedCursor(maxWidth) : new InlineCursor(maxWidth);
      const spaceMetrics = this._getGlyphMetrics(' ');
      const spaceAdvance = spaceMetrics.advance * scale + wordSpacing;
      // Split on whitespace, handle hard breaks (\n)
      const segments = text.split('\n');
      for (let si = 0; si < segments.length; si++) {
        if (si > 0) cursor.pushHardBreak();
        const words = segments[si].split(/\s+/).filter(w => w.length > 0);
        for (const word of words) {
          let wordWidth = 0;
          for (const ch of word) {
            wordWidth += this._getGlyphMetrics(ch).advance * scale + letterSpacing;
          }
          wordWidth -= letterSpacing; // no trailing letter-spacing
          cursor.pushWord(word, wordWidth, spaceAdvance);
        }
      }

      const lines = cursor.getLines();
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const lineY = baseY + li * lineHeight;
        let lineX = baseX;
        if (align === 'center') lineX += (maxWidth - line.width) / 2;
        else if (align === 'right') lineX += maxWidth - line.width;

        const lineStartX = lineX;
        let cursorX = lineX;
        for (let wi = 0; wi < line.words.length; wi++) {
          if (wi > 0) cursorX += spaceAdvance;
          for (const ch of line.words[wi].word) {
            const metrics = this._getGlyphMetrics(ch);
            if (ch === ' ') { cursorX += metrics.advance * scale + wordSpacing; continue; }
            const qw = metrics.charW * scale;
            const qh = metrics.charH * scale;
            const qx = cursorX - metrics.drawOffsetX * scale;
            const qy = lineY - metrics.drawOffsetY * scale;
            if (!clip || (qy + qh >= clip.y && qy <= clip.y + clip.h && qx + qw >= clip.x && qx <= clip.x + clip.w)) {
              this._textQuads.push({ x: qx, y: qy, w: qw, h: qh, u0: 0, v0: 0, u1: 0, v1: 0, color, char: ch });
            }
            cursorX += metrics.advance * scale + letterSpacing;
          }
        }
        _addDecoration(lineStartX, cursorX, lineY);
      }
      return;
    }

    // Single-line path
    // Measure total width including letter-spacing and word-spacing
    let totalW = 0;
    for (const ch of text) {
      const metrics = this._getGlyphMetrics(ch);
      totalW += metrics.advance * scale + (ch === ' ' ? wordSpacing : letterSpacing);
    }
    totalW -= letterSpacing; // no trailing letter-spacing

    let x = baseX;
    if (align !== 'left') {
      if (align === 'center') x -= totalW / 2;
      else if (align === 'right') x -= totalW;
    }

    const lineStartX = x;
    let cursorX = x;
    for (const ch of text) {
      const metrics = this._getGlyphMetrics(ch);
      if (ch === ' ') { cursorX += metrics.advance * scale + wordSpacing; continue; }
      const qw = metrics.charW * scale;
      const qh = metrics.charH * scale;
      const qx = cursorX - metrics.drawOffsetX * scale;
      const qy = baseY - metrics.drawOffsetY * scale;
      if (!clip || (qy + qh >= clip.y && qy <= clip.y + clip.h && qx + qw >= clip.x && qx <= clip.x + clip.w)) {
        this._textQuads.push({ x: qx, y: qy, w: qw, h: qh, u0: 0, v0: 0, u1: 0, v1: 0, color, char: ch });
      }
      cursorX += metrics.advance * scale + letterSpacing;
    }
    _addDecoration(lineStartX, cursorX, baseY);
  }

  // ── Dimension evaluation (supports px numbers, "50%" strings, "auto") ──
  _evalDim(node, key, fallback, total) {
    const raw = node.attrs[key];
    if (raw === undefined || raw === null) return fallback;
    // Expression object
    if (typeof raw === 'object' && raw.expr !== undefined) {
      if (raw._compiled === undefined) raw._compiled = Rex.compileExpr(raw) ?? false;
      if (!this._surfaceCtx) this._surfaceCtx = this._makeSurfaceEvalContext();
      const result = Rex.evalExpr(raw._compiled, this._surfaceCtx);
      return result !== undefined ? result : fallback;
    }
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') {
      if (raw === 'auto') return null; // null = auto
      if (raw.endsWith('%')) {
        const pct = parseFloat(raw) / 100;
        return total != null ? total * pct : fallback;
      }
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : fallback;
    }
    return fallback;
  }

  // ── Per-side padding: :padding N or :padding-top/:padding-right/:padding-bottom/:padding-left ──
  _getPadding(node) {
    const p = this._numAttr(node, 'padding', 0);
    return {
      top:    this._numAttr(node, 'padding-top', p),
      right:  this._numAttr(node, 'padding-right', p),
      bottom: this._numAttr(node, 'padding-bottom', p),
      left:   this._numAttr(node, 'padding-left', p),
    };
  }

  // ── Per-side margin (supports 'auto' for centering) ──
  _getMargin(node) {
    const m = this._attr(node, 'margin', 0);
    const resolve = (key, fallback) => {
      const v = this._attr(node, key, fallback);
      if (v === 'auto') return 'auto';
      return typeof v === 'number' ? v : +v || 0;
    };
    return {
      top:    resolve('margin-top', m),
      right:  resolve('margin-right', m),
      bottom: resolve('margin-bottom', m),
      left:   resolve('margin-left', m),
    };
  }

  // ── Breakpoint resolution: :breakpoints [[768 column] [1024 row]] ──
  // Returns the layout direction based on canvas width
  _resolveBreakpoint(node, defaultDir) {
    const bp = this._attr(node, 'breakpoints', null);
    if (!bp || !Array.isArray(bp)) return defaultDir;
    // bp = [[width1, layout1], [width2, layout2], ...] sorted ascending
    // Walk from smallest to largest; last one that matches (canvasWidth >= threshold) wins
    let resolved = defaultDir;
    for (const entry of bp) {
      if (Array.isArray(entry) && entry.length >= 2) {
        const threshold = +entry[0];
        if (this._width >= threshold) resolved = entry[1];
      }
    }
    return resolved;
  }

  // ── Full flexbox _collectPanel ──
  // Supports: layout row/column, gap/row-gap/column-gap, padding (per-side), align, justify,
  //   align-self, flex-grow, flex-shrink, flex-basis, flex-wrap, min-width/max-width/min-height/max-height,
  //   position absolute, z-index, order, breakpoints, percentage dimensions, overflow-x/overflow-y,
  //   scroll-x/scroll-y, margin (including auto), opacity, display none, visibility hidden, block layout
  _collectPanel(node, offsetX, offsetY, parentClip) {
    const x = this._numAttr(node, 'x', 0) + offsetX;
    const y = this._numAttr(node, 'y', 0) + offsetY;
    const pad = this._getPadding(node);
    const gapVal = this._numAttr(node, 'gap', 0);
    const rawDir = this._attr(node, 'layout', 'column');
    const dir = this._resolveBreakpoint(node, rawDir);
    const isReverse = dir === 'row-reverse' || dir === 'column-reverse';
    const isRow = dir === 'row' || dir === 'row-reverse' || dir === 'inline';
    const isBlock = dir === 'block';
    const isInline = dir === 'inline';
    // Separate row-gap / column-gap, falling back to single gap
    const mainGapBase = this._numAttr(node, isRow ? 'column-gap' : 'row-gap', gapVal);
    const crossGapBase = this._numAttr(node, isRow ? 'row-gap' : 'column-gap', gapVal);
    const gap = mainGapBase; // main-axis gap for flex distribution
    const align = this._attr(node, 'align', 'start');
    const justify = this._attr(node, 'justify', 'start');
    const fill = this._attr(node, 'fill', undefined);
    // Per-axis overflow control
    const overflowShort = this._attr(node, 'overflow', 'visible');
    const overflowX = this._attr(node, 'overflow-x', overflowShort);
    const overflowY = this._attr(node, 'overflow-y', overflowShort);
    const scrollY = this._numAttr(node, 'scroll-y', 0);
    const scrollX = this._numAttr(node, 'scroll-x', 0);
    const wrap = this._attr(node, 'flex-wrap', this._attr(node, 'wrap', 'nowrap'));
    const alignContent = this._attr(node, 'align-content', 'stretch');
    const panelOpacity = this._numAttr(node, 'opacity', 1);

    const isWrap = wrap === 'wrap' || wrap === 'wrap-reverse' || isInline;
    const isWrapReverse = wrap === 'wrap-reverse';

    // Separate flow children from absolute-positioned children
    // Expand @each and @match nodes inline so their children participate in flex layout
    // Filter out display:none, respect order property
    const allChildren = [];
    const childOverlays = [];
    for (const c of node.children) {
      // display:none — skip entirely (no layout, no rendering)
      if (this._attr(c, 'display', '') === 'none') continue;
      if (c.type === 'each') {
        const expanded = this._expandEachForLayout(c);
        for (const { child, overlay } of expanded) {
          if (this._attr(child, 'display', '') === 'none') continue;
          allChildren.push(child);
          childOverlays.push(overlay);
        }
      } else if (c.type === 'match') {
        const matched = this._expandMatchForLayout(c);
        for (const child of matched) {
          if (this._attr(child, 'display', '') === 'none') continue;
          allChildren.push(child);
          childOverlays.push(null);
        }
      } else if (c.type === 'if') {
        const expanded = this._expandIfForLayout(c);
        for (const child of expanded) {
          if (this._attr(child, 'display', '') === 'none') continue;
          allChildren.push(child);
          childOverlays.push(null);
        }
      } else if (this._surfaceTypeSet.has(c.type)) {
        allChildren.push(c);
        childOverlays.push(null);
      }
    }
    // CSS order property: sort by order value (stable sort preserves DOM order for equal values)
    const orderValues = allChildren.map(c => this._numAttr(c, 'order', 0));
    const orderIndices = allChildren.map((_, i) => i);
    orderIndices.sort((a, b) => orderValues[a] - orderValues[b]);
    const sortedChildren = orderIndices.map(i => allChildren[i]);
    const sortedOverlays = orderIndices.map(i => childOverlays[i]);

    const flowChildren = [];
    const flowOverlays = [];
    const absChildren = [];
    const absOverlays = [];
    for (let i = 0; i < sortedChildren.length; i++) {
      if (this._attr(sortedChildren[i], 'position', '') === 'absolute') {
        absChildren.push(sortedChildren[i]);
        absOverlays.push(sortedOverlays[i]);
      } else {
        flowChildren.push(sortedChildren[i]);
        flowOverlays.push(sortedOverlays[i]);
      }
    }

    // Panel size — percentage resolves against parent panel, not canvas
    const pctW = this._parentWidth || this._width;
    const pctH = this._parentHeight || this._height;
    const explicitW = this._evalDim(node, 'w', 0, pctW);
    const explicitH = this._evalDim(node, 'h', 0, pctH);

    // Measure flow children (intrinsic sizes — margins NOT included)
    // Activate @each overlay during measurement so expressions resolve correctly
    const savedOverlay = this._eachOverlay;
    const measures = flowChildren.map((c, i) => {
      if (flowOverlays[i]) { this._eachOverlay = flowOverlays[i]; this._surfaceCtx = null; }
      const m = this._measureElement(c);
      if (flowOverlays[i]) { this._eachOverlay = savedOverlay; this._surfaceCtx = null; }
      return m;
    });
    const margins = flowChildren.map((c, i) => {
      if (flowOverlays[i]) { this._eachOverlay = flowOverlays[i]; this._surfaceCtx = null; }
      const m = this._getMargin(c);
      if (flowOverlays[i]) { this._eachOverlay = savedOverlay; this._surfaceCtx = null; }
      return m;
    });
    const padH = pad.left + pad.right;
    const padV = pad.top + pad.bottom;

    // Flex basis, grow, shrink per child
    const N = flowChildren.length;
    const basis = new Float64Array(N);
    const grow  = new Float64Array(N);
    const shrink = new Float64Array(N);
    const minMain = new Float64Array(N);
    const maxMain = new Float64Array(N);
    const minCross = new Float64Array(N);
    const maxCross = new Float64Array(N);
    // Per-child main/cross margin totals
    const marginMain = new Float64Array(N);
    const marginCross = new Float64Array(N);

    // Track which margins are auto (for free-space consumption in positioning)
    const hasAutoMarginMain = new Array(N).fill(false);
    const autoMarginMainCount = new Float64Array(N); // number of auto margins on main axis per child

    for (let i = 0; i < N; i++) {
      const c = flowChildren[i];
      const m = measures[i];
      const mg = margins[i];
      const fb = this._attr(c, 'flex-basis', null);
      basis[i] = fb != null ? +fb : (isRow ? m.w : m.h);
      grow[i]  = this._numAttr(c, 'flex-grow', this._numAttr(c, 'grow', 0));
      shrink[i] = this._numAttr(c, 'flex-shrink', this._numAttr(c, 'shrink', 1));
      minMain[i] = this._numAttr(c, isRow ? 'min-width' : 'min-height', 0);
      maxMain[i] = this._numAttr(c, isRow ? 'max-width' : 'max-height', Infinity);
      minCross[i] = this._numAttr(c, isRow ? 'min-height' : 'min-width', 0);
      maxCross[i] = this._numAttr(c, isRow ? 'max-height' : 'max-width', Infinity);
      // Auto margins: treat as 0 for sizing, resolve during positioning
      const mBefore = isRow ? mg.left : mg.top;
      const mAfter = isRow ? mg.right : mg.bottom;
      const mCrossBefore = isRow ? mg.top : mg.left;
      const mCrossAfter = isRow ? mg.bottom : mg.right;
      const autoMain = (mBefore === 'auto' ? 1 : 0) + (mAfter === 'auto' ? 1 : 0);
      autoMarginMainCount[i] = autoMain;
      hasAutoMarginMain[i] = autoMain > 0;
      marginMain[i] = (mBefore === 'auto' ? 0 : mBefore) + (mAfter === 'auto' ? 0 : mAfter);
      marginCross[i] = (mCrossBefore === 'auto' ? 0 : mCrossBefore) + (mCrossAfter === 'auto' ? 0 : mCrossAfter);
    }

    // Compute natural content extent for auto-sizing (basis + margins)
    let contentMain = Math.max(0, N - 1) * gap;
    for (let i = 0; i < N; i++) contentMain += basis[i] + marginMain[i];
    let contentCross = 0;
    for (let i = 0; i < N; i++) {
      const intrinsicCross = isRow ? measures[i].h : measures[i].w;
      contentCross = Math.max(contentCross, intrinsicCross + marginCross[i]);
    }

    // Resolve panel dimensions
    const panelW = explicitW || (isRow ? contentMain + padH : contentCross + padH);
    const panelH = explicitH || (isRow ? contentCross + padV : contentMain + padV);
    const innerW = panelW - padH;
    const innerH = panelH - padV;
    const innerMain = isRow ? innerW : innerH;
    const innerCross = isRow ? innerH : innerW;

    // ── FLEX WRAP: break flow children into lines ──
    const lines = []; // [{start, end, sizes[], mainSize, crossSize}]
    if (isWrap && N > 0) {
      let lineStart = 0;
      let lineCursor = 0;
      for (let i = 0; i < N; i++) {
        const itemMain = basis[i] + marginMain[i];
        const wouldBe = lineCursor + (i > lineStart ? gap : 0) + itemMain;
        if (i > lineStart && wouldBe > innerMain) {
          // Flush line
          lines.push({ start: lineStart, end: i });
          lineStart = i;
          lineCursor = itemMain;
        } else {
          lineCursor = wouldBe;
        }
      }
      lines.push({ start: lineStart, end: N });
    } else {
      lines.push({ start: 0, end: N });
    }

    // ── Per-line: resolve flex sizes (grow/shrink distribution) ──
    const resolvedMain = new Float64Array(N);  // final main-axis size per child
    const resolvedCross = new Float64Array(N); // final cross-axis size per child
    const lineCrossSizes = [];

    for (const line of lines) {
      const { start, end } = line;
      const count = end - start;
      const gapTotal = Math.max(0, count - 1) * gap;

      // Basis sum for this line (margins consume space but don't participate in grow/shrink)
      let basisSum = 0;
      let marginSum = 0;
      for (let i = start; i < end; i++) { basisSum += basis[i]; marginSum += marginMain[i]; }
      const freeSpace = innerMain - basisSum - marginSum - gapTotal;

      // Apply grow or shrink
      for (let i = start; i < end; i++) resolvedMain[i] = basis[i];

      if (freeSpace > 0) {
        // Grow: distribute positive free space proportionally by grow weight
        let totalGrow = 0;
        for (let i = start; i < end; i++) totalGrow += grow[i];
        if (totalGrow > 0) {
          for (let i = start; i < end; i++) {
            if (grow[i] > 0) resolvedMain[i] += freeSpace * grow[i] / totalGrow;
          }
        }
      } else if (freeSpace < 0) {
        // Shrink: distribute negative space proportionally by shrink * basis (CSS spec)
        let totalShrinkScaled = 0;
        for (let i = start; i < end; i++) totalShrinkScaled += shrink[i] * basis[i];
        if (totalShrinkScaled > 0) {
          for (let i = start; i < end; i++) {
            if (shrink[i] > 0) {
              resolvedMain[i] += freeSpace * (shrink[i] * basis[i]) / totalShrinkScaled;
            }
          }
          // Multi-pass clamp and redistribute (CSS spec: iterate until no violations)
          for (let pass = 0; pass < 10; pass++) {
            let deficit = 0;
            let redistWeight = 0;
            for (let i = start; i < end; i++) {
              if (resolvedMain[i] < minMain[i]) {
                deficit += minMain[i] - resolvedMain[i];
                resolvedMain[i] = minMain[i];
              } else {
                redistWeight += shrink[i] * basis[i];
              }
            }
            if (deficit <= 0 || redistWeight <= 0) break;
            let anyViolated = false;
            for (let i = start; i < end; i++) {
              if (resolvedMain[i] > minMain[i] && shrink[i] > 0) {
                resolvedMain[i] -= deficit * (shrink[i] * basis[i]) / redistWeight;
                if (resolvedMain[i] < minMain[i]) anyViolated = true;
              }
            }
            if (!anyViolated) break;
          }
        }
      }

      // Clamp to min/max
      for (let i = start; i < end; i++) {
        resolvedMain[i] = Math.max(minMain[i], Math.min(maxMain[i], resolvedMain[i]));
      }

      // Cross-axis sizing for this line (resolvedCross = intrinsic, margins tracked separately)
      let lineMaxCross = 0;
      for (let i = start; i < end; i++) {
        const intrinsicCross = isRow ? measures[i].h : measures[i].w;
        resolvedCross[i] = Math.max(minCross[i], Math.min(maxCross[i], intrinsicCross));
        lineMaxCross = Math.max(lineMaxCross, resolvedCross[i] + marginCross[i]);
      }
      lineCrossSizes.push(lineMaxCross);
    }

    // ── Align-content: distribute cross-axis space among lines ──
    const totalLineCross = lineCrossSizes.reduce((s, c) => s + c, 0);
    const lineGap = crossGapBase; // cross-axis line spacing (row-gap or column-gap)
    const totalLineSpace = totalLineCross + Math.max(0, lines.length - 1) * lineGap;
    const freeCross = innerCross - totalLineSpace;
    let lineCrossStart = 0;
    let lineCrossGap = lineGap;

    if (lines.length > 1 && freeCross > 0) {
      switch (alignContent) {
        case 'center': lineCrossStart = freeCross / 2; break;
        case 'end': lineCrossStart = freeCross; break;
        case 'space-between':
          lineCrossGap = lines.length > 1 ? lineGap + freeCross / (lines.length - 1) : lineGap;
          break;
        case 'space-around': {
          const around = freeCross / lines.length;
          lineCrossStart = around / 2;
          lineCrossGap = lineGap + around;
          break;
        }
        case 'space-evenly': {
          const even = freeCross / (lines.length + 1);
          lineCrossStart = even;
          lineCrossGap = lineGap + even;
          break;
        }
        case 'stretch': {
          const extra = freeCross / lines.length;
          for (let li = 0; li < lines.length; li++) lineCrossSizes[li] += extra;
          break;
        }
        // 'start': default
      }
    }

    // ── Position children ──
    const positions = new Array(N);
    const finalW = new Float64Array(N);
    const finalH = new Float64Array(N);
    let crossCursor = lineCrossStart;

    for (let li = 0; li < lines.length; li++) {
      const { start, end } = lines[li];
      const count = end - start;
      const lineCross = lineCrossSizes[li];

      // Main-axis: recompute actual used main space after grow/shrink (content + margins)
      let usedMain = 0;
      for (let i = start; i < end; i++) usedMain += resolvedMain[i] + marginMain[i];
      usedMain += Math.max(0, count - 1) * gap;
      const freeMain = innerMain - usedMain;

      // Justify: distribute free space along main axis
      let mainStart = 0;
      let mainGap = gap;
      switch (justify) {
        case 'center': mainStart = freeMain / 2; break;
        case 'end': mainStart = freeMain; break;
        case 'space-between':
          mainGap = count > 1 ? gap + freeMain / (count - 1) : gap;
          break;
        case 'space-around': {
          const around = count > 0 ? freeMain / count : 0;
          mainStart = around / 2;
          mainGap = gap + around;
          break;
        }
        case 'space-evenly': {
          const even = count > 0 ? freeMain / (count + 1) : 0;
          mainStart = even;
          mainGap = gap + even;
          break;
        }
      }

      // Auto margins: count total auto margins in this line
      let totalAutoMargins = 0;
      for (let i = start; i < end; i++) totalAutoMargins += autoMarginMainCount[i];
      // If any auto margins exist, they consume freeMain instead of justify
      const hasLineAutoMargins = totalAutoMargins > 0;
      const autoMarginSlice = hasLineAutoMargins && freeMain > 0 ? freeMain / totalAutoMargins : 0;

      // Compute per-line baseline for baseline alignment (inline mode or align:baseline)
      let lineBaseline = 0;
      if (isInline || align === 'baseline') {
        for (let i = start; i < end; i++) {
          const bl = measures[i].baseline || resolvedCross[i] * 0.8; // fallback: 80% of height
          lineBaseline = Math.max(lineBaseline, bl);
        }
      }

      let mainCursor = hasLineAutoMargins ? 0 : mainStart;
      let prevMarginAfter = 0; // for block margin collapsing
      for (let i = start; i < end; i++) {
        const c = flowChildren[i];
        const mg = margins[i];
        const itemMain = resolvedMain[i];
        const itemCross = resolvedCross[i];
        // Resolve auto margins: each auto margin gets equal share of free space
        let mMainBefore = isRow ? mg.left : mg.top;
        let mMainAfter  = isRow ? mg.right : mg.bottom;
        if (mMainBefore === 'auto') mMainBefore = autoMarginSlice;
        if (mMainAfter === 'auto') mMainAfter = autoMarginSlice;
        // Block margin collapsing: adjacent margins collapse to max(prev, cur)
        if (isBlock && i > start && prevMarginAfter > 0) {
          const collapsed = Math.max(prevMarginAfter, mMainBefore);
          // prevMarginAfter already advanced cursor; reduce mMainBefore to compensate
          mMainBefore = collapsed - prevMarginAfter;
        }
        let mCrossBefore = isRow ? mg.top : mg.left;
        let mCrossAfter = isRow ? mg.bottom : mg.right;
        // Auto cross margins center the item
        if (mCrossBefore === 'auto' && mCrossAfter === 'auto') {
          const crossSlack = lineCross - itemCross - marginCross[i];
          mCrossBefore = crossSlack > 0 ? crossSlack / 2 : 0;
          mCrossAfter = mCrossBefore;
        } else {
          if (mCrossBefore === 'auto') mCrossBefore = 0;
          if (mCrossAfter === 'auto') mCrossAfter = 0;
        }

        const selfAlign = this._attr(c, 'align-self', align);
        let crossPos = 0;
        const resolvedMarginCross = (typeof mCrossBefore === 'number' ? mCrossBefore : 0) + (typeof mCrossAfter === 'number' ? mCrossAfter : 0);
        const itemCrossWithMargin = itemCross + resolvedMarginCross;
        switch (selfAlign) {
          case 'center': crossPos = (lineCross - itemCrossWithMargin) / 2; break;
          case 'end': crossPos = lineCross - itemCrossWithMargin; break;
          case 'stretch':
            resolvedCross[i] = Math.max(minCross[i], Math.min(maxCross[i], lineCross - resolvedMarginCross));
            break;
          case 'baseline': {
            // Align item baseline to line baseline
            const itemBl = measures[i].baseline || itemCross * 0.8;
            crossPos = lineBaseline - itemBl;
            break;
          }
          case 'base-center': {
            // Center the item's baseline range within the line
            const itemBl = measures[i].baseline || itemCross * 0.8;
            crossPos = (lineCross - itemCrossWithMargin) / 2 + (lineBaseline - itemBl) / 2;
            break;
          }
        }
        // In inline mode, default to baseline alignment
        if (isInline && selfAlign === 'start') {
          const itemBl = measures[i].baseline || itemCross * 0.8;
          crossPos = lineBaseline - itemBl;
        }

        const px = x + pad.left + (isRow ? mainCursor + mMainBefore : crossPos + crossCursor + mCrossBefore);
        const py = y + pad.top  + (isRow ? crossPos + crossCursor + mCrossBefore : mainCursor + mMainBefore);

        finalW[i] = isRow ? itemMain : resolvedCross[i];
        finalH[i] = isRow ? resolvedCross[i] : itemMain;
        positions[i] = { x: px, y: py };
        mainCursor += itemMain + mMainBefore + mMainAfter + (hasLineAutoMargins || isBlock ? 0 : mainGap);
        prevMarginAfter = mMainAfter;
      }

      crossCursor += lineCross + lineCrossGap;
    }
    if (isWrapReverse) {
      // Reverse line order: flip cross positions
      for (let li = 0; li < lines.length; li++) {
        const { start, end } = lines[li];
        for (let i = start; i < end; i++) {
          if (isRow) positions[i].y = y + pad.top + innerCross - (positions[i].y - y - pad.top) - finalH[i];
          else positions[i].x = x + pad.left + innerCross - (positions[i].x - x - pad.left) - finalW[i];
        }
      }
    }
    if (isReverse) {
      // row-reverse / column-reverse: flip main-axis positions within each line
      for (const { start, end } of lines) {
        for (let i = start; i < end; i++) {
          if (isRow) positions[i].x = x + pad.left + innerW - (positions[i].x - x - pad.left) - finalW[i];
          else positions[i].y = y + pad.top + innerH - (positions[i].y - y - pad.top) - finalH[i];
        }
      }
    }

    // ── Background rect ──
    if (fill) {
      const radius = this._numAttr(node, 'radius', 0);
      this._addRectPath(x, y, panelW, panelH, radius, this._packColor(fill));
    }
    // ── Stroke ──
    const stroke = this._attr(node, 'stroke', undefined);
    if (stroke) {
      const sw = this._numAttr(node, 'stroke-width', 1);
      const hsw = sw / 2;
      const radius = this._numAttr(node, 'radius', 0);
      const sc = this._packColor(stroke);
      this._addRectPath(x - hsw, y - hsw, panelW + sw, panelH + sw, radius > 0 ? radius + hsw : 0, sc);
      this._addRectPathReversed(x + hsw, y + hsw, panelW - sw, panelH - sw, radius > 0 ? Math.max(0, radius - hsw) : 0, sc);
    }
    // ── Gradient fill on panel ──
    const gradient = this._attr(node, 'gradient', undefined);
    if (gradient) {
      const radius = this._numAttr(node, 'radius', 0);
      this._addGradientRectPath(x, y, panelW, panelH, radius, gradient);
    }

    // ── Clip rect for overflow (per-axis: overflow-x, overflow-y) ──
    let clip = parentClip || null;
    const clipX = overflowX === 'hidden' || overflowX === 'scroll';
    const clipY = overflowY === 'hidden' || overflowY === 'scroll';
    if (clipX || clipY) {
      // Build clip rect from axes that are clipped; unclamped axes use huge range
      const newClip = {
        x: clipX ? x : -1e6, y: clipY ? y : -1e6,
        w: clipX ? panelW : 2e6, h: clipY ? panelH : 2e6,
      };
      if (clip) {
        const cx1 = Math.max(clip.x, newClip.x), cy1 = Math.max(clip.y, newClip.y);
        const cx2 = Math.min(clip.x + clip.w, newClip.x + newClip.w);
        const cy2 = Math.min(clip.y + clip.h, newClip.y + newClip.h);
        clip = { x: cx1, y: cy1, w: Math.max(0, cx2 - cx1), h: Math.max(0, cy2 - cy1) };
      } else {
        clip = newClip;
      }
    }

    // Set parent dimensions for child percentage resolution
    const savedParentW = this._parentWidth;
    const savedParentH = this._parentHeight;
    this._parentWidth = panelW;
    this._parentHeight = panelH;

    // ── Collect flow children (z-index sorted) ──
    const renderList = [];
    for (let i = 0; i < N; i++) {
      const child = flowChildren[i];
      // visibility:hidden — takes layout space but doesn't render
      if (this._attr(child, 'visibility', '') === 'hidden') continue;
      const pos = positions[i];
      const ox = pos.x - this._numAttr(child, 'x', 0) - scrollX;
      const oy = pos.y - this._numAttr(child, 'y', 0) - scrollY;
      const z = this._numAttr(child, 'z-index', 0);
      renderList.push({ child, ox, oy, z, overlay: flowOverlays[i] });
    }

    // ── Absolute children: position relative to panel ──
    for (let ai = 0; ai < absChildren.length; ai++) {
      const child = absChildren[ai];
      if (this._attr(child, 'visibility', '') === 'hidden') continue;
      const margin = this._getMargin(child);
      const left   = this._evalDim(child, 'left', null, panelW);
      const top    = this._evalDim(child, 'top', null, panelH);
      const right  = this._evalDim(child, 'right', null, panelW);
      const bottom = this._evalDim(child, 'bottom', null, panelH);
      // Absolute w/h also support percentage (relative to panel)
      const cw = this._evalDim(child, 'w', 0, panelW) || (left != null && right != null ? panelW - left - right : 0);
      const ch = this._evalDim(child, 'h', 0, panelH) || (top != null && bottom != null ? panelH - top - bottom : 0);

      const mLeft = margin.left === 'auto' ? 0 : margin.left;
      const mRight = margin.right === 'auto' ? 0 : margin.right;
      const mTop = margin.top === 'auto' ? 0 : margin.top;
      const mBottom = margin.bottom === 'auto' ? 0 : margin.bottom;

      let ax = x + pad.left + mLeft;
      let ay = y + pad.top + mTop;
      if (left != null) ax = x + left + mLeft;
      else if (right != null) ax = x + panelW - right - cw - mRight;
      if (top != null) ay = y + top + mTop;
      else if (bottom != null) ay = y + panelH - bottom - ch - mBottom;

      const ox = ax - this._numAttr(child, 'x', 0) - scrollX;
      const oy = ay - this._numAttr(child, 'y', 0) - scrollY;
      const z = this._numAttr(child, 'z-index', 0);
      renderList.push({ child, ox, oy, z, overlay: absOverlays[ai] });
    }

    // ── Sort by z-index (stable) and render ──
    renderList.sort((a, b) => a.z - b.z);

    for (const { child, ox, oy, overlay } of renderList) {
      if (overlay) { this._eachOverlay = overlay; this._surfaceCtx = null; }
      switch (child.type) {
        case 'rect': this._collectRect(child, ox, oy, clip); break;
        case 'text': this._collectText(child, ox, oy, clip); break;
        case 'panel': this._collectPanel(child, ox, oy, clip); break;
        case 'shadow': this._collectShadow(child, ox, oy); break;
        case 'path': this._collectPath(child, ox, oy); break;
        case 'text-editor': this._collectTextEditor(child, ox, oy, clip); break;
        case 'each': this._collectEach(child, ox, oy, clip); break;
        case 'match': this._collectMatch(child, ox, oy, clip); break;
        case 'surface': this._collectSurface(child, ox, oy, clip); break;
        case 'viewport': this._collectViewport(child, ox, oy, clip); break;
        case 'image': this._collectImage(child, ox, oy, clip); break;
        case 'if': this._collectIf(child, ox, oy, clip); break;
        default: {
          const h = this._elementHandlers.get(child.type);
          if (h && h.collect) h.collect(child, ox, oy, clip, this);
          break;
        }
      }
      if (overlay) { this._eachOverlay = savedOverlay; this._surfaceCtx = null; }
    }

    // ── Scroll bar rendering ──
    // Show scroll bars when overflow is 'scroll' and content exceeds panel
    if (overflowY === 'scroll' || overflowX === 'scroll') {
      // Compute content extent from flow children
      let contentH = 0, contentW = 0;
      for (let i = 0; i < N; i++) {
        const pos = positions[i];
        const m = measures[i];
        const childBottom = pos.y + (isRow ? m.h : m.h) - y;
        const childRight = pos.x + (isRow ? m.w : m.w) - x;
        contentH = Math.max(contentH, childBottom);
        contentW = Math.max(contentW, childRight);
      }
      contentH += pad.bottom;
      contentW += pad.right;

      const SCROLLBAR_WIDTH = 6;
      const SCROLLBAR_MIN_THUMB = 20;
      const scrollBarColor = this._packColor([0.5, 0.5, 0.5, 0.4]);

      // Vertical scroll bar
      if (overflowY === 'scroll' && contentH > panelH) {
        const trackX = x + panelW - SCROLLBAR_WIDTH - 2;
        const trackY = y + 2;
        const trackH = panelH - 4;
        const thumbRatio = panelH / contentH;
        const thumbH = Math.max(SCROLLBAR_MIN_THUMB, trackH * thumbRatio);
        const thumbY = trackY + (scrollY / (contentH - panelH)) * (trackH - thumbH);
        // Track (subtle bg)
        this._addRectPath(trackX, trackY, SCROLLBAR_WIDTH, trackH, SCROLLBAR_WIDTH / 2, this._packColor([0.3, 0.3, 0.3, 0.15]));
        // Thumb
        this._addRectPath(trackX, thumbY, SCROLLBAR_WIDTH, thumbH, SCROLLBAR_WIDTH / 2, scrollBarColor);
      }

      // Horizontal scroll bar
      if (overflowX === 'scroll' && contentW > panelW) {
        const trackY = y + panelH - SCROLLBAR_WIDTH - 2;
        const trackX = x + 2;
        const trackW = panelW - 4;
        const thumbRatio = panelW / contentW;
        const thumbW = Math.max(SCROLLBAR_MIN_THUMB, trackW * thumbRatio);
        const thumbX = trackX + (scrollX / (contentW - panelW)) * (trackW - thumbW);
        // Track
        this._addRectPath(trackX, trackY, trackW, SCROLLBAR_WIDTH, SCROLLBAR_WIDTH / 2, this._packColor([0.3, 0.3, 0.3, 0.15]));
        // Thumb
        this._addRectPath(thumbX, trackY, thumbW, SCROLLBAR_WIDTH, SCROLLBAR_WIDTH / 2, scrollBarColor);
      }
    }

    // Restore parent dimensions
    this._parentWidth = savedParentW;
    this._parentHeight = savedParentH;
  }

  // ── @text-editor — interactive editable text area (Phase 5: self-hosting) ──
  _collectTextEditor(node, offsetX, offsetY, clip) {
    // Save non-editor counts on first editor (for incremental recompile)
    if (!this._nonEditorCounts) {
      this._nonEditorCounts = {
        paths: this._paths.length, segs: this._segments.length,
        quads: this._textQuads.length, grads: this._gradients.length,
        stops: this._gradientStops.length,
      };
    }
    const id = node.name || node.attrs.id || `editor-${this._editors.size}`;
    const x = this._numAttr(node, 'x', 0) + offsetX;
    const y = this._numAttr(node, 'y', 0) + offsetY;
    const w = this._numAttr(node, 'w', 400);
    const h = this._numAttr(node, 'h', 300);
    const size = this._numAttr(node, 'size', 14);
    const color = this._packColor(this._attr(node, 'color', [0.85, 0.85, 0.85, 1]));
    const bgFill = this._attr(node, 'fill', [0.05, 0.05, 0.08, 1]);
    const radius = this._numAttr(node, 'radius', 0);
    const padding = this._numAttr(node, 'padding', 8);
    const lineHeight = Math.round(size * 1.4);

    // Initialize or update editor state
    if (!this._editors.has(id)) {
      const initialContent = (node.content || node.name || '').replace(/\n$/, '');
      this._editors.set(id, {
        content: initialContent,
        lines: initialContent.split('\n'),
        cursor: this._numAttr(node, 'cursor', 0),
        selStart: -1, selEnd: -1,
        scrollY: this._numAttr(node, 'scroll-y', 0),
      });
    }
    const ed = this._editors.get(id);
    // Store layout info for hit testing and keyboard handling
    ed.x = x; ed.y = y; ed.w = w; ed.h = h;
    ed.lineHeight = lineHeight; ed.size = size; ed.padding = padding;
    ed.hasLineNumbers = !!this._attr(node, 'line-numbers', false);
    // Cache for incremental recompile
    ed._node = node; ed._offsetX = offsetX; ed._offsetY = offsetY; ed._clip = clip;

    const cursorPos = ed.cursor;
    const scrollY = ed.scrollY;

    // Background
    this._addRectPath(x, y, w, h, radius, this._packColor(bgFill));

    // Content from editor state (mutable) — use cached lines array
    const lines = ed.lines;

    // Clip to editor bounds
    const editorClip = { x: x + padding, y: y + padding, w: w - padding * 2, h: h - padding * 2 };
    const activeClip = clip ? {
      x: Math.max(clip.x, editorClip.x),
      y: Math.max(clip.y, editorClip.y),
      w: Math.min(clip.x + clip.w, editorClip.x + editorClip.w) - Math.max(clip.x, editorClip.x),
      h: Math.min(clip.y + clip.h, editorClip.y + editorClip.h) - Math.max(clip.y, editorClip.y),
    } : editorClip;

    this._ensureMeasureCanvas();
    const ctx = this._measureCtx;
    ctx.font = this._sdfFont;
    const scale = size / SDF_GLYPH_SIZE;
    const hasLineNumbers = ed.hasLineNumbers;
    const gutterW = hasLineNumbers ? size * 3 : 0;
    const textLeft = x + padding + (hasLineNumbers ? gutterW + padding : 0);
    ed.textLeft = textLeft;
    ed.scale = scale;

    // Line numbers gutter (rendered BEFORE content so it's behind text)
    if (hasLineNumbers) {
      const gutterColor = this._packColor([0.4, 0.4, 0.5, 1]);
      this._addRectPath(x, y, gutterW + padding * 2, h, radius > 0 ? radius : 0, this._packColor([0.04, 0.04, 0.06, 1]));

      for (let li = 0; li < lines.length; li++) {
        const ly = y + padding + li * lineHeight - scrollY;
        if (ly + lineHeight < activeClip.y || ly > activeClip.y + activeClip.h) continue;
        const numStr = String(li + 1);
        let nx = x + padding + gutterW - ctx.measureText(numStr).width * scale;
        for (const ch of numStr) {
          const metrics = this._getGlyphMetrics(ch);
          if (ch === ' ') { nx += metrics.advance * scale; continue; }
          const qx = nx - metrics.drawOffsetX * scale;
          const qy = ly - metrics.drawOffsetY * scale;
          this._textQuads.push({
            x: qx, y: qy, w: metrics.charW * scale, h: metrics.charH * scale,
            u0: 0, v0: 0, u1: 0, v1: 0,
            color: gutterColor, char: ch,
          });
          nx += metrics.advance * scale;
        }
      }
    }

    // Render each line of text
    let charIdx = 0;
    const cursorColor = this._packColor([1, 1, 1, 0.8]);
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const ly = y + padding + li * lineHeight - scrollY;

      // Skip lines outside clip
      if (ly + lineHeight < activeClip.y || ly > activeClip.y + activeClip.h) {
        charIdx += line.length + (li < lines.length - 1 ? 1 : 0);
        continue;
      }

      let cursorX = textLeft;
      for (let ci = 0; ci < line.length; ci++) {
        const ch = line[ci];
        const metrics = this._getGlyphMetrics(ch);

        if (charIdx === cursorPos) {
          this._addRectPath(cursorX, ly, 1.5, lineHeight, 0, cursorColor);
        }

        if (ch === ' ') {
          cursorX += metrics.advance * scale;
          charIdx++;
          continue;
        }

        const qw = metrics.charW * scale;
        const qh = metrics.charH * scale;
        const qx = cursorX - metrics.drawOffsetX * scale;
        const qy = ly - metrics.drawOffsetY * scale;

        if (qx + qw >= activeClip.x && qx <= activeClip.x + activeClip.w) {
          this._textQuads.push({
            x: qx, y: qy, w: qw, h: qh,
            u0: 0, v0: 0, u1: 0, v1: 0,
            color, char: ch,
          });
        }

        cursorX += metrics.advance * scale;
        charIdx++;
      }

      // Cursor at end of line
      if (charIdx === cursorPos) {
        this._addRectPath(cursorX, ly, 1.5, lineHeight, 0, cursorColor);
      }
      // Only count newline between lines, not after the last line
      if (li < lines.length - 1) charIdx++;
    }
  }

  // Two-phase layout contract (use.gpu §7):
  //   Phase 1 (minMax): _measureElement returns {w, h, minW, minH, maxW, maxH}
  //     w/h = preferred intrinsic size, min/max = constraint range
  //   Phase 2 (fit): _fitElement(node, availW, availH, maxW, maxH) returns {w, h}
  //     allocates actual size within constraints given available space

  _measureElement(node) {
    // Memoize by node identity — avoids O(n²) for nested panels
    if (this._measureCache) {
      const cached = this._measureCache.get(node);
      if (cached) return cached;
    }
    const result = this._measureElementInner(node);
    // Augment with min/max constraints (two-phase contract)
    result.minW = result.minW ?? this._numAttr(node, 'min-width', 0);
    result.minH = result.minH ?? this._numAttr(node, 'min-height', 0);
    result.maxW = result.maxW ?? this._numAttr(node, 'max-width', Infinity);
    result.maxH = result.maxH ?? this._numAttr(node, 'max-height', Infinity);
    if (this._measureCache) this._measureCache.set(node, result);
    return result;
  }

  _fitElement(node, availW, availH, maxW, maxH) {
    // Phase 2: top-down space allocation. Returns actual size within constraints.
    const m = this._measureElement(node);
    const w = Math.max(m.minW, Math.min(m.maxW, maxW ?? Infinity, availW ?? m.w, m.w));
    const h = Math.max(m.minH, Math.min(m.maxH, maxH ?? Infinity, availH ?? m.h, m.h));
    // For stretch-mode children, expand to available space
    return { w, h };
  }

  _measureElementInner(node) {
    // Absolute-positioned elements don't contribute to parent layout size
    if (this._attr(node, 'position', '') === 'absolute') return { w: 0, h: 0 };

    // Margins are handled externally in _collectPanel (use.gpu pattern):
    // measurement returns intrinsic content size WITHOUT margins.

    switch (node.type) {
      case 'rect': {
        const w = this._evalDim(node, 'w', 100, this._width);
        const h = this._evalDim(node, 'h', 100, this._height);
        return { w: w || 100, h: h || 100 };
      }
      case 'text': {
        const text = this._resolveTextContent(node);
        const size = this._numAttr(node, 'size', 16);
        const maxWidth = this._numAttr(node, 'max-width', 0);
        const lineHeight = this._numAttr(node, 'line-height', size * 1.3);
        const letterSpacing = this._numAttr(node, 'letter-spacing', 0);
        const wordSpacing = this._numAttr(node, 'word-spacing', 0);
        this._ensureMeasureCanvas();
        this._measureCtx.font = this._sdfFont;
        const scale = size / SDF_GLYPH_SIZE;
        // Baseline: ascent above baseline, descent below
        const ascent = size * 0.8;  // approximate ascent
        const descent = size * 0.2; // approximate descent
        // Measure width accounting for letter-spacing and word-spacing
        let totalW = 0;
        if (text) {
          for (const ch of text) {
            totalW += this._getGlyphMetrics(ch).advance * scale + (ch === ' ' ? wordSpacing : letterSpacing);
          }
          totalW -= letterSpacing; // no trailing letter-spacing
        }
        if (maxWidth > 0 && text) {
          const lineCount = Math.max(1, Math.ceil(totalW / maxWidth));
          return { w: maxWidth, h: lineCount * lineHeight, baseline: ascent };
        }
        return { w: totalW, h: size, baseline: ascent };
      }
      case 'panel': {
        const pad = this._getPadding(node);
        const padH = pad.left + pad.right;
        const padV = pad.top + pad.bottom;
        const gap = this._numAttr(node, 'gap', 0);
        const rawDir = this._attr(node, 'layout', 'column');
        const dir = this._resolveBreakpoint(node, rawDir);
        const isRow = dir === 'row';
        // Only measure flow children (not absolute-positioned), expanding @each and @match inline
        const children = [];
        const childOverlaysMeasure = [];
        for (const c of node.children) {
          if (c.type === 'each') {
            const expanded = this._expandEachForLayout(c);
            for (const { child, overlay } of expanded) {
              if (this._attr(child, 'position', '') !== 'absolute') {
                children.push(child);
                childOverlaysMeasure.push(overlay);
              }
            }
          } else if (c.type === 'match') {
            const matched = this._expandMatchForLayout(c);
            for (const child of matched) {
              if (this._attr(child, 'position', '') !== 'absolute') {
                children.push(child);
                childOverlaysMeasure.push(null);
              }
            }
          } else if (c.type === 'if') {
            const expanded = this._expandIfForLayout(c);
            for (const child of expanded) {
              if (this._attr(child, 'position', '') !== 'absolute') {
                children.push(child);
                childOverlaysMeasure.push(null);
              }
            }
          } else if (this._surfaceTypeSet.has(c.type) && this._attr(c, 'position', '') !== 'absolute') {
            children.push(c);
            childOverlaysMeasure.push(null);
          }
        }
        const savedOvMeasure = this._eachOverlay;
        const measures = children.map((c, i) => {
          if (childOverlaysMeasure[i]) { this._eachOverlay = childOverlaysMeasure[i]; this._surfaceCtx = null; }
          const m = this._measureElement(c);
          if (childOverlaysMeasure[i]) { this._eachOverlay = savedOvMeasure; this._surfaceCtx = null; }
          return m;
        });

        // Child margins contribute to the panel's intrinsic size
        const childMargins = children.map((c, i) => {
          if (childOverlaysMeasure[i]) { this._eachOverlay = childOverlaysMeasure[i]; this._surfaceCtx = null; }
          const m = this._getMargin(c);
          if (childOverlaysMeasure[i]) { this._eachOverlay = savedOvMeasure; this._surfaceCtx = null; }
          return m;
        });

        // Explicit dimensions (support percentages)
        const explicitW = this._evalDim(node, 'w', 0, this._width);
        const explicitH = this._evalDim(node, 'h', 0, this._height);
        if (explicitW && explicitH) return { w: explicitW, h: explicitH };

        // Use flex-basis when available for main axis measurement
        const mainSizes = children.map((c, i) => {
          const fb = this._attr(c, 'flex-basis', null);
          if (fb != null) return +fb;
          const cm = childMargins[i];
          const mMain = isRow ? cm.left + cm.right : cm.top + cm.bottom;
          return (isRow ? measures[i].w : measures[i].h) + mMain;
        });
        const crossSizes = children.map((c, i) => {
          const cm = childMargins[i];
          const mCross = isRow ? cm.top + cm.bottom : cm.left + cm.right;
          return (isRow ? measures[i].h : measures[i].w) + mCross;
        });

        const mainTotal = mainSizes.reduce((s, m) => s + m, 0) + Math.max(0, mainSizes.length - 1) * gap;
        const crossMax = crossSizes.length > 0 ? Math.max(...crossSizes) : 0;

        // Apply min-width / min-height / max-width / max-height on the panel itself
        let w, h;
        if (isRow) {
          w = explicitW || (mainTotal + padH);
          h = explicitH || (crossMax + padV);
        } else {
          w = explicitW || (crossMax + padH);
          h = explicitH || (mainTotal + padV);
        }

        // Clamp to min/max
        const minW = this._numAttr(node, 'min-width', 0);
        const maxW = this._numAttr(node, 'max-width', Infinity);
        const minH = this._numAttr(node, 'min-height', 0);
        const maxH = this._numAttr(node, 'max-height', Infinity);
        w = Math.max(minW, Math.min(maxW, w));
        h = Math.max(minH, Math.min(maxH, h));

        return { w, h };
      }
      case 'each': {
        // @each measured as sum of its expanded children (column layout)
        const expanded = this._expandEachForLayout(node);
        let totalH = 0, maxW = 0;
        const savedOvEach = this._eachOverlay;
        for (const { child, overlay } of expanded) {
          this._eachOverlay = overlay; this._surfaceCtx = null;
          const m = this._measureElement(child);
          totalH += m.h;
          maxW = Math.max(maxW, m.w);
        }
        this._eachOverlay = savedOvEach; this._surfaceCtx = null;
        return { w: maxW, h: totalH };
      }
      case 'match': {
        // @match measured as the matched branch's children
        const matched = this._expandMatchForLayout(node);
        let totalH = 0, maxW = 0;
        for (const child of matched) {
          const m = this._measureElement(child);
          totalH += m.h;
          maxW = Math.max(maxW, m.w);
        }
        return { w: maxW, h: totalH };
      }
      case 'surface': {
        // @surface measured by explicit w/h or defaults
        const w = this._evalDim(node, 'w', 200, this._width) || 200;
        const h = this._evalDim(node, 'h', 200, this._height) || 200;
        return { w, h };
      }
      case 'image': {
        const w = this._evalDim(node, 'w', 100, this._width) || 100;
        const h = this._evalDim(node, 'h', 100, this._height) || 100;
        return { w, h };
      }
      case 'if': {
        // @if measured as its visible children (if condition true)
        const expanded = this._expandIfForLayout(node);
        let totalH = 0, maxW = 0;
        for (const child of expanded) {
          const m = this._measureElement(child);
          totalH += m.h;
          maxW = Math.max(maxW, m.w);
        }
        return { w: maxW, h: totalH };
      }
      case 'shadow':
        return { w: 0, h: 0 };
      case 'path': {
        const d = node.name || node.attrs.d || '';
        const bbox = this._pathBBox(d);
        return { w: bbox.maxX - bbox.minX, h: bbox.maxY - bbox.minY };
      }
      case 'text-editor': {
        const w = this._evalDim(node, 'w', 400, this._width) || 400;
        const h = this._evalDim(node, 'h', 300, this._height) || 300;
        return { w, h };
      }
      case 'viewport':
        return { w: 0, h: 0 }; // viewport is a transform container, not sized
      default: {
        const handler = this._elementHandlers.get(node.type);
        if (handler && handler.measure) return handler.measure(node, this);
        return { w: 0, h: 0 };
      }
    }
  }

  // ════════════════════════════════════════════════════════════════
  // SDF GLYPH ATLAS
  // ════════════════════════════════════════════════════════════════

  _ensureMeasureCanvas() {
    if (this._measureCanvas) return;
    this._measureCanvas = document.createElement('canvas');
    this._measureCanvas.width = SDF_GLYPH_SIZE * 2;
    this._measureCanvas.height = SDF_GLYPH_SIZE * 2;
    this._measureCtx = this._measureCanvas.getContext('2d', { willReadFrequently: true });
  }

  _getGlyphMetrics(ch) {
    if (this._glyphCache.has(ch)) return this._glyphCache.get(ch);
    this._ensureMeasureCanvas();
    const ctx = this._measureCtx;
    ctx.font = this._sdfFont;
    ctx.textBaseline = 'top';
    const m = ctx.measureText(ch);
    const drawX = Math.max(0, (SDF_GLYPH_SIZE - m.width) / 2);
    // Use full TextMetrics API for accurate vertical positioning
    const ascent = m.actualBoundingBoxAscent;
    const descent = m.actualBoundingBoxDescent;
    const hasFullMetrics = typeof ascent === 'number' && typeof descent === 'number';
    const drawY = hasFullMetrics ? Math.max(0, Math.round((SDF_GLYPH_SIZE - ascent - descent) / 2)) : 2;
    const metrics = {
      charW: SDF_GLYPH_SIZE,
      charH: SDF_GLYPH_SIZE,
      advance: m.width,
      drawOffsetX: drawX,
      drawOffsetY: drawY,
      bearingY: hasFullMetrics ? Math.round(ascent) : Math.round(SDF_GLYPH_SIZE * 0.75),
      atlasX: 0, atlasY: 0, atlasW: SDF_GLYPH_SIZE, atlasH: SDF_GLYPH_SIZE,
    };
    this._glyphCache.set(ch, metrics);
    return metrics;
  }

  _buildGlyphAtlas() {
    // Collect unique characters
    const chars = new Set();
    for (const q of this._textQuads) chars.add(q.char);
    const charList = [...chars].sort();
    const charStr = charList.join('');
    if (charStr === this._atlasChars && this._sdfAtlasTexture) {
      // Atlas unchanged, just update UVs
      this._assignAtlasUVs();
      return;
    }
    this._atlasChars = charStr;

    this._ensureMeasureCanvas();
    const canvas = this._measureCanvas;
    const ctx = this._measureCtx;
    const gs = SDF_GLYPH_SIZE;

    // Compute atlas layout
    const cols = Math.floor(SDF_ATLAS_SIZE / gs);
    const atlasData = new Uint8Array(SDF_ATLAS_SIZE * SDF_ATLAS_SIZE);

    this._glyphCache.clear();

    for (let i = 0; i < charList.length; i++) {
      const ch = charList[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const ax = col * gs;
      const ay = row * gs;

      // Rasterize glyph on canvas
      canvas.width = gs;
      canvas.height = gs;
      ctx.clearRect(0, 0, gs, gs);
      ctx.fillStyle = 'white';
      ctx.font = this._sdfFont;
      ctx.textBaseline = 'top';
      const m = ctx.measureText(ch);
      const drawX = Math.max(0, (gs - m.width) / 2);
      const ascent = m.actualBoundingBoxAscent;
      const descent = m.actualBoundingBoxDescent;
      const hasFullMetrics = typeof ascent === 'number' && typeof descent === 'number';
      const drawY = hasFullMetrics ? Math.max(0, Math.round((gs - ascent - descent) / 2)) : 2;
      ctx.fillText(ch, drawX, drawY);

      // Read pixels — keep full alpha for ESDT subpixel offsets
      const imgData = ctx.getImageData(0, 0, gs, gs);
      const alpha = new Uint8Array(gs * gs);
      for (let j = 0; j < gs * gs; j++) alpha[j] = imgData.data[j * 4 + 3];

      // Generate SDF via Extended Subpixel Distance Transform
      const sdf = this._generateESDT(alpha, gs, gs, SDF_SPREAD);

      // Write to atlas
      for (let sy = 0; sy < gs; sy++) {
        for (let sx = 0; sx < gs; sx++) {
          atlasData[(ay + sy) * SDF_ATLAS_SIZE + (ax + sx)] = Math.round(sdf[sy * gs + sx] * 255);
        }
      }

      // Metrics: store the centering offset used for rasterization so quad
      // positioning can undo it and align the glyph with the text cursor.
      // drawX centers the glyph horizontally in the cell; drawY=2 is the
      // top baseline offset used above in fillText.
      this._glyphCache.set(ch, {
        charW: gs, charH: gs,
        advance: m.width,
        drawOffsetX: drawX,
        drawOffsetY: drawY,
        bearingY: hasFullMetrics ? Math.round(ascent) : Math.round(gs * 0.75),
        atlasX: ax, atlasY: ay, atlasW: gs, atlasH: gs,
      });
    }

    // Upload atlas to GPU
    if (this._sdfAtlasTexture) this._sdfAtlasTexture.destroy();
    this._sdfAtlasTexture = this.device.createTexture({
      size: [SDF_ATLAS_SIZE, SDF_ATLAS_SIZE],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: this._sdfAtlasTexture },
      atlasData,
      { bytesPerRow: SDF_ATLAS_SIZE },
      [SDF_ATLAS_SIZE, SDF_ATLAS_SIZE]
    );
    this._sdfAtlasSampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    this._assignAtlasUVs();
    this.log(`surface sdf atlas: ${charList.length} glyphs in ${SDF_ATLAS_SIZE}x${SDF_ATLAS_SIZE}`, 'ok');
  }

  _assignAtlasUVs() {
    const as = SDF_ATLAS_SIZE;
    for (const q of this._textQuads) {
      const g = this._glyphCache.get(q.char);
      if (!g) continue;
      q.u0 = g.atlasX / as;
      q.v0 = g.atlasY / as;
      q.u1 = (g.atlasX + g.atlasW) / as;
      q.v1 = (g.atlasY + g.atlasH) / as;
    }
  }

  // ── ESDT: Extended Subpixel Distance Transform ──
  // Adapted from use.gpu (unconed) — Felzenszwalb & Huttenlocher with subpixel offsets
  // Produces dramatically sharper SDF text at small pixel sizes.

  _generateESDT(alpha, w, h, radius) {
    const INF = 1e10;
    const np = w * h;
    const sp = Math.max(w, h);

    // Scratch workspace (reuse across glyphs via lazy init)
    if (!this._esdtStage || this._esdtStage.size < sp) {
      const n = sp * sp;
      this._esdtStage = {
        outer: new Float32Array(n), inner: new Float32Array(n),
        xo: new Float32Array(n), yo: new Float32Array(n),
        xi: new Float32Array(n), yi: new Float32Array(n),
        f: new Float32Array(sp), z: new Float32Array(sp + 1),
        b: new Float32Array(sp), t: new Float32Array(sp), v: new Uint16Array(sp),
        size: sp,
      };
    }
    const { outer, inner, xo, yo, xi, yi, f, z, b, t, v } = this._esdtStage;

    // ── Step 1: Paint alpha into stage (squared distance seeds) ──
    outer.fill(INF, 0, np);
    inner.fill(0, 0, np);
    for (let i = 0; i < np; i++) {
      const a = alpha[i];
      if (!a) continue;
      if (a >= 254) { outer[i] = 0; inner[i] = INF; }
      else          { outer[i] = 0; inner[i] = 0; }
    }

    // ── Step 2: Compute subpixel offsets at boundary pixels ──
    xo.fill(0, 0, np);
    yo.fill(0, 0, np);
    xi.fill(0, 0, np);
    yi.fill(0, 0, np);

    const get = (x, y) => (x >= 0 && x < w && y >= 0 && y < h) ? alpha[y * w + x] / 255 : 0;
    const _isBlack = (v) => !v;
    const _isWhite = (v) => v === 1;
    const _isSolid = (v) => !(v && 1 - v); // true if 0 or 1 (binary), false if gray

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = get(x, y);
        const j = y * w + x;

        if (!_isSolid(c)) {
          // Gray pixel — compute gradient via 8-neighbor Sobel kernel
          const dc = c - 0.5;
          const l = get(x-1, y), r = get(x+1, y);
          const tt2 = get(x, y-1), bb2 = get(x, y+1);
          const tl = get(x-1, y-1), tr = get(x+1, y-1);
          const bl = get(x-1, y+1), br = get(x+1, y+1);

          const ll = (tl + l*2 + bl) / 4;
          const rr = (tr + r*2 + br) / 4;
          const ttw = (tl + tt2*2 + tr) / 4;
          const bbw = (bl + bb2*2 + br) / 4;

          const mn = Math.min(l, r, tt2, bb2, tl, tr, bl, br);
          const mx = Math.max(l, r, tt2, bb2, tl, tr, bl, br);

          if (mn > 0) { inner[j] = INF; continue; }  // interior crease
          if (mx < 1) { outer[j] = INF; continue; }  // exterior crease

          let dx = rr - ll;
          let dy = bbw - ttw;
          const dl = 1 / Math.sqrt(dx * dx + dy * dy);
          dx *= dl; dy *= dl;

          xo[j] = -dc * dx;
          yo[j] = -dc * dy;
        } else if (_isWhite(c)) {
          // White pixel adjacent to black — set 0.4999 offset on neighbor
          const l = get(x-1, y), r = get(x+1, y);
          const tt2 = get(x, y-1), bb2 = get(x, y+1);
          if (_isBlack(l) && j-1 >= 0) { xo[j-1] = 0.4999; outer[j-1] = 0; inner[j-1] = 0; }
          if (_isBlack(r) && j+1 < np) { xo[j+1] = -0.4999; outer[j+1] = 0; inner[j+1] = 0; }
          if (_isBlack(tt2) && j-w >= 0) { yo[j-w] = 0.4999; outer[j-w] = 0; inner[j-w] = 0; }
          if (_isBlack(bb2) && j+w < np) { yo[j+w] = -0.4999; outer[j+w] = 0; inner[j+w] = 0; }
        }
      }
    }

    // ── Step 3: Split subpixel offsets into outer/inner at ±0.5 boundary ──
    for (let i = 0; i < np; i++) {
      const nx = xo[i], ny = yo[i];
      if (!nx && !ny) continue;

      const nn = Math.sqrt(nx * nx + ny * ny);
      const sx = (Math.abs(nx / nn) - 0.5) > 0 ? Math.sign(nx) : 0;
      const sy = (Math.abs(ny / nn) - 0.5) > 0 ? Math.sign(ny) : 0;

      const ix = i % w, iy = (i / w) | 0;
      const c = get(ix, iy);
      const d = get(ix + sx, iy + sy);
      const s = Math.sign(d - c);

      let dlo = (nn + 0.4999 * s);
      let dli = (nn - 0.4999 * s);
      dlo /= nn; dli /= nn;

      xo[i] = nx * dlo; yo[i] = ny * dlo;
      xi[i] = nx * dli; yi[i] = ny * dli;
    }

    // ── Step 4: 2D ESDT (Felzenszwalb & Huttenlocher + subpixel) ──
    // Column pass then row pass for both outer and inner
    const esdt1d = (mask, xs, ys, offset, stride, length) => {
      v[0] = 0;
      b[0] = xs[offset];
      t[0] = ys[offset];
      z[0] = -INF; z[1] = INF;
      f[0] = mask[offset] ? INF : ys[offset] * ys[offset];

      let k = 0;
      for (let q = 1, s2 = 0; q < length; q++) {
        const o = offset + q * stride;
        const dx2 = xs[o], dy2 = ys[o];
        const fq = f[q] = mask[o] ? INF : dy2 * dy2;
        t[q] = dy2;
        const qs = q + dx2;
        const q2 = qs * qs;
        b[q] = qs;

        do {
          const r2 = v[k]; const rs = b[r2];
          s2 = (fq - f[r2] + q2 - rs * rs) / (qs - rs) / 2;
        } while (s2 <= z[k] && --k > -1);

        k++;
        v[k] = q; z[k] = s2; z[k + 1] = INF;
      }

      for (let q = 0, k2 = 0; q < length; q++) {
        while (z[k2 + 1] < q) k2++;
        const r2 = v[k2];
        const rs = b[r2];
        const dy2 = t[r2];
        const rq = rs - q;
        const o = offset + q * stride;
        xs[o] = rq; ys[o] = dy2;
        if (r2 !== q) mask[o] = 0;
      }
    };

    const esdt2d = (mask, xs, ys) => {
      for (let x = 0; x < w; x++) esdt1d(mask, ys, xs, x, w, h);  // columns
      for (let y = 0; y < h; y++) esdt1d(mask, xs, ys, y * w, 1, w);  // rows
    };

    esdt2d(outer, xo, yo);
    esdt2d(inner, xi, yi);

    // ── Step 5: Combine into normalized SDF [0, 1], 0.5 = boundary ──
    const cutoff = 0.25;
    const sdf = new Float32Array(np);
    for (let i = 0; i < np; i++) {
      const outerD = Math.max(0, Math.sqrt(xo[i] * xo[i] + yo[i] * yo[i]) - 0.5);
      const innerD = Math.max(0, Math.sqrt(xi[i] * xi[i] + yi[i] * yi[i]) - 0.5);
      const d = outerD >= innerD ? outerD : -innerD;
      // Map to [0, 1] with 0.5 at boundary
      sdf[i] = Math.max(0, Math.min(1, (255 - 255 * (d / radius + cutoff)) / 255));
    }

    // Paint original alpha back at boundary pixels (preserves rasterizer antialiasing)
    for (let i = 0; i < np; i++) {
      const a = alpha[i] / 255;
      if (a > 0 && a < 1) {
        const d = 0.5 - a;
        sdf[i] = Math.max(0, Math.min(1, (255 - 255 * (d / radius + cutoff)) / 255));
      }
    }

    return sdf;
  }

  // ════════════════════════════════════════════════════════════════
  // GEOMETRY HELPERS (unchanged from Phase 1)
  // ════════════════════════════════════════════════════════════════

  _roundedRectSegments(x, y, w, h, r, pathIdx) {
    const ARC_SEGS = 4;
    const push = (x0, y0, x1, y1) => {
      this._segments.push({ p0x: x0, p0y: y0, p1x: x1, p1y: y1, pathIdx });
    };
    push(x + r, y, x + w - r, y);
    this._arcSegments(x + w - r, y + r, r, -Math.PI / 2, 0, ARC_SEGS, pathIdx);
    push(x + w, y + r, x + w, y + h - r);
    this._arcSegments(x + w - r, y + h - r, r, 0, Math.PI / 2, ARC_SEGS, pathIdx);
    push(x + w - r, y + h, x + r, y + h);
    this._arcSegments(x + r, y + h - r, r, Math.PI / 2, Math.PI, ARC_SEGS, pathIdx);
    push(x, y + h - r, x, y + r);
    this._arcSegments(x + r, y + r, r, Math.PI, Math.PI * 1.5, ARC_SEGS, pathIdx);
  }

  _arcSegments(cx, cy, r, startAngle, endAngle, nSegs, pathIdx) {
    const step = (endAngle - startAngle) / nSegs;
    for (let i = 0; i < nSegs; i++) {
      const a0 = startAngle + i * step;
      const a1 = startAngle + (i + 1) * step;
      this._segments.push({
        p0x: cx + Math.cos(a0) * r, p0y: cy + Math.sin(a0) * r,
        p1x: cx + Math.cos(a1) * r, p1y: cy + Math.sin(a1) * r,
        pathIdx,
      });
    }
  }

  _packColor(rgba) {
    const arr = Array.isArray(rgba) ? rgba : [1, 1, 1, 1];
    const rc = Math.round((arr[0] || 0) * 255) & 0xFF;
    const gc = Math.round((arr[1] || 0) * 255) & 0xFF;
    const bc = Math.round((arr[2] || 0) * 255) & 0xFF;
    const ac = Math.round((arr[3] ?? 1) * 255) & 0xFF;
    return rc | (gc << 8) | (bc << 16) | (ac << 24);
  }

  // ── Rect path helpers (fill + stroke) ──

  _addRectPath(x, y, w, h, radius, color) {
    const pathIdx = this._paths.length;
    const segStart = this._segments.length;
    if (radius > 0) {
      this._roundedRectSegments(x, y, w, h, Math.min(radius, w / 2, h / 2), pathIdx);
    } else {
      this._segments.push({ p0x: x, p0y: y, p1x: x + w, p1y: y, pathIdx });
      this._segments.push({ p0x: x + w, p0y: y, p1x: x + w, p1y: y + h, pathIdx });
      this._segments.push({ p0x: x + w, p0y: y + h, p1x: x, p1y: y + h, pathIdx });
      this._segments.push({ p0x: x, p0y: y + h, p1x: x, p1y: y, pathIdx });
    }
    this._paths.push({ segStart, segCount: this._segments.length - segStart, color, flags: pathIdx });
  }

  _addRectPathReversed(x, y, w, h, radius, color) {
    // Clockwise winding (reversed) — for stroke cutout
    const pathIdx = this._paths.length;
    const segStart = this._segments.length;
    if (w <= 0 || h <= 0) return;
    if (radius > 0) {
      const r = Math.min(radius, w / 2, h / 2);
      const ARC_SEGS = 4;
      const push = (x0, y0, x1, y1) => { this._segments.push({ p0x: x0, p0y: y0, p1x: x1, p1y: y1, pathIdx }); };
      // Clockwise: reverse order of edges and arcs
      this._arcSegments(x + r, y + r, r, Math.PI * 1.5, Math.PI, ARC_SEGS, pathIdx);
      push(x, y + r, x, y + h - r);
      this._arcSegments(x + r, y + h - r, r, Math.PI, Math.PI / 2, ARC_SEGS, pathIdx);
      push(x + r, y + h, x + w - r, y + h);
      this._arcSegments(x + w - r, y + h - r, r, Math.PI / 2, 0, ARC_SEGS, pathIdx);
      push(x + w, y + h - r, x + w, y + r);
      this._arcSegments(x + w - r, y + r, r, 0, -Math.PI / 2, ARC_SEGS, pathIdx);
      push(x + w - r, y, x + r, y);
    } else {
      this._segments.push({ p0x: x, p0y: y, p1x: x, p1y: y + h, pathIdx });
      this._segments.push({ p0x: x, p0y: y + h, p1x: x + w, p1y: y + h, pathIdx });
      this._segments.push({ p0x: x + w, p0y: y + h, p1x: x + w, p1y: y, pathIdx });
      this._segments.push({ p0x: x + w, p0y: y, p1x: x, p1y: y, pathIdx });
    }
    this._paths.push({ segStart, segCount: this._segments.length - segStart, color, flags: pathIdx });
  }

  // ── Gradient rect ──
  // 2-stop:  :gradient [linear [r g b a] [r g b a]]
  // N-stop:  :gradient [linear [r g b a 0] [r g b a 0.5] [r g b a 1]]
  //   Each stop is [r g b a t] where t ∈ [0..1]. If t is omitted, stops are evenly spaced.
  //   Type: "linear" | "radial"

  _addGradientRectPath(x, y, w, h, radius, gradient) {
    if (!Array.isArray(gradient) || gradient.length < 3) {
      this._addRectPath(x, y, w, h, radius, this._packColor([1, 1, 1, 1]));
      return;
    }
    const type = gradient[0];
    const fillType = type === 'radial' ? FILL_RADIAL : type === 'conic' ? FILL_CONIC : FILL_LINEAR;
    const gradIdx = this._gradients.length;
    const stops = gradient.slice(1); // array of color arrays

    // Gradient endpoints
    let p0x, p0y, p1x, p1y;
    if (fillType === FILL_LINEAR) {
      p0x = x + w / 2; p0y = y;
      p1x = x + w / 2; p1y = y + h;
    } else if (fillType === FILL_CONIC) {
      // Conic: center at rect center, p1.x = angle offset (radians), p1.y unused
      const angleOffset = Array.isArray(gradient) && typeof gradient[gradient.length - 1] === 'string' && gradient[gradient.length - 1].endsWith('deg')
        ? parseFloat(gradient[gradient.length - 1]) * Math.PI / 180 : 0;
      p0x = x + w / 2; p0y = y + h / 2;
      p1x = angleOffset; p1y = 0;
    } else {
      p0x = x + w / 2; p0y = y + h / 2;
      p1x = x + w; p1y = y;
    }

    // Determine if this is a simple 2-stop (fast path) or N-stop
    const isNStop = stops.length > 2 || stops.some(s => Array.isArray(s) && s.length >= 5);

    if (isNStop) {
      // N-stop: push stops into the flat gradient_stops array
      const stopStart = this._gradientStops.length;
      for (let i = 0; i < stops.length; i++) {
        const s = Array.isArray(stops[i]) ? stops[i] : [1, 1, 1, 1];
        const color = this._packColor(s.slice(0, 4));
        const t = s.length >= 5 ? Number(s[4]) : i / Math.max(1, stops.length - 1);
        this._gradientStops.push({ color, t });
      }
      this._gradients.push({
        color0: 0, color1: 0,
        p0x, p0y, p1x, p1y,
        stopStart, stopCount: stops.length,
      });
    } else {
      // 2-stop fast path: colors in header, no stops array
      const c0 = Array.isArray(stops[0]) ? stops[0] : [1, 1, 1, 1];
      const c1 = Array.isArray(stops[1]) ? stops[1] : [0, 0, 0, 1];
      this._gradients.push({
        color0: this._packColor(c0), color1: this._packColor(c1),
        p0x, p0y, p1x, p1y,
        stopStart: 0, stopCount: 0,
      });
    }

    // Create path with gradient flags
    const pathIdx = this._paths.length;
    const segStart = this._segments.length;
    if (radius > 0) {
      this._roundedRectSegments(x, y, w, h, Math.min(radius, w / 2, h / 2), pathIdx);
    } else {
      this._segments.push({ p0x: x, p0y: y, p1x: x + w, p1y: y, pathIdx });
      this._segments.push({ p0x: x + w, p0y: y, p1x: x + w, p1y: y + h, pathIdx });
      this._segments.push({ p0x: x + w, p0y: y + h, p1x: x, p1y: y + h, pathIdx });
      this._segments.push({ p0x: x, p0y: y + h, p1x: x, p1y: y, pathIdx });
    }
    const flags = (pathIdx & 0xFFFF) | (fillType << 16) | (gradIdx << 19);
    this._paths.push({ segStart, segCount: this._segments.length - segStart, color: 0xFFFFFFFF, flags });
  }

  // ── @shadow — analytical rounded-rect shadow ──

  _collectShadow(node, offsetX, offsetY) {
    // Analytical erf-based rounded-rect shadow
    const blur = this._numAttr(node, 'blur', 4);
    const oxAttr = this._numAttr(node, 'offset-x', 0);
    const oyAttr = this._numAttr(node, 'offset-y', 0);
    const offset = this._attr(node, 'offset', undefined);
    const offX = offset && Array.isArray(offset) ? (+offset[0] || 0) : oxAttr;
    const offY = offset && Array.isArray(offset) ? (+offset[1] || 0) : oyAttr;
    const color = this._attr(node, 'color', [0, 0, 0, 0.3]);
    const spread = this._numAttr(node, 'spread', 0);

    // Find the child rect/panel to shadow, or use explicit dimensions
    let sx, sy, sw, sh, sr;
    const child = node.children.find(c => c.type === 'rect' || c.type === 'panel');
    if (child) {
      sx = this._numAttr(child, 'x', 0) + offsetX;
      sy = this._numAttr(child, 'y', 0) + offsetY;
      sw = this._numAttr(child, 'w', 100);
      sh = this._numAttr(child, 'h', 100);
      sr = this._numAttr(child, 'radius', 0);
    } else {
      sx = this._numAttr(node, 'x', 0) + offsetX;
      sy = this._numAttr(node, 'y', 0) + offsetY;
      sw = this._numAttr(node, 'w', 100);
      sh = this._numAttr(node, 'h', 100);
      sr = this._numAttr(node, 'radius', 0);
    }

    // Shadow rect expanded by blur + spread, with offset
    const expand = blur * 2.5 + spread;
    const ex = sx + offX - expand;
    const ey = sy + offY - expand;
    const ew = sw + expand * 2;
    const eh = sh + expand * 2;

    // Store shadow in gradient buffer: p0=rect center, p1=rect half-size
    // color0=shadow color, color1 packs radius and blur into R and G channels
    const gradIdx = this._gradients.length;
    const centerX = sx + offX + sw / 2;
    const centerY = sy + offY + sh / 2;
    const clampedRadius = Math.min(Math.round(sr + spread), 255);
    const clampedBlur = Math.min(Math.round(blur), 255);

    this._gradients.push({
      color0: this._packColor(color),
      color1: (clampedRadius & 0xFF) | ((clampedBlur & 0xFF) << 8),
      p0x: centerX, p0y: centerY,
      p1x: sw / 2 + spread, p1y: sh / 2 + spread,
      stopStart: 0, stopCount: 0,
    });

    // Create shadow path with FILL_SHADOW flag
    const pathIdx = this._paths.length;
    const segStart = this._segments.length;
    // Outer bounding rect for the shadow (expanded to cover blur falloff)
    this._segments.push({ p0x: ex, p0y: ey, p1x: ex + ew, p1y: ey, pathIdx });
    this._segments.push({ p0x: ex + ew, p0y: ey, p1x: ex + ew, p1y: ey + eh, pathIdx });
    this._segments.push({ p0x: ex + ew, p0y: ey + eh, p1x: ex, p1y: ey + eh, pathIdx });
    this._segments.push({ p0x: ex, p0y: ey + eh, p1x: ex, p1y: ey, pathIdx });
    const flags = (pathIdx & 0xFFFF) | (FILL_SHADOW << 16) | (gradIdx << 19);
    this._paths.push({ segStart, segCount: 4, color: this._packColor(color), flags });

    // Also collect the child element itself (drawn on top of shadow)
    if (child) {
      switch (child.type) {
        case 'rect': this._collectRect(child, offsetX, offsetY, null); break;
        case 'panel': this._collectPanel(child, offsetX, offsetY, null); break;
      }
    }
  }

  // ── @path — SVG path data → line segments ──

  _collectPath(node, offsetX, offsetY) {
    const d = node.name || this._attr(node, 'd', '') || '';
    if (!d) return;
    const fill = this._attr(node, 'fill', undefined);
    const stroke = this._attr(node, 'stroke', undefined);
    const strokeWidth = this._numAttr(node, 'stroke-width', 1);
    const x = this._numAttr(node, 'x', 0) + offsetX;
    const y = this._numAttr(node, 'y', 0) + offsetY;

    // Cache parsed SVG segments at zero offset, translate on use
    if (!this._svgPathCache) this._svgPathCache = new Map();
    let baseSegs = this._svgPathCache.get(d);
    if (!baseSegs) {
      baseSegs = this._parseSVGPath(d, 0, 0);
      this._svgPathCache.set(d, baseSegs);
    }
    // Apply offset translation
    const segments = (x === 0 && y === 0) ? baseSegs : baseSegs.map(s => ({
      p0x: s.p0x + x, p0y: s.p0y + y, p1x: s.p1x + x, p1y: s.p1y + y,
    }));
    if (segments.length === 0) return;

    // Fill path
    if (fill) {
      const pathIdx = this._paths.length;
      const segStart = this._segments.length;
      for (const s of segments) {
        this._segments.push({ ...s, pathIdx });
      }
      this._paths.push({ segStart, segCount: segments.length, color: this._packColor(fill), flags: pathIdx });
    }

    // Stroke path — expand each segment into a thin quad, merged into one path
    if (stroke) {
      const sc = this._packColor(stroke);
      const hsw = strokeWidth / 2;
      const pathIdx = this._paths.length;
      const segStart = this._segments.length;
      for (const s of segments) {
        const dx = s.p1x - s.p0x, dy = s.p1y - s.p0y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.001) continue;
        const nx = -dy / len * hsw, ny = dx / len * hsw;
        this._segments.push({ p0x: s.p0x + nx, p0y: s.p0y + ny, p1x: s.p1x + nx, p1y: s.p1y + ny, pathIdx });
        this._segments.push({ p0x: s.p1x + nx, p0y: s.p1y + ny, p1x: s.p1x - nx, p1y: s.p1y - ny, pathIdx });
        this._segments.push({ p0x: s.p1x - nx, p0y: s.p1y - ny, p1x: s.p0x - nx, p1y: s.p0y - ny, pathIdx });
        this._segments.push({ p0x: s.p0x - nx, p0y: s.p0y - ny, p1x: s.p0x + nx, p1y: s.p0y + ny, pathIdx });
      }
      const segCount = this._segments.length - segStart;
      if (segCount > 0) this._paths.push({ segStart, segCount, color: sc, flags: pathIdx });
    }
  }

  _parseSVGPath(d, ox, oy) {
    // ox/oy = translation offset applied to all absolute coords in the path
    const segs = [];
    const tokens = d.match(/[a-zA-Z]|[-+]?\d*\.?\d+/g) || [];
    let i = 0, cx = ox, cy = oy, sx = ox, sy = oy;
    const n = () => { const v = Number(tokens[i]) || 0; i++; return v; };
    while (i < tokens.length) {
      const cmd = tokens[i]; i++;
      switch (cmd) {
        case 'M': cx = n() + ox; cy = n() + oy; sx = cx; sy = cy; break;
        case 'm': cx += n(); cy += n(); sx = cx; sy = cy; break;
        case 'L': { const x = n() + ox, y = n() + oy; segs.push({ p0x: cx, p0y: cy, p1x: x, p1y: y }); cx = x; cy = y; break; }
        case 'l': { const dx = n(), dy = n(); segs.push({ p0x: cx, p0y: cy, p1x: cx + dx, p1y: cy + dy }); cx += dx; cy += dy; break; }
        case 'H': { const x = n() + ox; segs.push({ p0x: cx, p0y: cy, p1x: x, p1y: cy }); cx = x; break; }
        case 'h': { const dx = n(); segs.push({ p0x: cx, p0y: cy, p1x: cx + dx, p1y: cy }); cx += dx; break; }
        case 'V': { const y = n() + oy; segs.push({ p0x: cx, p0y: cy, p1x: cx, p1y: y }); cy = y; break; }
        case 'v': { const dy = n(); segs.push({ p0x: cx, p0y: cy, p1x: cx, p1y: cy + dy }); cy += dy; break; }
        case 'Q': {
          const cpx = n() + ox, cpy = n() + oy, ex = n() + ox, ey = n() + oy;
          this._flattenQuad(cx, cy, cpx, cpy, ex, ey, segs);
          cx = ex; cy = ey; break;
        }
        case 'q': {
          const cpx = cx + n(), cpy = cy + n(), ex = cx + n(), ey = cy + n();
          this._flattenQuad(cx, cy, cpx, cpy, ex, ey, segs);
          cx = ex; cy = ey; break;
        }
        case 'C': {
          const c1x = n() + ox, c1y = n() + oy, c2x = n() + ox, c2y = n() + oy, ex = n() + ox, ey = n() + oy;
          this._flattenCubic(cx, cy, c1x, c1y, c2x, c2y, ex, ey, segs);
          cx = ex; cy = ey; break;
        }
        case 'c': {
          const c1x = cx + n(), c1y = cy + n(), c2x = cx + n(), c2y = cy + n(), ex = cx + n(), ey = cy + n();
          this._flattenCubic(cx, cy, c1x, c1y, c2x, c2y, ex, ey, segs);
          cx = ex; cy = ey; break;
        }
        case 'A': {
          const rx = Math.abs(n()), ry = Math.abs(n()), rot = n() * Math.PI / 180;
          const largeArc = n(), sweep = n();
          const ex = n() + ox, ey = n() + oy;
          this._flattenArc(cx, cy, rx, ry, rot, largeArc, sweep, ex, ey, segs);
          cx = ex; cy = ey; break;
        }
        case 'a': {
          const rx = Math.abs(n()), ry = Math.abs(n()), rot = n() * Math.PI / 180;
          const largeArc = n(), sweep = n();
          const ex = cx + n(), ey = cy + n();
          this._flattenArc(cx, cy, rx, ry, rot, largeArc, sweep, ex, ey, segs);
          cx = ex; cy = ey; break;
        }
        case 'S': {
          // Smooth cubic: reflect last control point
          const c1x = cx, c1y = cy; // fallback (no previous cubic)
          const c2x = n() + ox, c2y = n() + oy, ex = n() + ox, ey = n() + oy;
          this._flattenCubic(cx, cy, c1x, c1y, c2x, c2y, ex, ey, segs);
          cx = ex; cy = ey; break;
        }
        case 's': {
          const c1x = cx, c1y = cy;
          const c2x = cx + n(), c2y = cy + n(), ex = cx + n(), ey = cy + n();
          this._flattenCubic(cx, cy, c1x, c1y, c2x, c2y, ex, ey, segs);
          cx = ex; cy = ey; break;
        }
        case 'T': {
          // Smooth quadratic: reflect last control point (fallback = current)
          const ex = n() + ox, ey = n() + oy;
          this._flattenQuad(cx, cy, cx, cy, ex, ey, segs);
          cx = ex; cy = ey; break;
        }
        case 't': {
          const ex = cx + n(), ey = cy + n();
          this._flattenQuad(cx, cy, cx, cy, ex, ey, segs);
          cx = ex; cy = ey; break;
        }
        case 'Z': case 'z':
          if (cx !== sx || cy !== sy) segs.push({ p0x: cx, p0y: cy, p1x: sx, p1y: sy });
          cx = sx; cy = sy; break;
        default: break;
      }
    }
    return segs;
  }

  // SVG endpoint arc → center parameterization → line segments (W3C SVG spec F.6)
  _flattenArc(x1, y1, rx, ry, phi, fA, fS, x2, y2, segs) {
    if (rx === 0 || ry === 0) { segs.push({ p0x: x1, p0y: y1, p1x: x2, p1y: y2 }); return; }
    const cos = Math.cos(phi), sin = Math.sin(phi);
    const dx2 = (x1 - x2) / 2, dy2 = (y1 - y2) / 2;
    const x1p = cos * dx2 + sin * dy2, y1p = -sin * dx2 + cos * dy2;
    // Correct radii if too small
    let rxSq = rx * rx, rySq = ry * ry;
    const x1pSq = x1p * x1p, y1pSq = y1p * y1p;
    const lambda = x1pSq / rxSq + y1pSq / rySq;
    if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); rxSq = rx * rx; rySq = ry * ry; }
    // Center point
    let sq = Math.max(0, (rxSq * rySq - rxSq * y1pSq - rySq * x1pSq) / (rxSq * y1pSq + rySq * x1pSq));
    sq = Math.sqrt(sq) * (fA === fS ? -1 : 1);
    const cxp = sq * rx * y1p / ry, cyp = -sq * ry * x1p / rx;
    const cxr = cos * cxp - sin * cyp + (x1 + x2) / 2;
    const cyr = sin * cxp + cos * cyp + (y1 + y2) / 2;
    // Angles
    const ang = (ux, uy, vx, vy) => {
      const n = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
      const c = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (n || 1)));
      return (ux * vy - uy * vx < 0 ? -1 : 1) * Math.acos(c);
    };
    const theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dTheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!fS && dTheta > 0) dTheta -= 2 * Math.PI;
    if (fS && dTheta < 0) dTheta += 2 * Math.PI;
    // Flatten to line segments
    const nSegs = Math.max(4, Math.ceil(Math.abs(dTheta) / (Math.PI / 4)));
    let px = x1, py = y1;
    for (let i = 1; i <= nSegs; i++) {
      const t = theta1 + dTheta * i / nSegs;
      const ex = cos * rx * Math.cos(t) - sin * ry * Math.sin(t) + cxr;
      const ey = sin * rx * Math.cos(t) + cos * ry * Math.sin(t) + cyr;
      segs.push({ p0x: px, p0y: py, p1x: ex, p1y: ey });
      px = ex; py = ey;
    }
  }

  _flattenQuad(x0, y0, cpx, cpy, x1, y1, segs, n = 4) {
    let px = x0, py = y0;
    for (let i = 1; i <= n; i++) {
      const t = i / n, t1 = 1 - t;
      const x = t1 * t1 * x0 + 2 * t1 * t * cpx + t * t * x1;
      const y = t1 * t1 * y0 + 2 * t1 * t * cpy + t * t * y1;
      segs.push({ p0x: px, p0y: py, p1x: x, p1y: y });
      px = x; py = y;
    }
  }

  _flattenCubic(x0, y0, c1x, c1y, c2x, c2y, x1, y1, segs, n = 8) {
    let px = x0, py = y0;
    for (let i = 1; i <= n; i++) {
      const t = i / n, t1 = 1 - t;
      const x = t1*t1*t1*x0 + 3*t1*t1*t*c1x + 3*t1*t*t*c2x + t*t*t*x1;
      const y = t1*t1*t1*y0 + 3*t1*t1*t*c1y + 3*t1*t*t*c2y + t*t*t*y1;
      segs.push({ p0x: px, p0y: py, p1x: x, p1y: y });
      px = x; py = y;
    }
  }

  _pathBBox(d) {
    // Reuse cached zero-offset segments
    if (!this._svgPathCache) this._svgPathCache = new Map();
    let segs = this._svgPathCache.get(d);
    if (!segs) { segs = this._parseSVGPath(d, 0, 0); this._svgPathCache.set(d, segs); }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of segs) {
      minX = Math.min(minX, s.p0x, s.p1x); minY = Math.min(minY, s.p0y, s.p1y);
      maxX = Math.max(maxX, s.p0x, s.p1x); maxY = Math.max(maxY, s.p0y, s.p1y);
    }
    if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    return { minX, minY, maxX, maxY };
  }

  // ════════════════════════════════════════════════════════════════
  // GPU RESOURCES
  // ════════════════════════════════════════════════════════════════

  _destroyBuffers() {
    const bufs = [
      '_configBuffer', '_segmentBuffer', '_pathInfoBuffer',
      '_tileSegCountsBuffer', '_ptclBuffer', '_tileSegsBuffer',
      '_bumpBuffer', '_hitResultBuffer', '_mousePosBuffer',
      '_glyphBuffer', '_sdfDimsBuffer', '_gradientBuffer', '_gradientStopsBuffer',
    ];
    for (const key of bufs) {
      if (this[key]) { this[key].destroy(); this[key] = null; }
    }
    if (this._surfaceTexture) { this._surfaceTexture.destroy(); this._surfaceTexture = null; }
  }

  _createBuffers() {
    this._destroyBuffers();

    const nSegs = Math.max(this._segments.length, 1);
    const nPaths = Math.max(this._paths.length, 1);
    const nTiles = this._tilesX * this._tilesY;
    const maxTileSegs = nSegs * Math.min(16, Math.max(this._tilesX, this._tilesY));
    const nGlyphs = Math.max(this._textQuads.length, 1);

    const dev = this.device;
    const S = GPUBufferUsage.STORAGE;
    const U = GPUBufferUsage.UNIFORM;
    const CD = GPUBufferUsage.COPY_DST;
    const CS = GPUBufferUsage.COPY_SRC;

    this._configBuffer = dev.createBuffer({ size: 32, usage: U | CD });
    this._segmentBuffer = dev.createBuffer({ size: nSegs * 24, usage: S | CD });
    this._pathInfoBuffer = dev.createBuffer({ size: nPaths * 16, usage: S | CD });
    this._tileSegCountsBuffer = dev.createBuffer({ size: Math.max(nTiles * 4, 4), usage: S | CD });
    this._ptclBuffer = dev.createBuffer({ size: Math.max(nTiles * MAX_CMDS_PER_TILE * 8, 8), usage: S | CD });
    this._tileSegsBuffer = dev.createBuffer({ size: Math.max(maxTileSegs * 24, 24), usage: S | CD });
    this._bumpBuffer = dev.createBuffer({ size: 16, usage: S | CD });
    this._hitResultBuffer = dev.createBuffer({ size: 16, usage: S | CD | CS });
    this._hitReadbackBuffer = dev.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this._mousePosBuffer = dev.createBuffer({ size: 16, usage: U | CD });

    // GlyphInstance = 48 bytes (pos_size:16 + uv_rect:16 + color:4 + pad:12)
    this._glyphBuffer = dev.createBuffer({ size: nGlyphs * 48, usage: S | CD });
    // GradientInfo = 32 bytes (color0:4 + color1:4 + p0:8 + p1:8 + stop_start:4 + stop_count:4)
    const nGrads = Math.max(this._gradients.length, 1);
    this._gradientBuffer = dev.createBuffer({ size: nGrads * 32, usage: S | CD });
    // GradientStop = 8 bytes (color:4 + t:4)
    const nStops = Math.max(this._gradientStops.length, 1);
    this._gradientStopsBuffer = dev.createBuffer({ size: nStops * 8, usage: S | CD });
    // Surface dims uniform (width, height as f32)
    this._sdfDimsBuffer = dev.createBuffer({ size: 16, usage: U | CD });

    // Surface texture — STORAGE + TEXTURE + RENDER_ATTACHMENT (for SDF text pass)
    this._surfaceTexture = dev.createTexture({
      size: [this._width, this._height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this._surfaceSampler = dev.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }

  _uploadSceneData() {
    const dev = this.device;
    const nTiles = this._tilesX * this._tilesY;

    // Config
    dev.queue.writeBuffer(this._configBuffer, 0, new Uint32Array([
      this._width, this._height, this._tilesX, this._tilesY,
      this._paths.length, this._segments.length, this._gradients.length, 0,
    ]));

    // Segments
    if (this._segments.length > 0) {
      const segData = new ArrayBuffer(this._segments.length * 24);
      const segF32 = new Float32Array(segData);
      const segU32 = new Uint32Array(segData);
      for (let i = 0; i < this._segments.length; i++) {
        const s = this._segments[i];
        const off = i * 6;
        segF32[off] = s.p0x; segF32[off + 1] = s.p0y;
        segF32[off + 2] = s.p1x; segF32[off + 3] = s.p1y;
        segU32[off + 4] = s.pathIdx; segU32[off + 5] = 0;
      }
      dev.queue.writeBuffer(this._segmentBuffer, 0, segData);
    }

    // Path info
    if (this._paths.length > 0) {
      const pathData = new Uint32Array(this._paths.length * 4);
      for (let i = 0; i < this._paths.length; i++) {
        const p = this._paths[i];
        const off = i * 4;
        pathData[off] = p.segStart; pathData[off + 1] = p.segCount;
        pathData[off + 2] = p.color; pathData[off + 3] = p.flags;
      }
      dev.queue.writeBuffer(this._pathInfoBuffer, 0, pathData);
    }

    // Tile data
    dev.queue.writeBuffer(this._tileSegCountsBuffer, 0, new Uint32Array(Math.max(nTiles, 1)));
    dev.queue.writeBuffer(this._bumpBuffer, 0, new Uint32Array([0, 0, 0, 0]));
    dev.queue.writeBuffer(this._ptclBuffer, 0, new Uint32Array(Math.max(nTiles * MAX_CMDS_PER_TILE * 2, 2)));

    // Glyph instances — 48 bytes each: pos_size(16) + uv_rect(16) + color(4) + pad(12)
    if (this._textQuads.length > 0) {
      const glyphData = new ArrayBuffer(this._textQuads.length * 48);
      const gf = new Float32Array(glyphData);
      const gu = new Uint32Array(glyphData);
      for (let i = 0; i < this._textQuads.length; i++) {
        const q = this._textQuads[i];
        const off = i * 12; // 48 bytes / 4 = 12 u32s
        gf[off] = q.x; gf[off + 1] = q.y; gf[off + 2] = q.w; gf[off + 3] = q.h;
        gf[off + 4] = q.u0; gf[off + 5] = q.v0; gf[off + 6] = q.u1; gf[off + 7] = q.v1;
        gu[off + 8] = q.color;
        gu[off + 9] = 0; gu[off + 10] = 0; gu[off + 11] = 0; // padding
      }
      dev.queue.writeBuffer(this._glyphBuffer, 0, glyphData);
    }

    // Gradient headers — 32 bytes each
    if (this._gradients.length > 0) {
      const gradData = new ArrayBuffer(this._gradients.length * 32);
      const gU = new Uint32Array(gradData);
      const gF = new Float32Array(gradData);
      for (let i = 0; i < this._gradients.length; i++) {
        const g = this._gradients[i];
        const off = i * 8; // 32 bytes / 4 = 8 u32s
        gU[off] = g.color0; gU[off + 1] = g.color1;
        gF[off + 2] = g.p0x; gF[off + 3] = g.p0y;
        gF[off + 4] = g.p1x; gF[off + 5] = g.p1y;
        gU[off + 6] = g.stopStart || 0; gU[off + 7] = g.stopCount || 0;
      }
      dev.queue.writeBuffer(this._gradientBuffer, 0, gradData);
    }

    // Gradient stops — 8 bytes each (color u32 + t f32)
    if (this._gradientStops.length > 0) {
      const stopData = new ArrayBuffer(this._gradientStops.length * 8);
      const sU = new Uint32Array(stopData);
      const sF = new Float32Array(stopData);
      for (let i = 0; i < this._gradientStops.length; i++) {
        const s = this._gradientStops[i];
        sU[i * 2] = s.color;
        sF[i * 2 + 1] = s.t;
      }
      dev.queue.writeBuffer(this._gradientStopsBuffer, 0, stopData);
    }

    // SDF dims
    dev.queue.writeBuffer(this._sdfDimsBuffer, 0, new Float32Array([this._width, this._height, 0, 0]));
  }

  // ════════════════════════════════════════════════════════════════
  // PIPELINES
  // ════════════════════════════════════════════════════════════════

  _createPipelines() {
    const dev = this.device;

    try { this._flattenPipeline = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: FLATTEN_WGSL }), entryPoint: 'main' } }); this.log('surface pipeline: flatten', 'ok'); } catch (e) { this.log(`surface pipeline flatten: ${e.message}`, 'err'); }
    try { this._coarsePipeline = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: COARSE_WGSL }), entryPoint: 'main' } }); this.log('surface pipeline: coarse', 'ok'); } catch (e) { this.log(`surface pipeline coarse: ${e.message}`, 'err'); }
    try { this._finePipeline = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: FINE_WGSL }), entryPoint: 'main' } }); this.log('surface pipeline: fine', 'ok'); } catch (e) { this.log(`surface pipeline fine: ${e.message}`, 'err'); }
    try { this._hitTestPipeline = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: HIT_TEST_WGSL }), entryPoint: 'main' } }); this.log('surface pipeline: hit-test', 'ok'); } catch (e) { this.log(`surface pipeline hit-test: ${e.message}`, 'err'); }

    try {
      const compMod = dev.createShaderModule({ code: COMPOSITE_WGSL });
      this._compositePipeline = dev.createRenderPipeline({
        layout: 'auto',
        vertex: { module: compMod, entryPoint: 'vs_main' },
        fragment: { module: compMod, entryPoint: 'fs_main', targets: [{ format: this.format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } }] },
        primitive: { topology: 'triangle-list' },
      });
      this.log('surface pipeline: composite', 'ok');
    } catch (e) { this.log(`surface pipeline composite: ${e.message}`, 'err'); }

    // SDF text render pipeline — renders to rgba8unorm surface texture
    try {
      const sdfMod = dev.createShaderModule({ code: SDF_TEXT_WGSL });
      this._sdfPipeline = dev.createRenderPipeline({
        layout: 'auto',
        vertex: { module: sdfMod, entryPoint: 'vs_main' },
        fragment: {
          module: sdfMod, entryPoint: 'fs_main',
          targets: [{
            format: 'rgba8unorm',
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          }],
        },
        primitive: { topology: 'triangle-list' },
      });
      this.log('surface pipeline: sdf-text', 'ok');
    } catch (e) { this.log(`surface pipeline sdf-text: ${e.message}`, 'err'); }
  }

  // ════════════════════════════════════════════════════════════════
  // BIND GROUPS
  // ════════════════════════════════════════════════════════════════

  _createBindGroups() {
    const dev = this.device;

    if (this._flattenPipeline) {
      this._flattenBG = dev.createBindGroup({ layout: this._flattenPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this._configBuffer } },
        { binding: 1, resource: { buffer: this._segmentBuffer } },
        { binding: 2, resource: { buffer: this._tileSegCountsBuffer } },
        { binding: 3, resource: { buffer: this._tileSegsBuffer } },
        { binding: 4, resource: { buffer: this._bumpBuffer } },
      ]});
    }
    if (this._coarsePipeline) {
      this._coarseBG = dev.createBindGroup({ layout: this._coarsePipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this._configBuffer } },
        { binding: 1, resource: { buffer: this._pathInfoBuffer } },
        { binding: 2, resource: { buffer: this._segmentBuffer } },
        { binding: 3, resource: { buffer: this._ptclBuffer } },
      ]});
    }
    if (this._finePipeline && this._surfaceTexture) {
      this._fineBG = dev.createBindGroup({ layout: this._finePipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this._configBuffer } },
        { binding: 1, resource: { buffer: this._pathInfoBuffer } },
        { binding: 2, resource: { buffer: this._segmentBuffer } },
        { binding: 3, resource: { buffer: this._ptclBuffer } },
        { binding: 4, resource: this._surfaceTexture.createView() },
        { binding: 5, resource: { buffer: this._gradientBuffer } },
        { binding: 6, resource: { buffer: this._gradientStopsBuffer } },
      ]});
    }
    if (this._hitTestPipeline) {
      this._hitTestBG = dev.createBindGroup({ layout: this._hitTestPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this._configBuffer } },
        { binding: 1, resource: { buffer: this._pathInfoBuffer } },
        { binding: 2, resource: { buffer: this._segmentBuffer } },
        { binding: 3, resource: { buffer: this._mousePosBuffer } },
        { binding: 4, resource: { buffer: this._hitResultBuffer } },
      ]});
    }
    if (this._compositePipeline && this._surfaceTexture) {
      this._compositeBG = dev.createBindGroup({ layout: this._compositePipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this._surfaceTexture.createView() },
        { binding: 1, resource: this._surfaceSampler },
      ]});
    }
    // SDF text bind group
    if (this._sdfPipeline && this._sdfAtlasTexture && this._glyphBuffer) {
      this._sdfBG = dev.createBindGroup({ layout: this._sdfPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this._glyphBuffer } },
        { binding: 1, resource: this._sdfAtlasTexture.createView() },
        { binding: 2, resource: this._sdfAtlasSampler },
        { binding: 3, resource: { buffer: this._sdfDimsBuffer } },
      ]});
    }
  }

  // ════════════════════════════════════════════════════════════════
  // EXECUTE PHASE
  // ════════════════════════════════════════════════════════════════

  execute() {
    if (!this._active) return;

    const hasPaths = this._paths.length > 0;
    const hasText = this._textQuads.length > 0;

    if (!hasPaths && !hasText) return;
    if (!this._compositePipeline) return;

    const dev = this.device;
    const nTiles = this._tilesX * this._tilesY;

    const enc = dev.createCommandEncoder();

    // ── Path pipeline (if we have paths) ──
    if (hasPaths && this._flattenPipeline && this._coarsePipeline && this._finePipeline) {
      dev.queue.writeBuffer(this._bumpBuffer, 0, new Uint32Array([0, 0, 0, 0]));
      dev.queue.writeBuffer(this._tileSegCountsBuffer, 0, new Uint32Array(nTiles));

      { const p = enc.beginComputePass(); p.setPipeline(this._flattenPipeline); p.setBindGroup(0, this._flattenBG); p.dispatchWorkgroups(Math.max(1, Math.ceil(this._segments.length / 256))); p.end(); }
      { const p = enc.beginComputePass(); p.setPipeline(this._coarsePipeline); p.setBindGroup(0, this._coarseBG); p.dispatchWorkgroups(this._tilesX, this._tilesY); p.end(); }
      { const p = enc.beginComputePass(); p.setPipeline(this._finePipeline); p.setBindGroup(0, this._fineBG); p.dispatchWorkgroups(this._tilesX, this._tilesY); p.end(); }
    }

    // ── Hit test ──
    dev.queue.writeBuffer(this._mousePosBuffer, 0, new Float32Array([this._mouseX, this._mouseY]));
    if (hasPaths && this._hitTestPipeline && this._hitTestBG) {
      const p = enc.beginComputePass(); p.setPipeline(this._hitTestPipeline); p.setBindGroup(0, this._hitTestBG); p.dispatchWorkgroups(1); p.end();
    }

    // ── SDF text render pass (renders to surface texture) ──
    if (hasText && this._sdfPipeline && this._sdfBG) {
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: this._surfaceTexture.createView(),
          loadOp: hasPaths ? 'load' : 'clear',  // preserve path output if present
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
      });
      pass.setPipeline(this._sdfPipeline);
      pass.setBindGroup(0, this._sdfBG);
      pass.draw(6, this._textQuads.length);
      pass.end();
    }

    // ── Composite to canvas ──
    {
      const tv = this.context.getCurrentTexture().createView();
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: tv, loadOp: this._compositeLoadOp, storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      pass.setPipeline(this._compositePipeline);
      pass.setBindGroup(0, this._compositeBG);
      pass.draw(3);
      pass.end();
    }

    // ── Hit test readback (async, non-blocking) ──
    if (this._hitTestPipeline && this._hitReadbackBuffer && !this._hitReadbackPending) {
      const readEnc = dev.createCommandEncoder();
      readEnc.copyBufferToBuffer(this._hitResultBuffer, 0, this._hitReadbackBuffer, 0, 16);
      dev.queue.submit([enc.finish(), readEnc.finish()]);
      this._hitReadbackPending = true;
      this._hitReadbackBuffer.mapAsync(GPUMapMode.READ).then(() => {
        const data = new Uint32Array(this._hitReadbackBuffer.getMappedRange().slice(0));
        this._hitReadbackBuffer.unmap();
        this._hitReadbackPending = false;
        const eid = data[0];
        if (eid !== this._lastHitId) {
          this._lastHitId = eid;
          if (this.onHitChange) this.onHitChange(eid === 0xFFFFFFFF ? -1 : eid);
        }
        if (this._pendingClick) {
          const {x, y} = this._pendingClick;
          this._pendingClick = null;
          if (this.onElementClick && eid !== 0xFFFFFFFF) this.onElementClick(eid, x, y);
        }
      }).catch(() => { this._hitReadbackPending = false; });
    } else {
      dev.queue.submit([enc.finish()]);
    }
  }

  // Click registration — called by main.js on mousedown
  registerClick(x, y) { this._pendingClick = {x, y}; }

  // ════════════════════════════════════════════════════════════════
  // TEXT EDITOR INPUT — keyboard, mouse, focus
  // ════════════════════════════════════════════════════════════════

  // Click → focus editor + place cursor
  handleEditorClick(canvasX, canvasY) {
    // Find which editor was clicked
    for (const [id, ed] of this._editors) {
      if (canvasX >= ed.x && canvasX <= ed.x + ed.w && canvasY >= ed.y && canvasY <= ed.y + ed.h) {
        this._focusedEditor = id;
        // Convert click position to cursor offset
        const lines = ed.lines;
        const clickLine = Math.floor((canvasY - ed.y - ed.padding + ed.scrollY) / ed.lineHeight);
        const li = Math.max(0, Math.min(clickLine, lines.length - 1));
        const line = lines[li];

        // Walk characters to find closest cursor position
        this._ensureMeasureCanvas();
        this._measureCtx.font = this._sdfFont;
        const scale = ed.scale || (ed.size / SDF_GLYPH_SIZE);
        let cx = ed.textLeft;
        let bestCol = 0;
        for (let ci = 0; ci < line.length; ci++) {
          const adv = this._getGlyphMetrics(line[ci]).advance * scale;
          if (canvasX < cx + adv / 2) break;
          cx += adv;
          bestCol = ci + 1;
        }

        // Convert line + col to absolute offset
        let offset = 0;
        for (let i = 0; i < li; i++) offset += lines[i].length + 1;
        offset += bestCol;
        ed.cursor = Math.min(offset, ed.content.length);
        ed.selStart = -1; ed.selEnd = -1;
        this._editorDirty = true;
        return true;
      }
    }
    this._focusedEditor = null;
    return false;
  }

  // Keyboard input → modify focused editor content
  handleEditorKey(key, shift, ctrl, meta) {
    const id = this._focusedEditor;
    if (!id) return false;
    const ed = this._editors.get(id);
    if (!ed) return false;

    const content = ed.content;
    const cur = ed.cursor;
    const lines = ed.lines;

    // Find current line and column
    let lineIdx = 0, colIdx = 0, charCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (charCount + lines[i].length >= cur && charCount <= cur) {
        lineIdx = i;
        colIdx = cur - charCount;
        break;
      }
      charCount += lines[i].length + 1;
    }

    let handled = true;

    if (key === 'Backspace') {
      if (cur > 0) {
        ed.content = content.slice(0, cur - 1) + content.slice(cur);
        ed.cursor = cur - 1;
      }
    } else if (key === 'Delete') {
      if (cur < content.length) {
        ed.content = content.slice(0, cur) + content.slice(cur + 1);
      }
    } else if (key === 'Enter') {
      ed.content = content.slice(0, cur) + '\n' + content.slice(cur);
      ed.cursor = cur + 1;
    } else if (key === 'Tab') {
      ed.content = content.slice(0, cur) + '  ' + content.slice(cur);
      ed.cursor = cur + 2;
    } else if (key === 'ArrowLeft') {
      if (ctrl || meta) {
        let p = cur - 1;
        while (p > 0 && content[p - 1] === ' ') p--;
        while (p > 0 && content[p - 1] !== ' ' && content[p - 1] !== '\n') p--;
        ed.cursor = Math.max(0, p);
      } else {
        ed.cursor = Math.max(0, cur - 1);
      }
    } else if (key === 'ArrowRight') {
      if (ctrl || meta) {
        let p = cur;
        while (p < content.length && content[p] !== ' ' && content[p] !== '\n') p++;
        while (p < content.length && content[p] === ' ') p++;
        ed.cursor = p;
      } else {
        ed.cursor = Math.min(content.length, cur + 1);
      }
    } else if (key === 'ArrowUp') {
      if (lineIdx > 0) {
        const prevLine = lines[lineIdx - 1];
        const newCol = Math.min(colIdx, prevLine.length);
        let offset = 0;
        for (let i = 0; i < lineIdx - 1; i++) offset += lines[i].length + 1;
        ed.cursor = offset + newCol;
      }
    } else if (key === 'ArrowDown') {
      if (lineIdx < lines.length - 1) {
        const nextLine = lines[lineIdx + 1];
        const newCol = Math.min(colIdx, nextLine.length);
        let offset = 0;
        for (let i = 0; i <= lineIdx; i++) offset += lines[i].length + 1;
        ed.cursor = offset + newCol;
      }
    } else if (key === 'Home') {
      let offset = 0;
      for (let i = 0; i < lineIdx; i++) offset += lines[i].length + 1;
      ed.cursor = offset;
    } else if (key === 'End') {
      let offset = 0;
      for (let i = 0; i < lineIdx; i++) offset += lines[i].length + 1;
      ed.cursor = offset + lines[lineIdx].length;
    } else if (ctrl && key === 'a') {
      ed.selStart = 0; ed.selEnd = content.length;
    } else if (key.length === 1 && !ctrl && !meta) {
      ed.content = content.slice(0, cur) + key + content.slice(cur);
      ed.cursor = cur + 1;
    } else {
      handled = false;
    }

    if (handled) {
      // Invalidate cached lines on content mutation
      if (ed.content !== content) ed.lines = ed.content.split('\n');

      // Auto-scroll to keep cursor visible
      const cursorLine = this._getCursorLine(ed);
      const visibleTop = ed.scrollY;
      const visibleBottom = ed.scrollY + ed.h - ed.padding * 2;
      const cursorY = cursorLine * ed.lineHeight;
      if (cursorY < visibleTop) ed.scrollY = cursorY;
      else if (cursorY + ed.lineHeight > visibleBottom) ed.scrollY = cursorY + ed.lineHeight - (ed.h - ed.padding * 2);
      ed.scrollY = Math.max(0, ed.scrollY);

      this._editorDirty = true;
      if (this.onEditorChange) this.onEditorChange(id, ed.content, ed.cursor);
    }
    return handled;
  }

  // Scroll within focused editor
  handleEditorScroll(deltaY) {
    const id = this._focusedEditor;
    if (!id) return false;
    const ed = this._editors.get(id);
    if (!ed) return false;
    ed.scrollY = Math.max(0, ed.scrollY + deltaY);
    this._editorDirty = true;
    return true;
  }

  _getCursorLine(ed) {
    const content = ed.content;
    let line = 0;
    for (let i = 0; i < ed.cursor && i < content.length; i++) {
      if (content[i] === '\n') line++;
    }
    return line;
  }

  // Check if an editor needs recompile, reset flag
  consumeDirty() {
    if (this._editorDirty) { this._editorDirty = false; return true; }
    return false;
  }

  get focusedEditor() { return this._focusedEditor; }
  getEditorContent(id) { return this._editors.get(id)?.content ?? ''; }
  getEditorState(id) { return this._editors.get(id) ?? null; }

  // ════════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════════════

  invalidate() {
    this._flattenBG = null;
    this._coarseBG = null;
    this._fineBG = null;
    this._hitTestBG = null;
    this._compositeBG = null;
    this._sdfBG = null;
  }

  destroy() {
    this._destroyBuffers();
    if (this._sdfAtlasTexture) { this._sdfAtlasTexture.destroy(); this._sdfAtlasTexture = null; }
    this._active = false;
  }
}
