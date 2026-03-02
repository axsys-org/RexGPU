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
;; price_buf: 8 tickers x 512 f32 = 16384 bytes
@buffer price_buf :usage [storage] :size 16384
;; stat_buf:  8 tickers x 8 f32 = 256 bytes  (open, close, hi, lo, chg, chgpct, bid, ask)
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

    // Fill entire history on frame 0
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

    // Evolve current tick (GBM step)
    let sidx = u32(t) % 512u;
    let pidx = (sidx + 511u) % 512u;
    let prev = prices[boff + pidx];
    let dW = noise(t * 3.7 + seed, seed + t * 0.01) * sqrt(max(u.dt, 0.001));
    var cur = prev * exp(sigma * 6.0 * dW);
    cur = clamp(cur, base * 0.4, base * 2.8);
    prices[boff + sidx] = cur;

    // Stats: open, close, hi, lo, chg, chgpct, bid, ask
    let open = prices[boff + ((sidx + 1u) % 512u)];
    var hi = cur; var lo = cur;
    for (var k = 0u; k < 512u; k = k + 1u) {
      let pp = prices[boff + k];
      if (pp > hi) { hi = pp; }
      if (pp < lo) { lo = pp; }
    }
    let soff = tk * 8u;
    stats[soff + 0u] = open;
    stats[soff + 1u] = cur;
    stats[soff + 2u] = hi;
    stats[soff + 3u] = lo;
    stats[soff + 4u] = cur - open;
    stats[soff + 5u] = (cur - open) / open * 100.0;
    stats[soff + 6u] = cur * (1.0 - 0.0001);
    stats[soff + 7u] = cur * (1.0 + 0.0001);
  }

