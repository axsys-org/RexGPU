;; ═══════════════════════════════════════════════════════════════════
;; Minecraft voxel world — Rex Projection Engine
;; Click canvas to lock mouse · WASD move · Space jump · Esc menu
;; DDA raycast · procedural terrain · gravity/jump · ACES tonemap
;; ═══════════════════════════════════════════════════════════════════

;; ── Per-frame uniform inputs (16 × f32 = 64B, 256-padded) ──
@struct Inputs
  @field time    :type f32
  @field dt      :type f32
  @field res     :type f32x2
  @field mdx     :type f32
  @field mdy     :type f32
  @field movex   :type f32
  @field movey   :type f32
  @field movez   :type f32
  @field locked  :type f32
  @field fov     :type f32
  @field fog     :type f32
  @field sunang  :type f32
  @field menuopen :type f32
  @field pad0    :type f32
  @field pad1    :type f32
  @field pad2    :type f32

;; ── Noise library — shared by render shader via #import ──
@lib mc_noise
  fn mc_h2(pp: vec2f) -> f32 {
    var qq = fract(pp * vec2f(127.1, 311.7));
    qq += dot(qq, qq + 19.19);
    return fract(qq.x * qq.y);
  }
  fn mc_h3(pp: vec3f) -> f32 {
    var qq = fract(pp * vec3f(127.1, 311.7, 74.7));
    qq += dot(qq, qq + 19.19);
    return fract(qq.x * qq.y + qq.z * 0.31);
  }
  fn mc_vn(pv: vec2f) -> f32 {
    let iv = floor(pv); let fv = fract(pv);
    let sv = fv * fv * (3.0 - 2.0 * fv);
    return mix(
      mix(mc_h2(iv), mc_h2(iv + vec2f(1, 0)), sv.x),
      mix(mc_h2(iv + vec2f(0, 1)), mc_h2(iv + vec2f(1, 1)), sv.x),
      sv.y);
  }
  fn mc_fbm(pf: vec2f) -> f32 {
    var v = 0.0; var a = 0.5; var q = pf;
    for (var i = 0; i < 4; i++) { v += a * mc_vn(q); q *= 2.1; a *= 0.5; }
    return v;
  }
  fn mc_th(xz: vec2f) -> f32 {
    return mc_fbm(xz * 0.07) * 13.0 + mc_fbm(xz * 0.30) * 2.0 + 3.5;
  }

