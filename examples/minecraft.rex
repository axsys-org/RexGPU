;; ═══════════════════════════════════════════════════════════════════
;; Minecraft voxel world — Rex Projection Engine
;; Click canvas to lock mouse · WASD move · Space jump · Esc = menu
;; DDA raycast · procedural terrain · gravity/jump · ACES tonemap
;; ═══════════════════════════════════════════════════════════════════

;; ── Per-frame inputs ──
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

;; ── Noise lib ──
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
    return mix(mix(mc_h2(iv),mc_h2(iv+vec2f(1,0)),sv.x),mix(mc_h2(iv+vec2f(0,1)),mc_h2(iv+vec2f(1,1)),sv.x),sv.y);
  }
  fn mc_fbm(pf: vec2f) -> f32 {
    var fval=0.0; var fa=0.5; var fq=pf;
    for(var fi=0;fi<4;fi++){fval+=fa*mc_vn(fq);fq*=2.1;fa*=0.5;}
    return fval;
  }
  fn mc_th(xz: vec2f) -> f32 {
    return mc_fbm(xz*0.07)*13.0 + mc_fbm(xz*0.30)*2.0 + 3.5;
  }

;; ── Compute: integrate camera physics each frame ──
;; @bind 0 = cam storage (group 0), @bind 1 = inp uniform (group 1)
@shader mc_integrate
  struct CamState { px:f32, py:f32, pz:f32, yaw:f32, pitch:f32, vy:f32, p0:f32, p1:f32 };
  struct Inputs {
    time:f32, dt:f32, res:vec2f, mdx:f32, mdy:f32,
    movex:f32, movey:f32, movez:f32, locked:f32,
    fov:f32, fog:f32, sunang:f32, menuopen:f32, pad0:f32, pad1:f32, pad2:f32
  };
  @group(0) @binding(0) var<storage, read_write> cam: CamState;
  @group(1) @binding(0) var<uniform> inp: Inputs;

  fn mc_th_c(xz: vec2f) -> f32 {
    var fval=0.0; var fa=0.5; var fq=xz*0.07;
    for(var fi=0;fi<4;fi++){
      let iv=floor(fq); let fv=fract(fq); let sv=fv*fv*(3.0-2.0*fv);
      var qa=fract(iv*vec2f(127.1,311.7)); qa+=dot(qa,qa+19.19);
      var qb=fract((iv+vec2f(1,0))*vec2f(127.1,311.7)); qb+=dot(qb,qb+19.19);
      var qc=fract((iv+vec2f(0,1))*vec2f(127.1,311.7)); qc+=dot(qc,qc+19.19);
      var qd=fract((iv+vec2f(1,1))*vec2f(127.1,311.7)); qd+=dot(qd,qd+19.19);
      fval+=fa*mix(mix(fract(qa.x*qa.y),fract(qb.x*qb.y),sv.x),mix(fract(qc.x*qc.y),fract(qd.x*qd.y),sv.x),sv.y);
      fq*=2.1; fa*=0.5;
    }
    var fval2=0.0; fa=0.5; fq=xz*0.30;
    for(var fi2=0;fi2<3;fi2++){
      let iv=floor(fq); let fv=fract(fq); let sv=fv*fv*(3.0-2.0*fv);
      var qa=fract(iv*vec2f(127.1,311.7)); qa+=dot(qa,qa+19.19);
      var qb=fract((iv+vec2f(1,0))*vec2f(127.1,311.7)); qb+=dot(qb,qb+19.19);
      var qc=fract((iv+vec2f(0,1))*vec2f(127.1,311.7)); qc+=dot(qc,qc+19.19);
      var qd=fract((iv+vec2f(1,1))*vec2f(127.1,311.7)); qd+=dot(qd,qd+19.19);
      fval2+=fa*mix(mix(fract(qa.x*qa.y),fract(qb.x*qb.y),sv.x),mix(fract(qc.x*qc.y),fract(qd.x*qd.y),sv.x),sv.y);
      fq*=2.1; fa*=0.5;
    }
    return fval*13.0 + fval2*2.0 + 3.5;
  }

  @compute @workgroup_size(1)
  fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
    let dt   = clamp(inp.dt, 0.0001, 0.05);
    let spd  = 5.0;
    let grav = 22.0;
    let jmpV = 9.0;
    let eyeH = 1.7;
    let stepH = 0.8;  // max step-up height (smooth slope traversal)

    if (inp.locked > 0.5 && inp.menuopen < 0.5) {
      cam.yaw   = cam.yaw + inp.mdx * 0.002;
      cam.pitch = clamp(cam.pitch - inp.mdy * 0.002, -1.48, 1.48);
      let cy=cos(cam.yaw); let sy=sin(cam.yaw);
      let dx = (sy*(-inp.movez) + cy*inp.movex) * spd * dt;
      let dz = (cy*(-inp.movez) - sy*inp.movex) * spd * dt;

      // Try full move; if new ground is too high to step up, slide axes
      let nx = cam.px + dx;
      let nz = cam.pz + dz;
      let curFloor = mc_th_c(vec2f(cam.px, cam.pz));
      let newFloor = mc_th_c(vec2f(nx, nz));
      if (newFloor - curFloor <= stepH || cam.vy > 0.1) {
        // Walkable step or airborne — accept full move
        cam.px = nx; cam.pz = nz;
      } else {
        // Try sliding on each axis separately
        let floorX = mc_th_c(vec2f(nx, cam.pz));
        let floorZ = mc_th_c(vec2f(cam.px, nz));
        if (floorX - curFloor <= stepH) { cam.px = nx; }
        else if (floorZ - curFloor <= stepH) { cam.pz = nz; }
        // else: completely blocked, no move
      }
    }

    let groundY = mc_th_c(vec2f(cam.px, cam.pz)) + eyeH;
    let onGround = cam.py <= groundY + 0.08;
    if (onGround) {
      // Smooth step-up: lerp toward ground level instead of snapping
      cam.py = mix(cam.py, groundY, clamp(dt * 18.0, 0.0, 1.0));
      if (inp.movey > 0.5 && inp.locked > 0.5 && inp.menuopen < 0.5) {
        cam.vy = jmpV;
        cam.py = groundY + 0.1;  // ensure airborne so gravity kicks in
      } else {
        cam.vy = 0.0;
      }
    } else {
      cam.vy = cam.vy - grav * dt;
      cam.py = cam.py + cam.vy * dt;
      // Hard floor clamp with vy reset
      if (cam.py < groundY) { cam.py = groundY; cam.vy = 0.0; }
    }
  }

