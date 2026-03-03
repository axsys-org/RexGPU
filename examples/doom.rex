;; ═══════════════════════════════════════════════════════════════════
;; DOOM — Rex Projection Engine
;; Classic FPS · BSP-style raycasting · Textured walls · Enemies
;; Click canvas to lock mouse · WASD move · Space shoot · Mouse aim
;; E open doors · R reload · Shift run · Esc menu
;; ═══════════════════════════════════════════════════════════════════

;; ── Uniform inputs ──
@struct DoomInp
  @field time     :type f32
  @field dt       :type f32
  @field res      :type f32x2
  @field mdx      :type f32
  @field mdy      :type f32
  @field movex    :type f32
  @field movey    :type f32
  @field movez    :type f32
  @field locked   :type f32
  @field fov      :type f32
  @field sens     :type f32
  @field menuopen :type f32
  @field sprint   :type f32
  @field mousebtns :type f32
  @field selweap  :type f32
  @field pad0     :type f32

;; ═══════════════════════════════════════════════════════════════════
;; NOISE + TEXTURE LIBRARY
;; ═══════════════════════════════════════════════════════════════════
@lib doom_lib
  fn d_hash(p: vec2f) -> f32 {
    var q = fract(p * vec2f(127.1, 311.7));
    q += dot(q, q + 19.19);
    return fract(q.x * q.y);
  }
  fn d_hash3(p: vec3f) -> f32 {
    var q = fract(p * vec3f(127.1, 311.7, 74.7));
    q += dot(q, q + 19.19);
    return fract(q.x * q.y + q.z * 0.31);
  }
  fn d_vnoise(p: vec2f) -> f32 {
    let i = floor(p); let f = fract(p);
    let s = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(d_hash(i), d_hash(i + vec2f(1, 0)), s.x),
      mix(d_hash(i + vec2f(0, 1)), d_hash(i + vec2f(1, 1)), s.x), s.y);
  }
  fn d_fbm(p: vec2f) -> f32 {
    var v = 0.0; var a = 0.5; var q = p;
    for (var i = 0; i < 4; i++) { v += a * d_vnoise(q); q *= 2.07; a *= 0.48; }
    return v;
  }