;; ═══════════════════════════════════════════════════════════════════
;; Compute: camera physics — gravity, jump, WASD, wall-slide
;; Group 0 = camera storage (read_write), Group 1 = per-frame uniforms
;; ═══════════════════════════════════════════════════════════════════
@shader mc_physics
  struct Cam { px:f32, py:f32, pz:f32, yaw:f32, pitch:f32, vy:f32, p0:f32, p1:f32 };
  struct Inp {
    time:f32, dt:f32, res:vec2f, mdx:f32, mdy:f32,
    movex:f32, movey:f32, movez:f32, locked:f32,
    fov:f32, fog:f32, sunang:f32, menuopen:f32, pad0:f32, pad1:f32, pad2:f32
  };
  @group(0) @binding(0) var<storage, read_write> cam: Cam;
  @group(1) @binding(0) var<uniform> inp: Inp;

  fn h2c(pp: vec2f) -> f32 {
    var qq = fract(pp * vec2f(127.1, 311.7));
    qq += dot(qq, qq + 19.19);
    return fract(qq.x * qq.y);
  }
  fn vnc(pv: vec2f) -> f32 {
    let iv = floor(pv); let fv = fract(pv);
    let sv = fv * fv * (3.0 - 2.0 * fv);
    return mix(
      mix(h2c(iv), h2c(iv + vec2f(1, 0)), sv.x),
      mix(h2c(iv + vec2f(0, 1)), h2c(iv + vec2f(1, 1)), sv.x), sv.y);
  }
  fn fbmc(pf: vec2f) -> f32 {
    var v = 0.0; var a = 0.5; var q = pf;
    for (var i = 0; i < 4; i++) { v += a * vnc(q); q *= 2.1; a *= 0.5; }
    return v;
  }
  fn terrain(xz: vec2f) -> f32 {
    return fbmc(xz * 0.07) * 13.0 + fbmc(xz * 0.30) * 2.0 + 3.5;
  }

  @compute @workgroup_size(1)
  fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
    let dt  = clamp(inp.dt, 0.0001, 0.05);
    let spd = 5.0;
    let g   = 22.0;
    let jv  = 9.0;
    let eye = 1.7;

    if (inp.locked > 0.5 && inp.menuopen < 0.5) {
      cam.yaw   += inp.mdx * 0.002;
      cam.pitch  = clamp(cam.pitch - inp.mdy * 0.002, -1.48, 1.48);
      let cy = cos(cam.yaw); let sy = sin(cam.yaw);
      let dx = (sy * (-inp.movez) + cy * inp.movex) * spd * dt;
      let dz = (cy * (-inp.movez) - sy * inp.movex) * spd * dt;
      let nx = cam.px + dx; let nz = cam.pz + dz;
      let cf = terrain(vec2f(cam.px, cam.pz));
      let nf = terrain(vec2f(nx, nz));
      if (nf - cf <= 0.8 || cam.vy > 0.1) {
        cam.px = nx; cam.pz = nz;
      } else {
        let fx = terrain(vec2f(nx, cam.pz));
        let fz = terrain(vec2f(cam.px, nz));
        if (fx - cf <= 0.8) { cam.px = nx; }
        else if (fz - cf <= 0.8) { cam.pz = nz; }
      }
    }

    let gy = terrain(vec2f(cam.px, cam.pz)) + eye;
    if (cam.py <= gy + 0.08) {
      cam.py = mix(cam.py, gy, clamp(dt * 18.0, 0.0, 1.0));
      if (inp.movey > 0.5 && inp.locked > 0.5 && inp.menuopen < 0.5) {
        cam.vy = jv; cam.py = gy + 0.1;
      } else { cam.vy = 0.0; }
    } else {
      cam.vy -= g * dt;
      cam.py += cam.vy * dt;
      if (cam.py < gy) { cam.py = gy; cam.vy = 0.0; }
    }
  }

