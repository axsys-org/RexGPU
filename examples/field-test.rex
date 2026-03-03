;; Scalar field metaballs with mouse tracking
;; Three gaussian blobs merge smoothly — cursor acts as a field source

@field metaballs
  :resolution 512 512
  :composition smooth-min
  :blend-k 0.3

  @source blob-a
    :pos (150 256)
    :strength 1.0
    :falloff gaussian
    :radius 80

  @source blob-b
    :pos (362 256)
    :strength 0.8
    :falloff gaussian
    :radius 60

  @source cursor
    :pos (mouse-x mouse-y)
    :strength 1.2
    :falloff gaussian
    :radius 50

  @visualize
    :mode isosurface
    :threshold 0.4
    :color-inside #7744ffff
    :color-outside #0a0a12ff
    :feather 3.0

@panel hud :x 12 :y 12 :w 200 :h 28 :fill [0 0 0 0.6] :radius 6 :layout row :gap 8 :padding 8 :align center
  @text label :size 11 :color [0.5 1 0.5 1]
    Scalar Field Demo
