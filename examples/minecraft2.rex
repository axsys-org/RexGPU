;; ═══════════════════════════════════════════════════════════════════
;; Minecraft 2 — Rex Projection Engine
;; Voxelized world · AABB collision · AO · caves · biomes · sprint
;; Click canvas to lock mouse · WASD move · Space jump · Shift sneak
;; Esc menu · E toggle sprint
;; ═══════════════════════════════════════════════════════════════════

;; ── Uniform inputs (20 × f32 = 80B, padded to 256) ──
@struct MC2Inp
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
  @field sprint  :type f32
  @field sneak   :type f32
  @field drawdist :type f32
  @field pad0    :type f32
  @field pad1    :type f32
  @field pad2    :type f32

;; ═══════════════════════════════════════════════════════════════════
;; NOISE LIBRARY — shared across all shaders
;; ═══════════════════════════════════════════════════════════════════
@lib mc2_noise
  fn mc2_h1(n: f32) -> f32 { return fract(sin(n * 127.1) * 43758.5453); }
  fn mc2_h2(p: vec2f) -> f32 {
    var q = fract(p * vec2f(127.1, 311.7));
    q += dot(q, q + 19.19);
    return fract(q.x * q.y);
  }
  fn mc2_h3(p: vec3f) -> f32 {
    var q = fract(p * vec3f(127.1, 311.7, 74.7));
    q += dot(q, q + 19.19);
    return fract(q.x * q.y + q.z * 0.31);
  }
  fn mc2_vn2(p: vec2f) -> f32 {
    let i = floor(p); let f = fract(p);
    let s = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mc2_h2(i), mc2_h2(i + vec2f(1, 0)), s.x),
      mix(mc2_h2(i + vec2f(0, 1)), mc2_h2(i + vec2f(1, 1)), s.x), s.y);
  }
  fn mc2_vn3(p: vec3f) -> f32 {
    let i = floor(p); let f = fract(p);
    let s = f * f * (3.0 - 2.0 * f);
    let a = mc2_h3(i);
    let b = mc2_h3(i + vec3f(1, 0, 0));
    let c = mc2_h3(i + vec3f(0, 1, 0));
    let d = mc2_h3(i + vec3f(1, 1, 0));
    let e = mc2_h3(i + vec3f(0, 0, 1));
    let ff = mc2_h3(i + vec3f(1, 0, 1));
    let g = mc2_h3(i + vec3f(0, 1, 1));
    let h = mc2_h3(i + vec3f(1, 1, 1));
    return mix(
      mix(mix(a, b, s.x), mix(c, d, s.x), s.y),
      mix(mix(e, ff, s.x), mix(g, h, s.x), s.y), s.z);
  }
  fn mc2_fbm2(p: vec2f) -> f32 {
    var v = 0.0; var a = 0.5; var q = p;
    for (var i = 0; i < 5; i++) { v += a * mc2_vn2(q); q *= 2.07; a *= 0.48; }
    return v;
  }
  fn mc2_fbm3(p: vec3f) -> f32 {
    var v = 0.0; var a = 0.5; var q = p;
    for (var i = 0; i < 4; i++) { v += a * mc2_vn3(q); q *= 2.03; a *= 0.5; }
    return v;
  }