;; ═══════════════════════════════════════════════════════════════════
;; LEVEL GENERATION — fills 64×64 tile grid + entity list
;; Wall types: 0=air, 1=stone wall, 2=brick wall, 3=tech wall,
;;             4=door, 5=exit, 6=barrel, 7=pillar, 8=cage wall,
;;             9=skull wall, 10=blood wall, 11=vine wall
;; Floor types (upper 16 bits): 0=stone, 1=nukage, 2=metal, 3=carpet
;; Entity types (enemies, items, etc.) stored in entity buffer
;; ═══════════════════════════════════════════════════════════════════
@shader doom_levelgen
  #import doom_lib
  struct Inp {
    time:f32, dt:f32, res:vec2f, mdx:f32, mdy:f32,
    movex:f32, movey:f32, movez:f32, locked:f32,
    fov:f32, sens:f32, menuopen:f32, sprint:f32,
    mousebtns:f32, selweap:f32, pad0:f32
  };
  @group(0) @binding(0) var<storage, read_write> level: array<u32>;
  @group(0) @binding(1) var<storage, read_write> entities: array<f32>;
  @group(0) @binding(2) var<storage, read_write> flags: array<u32>;
  @group(1) @binding(0) var<uniform> inp: Inp;

  const LW: u32 = 64u;
  const LH: u32 = 64u;
  const MAX_ENT: u32 = 128u;    // max entities × 8 floats each
  const ENT_STRIDE: u32 = 8u;   // type, x, z, hp, state, timer, dir, speed

  fn lidx(x: u32, z: u32) -> u32 { return x + z * LW; }

  // Procedural room-and-corridor dungeon
  @compute @workgroup_size(1)
  fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
    if (flags[0] > 0u) { return; }

    // Clear map to solid
    for (var z = 0u; z < LH; z++) {
      for (var x = 0u; x < LW; x++) {
        level[lidx(x, z)] = 1u; // all stone walls
      }
    }

    // Carve rooms
    // Room data: cx, cz, half_w, half_h, wall_type
    // Procedurally generate ~14 rooms with corridors

    // Room 1 — spawn room (center of map)
    let r1x = 32u; let r1z = 32u;
    for (var z = r1z - 4u; z <= r1z + 4u; z++) {
      for (var x = r1x - 5u; x <= r1x + 5u; x++) {
        level[lidx(x, z)] = 0u;
      }
    }
    // Add pillars in spawn room
    level[lidx(r1x - 3u, r1z - 2u)] = 7u;
    level[lidx(r1x + 3u, r1z - 2u)] = 7u;
    level[lidx(r1x - 3u, r1z + 2u)] = 7u;
    level[lidx(r1x + 3u, r1z + 2u)] = 7u;

    // Room 2 — north corridor + room
    for (var z = r1z - 12u; z < r1z - 4u; z++) {
      for (var x = r1x - 1u; x <= r1x + 1u; x++) {
        level[lidx(x, z)] = 0u;
      }
    }
    // North room — brick walls
    for (var z = r1z - 20u; z <= r1z - 12u; z++) {
      for (var x = r1x - 6u; x <= r1x + 6u; x++) {
        if (z == r1z - 20u || z == r1z - 12u || x == r1x - 6u || x == r1x + 6u) {
          level[lidx(x, z)] = 2u;
        } else {
          level[lidx(x, z)] = 0u;
        }
      }
    }
    // Door to north room
    level[lidx(r1x, r1z - 12u)] = 4u;

    // Room 3 — east wing
    for (var z = r1z - 1u; z <= r1z + 1u; z++) {
      for (var x = r1x + 5u; x < r1x + 14u; x++) {
        level[lidx(x, z)] = 0u;
      }
    }
    for (var z = r1z - 5u; z <= r1z + 5u; z++) {
      for (var x = r1x + 14u; x <= r1x + 22u; x++) {
        if (z == r1z - 5u || z == r1z + 5u || x == r1x + 14u || x == r1x + 22u) {
          level[lidx(x, z)] = 3u; // tech walls
        } else {
          level[lidx(x, z)] = 0u;
        }
      }
    }
    level[lidx(r1x + 14u, r1z)] = 4u;

    // Room 4 — south area (nukage pit)
    for (var z = r1z + 4u; z < r1z + 10u; z++) {
      for (var x = r1x - 1u; x <= r1x + 1u; x++) {
        level[lidx(x, z)] = 0u;
      }
    }
    for (var z = r1z + 10u; z <= r1z + 20u; z++) {
      for (var x = r1x - 8u; x <= r1x + 8u; x++) {
        if (z == r1z + 10u || z == r1z + 20u || x == r1x - 8u || x == r1x + 8u) {
          level[lidx(x, z)] = 10u; // blood walls
        } else {
          // Nukage floor (encoded as floor type 1 in upper bits)
          level[lidx(x, z)] = (1u << 16u); // air with nukage floor
        }
      }
    }
    level[lidx(r1x, r1z + 10u)] = 0u; // open entrance

    // Room 5 — west wing
    for (var z = r1z - 1u; z <= r1z + 1u; z++) {
      for (var x = r1x - 14u; x < r1x - 5u; x++) {
        level[lidx(x, z)] = 0u;
      }
    }
    for (var z = r1z - 6u; z <= r1z + 6u; z++) {
      for (var x = r1x - 22u; x <= r1x - 14u; x++) {
        if (z == r1z - 6u || z == r1z + 6u || x == r1x - 22u || x == r1x - 14u) {
          level[lidx(x, z)] = 9u; // skull walls
        } else {
          level[lidx(x, z)] = 0u;
        }
      }
    }
    level[lidx(r1x - 14u, r1z)] = 4u;

    // Room 6 — secret room behind west
    for (var z = r1z - 2u; z <= r1z + 2u; z++) {
      for (var x = r1x - 28u; x <= r1x - 22u; x++) {
        if (z == r1z - 2u || z == r1z + 2u || x == r1x - 28u) {
          level[lidx(x, z)] = 8u; // cage wall
        } else {
          level[lidx(x, z)] = 0u;
        }
      }
    }
    level[lidx(r1x - 22u, r1z)] = 4u;

    // Room 7 — northeast (vine room)
    for (var z = r1z - 18u; z <= r1z - 14u; z++) {
      for (var x = r1x + 6u; x <= r1x + 4u; x++) {
        level[lidx(x, z)] = 0u;
      }
    }
    // Corridor from north room east
    for (var z = r1z - 16u; z <= r1z - 15u; z++) {
      for (var x = r1x + 1u; x <= r1x + 12u; x++) {
        level[lidx(x, z)] = 0u;
      }
    }
    for (var z = r1z - 22u; z <= r1z - 14u; z++) {
      for (var x = r1x + 10u; x <= r1x + 18u; x++) {
        if (z == r1z - 22u || z == r1z - 14u || x == r1x + 10u || x == r1x + 18u) {
          level[lidx(x, z)] = 11u; // vine wall
        } else {
          level[lidx(x, z)] = 0u;
        }
      }
    }

    // Room 8 — southeast arena (large)
    for (var z = r1z + 5u; z < r1z + 10u; z++) {
      for (var x = r1x + 5u; x <= r1x + 7u; x++) {
        level[lidx(x, z)] = 0u; // corridor
      }
    }
    for (var z = r1z + 8u; z <= r1z + 22u; z++) {
      for (var x = r1x + 8u; x <= r1x + 26u; x++) {
        if (z == r1z + 8u || z == r1z + 22u || x == r1x + 8u || x == r1x + 26u) {
          level[lidx(x, z)] = 2u; // brick
        } else {
          level[lidx(x, z)] = 0u;
        }
      }
    }
    // Pillars in arena
    level[lidx(r1x + 12u, r1z + 12u)] = 7u;
    level[lidx(r1x + 22u, r1z + 12u)] = 7u;
    level[lidx(r1x + 12u, r1z + 18u)] = 7u;
    level[lidx(r1x + 22u, r1z + 18u)] = 7u;
    level[lidx(r1x + 17u, r1z + 15u)] = 7u;

    // Room 9 — southwest crypt
    for (var z = r1z + 4u; z <= r1z + 6u; z++) {
      for (var x = r1x - 12u; x < r1x - 5u; x++) {
        level[lidx(x, z)] = 0u;
      }
    }
    for (var z = r1z + 6u; z <= r1z + 16u; z++) {
      for (var x = r1x - 18u; x <= r1x - 10u; x++) {
        if (z == r1z + 6u || z == r1z + 16u || x == r1x - 18u || x == r1x - 10u) {
          level[lidx(x, z)] = 9u; // skull
        } else {
          level[lidx(x, z)] = 0u;
        }
      }
    }
    level[lidx(r1x - 10u, r1z + 6u)] = 4u; // door

    // Add barrels scattered around
    level[lidx(r1x + 16u, r1z + 10u)] = 6u;
    level[lidx(r1x + 20u, r1z + 20u)] = 6u;
    level[lidx(r1x - 15u, r1z + 10u)] = 6u;
    level[lidx(r1x - 4u, r1z + 15u)] = 6u;

    // Exit switch in northeast vine room
    level[lidx(r1x + 14u, r1z - 22u)] = 5u;

    // ── Place entities ──
    // Format: type, x, z, hp, state, timer, dir, speed
    // Types: 1=imp, 2=demon, 3=zombie, 4=cacodemon, 5=baron
    //        10=health, 11=armor, 12=ammo, 13=shotgun, 14=chaingun
    var ei = 0u;

    // Imps in north room
    entities[ei * ENT_STRIDE + 0u] = 1.0; entities[ei * ENT_STRIDE + 1u] = f32(r1x) - 3.0;
    entities[ei * ENT_STRIDE + 2u] = f32(r1z) - 16.0; entities[ei * ENT_STRIDE + 3u] = 60.0;
    entities[ei * ENT_STRIDE + 4u] = 0.0; entities[ei * ENT_STRIDE + 5u] = 0.0;
    entities[ei * ENT_STRIDE + 6u] = 0.0; entities[ei * ENT_STRIDE + 7u] = 2.0; ei++;

    entities[ei * ENT_STRIDE + 0u] = 1.0; entities[ei * ENT_STRIDE + 1u] = f32(r1x) + 3.0;
    entities[ei * ENT_STRIDE + 2u] = f32(r1z) - 16.0; entities[ei * ENT_STRIDE + 3u] = 60.0;
    entities[ei * ENT_STRIDE + 4u] = 0.0; entities[ei * ENT_STRIDE + 5u] = 0.0;
    entities[ei * ENT_STRIDE + 6u] = 0.0; entities[ei * ENT_STRIDE + 7u] = 2.0; ei++;

    // Demons in east tech room
    entities[ei * ENT_STRIDE + 0u] = 2.0; entities[ei * ENT_STRIDE + 1u] = f32(r1x) + 18.0;
    entities[ei * ENT_STRIDE + 2u] = f32(r1z) - 2.0; entities[ei * ENT_STRIDE + 3u] = 150.0;
    entities[ei * ENT_STRIDE + 4u] = 0.0; entities[ei * ENT_STRIDE + 5u] = 0.0;
    entities[ei * ENT_STRIDE + 6u] = 0.0; entities[ei * ENT_STRIDE + 7u] = 3.5; ei++;

    entities[ei * ENT_STRIDE + 0u] = 2.0; entities[ei * ENT_STRIDE + 1u] = f32(r1x) + 20.0;
    entities[ei * ENT_STRIDE + 2u] = f32(r1z) + 2.0; entities[ei * ENT_STRIDE + 3u] = 150.0;
    entities[ei * ENT_STRIDE + 4u] = 0.0; entities[ei * ENT_STRIDE + 5u] = 0.0;
    entities[ei * ENT_STRIDE + 6u] = 0.0; entities[ei * ENT_STRIDE + 7u] = 3.5; ei++;

    // Zombies in south nukage room
    entities[ei * ENT_STRIDE + 0u] = 3.0; entities[ei * ENT_STRIDE + 1u] = f32(r1x) - 4.0;
    entities[ei * ENT_STRIDE + 2u] = f32(r1z) + 15.0; entities[ei * ENT_STRIDE + 3u] = 30.0;
    entities[ei * ENT_STRIDE + 4u] = 0.0; entities[ei * ENT_STRIDE + 5u] = 0.0;
    entities[ei * ENT_STRIDE + 6u] = 0.0; entities[ei * ENT_STRIDE + 7u] = 1.5; ei++;

    entities[ei * ENT_STRIDE + 0u] = 3.0; entities[ei * ENT_STRIDE + 1u] = f32(r1x) + 4.0;
    entities[ei * ENT_STRIDE + 2u] = f32(r1z) + 15.0; entities[ei * ENT_STRIDE + 3u] = 30.0;
    entities[ei * ENT_STRIDE + 4u] = 0.0; entities[ei * ENT_STRIDE + 5u] = 0.0;
    entities[ei * ENT_STRIDE + 6u] = 0.0; entities[ei * ENT_STRIDE + 7u] = 1.5; ei++;

    entities[ei * ENT_STRIDE + 0u] = 3.0; entities[ei * ENT_STRIDE + 1u] = f32(r1x);
    entities[ei * ENT_STRIDE + 2u] = f32(r1z) + 18.0; entities[ei * ENT_STRIDE + 3u] = 30.0;
    entities[ei * ENT_STRIDE + 4u] = 0.0; entities[ei * ENT_STRIDE + 5u] = 0.0;
    entities[ei * ENT_STRIDE + 6u] = 0.0; entities[ei * ENT_STRIDE + 7u] = 1.5; ei++;

    // Cacodemon in west skull room
    entities[ei * ENT_STRIDE + 0u] = 4.0; entities[ei * ENT_STRIDE + 1u] = f32(r1x) - 18.0;
    entities[ei * ENT_STRIDE + 2u] = f32(r1z); entities[ei * ENT_STRIDE + 3u] = 400.0;
    entities[ei * ENT_STRIDE + 4u] = 0.0; entities[ei * ENT_STRIDE + 5u] = 0.0;
    entities[ei * ENT_STRIDE + 6u] = 0.0; entities[ei * ENT_STRIDE + 7u] = 4.0; ei++;

    // Baron of Hell in arena
    entities[ei * ENT_STRIDE + 0u] = 5.0; entities[ei * ENT_STRIDE + 1u] = f32(r1x) + 17.0;
    entities[ei * ENT_STRIDE + 2u] = f32(r1z) + 15.0; entities[ei * ENT_STRIDE + 3u] = 1000.0;
    entities[ei * ENT_STRIDE + 4u] = 0.0; entities[ei * ENT_STRIDE + 5u] = 0.0;
    entities[ei * ENT_STRIDE + 6u] = 0.0; entities[ei * ENT_STRIDE + 7u] = 2.5; ei++;

    // More imps in arena
    entities[ei * ENT_STRIDE + 0u] = 1.0; entities[ei * ENT_STRIDE + 1u] = f32(r1x) + 12.0;
    entities[ei * ENT_STRIDE + 2u] = f32(r1z) + 10.0; entities[ei * ENT_STRIDE + 3u] = 60.0;
    entities[ei * ENT_STRIDE + 4u] = 0.0; entities[ei * ENT_STRIDE + 5u] = 0.0;
    entities[ei * ENT_STRIDE + 6u] = 0.0; entities[ei * ENT_STRIDE + 7u] = 2.0; ei++;

    entities[ei * ENT_STRIDE + 0u] = 1.0; entities[ei * ENT_STRIDE + 1u] = f32(r1x) + 22.0;
    entities[ei * ENT_STRIDE + 2u] = f32(r1z) + 20.0; entities[ei * ENT_STRIDE + 3u] = 60.0;
    entities[ei * ENT_STRIDE + 4u] = 0.0; entities[ei * ENT_STRIDE + 5u] = 0.0;
    entities[ei * ENT_STRIDE + 6u] = 0.0; entities[ei * ENT_STRIDE + 7u] = 2.0; ei++;

    // Zombies in southwest crypt
    entities[ei * ENT_STRIDE + 0u] = 3.0; entities[ei * ENT_STRIDE + 1u] = f32(r1x) - 14.0;
    entities[ei * ENT_STRIDE + 2u] = f32(r1z) + 10.0; entities[ei * ENT_STRIDE + 3u] = 30.0;
    entities[ei * ENT_STRIDE + 4u] = 0.0; entities[ei * ENT_STRIDE + 5u] = 0.0;
    entities[ei * ENT_STRIDE + 6u] = 0.0; entities[ei * ENT_STRIDE + 7u] = 1.5; ei++;

    entities[ei * ENT_STRIDE + 0u] = 3.0; entities[ei * ENT_STRIDE + 1u] = f32(r1x) - 16.0;
    entities[ei * ENT_STRIDE + 2u] = f32(r1z) + 14.0; entities[ei * ENT_STRIDE + 3u] = 30.0;
    entities[ei * ENT_STRIDE + 4u] = 0.0; entities[ei * ENT_STRIDE + 5u] = 0.0;
    entities[ei * ENT_STRIDE + 6u] = 0.0; entities[ei * ENT_STRIDE + 7u] = 1.5; ei++;

    // Imp in vine room
    entities[ei * ENT_STRIDE + 0u] = 1.0; entities[ei * ENT_STRIDE + 1u] = f32(r1x) + 14.0;
    entities[ei * ENT_STRIDE + 2u] = f32(r1z) - 18.0; entities[ei * ENT_STRIDE + 3u] = 60.0;
    entities[ei * ENT_STRIDE + 4u] = 0.0; entities[ei * ENT_STRIDE + 5u] = 0.0;
    entities[ei * ENT_STRIDE + 6u] = 0.0; entities[ei * ENT_STRIDE + 7u] = 2.0; ei++;

    // ── Pickups ──
    // Health in spawn room
    entities[ei * ENT_STRIDE + 0u] = 10.0; entities[ei * ENT_STRIDE + 1u] = f32(r1x) + 2.0;
    entities[ei * ENT_STRIDE + 2u] = f32(r1z) + 2.0; entities[ei * ENT_STRIDE + 3u] = 25.0;
    entities[ei * ENT_STRIDE + 4u] = 0.0; entities[ei * ENT_STRIDE + 5u] = 0.0;
    entities[ei * ENT_STRIDE + 6u] = 0.0; entities[ei * ENT_STRIDE + 7u] = 0.0; ei++;

    // Armor in east room
    entities[ei * ENT_STRIDE + 0u] = 11.0; entities[ei * ENT_STRIDE + 1u] = f32(r1x) + 18.0;
    entities[ei * ENT_STRIDE + 2u] = f32(r1z) + 2.0; entities[ei * ENT_STRIDE + 3u] = 50.0;
    entities[ei * ENT_STRIDE + 4u] = 0.0; entities[ei * ENT_STRIDE + 5u] = 0.0;
    entities[ei * ENT_STRIDE + 6u] = 0.0; entities[ei * ENT_STRIDE + 7u] = 0.0; ei++;

    // Ammo in corridors
    entities[ei * ENT_STRIDE + 0u] = 12.0; entities[ei * ENT_STRIDE + 1u] = f32(r1x);
    entities[ei * ENT_STRIDE + 2u] = f32(r1z) - 8.0; entities[ei * ENT_STRIDE + 3u] = 20.0;
    entities[ei * ENT_STRIDE + 4u] = 0.0; entities[ei * ENT_STRIDE + 5u] = 0.0;
    entities[ei * ENT_STRIDE + 6u] = 0.0; entities[ei * ENT_STRIDE + 7u] = 0.0; ei++;

    // Shotgun in secret room
    entities[ei * ENT_STRIDE + 0u] = 13.0; entities[ei * ENT_STRIDE + 1u] = f32(r1x) - 25.0;
    entities[ei * ENT_STRIDE + 2u] = f32(r1z); entities[ei * ENT_STRIDE + 3u] = 1.0;
    entities[ei * ENT_STRIDE + 4u] = 0.0; entities[ei * ENT_STRIDE + 5u] = 0.0;
    entities[ei * ENT_STRIDE + 6u] = 0.0; entities[ei * ENT_STRIDE + 7u] = 0.0; ei++;

    // Chaingun in arena
    entities[ei * ENT_STRIDE + 0u] = 14.0; entities[ei * ENT_STRIDE + 1u] = f32(r1x) + 17.0;
    entities[ei * ENT_STRIDE + 2u] = f32(r1z) + 12.0; entities[ei * ENT_STRIDE + 3u] = 1.0;
    entities[ei * ENT_STRIDE + 4u] = 0.0; entities[ei * ENT_STRIDE + 5u] = 0.0;
    entities[ei * ENT_STRIDE + 6u] = 0.0; entities[ei * ENT_STRIDE + 7u] = 0.0; ei++;

    // Health in arena
    entities[ei * ENT_STRIDE + 0u] = 10.0; entities[ei * ENT_STRIDE + 1u] = f32(r1x) + 14.0;
    entities[ei * ENT_STRIDE + 2u] = f32(r1z) + 18.0; entities[ei * ENT_STRIDE + 3u] = 25.0;
    entities[ei * ENT_STRIDE + 4u] = 0.0; entities[ei * ENT_STRIDE + 5u] = 0.0;
    entities[ei * ENT_STRIDE + 6u] = 0.0; entities[ei * ENT_STRIDE + 7u] = 0.0; ei++;

    // Ammo in crypt
    entities[ei * ENT_STRIDE + 0u] = 12.0; entities[ei * ENT_STRIDE + 1u] = f32(r1x) - 14.0;
    entities[ei * ENT_STRIDE + 2u] = f32(r1z) + 12.0; entities[ei * ENT_STRIDE + 3u] = 20.0;
    entities[ei * ENT_STRIDE + 4u] = 0.0; entities[ei * ENT_STRIDE + 5u] = 0.0;
    entities[ei * ENT_STRIDE + 6u] = 0.0; entities[ei * ENT_STRIDE + 7u] = 0.0; ei++;

    // Store entity count
    flags[1] = ei;
    flags[0] = 1u;
  }

