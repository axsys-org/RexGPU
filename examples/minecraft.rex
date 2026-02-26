;; ═══════════════════════════════════════════════════════════════════
;; Minecraft voxel world — Rex Projection Engine
;; Drag canvas to look. Sliders to fly. Sun auto-rotates.
;; DDA raycast · procedural terrain · soft shadows · ACES tonemap
;; ═══════════════════════════════════════════════════════════════════

@struct Params
  @field time   :type f32
  @field res    :type f32x2
  @field px     :type f32
  @field py     :type f32
  @field pz     :type f32
  @field yaw    :type f32
  @field pitch  :type f32
  @field fov    :type f32
  @field fog    :type f32
  @field sunang :type f32

@lib mc_noise
  fn mc_h2(p2: vec2f) -> f32 {
    var qq = fract(p2 * vec2f(127.1, 311.7));
    qq += dot(qq, qq + 19.19);
    return fract(qq.x * qq.y);
  }
  fn mc_h3(p3: vec3f) -> f32 {
    var qq3 = fract(p3 * vec3f(127.1, 311.7, 74.7));
    qq3 += dot(qq3, qq3 + 19.19);
    return fract(qq3.x * qq3.y + qq3.z * 0.31);
  }
  fn mc_vn(pv: vec2f) -> f32 {
    let iv = floor(pv);
    let fv = fract(pv);
    let sv = fv * fv * (3.0 - 2.0 * fv);
    return mix(
      mix(mc_h2(iv), mc_h2(iv + vec2f(1,0)), sv.x),
      mix(mc_h2(iv + vec2f(0,1)), mc_h2(iv + vec2f(1,1)), sv.x),
      sv.y
    );
  }
  fn mc_fbm(pf: vec2f) -> f32 {
    var fv = 0.0; var fa = 0.5; var fq = pf;
    for (var fi = 0; fi < 5; fi++) { fv += fa * mc_vn(fq); fq *= 2.1; fa *= 0.5; }
    return fv;
  }
  fn mc_th(xz: vec2f) -> f32 {
    return mc_fbm(xz * 0.07) * 13.0 + mc_fbm(xz * 0.30) * 2.0 + 3.5;
  }

