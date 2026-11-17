import { useRef, useState, type ReactNode } from "react";
import { Crop, Eye, EyeOff, ImagePlus, Link2, Link2Off, Loader2, RotateCcw } from "lucide-react";
import type { CamElement, Clip, CustomLayout, LayoutBackground, LayoutElement, Project } from "../../shared/types";
import { ASSET_TYPES, MAX_ASSET_BYTES, media, uploadAsset } from "../lib/api";
import { CAM_STYLE, defaultElement, fitAspect, MAX_BORDER, MAX_FEATHER, resolveCustom, setDstField, withElement, type CustomUi, type ElementRole } from "../lib/custom";
import { cn } from "../lib/format";
import type { ClipEdit } from "../lib/hooks";
import type { Player } from "../lib/player";
import { useToast } from "../lib/toast";
import { CropEditor } from "./CropEditor";
import { RectFields } from "./RectEditor";
import { Button, ProgressBar } from "./ui";

const ELEMENTS: { role: ElementRole; label: string }[] = [
  { role: "game", label: "Game" },
  { role: "cam", label: "Webcam" },
];

const BACKGROUNDS = [
  { kind: "blur", label: "Blur" },
  { kind: "color", label: "Colour" },
  { kind: "image", label: "Image" },
] as const;

const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

/** "#abc" / "abc" / "#AABBCC" -> "#aabbcc"; null when it is not a colour. */
function normalizeHex(text: string): string | null {
  const m = HEX.exec(text.trim());
  if (!m) return null;
  const digits = m[1]!.toLowerCase();
  return `#${digits.length === 3 ? [...digits].map((c) => c + c).join("") : digits}`;
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const hex = draft === null ? null : normalizeHex(draft);
    setDraft(null);
    if (hex && hex !== value) onChange(hex);
  };
  return (
    <span className="flex items-center gap-2">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} aria-label={`${label} picker`} className="h-9 w-10 shrink-0 cursor-pointer rounded border border-zinc-700 bg-zinc-950 p-0.5" />
      <input
        type="text"
        value={draft ?? value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        spellCheck={false}
        maxLength={7}
        aria-label={`${label} hex`}
        className="h-9 w-24 rounded-md border border-zinc-700 bg-zinc-950 px-2.5 font-mono text-sm text-zinc-100 focus:border-indigo-400"
      />
    </span>
  );
}

function Slider({ label, value, min, max, onChange, suffix = "px", children }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; suffix?: string; children?: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="text-zinc-200 tabular-nums">
          {value}
          {suffix}
        </span>
      </span>
      <span className="flex items-center gap-2">
        <input type="range" min={min} max={max} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} className="min-w-0 flex-1" />
        {children}
      </span>
    </label>
  );
}

interface Props {
  project: Project;
  clip: Clip;
  player: Player;
  ui: CustomUi;
  onUiChange: (ui: CustomUi) => void;
  edit: (clipId: string, patch: ClipEdit, immediate?: boolean) => void;
  onApplyAll: () => void;
  applying: boolean;
}

