import type { CamElement, ClipSettings, CustomLayout, LayoutMode, Rect, Size } from "./types";

/**
 * One draw step of the vertical frame: take `src` (source-video pixels) and paint it into `dst`
 * (output pixels). Layers are painted in order. A `blur` layer is blurred after scaling.
 * The renderer maps this to ffmpeg crop/scale/overlay; the web preview maps it to drawImage.
 */
export interface LayoutLayer {
  role: "background" | "game" | "cam";
  blur: boolean;
  src: Rect;
  dst: Rect;
  /** Webcam look (custom layout only): soft edge, rounded corners and border, in output px. */
  cam?: Pick<CamElement, "feather" | "radius" | "border" | "borderColor">;
}

export interface FrameLayout {
  /** Mode actually used (`split` degrades to `fill` without a webcam rect). */
  mode: LayoutMode;
  layers: LayoutLayer[];
  /** Base colour painted first. */
  fill: string;
  /** Uploaded background image (project asset file name), painted cover-fit over `fill`, before the layers. */
  image: string | null;
}

/** Webcam panel height bounds in `split`, as a fraction of the output height. */
const CAM_PANEL_MIN = 0.25;
const CAM_PANEL_MAX = 0.42;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Largest rect of aspect `aspect` (w/h) inside `bounds`, positioned by focus (0..1 on each axis). */
function cropToAspect(bounds: Rect, aspect: number, focusX = 0.5, focusY = 0.5): Rect {
  let w = bounds.w;
  let h = w / aspect;
  if (h > bounds.h) {
    h = bounds.h;
    w = h * aspect;
  }
  w = Math.min(even(w), Math.floor(bounds.w));
  h = Math.min(even(h), Math.floor(bounds.h));
  const x = Math.round(bounds.x + (bounds.w - w) * clamp(focusX, 0, 1));
  const y = Math.round(bounds.y + (bounds.h - h) * clamp(focusY, 0, 1));
  return { x, y, w, h };
}

export function computeLayout(
  source: Size,
  webcam: Rect | null,
  settings: Pick<ClipSettings, "layout" | "focusX" | "custom">,
  output: Size,
): FrameLayout {
  const full: Rect = { x: 0, y: 0, w: source.width, h: source.height };
  const out: Rect = { x: 0, y: 0, w: output.width, h: output.height };
  const fitH = even((output.width * source.height) / source.width);
  // A source at least as tall as the output has no room for a blurred border: `fit` is `fill` there.
  const requested = settings.layout === "fit" && fitH >= output.height ? "fill" : settings.layout;
  const mode: LayoutMode = requested === "split" && !webcam ? "fill" : requested;

  if (mode === "custom") {
    const custom = settings.custom ?? defaultCustomLayout(source, webcam, output);
    const { background, game, cam } = custom;
    const layers: LayoutLayer[] = [];
    if (background.kind === "blur") {
      layers.push({ role: "background", blur: true, src: cropToAspect(full, output.width / output.height), dst: out });
    }
    if (game) layers.push({ role: "game", blur: false, src: game.src, dst: game.dst });
    if (cam) {
      const { feather, radius, border, borderColor } = cam;
      layers.push({ role: "cam", blur: false, src: cam.src, dst: cam.dst, cam: { feather, radius, border, borderColor } });
    }
    return {
      mode,
      layers,
      fill: background.kind === "color" ? background.color : "#000",
      image: background.kind === "image" ? background.file : null,
    };
  }

  if (mode === "fit") {
    return {
      mode,
      fill: "#000",
      image: null,
      layers: [
        { role: "background", blur: true, src: cropToAspect(full, output.width / output.height), dst: out },
        {
          role: "game",
          blur: false,
          src: full,
          dst: { x: 0, y: Math.floor((output.height - fitH) / 4) * 2, w: output.width, h: fitH },
        },
      ],
    };
  }

  if (mode === "split" && webcam) {
    const cam = intersect(webcam, full);
    const natural = (output.width * cam.h) / cam.w;
    const panelH = even(clamp(natural, output.height * CAM_PANEL_MIN, output.height * CAM_PANEL_MAX));
    const gameH = output.height - panelH;
    return {
      mode,
      fill: "#000",
      image: null,
      layers: [
        {
          role: "game",
          blur: false,
          src: nudgeOffCam(cropToAspect(full, output.width / gameH, settings.focusX), cam, source.width),
          dst: { x: 0, y: panelH, w: output.width, h: gameH },
        },
        {
          role: "cam",
          blur: false,
          // Keep the top of the webcam (faces sit high in the frame) when it must be cropped.
          src: cropToAspect(cam, output.width / panelH, 0.5, 0.3),
          dst: { x: 0, y: 0, w: output.width, h: panelH },
        },
      ],
    };
  }

  return {
    mode: "fill",
    fill: "#000",
    image: null,
    layers: [
      {
        role: "game",
        blur: false,
        src: cropToAspect(full, output.width / output.height, settings.focusX),
        dst: out,
      },
    ],
  };
}

/**
 * Starting point when the user switches a clip to custom: the current split layout (webcam panel on top,
 * gameplay below), or the plain fill without a webcam, as free elements over a blurred background.
 */
export function defaultCustomLayout(source: Size, webcam: Rect | null, output: Size): CustomLayout {
  const { layers } = computeLayout(source, webcam, { layout: "split", focusX: 0.5, custom: null }, output);
  const game = layers.find((layer) => layer.role === "game");
  const cam = layers.find((layer) => layer.role === "cam");
  return {
    background: { kind: "blur" },
    game: game ? { src: game.src, dst: game.dst } : null,
    cam: cam ? { src: cam.src, dst: cam.dst, feather: 0, radius: 0, border: 0, borderColor: "#ffffff" } : null,
  };
}

/** Largest share of the crop width the gameplay crop may move to get the webcam out of the picture. */
const MAX_CAM_NUDGE = 0.25;

/**
 * The webcam is already shown in its own panel; when it only clips the side of the gameplay crop,
 * slide the crop sideways until it is clear. A webcam deep inside the crop is left alone:
 * keeping the action centred matters more.
 */
function nudgeOffCam(crop: Rect, cam: Rect, sourceWidth: number): Rect {
  const camRight = cam.x + cam.w;
  const cropRight = crop.x + crop.w;
  if (camRight <= crop.x || cam.x >= cropRight) return crop;
  const limit = crop.w * MAX_CAM_NUDGE;
  const toRight = Math.ceil(camRight / 2) * 2 - crop.x;
  if (cam.x <= crop.x && toRight <= limit && cropRight + toRight <= sourceWidth) {
    return { ...crop, x: crop.x + toRight };
  }
  const toLeft = cropRight - Math.floor(cam.x / 2) * 2;
  if (camRight >= cropRight && toLeft <= limit && crop.x - toLeft >= 0) {
    return { ...crop, x: crop.x - toLeft };
  }
  return crop;
}

function intersect(a: Rect, b: Rect): Rect {
  const x = clamp(a.x, b.x, b.x + b.w - 2);
  const y = clamp(a.y, b.y, b.y + b.h - 2);
  return {
    x,
    y,
    w: clamp(a.x + a.w, x + 2, b.x + b.w) - x,
    h: clamp(a.y + a.h, y + 2, b.y + b.h) - y,
  };
}