;; ═══════════════════════════════════════════════════════════════════
;; TERRAIN GENERATION — fills 128×64×128 voxel grid once
;; Runs at frame 0, workgroup per column (128×128 = 16384 dispatches)
;; Block types: 0=air, 1=grass, 2=dirt, 3=stone, 4=sand, 5=water,
;;              6=coal, 7=iron, 8=gold, 9=diamond, 10=bedrock,
;;              11=wood, 12=leaves, 13=snow, 14=gravel
;; ═══════════════════════════════════════════════════════════════════
@shader mc2_terrain
  #import mc2_noise
  struct Inp {
    time:f32, dt:f32, res:vec2f, mdx:f32, mdy:f32,
    movex:f32, movey:f32, movez:f32, locked:f32,
    fov:f32, fog:f32, sunang:f32, menuopen:f32,
    sprint:f32, sneak:f32, drawdist:f32, pad0:f32, pad1:f32, pad2:f32
  };
  @group(0) @binding(0) var<storage, read_write> world: array<u32>;
  @group(0) @binding(1) var<storage, read_write> flags: array<u32>;
  @group(1) @binding(0) var<uniform> inp: Inp;

  const WX: u32 = 128u;
  const WY: u32 = 64u;
  const WZ: u32 = 128u;

  fn idx(x: u32, y: u32, z: u32) -> u32 { return x + y * WX + z * WX * WY; }

  fn terrain_h(xf: f32, zf: f32) -> f32 {
    let base = mc2_fbm2(vec2f(xf, zf) * 0.025) * 20.0;
    let detail = mc2_fbm2(vec2f(xf, zf) * 0.12) * 4.0;
    let plateau = smoothstep(0.48, 0.55, mc2_vn2(vec2f(xf, zf) * 0.008)) * 12.0;
    return base + detail + plateau + 16.0;
  }

  fn biome(xf: f32, zf: f32) -> f32 {
    return mc2_vn2(vec2f(xf, zf) * 0.005);
  }

  @compute @workgroup_size(1)
  fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
    // Skip if already generated
    if (flags[0] > 0u) { return; }
    let x = gid.x;
    let z = gid.y;
    if (x >= WX || z >= WZ) { return; }

    let xf = f32(x); let zf = f32(z);
    let h = terrain_h(xf, zf);
    let hi = u32(clamp(h, 0.0, f32(WY - 1u)));
    let bio = biome(xf, zf);
    let water_level = 18u;

    for (var y = 0u; y < WY; y++) {
      var bt = 0u;

      if (y == 0u) {
        bt = 10u; // bedrock
      } else if (y <= hi) {
        let depth = hi - y;
        let cave = mc2_fbm3(vec3f(xf * 0.08, f32(y) * 0.1, zf * 0.08));
        let cave2 = mc2_vn3(vec3f(xf * 0.15, f32(y) * 0.15, zf * 0.15));
        let cave_mask = cave * 0.6 + cave2 * 0.4;

        // Cave carving — wider caves lower, narrow tunnels higher
        let cave_threshold = 0.52 + f32(y) * 0.003;
        if (cave_mask > cave_threshold && y > 2u && depth > 1u) {
          // Air (cave)
          if (y <= water_level) { bt = 5u; } // water fills caves below water level
          else { bt = 0u; }
        } else if (depth == 0u) {
          // Surface block
          if (bio < 0.25) {
            // Desert biome
            if (h < f32(water_level) + 2.0) { bt = 4u; } else { bt = 4u; }
          } else if (bio > 0.75 && h > 30.0) {
            bt = 13u; // Snow biome
          } else {
            bt = 1u; // Grass
          }
        } else if (depth <= 3u) {
          if (bio < 0.25) { bt = 4u; } // Sand subsurface
          else { bt = 2u; } // Dirt
        } else {
          bt = 3u; // Stone
          // Ore generation
          let ore_n = mc2_h3(vec3f(xf * 0.5, f32(y) * 0.5, zf * 0.5));
          if (y < 12u && ore_n > 0.97) { bt = 9u; }       // Diamond (deep, rare)
          else if (y < 20u && ore_n > 0.94) { bt = 8u; }  // Gold
          else if (y < 40u && ore_n > 0.90) { bt = 7u; }  // Iron
          else if (y < 50u && ore_n > 0.87) { bt = 6u; }  // Coal
          if (y < 6u && mc2_h3(vec3f(xf, f32(y), zf) * 0.3) > 0.85) { bt = 14u; } // Gravel
        }
      } else if (y <= water_level) {
        bt = 5u; // Water above terrain
      }

      // Trees — only on grass surface, not desert or snow
      if (bt == 0u && y == hi + 1u && bio >= 0.25 && bio <= 0.75) {
        let tree_chance = mc2_h2(vec2f(xf * 7.3, zf * 13.1));
        if (tree_chance > 0.96 && x > 3u && x < WX - 4u && z > 3u && z < WZ - 4u) {
          // Tree trunk at this column
          if (y <= hi + 5u) { bt = 11u; }
        }
      }
      // Tree trunk continuation (check if we started a trunk below)
      if (bt == 0u && y > hi + 1u && y <= hi + 5u && bio >= 0.25 && bio <= 0.75) {
        let tree_chance = mc2_h2(vec2f(xf * 7.3, zf * 13.1));
        if (tree_chance > 0.96 && x > 3u && x < WX - 4u && z > 3u && z < WZ - 4u) {
          bt = 11u;
        }
      }
      // Leaves around tree tops
      if (bt == 0u && y >= hi + 4u && y <= hi + 7u && bio >= 0.25 && bio <= 0.75) {
        // Check nearby columns for tree trunks
        for (var dx = -2; dx <= 2; dx++) {
          for (var dz = -2; dz <= 2; dz++) {
            let nx = i32(x) + dx; let nz = i32(z) + dz;
            if (nx >= 0 && nx < i32(WX) && nz >= 0 && nz < i32(WZ)) {
              let nxf = f32(nx); let nzf = f32(nz);
              let nh = terrain_h(nxf, nzf);
              let nhi = u32(clamp(nh, 0.0, f32(WY - 1u)));
              let nb = biome(nxf, nzf);
              let tc = mc2_h2(vec2f(nxf * 7.3, nzf * 13.1));
              if (tc > 0.96 && nb >= 0.25 && nb <= 0.75) {
                let dist = abs(dx) + abs(dz);
                let leaf_h = i32(y) - i32(nhi) - 4;
                if (leaf_h >= 0 && leaf_h <= 3 && dist <= 2 + select(0, -1, leaf_h > 2)) {
                  bt = 12u;
                }
              }
            }
          }
        }
      }

      world[idx(x, y, z)] = bt;
    }
    // Mark terrain as generated (every workgroup sets this; harmless race)
    flags[0] = 1u;
  }

