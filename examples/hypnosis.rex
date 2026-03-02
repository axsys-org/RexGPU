;; ═══════════════════════════════════════════════════════════════════
;; Hypnosis Engine — Rex Projection Engine
;; Four visual modes: fractal · mandelbrot · tunnel · warp
;; Mouse steers · scroll zooms · all parameters exposed
;; ═══════════════════════════════════════════════════════════════════

;; ── Shared uniform struct ──
@struct Params
  @field res   :type f32x2
  @field time  :type f32
  @field mouse :type f32x2
  @field seed  :type f32
  @field zoom  :type f32
  @field twist :type f32
  @field hue   :type f32
  @field speed :type f32

;; ── Shared WGSL helpers ──
@lib hyp_util
  fn hsv(h: f32, s: f32, v: f32) -> vec3f {
    let k = vec4f(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    let p = abs(fract(vec3f(h) + k.xyz) * 6.0 - k.www);
    return v * mix(k.xxx, clamp(p - k.xxx, vec3f(0.0), vec3f(1.0)), s);
  }
  fn hash2(p: vec2f) -> f32 {
    var q = fract(p * vec2f(127.1, 311.7));
    q += dot(q, q + 19.19);
    return fract(q.x * q.y);
  }
  fn fullscreen_uv(vi: u32) -> vec2f {
    var pts = array<vec2f,6>(
      vec2f(-1,-1), vec2f(1,-1), vec2f(-1,1),
      vec2f(-1,1),  vec2f(1,-1), vec2f(1,1)
    );
    return pts[vi];
  }

;; ═══════════════════════════════════════════════════════════════════
;; MODE 1: Julia fractal — animated orbit seed + fbm interference
;; ═══════════════════════════════════════════════════════════════════
@shader fractal
  #import Params
  #import hyp_util

  struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
  @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    let p = fullscreen_uv(vi);
    var o: VSOut; o.pos = vec4f(p, 0, 1); o.uv = p; return o;
  }

  fn fbm(p: vec2f, t: f32) -> f32 {
    var v = 0.0; var a = 0.5; var q = p;
    for (var i = 0; i < 6; i = i + 1) {
      v += a * (sin(q.x * 7.3 + t * 0.3) * sin(q.y * 5.1 + t * 0.2) + hash2(q) * 0.15);
      q = q * 2.1 + vec2f(1.7, 0.9);
      a *= 0.48;
    }
    return v;
  }

  fn julia(c: vec2f, seed: vec2f) -> vec2f {
    var z = c;
    var ji = 0;
    for (var i = 0; i < 96; i = i + 1) {
      z = vec2f(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + seed;
      ji = i;
      if (dot(z, z) > 256.0) { break; }
    }
    let fi = f32(ji) - log2(log2(dot(z, z))) + 4.0;
    return vec2f(fi / 96.0, dot(z, z));
  }

  @fragment fn fs_main(v: VSOut) -> @location(0) vec4f {
    let asp = u.res.x / u.res.y;
    var p = v.uv * vec2f(asp, 1.0) / u.zoom;
    let t = u.time * u.speed;

    // Twist coordinate space
    let angle = atan2(p.y, p.x) + u.twist + sin(t * 0.07) * 0.3;
    let r = length(p);
    p = vec2f(cos(angle), sin(angle)) * r;

    // Julia seed: orbiting + mouse steering
    let m = (u.mouse - 0.5) * 2.0 * vec2f(asp, 1.0);
    let orbit = vec2f(
      sin(t * 0.17) * 0.6 + sin(t * 0.11) * 0.2,
      cos(t * 0.13) * 0.6 + cos(t * 0.07) * 0.2
    );
    let seed = (orbit + m * 0.25) * u.seed;
    let jv = julia(p, seed);
    let j = jv.x;

    let noise = fbm(p * 0.6 + vec2f(t * 0.04), t);
    let trap = abs(length(p) - 0.5);
    let blended = mix(j, noise * 0.5 + 0.5, 0.25) + trap * 0.08;

    // Triple-layer hue interference
    let h1 = fract(j * 2.1 + u.hue + t * 0.03);
    let h2 = fract(j * 5.3 + u.hue * 1.3 + t * 0.05);
    let h3 = fract(noise * 3.0 + u.hue * 0.7);
    let c1 = hsv(h1, 0.9, pow(clamp(j, 0.0, 1.0), 0.55) * 1.3);
    let c2 = hsv(h2, 0.7, pow(clamp(j, 0.0, 1.0), 0.8));
    let c3 = hsv(h3, 0.5, 0.4);
    var col = c1 * 0.6 + c2 * 0.3 + c3 * 0.1;

    // Glow halo on escaped boundary
    let edgeGlow = exp(-j * 4.0) * 2.0;
    col += hsv(fract(u.hue + 0.5), 1.0, edgeGlow) * 0.4;

    // Vignette
    let vign = 1.0 - smoothstep(0.6, 1.5, length(v.uv));
    return vec4f(col * vign, 1.0);
  }

;; ═══════════════════════════════════════════════════════════════════
;; MODE 2: Mandelbrot deep zoom — animated dive + smooth colouring
;; ═══════════════════════════════════════════════════════════════════
@shader mandelbrot
  #import Params
  #import hyp_util

  struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
  @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    let p = fullscreen_uv(vi);
    var o: VSOut; o.pos = vec4f(p, 0, 1); o.uv = p; return o;
  }

  @fragment fn fs_main(v: VSOut) -> @location(0) vec4f {
    let asp = u.res.x / u.res.y;
    let t = u.time * u.speed * 0.15;

    // Animated zoom into a deep spiral point
    let center = vec2f(-0.7435669, 0.1314023);
    let zf = pow(u.zoom * 0.5, 2.5) * exp(t * 0.08 * u.seed);
    var c = v.uv * vec2f(asp, 1.0) / zf + center;
    c += (u.mouse - 0.5) * 0.002 / zf;

    // Apply twist rotation
    let ang = u.twist;
    c = vec2f(c.x * cos(ang) - c.y * sin(ang), c.x * sin(ang) + c.y * cos(ang));

    var z = vec2f(0.0);
    var escaped = false;
    var iesc = 128;
    for (var i = 0; i < 128; i = i + 1) {
      z = vec2f(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
      if (dot(z, z) > 256.0) { escaped = true; iesc = i; break; }
    }
    if (!escaped) { return vec4f(0.0, 0.0, 0.0, 1.0); }

    let fi = f32(iesc) - log2(log2(dot(z, z))) + 4.0;
    let fn0 = fi / 128.0;

    // Colour bands cycling with time
    let h1 = fract(fn0 * 3.0 + u.hue + t * 0.4);
    let h2 = fract(fn0 * 7.0 + u.hue * 1.7 + t * 0.2);
    let bright = pow(fn0, 0.45);
    let col = hsv(h1, 0.95, bright) * 0.7 + hsv(h2, 0.6, bright * 0.5) * 0.3;
    let edgeGlow = exp(-fn0 * 6.0) * 1.5;
    return vec4f(col + hsv(fract(u.hue + 0.33), 1.0, edgeGlow) * 0.5, 1.0);
  }

;; ═══════════════════════════════════════════════════════════════════
;; MODE 3: Hex tunnel — infinite perspective + rotating hex grid
;; ═══════════════════════════════════════════════════════════════════
@shader tunnel
  #import Params
  #import hyp_util

  struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
  @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    let p = fullscreen_uv(vi);
    var o: VSOut; o.pos = vec4f(p, 0, 1); o.uv = p; return o;
  }

  fn hexDist(p: vec2f) -> f32 {
    let q = abs(p);
    return max(q.x * 0.866025 + q.y * 0.5, q.y) - 1.0;
  }

  fn hexGrid(uv: vec2f, scale: f32) -> vec3f {
    let s = vec2f(1.732051, 1.0) * scale;
    var gid = round(uv / s);
    var best = 9999.0;
    var bestId = vec2f(0.0);
    for (var dx = -1; dx <= 1; dx = dx + 1) {
      for (var dy = -1; dy <= 1; dy = dy + 1) {
        let id = gid + vec2f(f32(dx), f32(dy));
        let ctr = id * s;
        let d = hexDist((uv - ctr) / scale);
        if (d < best) { best = d; bestId = id; }
      }
    }
    return vec3f(best, bestId);
  }

  @fragment fn fs_main(v: VSOut) -> @location(0) vec4f {
    let asp = u.res.x / u.res.y;
    let p = v.uv * vec2f(asp, 1.0);
    let t = u.time * u.speed;

    // Twist angle with time and control
    let baseAng = atan2(p.y, p.x);
    let ang = baseAng / 3.14159 + u.twist + t * 0.04;
    let rad = length(p);

    // Perspective warp: depth = 1/r
    let depth = (1.0 / (rad + 0.02)) * u.zoom * 0.5;
    let texV = depth - t * 0.8;

    // Hex grid in tunnel coordinates
    let hv = hexGrid(vec2f(ang * 6.0, texV), 0.5);
    let hexD = hv.x;
    let hexId = hv.yz;

    // Edge glow + cell fill
    let edge = 1.0 - smoothstep(-0.04, 0.04, hexD);
    let fill = smoothstep(0.0, 0.3, hexD) * 0.15;

    // Unique colour per cell
    let cellH = fract(sin(dot(hexId, vec2f(127.1, 311.7))) * 43758.5);
    let hue = fract(cellH + u.hue + t * 0.06 + depth * 0.02);
    let m = u.mouse - 0.5;
    let hueShift = fract(hue + m.x * 0.3 + ang * 0.1);

    // Depth fog
    let fog = pow(1.0 - clamp(rad * 0.55, 0.0, 1.0), 2.0);
    let edgeCol = hsv(hueShift, 1.0, 1.0) * edge * fog * 2.5;
    let fillCol = hsv(fract(hueShift + 0.5), 0.6, fill) * fog;

    // Central glow
    let glow = exp(-rad * 3.0) * 0.8;
    let glowCol = hsv(fract(u.hue + t * 0.05), 0.8, glow);
    return vec4f(edgeCol + fillCol + glowCol, 1.0);
  }