;; ═══════════════════════════════════════════════════════════════════════════
;; Fragment: price chart with line, gradient fill, volume bars, grid
;; ═══════════════════════════════════════════════════════════════════════════
@shader bloom_chart
  @group(0) @binding(0) var<storage, read> prices: array<f32>;
  @group(0) @binding(1) var<storage, read> stats: array<f32>;
  @group(1) @binding(0) var<uniform> u: BInp;

  struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

  @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    var p = array<vec2f,6>(
      vec2f(-1,-1), vec2f(1,-1), vec2f(-1,1),
      vec2f(-1,1),  vec2f(1,-1), vec2f(1,1)
    );
    var o: VSOut;
    o.pos = vec4f(p[vi], 0, 1);
    o.uv = vec2f(p[vi].x * 0.5 + 0.5, 0.5 - p[vi].y * 0.5);
    return o;
  }

  // Line segment SDF for chart line drawing
  fn lsdf(p: vec2f, a: vec2f, b: vec2f) -> f32 {
    let pa = p - a; let ba = b - a;
    let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
  }

  @fragment fn fs_main(v: VSOut) -> @location(0) vec4f {
    let px = v.uv * vec2f(u.resx, u.resy);
    let tk = u32(clamp(u.tid, 0.0, 7.0));
    let boff = tk * 512u;
    let soff = tk * 8u;

    let s_lo = stats[soff + 3u];
    let s_hi = stats[soff + 2u];
    let rng = max(s_hi - s_lo, s_lo * 0.005);

    // Chart area (top 80%) and volume area (bottom 20%)
    let cy1 = u.resy * 0.80;
    let vy0 = u.resy * 0.82;
    let vy1 = u.resy;

    var col = vec3f(0.03, 0.03, 0.05);

    // Grid lines
    for (var gi = 0u; gi < 9u; gi = gi + 1u) {
      let gy = cy1 * f32(gi) / 8.0;
      if (abs(px.y - gy) < 0.6) { col = vec3f(0.10, 0.10, 0.14); }
      let gx = u.resx * f32(gi) / 8.0;
      if (abs(px.x - gx) < 0.6) { col = vec3f(0.10, 0.10, 0.14); }
    }
    if (abs(px.y - vy0 + 1.0) < 1.0) { col = vec3f(0.18, 0.18, 0.24); }

    // Price line segments
    let sidx_now = u32(u.tick) % 512u;
    let n_vis = 256u;
    let nx = clamp(px.x / u.resx, 0.0, 0.9999);
    let i_c = u32(nx * f32(n_vis));
    let i_n = min(i_c + 1u, n_vis - 1u);
    let i_p = select(0u, i_c - 1u, i_c > 0u);

    let si_c = (sidx_now + 512u - n_vis + i_c) % 512u;
    let si_n = (sidx_now + 512u - n_vis + i_n) % 512u;
    let si_p = (sidx_now + 512u - n_vis + i_p) % 512u;

    let pc = prices[boff + si_c];
    let pn = prices[boff + si_n];
    let pp = prices[boff + si_p];

    let tc = f32(i_c) / f32(n_vis - 1u);
    let tn = f32(i_n) / f32(n_vis - 1u);
    let tp = f32(i_p) / f32(n_vis - 1u);

    let yc = cy1 - (pc - s_lo) / rng * cy1;
    let yn = cy1 - (pn - s_lo) / rng * cy1;
    let yp = cy1 - (pp - s_lo) / rng * cy1;

    let xc = tc * u.resx;
    let xn = tn * u.resx;
    let xp = tp * u.resx;

    let d1 = lsdf(px, vec2f(xc, yc), vec2f(xn, yn));
    let d2 = lsdf(px, vec2f(xp, yp), vec2f(xc, yc));
    let md = min(d1, d2);
    let seg_up = pn >= pc;

    // Price line (green up, red down)
    if (md < 1.4 && px.y < cy1) {
      let br = 1.0 - smoothstep(0.0, 1.4, md);
      let lc = select(vec3f(0.85, 0.20, 0.20), vec3f(0.18, 0.85, 0.35), seg_up);
      col = mix(col, lc, br);
    }

    // Gradient fill under chart line
    if (px.y < cy1 && px.y > yc) {
      let fade = 1.0 - (px.y - yc) / (cy1 - yc);
      let open_px = stats[soff + 0u];
      let close_px = stats[soff + 1u];
      let fc = select(vec3f(0.65, 0.08, 0.08), vec3f(0.08, 0.58, 0.20), close_px >= open_px);
      col = mix(col, fc, fade * fade * 0.20);
    }

    // Volume bars
    if (px.y >= vy0 && px.y <= vy1) {
      let vd = abs(pc - pp) / rng * 0.85 + 0.04;
      let vy_bar = vy1 - vd * (vy1 - vy0);
      if (px.y >= vy_bar) {
        col = select(vec3f(0.48, 0.12, 0.12), vec3f(0.10, 0.40, 0.18), pc >= pp);
      }
    }

    // Current price marker
    let last = stats[soff + 1u];
    let cur_y = cy1 - (last - s_lo) / rng * cy1;
    if (abs(px.y - cur_y) < 0.7 && px.y < cy1) {
      col = mix(col, vec3f(0.95, 0.78, 0.12), 0.65);
    }

    return vec4f(col, 1.0);
  }

;; ═══════════════════════════════════════════════════════════════════════════
;; PIPELINES + COMMANDS
;; ═══════════════════════════════════════════════════════════════════════════

@pipeline p_sim   :compute bloom_sim :entry cs_main
@pipeline p_chart :vertex bloom_chart :fragment bloom_chart :format canvas :topology triangle-list

;; Compute: simulate 8 tickers
@dispatch d_sim :pipeline p_sim :grid [8 1 1]
  @bind 0 :storage [price_buf stat_buf]
  @bind 1 :buffer b_inp

;; Render: fullscreen chart
@pass p_main :clear [0.03 0.03 0.05 1]
  @draw :pipeline p_chart :vertices 6
    @bind 0 :storage [price_buf stat_buf]
    @bind 1 :buffer b_inp

;; ═══════════════════════════════════════════════════════════════════════════
;; FORM — ticker selection + simulation controls
;; ═══════════════════════════════════════════════════════════════════════════
@form controls :title "Bloomberg Terminal"
  @field ticker     :type select :label "Ticker" :options [AAPL MSFT GOOGL AMZN TSLA META NVDA SPY] :default AAPL
  @field speed      :type range  :label "Speed"  :default 3.0 :min 0.5 :max 15.0 :step 0.5
  @field volatility :type range  :label "Vol"    :default 1.0 :min 0.2 :max 4.0  :step 0.1