;; ═══════════════════════════════════════════════════════════════════
;; PHYSICS + AI — player movement, collision, enemy AI, shooting
;; ═══════════════════════════════════════════════════════════════════
@shader doom_physics
  #import doom_lib
  struct Cam {
    px:f32, pz:f32, yaw:f32, pitch:f32,
    vy:f32, hp:f32, armor:f32, ammo:f32,
    weapon:f32, bobphase:f32, bobamp:f32, init:f32,
    shoot_cd:f32, hurt_flash:f32, kills:f32, sprint_state:f32
  };
  struct Inp {
    time:f32, dt:f32, res:vec2f, mdx:f32, mdy:f32,
    movex:f32, movey:f32, movez:f32, locked:f32,
    fov:f32, sens:f32, menuopen:f32, sprint:f32,
    mousebtns:f32, selweap:f32, pad0:f32
  };
  @group(0) @binding(0) var<storage, read_write> cam: Cam;
  @group(0) @binding(1) var<storage, read> level: array<u32>;
  @group(0) @binding(2) var<storage, read_write> entities: array<f32>;
  @group(0) @binding(3) var<storage, read> flags: array<u32>;
  @group(1) @binding(0) var<uniform> inp: Inp;

  const LW: u32 = 64u;
  const LH: u32 = 64u;
  const PLAYER_R: f32 = 0.3;
  const WALK_SPD: f32 = 5.0;
  const RUN_SPD: f32 = 9.0;
  const MOUSE_SENS: f32 = 0.003;
  const PITCH_LIMIT: f32 = 1.2;
  const ENT_STRIDE: u32 = 8u;

  fn lidx(x: u32, z: u32) -> u32 { return x + z * LW; }

  fn is_wall(x: i32, z: i32) -> bool {
    if (x < 0 || x >= i32(LW) || z < 0 || z >= i32(LH)) { return true; }
    let t = level[lidx(u32(x), u32(z))] & 0xFFFFu;
    return t >= 1u && t <= 11u && t != 4u && t != 6u; // walls/pillars block, doors/barrels don't
  }

  fn is_solid_move(x: i32, z: i32) -> bool {
    if (x < 0 || x >= i32(LW) || z < 0 || z >= i32(LH)) { return true; }
    let t = level[lidx(u32(x), u32(z))] & 0xFFFFu;
    // Walls and pillars block. Doors let through. Barrels block.
    return (t >= 1u && t <= 3u) || t == 5u || t == 6u || t == 7u || (t >= 8u && t <= 11u);
  }

  fn collides_player(px: f32, pz: f32) -> bool {
    // Check 4 corners of AABB around player circle
    let r = PLAYER_R;
    if (is_solid_move(i32(floor(px - r)), i32(floor(pz - r)))) { return true; }
    if (is_solid_move(i32(floor(px + r)), i32(floor(pz - r)))) { return true; }
    if (is_solid_move(i32(floor(px - r)), i32(floor(pz + r)))) { return true; }
    if (is_solid_move(i32(floor(px + r)), i32(floor(pz + r)))) { return true; }
    return false;
  }

  // DDA line-of-sight check (2D)
  fn has_los(x0: f32, z0: f32, x1: f32, z1: f32) -> bool {
    let dx = x1 - x0; let dz = z1 - z0;
    let dist = sqrt(dx * dx + dz * dz);
    if (dist < 0.01) { return true; }
    let steps = i32(ceil(dist * 2.0));
    for (var i = 0; i < steps; i++) {
      let t = f32(i) / f32(steps);
      let cx = x0 + dx * t;
      let cz = z0 + dz * t;
      if (is_wall(i32(floor(cx)), i32(floor(cz)))) { return false; }
    }
    return true;
  }

  @compute @workgroup_size(1)
  fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
    let dt = clamp(inp.dt, 0.0001, 0.05);

    // Initialize
    if (cam.init < 0.5) {
      cam.px = 32.0;
      cam.pz = 32.0;
      cam.yaw = 0.0;
      cam.pitch = 0.0;
      cam.hp = 100.0;
      cam.armor = 0.0;
      cam.ammo = 50.0;
      cam.weapon = 1.0; // 1=pistol, 2=shotgun, 3=chaingun
      cam.bobphase = 0.0;
      cam.bobamp = 0.0;
      cam.init = 1.0;
      cam.shoot_cd = 0.0;
      cam.hurt_flash = 0.0;
      cam.kills = 0.0;
      cam.sprint_state = 0.0;
      return;
    }

    if (cam.hp <= 0.0) { return; } // Dead — no updates

    // Cooldowns
    cam.shoot_cd = max(0.0, cam.shoot_cd - dt);
    cam.hurt_flash = max(0.0, cam.hurt_flash - dt * 3.0);

    // Sprint
    let is_sprinting = inp.sprint > 0.5 && abs(inp.movez) > 0.1;
    cam.sprint_state = select(0.0, 1.0, is_sprinting);
    let spd = select(WALK_SPD, RUN_SPD, is_sprinting);

    // Mouse look
    if (inp.locked > 0.5 && inp.menuopen < 0.5) {
      cam.yaw += inp.mdx * MOUSE_SENS * inp.sens;
      cam.pitch = clamp(cam.pitch - inp.mdy * MOUSE_SENS * inp.sens, -PITCH_LIMIT, PITCH_LIMIT);
    }

    // Movement
    if (inp.locked > 0.5 && inp.menuopen < 0.5) {
      let cy = cos(cam.yaw); let sy = sin(cam.yaw);
      let dx = (sy * (-inp.movez) + cy * inp.movex) * spd * dt;
      let dz = (cy * (-inp.movez) - sy * inp.movex) * spd * dt;

      // Slide along walls (axis-separated)
      var nx = cam.px + dx;
      if (!collides_player(nx, cam.pz)) { cam.px = nx; }
      var nz = cam.pz + dz;
      if (!collides_player(cam.px, nz)) { cam.pz = nz; }
    }

    // Head bob
    let moving = abs(inp.movex) + abs(inp.movez);
    if (moving > 0.1) {
      let bob_freq = select(7.0, 10.0, is_sprinting);
      cam.bobphase += dt * bob_freq;
      cam.bobamp = mix(cam.bobamp, select(0.025, 0.045, is_sprinting), dt * 10.0);
    } else {
      cam.bobamp = mix(cam.bobamp, 0.0, dt * 8.0);
    }

    // Clamp to map
    cam.px = clamp(cam.px, 1.5, f32(LW) - 1.5);
    cam.pz = clamp(cam.pz, 1.5, f32(LH) - 1.5);

    // ── Shooting ──
    let ent_count = flags[1];
    if (inp.mousebtns > 0.5 && inp.locked > 0.5 && inp.menuopen < 0.5 && cam.shoot_cd <= 0.0 && cam.ammo > 0.0) {
      // Fire rate depends on weapon
      let fire_rate = select(select(0.35, 0.8, cam.weapon > 1.5), 0.08, cam.weapon > 2.5);
      let ammo_cost = select(select(1.0, 1.0, cam.weapon > 1.5), 1.0, cam.weapon > 2.5);
      let damage = select(select(15.0, 70.0, cam.weapon > 1.5), 12.0, cam.weapon > 2.5);

      cam.shoot_cd = fire_rate;
      cam.ammo = max(0.0, cam.ammo - ammo_cost);

      // Hitscan ray in look direction
      let fwd_x = sin(cam.yaw) * cos(cam.pitch);
      let fwd_z = cos(cam.yaw) * cos(cam.pitch);
      var best_dist = 999.0;
      var best_ent = -1;

      for (var i = 0u; i < min(ent_count, 128u); i++) {
        let etype = entities[i * ENT_STRIDE];
        if (etype < 1.0 || etype > 5.0) { continue; } // only enemies
        let ehp = entities[i * ENT_STRIDE + 3u];
        if (ehp <= 0.0) { continue; } // dead

        let ex = entities[i * ENT_STRIDE + 1u];
        let ez = entities[i * ENT_STRIDE + 2u];
        let dx = ex - cam.px; let dz = ez - cam.pz;
        let dist = sqrt(dx * dx + dz * dz);

        if (dist < 1.0 || dist > 40.0) { continue; }

        // Angle to enemy
        let angle_to = atan2(dx, dz);
        var angle_diff = angle_to - cam.yaw;
        // Normalize to -PI..PI
        angle_diff = angle_diff - floor((angle_diff + 3.14159) / 6.28318) * 6.28318;

        // Hit width depends on distance (perspective)
        let hit_angle = atan2(0.5, dist); // ~0.5 unit radius

        // Shotgun has spread
        let spread = select(select(0.02, 0.08, cam.weapon > 1.5), 0.04, cam.weapon > 2.5);

        if (abs(angle_diff) < hit_angle + spread && dist < best_dist) {
          if (has_los(cam.px, cam.pz, ex, ez)) {
            best_dist = dist;
            best_ent = i32(i);
          }
        }
      }

      // Apply damage
      if (best_ent >= 0) {
        let bi = u32(best_ent);
        var hp = entities[bi * ENT_STRIDE + 3u];
        hp -= damage;
        entities[bi * ENT_STRIDE + 3u] = hp;
        if (hp <= 0.0) {
          entities[bi * ENT_STRIDE + 4u] = 2.0; // state = dying
          entities[bi * ENT_STRIDE + 5u] = 0.5; // death timer
          cam.kills += 1.0;
        } else {
          entities[bi * ENT_STRIDE + 4u] = 1.0; // state = alert/hurt
          entities[bi * ENT_STRIDE + 5u] = 0.2; // hurt flash
        }
      }
    }

    // ── Entity AI ──
    for (var i = 0u; i < min(ent_count, 128u); i++) {
      let etype = entities[i * ENT_STRIDE];
      if (etype < 1.0 || etype > 5.0) { continue; } // only enemies
      var ehp = entities[i * ENT_STRIDE + 3u];
      var estate = entities[i * ENT_STRIDE + 4u];
      var etimer = entities[i * ENT_STRIDE + 5u];
      var edir = entities[i * ENT_STRIDE + 6u];
      let espeed = entities[i * ENT_STRIDE + 7u];
      var ex = entities[i * ENT_STRIDE + 1u];
      var ez = entities[i * ENT_STRIDE + 2u];

      // Dead — decay timer
      if (ehp <= 0.0) {
        etimer -= dt;
        if (etimer < -2.0) {
          entities[i * ENT_STRIDE] = 0.0; // remove
        }
        entities[i * ENT_STRIDE + 5u] = etimer;
        continue;
      }

      // Hurt flash decay
      if (estate > 0.5 && estate < 1.5) {
        etimer -= dt;
        if (etimer <= 0.0) { estate = 0.0; }
      }

      let dx = cam.px - ex; let dz = cam.pz - ez;
      let dist = sqrt(dx * dx + dz * dz);

      // Detection: alert if player within range and has LOS
      let detect_range = select(select(12.0, 15.0, etype > 1.5), 20.0, etype > 3.5);
      if (dist < detect_range && has_los(ex, ez, cam.px, cam.pz)) {
        estate = max(estate, 1.0); // alert

        // Move toward player
        let angle_to = atan2(dx, dz);
        edir = angle_to;

        let move_speed = espeed * dt;
        let mx = sin(edir) * move_speed;
        let mz = cos(edir) * move_speed;

        // Only move if not too close
        if (dist > 1.5) {
          let nmx = ex + mx;
          let nmz = ez + mz;
          if (!is_wall(i32(floor(nmx)), i32(floor(ez)))) { ex = nmx; }
          if (!is_wall(i32(floor(ex)), i32(floor(nmz)))) { ez = nmz; }
        }

        // Attack: melee or ranged depending on type
        etimer -= dt;
        if (etimer <= 0.0) {
          // Damage player
          var atk_range = 2.0;
          var atk_dmg = 5.0;
          if (etype > 0.5 && etype < 1.5) { atk_range = 8.0; atk_dmg = 5.0; etimer = 1.5; } // imp fireball
          else if (etype > 1.5 && etype < 2.5) { atk_range = 2.0; atk_dmg = 15.0; etimer = 0.8; } // demon bite
          else if (etype > 2.5 && etype < 3.5) { atk_range = 10.0; atk_dmg = 4.0; etimer = 1.2; } // zombie shot
          else if (etype > 3.5 && etype < 4.5) { atk_range = 15.0; atk_dmg = 10.0; etimer = 2.0; } // caco ball
          else if (etype > 4.5) { atk_range = 12.0; atk_dmg = 20.0; etimer = 1.5; } // baron

          if (dist < atk_range && has_los(ex, ez, cam.px, cam.pz)) {
            // Deal damage (armor absorbs 1/3)
            let absorbed = min(cam.armor, atk_dmg * 0.33);
            cam.armor = max(0.0, cam.armor - absorbed);
            cam.hp = max(0.0, cam.hp - (atk_dmg - absorbed));
            cam.hurt_flash = 1.0;
          }
        }
      }

      entities[i * ENT_STRIDE + 1u] = ex;
      entities[i * ENT_STRIDE + 2u] = ez;
      entities[i * ENT_STRIDE + 4u] = estate;
      entities[i * ENT_STRIDE + 5u] = etimer;
      entities[i * ENT_STRIDE + 6u] = edir;
    }

    // ── Pickup collection ──
    for (var i = 0u; i < min(ent_count, 128u); i++) {
      let etype = entities[i * ENT_STRIDE];
      if (etype < 10.0) { continue; } // only pickups
      let ex = entities[i * ENT_STRIDE + 1u];
      let ez = entities[i * ENT_STRIDE + 2u];
      let dx = cam.px - ex; let dz = cam.pz - ez;
      let dist = sqrt(dx * dx + dz * dz);

      if (dist < 1.0) {
        let amt = entities[i * ENT_STRIDE + 3u];
        if (etype > 9.5 && etype < 10.5) { cam.hp = min(200.0, cam.hp + amt); }
        else if (etype > 10.5 && etype < 11.5) { cam.armor = min(200.0, cam.armor + amt); }
        else if (etype > 11.5 && etype < 12.5) { cam.ammo = min(200.0, cam.ammo + amt); }
        else if (etype > 12.5 && etype < 13.5) { cam.weapon = max(cam.weapon, 2.0); cam.ammo = min(200.0, cam.ammo + 8.0); }
        else if (etype > 13.5 && etype < 14.5) { cam.weapon = max(cam.weapon, 3.0); cam.ammo = min(200.0, cam.ammo + 20.0); }
        entities[i * ENT_STRIDE] = 0.0; // consumed
      }
    }

    // Nukage damage — check floor type at player position
    let player_tile = level[lidx(u32(floor(cam.px)), u32(floor(cam.pz)))];
    let floor_type = (player_tile >> 16u) & 0xFFu;
    if (floor_type == 1u) { // nukage
      cam.hp -= 3.0 * dt;
      cam.hurt_flash = max(cam.hurt_flash, 0.3);
    }
  }