;; ═══════════════════════════════════════════════════════════════════
;; MODE 4: Warp — raymarched SDF tori + sphere, orbiting camera
;; ═══════════════════════════════════════════════════════════════════
@shader warp
  #import Params
  #import hyp_util

  struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
  @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    let p = fullscreen_uv(vi);
    var o: VSOut; o.pos = vec4f(p, 0, 1); o.uv = p; return o;
  }

  fn sdTorus(p: vec3f, t: vec2f) -> f32 {
    let q = vec2f(length(p.xz) - t.x, p.y);
    return length(q) - t.y;
  }
  fn sdSphere(p: vec3f, r: f32) -> f32 { return length(p) - r; }
  fn smin(a: f32, b: f32, k: f32) -> f32 {
    let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
  }

  fn scene(p: vec3f, t: f32) -> f32 {
    let ang1 = t * 0.7 + p.y * 0.3;
    let ang2 = t * 0.4;
    let r1 = vec3f(p.x * cos(ang1) - p.z * sin(ang1), p.y, p.x * sin(ang1) + p.z * cos(ang1));
    let r2 = vec3f(p.x * cos(ang2) - p.y * sin(ang2), p.x * sin(ang2) + p.y * cos(ang2), p.z);
    let d1 = sdTorus(r1, vec2f(0.9, 0.25));
    let d2 = sdTorus(r2, vec2f(0.55, 0.12));
    let d3 = sdSphere(p, 0.3 + sin(t * 1.3) * 0.08);
    return smin(smin(d1, d2, 0.15), d3, 0.2);
  }

  fn getNormal(p: vec3f, t: f32) -> vec3f {
    let e = vec2f(0.001, 0.0);
    return normalize(vec3f(
      scene(p + e.xyy, t) - scene(p - e.xyy, t),
      scene(p + e.yxy, t) - scene(p - e.yxy, t),
      scene(p + e.yyx, t) - scene(p - e.yyx, t)
    ));
  }

  @fragment fn fs_main(v: VSOut) -> @location(0) vec4f {
    let asp = u.res.x / u.res.y;
    let t = u.time * u.speed * 0.5;

    // Orbiting camera
    let m = (u.mouse - 0.5) * 3.14159;
    let camDist = 2.8 / u.zoom;
    let camAng = t * 0.25 + u.twist + m.x;
    let camY = sin(t * 0.15 + m.y) * 1.2;
    let ro = vec3f(cos(camAng) * camDist, camY, sin(camAng) * camDist);
    let fwd = normalize(vec3f(0.0) - ro);
    let right = normalize(cross(vec3f(0, 1, 0), fwd));
    let up = cross(fwd, right);
    let rd = normalize(v.uv.x * asp * right + v.uv.y * up + fwd * 1.5);

    // Raymarch
    var d = 0.0;
    var hit = false;
    var steps = 0;
    for (var i = 0; i < 96; i = i + 1) {
      let rp = ro + rd * d;
      let sd = scene(rp, t) * u.seed;
      if (sd < 0.001) { hit = true; steps = i; break; }
      if (d > 12.0) { steps = i; break; }
      d += sd;
      steps = i;
    }

    if (!hit) {
      // Background: starfield + nebula
      let nebula = fract(sin(dot(rd.xy, vec2f(127.1, 311.7))) * 43758.5);
      let stars = step(0.997, nebula) * 2.0;
      let bgH = fract(rd.x * 0.3 + rd.y * 0.2 + u.hue + t * 0.02);
      let bg = hsv(bgH, 0.7, 0.04) + vec3f(stars * 0.6);
      return vec4f(bg, 1.0);
    }

    let hp = ro + rd * d;
    let n = getNormal(hp, t);

    // Two coloured lights + rim
    let l1 = normalize(vec3f(cos(t * 0.5), 0.8, sin(t * 0.5)));
    let l2 = normalize(vec3f(-cos(t * 0.3 + 1.0), -0.5, -sin(t * 0.3 + 1.0)));
    let diff1 = max(dot(n, l1), 0.0);
    let diff2 = max(dot(n, l2), 0.0);
    let rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    let ao = 1.0 - f32(steps) / 96.0;

    let h1 = fract(u.hue);
    let h2 = fract(u.hue + 0.33);
    let h3 = fract(u.hue + 0.66);
    var col = hsv(h1, 0.9, diff1 * 1.2) + hsv(h2, 0.8, diff2 * 0.8);
    col += hsv(h3, 1.0, rim * 1.5);
    col *= ao * 0.8 + 0.2;

    // Specular
    let refl = reflect(rd, n);
    let spec = pow(max(dot(refl, l1), 0.0), 32.0);
    col += vec3f(spec * 0.6);
    return vec4f(col, 1.0);
  }