;; ── Render shader ──
;; @bind 0 = inp uniform (group 0, auto injects u), @bind 1 = cam storage (group 1)
@shader mc
  #import Inputs
  #import mc_noise
  struct CamState { px:f32, py:f32, pz:f32, yaw:f32, pitch:f32, vy:f32, p0:f32, p1:f32 };
  @group(1) @binding(0) var<storage, read> cam: CamState;

  struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
  @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    var pts=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
    var vo: VSOut; vo.pos=vec4f(pts[vi],0,1); vo.uv=vec2f(pts[vi].x*.5+.5,.5-pts[vi].y*.5); return vo;
  }

  fn mc_camRay(yaw:f32,pitch:f32,fov:f32,uv:vec2f,res:vec2f)->vec3f{
    let fwd=vec3f(sin(yaw)*cos(pitch),sin(pitch),cos(yaw)*cos(pitch));
    let right=normalize(cross(fwd,vec3f(0,1,0))); let up=cross(right,fwd);
    let dd=(uv-0.5)*vec2f(res.x/res.y,-1.0)*tan(fov*0.5);
    return normalize(fwd+right*dd.x+up*dd.y);
  }

  fn mc_cast(ro:vec3f,rd:vec3f)->vec4f{
    var ip=floor(ro); let sg=sign(rd); let rinv=1.0/(abs(rd)+0.00001);
    var tm=(ip+select(vec3f(0),vec3f(1),rd>vec3f(0))-ro)*rinv;
    let td=rinv; var na=1.0; var ns=1.0; var rt=0.0;
    for(var ci=0;ci<96;ci++){
      let bty=floor(mc_th(vec2f(ip.x,ip.z)));
      if(ip.y<=bty&&ip.y>=-2.0){
        let dep=bty-ip.y; var bt=1.0;
        if(dep>3.0){bt=3.0;}else if(dep>1.0){bt=2.0;}
        if(bty>14.5){bt=4.0;}
        return vec4f(rt,bt,na,ns);
      }
      if(tm.x<tm.y&&tm.x<tm.z){rt=tm.x;ip.x+=sg.x;na=0.0;ns=-sg.x;tm.x+=td.x;}
      else if(tm.y<tm.z){rt=tm.y;ip.y+=sg.y;na=1.0;ns=-sg.y;tm.y+=td.y;}
      else{rt=tm.z;ip.z+=sg.z;na=2.0;ns=-sg.z;tm.z+=td.z;}
      if(rt>100.0){break;}
    }
    return vec4f(rt,0,1,1);
  }

  fn mc_norm(na:f32,ns:f32)->vec3f{
    if(na<0.5){return vec3f(ns,0,0);} if(na<1.5){return vec3f(0,ns,0);} return vec3f(0,0,ns);
  }

  fn mc_sky(rd:vec3f,sun:vec3f,tt:f32)->vec3f{
    let yt=clamp(rd.y*.5+.5,0,1);
    let sc=mix(vec3f(.56,.76,.99),vec3f(.20,.44,.85),yt);
    let sdot=max(0.0,dot(rd,sun));
    let sdsk=pow(sdot,260.0)*vec3f(2,1.8,1.2); let sgl=pow(sdot,10.0)*vec3f(.4,.22,.04);
    let cp=rd.xz/(abs(rd.y)+.01)*.032+vec2f(tt*.0025,0);
    let cl=smoothstep(.40,.62,mc_vn(cp*7.0)*.55+mc_vn(cp*19.0)*.25);
    return mix(sc,vec3f(1),cl*clamp(rd.y*5,0,1))+sdsk+sgl;
  }

  fn mc_block(bt:f32,wp:vec3f,bn:vec3f)->vec3f{
    let jt=mc_h3(floor(wp))*.07-.035;
    if(bt<1.5){if(bn.y>0.5){return vec3f(.28+jt,.58+jt,.16+jt);}
      return mix(vec3f(.28+jt,.58+jt,.16+jt),vec3f(.50+jt,.36+jt,.20+jt),.72);}
    if(bt<2.5){return vec3f(.51+jt,.37+jt,.21+jt);}
    if(bt<3.5){return vec3f(.42+jt,.42+jt,.42+jt);}
    return vec3f(.89+jt,.92+jt,.95+jt);
  }

  @fragment fn fs_main(v: VSOut) -> @location(0) vec4f {
    let sun=normalize(vec3f(cos(u.sunang),.55,sin(u.sunang)));
    let ro=vec3f(cam.px,cam.py,cam.pz);
    let rd=mc_camRay(cam.yaw,cam.pitch,u.fov,v.uv,u.res);
    let ray=mc_cast(ro,rd); let rt=ray.x; let bt=ray.y;
    let bn=mc_norm(ray.z,ray.w);
    var col: vec3f;
    if(bt<0.5){ col=mc_sky(rd,sun,u.time); }
    else {
      let wp=ro+rd*rt; let base=mc_block(bt,wp,bn);
      let diff=clamp(dot(bn,sun),0,1);
      let ao=mix(.50,1.0,clamp(dot(bn,vec3f(0,1,0))*.5+.5,0,1));
      let shray=mc_cast(wp+bn*.02,sun); let shad=select(1.0,.28,shray.y>0.5);
      let lit=base*(diff*shad+.20)*ao*vec3f(1.08,1,.90);
      let fa=1.0-exp(-rt*rt*u.fog*.00032);
      col=mix(lit,mc_sky(rd,sun,u.time),fa);
    }
    col=(col*(col+.0245786)-.000090537)/(col*(.983729*col+.4329510)+.238081);
    col=pow(clamp(col,vec3f(0),vec3f(1)),vec3f(.4545));
    return vec4f(col,1);
  }

