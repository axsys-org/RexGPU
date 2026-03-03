;; ═══════════════════════════════════════════════════════════════════════════
;; Bloomberg Terminal — Rex Projection Engine
;; GPU GBM price simulation · SDF text · full 2D flexbox layout
;; ═══════════════════════════════════════════════════════════════════════════

;; ── Uniform struct (8 x f32 = 32 bytes, 256-padded on heap) ──
@struct BInp
  @field time  :type f32
  @field dt    :type f32
  @field resx  :type f32
  @field resy  :type f32
  @field tick  :type f32
  @field vol   :type f32
  @field tid   :type f32
  @field pad0  :type f32

;; ── Storage buffers ──
@buffer price_buf :usage [storage] :size 16384
@buffer stat_buf  :usage [storage] :size 256

;; ── Uniform: per-frame inputs ──
@buffer b_inp :struct BInp :usage [uniform]
  @data
    :time  (elapsed)
    :dt    (frame-dt)
    :resx  (canvas-width)
    :resy  (canvas-height)
    :tick  (mul (elapsed) (form/speed))
    :vol   (form/volatility)
    :tid   (if (eq (form/ticker) "AAPL") 0 (if (eq (form/ticker) "MSFT") 1 (if (eq (form/ticker) "GOOGL") 2 (if (eq (form/ticker) "AMZN") 3 (if (eq (form/ticker) "TSLA") 4 (if (eq (form/ticker) "META") 5 (if (eq (form/ticker) "NVDA") 6 7)))))))
    :pad0  0

;; ═══════════════════════════════════════════════════════════════════════════
;; Compute: Geometric Brownian Motion price evolution (8 tickers)
;; ═══════════════════════════════════════════════════════════════════════════
@shader bloom_sim
  struct BInp { time:f32, dt:f32, resx:f32, resy:f32, tick:f32, vol:f32, tid:f32, pad0:f32 };
  @group(0) @binding(0) var<storage, read_write> prices: array<f32>;
  @group(0) @binding(1) var<storage, read_write> stats: array<f32>;
  @group(1) @binding(0) var<uniform> u: BInp;

  fn hash(n: f32) -> f32 { return fract(sin(n) * 43758.5453); }

  fn noise(t: f32, s: f32) -> f32 {
    let i = floor(t); let f = fract(t);
    let sm = f * f * (3.0 - 2.0 * f);
    let h0 = hash(i * 127.1 + s * 311.7);
    let h1 = hash((i + 1.0) * 127.1 + s * 311.7);
    return mix(h0, h1, sm) * 2.0 - 1.0;
  }

  fn base_p(tk: u32) -> f32 {
    if (tk == 0u) { return 188.0; }
    if (tk == 1u) { return 415.0; }
    if (tk == 2u) { return 172.0; }
    if (tk == 3u) { return 196.0; }
    if (tk == 4u) { return 248.0; }
    if (tk == 5u) { return 525.0; }
    if (tk == 6u) { return 875.0; }
    return 510.0;
  }

  fn base_sigma(tk: u32) -> f32 {
    if (tk == 0u) { return 0.012; }
    if (tk == 1u) { return 0.013; }
    if (tk == 2u) { return 0.014; }
    if (tk == 3u) { return 0.015; }
    if (tk == 4u) { return 0.030; }
    if (tk == 5u) { return 0.018; }
    if (tk == 6u) { return 0.025; }
    return 0.008;
  }

  @compute @workgroup_size(1)
  fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
    let tk = gid.x;
    if (tk >= 8u) { return; }
    let base = base_p(tk);
    let sigma = base_sigma(tk) * u.vol;
    let seed = f32(tk) * 17.3 + 1.0;
    let t = u.tick;
    let boff = tk * 512u;
    if (t < 0.1) {
      var p = base;
      for (var i = 0u; i < 512u; i = i + 1u) {
        let ft = f32(i) * 0.5 + seed;
        let dW = noise(ft, seed) * 0.22;
        p = p * exp(sigma * dW);
        p = clamp(p, base * 0.4, base * 2.8);
        prices[boff + i] = p;
      }
    }
    let sidx = u32(t) % 512u;
    let pidx = (sidx + 511u) % 512u;
    let prev = prices[boff + pidx];
    let dW = noise(t * 3.7 + seed, seed + t * 0.01) * sqrt(max(u.dt, 0.001));
    var cur = prev * exp(sigma * 6.0 * dW);
    cur = clamp(cur, base * 0.4, base * 2.8);
    prices[boff + sidx] = cur;
    let open = prices[boff + ((sidx + 1u) % 512u)];
    var hi = cur; var lo = cur;
    for (var k = 0u; k < 512u; k = k + 1u) {
      let pp = prices[boff + k];
      if (pp > hi) { hi = pp; }
      if (pp < lo) { lo = pp; }
    }
    let soff = tk * 8u;
    stats[soff + 0u] = open;  stats[soff + 1u] = cur;
    stats[soff + 2u] = hi;    stats[soff + 3u] = lo;
    stats[soff + 4u] = cur - open;
    stats[soff + 5u] = (cur - open) / open * 100.0;
    stats[soff + 6u] = cur * (1.0 - 0.0001);
    stats[soff + 7u] = cur * (1.0 + 0.0001);
  }