@shader mc
  #import Params
  #import mc_noise

  struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

  @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    var pts = array<vec2f,6>(
      vec2f(-1,-1), vec2f(1,-1), vec2f(-1,1),
      vec2f(-1,1),  vec2f(1,-1), vec2f(1,1)
    );
    var vo: VSOut;
    vo.pos = vec4f(pts[vi], 0.0, 1.0);
    vo.uv  = vec2f(pts[vi].x * 0.5 + 0.5, 0.5 - pts[vi].y * 0.5);
    return vo;
  }

  fn mc_camRay(yaw: f32, pitch: f32, fov: f32, uv: vec2f, res: vec2f) -> vec3f {
    let fwd   = vec3f(sin(yaw) * cos(pitch), sin(pitch), cos(yaw) * cos(pitch));
    let right = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)));
    let up    = cross(right, fwd);
    let dd    = (uv - 0.5) * vec2f(res.x / res.y, -1.0) * tan(fov * 0.5);
    return normalize(fwd + right * dd.x + up * dd.y);
  }

  // DDA voxel cast
  // Returns vec4(t, btype, normAxis, normSign)
  // btype: 0=sky  1=grass  2=dirt  3=stone  4=snow
  fn mc_cast(ro: vec3f, rd: vec3f) -> vec4f {
    var ip   = floor(ro);
    let sg   = sign(rd);
    let rinv = 1.0 / (abs(rd) + 0.00001);
    var tm   = (ip + select(vec3f(0.0), vec3f(1.0), rd > vec3f(0.0)) - ro) * rinv;
    let td   = rinv;
    var na   = 1.0;
    var ns   = 1.0;
    var rt   = 0.0;

    for (var ci = 0; ci < 160; ci++) {
      let bty = floor(mc_th(vec2f(ip.x, ip.z)));
      if (ip.y <= bty && ip.y >= -2.0) {
        let dep = bty - ip.y;
        var bt  = 1.0;
        if (dep > 3.0)      { bt = 3.0; }
        else if (dep > 1.0) { bt = 2.0; }
        if (bty > 14.5)     { bt = 4.0; }
        return vec4f(rt, bt, na, ns);
      }
      if (tm.x < tm.y && tm.x < tm.z) {
        rt = tm.x; ip.x += sg.x; na = 0.0; ns = -sg.x; tm.x += td.x;
      } else if (tm.y < tm.z) {
        rt = tm.y; ip.y += sg.y; na = 1.0; ns = -sg.y; tm.y += td.y;
      } else {
        rt = tm.z; ip.z += sg.z; na = 2.0; ns = -sg.z; tm.z += td.z;
      }
      if (rt > 100.0) { break; }
    }
    return vec4f(rt, 0.0, 1.0, 1.0);
  }

  fn mc_norm(na: f32, ns: f32) -> vec3f {
    if (na < 0.5)  { return vec3f(ns, 0.0, 0.0); }
    if (na < 1.5)  { return vec3f(0.0, ns, 0.0); }
    return vec3f(0.0, 0.0, ns);
  }

  fn mc_sky(rd: vec3f, sun: vec3f, tt: f32) -> vec3f {
    let yt   = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
    let sc   = mix(vec3f(0.56, 0.76, 0.99), vec3f(0.20, 0.44, 0.85), yt);
    let sdot = max(0.0, dot(rd, sun));
    let sdsk = pow(sdot, 260.0) * vec3f(2.0, 1.8, 1.2);
    let sgl  = pow(sdot, 10.0)  * vec3f(0.40, 0.22, 0.04);
    let cp   = rd.xz / (abs(rd.y) + 0.01) * 0.032 + vec2f(tt * 0.0025, 0.0);
    let cl   = smoothstep(0.40, 0.62, mc_vn(cp * 7.0) * 0.55 + mc_vn(cp * 19.0) * 0.25);
    return mix(sc, vec3f(1.0), cl * clamp(rd.y * 5.0, 0.0, 1.0)) + sdsk + sgl;
  }

  fn mc_block(bt: f32, wp: vec3f, bn: vec3f) -> vec3f {
    let jt = mc_h3(floor(wp)) * 0.07 - 0.035;
    if (bt < 1.5) {
      if (bn.y > 0.5) { return vec3f(0.28 + jt, 0.58 + jt, 0.16 + jt); }
      return mix(vec3f(0.28+jt, 0.58+jt, 0.16+jt), vec3f(0.50+jt, 0.36+jt, 0.20+jt), 0.72);
    }
    if (bt < 2.5) { return vec3f(0.51 + jt, 0.37 + jt, 0.21 + jt); }
    if (bt < 3.5) { return vec3f(0.42 + jt, 0.42 + jt, 0.42 + jt); }
    return vec3f(0.89 + jt, 0.92 + jt, 0.95 + jt);
  }

  @fragment fn fs_main(v: VSOut) -> @location(0) vec4f {
    let sun = normalize(vec3f(cos(u.sunang), 0.55, sin(u.sunang)));
    let ro  = vec3f(u.px, u.py, u.pz);
    let rd  = mc_camRay(u.yaw, u.pitch, u.fov, v.uv, u.res);
    let ray = mc_cast(ro, rd);
    let rt  = ray.x;
    let bt  = ray.y;
    let bn  = mc_norm(ray.z, ray.w);

    var col: vec3f;
    if (bt < 0.5) {
      col = mc_sky(rd, sun, u.time);
    } else {
      let wp   = ro + rd * rt;
      let base = mc_block(bt, wp, bn);
      let diff = clamp(dot(bn, sun), 0.0, 1.0);
      let ao   = mix(0.50, 1.0, clamp(dot(bn, vec3f(0.0, 1.0, 0.0)) * 0.5 + 0.5, 0.0, 1.0));
      let sh   = mc_cast(wp + bn * 0.02, sun);
      let shad = select(1.0, 0.28, sh.y > 0.5);
      let lit  = base * (diff * shad + 0.20) * ao * vec3f(1.08, 1.0, 0.90);
      let fa   = 1.0 - exp(-rt * rt * u.fog * 0.00032);
      col = mix(lit, mc_sky(rd, sun, u.time), fa);
    }

    // ACES filmic tonemap + gamma
    col = (col * (col + 0.0245786) - 0.000090537) / (col * (0.983729 * col + 0.4329510) + 0.238081);
    col = pow(clamp(col, vec3f(0.0), vec3f(1.0)), vec3f(0.4545));
    return vec4f(col, 1.0);
  }

@buffer p :struct Params :usage [uniform]
  @data
    :time   (elapsed)
    :res    (canvas-size)
    :px     (form/px)
    :py     (form/py)
    :pz     (form/pz)
    :yaw    (form/yaw)
    :pitch  (form/pitch)
    :fov    (form/fov)
    :fog    (form/fog)
    :sunang (mul (elapsed) 0.08)

@pipeline mc :vertex mc :fragment mc :format canvas :topology triangle-list :depth false

@pass main :clear [0.56 0.76 0.99 1]
  @draw :pipeline mc :vertices 6
    @bind 0 :buffer p

@form controls :title "Minecraft"
  @section pos :title "Position"
  @field px    :type range :label "X"     :default 8.0  :min -64 :max 64  :step 0.5
  @field py    :type range :label "Y"     :default 20.0 :min 4   :max 48  :step 0.5
  @field pz    :type range :label "Z"     :default 8.0  :min -64 :max 64  :step 0.5
  @section look :title "Look"
  @field yaw   :type range :label "Yaw"   :default 0.8  :min -3.14 :max 3.14 :step 0.005
  @field pitch :type range :label "Pitch" :default -0.55 :min -1.4 :max 1.4  :step 0.005
  @field fov   :type range :label "FOV"   :default 1.15 :min 0.5  :max 2.0  :step 0.05
  @section world :title "World"
  @field fog   :type range :label "Fog"   :default 1.2  :min 0.0  :max 5.0  :step 0.1
  @interact
    :drag-x yaw   :drag-x-scale 0.005 :drag-x-min -3.14 :drag-x-max 3.14
    :drag-y pitch :drag-y-scale 0.005 :drag-y-min -1.4  :drag-y-max 1.4

@panel hud :x 16 :y 16 :w 210 :h 56 :fill "#00000099" :radius 6 :layout column :gap 4 :padding 10
  @text t1 :size 13 :color "#5dfc6e"
    Minecraft · RPE
  @text t2 :size 10 :color "#aaaaaa"
    drag canvas to look · sliders to fly