;; ── Camera state — initialised above terrain at (8, 20, 8) facing slightly down ──
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

;; ── Per-frame uniform inputs ──
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

@pipeline mc_phys :compute mc_integrate :entry cs_main
@pipeline mc_rend :vertex mc :fragment mc :format canvas :topology triangle-list

@dispatch mc_step :pipeline mc_phys :grid [1 1 1]
  @bind 0 :storage cam_buf
  @bind 1 :buffer inp_buf

@pass main :clear [0.56 0.76 0.99 1]
  @draw :pipeline mc_rend :vertices 6
    @bind 0 :buffer inp_buf
    @bind 1 :storage cam_buf

@form controls :title "Minecraft"
  @field fov     :type range   :label "FOV" :default 1.15 :min 0.5 :max 2.0 :step 0.05
  @field fog     :type range   :label "Fog" :default 1.2  :min 0.0 :max 5.0 :step 0.1
  @field menuopen :type checkbox :label "menu" :default 1

;; ── Crosshair (only while playing) ──
@panel xhair :x (sub (mul (canvas-width) 0.5) 10) :y (sub (mul (canvas-height) 0.5) 10) :w 20 :h 20 :fill "#00000000"
  @rect ch_h :x 0 :y 9 :w 20 :h 2 :fill (if (eq (form/menuopen) 0) "#ffffffcc" "#00000000") :radius 1
  @rect ch_v :x 9 :y 0 :w 2  :h 20 :fill (if (eq (form/menuopen) 0) "#ffffffcc" "#00000000") :radius 1

;; ── HUD ──
@panel hud :x 12 :y 12 :w 200 :h 36 :fill "#00000099" :radius 6 :layout row :gap 8 :padding 10
  @text hud_t :size 12 :color "#5dfc6e"
    Minecraft · RPE

;; ── Menu / click-to-play overlay ──
@panel menu :x (sub (mul (canvas-width) 0.5) 150) :y (sub (mul (canvas-height) 0.5) 110) :w 300 :h 220 :fill (if (gt (form/menuopen) 0.5) "#111122ee" "#00000000") :radius 12 :layout column :gap 12 :padding 36
  @text menu_t :size 22 :color (if (gt (form/menuopen) 0.5) "#5dfc6eff" "#00000000") :align center
    Minecraft · RPE
  @text menu_s1 :size 14 :color (if (gt (form/menuopen) 0.5) "#ffffffff" "#00000000") :align center
    Click to play
  @text menu_s2 :size 11 :color (if (gt (form/menuopen) 0.5) "#aaaabaff" "#00000000") :align center
    WASD · Space jump · Esc menu
  @text menu_s3 :size 10 :color (if (gt (form/menuopen) 0.5) "#555566ff" "#00000000") :align center
    FOV / Fog sliders in panel