;; ═══════════════════════════════════════════════════════════════════
;; PHYSICS — proper AABB collision against voxel grid
;; Player bounding box: 0.6 wide × 1.8 tall × 0.6 deep
;; ═══════════════════════════════════════════════════════════════════
@shader mc2_physics
  #import mc2_noise
  struct Cam {
    px:f32, py:f32, pz:f32, yaw:f32, pitch:f32, vy:f32,
    onground:f32, init:f32, bobphase:f32, bobamp:f32,
    sprint_state:f32, pad0:f32, pad1:f32, pad2:f32, pad3:f32, pad4:f32
  };
  struct Inp {
    time:f32, dt:f32, res:vec2f, mdx:f32, mdy:f32,
    movex:f32, movey:f32, movez:f32, locked:f32,
    fov:f32, fog:f32, sunang:f32, menuopen:f32,
    sprint:f32, sneak:f32, drawdist:f32, pad0:f32, pad1:f32, pad2:f32
  };
  @group(0) @binding(0) var<storage, read_write> cam: Cam;
  @group(0) @binding(1) var<storage, read> world: array<u32>;
  @group(1) @binding(0) var<uniform> inp: Inp;

  const WX: u32 = 128u;
  const WY: u32 = 64u;
  const WZ: u32 = 128u;
  const PW: f32 = 0.6;   // player width
  const PH: f32 = 1.8;   // player height
  const EYE: f32 = 1.62; // eye height

  fn idx(x: u32, y: u32, z: u32) -> u32 { return x + y * WX + z * WX * WY; }

  fn is_solid(x: i32, y: i32, z: i32) -> bool {
    if (x < 0 || x >= i32(WX) || y < 0 || y >= i32(WY) || z < 0 || z >= i32(WZ)) { return true; }
    let bt = world[idx(u32(x), u32(y), u32(z))];
    return bt != 0u && bt != 5u; // air and water are non-solid
  }

  // AABB vs voxel grid — test player box at position (px,py,pz) feet
  fn collides(px: f32, py: f32, pz: f32) -> bool {
    let hw = PW * 0.5;
    let x0 = i32(floor(px - hw)); let x1 = i32(floor(px + hw));
    let y0 = i32(floor(py));       let y1 = i32(floor(py + PH - 0.01));
    let z0 = i32(floor(pz - hw)); let z1 = i32(floor(pz + hw));
    for (var ix = x0; ix <= x1; ix++) {
      for (var iy = y0; iy <= y1; iy++) {
        for (var iz = z0; iz <= z1; iz++) {
          if (is_solid(ix, iy, iz)) { return true; }
        }
      }
    }
    return false;
  }

  fn terrain_h(xf: f32, zf: f32) -> f32 {
    let base = mc2_fbm2(vec2f(xf, zf) * 0.025) * 20.0;
    let detail = mc2_fbm2(vec2f(xf, zf) * 0.12) * 4.0;
    let plateau = smoothstep(0.48, 0.55, mc2_vn2(vec2f(xf, zf) * 0.008)) * 12.0;
    return base + detail + plateau + 16.0;
  }

  @compute @workgroup_size(1)
  fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
    let dt = clamp(inp.dt, 0.0001, 0.05);

    // Initialize camera position on first frame
    if (cam.init < 0.5) {
      let spawn_h = terrain_h(64.0, 64.0);
      cam.px = 64.0;
      cam.py = spawn_h + 1.0;
      cam.pz = 64.0;
      cam.yaw = 0.8;
      cam.pitch = -0.15;
      cam.vy = 0.0;
      cam.onground = 1.0;
      cam.init = 1.0;
      cam.bobphase = 0.0;
      cam.bobamp = 0.0;
      cam.sprint_state = 0.0;
      return;
    }

    // Sprint — hold E while moving forward
    let is_sprinting = inp.sprint > 0.5 && inp.movez < -0.1;
    cam.sprint_state = select(0.0, 1.0, is_sprinting);
    let base_spd = select(4.3, 5.6, is_sprinting);
    let sneak_spd = 1.3;
    let spd = select(base_spd, sneak_spd, inp.sneak > 0.5);
    let g = 28.0;
    let jv = 8.5;

    // Mouse look
    if (inp.locked > 0.5 && inp.menuopen < 0.5) {
      cam.yaw += inp.mdx * 0.002;
      cam.pitch = clamp(cam.pitch - inp.mdy * 0.002, -1.50, 1.50);
    }

    // Movement
    if (inp.locked > 0.5 && inp.menuopen < 0.5) {
      let cy = cos(cam.yaw); let sy = sin(cam.yaw);
      let dx = (sy * (-inp.movez) + cy * inp.movex) * spd * dt;
      let dz = (cy * (-inp.movez) - sy * inp.movex) * spd * dt;

      // Separate axis collision (wall sliding)
      let sneak_edge = inp.sneak > 0.5 && cam.onground > 0.5;

      // X axis
      var nx = cam.px + dx;
      if (!collides(nx, cam.py, cam.pz)) {
        // Sneak edge detection — don't walk off edges
        if (sneak_edge) {
          let below = collides(nx, cam.py - 0.5, cam.pz);
          if (below) { cam.px = nx; }
        } else {
          cam.px = nx;
        }
      } else {
        // Try step up (0.5 block step)
        if (cam.onground > 0.5 && !collides(nx, cam.py + 0.6, cam.pz)) {
          cam.px = nx;
          cam.py += 0.6;
          cam.vy = 0.0;
        }
      }

      // Z axis
      var nz = cam.pz + dz;
      if (!collides(cam.px, cam.py, nz)) {
        if (sneak_edge) {
          let below = collides(cam.px, cam.py - 0.5, nz);
          if (below) { cam.pz = nz; }
        } else {
          cam.pz = nz;
        }
      } else {
        if (cam.onground > 0.5 && !collides(cam.px, cam.py + 0.6, nz)) {
          cam.pz = nz;
          cam.py += 0.6;
          cam.vy = 0.0;
        }
      }
    }

    // Gravity + jump
    cam.vy -= g * dt;
    var ny = cam.py + cam.vy * dt;

    if (cam.vy < 0.0 && collides(cam.px, ny, cam.pz)) {
      // Falling — land on surface
      ny = floor(cam.py) + 0.001;
      // Find exact ground
      for (var step = 0; step < 4; step++) {
        if (!collides(cam.px, ny, cam.pz)) { break; }
        ny += 1.0;
      }
      cam.vy = 0.0;
      cam.onground = 1.0;
    } else if (cam.vy > 0.0 && collides(cam.px, ny, cam.pz)) {
      // Head bump
      cam.vy = 0.0;
      ny = cam.py;
    } else {
      if (cam.vy < -0.1) { cam.onground = 0.0; }
    }
    cam.py = ny;

    // Jump
    if (inp.movey > 0.5 && inp.locked > 0.5 && inp.menuopen < 0.5 && cam.onground > 0.5) {
      cam.vy = jv;
      cam.onground = 0.0;
    }

    // Head bob
    let moving = abs(inp.movex) + abs(inp.movez);
    if (moving > 0.1 && cam.onground > 0.5) {
      let bob_freq = select(8.0, 10.5, is_sprinting);
      cam.bobphase += dt * bob_freq;
      cam.bobamp = mix(cam.bobamp, select(0.04, 0.065, is_sprinting), dt * 12.0);
    } else {
      cam.bobamp = mix(cam.bobamp, 0.0, dt * 8.0);
    }

    // Clamp to world bounds
    cam.px = clamp(cam.px, 1.5, f32(WX) - 1.5);
    cam.pz = clamp(cam.pz, 1.5, f32(WZ) - 1.5);
    cam.py = clamp(cam.py, 1.0, f32(WY) - 2.0);
  }