;; ═══════════════════════════════════════════════════════════════════
;; RENDER — 2.5D raycasting with textured walls, floor/ceiling,
;;          enemies as billboarded sprites, lighting
;; ═══════════════════════════════════════════════════════════════════
@shader doom_render
  #import doom_lib
  struct DoomInp {
    time:f32, dt:f32, res:vec2f, mdx:f32, mdy:f32,
    movex:f32, movey:f32, movez:f32, locked:f32,
    fov:f32, sens:f32, menuopen:f32, sprint:f32,
    mousebtns:f32, selweap:f32, pad0:f32
  };
  struct Cam {
    px:f32, pz:f32, yaw:f32, pitch:f32,
    vy:f32, hp:f32, armor:f32, ammo:f32,
    weapon:f32, bobphase:f32, bobamp:f32, init:f32,
    shoot_cd:f32, hurt_flash:f32, kills:f32, sprint_state:f32
  };
  @group(0) @binding(0) var<uniform> u: DoomInp;
  @group(1) @binding(0) var<storage, read> cam: Cam;
  @group(1) @binding(1) var<storage, read> level: array<u32>;
  @group(1) @binding(2) var<storage, read> entities: array<f32>;
  @group(1) @binding(3) var<storage, read> flags: array<u32>;

  const LW: u32 = 64u;
  const LH: u32 = 64u;
  const ENT_STRIDE: u32 = 8u;
  const PI: f32 = 3.14159265;
  const WALL_H: f32 = 1.0;      // wall height in world units
  const EYE_H: f32 = 0.5;       // eye height

  fn lidx(x: u32, z: u32) -> u32 { return x + z * LW; }

  fn get_tile(x: i32, z: i32) -> u32 {
    if (x < 0 || x >= i32(LW) || z < 0 || z >= i32(LH)) { return 1u; }
    return level[lidx(u32(x), u32(z))] & 0xFFFFu;
  }

  fn is_wall_tile(t: u32) -> bool {
    return (t >= 1u && t <= 3u) || t == 5u || (t >= 7u && t <= 11u);
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

  // ── Procedural wall textures ──
  fn stone_wall_tex(uv: vec2f, light: f32) -> vec3f {
    let px = floor(uv * 16.0);
    let h = d_hash(px);
    let sub = fract(uv * 16.0);
    let crack = smoothstep(0.0, 0.08, abs(sub.x - 0.5)) * smoothstep(0.0, 0.08, abs(sub.y - 0.5));
    let base = vec3f(0.35, 0.33, 0.30) * (0.85 + h * 0.15) * mix(0.75, 1.0, crack);
    return base * light;
  }

  fn brick_wall_tex(uv: vec2f, light: f32) -> vec3f {
    var buv = uv * vec2f(4.0, 8.0);
    // Offset every other row
    if (fract(buv.y * 0.5) > 0.5) { buv.x += 0.5; }
    let brick = fract(buv);
    let mortar_x = smoothstep(0.0, 0.06, brick.x) * smoothstep(0.0, 0.06, 1.0 - brick.x);
    let mortar_y = smoothstep(0.0, 0.08, brick.y) * smoothstep(0.0, 0.08, 1.0 - brick.y);
    let mortar = mortar_x * mortar_y;
    let bid = floor(buv);
    let h = d_hash(bid);
    let brick_col = vec3f(0.55 + h * 0.1, 0.18 + h * 0.08, 0.12 + h * 0.05);
    let mortar_col = vec3f(0.4, 0.38, 0.35);
    return mix(mortar_col, brick_col, mortar) * light;
  }

  fn tech_wall_tex(uv: vec2f, t: f32, light: f32) -> vec3f {
    let px = floor(uv * 16.0);
    let sub = fract(uv * 16.0);
    let h = d_hash(px);
    // Metal panel grid
    let panel = smoothstep(0.0, 0.05, sub.x) * smoothstep(0.0, 0.05, 1.0 - sub.x) *
                smoothstep(0.0, 0.05, sub.y) * smoothstep(0.0, 0.05, 1.0 - sub.y);
    let base = vec3f(0.25, 0.28, 0.32) * (0.9 + h * 0.1) * mix(0.7, 1.0, panel);
    // Blinking light strip
    let strip = step(0.85, uv.y) * step(uv.y, 0.95);
    let blink = sin(t * 3.0 + uv.x * 8.0) * 0.5 + 0.5;
    let glow = vec3f(0.1, 0.8, 0.3) * strip * blink;
    return base * light + glow;
  }

  fn door_tex(uv: vec2f, light: f32) -> vec3f {
    let px = floor(uv * 8.0);
    let sub = fract(uv * 8.0);
    let h = d_hash(px);
    // Metal door with rivets
    let panel = smoothstep(0.0, 0.04, sub.x) * smoothstep(0.0, 0.04, 1.0 - sub.x);
    let base = vec3f(0.3, 0.28, 0.25) * (0.85 + h * 0.15) * mix(0.8, 1.0, panel);
    // Vertical dividing line
    let center = smoothstep(0.48, 0.50, abs(uv.x - 0.5));
    // Rivets
    let rivet_uv = fract(uv * vec2f(8.0, 4.0)) - 0.5;
    let rivet = 1.0 - smoothstep(0.05, 0.12, length(rivet_uv));
    return (base * center + vec3f(0.4, 0.38, 0.35) * rivet * 0.3) * light;
  }

  fn skull_wall_tex(uv: vec2f, light: f32) -> vec3f {
    let base = stone_wall_tex(uv, 1.0);
    // Skull face pattern
    let c = (uv - 0.5) * 2.0;
    let face = smoothstep(0.5, 0.45, length(c * vec2f(0.8, 1.0)));
    let eye_l = smoothstep(0.12, 0.08, length(c - vec2f(-0.2, 0.15)));
    let eye_r = smoothstep(0.12, 0.08, length(c - vec2f(0.2, 0.15)));
    let mouth = smoothstep(0.08, 0.04, abs(c.y + 0.15)) * step(abs(c.x), 0.15);
    let skull = face * vec3f(0.7, 0.68, 0.6) - (eye_l + eye_r) * vec3f(0.5) - mouth * vec3f(0.3);
    return mix(base, max(skull, vec3f(0.05)), face) * light;
  }

  fn blood_wall_tex(uv: vec2f, light: f32) -> vec3f {
    let base = stone_wall_tex(uv, 1.0);
    // Dripping blood streaks
    let streak_x = d_hash(vec2f(floor(uv.x * 8.0), 0.0));
    if (streak_x > 0.6) {
      let drip_len = d_hash(vec2f(floor(uv.x * 8.0), 1.0)) * 0.7 + 0.3;
      let drip = smoothstep(0.0, drip_len, 1.0 - uv.y) * smoothstep(0.0, 0.06, 0.5 - abs(fract(uv.x * 8.0) - 0.5));
      return mix(base, vec3f(0.5, 0.05, 0.02), drip) * light;
    }
    return base * light;
  }

  fn vine_wall_tex(uv: vec2f, t: f32, light: f32) -> vec3f {
    let base = stone_wall_tex(uv, 1.0);
    // Vine tendrils
    let vine_x = sin(uv.y * 12.0 + d_hash(vec2f(floor(uv.x * 3.0), 0.0)) * 6.0) * 0.1 + uv.x;
    let vine_mask = smoothstep(0.08, 0.0, abs(fract(vine_x * 3.0) - 0.5));
    let vine_col = vec3f(0.15, 0.4 + sin(t * 0.5) * 0.05, 0.1);
    return mix(base, vine_col, vine_mask * 0.7) * light;
  }

  fn cage_wall_tex(uv: vec2f, light: f32) -> vec3f {
    let bars_x = smoothstep(0.08, 0.12, abs(fract(uv.x * 6.0) - 0.5));
    let bars_y = smoothstep(0.08, 0.12, abs(fract(uv.y * 6.0) - 0.5));
    let cage = max(1.0 - bars_x, 1.0 - bars_y);
    let metal = vec3f(0.35, 0.33, 0.30);
    let dark = vec3f(0.05, 0.04, 0.03);
    return mix(dark, metal, cage) * light;
  }

  fn wall_color(wtype: u32, uv: vec2f, t: f32, light: f32) -> vec3f {
    if (wtype == 1u) { return stone_wall_tex(uv, light); }
    if (wtype == 2u) { return brick_wall_tex(uv, light); }
    if (wtype == 3u) { return tech_wall_tex(uv, t, light); }
    if (wtype == 4u) { return door_tex(uv, light); }
    if (wtype == 5u) { return tech_wall_tex(uv, t, light) * vec3f(1.2, 0.3, 0.3); } // exit: red tech
    if (wtype == 7u) { return stone_wall_tex(uv, light) * vec3f(0.8, 0.78, 0.75); } // pillar: lighter stone
    if (wtype == 8u) { return cage_wall_tex(uv, light); }
    if (wtype == 9u) { return skull_wall_tex(uv, light); }
    if (wtype == 10u) { return blood_wall_tex(uv, light); }
    if (wtype == 11u) { return vine_wall_tex(uv, t, light); }
    return vec3f(0.5) * light;
  }

  // ── Floor textures ──
  fn floor_color(fx: f32, fz: f32, floor_t: u32, t: f32) -> vec3f {
    let px = floor(vec2f(fx, fz) * 4.0);
    let h = d_hash(px);
    if (floor_t == 1u) {
      // Nukage — glowing green with animated wobble
      let wobble = sin(t * 2.0 + fx * 3.0) * 0.5 + 0.5;
      return vec3f(0.05, 0.25 + wobble * 0.15, 0.03) + vec3f(0.0, h * 0.08, 0.0);
    }
    if (floor_t == 2u) {
      // Metal grating
      let grid = step(0.1, fract(fx * 4.0)) * step(0.1, fract(fz * 4.0));
      return vec3f(0.3, 0.28, 0.25) * (0.7 + grid * 0.3);
    }
    // Default stone floor — checkerboard with noise
    let check = select(0.8, 1.0, (i32(floor(fx)) + i32(floor(fz))) % 2 == 0);
    return vec3f(0.22, 0.20, 0.18) * (0.85 + h * 0.15) * check;
  }

  fn ceiling_color(cx: f32, cz: f32) -> vec3f {
    let px = floor(vec2f(cx, cz) * 4.0);
    let h = d_hash(px);
    return vec3f(0.18, 0.17, 0.16) * (0.9 + h * 0.1);
  }

  // ── DDA 2D raycaster ──
  struct RayHit {
    dist: f32,
    wtype: u32,
    side: f32,    // 0=X face, 1=Z face
    wall_x: f32,  // hit position along wall (0..1) for texturing
  };

  // DDA 2D — branchless offset-accumulation pattern (use.gpu style)
  fn cast_ray(ox: f32, oz: f32, dx: f32, dz: f32) -> RayHit {
    var hit: RayHit;
    hit.dist = 64.0;
    hit.wtype = 0u;

    let signs = vec2f(sign(dx), sign(dz));
    let signI = vec2i(signs);
    let signF = -signs;
    let baseF = max(vec2f(0.0), signs);
    let invAbs = 1.0001 / max(abs(vec2f(dx, dz)), vec2f(1e-5));

    let fl = floor(vec2f(ox, oz));
    var offset = (baseF + (vec2f(ox, oz) - fl) * signF) * invAbs;
    var uvw = vec2i(fl);
    var dist = 0.0;
    var axis = vec2f(0.0);

    for (var i = 0; i < 96; i++) {
      // Axis selection — pick whichever boundary is closer
      axis = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), offset.x <= offset.y);
      dist = dot(axis, offset);
      if (dist > 64.0) { break; }
      offset += invAbs * axis;
      uvw += signI * vec2i(axis);

      if (uvw.x < 0 || uvw.x >= i32(LW) || uvw.y < 0 || uvw.y >= i32(LH)) { break; }
      let t = get_tile(uvw.x, uvw.y);
      if (is_wall_tile(t) || t == 4u || t == 6u) {
        hit.dist = dist;
        hit.wtype = t;
        hit.side = axis.y; // 0=X face, 1=Z face
        // Wall UV: reconstruct hit position
        let wp = vec2f(ox, oz) + vec2f(dx, dz) * dist;
        hit.wall_x = select(fract(wp.y), fract(wp.x), axis.y > 0.5);
        return hit;
      }
    }
    return hit;
  }

  // ── Sprite rendering helper ──
  fn entity_color(etype: f32, estate: f32, ehp: f32, uv: vec2f, t: f32) -> vec4f {
    // Generate billboarded sprite procedurally
    let c = (uv - 0.5) * 2.0; // -1..1
    var col = vec4f(0.0);

    // Dead entities: flatten
    if (ehp <= 0.0) {
      if (abs(c.y + 0.8) < 0.2 && abs(c.x) < 0.6) {
        return vec4f(0.3, 0.05, 0.02, 1.0); // blood puddle
      }
      return vec4f(0.0);
    }

    let eti = u32(etype);

    // Imp (brown/orange, fireball throwing)
    if (eti == 1u) {
      let body = smoothstep(0.6, 0.55, length(c * vec2f(0.8, 0.6)));
      let head = smoothstep(0.35, 0.30, length(c - vec2f(0.0, 0.45)));
      let eye_l = smoothstep(0.08, 0.04, length(c - vec2f(-0.12, 0.52)));
      let eye_r = smoothstep(0.08, 0.04, length(c - vec2f(0.12, 0.52)));
      let body_col = vec3f(0.55, 0.3, 0.15);
      let hurt = select(0.0, sin(t * 30.0) * 0.5 + 0.5, estate > 0.5 && estate < 1.5);
      col = vec4f(mix(body_col, vec3f(1.0, 0.2, 0.1), hurt), max(body, head));
      col = vec4f(col.rgb - vec3f(eye_l + eye_r) * vec3f(0.3, 0.0, 0.0), col.a);
      col.r += (eye_l + eye_r) * 0.8; // red eyes
    }
    // Demon (pink/brown, melee)
    else if (eti == 2u) {
      let body = smoothstep(0.7, 0.65, length(c * vec2f(0.7, 0.55)));
      let head = smoothstep(0.4, 0.35, length(c - vec2f(0.0, 0.35)));
      let jaw = smoothstep(0.15, 0.10, length(c - vec2f(0.0, 0.15)));
      let body_col = vec3f(0.6, 0.25, 0.3);
      let hurt = select(0.0, sin(t * 30.0) * 0.5 + 0.5, estate > 0.5 && estate < 1.5);
      col = vec4f(mix(body_col, vec3f(1.0, 0.3, 0.3), hurt), max(body, head));
      col.g -= jaw * 0.2;
    }
    // Zombie (green/grey, hitscan)
    else if (eti == 3u) {
      let body = smoothstep(0.55, 0.50, length(c * vec2f(0.85, 0.6)));
      let head = smoothstep(0.28, 0.23, length(c - vec2f(0.0, 0.5)));
      let body_col = vec3f(0.3, 0.35, 0.25);
      let hurt = select(0.0, sin(t * 30.0) * 0.5 + 0.5, estate > 0.5 && estate < 1.5);
      col = vec4f(mix(body_col, vec3f(0.8, 0.2, 0.1), hurt), max(body, head));
    }
    // Cacodemon (red sphere, floating)
    else if (eti == 4u) {
      let r = length(c);
      let sphere = smoothstep(0.7, 0.65, r);
      let eye = smoothstep(0.2, 0.15, length(c - vec2f(0.0, 0.15)));
      let pupil = smoothstep(0.08, 0.04, length(c - vec2f(0.0, 0.15)));
      // 3D shading on sphere
      let shade = clamp(dot(normalize(vec3f(c, sqrt(max(0.0, 0.49 - r * r)))), vec3f(0.3, 0.5, 0.8)), 0.3, 1.0);
      let hurt = select(0.0, sin(t * 30.0) * 0.5 + 0.5, estate > 0.5 && estate < 1.5);
      let body_col = mix(vec3f(0.7, 0.15, 0.1), vec3f(1.0, 0.5, 0.2), hurt) * shade;
      col = vec4f(body_col, sphere);
      // Green eye
      col = vec4f(mix(col.rgb, vec3f(0.2, 0.9, 0.2), eye - pupil), max(col.a, eye));
      col = vec4f(mix(col.rgb, vec3f(0.0), pupil), col.a);
      // Floating bob
    }
    // Baron of Hell (big, green fireballs)
    else if (eti == 5u) {
      let body = smoothstep(0.8, 0.75, length(c * vec2f(0.6, 0.45)));
      let head = smoothstep(0.35, 0.30, length(c - vec2f(0.0, 0.55)));
      let horn_l = smoothstep(0.1, 0.06, length(c - vec2f(-0.2, 0.75)));
      let horn_r = smoothstep(0.1, 0.06, length(c - vec2f(0.2, 0.75)));
      let body_col = vec3f(0.45, 0.25, 0.2);
      let hurt = select(0.0, sin(t * 30.0) * 0.5 + 0.5, estate > 0.5 && estate < 1.5);
      col = vec4f(mix(body_col, vec3f(1.0, 0.3, 0.1), hurt), max(body, max(head, max(horn_l, horn_r))));
      col = vec4f(col.rgb + vec3f(horn_l + horn_r) * vec3f(0.3, 0.15, 0.0), col.a);
    }

    // Pickups
    if (u32(etype) == 10u) {
      // Health kit — red cross
      let box_shape = step(abs(c.x), 0.35) * step(abs(c.y), 0.35);
      let cross_h = step(abs(c.y), 0.1) * step(abs(c.x), 0.25);
      let cross_v = step(abs(c.x), 0.1) * step(abs(c.y), 0.25);
      let bob = sin(t * 3.0) * 0.03;
      col = vec4f(mix(vec3f(0.9, 0.9, 0.9), vec3f(0.9, 0.1, 0.1), max(cross_h, cross_v)), box_shape);
    }
    else if (u32(etype) == 11u) {
      // Armor — green shield
      let shield = step(length(c * vec2f(1.0, 0.8)), 0.45) * step(-c.y, 0.3);
      let inner = step(length(c * vec2f(1.0, 0.8)), 0.3) * step(-c.y, 0.2);
      col = vec4f(mix(vec3f(0.1, 0.5, 0.1), vec3f(0.2, 0.8, 0.2), inner), shield);
    }
    else if (u32(etype) == 12u) {
      // Ammo box — brown box
      let box_shape = step(abs(c.x), 0.3) * step(abs(c.y), 0.2);
      col = vec4f(vec3f(0.5, 0.35, 0.15), box_shape);
    }
    else if (u32(etype) == 13u) {
      // Shotgun — L shape
      let barrel = step(abs(c.y - 0.05), 0.05) * step(-0.3, c.x) * step(c.x, 0.4);
      let stock = step(abs(c.x + 0.1), 0.08) * step(-0.2, c.y) * step(c.y, 0.15);
      col = vec4f(vec3f(0.4, 0.35, 0.3), max(barrel, stock));
    }
    else if (u32(etype) == 14u) {
      // Chaingun — wider barrel
      let barrel = step(abs(c.y), 0.06) * step(-0.35, c.x) * step(c.x, 0.4);
      let barrel2 = step(abs(c.y - 0.08), 0.04) * step(-0.3, c.x) * step(c.x, 0.38);
      let body_s = step(abs(c.x + 0.05), 0.15) * step(abs(c.y), 0.12);
      col = vec4f(vec3f(0.35, 0.32, 0.28), max(max(barrel, barrel2), body_s));
    }

    // Barrel (type 6)
    if (u32(etype) == 6u) {
      let barrel_body = smoothstep(0.45, 0.40, length(c * vec2f(0.9, 0.6)));
      let stripe1 = step(abs(c.y - 0.15), 0.03);
      let stripe2 = step(abs(c.y + 0.15), 0.03);
      let base_col = vec3f(0.25, 0.4, 0.15);
      let stripe_col = vec3f(0.15, 0.25, 0.1);
      col = vec4f(mix(base_col, stripe_col, max(stripe1, stripe2)), barrel_body);
    }

    return col;
  }

  @fragment fn fs_main(v: VSOut) -> @location(0) vec4f {
    let bob_y = sin(cam.bobphase) * cam.bobamp;
    let bob_x = cos(cam.bobphase * 0.5) * cam.bobamp * 0.3;

    // Pitch offset for look up/down
    let pitch_offset = cam.pitch * 0.5;

    // Screen coordinates
    let aspect = u.res.x / u.res.y;
    let sx = (v.uv.x - 0.5) * aspect;
    let sy = (v.uv.y - 0.5); // -0.5 to 0.5, top to bottom

    // Per-column 2D raycast
    let ray_angle = cam.yaw + atan2(sx, 1.0 / tan(u.fov * 0.5));
    let dx = sin(ray_angle);
    let dz = cos(ray_angle);

    // Cast ray
    let hit = cast_ray(cam.px, cam.pz, dx, dz);

    // Correct for fisheye
    let perp_dist = hit.dist * cos(ray_angle - cam.yaw);

    // Wall height on screen
    let wall_h = WALL_H / (perp_dist + 0.001);
    let wall_top = 0.5 - wall_h * 0.5 + pitch_offset + bob_y * 0.5;
    let wall_bot = 0.5 + wall_h * 0.5 + pitch_offset + bob_y * 0.5;

    // Lighting: distance falloff + side shading
    let base_light = clamp(1.5 / (perp_dist * 0.3 + 1.0), 0.08, 1.0);
    let side_dim = select(1.0, 0.75, hit.side > 0.5);
    let wall_light = base_light * side_dim;

    var col = vec3f(0.0);

    // Wall texture UV
    let wall_u = hit.wall_x;

    if (v.uv.y < wall_top) {
      // ── Ceiling ──
      let ceil_dist = (0.5 - pitch_offset - bob_y * 0.5) / (0.5 - v.uv.y + 0.001);
      let fx = cam.px + dx * ceil_dist;
      let fz = cam.pz + dz * ceil_dist;
      let ceil_light = clamp(1.2 / (ceil_dist * 0.25 + 1.0), 0.05, 0.7);
      col = ceiling_color(fx, fz) * ceil_light;
    } else if (v.uv.y > wall_bot) {
      // ── Floor ──
      let floor_dist = (0.5 + pitch_offset + bob_y * 0.5) / (v.uv.y - 0.5 + 0.001);
      let fx = cam.px + dx * floor_dist;
      let fz = cam.pz + dz * floor_dist;
      let floor_light = clamp(1.2 / (floor_dist * 0.25 + 1.0), 0.05, 0.8);

      // Check floor type at this position
      let fmx = i32(floor(fx)); let fmz = i32(floor(fz));
      var floor_t = 0u;
      if (fmx >= 0 && fmx < i32(LW) && fmz >= 0 && fmz < i32(LH)) {
        floor_t = (level[lidx(u32(fmx), u32(fmz))] >> 16u) & 0xFFu;
      }
      col = floor_color(fx, fz, floor_t, u.time) * floor_light;
    } else {
      // ── Wall ──
      let wall_v = (v.uv.y - wall_top) / (wall_bot - wall_top);
      if (hit.wtype > 0u) {
        col = wall_color(hit.wtype, vec2f(wall_u, wall_v), u.time, wall_light);
      }

      // Barrel — render as half-height cylinder in the wall column
      if (hit.wtype == 6u) {
        let barrel_v = wall_v;
        if (barrel_v > 0.3 && barrel_v < 1.0) {
          let bv = (barrel_v - 0.3) / 0.7;
          let stripe1 = step(abs(bv - 0.3), 0.04);
          let stripe2 = step(abs(bv - 0.7), 0.04);
          col = mix(vec3f(0.25, 0.4, 0.15), vec3f(0.15, 0.25, 0.1), max(stripe1, stripe2)) * wall_light;
        } else {
          // Top of barrel — show floor behind
          let floor_dist = (0.5 + pitch_offset + bob_y * 0.5) / (v.uv.y - 0.5 + 0.001);
          let fx = cam.px + dx * floor_dist;
          let fz = cam.pz + dz * floor_dist;
          col = floor_color(fx, fz, 0u, u.time) * clamp(1.2 / (floor_dist * 0.25 + 1.0), 0.05, 0.8);
        }
      }
    }

    // ── Entities (billboarded sprites) ──
    // Sort by distance (simplified: just test all, draw back-to-front via depth)
    let ent_count = flags[1];
    var z_buffer = perp_dist; // wall distance for this column

    // We need to render sprites. For each sprite, check if this pixel's column overlaps.
    for (var i = 0u; i < min(ent_count, 128u); i++) {
      let etype = entities[i * ENT_STRIDE];
      if (etype < 0.5) { continue; }

      let ex = entities[i * ENT_STRIDE + 1u];
      let ez = entities[i * ENT_STRIDE + 2u];
      let ehp = entities[i * ENT_STRIDE + 3u];
      let estate = entities[i * ENT_STRIDE + 4u];

      // Transform to view space
      let rel_x = ex - cam.px;
      let rel_z = ez - cam.pz;
      let cy = cos(cam.yaw); let sy_val = sin(cam.yaw);

      // Rotate to camera space
      let view_x = rel_x * cy - rel_z * sy_val;
      let view_z = rel_x * sy_val + rel_z * cy;

      if (view_z <= 0.2) { continue; } // Behind camera
      if (view_z > z_buffer) { continue; } // Behind wall

      // Project to screen
      let proj_x = (view_x / view_z) * (1.0 / tan(u.fov * 0.5));
      let screen_x = proj_x / aspect + 0.5;

      // Sprite size on screen
      let sprite_size = select(0.8, 1.2, etype > 4.5); // Baron is bigger
      let sprite_h = sprite_size / view_z;
      let sprite_w = sprite_h / aspect;

      // Pickup bob
      var sprite_y_offset = 0.0;
      if (etype >= 10.0) {
        sprite_y_offset = sin(u.time * 3.0 + ex * 2.0) * 0.02;
      }
      // Cacodemon float
      if (u32(etype) == 4u) {
        sprite_y_offset = sin(u.time * 1.5 + ex) * 0.03 - 0.08;
      }

      let spr_left = screen_x - sprite_w * 0.5;
      let spr_right = screen_x + sprite_w * 0.5;
      let spr_top = 0.5 - sprite_h * 0.5 + pitch_offset + bob_y * 0.5 + sprite_y_offset;
      let spr_bot = 0.5 + sprite_h * 0.5 + pitch_offset + bob_y * 0.5 + sprite_y_offset;

      // Check if this pixel falls within sprite bounds
      if (v.uv.x >= spr_left && v.uv.x <= spr_right && v.uv.y >= spr_top && v.uv.y <= spr_bot) {
        let spr_u = (v.uv.x - spr_left) / (spr_right - spr_left);
        let spr_v = (v.uv.y - spr_top) / (spr_bot - spr_top);

        let spr_col = entity_color(etype, estate, ehp, vec2f(spr_u, spr_v), u.time);

        if (spr_col.a > 0.3) {
          // Distance lighting for sprites
          let spr_light = clamp(1.5 / (view_z * 0.3 + 1.0), 0.1, 1.0);
          col = mix(col, spr_col.rgb * spr_light, spr_col.a);
        }
      }
    }

    // ── Fog ──
    let fog_dist = select(perp_dist, 999.0, hit.wtype == 0u);
    let fog = 1.0 - exp(-fog_dist * fog_dist * 0.002);
    col = mix(col, vec3f(0.0), fog);

    // ── Hurt flash ──
    col = mix(col, vec3f(0.8, 0.0, 0.0), cam.hurt_flash * 0.4);

    // ── Weapon bob + muzzle flash ──
    // Weapon at bottom of screen
    let weap_cx = 0.5 + bob_x * 2.0;
    let weap_cy = 0.85 - bob_y * 0.3;
    let wp = v.uv - vec2f(weap_cx, weap_cy);

    // Muzzle flash
    if (cam.shoot_cd > 0.2) {
      let flash_r = length(wp - vec2f(0.02, -0.15));
      let flash = smoothstep(0.08, 0.0, flash_r);
      col += vec3f(1.0, 0.8, 0.3) * flash * 2.0;
    }

    // Weapon body (simple silhouette)
    let in_weapon = step(abs(wp.x), 0.06) * step(-0.12, wp.y) * step(wp.y, 0.15);
    let grip = step(abs(wp.x + 0.01), 0.03) * step(-0.02, wp.y) * step(wp.y, 0.15);
    let barrel = step(abs(wp.x + 0.005), 0.015) * step(-0.18, wp.y) * step(wp.y, -0.05);
    let weapon_mask = max(max(in_weapon, grip), barrel);

    if (cam.weapon > 2.5) {
      // Chaingun — wider barrel
      let cg_barrel = step(abs(wp.x + 0.005), 0.025) * step(-0.22, wp.y) * step(wp.y, -0.05);
      let cg_body = step(abs(wp.x), 0.05) * step(-0.05, wp.y) * step(wp.y, 0.12);
      let cg_mask = max(cg_barrel, cg_body);
      if (cg_mask > 0.5) {
        let gun_shade = 0.25 + wp.y * 0.3;
        col = vec3f(gun_shade, gun_shade * 0.95, gun_shade * 0.9);
      }
    } else if (cam.weapon > 1.5) {
      // Shotgun — thicker barrel
      let sg_barrel = step(abs(wp.x), 0.02) * step(-0.2, wp.y) * step(wp.y, -0.03);
      let sg_stock = step(abs(wp.x), 0.04) * step(-0.02, wp.y) * step(wp.y, 0.14);
      let sg_pump = step(abs(wp.x + 0.025), 0.012) * step(-0.12, wp.y) * step(wp.y, -0.02);
      let sg_mask = max(max(sg_barrel, sg_stock), sg_pump);
      if (sg_mask > 0.5) {
        let gun_shade = 0.3 + wp.y * 0.2;
        col = vec3f(gun_shade * 0.9, gun_shade * 0.85, gun_shade * 0.8);
      }
    } else if (weapon_mask > 0.5) {
      // Pistol
      let gun_shade = 0.3 + wp.y * 0.3;
      col = vec3f(gun_shade, gun_shade * 0.95, gun_shade * 0.9);
    }

    // ── Death overlay ──
    if (cam.hp <= 0.0) {
      col = col * vec3f(0.3, 0.05, 0.02);
      // "YOU DIED" tint
      let dead_pulse = sin(u.time * 2.0) * 0.1 + 0.3;
      col += vec3f(dead_pulse, 0.0, 0.0);
    }

    // Gamma
    col = pow(clamp(col, vec3f(0.0), vec3f(1.0)), vec3f(0.85));

    return vec4f(col, 1.0);
  }

