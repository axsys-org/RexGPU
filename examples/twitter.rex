;; ═══════════════════════════════════════════════════════════════════════════
;; Twitter / X — Rex Projection Engine
;; Full social media UI · SDF text · flexbox layout · interactive feed
;; Form-driven tab switching, like/retweet/bookmark, compose, notifications
;; ═══════════════════════════════════════════════════════════════════════════

;; ── Behaviour: app state ──────────────────────────────────────────────────
@shrub app
  @slot tab :type string :default "home"
  @slot compose-open :type f32 :default 0
  @slot notify-count :type f32 :default 3
  @slot dm-count :type f32 :default 2
  @slot like-1 :type f32 :default 0
  @slot like-2 :type f32 :default 0
  @slot like-3 :type f32 :default 0
  @slot like-4 :type f32 :default 0
  @slot like-5 :type f32 :default 0
  @slot rt-1 :type f32 :default 0
  @slot rt-2 :type f32 :default 0
  @slot rt-3 :type f32 :default 0
  @slot rt-4 :type f32 :default 0
  @slot rt-5 :type f32 :default 0
  @slot bk-1 :type f32 :default 0
  @slot bk-2 :type f32 :default 0
  @slot bk-3 :type f32 :default 0
  @slot bk-4 :type f32 :default 0
  @slot bk-5 :type f32 :default 0
  @slot scroll :type f32 :default 0

;; ── Form: interactive controls ────────────────────────────────────────────
@form controls :title "Twitter Controls"
  @section tabs :title "Navigation"
    @field tab :type select :label "Tab" :options [home explore notifications messages bookmarks profile] :default home
    @field compose :type toggle :label "Compose" :default 0
  @section engagement :title "Engagement"
    @field like1 :type toggle :label "Like Tweet 1" :default 0
    @field like2 :type toggle :label "Like Tweet 2" :default 0
    @field like3 :type toggle :label "Like Tweet 3" :default 0
    @field like4 :type toggle :label "Like Tweet 4" :default 0
    @field like5 :type toggle :label "Like Tweet 5" :default 0
    @field rt1 :type toggle :label "Retweet 1" :default 0
    @field rt2 :type toggle :label "Retweet 2" :default 0
    @field rt3 :type toggle :label "Retweet 3" :default 0
    @field rt4 :type toggle :label "Retweet 4" :default 0
    @field rt5 :type toggle :label "Retweet 5" :default 0
    @field bk1 :type toggle :label "Bookmark 1" :default 0
    @field bk2 :type toggle :label "Bookmark 2" :default 0
    @field bk3 :type toggle :label "Bookmark 3" :default 0
    @field bk4 :type toggle :label "Bookmark 4" :default 0
    @field bk5 :type toggle :label "Bookmark 5" :default 0
  @section theme :title "Theme"
    @field darkmode :type toggle :label "Dark Mode" :default 1
    @field accent :type color :label "Accent Color" :default "#1d9bf0"
    @field fontscale :type range :label "Font Scale" :default 1.0 :min 0.8 :max 1.4 :step 0.05

;; ═══════════════════════════════════════════════════════════════════════════
;; COLOR PALETTE (Twitter dark theme defaults)
;;   bg-primary:    [0.000 0.000 0.000 1]  #000000
;;   bg-secondary:  [0.063 0.071 0.078 1]  #101214
;;   bg-elevated:   [0.098 0.110 0.118 1]  #191c1e
;;   border:        [0.184 0.200 0.216 1]  #2f3336
;;   text-primary:  [0.910 0.929 0.937 1]  #e8edee
;;   text-secondary:[0.443 0.498 0.529 1]  #717f87
;;   accent:        [0.114 0.608 0.941 1]  #1d9bf0
;;   like-red:      [0.969 0.251 0.400 1]  #f74066
;;   retweet-green: [0.000 0.733 0.482 1]  #00bb7b
;;   bookmark-blue: [0.114 0.608 0.941 1]  #1d9bf0
;; ═══════════════════════════════════════════════════════════════════════════