;; ═══════════════════════════════════════════════════════════════════
;; RENDER — DDA raycast through voxel grid with AO + block colors
;; ═══════════════════════════════════════════════════════════════════
@shader mc2_render
  #import mc2_noise
  struct MC2Inp {
    time:f32, dt:f32, res:vec2f, mdx:f32, mdy:f32,
    movex:f32, movey:f32, movez:f32, locked:f32,
    fov:f32, fog:f32, sunang:f32, menuopen:f32,
    sprint:f32, sneak:f32, drawdist:f32, pad0:f32, pad1:f32, pad2:f32
  };
  @group(0) @binding(0) var<uniform> u: MC2Inp;
  struct Cam {
    px:f32, py:f32, pz:f32, yaw:f32, pitch:f32, vy:f32,
    onground:f32, init:f32, bobphase:f32, bobamp:f32,
    sprint_state:f32, pad0:f32, pad1:f32, pad2:f32, pad3:f32, pad4:f32
  };
  @group(1) @binding(0) var<storage, read> cam: Cam;
  @group(1) @binding(1) var<storage, read> world: array<u32>;

  const WX: u32 = 128u;
  const WY: u32 = 64u;
  const WZ: u32 = 128u;

  fn vidx(x: u32, y: u32, z: u32) -> u32 { return x + y * WX + z * WX * WY; }

  fn get_block(x: i32, y: i32, z: i32) -> u32 {
    if (x < 0 || x >= i32(WX) || y < 0 || y >= i32(WY) || z < 0 || z >= i32(WZ)) { return 0u; }
    return world[vidx(u32(x), u32(y), u32(z))];
  }

  fn is_opaque(x: i32, y: i32, z: i32) -> bool {
    let b = get_block(x, y, z);
    return b != 0u && b != 5u;
  }

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

  fn cam_ray(yaw: f32, pitch: f32, fov_val: f32, uv: vec2f, res: vec2f) -> vec3f {
    let fwd = vec3f(sin(yaw) * cos(pitch), sin(pitch), cos(yaw) * cos(pitch));
    let rt = normalize(cross(fwd, vec3f(0, 1, 0)));
    let up = cross(rt, fwd);
    let d = (uv - 0.5) * vec2f(res.x / res.y, -1.0) * tan(fov_val * 0.5);
    return normalize(fwd + rt * d.x + up * d.y);
  }

  // DDA through voxel grid
  fn dda(ro: vec3f, rd: vec3f, max_dist: f32) -> vec4f {
    // Clamp ray origin into grid bounds
    if (ro.x < 0.0 || ro.x >= f32(WX) || ro.y < 0.0 || ro.y >= f32(WY) || ro.z < 0.0 || ro.z >= f32(WZ)) {
      return vec4f(max_dist, 0, 0, 0);
    }
    var ip = floor(ro);
    let sg = sign(rd);
    let ri = 1.0 / (abs(rd) + 1e-6);
    var tm = (ip + select(vec3f(0), vec3f(1), rd > vec3f(0)) - ro) * ri;
    let td = ri;
    var na = 1.0; var ns = 1.0; var t = 0.0;

    for (var i = 0; i < 192; i++) {
      let ix = i32(ip.x); let iy = i32(ip.y); let iz = i32(ip.z);
      if (ix < 0 || ix >= i32(WX) || iy < 0 || iy >= i32(WY) || iz < 0 || iz >= i32(WZ)) { break; }
      let bt = get_block(ix, iy, iz);
      if (bt > 0u && bt != 5u) {
        return vec4f(t, f32(bt), na, ns);
      }
      // Water — semi-transparent, only report if nothing else behind
      if (bt == 5u) {
        // Skip water for now, render as tinted
      }
      if (tm.x < tm.y && tm.x < tm.z) {
        t = tm.x; ip.x += sg.x; na = 0.0; ns = -sg.x; tm.x += td.x;
      } else if (tm.y < tm.z) {
        t = tm.y; ip.y += sg.y; na = 1.0; ns = -sg.y; tm.y += td.y;
      } else {
        t = tm.z; ip.z += sg.z; na = 2.0; ns = -sg.z; tm.z += td.z;
      }
      if (t > max_dist) { break; }
    }
    return vec4f(t, 0, 1, 1);
  }

  // Water DDA — detect water separately for underwater tint
  fn dda_water(ro: vec3f, rd: vec3f, max_dist: f32) -> f32 {
    if (ro.x < 0.0 || ro.x >= f32(WX) || ro.y < 0.0 || ro.y >= f32(WY) || ro.z < 0.0 || ro.z >= f32(WZ)) {
      return max_dist;
    }
    var ip = floor(ro);
    let sg = sign(rd);
    let ri = 1.0 / (abs(rd) + 1e-6);
    var tm = (ip + select(vec3f(0), vec3f(1), rd > vec3f(0)) - ro) * ri;
    let td = ri;
    var t = 0.0;
    for (var i = 0; i < 64; i++) {
      let ix = i32(ip.x); let iy = i32(ip.y); let iz = i32(ip.z);
      if (ix < 0 || ix >= i32(WX) || iy < 0 || iy >= i32(WY) || iz < 0 || iz >= i32(WZ)) { break; }
      if (get_block(ix, iy, iz) == 5u) { return t; }
      if (tm.x < tm.y && tm.x < tm.z) {
        t = tm.x; ip.x += sg.x; tm.x += td.x;
      } else if (tm.y < tm.z) {
        t = tm.y; ip.y += sg.y; tm.y += td.y;
      } else {
        t = tm.z; ip.z += sg.z; tm.z += td.z;
      }
      if (t > max_dist) { break; }
    }
    return max_dist;
  }

  fn get_normal(na: f32, ns: f32) -> vec3f {
    if (na < 0.5) { return vec3f(ns, 0, 0); }
    if (na < 1.5) { return vec3f(0, ns, 0); }
    return vec3f(0, 0, ns);
  }

  // Ambient occlusion per voxel face — sample 4 neighbors
  fn calc_ao(wp: vec3f, n: vec3f) -> f32 {
    let ip = vec3i(floor(wp - n * 0.01));
    var occ = 0.0;
    let t1 = vec3i(select(vec3f(1, 0, 0), select(vec3f(0, 0, 1), vec3f(1, 0, 0), abs(n.x) > 0.5), abs(n.z) > 0.5));
    let t2 = vec3i(select(vec3f(0, 1, 0), select(vec3f(0, 1, 0), vec3f(0, 0, 1), abs(n.y) > 0.5), abs(n.z) > 0.5));
    let ni = vec3i(n);
    // Check 4 edge neighbors + 4 corner neighbors
    let s1 = select(0.0, 1.0, is_opaque(ip.x + ni.x + t1.x, ip.y + ni.y + t1.y, ip.z + ni.z + t1.z));
    let s2 = select(0.0, 1.0, is_opaque(ip.x + ni.x - t1.x, ip.y + ni.y - t1.y, ip.z + ni.z - t1.z));
    let s3 = select(0.0, 1.0, is_opaque(ip.x + ni.x + t2.x, ip.y + ni.y + t2.y, ip.z + ni.z + t2.z));
    let s4 = select(0.0, 1.0, is_opaque(ip.x + ni.x - t2.x, ip.y + ni.y - t2.y, ip.z + ni.z - t2.z));
    occ = (s1 + s2 + s3 + s4) * 0.15;
    // Corner samples
    let c1 = select(0.0, 1.0, is_opaque(ip.x + ni.x + t1.x + t2.x, ip.y + ni.y + t1.y + t2.y, ip.z + ni.z + t1.z + t2.z));
    let c2 = select(0.0, 1.0, is_opaque(ip.x + ni.x - t1.x + t2.x, ip.y + ni.y - t1.y + t2.y, ip.z + ni.z - t1.z + t2.z));
    let c3 = select(0.0, 1.0, is_opaque(ip.x + ni.x + t1.x - t2.x, ip.y + ni.y + t1.y - t2.y, ip.z + ni.z + t1.z - t2.z));
    let c4 = select(0.0, 1.0, is_opaque(ip.x + ni.x - t1.x - t2.x, ip.y + ni.y - t1.y - t2.y, ip.z + ni.z - t1.z - t2.z));
    occ += (c1 + c2 + c3 + c4) * 0.08;
    return 1.0 - occ;
  }

  fn sky(rd: vec3f, sun: vec3f, tt: f32) -> vec3f {
    let yt = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
    let sc = mix(vec3f(0.53, 0.73, 0.98), vec3f(0.18, 0.42, 0.83), yt);
    let sd = max(0.0, dot(rd, sun));
    let disk = pow(sd, 320.0) * vec3f(2.2, 1.9, 1.3);
    let glow = pow(sd, 12.0) * vec3f(0.45, 0.24, 0.05);
    let cp = rd.xz / (abs(rd.y) + 0.01) * 0.03 + vec2f(tt * 0.003, 0);
    let cl = smoothstep(0.38, 0.60, mc2_vn2(cp * 7.0) * 0.55 + mc2_vn2(cp * 19.0) * 0.25);
    return mix(sc, vec3f(1), cl * clamp(rd.y * 5.0, 0.0, 1.0)) + disk + glow;
  }

  fn block_color(bt: f32, wp: vec3f, n: vec3f) -> vec3f {
    let j = mc2_h3(floor(wp)) * 0.06 - 0.03;
    let bti = u32(bt);
    // 1=grass
    if (bti == 1u) {
      if (n.y > 0.5) { return vec3f(0.30 + j, 0.60 + j, 0.17 + j); }
      return mix(vec3f(0.30 + j, 0.60 + j, 0.17 + j), vec3f(0.50 + j, 0.36 + j, 0.22 + j), 0.7);
    }
    // 2=dirt
    if (bti == 2u) { return vec3f(0.50 + j, 0.36 + j, 0.22 + j); }
    // 3=stone
    if (bti == 3u) { return vec3f(0.44 + j, 0.44 + j, 0.44 + j); }
    // 4=sand
    if (bti == 4u) { return vec3f(0.82 + j, 0.78 + j, 0.55 + j); }
    // 5=water (shouldn't render as opaque, but fallback)
    if (bti == 5u) { return vec3f(0.15, 0.35, 0.65); }
    // 6=coal
    if (bti == 6u) { return vec3f(0.22 + j, 0.22 + j, 0.22 + j); }
    // 7=iron
    if (bti == 7u) { return vec3f(0.60 + j, 0.52 + j, 0.45 + j); }
    // 8=gold
    if (bti == 8u) { return vec3f(0.85 + j, 0.72 + j, 0.15 + j); }
    // 9=diamond
    if (bti == 9u) { return vec3f(0.30 + j, 0.82 + j, 0.85 + j); }
    // 10=bedrock
    if (bti == 10u) { return vec3f(0.18 + j, 0.18 + j, 0.20 + j); }
    // 11=wood
    if (bti == 11u) { return vec3f(0.42 + j, 0.30 + j, 0.15 + j); }
    // 12=leaves
    if (bti == 12u) { return vec3f(0.18 + j, 0.50 + j, 0.12 + j); }
    // 13=snow
    if (bti == 13u) { return vec3f(0.90 + j, 0.92 + j, 0.95 + j); }
    // 14=gravel
    if (bti == 14u) { return vec3f(0.48 + j, 0.46 + j, 0.43 + j); }
    return vec3f(0.5);
  }

  // Block face texturing — subtle grid pattern per face
  fn face_detail(wp: vec3f, n: vec3f) -> f32 {
    var fuv: vec2f;
    if (abs(n.x) > 0.5) { fuv = fract(wp.yz); }
    else if (abs(n.y) > 0.5) { fuv = fract(wp.xz); }
    else { fuv = fract(wp.xy); }
    // Brick-like edge darkening
    let edge = min(min(fuv.x, 1.0 - fuv.x), min(fuv.y, 1.0 - fuv.y));
    return smoothstep(0.0, 0.06, edge) * 0.15 + 0.85;
  }

  @fragment fn fs_main(v: VSOut) -> @location(0) vec4f {
    let sun = normalize(vec3f(cos(u.sunang), 0.55, sin(u.sunang)));
    let bob_y = sin(cam.bobphase) * cam.bobamp;
    let bob_x = cos(cam.bobphase * 0.5) * cam.bobamp * 0.5;
    let fov_adj = select(u.fov, u.fov * 1.1, cam.sprint_state > 0.5);
    let ro = vec3f(cam.px, cam.py + 1.62 + bob_y, cam.pz);
    let rd = cam_ray(cam.yaw + bob_x * 0.02, cam.pitch, fov_adj, v.uv, u.res);
    let max_d = u.drawdist;
    let ray = dda(ro, rd, max_d);

    var col: vec3f;
    if (ray.y < 0.5) {
      col = sky(rd, sun, u.time);
    } else {
      let wp = ro + rd * ray.x;
      let n = get_normal(ray.z, ray.w);
      let base = block_color(ray.y, wp, n);
      let detail = face_detail(wp, n);
      let diff = clamp(dot(n, sun), 0.0, 1.0);
      let ao = calc_ao(wp, n);

      // Shadow ray — short range only for perf
      let shadow_o = wp + n * 0.05;
      let sh = dda(shadow_o, sun, 24.0);
      let shadow = select(1.0, 0.25, sh.y > 0.5);

      // Hemisphere ambient
      let sky_light = clamp(n.y * 0.4 + 0.6, 0.3, 1.0);

      let lit = base * detail * (diff * shadow * 0.65 + sky_light * 0.35) * ao;

      // Distance fog
      let fog_strength = u.fog * 0.00025;
      let fog = 1.0 - exp(-ray.x * ray.x * fog_strength);
      col = mix(lit, sky(rd, sun, u.time), fog);
    }

    // Water tint — if looking through water
    let water_d = dda_water(ro, rd, min(ray.x, max_d));
    if (water_d < ray.x) {
      let water_depth = ray.x - water_d;
      let absorption = exp(-water_depth * vec3f(0.15, 0.05, 0.02));
      col = col * absorption + vec3f(0.02, 0.06, 0.12) * (1.0 - exp(-water_depth * 0.3));
    }

    // ACES tonemap
    col = (col * (col + 0.0245786) - 0.000090537) / (col * (0.983729 * col + 0.4329510) + 0.238081);
    col = pow(clamp(col, vec3f(0), vec3f(1)), vec3f(0.4545));

    // Underwater overlay
    let eye_block = get_block(i32(floor(ro.x)), i32(floor(ro.y)), i32(floor(ro.z)));
    if (eye_block == 5u) {
      col = col * vec3f(0.4, 0.6, 0.9) + vec3f(0.02, 0.05, 0.12);
    }

    return vec4f(col, 1);
  }

