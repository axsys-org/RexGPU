;; ═══════════════════════════════════════════════════════════════════════════
;; Bloomberg Terminal — Rex Projection Engine
;; GPU GBM price simulation · SDF text · full flexbox layout
;; ═══════════════════════════════════════════════════════════════════════════

;; ── Uniform struct (8 × f32 = 32 bytes, 256-padded on heap) ──
@struct BInp
  @field time  :type f32
  @field dt    :type f32
  @field resx  :type f32
  @field resy  :type f32
  @field tick  :type f32
  @field vol   :type f32
  @field tid   :type f32
  @field pad0  :type f32

;; Storage buffers
;; price_buf: 8 tickers × 512 f32 = 16384 bytes
@buffer price_buf :usage [storage] :size 16384
;; stat_buf: 8 tickers × 8 f32 = 256 bytes  (open, close, hi, lo, chg, chgpct, bid, ask)
@buffer stat_buf  :usage [storage] :size 256

;; Uniform (on heap)
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

;; ── Compute: GBM price evolution (8 workgroups = 8 tickers) ──
@shader bloom_sim
  @group(0) @binding(0) var<storage, read_write> prices: array<f32>;
  @group(0) @binding(1) var<storage, read_write> stats: array<f32>;
  @group(1) @binding(0) var<uniform> u: BInp;

  fn hash(n: f32) -> f32 { return fract(sin(n) * 43758.5453); }
  fn noise(t: f32, s: f32) -> f32 {
    let i = floor(t); let f = fract(t);
    let sm = f * f * (3.0 - 2.0 * f);
    let h0 = hash(i * 127.1 + s * 311.7);
    let h1 = hash((i+1.0) * 127.1 + s * 311.7);
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
      for (var i = 0u; i < 512u; i++) {
        let ft = f32(i) * 0.5 + seed;
        let dW = noise(ft, seed) * 0.22;
        p = p * exp(sigma * dW);
        p = clamp(p, base * 0.4, base * 2.8);
        prices[boff + i] = p;
      }
    }

    // Evolve current tick
    let sidx = u32(t) % 512u;
    let pidx = (sidx + 511u) % 512u;
    let prev = prices[boff + pidx];
    let dW = noise(t * 3.7 + seed, seed + t * 0.01) * sqrt(max(u.dt, 0.001));
    var cur = prev * exp(sigma * 6.0 * dW);
    cur = clamp(cur, base * 0.4, base * 2.8);
    prices[boff + sidx] = cur;

    // Stats: open(oldest), close(newest), hi, lo, chg, chgpct, bid, ask
    let open = prices[boff + ((sidx + 1u) % 512u)];
    var hi = cur; var lo = cur;
    for (var k = 0u; k < 512u; k++) {
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

;; ── Fragment: draw price chart + volume bars ──
@shader bloom_chart
  @group(0) @binding(0) var<storage, read> prices: array<f32>;
  @group(0) @binding(1) var<storage, read> stats: array<f32>;
  @group(1) @binding(0) var<uniform> u: BInp;

  struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
  @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    var p = array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
    var o: VSOut;
    o.pos = vec4f(p[vi],0,1);
    o.uv = vec2f(p[vi].x*.5+.5, .5-p[vi].y*.5);
    return o;
  }

  fn lsdf(p: vec2f, a: vec2f, b: vec2f) -> f32 {
    let pa = p-a; let ba = b-a;
    let h = clamp(dot(pa,ba)/dot(ba,ba),0.,1.);
    return length(pa - ba*h);
  }

  @fragment fn fs_main(v: VSOut) -> @location(0) vec4f {
    let px = v.uv * vec2f(u.resx, u.resy);
    let tk = u32(clamp(u.tid, 0., 7.));
    let boff = tk * 512u;
    let soff = tk * 8u;

    let s_lo = stats[soff + 3u];
    let s_hi = stats[soff + 2u];
    let rng = max(s_hi - s_lo, s_lo * 0.005);

    let cy1 = u.resy * 0.80;
    let vy0 = u.resy * 0.82;
    let vy1 = u.resy;

    var col = vec3f(0.03, 0.03, 0.05);

    // grid
    for (var gi = 0u; gi < 9u; gi++) {
      let gy = cy1 * f32(gi) / 8.0;
      if (abs(px.y - gy) < 0.6) { col = vec3f(0.10, 0.10, 0.14); }
      let gx = u.resx * f32(gi) / 8.0;
      if (abs(px.x - gx) < 0.6) { col = vec3f(0.10, 0.10, 0.14); }
    }
    if (abs(px.y - vy0 + 1.0) < 1.0) { col = vec3f(0.18, 0.18, 0.24); }

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

    if (md < 1.4 && px.y < cy1) {
      let br = 1.0 - smoothstep(0.0, 1.4, md);
      let lc = select(vec3f(0.85, 0.20, 0.20), vec3f(0.18, 0.85, 0.35), seg_up);
      col = mix(col, lc, br);
    }
    if (px.y < cy1 && px.y > yc) {
      let fade = 1.0 - (px.y - yc) / (cy1 - yc);
      let open_px = stats[soff + 0u]; let close_px = stats[soff + 1u];
      let fc = select(vec3f(0.65, 0.08, 0.08), vec3f(0.08, 0.58, 0.20), close_px >= open_px);
      col = mix(col, fc, fade*fade*0.20);
    }
    if (px.y >= vy0 && px.y <= vy1) {
      let vd = abs(pc - pp) / rng * 0.85 + 0.04;
      let vy_bar = vy1 - vd * (vy1 - vy0);
      if (px.y >= vy_bar) {
        col = select(vec3f(0.48, 0.12, 0.12), vec3f(0.10, 0.40, 0.18), pc >= pp);
      }
    }
    let last = stats[soff + 1u];
    let cur_y = cy1 - (last - s_lo) / rng * cy1;
    if (abs(px.y - cur_y) < 0.7 && px.y < cy1) {
      col = mix(col, vec3f(0.95, 0.78, 0.12), 0.65);
    }
    return vec4f(col, 1.0);
  }