;; ═══════════════════════════════════════════════════════════════════
;; DATA — uniform buffer driven by builtins + form state
;; ═══════════════════════════════════════════════════════════════════
@buffer params :struct Params :usage [uniform]
  @data
    :res   (canvas-size)
    :time  (elapsed)
    :mouse (mouse-pos)
    :seed  (form/seed)
    :zoom  (form/zoom)
    :twist (form/twist)
    :hue   (form/hue)
    :speed (form/speed)

;; ── Pipelines — one per mode, switchable via form/mode ──
@pipeline frac :vertex fractal    :fragment fractal    :format canvas :topology triangle-list
@pipeline mand :vertex mandelbrot :fragment mandelbrot :format canvas :topology triangle-list
@pipeline tun  :vertex tunnel     :fragment tunnel     :format canvas :topology triangle-list
@pipeline warp :vertex warp       :fragment warp       :format canvas :topology triangle-list

;; ── Render pass — pipeline selected dynamically from form ──
@pass main :clear [0.01 0.01 0.02 1]
  @draw :pipeline (form/mode) :vertices 6
    @bind 0 :buffer params

;; ═══════════════════════════════════════════════════════════════════
;; FORM — all controls
;; ═══════════════════════════════════════════════════════════════════
@form controls :title "Hypnosis Engine"
  @field mode  :type select :label "Mode"  :options [frac mand tun warp] :default frac
  @field speed :type range  :label "Speed" :min 0.05 :max 4    :step 0.01  :default 0.8
  @field zoom  :type range  :label "Zoom"  :min 0.3  :max 8    :step 0.01  :default 1.0
  @field twist :type range  :label "Twist" :min -3.14 :max 3.14 :step 0.01 :default 0.0
  @field hue   :type range  :label "Hue"   :min 0    :max 1    :step 0.005 :default 0.0
  @field seed  :type range  :label "Seed"  :min 0.1  :max 2.5  :step 0.01  :default 1.0

;; ── Scroll-to-zoom interaction ──
@interact :scroll zoom :scroll-scale 0.02

;; ═══════════════════════════════════════════════════════════════════
;; SURFACE — minimal HUD overlay
;; ═══════════════════════════════════════════════════════════════════
@panel hud :x 12 :y 12 :w 200 :h 32 :fill [0 0 0 0.6] :radius 6 :layout row :gap 8 :padding 8 :align center
  @text hud_title :size 12 :color [0.36 0.99 0.43 1]
    Hypnosis Engine