;; ═══════════════════════════════════════════════════════════════════
;; DATA
;; ═══════════════════════════════════════════════════════════════════

;; Level grid — 64×64 × 4 bytes = 16,384 bytes
@buffer level_buf :usage [storage] :size 16384

;; Entity buffer — 128 entities × 8 floats × 4 bytes = 4,096 bytes
@buffer ent_buf :usage [storage] :size 4096

;; Flags (init flag + entity count + reserved) — 16 bytes
@buffer flag_buf :usage [storage] :size 16

;; Camera/player state — 16 × f32 = 64 bytes
@buffer cam_buf :usage [storage] :size 64
  @data
    :f0 0 :f1 0 :f2 0 :f3 0 :f4 0 :f5 0 :f6 0 :f7 0
    :f8 0 :f9 0 :f10 0 :f11 0 :f12 0 :f13 0 :f14 0 :f15 0

;; Per-frame uniform inputs
@buffer inp_buf :struct DoomInp :usage [uniform]
  @data
    :time      (elapsed)
    :dt        (frame-dt)
    :res       (canvas-size)
    :mdx       (mouse-dx)
    :mdy       (mouse-dy)
    :movex     (move-x)
    :movey     (move-y)
    :movez     (move-z)
    :locked    (pointer-locked)
    :fov       (form/fov)
    :sens      (form/sens)
    :menuopen  (form/menuopen)
    :sprint    (key-shift)
    :mousebtns (mouse-buttons)
    :selweap   0
    :pad0      0