;; ═══════════════════════════════════════════════════════════════════════════
;; Fragment: price chart — renders to full canvas, surface overlays on top
;; ═══════════════════════════════════════════════════════════════════════════
@shader bloom_chart
  struct BInp { time:f32, dt:f32, resx:f32, resy:f32, tick:f32, vol:f32, tid:f32, pad0:f32 };
  @group(0) @binding(0) var<storage, read> prices: array<f32>;
  @group(0) @binding(1) var<storage, read> stats: array<f32>;
  @group(1) @binding(0) var<uniform> u: BInp;
  struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
  @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    var p = array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
    var o: VSOut; o.pos = vec4f(p[vi], 0, 1);
    o.uv = vec2f(p[vi].x * 0.5 + 0.5, 0.5 - p[vi].y * 0.5); return o;
  }
  fn lsdf(p: vec2f, a: vec2f, b: vec2f) -> f32 {
    let pa = p - a; let ba = b - a;
    let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
  }
  @fragment fn fs_main(v: VSOut) -> @location(0) vec4f {
    let px = v.uv * vec2f(u.resx, u.resy);
    let tk = u32(clamp(u.tid, 0.0, 7.0));
    let boff = tk * 512u; let soff = tk * 8u;
    let s_lo = stats[soff + 3u]; let s_hi = stats[soff + 2u];
    let rng = max(s_hi - s_lo, s_lo * 0.005);
    let cy0 = u.resy * 0.04; let cy1 = u.resy * 0.78;
    let vy0 = u.resy * 0.82; let vy1 = u.resy * 0.96;
    var col = mix(vec3f(0.025, 0.025, 0.055), vec3f(0.015, 0.015, 0.035), px.y / u.resy);
    for (var gi = 0u; gi < 9u; gi = gi + 1u) {
      let gy = cy0 + (cy1 - cy0) * f32(gi) / 8.0;
      if (abs(px.y - gy) < 1.0) { col = vec3f(0.07, 0.07, 0.11); }
      let gx = u.resx * f32(gi) / 8.0;
      if (abs(px.x - gx) < 1.0) { col = vec3f(0.07, 0.07, 0.11); }
    }
    if (abs(px.y - vy0 + 1.0) < 1.5) { col = vec3f(0.12, 0.12, 0.20); }
    let sidx_now = u32(u.tick) % 512u; let n_vis = 256u;
    let nx = clamp(px.x / u.resx, 0.0, 0.9999);
    let i_c = u32(nx * f32(n_vis));
    let i_n = min(i_c + 1u, n_vis - 1u);
    let i_p = select(0u, i_c - 1u, i_c > 0u);
    let si_c = (sidx_now + 512u - n_vis + i_c) % 512u;
    let si_n = (sidx_now + 512u - n_vis + i_n) % 512u;
    let si_p = (sidx_now + 512u - n_vis + i_p) % 512u;
    let pc = prices[boff + si_c]; let pn = prices[boff + si_n]; let pp = prices[boff + si_p];
    let tc = f32(i_c) / f32(n_vis - 1u);
    let tn = f32(i_n) / f32(n_vis - 1u);
    let tp = f32(i_p) / f32(n_vis - 1u);
    let yc = cy1 - (pc - s_lo) / rng * (cy1 - cy0);
    let yn = cy1 - (pn - s_lo) / rng * (cy1 - cy0);
    let yp = cy1 - (pp - s_lo) / rng * (cy1 - cy0);
    let xc = tc * u.resx; let xn = tn * u.resx; let xp = tp * u.resx;
    let d1 = lsdf(px, vec2f(xc, yc), vec2f(xn, yn));
    let d2 = lsdf(px, vec2f(xp, yp), vec2f(xc, yc));
    let md = min(d1, d2); let seg_up = pn >= pc;
    if (px.y >= cy0 && px.y < cy1) {
      let lc = select(vec3f(0.9, 0.12, 0.12), vec3f(0.1, 0.9, 0.3), seg_up);
      if (md < 10.0) { col = mix(col, lc, (1.0 - smoothstep(3.0, 10.0, md)) * 0.12); }
      if (md < 3.0) { col = mix(col, lc, 1.0 - smoothstep(0.0, 3.0, md)); }
    }
    if (px.y >= cy0 && px.y < cy1 && px.y > yc) {
      let fade = 1.0 - (px.y - yc) / (cy1 - yc);
      let fc = select(vec3f(0.55, 0.05, 0.05), vec3f(0.05, 0.45, 0.15), stats[soff+1u] >= stats[soff+0u]);
      col = mix(col, fc, fade * fade * 0.22);
    }
    if (px.y >= vy0 && px.y <= vy1) {
      let vd = abs(pc - pp) / rng * 0.8 + 0.04;
      if (px.y >= vy1 - vd * (vy1 - vy0)) {
        col = mix(col, select(vec3f(0.45,0.08,0.08), vec3f(0.06,0.35,0.14), pc>=pp), 0.75);
      }
    }
    let last = stats[soff + 1u];
    let cur_y = cy1 - (last - s_lo) / rng * (cy1 - cy0);
    if (abs(px.y - cur_y) < 1.5 && px.y >= cy0 && px.y < cy1) {
      col = mix(col, vec3f(1.0, 0.8, 0.1), 0.7 * step(0.5, fract(px.x / 16.0)));
    }
    return vec4f(col, 1.0);
  }