;; ═══════════════════════════════════════════════════════════════════
;; DATA
;; ═══════════════════════════════════════════════════════════════════

;; Voxel world — 128×64×128 × 4 bytes = 4,194,304 bytes (4MB)
@buffer world_buf :usage [storage] :size 4194304

;; Init flag — 1 × u32 = 4 bytes (padded to 16)
@buffer flag_buf :usage [storage] :size 16

;; Camera state — 16 × f32 = 64 bytes
@buffer cam_buf :usage [storage] :size 64
  @data
    :f0 0
    :f1 0
    :f2 0
    :f3 0
    :f4 0
    :f5 0
    :f6 0
    :f7 0
    :f8 0
    :f9 0
    :f10 0
    :f11 0
    :f12 0
    :f13 0
    :f14 0
    :f15 0

;; Per-frame uniform inputs
@buffer inp_buf :struct MC2Inp :usage [uniform]
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
    :sunang  (mul (elapsed) 0.06)
    :menuopen (form/menuopen)
    :sprint  (key-e)
    :sneak   (key-shift)
    :drawdist (form/drawdist)
    :pad0    0
    :pad1    0
    :pad2    0

;; ═══════════════════════════════════════════════════════════════════
;; PIPELINES + COMMANDS
;; ═══════════════════════════════════════════════════════════════════