;; ═══════════════════════════════════════════════════════════════════
;; PIPELINES + COMMANDS
;; ═══════════════════════════════════════════════════════════════════

@pipeline p_levelgen :compute doom_levelgen :entry cs_main
@pipeline p_phys     :compute doom_physics  :entry cs_main
@pipeline p_render   :vertex doom_render :fragment doom_render :format canvas :topology triangle-list

;; Compute 1: Generate level (once)
@dispatch d_levelgen :pipeline p_levelgen :grid [1 1 1]
  @bind 0 :storage [level_buf ent_buf flag_buf]
  @bind 1 :buffer inp_buf

;; Compute 2: Physics + AI
@dispatch d_phys :pipeline p_phys :grid [1 1 1]
  @bind 0 :storage [cam_buf level_buf ent_buf flag_buf]
  @bind 1 :buffer inp_buf

;; Render: fullscreen 2.5D raycaster
@pass main :clear [0 0 0 1]
  @draw :pipeline p_render :vertices 6
    @bind 0 :buffer inp_buf
    @bind 1 :storage [cam_buf level_buf ent_buf flag_buf]

;; ═══════════════════════════════════════════════════════════════════
;; FORM
;; ═══════════════════════════════════════════════════════════════════
@form controls :title "DOOM"
  @field fov      :type range    :label "FOV"         :default 1.4  :min 0.8  :max 2.2  :step 0.05
  @field sens     :type range    :label "Sensitivity" :default 1.0  :min 0.2  :max 3.0  :step 0.1
  @field menuopen :type checkbox :label "Menu"        :default 1