;; ═══════════════════════════════════════════════════════════════════════════
;; PIPELINES + COMMANDS
;; ═══════════════════════════════════════════════════════════════════════════
@pipeline p_sim   :compute bloom_sim :entry cs_main
@pipeline p_chart :vertex bloom_chart :fragment bloom_chart :format canvas :topology triangle-list

@dispatch d_sim :pipeline p_sim :grid [8 1 1]
  @bind 0 :storage [price_buf stat_buf]
  @bind 1 :buffer b_inp

@pass p_main :clear [0.02 0.02 0.04 1]
  @draw :pipeline p_chart :vertices 6
    @bind 0 :storage [price_buf stat_buf]
    @bind 1 :buffer b_inp

;; ═══════════════════════════════════════════════════════════════════════════
;; FORM
;; ═══════════════════════════════════════════════════════════════════════════
@form controls :title "Bloomberg Terminal"
  @field ticker     :type select :label "Ticker" :options [AAPL MSFT GOOGL AMZN TSLA META NVDA SPY] :default AAPL
  @field speed      :type range  :label "Speed"  :default 3.0 :min 0.5 :max 15.0 :step 0.5
  @field volatility :type range  :label "Vol"    :default 1.0 :min 0.2 :max 4.0  :step 0.1

;; ═══════════════════════════════════════════════════════════════════════════
;; SURFACE LAYOUT
;;
;; GPU chart renders fullscreen to canvas first.
;; Surface composites on top with loadOp='load' (overlay mode).
;; Panels WITH :fill paint opaque/semi-opaque backgrounds (masking GPU output).
;; Panels WITHOUT :fill are transparent — GPU chart shows through.
;; All sizes in physical pixels (2x DPR on Retina).
;; ═══════════════════════════════════════════════════════════════════════════