@pipeline p_terrain :compute mc2_terrain :entry cs_main
@pipeline p_phys    :compute mc2_physics :entry cs_main
@pipeline p_rend    :vertex mc2_render :fragment mc2_render :format canvas :topology triangle-list

;; Compute 1: Generate terrain (128×128 columns)
@dispatch d_terrain :pipeline p_terrain :grid [128 128 1]
  @bind 0 :storage [world_buf flag_buf]
  @bind 1 :buffer inp_buf

;; Compute 2: Physics + collision
@dispatch d_phys :pipeline p_phys :grid [1 1 1]
  @bind 0 :storage [cam_buf world_buf]
  @bind 1 :buffer inp_buf

;; Render: fullscreen raycast through voxel grid
@pass main :clear [0.53 0.73 0.98 1]
  @draw :pipeline p_rend :vertices 6
    @bind 0 :buffer inp_buf
    @bind 1 :storage [cam_buf world_buf]

;; ═══════════════════════════════════════════════════════════════════
;; FORM
;; ═══════════════════════════════════════════════════════════════════
@form controls :title "Minecraft 2"
  @field fov      :type range    :label "FOV"       :default 1.2  :min 0.5  :max 2.2  :step 0.05
  @field fog      :type range    :label "Fog"       :default 1.5  :min 0.0  :max 5.0  :step 0.1
  @field drawdist :type range    :label "Draw Dist" :default 150  :min 40   :max 200  :step 10
  @field menuopen :type checkbox :label "Menu"      :default 1