;; ═══════════════════════════════════════════════════════════════════
;; SURFACE — HUD overlay
;; ═══════════════════════════════════════════════════════════════════

;; ── Crosshair ──
@panel xhair :x (sub (mul (canvas-width) 0.5) 12) :y (sub (mul (canvas-height) 0.5) 12) :w 24 :h 24
  @rect ch_h :x 2 :y 11 :w 20 :h 2 :fill (if (eq (form/menuopen) 0) [1 1 1 0.6] [0 0 0 0]) :radius 1
  @rect ch_v :x 11 :y 2 :w 2  :h 20 :fill (if (eq (form/menuopen) 0) [1 1 1 0.6] [0 0 0 0]) :radius 1

;; ── Status bar (bottom) ──
@panel statusbar :x 0 :y (sub (canvas-height) 48) :w (canvas-width) :h 48 :fill [0.15 0.1 0.08 0.92] :layout row :gap 0 :padding 0

  ;; Health section
  @panel hp_section :w 200 :h 48 :fill [0.12 0.08 0.06 1] :layout row :gap 8 :padding 10 :align center
    @text hp_label :size 11 :color [0.6 0.6 0.6 1]
      HEALTH
    @text hp_val :size 28 :color [0.9 0.2 0.15 1]
      100%

  ;; Ammo section
  @panel ammo_section :w 160 :h 48 :fill [0.1 0.08 0.06 1] :layout row :gap 8 :padding 10 :align center
    @text ammo_label :size 11 :color [0.6 0.6 0.6 1]
      AMMO
    @text ammo_val :size 28 :color [0.85 0.75 0.2 1]
      50

  ;; Arms section
  @panel arms_section :w 120 :h 48 :fill [0.12 0.08 0.06 1] :layout row :gap 6 :padding 10 :align center
    @text arms_label :size 11 :color [0.6 0.6 0.6 1]
      ARMS
    @text arms_val :size 20 :color [0.7 0.7 0.7 1]
      1 2 3

  ;; Armor section
  @panel armor_section :w 160 :h 48 :fill [0.1 0.08 0.06 1] :layout row :gap 8 :padding 10 :align center
    @text armor_label :size 11 :color [0.6 0.6 0.6 1]
      ARMOR
    @text armor_val :size 28 :color [0.3 0.6 0.9 1]
      0%

  ;; Kills section
  @panel kills_section :w 120 :h 48 :fill [0.12 0.08 0.06 1] :layout row :gap 8 :padding 10 :align center
    @text kills_label :size 11 :color [0.6 0.6 0.6 1]
      KILLS
    @text kills_val :size 20 :color [0.9 0.4 0.15 1]
      0