;; Root container
@panel root :w (canvas-width) :h (canvas-height) :layout row :fill [0.000 0.000 0.000 1]

  ;; ══════════════════════════════════════════════════════════════════════
  ;; LEFT SIDEBAR — Navigation
  ;; ══════════════════════════════════════════════════════════════════════
  @panel sidebar :w 275 :layout column :fill [0.000 0.000 0.000 1] :padding-top 12 :padding-left 12 :padding-right 12

    ;; X Logo
    @panel logo_wrap :h 50 :layout row :align center :padding-left 12
      @text logo :size 28 :color [0.910 0.929 0.937 1]
        X

    ;; ── Nav items ──
    ;; Home
    @panel nav_home :h 50 :layout row :align center :padding-left 12 :radius 25 :fill (if (eq (form/tab) "home") [0.098 0.110 0.118 1] [0 0 0 0])
      @text nav_home_icon :size 22 :color [0.910 0.929 0.937 1]
        @
      @text nav_home_lbl :size 18 :color (if (eq (form/tab) "home") [0.910 0.929 0.937 1] [0.910 0.929 0.937 0.85]) :margin-left 16
        Home

    ;; Explore
    @panel nav_explore :h 50 :layout row :align center :padding-left 12 :radius 25 :fill (if (eq (form/tab) "explore") [0.098 0.110 0.118 1] [0 0 0 0])
      @text nav_explore_icon :size 22 :color [0.910 0.929 0.937 1]
        #
      @text nav_explore_lbl :size 18 :color (if (eq (form/tab) "explore") [0.910 0.929 0.937 1] [0.910 0.929 0.937 0.85]) :margin-left 16
        Explore

    ;; Notifications (with badge)
    @panel nav_notif :h 50 :layout row :align center :padding-left 12 :radius 25 :fill (if (eq (form/tab) "notifications") [0.098 0.110 0.118 1] [0 0 0 0])
      @text nav_notif_icon :size 22 :color [0.910 0.929 0.937 1]
        !
      @text nav_notif_lbl :size 18 :color (if (eq (form/tab) "notifications") [0.910 0.929 0.937 1] [0.910 0.929 0.937 0.85]) :margin-left 16
        Notifications
      ;; Notification badge
      @rect notif_badge :w 20 :h 20 :fill [0.114 0.608 0.941 1] :radius 10 :position absolute :left 28 :top 4
      @text notif_badge_txt :size 11 :color [1 1 1 1] :position absolute :left 34 :top 7
        3

    ;; Messages
    @panel nav_msg :h 50 :layout row :align center :padding-left 12 :radius 25 :fill (if (eq (form/tab) "messages") [0.098 0.110 0.118 1] [0 0 0 0])
      @text nav_msg_icon :size 22 :color [0.910 0.929 0.937 1]
        ~
      @text nav_msg_lbl :size 18 :color (if (eq (form/tab) "messages") [0.910 0.929 0.937 1] [0.910 0.929 0.937 0.85]) :margin-left 16
        Messages
      ;; Message badge
      @rect msg_badge :w 20 :h 20 :fill [0.114 0.608 0.941 1] :radius 10 :position absolute :left 28 :top 4
      @text msg_badge_txt :size 11 :color [1 1 1 1] :position absolute :left 34 :top 7
        2

    ;; Bookmarks
    @panel nav_bk :h 50 :layout row :align center :padding-left 12 :radius 25 :fill (if (eq (form/tab) "bookmarks") [0.098 0.110 0.118 1] [0 0 0 0])
      @text nav_bk_icon :size 22 :color [0.910 0.929 0.937 1]
        *
      @text nav_bk_lbl :size 18 :color (if (eq (form/tab) "bookmarks") [0.910 0.929 0.937 1] [0.910 0.929 0.937 0.85]) :margin-left 16
        Bookmarks

    ;; Profile
    @panel nav_prof :h 50 :layout row :align center :padding-left 12 :radius 25 :fill (if (eq (form/tab) "profile") [0.098 0.110 0.118 1] [0 0 0 0])
      @text nav_prof_icon :size 22 :color [0.910 0.929 0.937 1]
        o
      @text nav_prof_lbl :size 18 :color (if (eq (form/tab) "profile") [0.910 0.929 0.937 1] [0.910 0.929 0.937 0.85]) :margin-left 16
        Profile

    ;; Post button
    @rect post_btn_bg :w 233 :h 50 :fill [0.114 0.608 0.941 1] :radius 25 :margin-top 16
    @text post_btn_lbl :size 17 :color [1 1 1 1] :position absolute :left 103 :top 333
      Post

    ;; Spacer
    @rect sidebar_spacer :h 10 :flex-grow 1

    ;; User profile card at bottom
    @panel user_card :h 64 :layout row :align center :padding 12 :radius 32
      ;; Avatar circle
      @rect user_avatar :w 40 :h 40 :fill [0.114 0.608 0.941 1] :radius 20
      @text user_avatar_txt :size 16 :color [1 1 1 1] :position absolute :left 23 :top 10
        R
      @panel user_info :layout column :margin-left 10 :flex-grow 1
        @text user_name :size 14 :color [0.910 0.929 0.937 1]
          Rex Developer
        @text user_handle :size 13 :color [0.443 0.498 0.529 1]
          @rexdev
      @text user_more :size 18 :color [0.443 0.498 0.529 1]
        ...

  ;; Left border
  @rect sidebar_border :w 1 :h (canvas-height) :fill [0.184 0.200 0.216 1]

  ;; ══════════════════════════════════════════════════════════════════════
  ;; MAIN FEED — Center column
  ;; ══════════════════════════════════════════════════════════════════════
  @panel feed_col :layout column :flex-grow 1 :min-width 500 :max-width 600

    ;; ── Header bar with For You / Following tabs ──
    @panel feed_header :h 53 :layout column :fill [0.000 0.000 0.000 0.85]
      @panel feed_title :h 53 :layout row :align center :padding-left 16
        @text feed_title_txt :size 20 :color [0.910 0.929 0.937 1]
          Home
      ;; Tab switcher
      @panel feed_tabs :h 53 :layout row
        @panel tab_foryou :layout column :flex-grow 1 :align center :justify center
          @text tab_foryou_txt :size 15 :color [0.910 0.929 0.937 1] :align center
            For you
          @rect tab_foryou_ind :w 60 :h 4 :fill [0.114 0.608 0.941 1] :radius 2 :margin-top 8
        @panel tab_following :layout column :flex-grow 1 :align center :justify center
          @text tab_following_txt :size 15 :color [0.443 0.498 0.529 1] :align center
            Following
    @rect feed_hdr_border :h 1 :fill [0.184 0.200 0.216 1]

    ;; ── Compose prompt bar ──
    @panel compose_bar :h 68 :layout row :padding 12 :gap 10 :fill [0.000 0.000 0.000 1]
      ;; Compose avatar
      @rect compose_avatar :w 40 :h 40 :fill [0.114 0.608 0.941 1] :radius 20
      @text compose_avatar_txt :size 16 :color [1 1 1 1] :position absolute :left 23 :top 121
        R
      ;; Compose input area
      @panel compose_input :layout column :flex-grow 1 :justify center
        @text compose_placeholder :size 18 :color [0.443 0.498 0.529 1]
          What is happening?!
    @rect compose_border :h 1 :fill [0.184 0.200 0.216 1]

    ;; ── Compose modal (shown when compose toggle is on) ──
    @panel compose_modal :h (if (gt (form/compose) 0.5) 180 0) :layout column :padding (if (gt (form/compose) 0.5) 16 0) :fill (if (gt (form/compose) 0.5) [0.063 0.071 0.078 1] [0 0 0 0]) :gap 8 :overflow hidden
      @panel compose_row :layout row :gap 10
        @rect cm_avatar :w 40 :h 40 :fill (if (gt (form/compose) 0.5) [0.114 0.608 0.941 1] [0 0 0 0]) :radius 20
        @text cm_avatar_txt :size 16 :color (if (gt (form/compose) 0.5) [1 1 1 1] [0 0 0 0])
          R
        @panel compose_area :layout column :flex-grow 1
          @text compose_edit :size 18 :color (if (gt (form/compose) 0.5) [0.910 0.929 0.937 1] [0 0 0 0])
            Type your post here...
          @text compose_counter :size 13 :color (if (gt (form/compose) 0.5) [0.443 0.498 0.529 1] [0 0 0 0]) :margin-top 4
            0/280
      ;; Compose toolbar
      @panel compose_tools :layout row :justify space-between :align center :margin-top 4
        @panel compose_icons :layout row :gap 16 :padding-left 52
          @text ci_photo :size 16 :color (if (gt (form/compose) 0.5) [0.114 0.608 0.941 1] [0 0 0 0])
            [img]
          @text ci_gif :size 16 :color (if (gt (form/compose) 0.5) [0.114 0.608 0.941 1] [0 0 0 0])
            GIF
          @text ci_poll :size 16 :color (if (gt (form/compose) 0.5) [0.114 0.608 0.941 1] [0 0 0 0])
            [=]
          @text ci_emoji :size 16 :color (if (gt (form/compose) 0.5) [0.114 0.608 0.941 1] [0 0 0 0])
            :)
          @text ci_schedule :size 16 :color (if (gt (form/compose) 0.5) [0.114 0.608 0.941 1] [0 0 0 0])
            [t]
          @text ci_location :size 16 :color (if (gt (form/compose) 0.5) [0.114 0.608 0.941 1] [0 0 0 0])
            [o]
        @rect compose_post_btn :w 72 :h 36 :fill (if (gt (form/compose) 0.5) [0.114 0.608 0.941 1] [0 0 0 0]) :radius 18
        @text compose_post_txt :size 15 :color (if (gt (form/compose) 0.5) [1 1 1 1] [0 0 0 0]) :position absolute :right 24 :top 6
          Post
    @rect compose_modal_border :h (if (gt (form/compose) 0.5) 1 0) :fill (if (gt (form/compose) 0.5) [0.184 0.200 0.216 1] [0 0 0 0])

    ;; ═══════════════════════════════════════════════════════════════════
    ;; TWEET 1 — Pinned tech tweet with image
    ;; ═══════════════════════════════════════════════════════════════════
    @panel tweet1 :layout column :padding 12 :gap 4 :fill [0.000 0.000 0.000 1]
      ;; Pinned indicator
      @panel t1_pinned :layout row :gap 6 :padding-left 44 :margin-bottom 2
        @text t1_pin_icon :size 11 :color [0.443 0.498 0.529 1]
          ^
        @text t1_pin_txt :size 12 :color [0.443 0.498 0.529 1]
          Pinned
      @panel t1_main :layout row :gap 10
        ;; Avatar
        @rect t1_avatar :w 40 :h 40 :fill [0.569 0.200 0.882 1] :radius 20
        @text t1_avatar_txt :size 16 :color [1 1 1 1] :position absolute :left 23 :top 12
          S
        ;; Content
        @panel t1_content :layout column :flex-grow 1 :gap 2
          ;; Author line
          @panel t1_author :layout row :gap 6 :align center
            @text t1_name :size 15 :color [0.910 0.929 0.937 1]
              ShrineOS
            @text t1_verified :size 14 :color [0.114 0.608 0.941 1]
              [v]
            @text t1_handle :size 14 :color [0.443 0.498 0.529 1]
              @shrine_os
            @text t1_dot :size 14 :color [0.443 0.498 0.529 1]
              .
            @text t1_time :size 14 :color [0.443 0.498 0.529 1]
              2h
          ;; Tweet body
          @text t1_body :size 15 :color [0.910 0.929 0.937 1]
            Just shipped the Rex Projection Engine — tree notation that compiles directly to GPU commands. No graphics API abstraction layer. Profunctor optics for zero-cost data access. This is how UIs should work.
          @text t1_body2 :size 15 :color [0.910 0.929 0.937 1] :margin-top 4
            The compile/execute split means: parse once, flat command list, zero-copy heap, one ArrayBuffer, one GPUBuffer. Execute is a tight loop.
          ;; Hashtags
          @text t1_tags :size 15 :color [0.114 0.608 0.941 1] :margin-top 4
            #WebGPU #GPU #Rex #ShrineOS #TreeNotation
          ;; Image placeholder
          @rect t1_img :w 400 :h 200 :fill [0.063 0.071 0.078 1] :radius 16 :margin-top 10 :stroke [0.184 0.200 0.216 1] :stroke-width 1
          @text t1_img_txt :size 14 :color [0.443 0.498 0.529 1] :position absolute :left 165 :top 110
            [Rex Architecture Diagram]
          ;; Engagement bar
          @panel t1_engage :layout row :margin-top 10 :gap 4
            ;; Reply
            @panel t1_reply :layout row :gap 6 :flex-grow 1 :align center
              @text t1_reply_icon :size 16 :color [0.443 0.498 0.529 1]
                ^
              @text t1_reply_ct :size 13 :color [0.443 0.498 0.529 1]
                247
            ;; Retweet
            @panel t1_rt :layout row :gap 6 :flex-grow 1 :align center
              @text t1_rt_icon :size 16 :color (if (gt (form/rt1) 0.5) [0.000 0.733 0.482 1] [0.443 0.498 0.529 1])
                <>
              @text t1_rt_ct :size 13 :color (if (gt (form/rt1) 0.5) [0.000 0.733 0.482 1] [0.443 0.498 0.529 1])
                1.2K
            ;; Like
            @panel t1_like :layout row :gap 6 :flex-grow 1 :align center
              @text t1_like_icon :size 16 :color (if (gt (form/like1) 0.5) [0.969 0.251 0.400 1] [0.443 0.498 0.529 1])
                <3
              @text t1_like_ct :size 13 :color (if (gt (form/like1) 0.5) [0.969 0.251 0.400 1] [0.443 0.498 0.529 1])
                8.4K
            ;; Bookmark
            @panel t1_bk :layout row :gap 6 :flex-grow 1 :align center
              @text t1_bk_icon :size 16 :color (if (gt (form/bk1) 0.5) [0.114 0.608 0.941 1] [0.443 0.498 0.529 1])
                [b]
              @text t1_bk_ct :size 13 :color (if (gt (form/bk1) 0.5) [0.114 0.608 0.941 1] [0.443 0.498 0.529 1])
                312
            ;; Share
            @panel t1_share :layout row :align center
              @text t1_share_icon :size 16 :color [0.443 0.498 0.529 1]
                ->
    @rect t1_border :h 1 :fill [0.184 0.200 0.216 1]

    ;; ═══════════════════════════════════════════════════════════════════
    ;; TWEET 2 — Retweeted tech thread
    ;; ═══════════════════════════════════════════════════════════════════
    @panel tweet2 :layout column :padding 12 :gap 4 :fill [0.000 0.000 0.000 1]
      ;; Retweet indicator
      @panel t2_rt_ind :layout row :gap 6 :padding-left 44 :margin-bottom 2
        @text t2_rt_icon_ind :size 11 :color [0.443 0.498 0.529 1]
          <>
        @text t2_rt_txt :size 12 :color [0.443 0.498 0.529 1]
          You retweeted
      @panel t2_main :layout row :gap 10
        ;; Avatar
        @rect t2_avatar :w 40 :h 40 :fill [0.988 0.600 0.067 1] :radius 20
        @text t2_avatar_txt :size 16 :color [1 1 1 1] :position absolute :left 23 :top 12
          S
        ;; Content
        @panel t2_content :layout column :flex-grow 1 :gap 2
          @panel t2_author :layout row :gap 6 :align center
            @text t2_name :size 15 :color [0.910 0.929 0.937 1]
              Sebastian Aaltonen
            @text t2_verified :size 14 :color [0.961 0.725 0.251 1]
              [v]
            @text t2_handle :size 14 :color [0.443 0.498 0.529 1]
              @SebAaltonen
            @text t2_dot :size 14 :color [0.443 0.498 0.529 1]
              .
            @text t2_time :size 14 :color [0.443 0.498 0.529 1]
              4h
          @text t2_body :size 15 :color [0.910 0.929 0.937 1]
            Hot take: Graphics APIs are the wrong abstraction. The GPU is memory + pointers + stage masks. Everything else is ceremony.
          @text t2_body2 :size 15 :color [0.910 0.929 0.937 1] :margin-top 6
            You don't need D3D12. You don't need Vulkan. You need a compiler that understands your scene graph and emits the right bytes.
          @text t2_body3 :size 15 :color [0.910 0.929 0.937 1] :margin-top 6
            1/
          ;; Thread indicator
          @rect t2_thread :h 2 :fill [0.114 0.608 0.941 0.3] :radius 1 :margin-top 6
          @text t2_thread_txt :size 13 :color [0.114 0.608 0.941 1] :margin-top 4
            Show this thread
          ;; Engagement
          @panel t2_engage :layout row :margin-top 10 :gap 4
            @panel t2_reply :layout row :gap 6 :flex-grow 1 :align center
              @text t2_reply_icon :size 16 :color [0.443 0.498 0.529 1]
                ^
              @text t2_reply_ct :size 13 :color [0.443 0.498 0.529 1]
                89
            @panel t2_rt_e :layout row :gap 6 :flex-grow 1 :align center
              @text t2_rt_e_icon :size 16 :color (if (gt (form/rt2) 0.5) [0.000 0.733 0.482 1] [0.443 0.498 0.529 1])
                <>
              @text t2_rt_e_ct :size 13 :color (if (gt (form/rt2) 0.5) [0.000 0.733 0.482 1] [0.443 0.498 0.529 1])
                543
            @panel t2_like :layout row :gap 6 :flex-grow 1 :align center
              @text t2_like_icon :size 16 :color (if (gt (form/like2) 0.5) [0.969 0.251 0.400 1] [0.443 0.498 0.529 1])
                <3
              @text t2_like_ct :size 13 :color (if (gt (form/like2) 0.5) [0.969 0.251 0.400 1] [0.443 0.498 0.529 1])
                3.1K
            @panel t2_bk :layout row :gap 6 :flex-grow 1 :align center
              @text t2_bk_icon :size 16 :color (if (gt (form/bk2) 0.5) [0.114 0.608 0.941 1] [0.443 0.498 0.529 1])
                [b]
              @text t2_bk_ct :size 13 :color (if (gt (form/bk2) 0.5) [0.114 0.608 0.941 1] [0.443 0.498 0.529 1])
                87
            @panel t2_share :layout row :align center
              @text t2_share_icon :size 16 :color [0.443 0.498 0.529 1]
                ->
    @rect t2_border :h 1 :fill [0.184 0.200 0.216 1]

    ;; ═══════════════════════════════════════════════════════════════════
    ;; TWEET 3 — Announcement with poll
    ;; ═══════════════════════════════════════════════════════════════════
    @panel tweet3 :layout column :padding 12 :gap 4 :fill [0.000 0.000 0.000 1]
      @panel t3_main :layout row :gap 10
        ;; Avatar
        @rect t3_avatar :w 40 :h 40 :fill [0.180 0.800 0.443 1] :radius 20
        @text t3_avatar_txt :size 16 :color [1 1 1 1] :position absolute :left 23 :top 12
          P
        ;; Content
        @panel t3_content :layout column :flex-grow 1 :gap 2
          @panel t3_author :layout row :gap 6 :align center
            @text t3_name :size 15 :color [0.910 0.929 0.937 1]
              PLAN Runtime
            @text t3_verified :size 14 :color [0.114 0.608 0.941 1]
              [v]
            @text t3_handle :size 14 :color [0.443 0.498 0.529 1]
              @plan_vm
            @text t3_dot :size 14 :color [0.443 0.498 0.529 1]
              .
            @text t3_time :size 14 :color [0.443 0.498 0.529 1]
              6h
          @text t3_body :size 15 :color [0.910 0.929 0.937 1]
            What should we prioritize for PLAN v0.4?
          ;; Poll
          @panel poll :layout column :margin-top 8 :gap 8 :padding 0
            ;; Option 1 (leading)
            @panel poll_1 :h 36 :layout row :align center :radius 8 :stroke [0.184 0.200 0.216 1] :stroke-width 1 :padding-left 12 :padding-right 12
              @rect poll_1_fill :w 260 :h 36 :fill [0.114 0.608 0.941 0.2] :radius 8 :position absolute :left 0 :top 0
              @text poll_1_txt :size 14 :color [0.910 0.929 0.937 1]
                Orthogonal persistence
              @rect poll_1_spacer :w 4 :h 1 :flex-grow 1
              @text poll_1_pct :size 14 :color [0.114 0.608 0.941 1]
                42%
            ;; Option 2
            @panel poll_2 :h 36 :layout row :align center :radius 8 :stroke [0.184 0.200 0.216 1] :stroke-width 1 :padding-left 12 :padding-right 12
              @rect poll_2_fill :w 180 :h 36 :fill [0.184 0.200 0.216 0.3] :radius 8 :position absolute :left 0 :top 0
              @text poll_2_txt :size 14 :color [0.910 0.929 0.937 1]
                WASM compilation target
              @rect poll_2_spacer :w 4 :h 1 :flex-grow 1
              @text poll_2_pct :size 14 :color [0.443 0.498 0.529 1]
                29%
            ;; Option 3
            @panel poll_3 :h 36 :layout row :align center :radius 8 :stroke [0.184 0.200 0.216 1] :stroke-width 1 :padding-left 12 :padding-right 12
              @rect poll_3_fill :w 110 :h 36 :fill [0.184 0.200 0.216 0.3] :radius 8 :position absolute :left 0 :top 0
              @text poll_3_txt :size 14 :color [0.910 0.929 0.937 1]
                Network replication
              @rect poll_3_spacer :w 4 :h 1 :flex-grow 1
              @text poll_3_pct :size 14 :color [0.443 0.498 0.529 1]
                18%
            ;; Option 4
            @panel poll_4 :h 36 :layout row :align center :radius 8 :stroke [0.184 0.200 0.216 1] :stroke-width 1 :padding-left 12 :padding-right 12
              @rect poll_4_fill :w 68 :h 36 :fill [0.184 0.200 0.216 0.3] :radius 8 :position absolute :left 0 :top 0
              @text poll_4_txt :size 14 :color [0.910 0.929 0.937 1]
                Hardware key derivation
              @rect poll_4_spacer :w 4 :h 1 :flex-grow 1
              @text poll_4_pct :size 14 :color [0.443 0.498 0.529 1]
                11%
          ;; Poll meta
          @text poll_meta :size 13 :color [0.443 0.498 0.529 1] :margin-top 4
            1,847 votes . 14 hours left
          ;; Engagement
          @panel t3_engage :layout row :margin-top 10 :gap 4
            @panel t3_reply :layout row :gap 6 :flex-grow 1 :align center
              @text t3_reply_icon :size 16 :color [0.443 0.498 0.529 1]
                ^
              @text t3_reply_ct :size 13 :color [0.443 0.498 0.529 1]
                56
            @panel t3_rt_e :layout row :gap 6 :flex-grow 1 :align center
              @text t3_rt_e_icon :size 16 :color (if (gt (form/rt3) 0.5) [0.000 0.733 0.482 1] [0.443 0.498 0.529 1])
                <>
              @text t3_rt_e_ct :size 13 :color (if (gt (form/rt3) 0.5) [0.000 0.733 0.482 1] [0.443 0.498 0.529 1])
                189
            @panel t3_like :layout row :gap 6 :flex-grow 1 :align center
              @text t3_like_icon :size 16 :color (if (gt (form/like3) 0.5) [0.969 0.251 0.400 1] [0.443 0.498 0.529 1])
                <3
              @text t3_like_ct :size 13 :color (if (gt (form/like3) 0.5) [0.969 0.251 0.400 1] [0.443 0.498 0.529 1])
                924
            @panel t3_bk :layout row :gap 6 :flex-grow 1 :align center
              @text t3_bk_icon :size 16 :color (if (gt (form/bk3) 0.5) [0.114 0.608 0.941 1] [0.443 0.498 0.529 1])
                [b]
              @text t3_bk_ct :size 13 :color (if (gt (form/bk3) 0.5) [0.114 0.608 0.941 1] [0.443 0.498 0.529 1])
                41
            @panel t3_share :layout row :align center
              @text t3_share_icon :size 16 :color [0.443 0.498 0.529 1]
                ->
    @rect t3_border :h 1 :fill [0.184 0.200 0.216 1]

    ;; ═══════════════════════════════════════════════════════════════════
    ;; TWEET 4 — Code snippet tweet
    ;; ═══════════════════════════════════════════════════════════════════
    @panel tweet4 :layout column :padding 12 :gap 4 :fill [0.000 0.000 0.000 1]
      @panel t4_main :layout row :gap 10
        ;; Avatar
        @rect t4_avatar :w 40 :h 40 :fill [0.933 0.322 0.188 1] :radius 20
        @text t4_avatar_txt :size 16 :color [1 1 1 1] :position absolute :left 23 :top 12
          J
        ;; Content
        @panel t4_content :layout column :flex-grow 1 :gap 2
          @panel t4_author :layout row :gap 6 :align center
            @text t4_name :size 15 :color [0.910 0.929 0.937 1]
              Jonathan Blow
            @text t4_handle :size 14 :color [0.443 0.498 0.529 1]
              @Jonathan_Blow
            @text t4_dot :size 14 :color [0.443 0.498 0.529 1]
              .
            @text t4_time :size 14 :color [0.443 0.498 0.529 1]
              8h
          @text t4_body :size 15 :color [0.910 0.929 0.937 1]
            The entire game industry is building on 15 layers of abstraction that exist to solve problems created by the previous 14 layers.
          @text t4_body2 :size 15 :color [0.910 0.929 0.937 1] :margin-top 6
            Compile-time execution. Flat data layouts. No hidden allocations. That's it. That's the architecture.
          ;; Code block
          @panel code_block :layout column :margin-top 10 :padding 12 :radius 12 :fill [0.063 0.071 0.078 1] :stroke [0.184 0.200 0.216 1] :stroke-width 1
            @text code_lang :size 11 :color [0.443 0.498 0.529 1]
              rex
            @text code_l1 :size 13 :color [0.569 0.200 0.882 1] :margin-top 6
              @struct Scene
            @text code_l2 :size 13 :color [0.443 0.498 0.529 1] :margin-left 16
              @field time  :type f32
            @text code_l3 :size 13 :color [0.443 0.498 0.529 1] :margin-left 16
              @field res   :type f32x2
            @text code_l4 :size 13 :color [0.443 0.498 0.529 1] :margin-left 16
              @field mouse :type f32x2
            @text code_l5 :size 13 :color [0.180 0.800 0.443 1] :margin-top 6
              ;; 20 bytes -> GPU heap. Zero copy.
          ;; Engagement
          @panel t4_engage :layout row :margin-top 10 :gap 4
            @panel t4_reply :layout row :gap 6 :flex-grow 1 :align center
              @text t4_reply_icon :size 16 :color [0.443 0.498 0.529 1]
                ^
              @text t4_reply_ct :size 13 :color [0.443 0.498 0.529 1]
                412
            @panel t4_rt_e :layout row :gap 6 :flex-grow 1 :align center
              @text t4_rt_e_icon :size 16 :color (if (gt (form/rt4) 0.5) [0.000 0.733 0.482 1] [0.443 0.498 0.529 1])
                <>
              @text t4_rt_e_ct :size 13 :color (if (gt (form/rt4) 0.5) [0.000 0.733 0.482 1] [0.443 0.498 0.529 1])
                2.8K
            @panel t4_like :layout row :gap 6 :flex-grow 1 :align center
              @text t4_like_icon :size 16 :color (if (gt (form/like4) 0.5) [0.969 0.251 0.400 1] [0.443 0.498 0.529 1])
                <3
              @text t4_like_ct :size 13 :color (if (gt (form/like4) 0.5) [0.969 0.251 0.400 1] [0.443 0.498 0.529 1])
                14.2K
            @panel t4_bk :layout row :gap 6 :flex-grow 1 :align center
              @text t4_bk_icon :size 16 :color (if (gt (form/bk4) 0.5) [0.114 0.608 0.941 1] [0.443 0.498 0.529 1])
                [b]
              @text t4_bk_ct :size 13 :color (if (gt (form/bk4) 0.5) [0.114 0.608 0.941 1] [0.443 0.498 0.529 1])
                891
            @panel t4_share :layout row :align center
              @text t4_share_icon :size 16 :color [0.443 0.498 0.529 1]
                ->
    @rect t4_border :h 1 :fill [0.184 0.200 0.216 1]

    ;; ═══════════════════════════════════════════════════════════════════
    ;; TWEET 5 — Reply chain / quote tweet
    ;; ═══════════════════════════════════════════════════════════════════
    @panel tweet5 :layout column :padding 12 :gap 4 :fill [0.000 0.000 0.000 1]
      @panel t5_main :layout row :gap 10
        ;; Avatar
        @rect t5_avatar :w 40 :h 40 :fill [0.114 0.608 0.941 1] :radius 20
        @text t5_avatar_txt :size 16 :color [1 1 1 1] :position absolute :left 23 :top 12
          R
        ;; Content
        @panel t5_content :layout column :flex-grow 1 :gap 2
          @panel t5_author :layout row :gap 6 :align center
            @text t5_name :size 15 :color [0.910 0.929 0.937 1]
              Rex Developer
            @text t5_handle :size 14 :color [0.443 0.498 0.529 1]
              @rexdev
            @text t5_dot :size 14 :color [0.443 0.498 0.529 1]
              .
            @text t5_time :size 14 :color [0.443 0.498 0.529 1]
              12h
          @text t5_body :size 15 :color [0.910 0.929 0.937 1]
            Profunctor optics + tree notation + GPU heap = the entire rendering pipeline as composable lenses. What if your UI framework was a category theory paper that actually compiled?
          ;; Quote tweet
          @panel quote :layout column :margin-top 10 :padding 12 :radius 16 :stroke [0.184 0.200 0.216 1] :stroke-width 1 :gap 6
            @panel quote_author :layout row :gap 6 :align center
              @rect quote_av :w 20 :h 20 :fill [0.769 0.376 0.078 1] :radius 10
              @text quote_av_txt :size 8 :color [1 1 1 1] :position absolute :left 6 :top 5
                B
              @text quote_name :size 13 :color [0.910 0.929 0.937 1]
                Bartosz Milewski
              @text quote_handle :size 13 :color [0.443 0.498 0.529 1]
                @BartoszMilewski
              @text quote_dot :size 13 :color [0.443 0.498 0.529 1]
                .
              @text quote_time :size 13 :color [0.443 0.498 0.529 1]
                Mar 1
            @text quote_body :size 14 :color [0.910 0.929 0.937 1]
              Profunctor optics are the right abstraction for bidirectional data access. The question was always: can you compile them to zero-cost? Turns out, yes.
          ;; Engagement
          @panel t5_engage :layout row :margin-top 10 :gap 4
            @panel t5_reply :layout row :gap 6 :flex-grow 1 :align center
              @text t5_reply_icon :size 16 :color [0.443 0.498 0.529 1]
                ^
              @text t5_reply_ct :size 13 :color [0.443 0.498 0.529 1]
                33
            @panel t5_rt_e :layout row :gap 6 :flex-grow 1 :align center
              @text t5_rt_e_icon :size 16 :color (if (gt (form/rt5) 0.5) [0.000 0.733 0.482 1] [0.443 0.498 0.529 1])
                <>
              @text t5_rt_e_ct :size 13 :color (if (gt (form/rt5) 0.5) [0.000 0.733 0.482 1] [0.443 0.498 0.529 1])
                156
            @panel t5_like :layout row :gap 6 :flex-grow 1 :align center
              @text t5_like_icon :size 16 :color (if (gt (form/like5) 0.5) [0.969 0.251 0.400 1] [0.443 0.498 0.529 1])
                <3
              @text t5_like_ct :size 13 :color (if (gt (form/like5) 0.5) [0.969 0.251 0.400 1] [0.443 0.498 0.529 1])
                1.1K
            @panel t5_bk :layout row :gap 6 :flex-grow 1 :align center
              @text t5_bk_icon :size 16 :color (if (gt (form/bk5) 0.5) [0.114 0.608 0.941 1] [0.443 0.498 0.529 1])
                [b]
              @text t5_bk_ct :size 13 :color (if (gt (form/bk5) 0.5) [0.114 0.608 0.941 1] [0.443 0.498 0.529 1])
                67
            @panel t5_share :layout row :align center
              @text t5_share_icon :size 16 :color [0.443 0.498 0.529 1]
                ->
    @rect t5_border :h 1 :fill [0.184 0.200 0.216 1]

  ;; Right border
  @rect feed_border :w 1 :h (canvas-height) :fill [0.184 0.200 0.216 1]

  ;; ══════════════════════════════════════════════════════════════════════
  ;; RIGHT SIDEBAR — Search, Trending, Who to follow
  ;; ══════════════════════════════════════════════════════════════════════
  @panel right_sidebar :w 350 :layout column :padding-top 12 :padding-left 20 :padding-right 20 :gap 16

    ;; ── Search bar ──
    @panel search_bar :h 42 :layout row :align center :padding-left 16 :fill [0.063 0.071 0.078 1] :radius 21 :gap 10
      @text search_icon :size 16 :color [0.443 0.498 0.529 1]
        Q
      @text search_placeholder :size 15 :color [0.443 0.498 0.529 1]
        Search

    ;; ── Subscribe to Premium ──
    @panel premium_card :layout column :padding 14 :gap 10 :radius 16 :stroke [0.184 0.200 0.216 1] :stroke-width 1
      @text premium_title :size 19 :color [0.910 0.929 0.937 1]
        Subscribe to Premium
      @text premium_desc :size 14 :color [0.443 0.498 0.529 1]
        Subscribe to unlock new features and if eligible, receive a share of revenue.
      @rect premium_btn :w 120 :h 36 :fill [0.910 0.929 0.937 1] :radius 18 :margin-top 4
      @text premium_btn_txt :size 14 :color [0.000 0.000 0.000 1] :position absolute :left 22 :top 8
        Subscribe

    ;; ── Trending Section ──
    @panel trending :layout column :radius 16 :fill [0.063 0.071 0.078 1] :padding 0
      @panel trending_hdr :h 48 :layout row :align center :padding-left 16 :padding-right 16
        @text trending_title :size 20 :color [0.910 0.929 0.937 1]
          Trends for you

      ;; Trend 1
      @panel trend1 :layout column :padding-left 16 :padding-right 16 :padding-top 10 :padding-bottom 10
        @text tr1_cat :size 13 :color [0.443 0.498 0.529 1]
          Technology . Trending
        @text tr1_topic :size 15 :color [0.910 0.929 0.937 1]
          #WebGPU
        @text tr1_posts :size 13 :color [0.443 0.498 0.529 1]
          24.7K posts
      @rect tr1_border :h 1 :fill [0.184 0.200 0.216 0.5] :margin-left 16 :margin-right 16

      ;; Trend 2
      @panel trend2 :layout column :padding-left 16 :padding-right 16 :padding-top 10 :padding-bottom 10
        @text tr2_cat :size 13 :color [0.443 0.498 0.529 1]
          Programming . Trending
        @text tr2_topic :size 15 :color [0.910 0.929 0.937 1]
          Tree-sitter
        @text tr2_posts :size 13 :color [0.443 0.498 0.529 1]
          8.3K posts
      @rect tr2_border :h 1 :fill [0.184 0.200 0.216 0.5] :margin-left 16 :margin-right 16

      ;; Trend 3
      @panel trend3 :layout column :padding-left 16 :padding-right 16 :padding-top 10 :padding-bottom 10
        @text tr3_cat :size 13 :color [0.443 0.498 0.529 1]
          Science . Trending
        @text tr3_topic :size 15 :color [0.910 0.929 0.937 1]
          Category Theory
        @text tr3_posts :size 13 :color [0.443 0.498 0.529 1]
          3.1K posts
      @rect tr3_border :h 1 :fill [0.184 0.200 0.216 0.5] :margin-left 16 :margin-right 16

      ;; Trend 4
      @panel trend4 :layout column :padding-left 16 :padding-right 16 :padding-top 10 :padding-bottom 10
        @text tr4_cat :size 13 :color [0.443 0.498 0.529 1]
          Gaming . Trending
        @text tr4_topic :size 15 :color [0.910 0.929 0.937 1]
          Voxel Engines
        @text tr4_posts :size 13 :color [0.443 0.498 0.529 1]
          12.1K posts
      @rect tr4_border :h 1 :fill [0.184 0.200 0.216 0.5] :margin-left 16 :margin-right 16

      ;; Trend 5
      @panel trend5 :layout column :padding-left 16 :padding-right 16 :padding-top 10 :padding-bottom 10
        @text tr5_cat :size 13 :color [0.443 0.498 0.529 1]
          Tech . Trending
        @text tr5_topic :size 15 :color [0.910 0.929 0.937 1]
          #ShrineOS
        @text tr5_posts :size 13 :color [0.443 0.498 0.529 1]
          1.8K posts

      ;; Show more
      @panel trending_more :h 44 :layout row :align center :padding-left 16
        @text trending_more_txt :size 15 :color [0.114 0.608 0.941 1]
          Show more

    ;; ── Who to follow ──
    @panel wtf :layout column :radius 16 :fill [0.063 0.071 0.078 1] :padding 0
      @panel wtf_hdr :h 48 :layout row :align center :padding-left 16
        @text wtf_title :size 20 :color [0.910 0.929 0.937 1]
          Who to follow

      ;; Suggestion 1
      @panel wtf1 :layout row :padding 12 :gap 10 :align center
        @rect wtf1_av :w 40 :h 40 :fill [0.988 0.388 0.157 1] :radius 20
        @text wtf1_av_txt :size 16 :color [1 1 1 1] :position absolute :left 14 :top 12
          K
        @panel wtf1_info :layout column :flex-grow 1
          @panel wtf1_name_row :layout row :gap 4 :align center
            @text wtf1_name :size 15 :color [0.910 0.929 0.937 1]
              Kat Marchetti
            @text wtf1_v :size 14 :color [0.114 0.608 0.941 1]
              [v]
          @text wtf1_handle :size 13 :color [0.443 0.498 0.529 1]
            @katm_gpu
        @rect wtf1_btn :w 76 :h 32 :fill [0.910 0.929 0.937 1] :radius 16
        @text wtf1_btn_txt :size 14 :color [0.000 0.000 0.000 1] :position absolute :right 32 :top 14
          Follow

      ;; Suggestion 2
      @panel wtf2 :layout row :padding 12 :gap 10 :align center
        @rect wtf2_av :w 40 :h 40 :fill [0.400 0.200 0.800 1] :radius 20
        @text wtf2_av_txt :size 16 :color [1 1 1 1] :position absolute :left 14 :top 12
          A
        @panel wtf2_info :layout column :flex-grow 1
          @panel wtf2_name_row :layout row :gap 4 :align center
            @text wtf2_name :size 15 :color [0.910 0.929 0.937 1]
              Alex Warth
            @text wtf2_v :size 14 :color [0.114 0.608 0.941 1]
              [v]
          @text wtf2_handle :size 13 :color [0.443 0.498 0.529 1]
            @alexwarth
        @rect wtf2_btn :w 76 :h 32 :fill [0.910 0.929 0.937 1] :radius 16
        @text wtf2_btn_txt :size 14 :color [0.000 0.000 0.000 1] :position absolute :right 32 :top 14
          Follow

      ;; Suggestion 3
      @panel wtf3 :layout row :padding 12 :gap 10 :align center
        @rect wtf3_av :w 40 :h 40 :fill [0.067 0.533 0.467 1] :radius 20
        @text wtf3_av_txt :size 16 :color [1 1 1 1] :position absolute :left 14 :top 12
          C
        @panel wtf3_info :layout column :flex-grow 1
          @text wtf3_name :size 15 :color [0.910 0.929 0.937 1]
            Curtis Yarvin
          @text wtf3_handle :size 13 :color [0.443 0.498 0.529 1]
            @urabormin
        @rect wtf3_btn :w 76 :h 32 :fill [0.910 0.929 0.937 1] :radius 16
        @text wtf3_btn_txt :size 14 :color [0.000 0.000 0.000 1] :position absolute :right 32 :top 14
          Follow

      ;; Show more
      @panel wtf_more :h 44 :layout row :align center :padding-left 16
        @text wtf_more_txt :size 15 :color [0.114 0.608 0.941 1]
          Show more

    ;; ── Footer links ──
    @panel footer :layout row :flex-wrap wrap :gap 8 :padding-top 4 :padding-left 4
      @text ft_tos :size 13 :color [0.443 0.498 0.529 1]
        Terms of Service
      @text ft_priv :size 13 :color [0.443 0.498 0.529 1]
        Privacy Policy
      @text ft_cookie :size 13 :color [0.443 0.498 0.529 1]
        Cookie Policy
      @text ft_access :size 13 :color [0.443 0.498 0.529 1]
        Accessibility
      @text ft_ads :size 13 :color [0.443 0.498 0.529 1]
        Ads info
      @text ft_more2 :size 13 :color [0.443 0.498 0.529 1]
        More ...
    @text ft_copy :size 13 :color [0.443 0.498 0.529 1] :margin-left 4 :margin-top 2
      (c) 2026 X Corp.

  ;; ══════════════════════════════════════════════════════════════════════
  ;; FLOATING COMPOSE BUTTON (mobile-style FAB, bottom-right of feed)
  ;; ══════════════════════════════════════════════════════════════════════
  @rect fab_shadow :w 58 :h 58 :fill [0.114 0.608 0.941 0.3] :radius 29 :position absolute :left (sub (canvas-width) 410) :top (sub (canvas-height) 80)
  @rect fab_btn :w 56 :h 56 :fill [0.114 0.608 0.941 1] :radius 28 :position absolute :left (sub (canvas-width) 409) :top (sub (canvas-height) 79)
  @text fab_icon :size 28 :color [1 1 1 1] :position absolute :left (sub (canvas-width) 396) :top (sub (canvas-height) 68)
    +

  ;; ══════════════════════════════════════════════════════════════════════
  ;; LIVE ACTIVITY INDICATOR (top of feed, pulsing)
  ;; ══════════════════════════════════════════════════════════════════════
  @rect live_dot :w 8 :h 8 :fill [0.114 0.608 0.941 (if (lt (fract (mul (elapsed) 0.8)) 0.5) 1 0.3)] :radius 4 :position absolute :left 288 :top 22