;; ═══════════════════════════════════════════════════════════════════
;; SURFACE — HUD + crosshair + menu overlay
;; ═══════════════════════════════════════════════════════════════════

;; Crosshair
@panel xhair :x (sub (mul (canvas-width) 0.5) 12) :y (sub (mul (canvas-height) 0.5) 12) :w 24 :h 24
  @rect ch_h :x 0 :y 11 :w 24 :h 2 :fill (if (eq (form/menuopen) 0) [1 1 1 0.75] [0 0 0 0]) :radius 1
  @rect ch_v :x 11 :y 0 :w 2  :h 24 :fill (if (eq (form/menuopen) 0) [1 1 1 0.75] [0 0 0 0]) :radius 1

;; HUD bar
@panel hud :x 12 :y 12 :w 260 :h 40 :fill [0 0 0 0.55] :radius 8 :layout row :gap 8 :padding 10 :align center
  @text hud_t :size 13 :color [0.36 0.99 0.43 1]
    Minecraft 2 · RPE
  @rect hud_sep :w 1 :h 18 :fill [0.3 0.3 0.3 1]
  @text hud_c :size 10 :color [0.7 0.7 0.7 1]
    128x64x128

;; Controls hint (bottom)
@panel hint :x (sub (mul (canvas-width) 0.5) 160) :y (sub (canvas-height) 36) :w 320 :h 24 :fill [0 0 0 0.4] :radius 6 :layout row :gap 4 :padding 6 :align center :justify center
  @text hint_t :size 10 :color (if (eq (form/menuopen) 0) [0.6 0.6 0.7 1] [0 0 0 0])
    WASD move · Space jump · Shift sneak · E sprint