@panel root :w (canvas-width) :h (canvas-height) :layout column

  ;; ── TOP BAR ──────────────────────────────────────────────────────────────
  @panel topbar :h 40 :layout row :fill [0.035 0.03 0.055 1] :align center :padding-left 16 :padding-right 16
    @text BLOOMBERG :size 22 :color [1 0.45 0 1]
    @rect sep1 :w 2 :h 24 :fill [0.25 0.25 0.35 1] :margin-left 14 :margin-right 14
    @text TERMINAL :size 18 :color [0.55 0.55 0.7 1]
    @rect sep2 :w 2 :h 24 :fill [0.25 0.25 0.35 1] :margin-left 14 :margin-right 14
    @text EQUITY :size 18 :color [1 0.8 0 1]
    @panel tspc :flex-grow 1
    @text "NYSE  NASDAQ  LIVE" :size 16 :color [0.13 0.8 0.27 1]
  @rect topbar_b :h 2 :fill [1 0.4 0 0.6]

  ;; ── MAIN BODY (3-column) ────────────────────────────────────────────────
  @panel body :layout row :flex-grow 1

    ;; ── LEFT COLUMN: WATCHLIST ──
    @panel watchlist :w (mul (canvas-width) 0.17) :layout column :fill [0.02 0.02 0.04 1] :overflow hidden

      ;; Header
      @panel wl_hdr :h 36 :layout row :fill [0.055 0.045 0.09 1] :align center :padding-left 12
        @text WATCHLIST :size 18 :color [1 0.45 0 1]
      @rect wl_hdr_b :h 1 :fill [0.12 0.12 0.22 1]

      ;; Ticker rows — fixed 48px each
      @panel wl0 :h 48 :layout row :fill (if (eq (form/ticker) "AAPL") [0.06 0.05 0.14 1] [0 0 0 0]) :align center :padding-left 10 :padding-right 10
        @panel wl0l :layout column :flex-grow 1
          @text AAPL :size 18 :color [1 0.8 0 1]
          @text "Apple Inc" :size 13 :color [0.4 0.4 0.52 1]
        @panel wl0r :layout column :align end
          @text 188.42 :size 18 :color [0.13 0.93 0.33 1]
          @text "+0.84%" :size 13 :color [0.13 0.67 0.27 1]
      @rect d0 :h 1 :fill [0.06 0.06 0.12 1]

      @panel wl1 :h 48 :layout row :fill (if (eq (form/ticker) "MSFT") [0.06 0.05 0.14 1] [0 0 0 0]) :align center :padding-left 10 :padding-right 10
        @panel wl1l :layout column :flex-grow 1
          @text MSFT :size 18 :color [1 0.8 0 1]
          @text Microsoft :size 13 :color [0.4 0.4 0.52 1]
        @panel wl1r :layout column :align end
          @text 415.10 :size 18 :color [0.13 0.93 0.33 1]
          @text "+1.22%" :size 13 :color [0.13 0.67 0.27 1]
      @rect d1 :h 1 :fill [0.06 0.06 0.12 1]

      @panel wl2 :h 48 :layout row :fill (if (eq (form/ticker) "GOOGL") [0.06 0.05 0.14 1] [0 0 0 0]) :align center :padding-left 10 :padding-right 10
        @panel wl2l :layout column :flex-grow 1
          @text GOOGL :size 18 :color [1 0.8 0 1]
          @text Alphabet :size 13 :color [0.4 0.4 0.52 1]
        @panel wl2r :layout column :align end
          @text 172.35 :size 18 :color [0.93 0.27 0.27 1]
          @text "-0.43%" :size 13 :color [0.93 0.2 0.2 1]
      @rect d2 :h 1 :fill [0.06 0.06 0.12 1]

      @panel wl3 :h 48 :layout row :fill (if (eq (form/ticker) "AMZN") [0.06 0.05 0.14 1] [0 0 0 0]) :align center :padding-left 10 :padding-right 10
        @panel wl3l :layout column :flex-grow 1
          @text AMZN :size 18 :color [1 0.8 0 1]
          @text Amazon :size 13 :color [0.4 0.4 0.52 1]
        @panel wl3r :layout column :align end
          @text 196.88 :size 18 :color [0.13 0.93 0.33 1]
          @text "+2.07%" :size 13 :color [0.13 0.67 0.27 1]
      @rect d3 :h 1 :fill [0.06 0.06 0.12 1]

      @panel wl4 :h 48 :layout row :fill (if (eq (form/ticker) "TSLA") [0.06 0.05 0.14 1] [0 0 0 0]) :align center :padding-left 10 :padding-right 10
        @panel wl4l :layout column :flex-grow 1
          @text TSLA :size 18 :color [1 0.8 0 1]
          @text Tesla :size 13 :color [0.4 0.4 0.52 1]
        @panel wl4r :layout column :align end
          @text 248.20 :size 18 :color [0.93 0.27 0.27 1]
          @text "-1.55%" :size 13 :color [0.93 0.2 0.2 1]
      @rect d4 :h 1 :fill [0.06 0.06 0.12 1]

      @panel wl5 :h 48 :layout row :fill (if (eq (form/ticker) "META") [0.06 0.05 0.14 1] [0 0 0 0]) :align center :padding-left 10 :padding-right 10
        @panel wl5l :layout column :flex-grow 1
          @text META :size 18 :color [1 0.8 0 1]
          @text "Meta Platforms" :size 13 :color [0.4 0.4 0.52 1]
        @panel wl5r :layout column :align end
          @text 525.44 :size 18 :color [0.13 0.93 0.33 1]
          @text "+3.11%" :size 13 :color [0.13 0.67 0.27 1]
      @rect d5 :h 1 :fill [0.06 0.06 0.12 1]

      @panel wl6 :h 48 :layout row :fill (if (eq (form/ticker) "NVDA") [0.06 0.05 0.14 1] [0 0 0 0]) :align center :padding-left 10 :padding-right 10
        @panel wl6l :layout column :flex-grow 1
          @text NVDA :size 18 :color [1 0.8 0 1]
          @text NVIDIA :size 13 :color [0.4 0.4 0.52 1]
        @panel wl6r :layout column :align end
          @text 875.39 :size 18 :color [0.13 0.93 0.33 1]
          @text "+5.88%" :size 13 :color [0.13 0.67 0.27 1]
      @rect d6 :h 1 :fill [0.06 0.06 0.12 1]

      @panel wl7 :h 48 :layout row :fill (if (eq (form/ticker) "SPY") [0.06 0.05 0.14 1] [0 0 0 0]) :align center :padding-left 10 :padding-right 10
        @panel wl7l :layout column :flex-grow 1
          @text SPY :size 18 :color [1 0.8 0 1]
          @text "S&P 500 ETF" :size 13 :color [0.4 0.4 0.52 1]
        @panel wl7r :layout column :align end
          @text 510.12 :size 18 :color [0.13 0.93 0.33 1]
          @text "+0.55%" :size 13 :color [0.13 0.67 0.27 1]

      ;; Portfolio summary
      @rect psep :h 2 :fill [1 0.4 0 0.35]
      @panel portfolio :layout column :fill [0.03 0.025 0.065 1] :padding 12 :gap 6 :flex-grow 1 :align stretch
        @text PORTFOLIO :size 16 :color [1 0.45 0 1]
        @panel pr1 :h 18 :layout row :justify space-between
          @text Cash :size 13 :color [0.4 0.4 0.52 1]
          @text "$100,000" :size 13 :color [0.67 0.67 0.73 1]
        @panel pr2 :h 18 :layout row :justify space-between
          @text Positions :size 13 :color [0.4 0.4 0.52 1]
          @text "0 shares" :size 13 :color [0.67 0.67 0.73 1]
        @panel pr3 :h 18 :layout row :justify space-between
          @text "P&L" :size 13 :color [0.4 0.4 0.52 1]
          @text "$0.00" :size 13 :color [0.13 0.67 0.27 1]

    ;; Left border
    @rect lborder :w 2 :fill [0.08 0.08 0.16 1]

    ;; ── CENTER COLUMN: CHART (transparent — GPU shows through) ──
    @panel center :layout column :flex-grow 1

      ;; Chart header bar (opaque, covers GPU chart)
      @panel chart_hdr :layout row :h 56 :fill [0.03 0.025 0.055 0.97] :align center :padding-left 16 :padding-right 16 :gap 16
        @panel chtk :layout column
          @text AAPL :size 26 :color [1 0.8 0 1]
          @text "APPLE INC" :size 12 :color [0.4 0.4 0.52 1]
        @rect cd1 :w 1 :h 36 :fill [0.18 0.18 0.28 1]
        @panel chlast :layout column
          @text LAST :size 11 :color [0.35 0.35 0.47 1]
          @text 188.42 :size 24 :color [1 1 1 1]
        @rect cd2 :w 1 :h 36 :fill [0.18 0.18 0.28 1]
        @panel chchg :layout column
          @text CHG :size 11 :color [0.35 0.35 0.47 1]
          @text "+0.84 / +0.45%" :size 18 :color [0.13 0.8 0.27 1]
        @rect cd3 :w 1 :h 36 :fill [0.18 0.18 0.28 1]
        @panel chohlc :layout row :gap 16
          @panel cho :layout column
            @text O :size 11 :color [0.35 0.35 0.47 1]
            @text 187.58 :size 16 :color [0.67 0.67 0.73 1]
          @panel chh :layout column
            @text H :size 11 :color [0.35 0.35 0.47 1]
            @text 189.91 :size 16 :color [0.13 0.93 0.33 1]
          @panel chl :layout column
            @text L :size 11 :color [0.35 0.35 0.47 1]
            @text 186.12 :size 16 :color [0.93 0.27 0.27 1]
          @panel chvol :layout column
            @text V :size 11 :color [0.35 0.35 0.47 1]
            @text "54.2M" :size 16 :color [0.67 0.67 0.73 1]
        @rect cd4 :w 1 :h 36 :fill [0.18 0.18 0.28 1]
        @panel chba :layout row :gap 16
          @panel chbid :layout column
            @text BID :size 11 :color [0.35 0.35 0.47 1]
            @text 188.40 :size 16 :color [0.13 0.8 0.27 1]
          @panel chask :layout column
            @text ASK :size 11 :color [0.35 0.35 0.47 1]
            @text 188.44 :size 16 :color [0.93 0.27 0.27 1]
      @rect chdr_b :h 1 :fill [0.08 0.08 0.16 1]

      ;; Chart body — NO FILL, NO CHILDREN = transparent spacer
      ;; GPU fullscreen chart renders beneath this area
      @panel chart_area :flex-grow 1

    ;; Right border
    @rect rborder :w 2 :fill [0.08 0.08 0.16 1]

    ;; ── RIGHT COLUMN: ORDER BOOK + TRADE BLOTTER ──
    @panel rightcol :w (mul (canvas-width) 0.17) :layout column :fill [0.02 0.02 0.04 1] :overflow hidden

      ;; Order Book header
      @panel ob_hdr :h 36 :layout row :fill [0.055 0.045 0.09 1] :align center :padding-left 10
        @text "ORDER BOOK" :size 18 :color [1 0.45 0 1]
      @rect ob_hdr_b :h 1 :fill [0.12 0.12 0.22 1]

      ;; Column headers
      @panel ob_cols :h 24 :layout row :fill [0.03 0.025 0.055 1] :align center :padding-left 8 :padding-right 8 :gap 6
        @text QTY :size 12 :color [0.35 0.35 0.47 1] :flex-grow 1
        @text PRICE :size 12 :color [0.35 0.35 0.47 1] :flex-grow 1
        @text SIDE :size 12 :color [0.35 0.35 0.47 1]

      ;; Asks (sellers) — compact rows
      @panel asks :layout column :padding-left 8 :padding-right 8 :padding-top 4 :padding-bottom 4 :gap 2
        @panel a5 :layout row :h 22 :align center :gap 4
          @text "1,243" :size 13 :color [0.7 0.18 0.25 0.7] :flex-grow 1
          @text 188.56 :size 13 :color [0.8 0.2 0.27 0.75] :flex-grow 1
          @text ASK :size 11 :color [0.7 0.18 0.25 0.5]
        @panel a4 :layout row :h 22 :align center :gap 4
          @text 876 :size 13 :color [0.75 0.2 0.27 0.7] :flex-grow 1
          @text 188.52 :size 13 :color [0.8 0.2 0.27 0.8] :flex-grow 1
          @text ASK :size 11 :color [0.75 0.2 0.27 0.5]
        @panel a3 :layout row :h 22 :align center :gap 4
          @text "2,108" :size 13 :color [0.82 0.2 0.27 0.7] :flex-grow 1
          @text 188.49 :size 13 :color [0.87 0.2 0.27 0.8] :flex-grow 1
          @text ASK :size 11 :color [0.82 0.2 0.27 0.5]
        @panel a2 :layout row :h 22 :align center :gap 4
          @text "1,567" :size 13 :color [0.88 0.2 0.27 0.7] :flex-grow 1
          @text 188.46 :size 13 :color [0.93 0.2 0.27 0.87] :flex-grow 1
          @text ASK :size 11 :color [0.88 0.2 0.27 0.55]
        @panel a1 :layout row :h 22 :align center :gap 4
          @text "3,412" :size 13 :color [1 0.27 0.33 0.8] :flex-grow 1
          @text 188.44 :size 13 :color [1 0.27 0.33 1] :flex-grow 1
          @text ASK :size 11 :color [1 0.27 0.33 0.7]

      ;; Spread line
      @panel spread :h 26 :layout row :fill [0.05 0.04 0.10 1] :align center :padding-left 8 :padding-right 8
        @text SPREAD :size 12 :color [0.4 0.4 0.52 1]
        @text "$0.04" :size 14 :color [1 0.8 0 1] :margin-left 6
        @panel spc :flex-grow 1
        @text 188.42 :size 14 :color [0.6 0.6 0.67 1]

      ;; Bids (buyers) — compact rows
      @panel bids :layout column :padding-left 8 :padding-right 8 :padding-top 4 :padding-bottom 4 :gap 2
        @panel b1 :layout row :h 22 :align center :gap 4
          @text "4,891" :size 13 :color [0.13 0.75 0.25 0.8] :flex-grow 1
          @text 188.40 :size 13 :color [0.13 0.93 0.33 1] :flex-grow 1
          @text BID :size 11 :color [0.13 0.75 0.25 0.7]
        @panel b2 :layout row :h 22 :align center :gap 4
          @text "2,234" :size 13 :color [0.13 0.7 0.25 0.67] :flex-grow 1
          @text 188.37 :size 13 :color [0.13 0.93 0.33 0.87] :flex-grow 1
          @text BID :size 11 :color [0.13 0.7 0.25 0.6]
        @panel b3 :layout row :h 22 :align center :gap 4
          @text "1,788" :size 13 :color [0.13 0.65 0.25 0.55] :flex-grow 1
          @text 188.34 :size 13 :color [0.13 0.93 0.33 0.73] :flex-grow 1
          @text BID :size 11 :color [0.13 0.65 0.25 0.5]
        @panel b4 :layout row :h 22 :align center :gap 4
          @text 943 :size 13 :color [0.13 0.6 0.25 0.4] :flex-grow 1
          @text 188.31 :size 13 :color [0.13 0.93 0.33 0.6] :flex-grow 1
          @text BID :size 11 :color [0.13 0.6 0.25 0.35]
        @panel b5 :layout row :h 22 :align center :gap 4
          @text 612 :size 13 :color [0.13 0.55 0.25 0.33] :flex-grow 1
          @text 188.28 :size 13 :color [0.13 0.93 0.33 0.47] :flex-grow 1
          @text BID :size 11 :color [0.13 0.55 0.25 0.3]

      ;; Trade blotter
      @rect bsep :h 1 :fill [0.08 0.08 0.16 1]
      @panel blot_hdr :h 32 :layout row :fill [0.055 0.045 0.09 1] :align center :padding-left 8
        @text "TRADE BLOTTER" :size 16 :color [1 0.45 0 1]
      @panel blotter :layout column :padding 8 :gap 4 :flex-grow 1
        @panel bl1 :layout row :h 20 :align center :gap 6
          @text "09:32:14" :size 13 :color [0.35 0.35 0.47 1]
          @text BUY :size 13 :color [0.13 0.8 0.27 1]
          @text 100 :size 13 :color [0.6 0.6 0.7 1]
          @text 188.24 :size 13 :color [0.6 0.6 0.7 1]
        @panel bl2 :layout row :h 20 :align center :gap 6
          @text "09:45:03" :size 13 :color [0.35 0.35 0.47 1]
          @text SELL :size 13 :color [0.93 0.27 0.27 1]
          @text 50 :size 13 :color [0.6 0.6 0.7 1]
          @text 188.91 :size 13 :color [0.6 0.6 0.7 1]
        @panel bl3 :layout row :h 20 :align center :gap 6
          @text "10:01:47" :size 13 :color [0.35 0.35 0.47 1]
          @text BUY :size 13 :color [0.13 0.8 0.27 1]
          @text 200 :size 13 :color [0.6 0.6 0.7 1]
          @text 187.55 :size 13 :color [0.6 0.6 0.7 1]
        @panel bl4 :layout row :h 20 :align center :gap 6
          @text "10:14:22" :size 13 :color [0.35 0.35 0.47 1]
          @text SELL :size 13 :color [0.93 0.27 0.27 1]
          @text 150 :size 13 :color [0.6 0.6 0.7 1]
          @text 189.03 :size 13 :color [0.6 0.6 0.7 1]

  ;; ── INDICES BAR ────────────────────────────────────────────────────────
  @rect idx_top :h 1 :fill [0.08 0.08 0.16 1]
  @panel indices :h 34 :layout row :fill [0.03 0.025 0.05 1] :align center :padding-left 14 :padding-right 14 :gap 10
    @text SPX :size 13 :color [0.45 0.45 0.58 1]
    @text "5,121" :size 16 :color [0.13 0.8 0.27 1]
    @text "+0.55%" :size 13 :color [0.13 0.67 0.27 1]
    @rect id1 :w 1 :h 20 :fill [0.18 0.18 0.28 1]
    @text NDX :size 13 :color [0.45 0.45 0.58 1]
    @text "18,003" :size 16 :color [0.13 0.8 0.27 1]
    @text "+0.83%" :size 13 :color [0.13 0.67 0.27 1]
    @rect id2 :w 1 :h 20 :fill [0.18 0.18 0.28 1]
    @text VIX :size 13 :color [0.45 0.45 0.58 1]
    @text 14.82 :size 16 :color [0.93 0.6 0.27 1]
    @text "+2.11%" :size 13 :color [0.93 0.27 0.27 1]
    @rect id3 :w 1 :h 20 :fill [0.18 0.18 0.28 1]
    @text BTC :size 13 :color [0.45 0.45 0.58 1]
    @text "67,234" :size 16 :color [0.13 0.8 0.27 1]
    @text "+1.44%" :size 13 :color [0.13 0.67 0.27 1]
    @rect id4 :w 1 :h 20 :fill [0.18 0.18 0.28 1]
    @text DXY :size 13 :color [0.45 0.45 0.58 1]
    @text 103.21 :size 16 :color [0.93 0.27 0.27 1]
    @text "-0.18%" :size 13 :color [0.93 0.2 0.2 1]
    @rect id5 :w 1 :h 20 :fill [0.18 0.18 0.28 1]
    @text 10Y :size 13 :color [0.45 0.45 0.58 1]
    @text "4.31%" :size 16 :color [0.93 0.6 0.27 1]
    @text +3bp :size 13 :color [0.93 0.27 0.27 1]

  ;; ── NEWS TICKER ──────────────────────────────────────────────────────────
  @rect news_sep :h 2 :fill [1 0.4 0 0.5]
  @panel news :h 32 :layout row :fill [0.03 0.025 0.045 1] :align center
    @panel news_tag :w 80 :h 32 :fill [1 0.45 0 1] :align center :justify center
      @text NEWS :size 16 :color [0 0 0 1]
    @panel news_scroll :layout row :flex-grow 1 :overflow hidden :align center :padding-left 10
      @text "AAPL Q1 BEAT  EPS $2.18 vs $2.09  *  FED HOLDS RATES  *  NVDA +8% AI DEMAND  *  TSLA CUTS EU PRICES  *  META LLAMA-4 LAUNCH  *  S&P ATH  *  MSFT AZURE +29%  *  GOOGL DOJ BREAKUP  *" :size 16 :color [0.85 0.85 0.72 1] :x (mul (fract (mul (elapsed) 0.015)) (sub 0 5000))