;; ── Level title (top) ──
@panel title_bar :x 0 :y 0 :w (canvas-width) :h 32 :fill [0 0 0 0.5] :layout row :gap 12 :padding 8 :align center
  @text title_txt :size 14 :color [0.85 0.15 0.1 1]
    E1M1: Hangar
  @rect title_sep :w 1 :h 16 :fill [0.3 0.15 0.1 1]
  @text engine_txt :size 10 :color [0.5 0.5 0.5 1]
    Rex Projection Engine

;; ── Controls hint ──
@panel hint :x (sub (mul (canvas-width) 0.5) 200) :y (sub (canvas-height) 72) :w 400 :h 20 :fill [0 0 0 0.35] :radius 4 :layout row :gap 4 :padding 4 :align center :justify center
  @text hint_t :size 9 :color (if (eq (form/menuopen) 0) [0.5 0.5 0.55 1] [0 0 0 0])
    WASD move · Mouse aim · Click shoot · Shift run · E use

;; ── Menu overlay ──
@panel menu :x (sub (mul (canvas-width) 0.5) 180) :y (sub (mul (canvas-height) 0.5) 160) :w 360 :h 320 :fill (if (gt (form/menuopen) 0.5) [0.08 0.02 0.02 0.95] [0 0 0 0]) :radius 0 :layout column :gap 12 :padding 30

  @text menu_t :size 42 :color (if (gt (form/menuopen) 0.5) [0.85 0.15 0.1 1] [0 0 0 0]) :align center
    DOOM
  @text menu_s0 :size 14 :color (if (gt (form/menuopen) 0.5) [0.7 0.65 0.55 1] [0 0 0 0]) :align center
    Rex Projection Engine

  @rect menu_div :w 300 :h 2 :fill (if (gt (form/menuopen) 0.5) [0.5 0.1 0.05 0.6] [0 0 0 0])

  @text menu_s1 :size 18 :color (if (gt (form/menuopen) 0.5) [1 0.85 0.7 1] [0 0 0 0]) :align center
    Click to play

  @text menu_s2 :size 12 :color (if (gt (form/menuopen) 0.5) [0.6 0.55 0.5 1] [0 0 0 0]) :align center
    WASD move · Mouse aim · Click shoot

  @text menu_s3 :size 12 :color (if (gt (form/menuopen) 0.5) [0.6 0.55 0.5 1] [0 0 0 0]) :align center
    Shift run · E use door · Esc menu

  @rect menu_div2 :w 300 :h 1 :fill (if (gt (form/menuopen) 0.5) [0.3 0.1 0.05 0.4] [0 0 0 0])

  @text menu_s4 :size 10 :color (if (gt (form/menuopen) 0.5) [0.45 0.4 0.35 1] [0 0 0 0]) :align center
    64x64 level · 14 enemies · 5 types · 3 weapons

  @text menu_s5 :size 10 :color (if (gt (form/menuopen) 0.5) [0.35 0.3 0.25 1] [0 0 0 0]) :align center
    Procedural textures · DDA raycasting · GPU compute AI