;; Menu overlay
@panel menu :x (sub (mul (canvas-width) 0.5) 160) :y (sub (mul (canvas-height) 0.5) 130) :w 320 :h 260 :fill (if (gt (form/menuopen) 0.5) [0.05 0.05 0.1 0.94] [0 0 0 0]) :radius 14 :layout column :gap 14 :padding 40
  @text menu_t :size 26 :color (if (gt (form/menuopen) 0.5) [0.36 0.99 0.43 1] [0 0 0 0]) :align center
    Minecraft 2
  @text menu_s0 :size 13 :color (if (gt (form/menuopen) 0.5) [0.8 0.85 0.9 1] [0 0 0 0]) :align center
    Rex Projection Engine
  @rect menu_div :w 240 :h 1 :fill (if (gt (form/menuopen) 0.5) [0.3 0.3 0.4 0.5] [0 0 0 0]) :margin-left 0
  @text menu_s1 :size 15 :color (if (gt (form/menuopen) 0.5) [1 1 1 1] [0 0 0 0]) :align center
    Click to play
  @text menu_s2 :size 11 :color (if (gt (form/menuopen) 0.5) [0.6 0.6 0.67 1] [0 0 0 0]) :align center
    WASD move · Space jump
  @text menu_s3 :size 11 :color (if (gt (form/menuopen) 0.5) [0.6 0.6 0.67 1] [0 0 0 0]) :align center
    Shift sneak · E sprint · Esc menu
  @text menu_s4 :size 10 :color (if (gt (form/menuopen) 0.5) [0.4 0.4 0.47 1] [0 0 0 0]) :align center
    128x64x128 voxel world · 15 block types