;; ═══════════════════════════════════════════════════════════════════
;; Render: fullscreen DDA raycast with sky, terrain, shadows
;; Group 0 = uniform inputs (#import auto-binds), Group 1 = camera
;; ═══════════════════════════════════════════════════════════════════
@shader mc_render
  #import Inputs
  #import mc_noise
  struct Cam { px:f32, py:f32, pz:f32, yaw:f32, pitch:f32, vy:f32, p0:f32, p1:f32 };
  @group(1) @binding(0) var<storage, read> cam: Cam;

  struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
  @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    var pts = array<vec2f,6>(
      vec2f(-1,-1), vec2f(1,-1), vec2f(-1,1),
      vec2f(-1,1),  vec2f(1,-1), vec2f(1,1));
    var o: VSOut;
    o.pos = vec4f(pts[vi], 0, 1);
    o.uv = vec2f(pts[vi].x * 0.5 + 0.5, 0.5 - pts[vi].y * 0.5);
    return o;
  }

  fn cam_ray(yaw: f32, pitch: f32, fov: f32, uv: vec2f, res: vec2f) -> vec3f {
    let fwd = vec3f(sin(yaw) * cos(pitch), sin(pitch), cos(yaw) * cos(pitch));
    let rt = normalize(cross(fwd, vec3f(0, 1, 0)));
    let up = cross(rt, fwd);
    let d = (uv - 0.5) * vec2f(res.x / res.y, -1.0) * tan(fov * 0.5);
    return normalize(fwd + rt * d.x + up * d.y);
  }

  fn dda(ro: vec3f, rd: vec3f) -> vec4f {
    var ip = floor(ro);
    let sg = sign(rd);
    let ri = 1.0 / (abs(rd) + 1e-5);
    var tm = (ip + select(vec3f(0), vec3f(1), rd > vec3f(0)) - ro) * ri;
    let td = ri;
    var na = 1.0; var ns = 1.0; var t = 0.0;
    for (var i = 0; i < 128; i++) {
      let h = floor(mc_th(vec2f(ip.x, ip.z)));
      if (ip.y <= h && ip.y >= -2.0) {
        let dep = h - ip.y;
        var bt = 1.0;
        if (dep > 3.0) { bt = 3.0; } else if (dep > 1.0) { bt = 2.0; }
        if (h > 14.5) { bt = 4.0; }
        return vec4f(t, bt, na, ns);
      }
      if (tm.x < tm.y && tm.x < tm.z) {
        t = tm.x; ip.x += sg.x; na = 0.0; ns = -sg.x; tm.x += td.x;
      } else if (tm.y < tm.z) {
        t = tm.y; ip.y += sg.y; na = 1.0; ns = -sg.y; tm.y += td.y;
      } else {
        t = tm.z; ip.z += sg.z; na = 2.0; ns = -sg.z; tm.z += td.z;
      }
      if (t > 120.0) { break; }
    }
    return vec4f(t, 0, 1, 1);
  }

  fn get_normal(na: f32, ns: f32) -> vec3f {
    if (na < 0.5) { return vec3f(ns, 0, 0); }
    if (na < 1.5) { return vec3f(0, ns, 0); }
    return vec3f(0, 0, ns);
  }

  fn sky(rd: vec3f, sun: vec3f, tt: f32) -> vec3f {
    let yt = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
    let sc = mix(vec3f(0.56, 0.76, 0.99), vec3f(0.20, 0.44, 0.85), yt);
    let sd = max(0.0, dot(rd, sun));
    let disk = pow(sd, 260.0) * vec3f(2, 1.8, 1.2);
    let glow = pow(sd, 10.0) * vec3f(0.4, 0.22, 0.04);
    let cp = rd.xz / (abs(rd.y) + 0.01) * 0.032 + vec2f(tt * 0.0025, 0);
    let cl = smoothstep(0.40, 0.62, mc_vn(cp * 7.0) * 0.55 + mc_vn(cp * 19.0) * 0.25);
    return mix(sc, vec3f(1), cl * clamp(rd.y * 5.0, 0.0, 1.0)) + disk + glow;
  }

  fn block_color(bt: f32, wp: vec3f, n: vec3f) -> vec3f {
    let j = mc_h3(floor(wp)) * 0.07 - 0.035;
    if (bt < 1.5) {
      if (n.y > 0.5) { return vec3f(0.28 + j, 0.58 + j, 0.16 + j); }
      return mix(vec3f(0.28 + j, 0.58 + j, 0.16 + j), vec3f(0.50 + j, 0.36 + j, 0.20 + j), 0.72);
    }
    if (bt < 2.5) { return vec3f(0.51 + j, 0.37 + j, 0.21 + j); }
    if (bt < 3.5) { return vec3f(0.42 + j, 0.42 + j, 0.42 + j); }
    return vec3f(0.89 + j, 0.92 + j, 0.95 + j);
  }

  @fragment fn fs_main(v: VSOut) -> @location(0) vec4f {
    let sun = normalize(vec3f(cos(u.sunang), 0.55, sin(u.sunang)));
    let ro = vec3f(cam.px, cam.py, cam.pz);
    let rd = cam_ray(cam.yaw, cam.pitch, u.fov, v.uv, u.res);
    let ray = dda(ro, rd);

    var col: vec3f;
    if (ray.y < 0.5) {
      col = sky(rd, sun, u.time);
    } else {
      let wp = ro + rd * ray.x;
      let n = get_normal(ray.z, ray.w);
      let base = block_color(ray.y, wp, n);
      let diff = clamp(dot(n, sun), 0.0, 1.0);
      let ao = mix(0.50, 1.0, clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
      let sh = dda(wp + n * 0.02, sun);
      let shadow = select(1.0, 0.28, sh.y > 0.5);
      let lit = base * (diff * shadow + 0.20) * ao * vec3f(1.08, 1, 0.90);
      let fog = 1.0 - exp(-ray.x * ray.x * u.fog * 0.00032);
      col = mix(lit, sky(rd, sun, u.time), fog);
    }

    col = (col * (col + 0.0245786) - 0.000090537) / (col * (0.983729 * col + 0.4329510) + 0.238081);
    col = pow(clamp(col, vec3f(0), vec3f(1)), vec3f(0.4545));
    return vec4f(col, 1);
  }

;; ═══════════════════════════════════════════════════════════════════
;; DATA
;; ═══════════════════════════════════════════════════════════════════

;; Camera state — storage buffer (8 × f32 = 32B)
;; Spawns at (8, 20, 8) looking roughly south-east
@buffer cam_buf :usage [storage] :size 32
  @data
    :f0 8
    :f1 20
    :f2 8
    :f3 0.8
    :f4 -0.3
    :f5 0
    :f6 0
    :f7 0

;; Per-frame uniform inputs — builtins + form state
@buffer inp_buf :struct Inputs :usage [uniform]
  @data
    :time    (elapsed)
    :dt      (frame-dt)
    :res     (canvas-size)
    :mdx     (mouse-dx)
    :mdy     (mouse-dy)
    :movex   (move-x)
    :movey   (move-y)
    :movez   (move-z)
    :locked  (pointer-locked)
    :fov     (form/fov)
    :fog     (form/fog)
    :sunang  (mul (elapsed) 0.08)
    :menuopen (form/menuopen)
    :pad0    0
    :pad1    0
    :pad2    0

;; ═══════════════════════════════════════════════════════════════════
;; PIPELINES + COMMANDS
;; ═══════════════════════════════════════════════════════════════════

@pipeline p_phys :compute mc_physics :entry cs_main
@pipeline p_rend :vertex mc_render :fragment mc_render :format canvas :topology triangle-list

;; Compute: integrate camera each frame
@dispatch d_phys :pipeline p_phys :grid [1 1 1]
  @bind 0 :storage cam_buf
  @bind 1 :buffer inp_buf

;; Render: fullscreen raycast
@pass main :clear [0.56 0.76 0.99 1]
  @draw :pipeline p_rend :vertices 6
    @bind 0 :buffer inp_buf
    @bind 1 :storage cam_buf

;; ═══════════════════════════════════════════════════════════════════
;; FORM
;; ═══════════════════════════════════════════════════════════════════
@form controls :title "Minecraft"
  @field fov      :type range    :label "FOV"  :default 1.15 :min 0.5 :max 2.0 :step 0.05
  @field fog      :type range    :label "Fog"  :default 1.2  :min 0.0 :max 5.0 :step 0.1
  @field menuopen :type checkbox :label "Menu" :default 1

;; ═══════════════════════════════════════════════════════════════════
;; SURFACE — HUD + crosshair + menu overlay
;; ═══════════════════════════════════════════════════════════════════

;; Crosshair
@panel xhair :x (sub (mul (canvas-width) 0.5) 10) :y (sub (mul (canvas-height) 0.5) 10) :w 20 :h 20
  @rect ch_h :x 0 :y 9 :w 20 :h 2 :fill (if (eq (form/menuopen) 0) [1 1 1 0.8] [0 0 0 0]) :radius 1
  @rect ch_v :x 9 :y 0 :w 2  :h 20 :fill (if (eq (form/menuopen) 0) [1 1 1 0.8] [0 0 0 0]) :radius 1

;; HUD
@panel hud :x 12 :y 12 :w 200 :h 36 :fill [0 0 0 0.6] :radius 6 :layout row :gap 8 :padding 10 :align center
  @text hud_t :size 12 :color [0.36 0.99 0.43 1]
    Minecraft · RPE

;; Menu overlay
@panel menu :x (sub (mul (canvas-width) 0.5) 150) :y (sub (mul (canvas-height) 0.5) 110) :w 300 :h 220 :fill (if (gt (form/menuopen) 0.5) [0.067 0.067 0.133 0.93] [0 0 0 0]) :radius 12 :layout column :gap 12 :padding 36
  @text menu_t :size 22 :color (if (gt (form/menuopen) 0.5) [0.36 0.99 0.43 1] [0 0 0 0]) :align center
    Minecraft · RPE
  @text menu_s1 :size 14 :color (if (gt (form/menuopen) 0.5) [1 1 1 1] [0 0 0 0]) :align center
    Click to play
  @text menu_s2 :size 11 :color (if (gt (form/menuopen) 0.5) [0.67 0.67 0.73 1] [0 0 0 0]) :align center
    WASD · Space jump · Esc menu
  @text menu_s3 :size 10 :color (if (gt (form/menuopen) 0.5) [0.33 0.33 0.4 1] [0 0 0 0]) :align center
    FOV / Fog sliders in panel