;; ═══════════════════════════════════════════════════════════════════════════
;; SURFACE LAYER — full 2D flexbox Bloomberg terminal layout
;; All static text; GPU chart renders beneath transparent centre area
;; ═══════════════════════════════════════════════════════════════════════════

;; Root: full-screen column
@panel root :w (canvas-width) :h (canvas-height) :layout column

  ;; ── TOP BAR ────────────────────────────────────────────────────────────
  @panel topbar :w (canvas-width) :h 26 :layout row :fill [0.039 0.039 0.051 1] :align center :padding-left 10 :padding-right 10
    @text t_logo :size 13 :color [1 0.4 0 1]
      BLOOMBERG
    @rect sep1 :w 1 :h 14 :fill [0.2 0.2 0.267 1] :margin-left 8 :margin-right 8
    @text t_mode :size 11 :color [0.6 0.604 0.733 1]
      TERMINAL
    @rect sep2 :w 1 :h 14 :fill [0.2 0.2 0.267 1] :margin-left 8 :margin-right 8
    @text t_mkt :size 11 :color [1 0.8 0 1]
      EQUITY
    @rect spacer_top :w 10 :h 1 :flex-grow 1
    @text t_conn :size 10 :color [0.133 0.8 0.267 1]
      NYSE  NASDAQ  LIVE
    @text t_dot :size 11 :color (if (lt (fract (mul (elapsed) 1.5)) 0.5) [0.133 0.933 0.267 1] [0 0 0 0]) :margin-left 6
      *
  @rect topbar_border :w (canvas-width) :h 1 :fill [1 0.4 0 0.4]

  ;; ── MAIN BODY: watchlist | chart | order book ─────────────────────────
  @panel body :layout row :flex-grow 1

    ;; ── LEFT COLUMN: WATCHLIST ──
    @panel watchlist :w 190 :layout column :fill [0.027 0.027 0.043 1]

      ;; Header
      @panel wl_hdr :w 190 :h 24 :layout row :fill [0.055 0.055 0.094 1] :align center :padding-left 8
        @text wl_hdr_txt :size 11 :color [1 0.4 0 1]
          WATCHLIST
      @rect wl_hdr_b :w 190 :h 1 :fill [0.133 0.133 0.227 1]

      ;; AAPL
      @panel wl_aapl :w 190 :h 34 :layout row :fill (if (eq (form/ticker) "AAPL") [0.059 0.059 0.133 1] [0 0 0 0]) :align center :padding-left 8 :padding-right 8
        @panel wl_aapl_l :layout column :flex-grow 1
          @text wl_aapl_sym :size 12 :color [1 0.8 0 1]
            AAPL
          @text wl_aapl_nm :size 9 :color [0.267 0.267 0.353 1]
            Apple Inc
        @panel wl_aapl_r :layout column :align end
          @text wl_aapl_px :size 11 :color [0.133 0.933 0.333 1]
            188.42
          @text wl_aapl_chg :size 9 :color [0.133 0.667 0.267 1]
            +0.84%
      @rect wl_d1 :w 174 :h 1 :fill [0.067 0.067 0.133 1] :margin-left 8

      ;; MSFT
      @panel wl_msft :w 190 :h 34 :layout row :fill (if (eq (form/ticker) "MSFT") [0.059 0.059 0.133 1] [0 0 0 0]) :align center :padding-left 8 :padding-right 8
        @panel wl_msft_l :layout column :flex-grow 1
          @text wl_msft_sym :size 12 :color [1 0.8 0 1]
            MSFT
          @text wl_msft_nm :size 9 :color [0.267 0.267 0.353 1]
            Microsoft
        @panel wl_msft_r :layout column :align end
          @text wl_msft_px :size 11 :color [0.133 0.933 0.333 1]
            415.10
          @text wl_msft_chg :size 9 :color [0.133 0.667 0.267 1]
            +1.22%
      @rect wl_d2 :w 174 :h 1 :fill [0.067 0.067 0.133 1] :margin-left 8

      ;; GOOGL
      @panel wl_googl :w 190 :h 34 :layout row :fill (if (eq (form/ticker) "GOOGL") [0.059 0.059 0.133 1] [0 0 0 0]) :align center :padding-left 8 :padding-right 8
        @panel wl_googl_l :layout column :flex-grow 1
          @text wl_googl_sym :size 12 :color [1 0.8 0 1]
            GOOGL
          @text wl_googl_nm :size 9 :color [0.267 0.267 0.353 1]
            Alphabet
        @panel wl_googl_r :layout column :align end
          @text wl_googl_px :size 11 :color [0.933 0.267 0.267 1]
            172.35
          @text wl_googl_chg :size 9 :color [0.933 0.2 0.2 1]
            -0.43%
      @rect wl_d3 :w 174 :h 1 :fill [0.067 0.067 0.133 1] :margin-left 8

      ;; AMZN
      @panel wl_amzn :w 190 :h 34 :layout row :fill (if (eq (form/ticker) "AMZN") [0.059 0.059 0.133 1] [0 0 0 0]) :align center :padding-left 8 :padding-right 8
        @panel wl_amzn_l :layout column :flex-grow 1
          @text wl_amzn_sym :size 12 :color [1 0.8 0 1]
            AMZN
          @text wl_amzn_nm :size 9 :color [0.267 0.267 0.353 1]
            Amazon
        @panel wl_amzn_r :layout column :align end
          @text wl_amzn_px :size 11 :color [0.133 0.933 0.333 1]
            196.88
          @text wl_amzn_chg :size 9 :color [0.133 0.667 0.267 1]
            +2.07%
      @rect wl_d4 :w 174 :h 1 :fill [0.067 0.067 0.133 1] :margin-left 8

      ;; TSLA
      @panel wl_tsla :w 190 :h 34 :layout row :fill (if (eq (form/ticker) "TSLA") [0.059 0.059 0.133 1] [0 0 0 0]) :align center :padding-left 8 :padding-right 8
        @panel wl_tsla_l :layout column :flex-grow 1
          @text wl_tsla_sym :size 12 :color [1 0.8 0 1]
            TSLA
          @text wl_tsla_nm :size 9 :color [0.267 0.267 0.353 1]
            Tesla
        @panel wl_tsla_r :layout column :align end
          @text wl_tsla_px :size 11 :color [0.933 0.267 0.267 1]
            248.20
          @text wl_tsla_chg :size 9 :color [0.933 0.2 0.2 1]
            -1.55%
      @rect wl_d5 :w 174 :h 1 :fill [0.067 0.067 0.133 1] :margin-left 8

      ;; META
      @panel wl_meta :w 190 :h 34 :layout row :fill (if (eq (form/ticker) "META") [0.059 0.059 0.133 1] [0 0 0 0]) :align center :padding-left 8 :padding-right 8
        @panel wl_meta_l :layout column :flex-grow 1
          @text wl_meta_sym :size 12 :color [1 0.8 0 1]
            META
          @text wl_meta_nm :size 9 :color [0.267 0.267 0.353 1]
            Meta
        @panel wl_meta_r :layout column :align end
          @text wl_meta_px :size 11 :color [0.133 0.933 0.333 1]
            525.44
          @text wl_meta_chg :size 9 :color [0.133 0.667 0.267 1]
            +3.11%
      @rect wl_d6 :w 174 :h 1 :fill [0.067 0.067 0.133 1] :margin-left 8

      ;; NVDA
      @panel wl_nvda :w 190 :h 34 :layout row :fill (if (eq (form/ticker) "NVDA") [0.059 0.059 0.133 1] [0 0 0 0]) :align center :padding-left 8 :padding-right 8
        @panel wl_nvda_l :layout column :flex-grow 1
          @text wl_nvda_sym :size 12 :color [1 0.8 0 1]
            NVDA
          @text wl_nvda_nm :size 9 :color [0.267 0.267 0.353 1]
            NVIDIA
        @panel wl_nvda_r :layout column :align end
          @text wl_nvda_px :size 11 :color [0.133 0.933 0.333 1]
            875.39
          @text wl_nvda_chg :size 9 :color [0.133 0.667 0.267 1]
            +5.88%
      @rect wl_d7 :w 174 :h 1 :fill [0.067 0.067 0.133 1] :margin-left 8

      ;; SPY
      @panel wl_spy :w 190 :h 34 :layout row :fill (if (eq (form/ticker) "SPY") [0.059 0.059 0.133 1] [0 0 0 0]) :align center :padding-left 8 :padding-right 8
        @panel wl_spy_l :layout column :flex-grow 1
          @text wl_spy_sym :size 12 :color [1 0.8 0 1]
            SPY
          @text wl_spy_nm :size 9 :color [0.267 0.267 0.353 1]
            S&P 500 ETF
        @panel wl_spy_r :layout column :align end
          @text wl_spy_px :size 11 :color [0.133 0.933 0.333 1]
            510.12
          @text wl_spy_chg :size 9 :color [0.133 0.667 0.267 1]
            +0.55%
      @rect wl_d8 :w 174 :h 1 :fill [0.067 0.067 0.133 1] :margin-left 8

      ;; Portfolio summary
      @rect wl_port_sep :w 190 :h 1 :fill [1 0.4 0 0.333]
      @panel portfolio :w 190 :layout column :fill [0.035 0.035 0.102 1] :padding 8
        @text port_hdr :size 10 :color [1 0.4 0 1]
          PORTFOLIO
        @panel port_row1 :layout row :justify space-between :margin-top 6
          @text port_cash_lbl :size 9 :color [0.333 0.333 0.412 1]
            Cash
          @text port_cash_val :size 9 :color [0.667 0.667 0.733 1]
            $100,000
        @panel port_row2 :layout row :justify space-between :margin-top 4
          @text port_pos_lbl :size 9 :color [0.333 0.333 0.412 1]
            Positions
          @text port_pos_val :size 9 :color [0.667 0.667 0.733 1]
            0 shares
        @panel port_row3 :layout row :justify space-between :margin-top 4
          @text port_pnl_lbl :size 9 :color [0.333 0.333 0.412 1]
            P&L
          @text port_pnl_val :size 9 :color [0.133 0.667 0.267 1]
            $0.00

    ;; Left border
    @rect wl_border :w 1 :h (sub (canvas-height) 55) :fill [0.102 0.102 0.157 1]

    ;; ── CENTER: chart header + GPU chart area ──
    @panel center :layout column :flex-grow 1

      ;; Chart header — ticker info bar
      @panel chart_hdr :layout row :h 42 :fill [0.035 0.035 0.063 1] :align center :padding-left 6 :padding-right 6 :gap 12
        ;; Ticker + name
        @panel ch_ticker :layout column
          @text ch_sym :size 18 :color [1 0.8 0 1]
            AAPL
          @text ch_name :size 9 :color [0.267 0.267 0.353 1]
            APPLE INC
        @rect ch_d1 :w 1 :h 26 :fill [0.2 0.2 0.267 1]
        ;; Last price
        @panel ch_last :layout column
          @text ch_last_lbl :size 8 :color [0.267 0.267 0.345 1]
            LAST
          @text ch_last_px :size 16 :color [1 1 1 1]
            188.42
        @rect ch_d2 :w 1 :h 26 :fill [0.2 0.2 0.267 1]
        ;; Change
        @panel ch_chg :layout column
          @text ch_chg_lbl :size 8 :color [0.267 0.267 0.345 1]
            CHG / CHG%
          @text ch_chg_val :size 12 :color [0.133 0.8 0.267 1]
            +0.84  +0.45%
        @rect ch_d3 :w 1 :h 26 :fill [0.2 0.2 0.267 1]
        ;; OHLC
        @panel ch_ohlc :layout row :gap 14
          @panel ch_o :layout column
            @text ch_o_lbl :size 8 :color [0.267 0.267 0.345 1]
              OPEN
            @text ch_o_val :size 10 :color [0.667 0.667 0.733 1]
              187.58
          @panel ch_h :layout column
            @text ch_h_lbl :size 8 :color [0.267 0.267 0.345 1]
              HIGH
            @text ch_h_val :size 10 :color [0.133 0.933 0.333 1]
              189.91
          @panel ch_l :layout column
            @text ch_l_lbl :size 8 :color [0.267 0.267 0.345 1]
              LOW
            @text ch_l_val :size 10 :color [0.933 0.267 0.267 1]
              186.12
          @panel ch_v :layout column
            @text ch_v_lbl :size 8 :color [0.267 0.267 0.345 1]
              VOL
            @text ch_v_val :size 10 :color [0.667 0.667 0.733 1]
              54.2M
        @rect ch_d4 :w 1 :h 26 :fill [0.2 0.2 0.267 1]
        ;; Bid / Ask
        @panel ch_bidask :layout row :gap 14
          @panel ch_bid :layout column
            @text ch_bid_lbl :size 8 :color [0.267 0.267 0.345 1]
              BID
            @text ch_bid_val :size 10 :color [0.133 0.8 0.267 1]
              188.40
          @panel ch_ask :layout column
            @text ch_ask_lbl :size 8 :color [0.267 0.267 0.345 1]
              ASK
            @text ch_ask_val :size 10 :color [0.933 0.267 0.267 1]
              188.44
      @rect ch_hdr_b :h 1 :fill [0.102 0.102 0.157 1]

      ;; Chart body — transparent filler, GPU renders beneath
      @rect chart_spacer :h 10 :flex-grow 1

    ;; Right border
    @rect ob_lborder :w 1 :h (sub (canvas-height) 55) :fill [0.102 0.102 0.157 1]

    ;; ── RIGHT COLUMN: ORDER BOOK ──
    @panel orderbook :w 200 :layout column :fill [0.027 0.027 0.043 1]

      ;; Header
      @panel ob_hdr :h 24 :layout row :fill [0.055 0.055 0.094 1] :align center :padding-left 6
        @text ob_hdr_txt :size 11 :color [1 0.4 0 1]
          ORDER BOOK
      @rect ob_hdr_b :w 200 :h 1 :fill [0.133 0.133 0.227 1]

      ;; Column headers
      @panel ob_cols :h 18 :layout row :fill [0.031 0.031 0.059 1] :align center :padding-left 4 :padding-right 4
        @text ob_col_sz :size 8 :color [0.267 0.267 0.333 1] :flex-grow 1
          SIZE
        @text ob_col_px :size 8 :color [0.267 0.267 0.333 1] :flex-grow 1
          PRICE
        @text ob_col_sd :size 8 :color [0.267 0.267 0.333 1]
          SIDE

      ;; Ask levels (5 levels, furthest to tightest)
      @panel asks :layout column :fill [0.027 0.008 0.043 1] :padding 4 :gap 2
        @panel a5 :layout row :h 14 :align center :gap 4
          @text a5_sz :size 10 :color [0.733 0.2 0.267 0.667] :flex-grow 1
            1,243
          @text a5_px :size 10 :color [0.8 0.2 0.267 0.733]
            188.56
          @text a5_sd :size 9 :color [0.8 0.2 0.267 0.533]
            ASK
        @panel a4 :layout row :h 14 :align center :gap 4
          @text a4_sz :size 10 :color [0.8 0.2 0.267 0.667] :flex-grow 1
            876
          @text a4_px :size 10 :color [0.8 0.2 0.267 0.8]
            188.52
          @text a4_sd :size 9 :color [0.8 0.2 0.267 0.533]
            ASK
        @panel a3 :layout row :h 14 :align center :gap 4
          @text a3_sz :size 10 :color [0.867 0.2 0.267 0.667] :flex-grow 1
            2,108
          @text a3_px :size 10 :color [0.867 0.2 0.267 0.8]
            188.49
          @text a3_sd :size 9 :color [0.867 0.2 0.267 0.533]
            ASK
        @panel a2 :layout row :h 14 :align center :gap 4
          @text a2_sz :size 10 :color [0.933 0.2 0.267 0.667] :flex-grow 1
            1,567
          @text a2_px :size 10 :color [0.933 0.2 0.267 0.867]
            188.46
          @text a2_sd :size 9 :color [0.933 0.2 0.267 0.667]
            ASK
        @panel a1 :layout row :h 14 :align center :gap 4
          @text a1_sz :size 10 :color [1 0.267 0.333 0.8] :flex-grow 1
            3,412
          @text a1_px :size 10 :color [1 0.267 0.333 1]
            188.44
          @text a1_sd :size 9 :color [1 0.267 0.333 0.8]
            ASK

      ;; Spread
      @panel spread :h 20 :layout row :fill [0.051 0.051 0.11 1] :align center :padding-left 4 :padding-right 4
        @text spread_lbl :size 9 :color [0.333 0.333 0.412 1]
          SPREAD
        @text spread_val :size 10 :color [1 0.8 0 1] :flex-grow 1 :margin-left 8
          $0.04
        @text spread_mid :size 10 :color [0.667 0.667 0.667 1]
          188.42

      ;; Bid levels (5 levels, tightest to furthest)
      @panel bids :layout column :fill [0.008 0.027 0.043 1] :padding 4 :gap 2
        @panel b1 :layout row :h 14 :align center :gap 4
          @text b1_sz :size 10 :color [0.133 0.8 0.267 0.8] :flex-grow 1
            4,891
          @text b1_px :size 10 :color [0.133 0.933 0.333 1]
            188.40
          @text b1_sd :size 9 :color [0.133 0.8 0.267 0.8]
            BID
        @panel b2 :layout row :h 14 :align center :gap 4
          @text b2_sz :size 10 :color [0.133 0.8 0.267 0.667] :flex-grow 1
            2,234
          @text b2_px :size 10 :color [0.133 0.933 0.333 0.867]
            188.37
          @text b2_sd :size 9 :color [0.133 0.8 0.267 0.667]
            BID
        @panel b3 :layout row :h 14 :align center :gap 4
          @text b3_sz :size 10 :color [0.133 0.8 0.267 0.533] :flex-grow 1
            1,788
          @text b3_px :size 10 :color [0.133 0.933 0.333 0.733]
            188.34
          @text b3_sd :size 9 :color [0.133 0.8 0.267 0.533]
            BID
        @panel b4 :layout row :h 14 :align center :gap 4
          @text b4_sz :size 10 :color [0.133 0.8 0.267 0.4] :flex-grow 1
            943
          @text b4_px :size 10 :color [0.133 0.933 0.333 0.6]
            188.31
          @text b4_sd :size 9 :color [0.133 0.8 0.267 0.4]
            BID
        @panel b5 :layout row :h 14 :align center :gap 4
          @text b5_sz :size 10 :color [0.133 0.8 0.267 0.333] :flex-grow 1
            612
          @text b5_px :size 10 :color [0.133 0.933 0.333 0.467]
            188.28
          @text b5_sd :size 9 :color [0.133 0.8 0.267 0.333]
            BID

      ;; Trade blotter
      @rect blot_sep :w 200 :h 1 :fill [0.102 0.102 0.157 1]
      @panel blotter_hdr :h 20 :layout row :fill [0.055 0.055 0.094 1] :align center :padding-left 6
        @text blot_hdr_txt :size 10 :color [1 0.4 0 1]
          TRADE BLOTTER

      @panel blotter :layout column :padding 4 :gap 4
        @panel bl1 :layout row :h 12 :align center :gap 6
          @text bl1_t :size 9 :color [0.267 0.267 0.333 1]
            09:32:14
          @text bl1_s :size 9 :color [0.133 0.8 0.267 1]
            BUY
          @text bl1_q :size 9 :color [0.667 0.667 0.733 1]
            100
          @text bl1_p :size 9 :color [0.667 0.667 0.733 1]
            188.24
        @panel bl2 :layout row :h 12 :align center :gap 6
          @text bl2_t :size 9 :color [0.267 0.267 0.333 1]
            09:45:03
          @text bl2_s :size 9 :color [0.933 0.267 0.267 1]
            SELL
          @text bl2_q :size 9 :color [0.667 0.667 0.733 1]
            50
          @text bl2_p :size 9 :color [0.667 0.667 0.733 1]
            188.91
        @panel bl3 :layout row :h 12 :align center :gap 6
          @text bl3_t :size 9 :color [0.267 0.267 0.333 1]
            10:01:47
          @text bl3_s :size 9 :color [0.133 0.8 0.267 1]
            BUY
          @text bl3_q :size 9 :color [0.667 0.667 0.733 1]
            200
          @text bl3_p :size 9 :color [0.667 0.667 0.733 1]
            187.55

      ;; BUY / SELL buttons
      @panel buttons :layout row :gap 6 :padding 4
        @rect buy_btn :w 88 :h 24 :fill [0.086 0.2 0.133 1] :stroke [0.133 0.8 0.267 1] :stroke-width 1 :radius 3
        @text buy_lbl :size 10 :color [0.133 0.933 0.333 1] :position absolute :left 18 :top 7
          BUY 100
        @rect sell_btn :w 88 :h 24 :fill [0.2 0.086 0.086 1] :stroke [0.8 0.2 0.267 1] :stroke-width 1 :radius 3
        @text sell_lbl :size 10 :color [0.933 0.267 0.333 1] :position absolute :left 110 :top 7
          SELL 100

  ;; ── INDICES BAR ──────────────────────────────────────────────────────
  @panel indices :h 28 :layout row :fill [0.035 0.035 0.055 1] :align center :padding-left 6 :padding-right 6 :gap 10
    @text idx_spx :size 9 :color [0.467 0.467 0.533 1]
      SPX
    @text idx_spx_v :size 10 :color [0.133 0.8 0.267 1]
      5,121
    @text idx_spx_c :size 9 :color [0.133 0.667 0.267 1]
      +0.55%
    @rect idx_d1 :w 1 :h 14 :fill [0.2 0.2 0.267 1]
    @text idx_ndx :size 9 :color [0.467 0.467 0.533 1]
      NDX
    @text idx_ndx_v :size 10 :color [0.133 0.8 0.267 1]
      18,003
    @text idx_ndx_c :size 9 :color [0.133 0.667 0.267 1]
      +0.83%
    @rect idx_d2 :w 1 :h 14 :fill [0.2 0.2 0.267 1]
    @text idx_vix :size 9 :color [0.467 0.467 0.533 1]
      VIX
    @text idx_vix_v :size 10 :color [0.933 0.6 0.267 1]
      14.82
    @text idx_vix_c :size 9 :color [0.933 0.267 0.267 1]
      +2.11%
    @rect idx_d3 :w 1 :h 14 :fill [0.2 0.2 0.267 1]
    @text idx_btc :size 9 :color [0.467 0.467 0.533 1]
      BTC
    @text idx_btc_v :size 10 :color [0.133 0.8 0.267 1]
      67,234
    @text idx_btc_c :size 9 :color [0.133 0.667 0.267 1]
      +1.44%
    @rect idx_d4 :w 1 :h 14 :fill [0.2 0.2 0.267 1]
    @text idx_dxy :size 9 :color [0.467 0.467 0.533 1]
      DXY
    @text idx_dxy_v :size 10 :color [0.933 0.267 0.267 1]
      103.21
    @text idx_dxy_c :size 9 :color [0.933 0.2 0.2 1]
      -0.18%
    @rect idx_d5 :w 1 :h 14 :fill [0.2 0.2 0.267 1]
    @text idx_tnx :size 9 :color [0.467 0.467 0.533 1]
      10Y
    @text idx_tnx_v :size 10 :color [0.933 0.6 0.267 1]
      4.31%
    @text idx_tnx_c :size 9 :color [0.933 0.267 0.267 1]
      +3bp
  @rect idx_top :w (canvas-width) :h 1 :fill [0.102 0.102 0.157 1] :z-index 1

  ;; ── NEWS TICKER ──────────────────────────────────────────────────────
  @panel news :h 27 :layout row :fill [0.035 0.035 0.047 1]
    @rect news_top :w (canvas-width) :h 1 :fill [1 0.4 0 0.333] :position absolute :top 0 :left 0
    @panel news_lbl_bg :w 62 :h 27 :fill [1 0.4 0 1] :align center :justify center
      @text news_lbl :size 11 :color [0 0 0 1]
        NEWS
    @panel news_clip :layout row :flex-grow 1 :overflow hidden :align center :padding-left 6
      @text t_news_scroll :size 11 :color [0.867 0.867 0.737 1] :x (mul (fract (mul (elapsed) 0.028)) (sub 0 2200))
        AAPL Q1 EARNINGS BEAT ESTIMATES — EPS $2.18 vs $2.09 EST  *  FED HOLDS RATES — POWELL SIGNALS PATIENCE  *  NVDA SURGES +8% ON AI SERVER DEMAND  *  TSLA CUTS PRICES IN EU/ASIA — MARGINS UNDER PRESSURE  *  META RELEASES LLAMA-4 — OUTPERFORMS GPT-4  *  S&P 500 HITS ALL-TIME HIGH  *  MSFT AZURE +29% ON AI WORKLOADS  *  GOOGL ANTITRUST RULING — DOJ SEEKS SEARCH BREAKUP  *
