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
  @field mousebtns :type f32
  @field selblock  :type f32
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
    sprint:f32, sneak:f32, drawdist:f32, mousebtns:f32, selblock:f32, pad2:f32
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
            // Desert biome — sand near water, sandstone (stone tint) on high ground
            if (h < f32(water_level) + 2.0) { bt = 4u; } else { bt = 3u; }
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
      // Leaves around tree tops — dense canopy like Minecraft
      if (bt == 0u && y >= hi + 3u && y <= hi + 7u && bio >= 0.25 && bio <= 0.75) {
        // Check nearby columns for tree trunks (radius 3)
        for (var dx = -3; dx <= 3; dx++) {
          for (var dz = -3; dz <= 3; dz++) {
            let nx = i32(x) + dx; let nz = i32(z) + dz;
            if (nx >= 0 && nx < i32(WX) && nz >= 0 && nz < i32(WZ)) {
              let nxf = f32(nx); let nzf = f32(nz);
              let nh = terrain_h(nxf, nzf);
              let nhi = u32(clamp(nh, 0.0, f32(WY - 1u)));
              let nb = biome(nxf, nzf);
              let tc = mc2_h2(vec2f(nxf * 7.3, nzf * 13.1));
              if (tc > 0.96 && nb >= 0.25 && nb <= 0.75) {
                let dist = max(abs(dx), abs(dz)); // Chebyshev = fill corners
                let leaf_h = i32(y) - i32(nhi) - 3;
                // Layer 0-1: radius 3, layer 2-3: radius 2, layer 4: radius 1
                var max_r = 3;
                if (leaf_h >= 3) { max_r = 2; }
                if (leaf_h >= 4) { max_r = 1; }
                if (leaf_h >= 0 && leaf_h <= 4 && dist <= max_r) {
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
    sprint_state:f32, tgt_x:f32, tgt_y:f32, tgt_z:f32, tgt_face:f32, break_time:f32
  };
  struct Inp {
    time:f32, dt:f32, res:vec2f, mdx:f32, mdy:f32,
    movex:f32, movey:f32, movez:f32, locked:f32,
    fov:f32, fog:f32, sunang:f32, menuopen:f32,
    sprint:f32, sneak:f32, drawdist:f32, mousebtns:f32, selblock:f32, pad2:f32
  };
  @group(0) @binding(0) var<storage, read_write> cam: Cam;
  @group(0) @binding(1) var<storage, read_write> world: array<u32>;
  @group(1) @binding(0) var<uniform> inp: Inp;

  const WX: u32 = 128u;
  const WY: u32 = 64u;
  const WZ: u32 = 128u;
  const PW: f32 = 0.6;        // player width
  const PH: f32 = 1.8;        // player height
  const EYE: f32 = 1.62;      // eye height
  const GRAVITY: f32 = 28.0;
  const JUMP_VEL: f32 = 8.5;
  const WALK_SPD: f32 = 4.3;
  const SPRINT_SPD: f32 = 5.6;
  const SNEAK_SPD: f32 = 1.3;
  const STEP_H: f32 = 1.0;    // max step-up height (one full block)
  const MOUSE_SENS: f32 = 0.002;
  const PITCH_LIMIT: f32 = 1.4; // ~80° — avoids gimbal lock at ±π/2

  fn idx(x: u32, y: u32, z: u32) -> u32 { return x + y * WX + z * WX * WY; }

  fn get_block_phys(x: i32, y: i32, z: i32) -> u32 {
    if (x < 0 || x >= i32(WX) || y < 0 || y >= i32(WY) || z < 0 || z >= i32(WZ)) { return 0u; }
    return world[idx(u32(x), u32(y), u32(z))];
  }

  fn set_block(x: i32, y: i32, z: i32, bt: u32) {
    if (x < 0 || x >= i32(WX) || y < 0 || y >= i32(WY) || z < 0 || z >= i32(WZ)) { return; }
    world[idx(u32(x), u32(y), u32(z))] = bt;
  }

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

  // Find the highest solid block under feet, return standing Y (top of that block).
  // Scans downward from py, returns py unchanged if nothing found within 3 blocks.
  fn find_ground(px: f32, py: f32, pz: f32) -> f32 {
    let hw = PW * 0.5;
    // Check from current foot level downward
    let start_y = i32(floor(py - 0.01)); // slight offset to handle exact boundary
    for (var dy = 0; dy < 4; dy++) {
      let check_y = start_y - dy;
      if (check_y < 0) { break; }
      // Is there a solid block at check_y?
      var found_solid = false;
      let x0 = i32(floor(px - hw)); let x1 = i32(floor(px + hw));
      let z0 = i32(floor(pz - hw)); let z1 = i32(floor(pz + hw));
      for (var ix = x0; ix <= x1; ix++) {
        for (var iz = z0; iz <= z1; iz++) {
          if (is_solid(ix, check_y, iz)) { found_solid = true; }
        }
      }
      if (found_solid) {
        // Stand on top of this block
        let stand_y = f32(check_y + 1);
        // Verify we can actually stand here (no collision at standing height)
        if (!collides(px, stand_y, pz)) {
          return stand_y;
        }
      }
    }
    return py; // nothing found — stay put
  }

  // Check if there's solid ground directly under the player's feet (within small epsilon)
  fn has_ground_below(px: f32, py: f32, pz: f32) -> bool {
    let hw = PW * 0.5;
    // Check block directly under feet — use small epsilon below foot position
    let foot_y = i32(floor(py - 0.05));
    let x0 = i32(floor(px - hw)); let x1 = i32(floor(px + hw));
    let z0 = i32(floor(pz - hw)); let z1 = i32(floor(pz + hw));
    for (var ix = x0; ix <= x1; ix++) {
      for (var iz = z0; iz <= z1; iz++) {
        if (is_solid(ix, foot_y, iz)) { return true; }
      }
    }
    return false;
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
    let spd = select(select(WALK_SPD, SPRINT_SPD, is_sprinting), SNEAK_SPD, inp.sneak > 0.5);

    // Mouse look
    if (inp.locked > 0.5 && inp.menuopen < 0.5) {
      cam.yaw += inp.mdx * MOUSE_SENS;
      cam.pitch = clamp(cam.pitch - inp.mdy * MOUSE_SENS, -PITCH_LIMIT, PITCH_LIMIT);
    }

    // Movement
    if (inp.locked > 0.5 && inp.menuopen < 0.5) {
      let cy = cos(cam.yaw); let sy = sin(cam.yaw);
      let dx = (sy * (-inp.movez) + cy * inp.movex) * spd * dt;
      let dz = (cy * (-inp.movez) - sy * inp.movex) * spd * dt;

      let sneak_edge = inp.sneak > 0.5 && cam.onground > 0.5;

      // X axis — try move, then try step-up
      var nx = cam.px + dx;
      if (!collides(nx, cam.py, cam.pz)) {
        if (sneak_edge && !has_ground_below(nx, cam.py, cam.pz)) {
          // Sneaking — don't walk off edges
        } else {
          cam.px = nx;
        }
      } else if (cam.onground > 0.5 && !collides(nx, cam.py + STEP_H, cam.pz)) {
        cam.px = nx;
        cam.py = find_ground(nx, cam.py + STEP_H, cam.pz);
        cam.vy = 0.0;
      }

      // Z axis — try move, then try step-up
      var nz = cam.pz + dz;
      if (!collides(cam.px, cam.py, nz)) {
        if (sneak_edge && !has_ground_below(cam.px, cam.py, nz)) {
          // Sneaking — don't walk off edges
        } else {
          cam.pz = nz;
        }
      } else if (cam.onground > 0.5 && !collides(cam.px, cam.py + STEP_H, nz)) {
        cam.pz = nz;
        cam.py = find_ground(cam.px, cam.py + STEP_H, nz);
        cam.vy = 0.0;
      }
    }

    // Gravity — only when airborne
    if (cam.onground < 0.5) {
      cam.vy -= GRAVITY * dt;
    }

    // Vertical movement
    if (cam.onground > 0.5 && cam.vy <= 0.0) {
      cam.vy = 0.0;
      // Snap to integer standing height to prevent float drift
      let snapped = round(cam.py);
      if (abs(cam.py - snapped) < 0.1 && !collides(cam.px, snapped, cam.pz)) {
        cam.py = snapped;
      }
      // Walked off edge? Check for solid ground under feet
      if (!has_ground_below(cam.px, cam.py, cam.pz)) {
        cam.onground = 0.0;
      }
    } else {
      let ny = cam.py + cam.vy * dt;
      if (cam.vy < 0.0 && collides(cam.px, ny, cam.pz)) {
        // Landing — find ground surface
        cam.py = find_ground(cam.px, ny, cam.pz);
        cam.vy = 0.0;
        cam.onground = 1.0;
      } else if (cam.vy > 0.0 && collides(cam.px, ny, cam.pz)) {
        // Head bump — stop upward velocity
        cam.vy = 0.0;
      } else {
        cam.py = ny;
        cam.onground = 0.0;
      }
    }

    // Jump
    if (inp.movey > 0.5 && inp.locked > 0.5 && inp.menuopen < 0.5 && cam.onground > 0.5) {
      cam.vy = JUMP_VEL;
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

    // ── Block interaction: targeting + break/place ──
    if (inp.locked > 0.5 && inp.menuopen < 0.5) {
      // Short DDA from eye along view direction to find targeted block
      let eye = vec3f(cam.px, cam.py + EYE, cam.pz);
      let fwd = vec3f(sin(cam.yaw) * cos(cam.pitch), sin(cam.pitch), cos(cam.yaw) * cos(cam.pitch));
      let reach = 6.0; // max reach distance in blocks

      // Branchless offset-accumulation DDA (use.gpu pattern)
      let sgn = sign(fwd);
      let signI = vec3i(sgn);
      let signF = -sgn;
      let baseF = max(vec3f(0.0), sgn);
      let invAbs = 1.0001 / max(abs(fwd), vec3f(1e-5));
      let fl = floor(eye);
      var offset = (baseF + (eye - fl) * signF) * invAbs;
      var uvw = vec3i(fl);
      var dist = 0.0;
      var hit = false;
      var hit_x = 0; var hit_y = 0; var hit_z = 0;
      var prev_x = 0; var prev_y = 0; var prev_z = 0;
      var hit_face = 0.0;

      // Check starting voxel
      let ix0 = uvw.x; let iy0 = uvw.y; let iz0 = uvw.z;
      if (ix0 >= 0 && ix0 < i32(WX) && iy0 >= 0 && iy0 < i32(WY) && iz0 >= 0 && iz0 < i32(WZ)) {
        let bt0 = get_block_phys(ix0, iy0, iz0);
        if (bt0 > 0u && bt0 != 5u && bt0 != 10u) {
          hit = true; hit_x = ix0; hit_y = iy0; hit_z = iz0;
        }
      }

      if (!hit) {
        for (var i = 0; i < 48; i++) {
          prev_x = uvw.x; prev_y = uvw.y; prev_z = uvw.z;
          let axis = step(offset, offset.yzx) * step(offset, offset.zxy);
          dist = dot(axis, offset);
          if (dist > reach) { break; }
          // Encode face from axis + sign
          let n = axis * signF;
          if (abs(n.x) > 0.5) { hit_face = select(1.0, 2.0, sgn.x > 0.0); }
          else if (abs(n.y) > 0.5) { hit_face = select(3.0, 4.0, sgn.y > 0.0); }
          else { hit_face = select(5.0, 6.0, sgn.z > 0.0); }
          offset += invAbs * axis;
          uvw += signI * vec3i(axis);
          if (uvw.x < 0 || uvw.x >= i32(WX) || uvw.y < 0 || uvw.y >= i32(WY) || uvw.z < 0 || uvw.z >= i32(WZ)) { break; }
          let bt = get_block_phys(uvw.x, uvw.y, uvw.z);
          if (bt > 0u && bt != 5u && bt != 10u) {
            hit = true; hit_x = uvw.x; hit_y = uvw.y; hit_z = uvw.z;
            break;
          }
        }
      }

      if (hit) {
        cam.tgt_x = f32(hit_x);
        cam.tgt_y = f32(hit_y);
        cam.tgt_z = f32(hit_z);
        cam.tgt_face = hit_face;

        let btns = u32(inp.mousebtns);

        // Left click — break block
        if ((btns & 1u) != 0u) {
          cam.break_time += dt;
          // Break threshold — harder blocks take longer
          let tgt_bt = get_block_phys(hit_x, hit_y, hit_z);
          var hardness = 0.4; // default: about half a second
          if (tgt_bt == 3u) { hardness = 1.2; } // stone
          if (tgt_bt == 7u || tgt_bt == 8u) { hardness = 1.5; } // iron/gold
          if (tgt_bt == 9u) { hardness = 2.0; } // diamond
          if (tgt_bt == 6u) { hardness = 1.0; } // coal
          if (cam.break_time >= hardness) {
            set_block(hit_x, hit_y, hit_z, 0u);
            cam.break_time = 0.0;
          }
        } else if ((btns & 2u) != 0u && cam.break_time < 0.05) {
          // Right click — place block at previous position (adjacent to hit face)
          let place_bt = u32(inp.selblock);
          if (place_bt > 0u && place_bt <= 14u) {
            let existing = get_block_phys(prev_x, prev_y, prev_z);
            // Don't place inside player or where a block already exists
            if (existing == 0u || existing == 5u) {
              // Check not inside player AABB
              let phw = PW * 0.5;
              let px_min = cam.px - phw; let px_max = cam.px + phw;
              let py_min = cam.py;       let py_max = cam.py + PH;
              let pz_min = cam.pz - phw; let pz_max = cam.pz + phw;
              let bx = f32(prev_x); let by = f32(prev_y); let bz = f32(prev_z);
              let overlap = bx + 1.0 > px_min && bx < px_max &&
                            by + 1.0 > py_min && by < py_max &&
                            bz + 1.0 > pz_min && bz < pz_max;
              if (!overlap) {
                set_block(prev_x, prev_y, prev_z, place_bt);
              }
            }
          }
          cam.break_time = 0.0;
        } else {
          cam.break_time = 0.0;
        }
      } else {
        cam.tgt_x = -1.0;
        cam.tgt_y = -1.0;
        cam.tgt_z = -1.0;
        cam.tgt_face = 0.0;
        cam.break_time = 0.0;
      }
    } else {
      cam.tgt_x = -1.0;
      cam.tgt_y = -1.0;
      cam.tgt_z = -1.0;
      cam.tgt_face = 0.0;
      cam.break_time = 0.0;
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
    sprint:f32, sneak:f32, drawdist:f32, mousebtns:f32, selblock:f32, pad2:f32
  };
  @group(0) @binding(0) var<uniform> u: MC2Inp;
  struct Cam {
    px:f32, py:f32, pz:f32, yaw:f32, pitch:f32, vy:f32,
    onground:f32, init:f32, bobphase:f32, bobamp:f32,
    sprint_state:f32, tgt_x:f32, tgt_y:f32, tgt_z:f32, tgt_face:f32, break_time:f32
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

  // DDA through voxel grid (use.gpu branchless offset-accumulation pattern)
  fn dda(ro: vec3f, rd: vec3f, max_dist: f32) -> vec4f {
    // Clamp ray origin into grid bounds
    if (ro.x < 0.0 || ro.x >= f32(WX) || ro.y < 0.0 || ro.y >= f32(WY) || ro.z < 0.0 || ro.z >= f32(WZ)) {
      return vec4f(max_dist, 0, 0, 0);
    }
    let signs = sign(rd);
    let signI = vec3i(signs);
    let signF = -signs;
    let baseF = max(vec3f(0.0), signs);
    let invAbs = 1.0001 / max(abs(rd), vec3f(1e-5));

    let fl = floor(ro);
    var offset = (baseF + (ro - fl) * signF) * invAbs;
    var uvw = vec3i(fl);
    var dist = 0.0;
    var axis = vec3f(0.0);

    // Check starting voxel first
    let bt0 = get_block(uvw.x, uvw.y, uvw.z);
    if (bt0 > 0u && bt0 != 5u) {
      // Camera inside block — use ray direction as normal
      let a = abs(rd);
      var na = 2.0; var ns = -sign(rd.z);
      if (a.x > a.y && a.x > a.z) { na = 0.0; ns = -sign(rd.x); }
      else if (a.y > a.z) { na = 1.0; ns = -sign(rd.y); }
      return vec4f(0.0, f32(bt0), na, ns);
    }

    for (var i = 0; i < 192; i++) {
      // Branchless axis selection (use.gpu pattern)
      axis = step(offset, offset.yzx) * step(offset, offset.zxy);
      dist = dot(axis, offset);
      if (dist > max_dist) { break; }
      offset += invAbs * axis;
      uvw += signI * vec3i(axis);

      if (uvw.x < 0 || uvw.x >= i32(WX) || uvw.y < 0 || uvw.y >= i32(WY) || uvw.z < 0 || uvw.z >= i32(WZ)) { break; }
      let bt = get_block(uvw.x, uvw.y, uvw.z);
      if (bt > 0u && bt != 5u) {
        let n = axis * signF;
        var na = 0.0; var ns = n.x;
        if (abs(n.y) > 0.5) { na = 1.0; ns = n.y; }
        else if (abs(n.z) > 0.5) { na = 2.0; ns = n.z; }
        return vec4f(dist, f32(bt), na, ns);
      }
    }
    return vec4f(dist, 0, 1, 1);
  }

  // Water DDA — detect water separately for underwater tint
  fn dda_water(ro: vec3f, rd: vec3f, max_dist: f32) -> f32 {
    if (ro.x < 0.0 || ro.x >= f32(WX) || ro.y < 0.0 || ro.y >= f32(WY) || ro.z < 0.0 || ro.z >= f32(WZ)) {
      return max_dist;
    }
    let signs = sign(rd);
    let signI = vec3i(signs);
    let signF = -signs;
    let baseF = max(vec3f(0.0), signs);
    let invAbs = 1.0001 / max(abs(rd), vec3f(1e-5));

    let fl = floor(ro);
    var offset = (baseF + (ro - fl) * signF) * invAbs;
    var uvw = vec3i(fl);

    // Check starting voxel
    if (get_block(uvw.x, uvw.y, uvw.z) == 5u) { return 0.0; }

    for (var i = 0; i < 64; i++) {
      let axis = step(offset, offset.yzx) * step(offset, offset.zxy);
      let dist = dot(axis, offset);
      if (dist > max_dist) { break; }
      offset += invAbs * axis;
      uvw += signI * vec3i(axis);
      if (uvw.x < 0 || uvw.x >= i32(WX) || uvw.y < 0 || uvw.y >= i32(WY) || uvw.z < 0 || uvw.z >= i32(WZ)) { break; }
      if (get_block(uvw.x, uvw.y, uvw.z) == 5u) { return dist; }
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
    let sun_y = sun.y; // sun elevation: >0 = day, <0 = night
    let day_amt = clamp(sun_y * 3.0 + 0.5, 0.0, 1.0); // 0=night, 1=day
    let sunset_amt = clamp(1.0 - abs(sun_y) * 5.0, 0.0, 1.0); // peak at horizon

    let yt = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);

    // Day sky
    let day_lo = vec3f(0.53, 0.73, 0.98);
    let day_hi = vec3f(0.18, 0.42, 0.83);
    let day_sky = mix(day_lo, day_hi, yt);

    // Sunset sky
    let sunset_lo = vec3f(0.95, 0.45, 0.15);
    let sunset_hi = vec3f(0.35, 0.20, 0.55);
    let sunset_sky = mix(sunset_lo, sunset_hi, yt);

    // Night sky
    let night_lo = vec3f(0.01, 0.01, 0.04);
    let night_hi = vec3f(0.0, 0.0, 0.02);
    let night_sky = mix(night_lo, night_hi, yt);

    var sc = mix(night_sky, day_sky, day_amt);
    sc = mix(sc, sunset_sky, sunset_amt * 0.7);

    // Sun disk + glow
    let sd = max(0.0, dot(rd, sun));
    let disk = pow(sd, 320.0) * vec3f(2.2, 1.9, 1.3);
    let glow = pow(sd, 12.0) * vec3f(0.45, 0.24, 0.05) * day_amt;

    // Moon (opposite sun)
    let moon_dir = -sun;
    let md = max(0.0, dot(rd, moon_dir));
    let moon_disk = pow(md, 800.0) * vec3f(0.9, 0.92, 1.0) * (1.0 - day_amt);
    let moon_glow = pow(md, 30.0) * vec3f(0.08, 0.10, 0.15) * (1.0 - day_amt);

    // Stars (only at night, above horizon)
    var stars = 0.0;
    if (day_amt < 0.7 && rd.y > 0.0) {
      let star_uv = floor(rd.xz / (rd.y + 0.001) * 120.0);
      let sh = mc2_h2(star_uv);
      if (sh > 0.985) {
        let twinkle = sin(tt * 2.0 + sh * 100.0) * 0.3 + 0.7;
        stars = twinkle * (1.0 - day_amt) * smoothstep(0.0, 0.1, rd.y);
      }
    }

    // Clouds (fade with day/night)
    let cp = rd.xz / (abs(rd.y) + 0.01) * 0.03 + vec2f(tt * 0.003, 0);
    let cl = smoothstep(0.38, 0.60, mc2_vn2(cp * 7.0) * 0.55 + mc2_vn2(cp * 19.0) * 0.25);
    let cloud_bright = mix(0.08, 1.0, day_amt);
    sc = mix(sc, vec3f(cloud_bright), cl * clamp(rd.y * 5.0, 0.0, 1.0));

    return sc + disk + glow + moon_disk + moon_glow + vec3f(stars);
  }

  // ── Procedural pixel-art textures ──
  // Get face UV in 0..1 range (used for all texture lookups)
  fn face_uv(wp: vec3f, n: vec3f) -> vec2f {
    if (abs(n.x) > 0.5) { return fract(wp.zy); }
    if (abs(n.y) > 0.5) { return fract(wp.xz); }
    return fract(wp.xy);
  }

  // Pixel-art hash: quantize UV to 16×16 grid, hash per pixel
  fn px_hash(uv: vec2f, bp: vec3f) -> f32 {
    let p = floor(uv * 16.0);
    return mc2_h3(vec3f(p.x, p.y, mc2_h2(bp.xz) * 100.0));
  }

  // Procedural ore speckles on stone base
  fn ore_tex(uv: vec2f, bp: vec3f, ore_col: vec3f) -> vec3f {
    let stone = vec3f(0.50, 0.50, 0.50);
    let px = floor(uv * 16.0);
    let h = mc2_h3(vec3f(px, mc2_h2(bp.xz) * 100.0));
    // Ore speckles: clusters of 2-3 pixels
    let h2 = mc2_h3(vec3f(px + vec2f(1, 0), mc2_h2(bp.xz) * 100.0));
    if (h > 0.82 || (h > 0.7 && h2 > 0.82)) {
      return ore_col;
    }
    // Stone cracks
    let crack = smoothstep(0.0, 0.04, abs(fract(uv.x * 16.0) - 0.5)) *
                smoothstep(0.0, 0.04, abs(fract(uv.y * 16.0) - 0.5));
    return stone * (0.88 + h * 0.12) * mix(0.82, 1.0, crack);
  }

  fn block_color(bt: f32, wp: vec3f, n: vec3f) -> vec3f {
    let bti = u32(bt);
    let bp = floor(wp);
    let uv = face_uv(wp, n);
    let px = floor(uv * 16.0);
    let h = px_hash(uv, bp);
    let sub = fract(uv * 16.0); // sub-pixel position within texel

    // 1=grass
    if (bti == 1u) {
      if (n.y > 0.5) {
        // Grass top: green with darker spots and occasional flowers
        let base = vec3f(0.33, 0.62, 0.18);
        let dark = vec3f(0.24, 0.50, 0.13);
        let c = select(base, dark, h > 0.65);
        return select(c, c * 1.12, h < 0.08); // occasional bright blade
      }
      // Grass side: dirt with green stripe at top
      let dirt = vec3f(0.53, 0.38, 0.24) * (0.90 + h * 0.1);
      let grass_edge = vec3f(0.30, 0.58, 0.15);
      let t = smoothstep(0.78, 0.92, uv.y); // top stripe
      return mix(dirt, grass_edge, t);
    }
    // 2=dirt
    if (bti == 2u) {
      let base = vec3f(0.53, 0.38, 0.24);
      let speckle = select(0.92, 1.05, h > 0.6);
      let darker = select(1.0, 0.85, h > 0.88);
      return base * speckle * darker;
    }
    // 3=stone
    if (bti == 3u) {
      let base = vec3f(0.50, 0.50, 0.50);
      let crack_x = smoothstep(0.0, 0.06, abs(sub.x - 0.5));
      let crack_y = smoothstep(0.0, 0.06, abs(sub.y - 0.5));
      let crack = min(crack_x, crack_y);
      let shade = 0.88 + h * 0.12;
      return base * shade * mix(0.80, 1.0, crack);
    }
    // 4=sand
    if (bti == 4u) {
      let base = vec3f(0.85, 0.80, 0.58);
      let grain = 0.94 + h * 0.12;
      return base * grain;
    }
    // 5=water
    if (bti == 5u) { return vec3f(0.15, 0.35, 0.65); }
    // 6=coal ore
    if (bti == 6u) { return ore_tex(uv, bp, vec3f(0.12, 0.12, 0.12)); }
    // 7=iron ore
    if (bti == 7u) { return ore_tex(uv, bp, vec3f(0.72, 0.58, 0.48)); }
    // 8=gold ore
    if (bti == 8u) { return ore_tex(uv, bp, vec3f(0.92, 0.78, 0.15)); }
    // 9=diamond ore
    if (bti == 9u) { return ore_tex(uv, bp, vec3f(0.35, 0.88, 0.92)); }
    // 10=bedrock
    if (bti == 10u) {
      let base = vec3f(0.20, 0.20, 0.22);
      let chaos = mc2_h3(vec3f(px * 1.7, mc2_h2(bp.xz) * 50.0));
      return base * (0.6 + chaos * 0.5);
    }
    // 11=wood/log
    if (bti == 11u) {
      if (abs(n.y) > 0.5) {
        // Log top/bottom: ring pattern
        let center = sub - 0.5;
        let r = length(center) * 4.0;
        let ring = smoothstep(0.4, 0.5, fract(r));
        return mix(vec3f(0.55, 0.40, 0.20), vec3f(0.38, 0.26, 0.12), ring);
      }
      // Log sides: bark with vertical grain
      let bark = vec3f(0.42, 0.30, 0.15);
      let grain = smoothstep(0.3, 0.5, fract(uv.x * 16.0 * 0.5 + h * 2.0));
      return bark * (0.85 + grain * 0.15 + h * 0.08);
    }
    // 12=leaves
    if (bti == 12u) {
      let base = vec3f(0.20, 0.52, 0.14);
      let dark = vec3f(0.12, 0.36, 0.08);
      let c = select(base, dark, h > 0.5);
      // Small gaps/holes (dither)
      let hole = select(1.0, 0.7, h > 0.9);
      return c * hole;
    }
    // 13=snow
    if (bti == 13u) {
      let base = vec3f(0.92, 0.94, 0.97);
      let shadow = select(1.0, 0.93, h > 0.7);
      return base * shadow;
    }
    // 14=gravel
    if (bti == 14u) {
      let base = vec3f(0.50, 0.48, 0.45);
      let h2 = mc2_h3(vec3f(px * 3.1, mc2_h2(bp.xz) * 77.0));
      let size = select(0.90, 1.08, h2 > 0.5);
      return base * (0.85 + h * 0.15) * size;
    }
    return vec3f(0.5);
  }

  // Block edge grid lines (subtle darkening at block boundaries)
  fn face_detail(wp: vec3f, n: vec3f) -> f32 {
    let fuv = face_uv(wp, n);
    let edge = min(min(fuv.x, 1.0 - fuv.x), min(fuv.y, 1.0 - fuv.y));
    return smoothstep(0.0, 0.04, edge) * 0.12 + 0.88;
  }

  @fragment fn fs_main(v: VSOut) -> @location(0) vec4f {
    // Sun orbits: Y component from sin(sunang) gives elevation (-1..1)
    let sun = normalize(vec3f(cos(u.sunang), sin(u.sunang) * 0.8 + 0.15, sin(u.sunang * 0.7)));
    let sun_up = clamp(sun.y * 3.0 + 0.5, 0.0, 1.0); // 0=night 1=day

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

      // Day/night ambient — dims at night
      let ambient_str = mix(0.08, 0.35, sun_up);
      let sky_light = clamp(n.y * 0.4 + 0.6, 0.3, 1.0) * ambient_str;
      let sun_str = mix(0.05, 0.65, sun_up);

      var lit = base * detail * (diff * shadow * sun_str + sky_light) * ao;

      // ── Targeted block highlight ──
      let bp = floor(wp - n * 0.01);
      let is_target = abs(bp.x - cam.tgt_x) < 0.5 && abs(bp.y - cam.tgt_y) < 0.5 && abs(bp.z - cam.tgt_z) < 0.5 && cam.tgt_x >= 0.0;
      if (is_target) {
        let fuv = face_uv(wp, n);
        let e = min(min(fuv.x, 1.0 - fuv.x), min(fuv.y, 1.0 - fuv.y));
        let wire = 1.0 - smoothstep(0.0, 0.03, e);
        lit = mix(lit, vec3f(1.0), wire * 0.8);
        // Break crack overlay
        if (cam.break_time > 0.01) {
          let crack_uv = fuv * 4.0;
          let crack_h = mc2_h2(floor(crack_uv));
          let crack_progress = clamp(cam.break_time * 2.0, 0.0, 1.0);
          if (crack_h < crack_progress) {
            lit = lit * (0.4 + 0.3 * crack_h);
          }
        }
      }

      // Distance fog (tint changes day/night)
      let fog_strength = u.fog * 0.00025;
      let fog = 1.0 - exp(-ray.x * ray.x * fog_strength);
      col = mix(lit, sky(rd, sun, u.time), fog);
    }

    // Water surface — waves, fresnel, specular
    let water_d = dda_water(ro, rd, min(ray.x, max_d));
    if (water_d < ray.x) {
      let water_wp = ro + rd * water_d;
      // Animated wave normal
      let wave1 = sin(u.time * 1.8 + water_wp.x * 2.5 + water_wp.z * 1.3) * 0.08;
      let wave2 = cos(u.time * 1.3 + water_wp.z * 3.1 - water_wp.x * 0.7) * 0.06;
      let wave_n = normalize(vec3f(wave1, 1.0, wave2));
      // Fresnel: more reflective at grazing angles
      let view_dot = abs(dot(rd, wave_n));
      let fresnel = pow(1.0 - view_dot, 3.0) * 0.7 + 0.15;
      // Reflected sky
      let refl_rd = reflect(rd, wave_n);
      let refl_sky = sky(refl_rd, sun, u.time);
      // Sun specular on water
      let spec = pow(max(0.0, dot(refl_rd, sun)), 64.0) * sun_up * 1.5;
      // Water body absorption
      let water_depth = ray.x - water_d;
      let absorption = exp(-water_depth * vec3f(0.18, 0.06, 0.02));
      let water_col = col * absorption + vec3f(0.02, 0.06, 0.12) * (1.0 - exp(-water_depth * 0.3));
      // Blend: fresnel controls reflection vs refraction
      col = mix(water_col, refl_sky, fresnel) + vec3f(spec);
    }

    // ACES tonemap
    col = (col * (col + 0.0245786) - 0.000090537) / (col * (0.983729 * col + 0.4329510) + 0.238081);
    col = pow(clamp(col, vec3f(0), vec3f(1)), vec3f(0.4545));

    // Underwater overlay
    let eye_block = get_block(i32(floor(ro.x)), i32(floor(ro.y)), i32(floor(ro.z)));
    if (eye_block == 5u) {
      // Underwater distortion
      let wobble = sin(u.time * 3.0 + v.uv.y * 20.0) * 0.003;
      col = col * vec3f(0.35, 0.55, 0.85) + vec3f(0.02, 0.05, 0.15);
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
    :mousebtns (mouse-buttons)
    :selblock  (form/selblock)
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
  @field selblock :type range    :label "Block"     :default 1    :min 1    :max 14   :step 1

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

;; Hotbar — 9 block slots at bottom center
@panel hotbar :x (sub (mul (canvas-width) 0.5) 184) :y (sub (canvas-height) 56) :w 368 :h 44 :fill (if (eq (form/menuopen) 0) [0 0 0 0.65] [0 0 0 0]) :radius 6 :layout row :gap 4 :padding 4 :align center
  ;; Slot 1: Grass
  @rect hb1 :w 36 :h 36 :fill (if (eq (form/menuopen) 0) [0.33 0.62 0.18 1] [0 0 0 0]) :radius 3 :stroke (if (lte (abs (sub (form/selblock) 1)) 0.5) [1 1 1 0.9] [0.3 0.3 0.3 0.4]) :stroke-width (if (lte (abs (sub (form/selblock) 1)) 0.5) 2 1)
  ;; Slot 2: Dirt
  @rect hb2 :w 36 :h 36 :fill (if (eq (form/menuopen) 0) [0.53 0.38 0.24 1] [0 0 0 0]) :radius 3 :stroke (if (lte (abs (sub (form/selblock) 2)) 0.5) [1 1 1 0.9] [0.3 0.3 0.3 0.4]) :stroke-width (if (lte (abs (sub (form/selblock) 2)) 0.5) 2 1)
  ;; Slot 3: Stone
  @rect hb3 :w 36 :h 36 :fill (if (eq (form/menuopen) 0) [0.50 0.50 0.50 1] [0 0 0 0]) :radius 3 :stroke (if (lte (abs (sub (form/selblock) 3)) 0.5) [1 1 1 0.9] [0.3 0.3 0.3 0.4]) :stroke-width (if (lte (abs (sub (form/selblock) 3)) 0.5) 2 1)
  ;; Slot 4: Sand
  @rect hb4 :w 36 :h 36 :fill (if (eq (form/menuopen) 0) [0.85 0.80 0.58 1] [0 0 0 0]) :radius 3 :stroke (if (lte (abs (sub (form/selblock) 4)) 0.5) [1 1 1 0.9] [0.3 0.3 0.3 0.4]) :stroke-width (if (lte (abs (sub (form/selblock) 4)) 0.5) 2 1)
  ;; Slot 5: Wood
  @rect hb5 :w 36 :h 36 :fill (if (eq (form/menuopen) 0) [0.42 0.30 0.15 1] [0 0 0 0]) :radius 3 :stroke (if (lte (abs (sub (form/selblock) 11)) 0.5) [1 1 1 0.9] [0.3 0.3 0.3 0.4]) :stroke-width (if (lte (abs (sub (form/selblock) 11)) 0.5) 2 1)
  ;; Slot 6: Leaves
  @rect hb6 :w 36 :h 36 :fill (if (eq (form/menuopen) 0) [0.20 0.52 0.14 1] [0 0 0 0]) :radius 3 :stroke (if (lte (abs (sub (form/selblock) 12)) 0.5) [1 1 1 0.9] [0.3 0.3 0.3 0.4]) :stroke-width (if (lte (abs (sub (form/selblock) 12)) 0.5) 2 1)
  ;; Slot 7: Coal ore
  @rect hb7 :w 36 :h 36 :fill (if (eq (form/menuopen) 0) [0.25 0.25 0.25 1] [0 0 0 0]) :radius 3 :stroke (if (lte (abs (sub (form/selblock) 6)) 0.5) [1 1 1 0.9] [0.3 0.3 0.3 0.4]) :stroke-width (if (lte (abs (sub (form/selblock) 6)) 0.5) 2 1)
  ;; Slot 8: Snow
  @rect hb8 :w 36 :h 36 :fill (if (eq (form/menuopen) 0) [0.92 0.94 0.97 1] [0 0 0 0]) :radius 3 :stroke (if (lte (abs (sub (form/selblock) 13)) 0.5) [1 1 1 0.9] [0.3 0.3 0.3 0.4]) :stroke-width (if (lte (abs (sub (form/selblock) 13)) 0.5) 2 1)
  ;; Slot 9: Gravel
  @rect hb9 :w 36 :h 36 :fill (if (eq (form/menuopen) 0) [0.50 0.48 0.45 1] [0 0 0 0]) :radius 3 :stroke (if (lte (abs (sub (form/selblock) 14)) 0.5) [1 1 1 0.9] [0.3 0.3 0.3 0.4]) :stroke-width (if (lte (abs (sub (form/selblock) 14)) 0.5) 2 1)

;; Controls hint (bottom)
@panel hint :x (sub (mul (canvas-width) 0.5) 160) :y (sub (canvas-height) 68) :w 320 :h 18 :fill [0 0 0 0.3] :radius 4 :layout row :gap 4 :padding 4 :align center :justify center
  @text hint_t :size 9 :color (if (eq (form/menuopen) 0) [0.5 0.5 0.6 1] [0 0 0 0])
    WASD move · Space jump · Shift sneak · E sprint · LMB break · RMB place

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