/** Free-form layout controls: element boxes, webcam look, background. The on-canvas boxes edit the same `settings.custom`. */
export function CustomLayoutPanel({ project, clip, player, ui, onUiChange, edit, onApplyAll, applying }: Props) {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [cropOpen, setCropOpen] = useState(false);
  const [upload, setUpload] = useState<{ fraction: number } | null>(null);
  const [lastImage, setLastImage] = useState<string | null>(null);
  const [lastColor, setLastColor] = useState("#111111");
  /** "Image" picked before any image exists: shows the upload prompt without touching the clip. */
  const [pendingImage, setPendingImage] = useState(false);

  const source = project.source;
  if (!source) return null;
  const sourceSize = { width: source.width, height: source.height };
  const webcam = project.webcam.rect;
  const custom = resolveCustom(sourceSize, webcam, clip.settings.custom);
  const { background } = custom;

  const change = (next: CustomLayout, immediate = false) => edit(clip.id, { settings: { custom: next } }, immediate);
  const selected = ui.selected;
  const element = custom[selected];
  const cam = custom.cam;
  const elementLabel = ELEMENTS.find((e) => e.role === selected)!.label;

  const patchElement = (patch: Partial<LayoutElement>, immediate = false) => {
    if (element) change(withElement(custom, selected, { ...element, ...patch }), immediate);
  };
  const patchCam = (patch: Partial<CamElement>, immediate = false) => {
    if (cam) change({ ...custom, cam: { ...cam, ...patch } }, immediate);
  };
  const setBackground = (next: LayoutBackground, immediate = true) => change({ ...custom, background: next }, immediate);

  const aspect = element && ui.lockAspect ? element.src.w / element.src.h : null;
  const fresh = (role: ElementRole) => (role === "game" ? defaultElement("game", sourceSize, webcam) : defaultElement("cam", sourceSize, webcam));

  const pickBackground = (kind: LayoutBackground["kind"]) => {
    if (kind === "image") {
      if (lastImage) {
        setPendingImage(false);
        setBackground({ kind: "image", file: lastImage });
      } else {
        setPendingImage(true);
      }
      return;
    }
    setPendingImage(false);
    if (background.kind === "color") setLastColor(background.color);
    setBackground(kind === "blur" ? { kind: "blur" } : { kind: "color", color: lastColor });
  };

  const onFile = async (file: File | undefined) => {
    if (fileInput.current) fileInput.current.value = "";
    if (!file) return;
    if (!ASSET_TYPES.includes(file.type)) return toast.error(new Error("Use a PNG, JPEG or WebP image"));
    if (file.size > MAX_ASSET_BYTES) return toast.error(new Error(`That image is ${(file.size / 1048576).toFixed(1)} MB; the limit is 15 MB`));
    setUpload({ fraction: 0 });
    try {
      const { file: name } = await uploadAsset(project.id, file, (fraction) => setUpload({ fraction }));
      setLastImage(name);
      setPendingImage(false);
      setBackground({ kind: "image", file: name });
    } catch (e) {
      toast.error(e);
    } finally {
      setUpload(null);
    }
  };

  const shownKind = pendingImage ? "image" : background.kind;
  const imageFile = background.kind === "image" ? background.file : null;

  return (
    <div className="flex flex-col gap-3 border-t border-zinc-800 pt-3" data-testid="custom-panel">
      <div className="flex flex-col gap-2">
        <div role="radiogroup" aria-label="Element to edit" className="grid grid-cols-2 gap-1 rounded-md border border-zinc-700 p-0.5">
          {ELEMENTS.map(({ role, label }) => (
            <button
              key={role}
              type="button"
              role="radio"
              aria-checked={selected === role}
              onClick={() => onUiChange({ ...ui, selected: role })}
              className={cn(
                "flex h-7 items-center justify-center gap-1.5 rounded text-xs font-medium transition-colors",
                selected === role ? "bg-zinc-100 text-zinc-900" : "text-zinc-300 hover:bg-zinc-800",
              )}
            >
              {custom[role] ? null : <EyeOff className="size-3.5" aria-hidden />}
              {label}
              {custom[role] ? null : <span className="text-[10px] font-normal">hidden</span>}
            </button>
          ))}
        </div>

        {element ? (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button small onClick={() => change(withElement(custom, selected, null), true)} aria-label={`Hide ${elementLabel}`}>
                <EyeOff className="size-3.5" aria-hidden /> Hide
              </Button>
              <Button small onClick={() => setCropOpen(true)} title="Choose which part of the video this element shows">
                <Crop className="size-3.5" aria-hidden /> Crop
              </Button>
              <Button
                small
                onClick={() => change(withElement(custom, selected, fresh(selected)), true)}
                title="Back to the default position, crop and style"
              >
                <RotateCcw className="size-3.5" aria-hidden /> Reset
              </Button>
              <Button
                small
                aria-pressed={ui.lockAspect}
                onClick={() => onUiChange({ ...ui, lockAspect: !ui.lockAspect })}
                title={ui.lockAspect ? "Resizing keeps the crop's proportions (Shift frees it)" : "Resizing is free: the picture can stretch"}
                className="ml-auto"
              >
                {ui.lockAspect ? <Link2 className="size-3.5" aria-hidden /> : <Link2Off className="size-3.5" aria-hidden />} Aspect
              </Button>
            </div>
            <RectFields
              key={selected}
              rect={element.dst}
              size={{ width: 1080, height: 1920 }}
              className="w-full"
              onChange={(dst) => patchElement({ dst })}
              setField={(field, value) => setDstField(element.dst, field, value, aspect)}
            />
            <p className="text-[11px] leading-snug text-zinc-500">
              Showing source {element.src.x},{element.src.y} {element.src.w}×{element.src.h}. On the preview: drag a box to move it, drag handles to resize. Shift frees the aspect, Alt skips snapping, arrow keys nudge (Shift = 10 px).
            </p>
          </>
        ) : (
          <div className="flex items-center justify-between gap-2 rounded-md bg-zinc-950 px-3 py-2 text-xs text-zinc-400">
            {elementLabel} is hidden.
            <Button small onClick={() => change(withElement(custom, selected, fresh(selected)), true)}>
              <Eye className="size-3.5" aria-hidden /> Show
            </Button>
          </div>
        )}
      </div>

      {cam && (
        <div className={cn("flex flex-col gap-3 rounded-md border p-2.5", selected === "cam" ? "border-amber-400/40" : "border-zinc-800")}>
          <h3 className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">Webcam style</h3>
          <Slider label="Feather" value={cam.feather} min={0} max={MAX_FEATHER} onChange={(feather) => patchCam({ feather })} />
          <Slider
            label="Corner radius"
            value={Math.min(cam.radius, Math.floor(Math.min(cam.dst.w, cam.dst.h) / 2))}
            min={0}
            max={Math.floor(Math.min(cam.dst.w, cam.dst.h) / 2)}
            onChange={(radius) => patchCam({ radius })}
          >
            <Button small onClick={() => patchCam({ radius: Math.floor(Math.min(cam.dst.w, cam.dst.h) / 2) }, true)} title="Fully rounded: a circle on a square box">
              Circle
            </Button>
          </Slider>
          <Slider label="Border" value={cam.border} min={0} max={MAX_BORDER} onChange={(border) => patchCam({ border })}>
            <ColorField label="Border colour" value={cam.borderColor || CAM_STYLE.borderColor} onChange={(borderColor) => patchCam({ borderColor })} />
          </Slider>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">Background</h3>
        <div role="radiogroup" aria-label="Background" className="grid grid-cols-3 gap-1 rounded-md border border-zinc-700 p-0.5">
          {BACKGROUNDS.map(({ kind, label }) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={shownKind === kind}
              onClick={() => pickBackground(kind)}
              className={cn("h-7 rounded text-xs font-medium transition-colors", shownKind === kind ? "bg-zinc-100 text-zinc-900" : "text-zinc-300 hover:bg-zinc-800")}
            >
              {label}
            </button>
          ))}
        </div>
        {shownKind === "blur" && <p className="text-xs text-zinc-500">A blurred copy of the whole video fills the frame.</p>}
        {shownKind === "color" && background.kind === "color" && <ColorField label="Background colour" value={background.color} onChange={(color) => setBackground({ kind: "color", color }, false)} />}
        {shownKind === "image" && (
          <div className="flex items-center gap-3">
            {imageFile && (
              <img src={media.asset(project.id, imageFile)} alt="Current background" className="h-20 w-[45px] shrink-0 rounded border border-zinc-700 bg-zinc-950 object-cover" />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <input ref={fileInput} type="file" accept={ASSET_TYPES.join(",")} className="sr-only" tabIndex={-1} onChange={(e) => void onFile(e.target.files?.[0])} aria-label="Background image file" />
              <Button small onClick={() => fileInput.current?.click()} disabled={upload !== null} className="self-start">
                {upload ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ImagePlus className="size-3.5" aria-hidden />}
                {imageFile ? "Replace image" : "Upload image"}
              </Button>
              {upload ? <ProgressBar value={upload.fraction} label="Upload progress" /> : <span className="text-[11px] text-zinc-500">PNG, JPEG or WebP, up to 15 MB. Cover-fitted to the frame.</span>}
            </div>
          </div>
        )}
      </div>

      <Button variant="secondary" onClick={onApplyAll} disabled={applying} className="w-full">
        {applying ? "Applying..." : "Apply layout to all clips"}
      </Button>

      {cropOpen && element && (
        <CropEditor
          project={project}
          title={elementLabel}
          initial={element.src}
          initialTime={player.time}
          onClose={() => setCropOpen(false)}
          // The box keeps its place and shrinks to the new proportions, so the picture is never stretched.
          onApply={(src) => patchElement({ src, dst: fitAspect(element.dst, src.w / src.h) }, true)}
        />
      )}
    </div>
  );
}