;; ── Pipelines ──
@pipeline p_sim  :compute bloom_sim :entry cs_main
@pipeline p_chart :vertex bloom_chart :fragment bloom_chart :format canvas :topology triangle-list

;; ── Commands ──
@dispatch d_sim :pipeline p_sim :grid [8 1 1]
  @bind 0 :storage [price_buf stat_buf]
  @bind 1 :buffer b_inp

@pass p_main :clear [0.03 0.03 0.05 1]
  @draw :pipeline p_chart :vertices 6
    @bind 0 :storage [price_buf stat_buf]
    @bind 1 :buffer b_inp

;; ── Form ──
@form controls :title "Bloomberg Terminal"
  @field ticker     :type select :label "Ticker" :options [AAPL MSFT GOOGL AMZN TSLA META NVDA SPY] :default AAPL
  @field speed      :type range  :label "Speed"   :default 3.0 :min 0.5 :max 15.0 :step 0.5
  @field volatility :type range  :label "Vol"     :default 1.0 :min 0.2 :max 4.0  :step 0.1

;; ═══════════════════════════════════════════════════════════════════════════
;; SURFACE LAYER — full flexbox layout
;; Uses @panel with layout/gap/padding/flex-grow/align/justify
;; ═══════════════════════════════════════════════════════════════════════════

;; ROOT: full-screen column layout
@panel root :w (canvas-width) :h (canvas-height) :layout column

  ;; ── TOP BAR ─────────────────────────────────────────────────────────────
  @panel topbar :w (canvas-width) :h 26 :layout row :fill "#0a0a0dff" :align center :padding-left 10 :padding-right 10
    @text t_logo :size 13 :color "#ff6600ff"
      BLOOMBERG
    @rect sep1 :w 1 :h 14 :fill "#333344ff" :margin-left 8 :margin-right 8
    @text t_mode :size 11 :color "#999abbff"
      TERMINAL
    @rect sep2 :w 1 :h 14 :fill "#333344ff" :margin-left 8 :margin-right 8
    @text t_mkt :size 11 :color "#ffcc00ff"
      EQUITY
    @rect spacer_top :w 10 :h 1 :flex-grow 1
    @text t_conn :size 10 :color "#22cc44ff"
      ● NYSE  NASDAQ  LIVE
    @text t_dot :size 11 :color (if (lt (fract (mul (elapsed) 1.5)) 0.5) "#22ee44ff" "#00000000") :margin-left 6
      ●
  @rect topbar_border :w (canvas-width) :h 1 :fill "#ff660066"

  ;; ── MAIN BODY: watchlist | chart area | order book ──────────────────────
  @panel body :layout row :flex-grow 1

    ;; ── LEFT: WATCHLIST ──
    @panel watchlist :w 190 :layout column :fill "#07070bff"
      ;; Header
      @panel wl_hdr :w 190 :h 24 :layout row :fill "#0e0e18ff" :align center :padding-left 8
        @text wl_hdr_txt :size 11 :color "#ff6600ff"
          WATCHLIST
      @rect wl_hdr_b :w 190 :h 1 :fill "#22223aff"

      ;; Ticker rows
      @panel wl_aapl :w 190 :h 34 :layout row :fill (if (eq (form/ticker) "AAPL") "#0f0f22ff" "#00000000") :align center :padding-left 8 :padding-right 8
        @panel wl_aapl_left :layout column :flex-grow 1
          @text wl_aapl_sym :size 12 :color "#ffcc00ff"
            AAPL
          @text wl_aapl_nm :size 9 :color "#44445aff"
            Apple Inc
        @panel wl_aapl_right :layout column :align end
          @text wl_aapl_px :size 11 :color "#22ee55ff"
            188.42
          @text wl_aapl_chg :size 9 :color "#22aa44ff"
            +0.84%
      @rect wl_d1 :w 174 :h 1 :fill "#111122ff" :margin-left 8

      @panel wl_msft :w 190 :h 34 :layout row :fill (if (eq (form/ticker) "MSFT") "#0f0f22ff" "#00000000") :align center :padding-left 8 :padding-right 8
        @panel wl_msft_left :layout column :flex-grow 1
          @text wl_msft_sym :size 12 :color "#ffcc00ff"
            MSFT
          @text wl_msft_nm :size 9 :color "#44445aff"
            Microsoft
        @panel wl_msft_right :layout column :align end
          @text wl_msft_px :size 11 :color "#22ee55ff"
            415.10
          @text wl_msft_chg :size 9 :color "#22aa44ff"
            +1.22%
      @rect wl_d2 :w 174 :h 1 :fill "#111122ff" :margin-left 8

      @panel wl_googl :w 190 :h 34 :layout row :fill (if (eq (form/ticker) "GOOGL") "#0f0f22ff" "#00000000") :align center :padding-left 8 :padding-right 8
        @panel wl_googl_left :layout column :flex-grow 1
          @text wl_googl_sym :size 12 :color "#ffcc00ff"
            GOOGL
          @text wl_googl_nm :size 9 :color "#44445aff"
            Alphabet
        @panel wl_googl_right :layout column :align end
          @text wl_googl_px :size 11 :color "#ee4444ff"
            172.35
          @text wl_googl_chg :size 9 :color "#ee3333ff"
            -0.43%
      @rect wl_d3 :w 174 :h 1 :fill "#111122ff" :margin-left 8

      @panel wl_amzn :w 190 :h 34 :layout row :fill (if (eq (form/ticker) "AMZN") "#0f0f22ff" "#00000000") :align center :padding-left 8 :padding-right 8
        @panel wl_amzn_left :layout column :flex-grow 1
          @text wl_amzn_sym :size 12 :color "#ffcc00ff"
            AMZN
          @text wl_amzn_nm :size 9 :color "#44445aff"
            Amazon
        @panel wl_amzn_right :layout column :align end
          @text wl_amzn_px :size 11 :color "#22ee55ff"
            196.88
          @text wl_amzn_chg :size 9 :color "#22aa44ff"
            +2.07%
      @rect wl_d4 :w 174 :h 1 :fill "#111122ff" :margin-left 8

      @panel wl_tsla :w 190 :h 34 :layout row :fill (if (eq (form/ticker) "TSLA") "#0f0f22ff" "#00000000") :align center :padding-left 8 :padding-right 8
        @panel wl_tsla_left :layout column :flex-grow 1
          @text wl_tsla_sym :size 12 :color "#ffcc00ff"
            TSLA
          @text wl_tsla_nm :size 9 :color "#44445aff"
            Tesla
        @panel wl_tsla_right :layout column :align end
          @text wl_tsla_px :size 11 :color "#ee4444ff"
            248.20
          @text wl_tsla_chg :size 9 :color "#ee3333ff"
            -1.55%
      @rect wl_d5 :w 174 :h 1 :fill "#111122ff" :margin-left 8

      @panel wl_meta :w 190 :h 34 :layout row :fill (if (eq (form/ticker) "META") "#0f0f22ff" "#00000000") :align center :padding-left 8 :padding-right 8
        @panel wl_meta_left :layout column :flex-grow 1
          @text wl_meta_sym :size 12 :color "#ffcc00ff"
            META
          @text wl_meta_nm :size 9 :color "#44445aff"
            Meta
        @panel wl_meta_right :layout column :align end
          @text wl_meta_px :size 11 :color "#22ee55ff"
            525.44
          @text wl_meta_chg :size 9 :color "#22aa44ff"
            +3.11%
      @rect wl_d6 :w 174 :h 1 :fill "#111122ff" :margin-left 8

      @panel wl_nvda :w 190 :h 34 :layout row :fill (if (eq (form/ticker) "NVDA") "#0f0f22ff" "#00000000") :align center :padding-left 8 :padding-right 8
        @panel wl_nvda_left :layout column :flex-grow 1
          @text wl_nvda_sym :size 12 :color "#ffcc00ff"
            NVDA
          @text wl_nvda_nm :size 9 :color "#44445aff"
            NVIDIA
        @panel wl_nvda_right :layout column :align end
          @text wl_nvda_px :size 11 :color "#22ee55ff"
            875.39
          @text wl_nvda_chg :size 9 :color "#22aa44ff"
            +5.88%
      @rect wl_d7 :w 174 :h 1 :fill "#111122ff" :margin-left 8

      @panel wl_spy :w 190 :h 34 :layout row :fill (if (eq (form/ticker) "SPY") "#0f0f22ff" "#00000000") :align center :padding-left 8 :padding-right 8
        @panel wl_spy_left :layout column :flex-grow 1
          @text wl_spy_sym :size 12 :color "#ffcc00ff"
            SPY
          @text wl_spy_nm :size 9 :color "#44445aff"
            S&P 500 ETF
        @panel wl_spy_right :layout column :align end
          @text wl_spy_px :size 11 :color "#22ee55ff"
            510.12
          @text wl_spy_chg :size 9 :color "#22aa44ff"
            +0.55%
      @rect wl_d8 :w 174 :h 1 :fill "#111122ff" :margin-left 8

      ;; Portfolio summary
      @rect wl_port_sep :w 190 :h 1 :fill "#ff660055"
      @panel portfolio :w 190 :layout column :fill "#09091aff" :padding 8
        @text port_hdr :size 10 :color "#ff6600ff"
          PORTFOLIO
        @panel port_row1 :layout row :justify space-between :margin-top 6
          @text port_cash_lbl :size 9 :color "#555568ff"
            Cash
          @text port_cash_val :size 9 :color "#aaaabbff"
            $100,000
        @panel port_row2 :layout row :justify space-between :margin-top 4
          @text port_pos_lbl :size 9 :color "#555568ff"
            Positions
          @text port_pos_val :size 9 :color "#aaaabbff"
            0 shares
        @panel port_row3 :layout row :justify space-between :margin-top 4
          @text port_pnl_lbl :size 9 :color "#555568ff"
            P&L
          @text port_pnl_val :size 9 :color "#22aa44ff"
            $0.00

    ;; Left border
    @rect wl_border :w 1 :h (sub (canvas-height) 55) :fill "#1a1a28ff"

    ;; ── CENTER: chart header + GPU chart area ──
    @panel center :layout column :flex-grow 1

      ;; Chart header — ticker info bar
      @panel chart_hdr :layout row :h 42 :fill "#090910ff" :align center :padding-left 6 :padding-right 6 :gap 12
        ;; Ticker + name
        @panel ch_ticker :layout column
          @text ch_sym :size 18 :color "#ffcc00ff"
            AAPL
          @text ch_name :size 9 :color "#44445aff"
            APPLE INC
        @rect ch_d1 :w 1 :h 26 :fill "#333344ff"
        ;; Last price
        @panel ch_last :layout column
          @text ch_last_lbl :size 8 :color "#444458ff"
            LAST
          @text ch_last_px :size 16 :color "#ffffffff"
            188.42
        @rect ch_d2 :w 1 :h 26 :fill "#333344ff"
        ;; Change
        @panel ch_chg :layout column
          @text ch_chg_lbl :size 8 :color "#444458ff"
            CHG / CHG%
          @text ch_chg_val :size 12 :color "#22cc44ff"
            +0.84  +0.45%
        @rect ch_d3 :w 1 :h 26 :fill "#333344ff"
        ;; OHLC
        @panel ch_ohlc :layout row :gap 14
          @panel ch_o :layout column
            @text ch_o_lbl :size 8 :color "#444458ff"
              OPEN
            @text ch_o_val :size 10 :color "#aaaabbff"
              187.58
          @panel ch_h :layout column
            @text ch_h_lbl :size 8 :color "#444458ff"
              HIGH
            @text ch_h_val :size 10 :color "#22ee55ff"
              189.91
          @panel ch_l :layout column
            @text ch_l_lbl :size 8 :color "#444458ff"
              LOW
            @text ch_l_val :size 10 :color "#ee4444ff"
              186.12
          @panel ch_v :layout column
            @text ch_v_lbl :size 8 :color "#444458ff"
              VOL
            @text ch_v_val :size 10 :color "#aaaabbff"
              54.2M
        @rect ch_d4 :w 1 :h 26 :fill "#333344ff"
        ;; Bid / Ask
        @panel ch_bidask :layout row :gap 14
          @panel ch_bid :layout column
            @text ch_bid_lbl :size 8 :color "#444458ff"
              BID
            @text ch_bid_val :size 10 :color "#22cc44ff"
              188.40
          @panel ch_ask :layout column
            @text ch_ask_lbl :size 8 :color "#444458ff"
              ASK
            @text ch_ask_val :size 10 :color "#ee4444ff"
              188.44
      @rect ch_hdr_b :h 1 :fill "#1a1a28ff"

      ;; Chart body — GPU renders here (transparent filler so surface doesn't cover it)
      @rect chart_spacer :h 10 :flex-grow 1

    ;; Right border
    @rect ob_lborder :w 1 :h (sub (canvas-height) 55) :fill "#1a1a28ff"

    ;; ── RIGHT: ORDER BOOK ──
    @panel orderbook :w 200 :layout column :fill "#07070bff"
      ;; Header
      @panel ob_hdr :h 24 :layout row :fill "#0e0e18ff" :align center :padding-left 6
        @text ob_hdr_txt :size 11 :color "#ff6600ff"
          ORDER BOOK
      @rect ob_hdr_b :w 200 :h 1 :fill "#22223aff"

      ;; Column headers
      @panel ob_cols :h 18 :layout row :fill "#08080fff" :align center :padding-left 4 :padding-right 4
        @text ob_col_sz :size 8 :color "#444455ff" :flex-grow 1
          SIZE
        @text ob_col_px :size 8 :color "#444455ff" :flex-grow 1
          PRICE
        @text ob_col_sd :size 8 :color "#444455ff"
          SIDE

      ;; Ask levels (5 levels, furthest to tightest)
      @panel asks :layout column :fill "#07020bff" :padding 4 :gap 2
        @panel a5 :layout row :h 14 :align center :gap 4
          @text a5_sz :size 10 :color "#bb3344aa" :flex-grow 1
            1,243
          @text a5_px :size 10 :color "#cc3344bb"
            188.56
          @text a5_sd :size 9 :color "#cc334488"
            ASK
        @panel a4 :layout row :h 14 :align center :gap 4
          @text a4_sz :size 10 :color "#cc3344aa" :flex-grow 1
            876
          @text a4_px :size 10 :color "#cc3344cc"
            188.52
          @text a4_sd :size 9 :color "#cc334488"
            ASK
        @panel a3 :layout row :h 14 :align center :gap 4
          @text a3_sz :size 10 :color "#dd3344aa" :flex-grow 1
            2,108
          @text a3_px :size 10 :color "#dd3344cc"
            188.49
          @text a3_sd :size 9 :color "#dd334488"
            ASK
        @panel a2 :layout row :h 14 :align center :gap 4
          @text a2_sz :size 10 :color "#ee3344aa" :flex-grow 1
            1,567
          @text a2_px :size 10 :color "#ee3344dd"
            188.46
          @text a2_sd :size 9 :color "#ee3344aa"
            ASK
        @panel a1 :layout row :h 14 :align center :gap 4
          @text a1_sz :size 10 :color "#ff4455cc" :flex-grow 1
            3,412
          @text a1_px :size 10 :color "#ff4455ff"
            188.44
          @text a1_sd :size 9 :color "#ff4455cc"
            ASK

      ;; Spread
      @panel spread :h 20 :layout row :fill "#0d0d1cff" :align center :padding-left 4 :padding-right 4
        @text spread_lbl :size 9 :color "#555568ff"
          SPREAD
        @text spread_val :size 10 :color "#ffcc00ff" :flex-grow 1 :margin-left 8
          $0.04
        @text spread_mid :size 10 :color "#aaaaaaff"
          188.42

      ;; Bid levels (5 levels, tightest to furthest)
      @panel bids :layout column :fill "#02070bff" :padding 4 :gap 2
        @panel b1 :layout row :h 14 :align center :gap 4
          @text b1_sz :size 10 :color "#22cc44cc" :flex-grow 1
            4,891
          @text b1_px :size 10 :color "#22ee55ff"
            188.40
          @text b1_sd :size 9 :color "#22cc44cc"
            BID
        @panel b2 :layout row :h 14 :align center :gap 4
          @text b2_sz :size 10 :color "#22cc44aa" :flex-grow 1
            2,234
          @text b2_px :size 10 :color "#22ee55dd"
            188.37
          @text b2_sd :size 9 :color "#22cc44aa"
            BID
        @panel b3 :layout row :h 14 :align center :gap 4
          @text b3_sz :size 10 :color "#22cc4488" :flex-grow 1
            1,788
          @text b3_px :size 10 :color "#22ee55bb"
            188.34
          @text b3_sd :size 9 :color "#22cc4488"
            BID
        @panel b4 :layout row :h 14 :align center :gap 4
          @text b4_sz :size 10 :color "#22cc4466" :flex-grow 1
            943
          @text b4_px :size 10 :color "#22ee5599"
            188.31
          @text b4_sd :size 9 :color "#22cc4466"
            BID
        @panel b5 :layout row :h 14 :align center :gap 4
          @text b5_sz :size 10 :color "#22cc4455" :flex-grow 1
            612
          @text b5_px :size 10 :color "#22ee5577"
            188.28
          @text b5_sd :size 9 :color "#22cc4455"
            BID

      ;; Trade blotter
      @rect blot_sep :w 200 :h 1 :fill "#1a1a28ff"
      @panel blotter_hdr :h 20 :layout row :fill "#0e0e18ff" :align center :padding-left 6
        @text blot_hdr_txt :size 10 :color "#ff6600ff"
          TRADE BLOTTER

      @panel blotter :layout column :padding 4 :gap 4
        @panel bl1 :layout row :h 12 :align center :gap 6
          @text bl1_t :size 9 :color "#444455ff"
            09:32:14
          @text bl1_s :size 9 :color "#22cc44ff"
            BUY
          @text bl1_q :size 9 :color "#aaaabbff"
            100
          @text bl1_p :size 9 :color "#aaaabbff"
            188.24
        @panel bl2 :layout row :h 12 :align center :gap 6
          @text bl2_t :size 9 :color "#444455ff"
            09:45:03
          @text bl2_s :size 9 :color "#ee4444ff"
            SELL
          @text bl2_q :size 9 :color "#aaaabbff"
            50
          @text bl2_p :size 9 :color "#aaaabbff"
            188.91
        @panel bl3 :layout row :h 12 :align center :gap 6
          @text bl3_t :size 9 :color "#444455ff"
            10:01:47
          @text bl3_s :size 9 :color "#22cc44ff"
            BUY
          @text bl3_q :size 9 :color "#aaaabbff"
            200
          @text bl3_p :size 9 :color "#aaaabbff"
            187.55

      ;; BUY/SELL buttons
      @panel buttons :layout row :gap 6 :padding 4
        @rect buy_btn :w 88 :h 24 :fill "#163322ff" :stroke "#22cc44ff" :stroke-width 1 :radius 3
        @text buy_lbl :size 10 :color "#22ee55ff" :position absolute :left 18 :top 7
          BUY 100
        @rect sell_btn :w 88 :h 24 :fill "#331616ff" :stroke "#cc3344ff" :stroke-width 1 :radius 3
        @text sell_lbl :size 10 :color "#ee4455ff" :position absolute :left 110 :top 7
          SELL 100

  ;; ── INDICES BAR ──────────────────────────────────────────────────────────
  @panel indices :h 28 :layout row :fill "#09090eff" :align center :padding-left 6 :padding-right 6 :gap 10
    @text idx_spx :size 9 :color "#777788ff"
      SPX
    @text idx_spx_v :size 10 :color "#22cc44ff"
      5,121
    @text idx_spx_c :size 9 :color "#22aa44ff"
      +0.55%
    @rect idx_d1 :w 1 :h 14 :fill "#333344ff"
    @text idx_ndx :size 9 :color "#777788ff"
      NDX
    @text idx_ndx_v :size 10 :color "#22cc44ff"
      18,003
    @text idx_ndx_c :size 9 :color "#22aa44ff"
      +0.83%
    @rect idx_d2 :w 1 :h 14 :fill "#333344ff"
    @text idx_vix :size 9 :color "#777788ff"
      VIX
    @text idx_vix_v :size 10 :color "#ee9944ff"
      14.82
    @text idx_vix_c :size 9 :color "#ee4444ff"
      +2.11%
    @rect idx_d3 :w 1 :h 14 :fill "#333344ff"
    @text idx_btc :size 9 :color "#777788ff"
      BTC
    @text idx_btc_v :size 10 :color "#22cc44ff"
      67,234
    @text idx_btc_c :size 9 :color "#22aa44ff"
      +1.44%
    @rect idx_d4 :w 1 :h 14 :fill "#333344ff"
    @text idx_dxy :size 9 :color "#777788ff"
      DXY
    @text idx_dxy_v :size 10 :color "#ee4444ff"
      103.21
    @text idx_dxy_c :size 9 :color "#ee3333ff"
      -0.18%
    @rect idx_d5 :w 1 :h 14 :fill "#333344ff"
    @text idx_tnx :size 9 :color "#777788ff"
      10Y
    @text idx_tnx_v :size 10 :color "#ee9944ff"
      4.31%
    @text idx_tnx_c :size 9 :color "#ee4444ff"
      +3bp
  @rect idx_top :w (canvas-width) :h 1 :fill "#1a1a28ff" :z-index 1

  ;; ── NEWS TICKER ──────────────────────────────────────────────────────────
  @panel news :h 27 :layout row :fill "#09090cff"
    @rect news_top :w (canvas-width) :h 1 :fill "#ff660055" :position absolute :top 0 :left 0
    @panel news_lbl_bg :w 62 :h 27 :fill "#ff6600ff" :align center :justify center
      @text news_lbl :size 11 :color "#000000ff"
        NEWS
    @panel news_clip :layout row :flex-grow 1 :overflow hidden :align center :padding-left 6
      @text t_news_scroll :size 11 :color "#ddddbcff" :x (mul (fract (mul (elapsed) 0.028)) (sub 0 2200))
        AAPL Q1 EARNINGS BEAT ESTIMATES — EPS $2.18 vs $2.09 EST  ●  FED HOLDS RATES — POWELL SIGNALS PATIENCE  ●  NVDA SURGES +8% ON AI SERVER DEMAND  ●  TSLA CUTS PRICES IN EU/ASIA — MARGINS UNDER PRESSURE  ●  META RELEASES LLAMA-4 — OUTPERFORMS GPT-4  ●  S&P 500 HITS ALL-TIME HIGH  ●  MSFT AZURE +29% ON AI WORKLOADS  ●  GOOGL ANTITRUST RULING — DOJ SEEKS SEARCH BREAKUP  ●
