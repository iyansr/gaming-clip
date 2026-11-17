import { useState } from "react";
import { RotateCcw, Save, ScanFace, VideoOff } from "lucide-react";
import type { Project, Rect } from "../../shared/types";
import { api } from "../lib/api";
import { clamp } from "../lib/format";
import { useToast } from "../lib/toast";
import { FrameTime, Modal, RectFields, RectStage } from "./RectEditor";
import { Button } from "./ui";

export function WebcamEditor({ project, initialTime, onClose, applyProject }: { project: Project; initialTime: number; onClose: () => void; applyProject: (p: Project) => void }) {
  const toast = useToast();
  const source = project.source;
  if (!source) throw new Error("WebcamEditor needs a downloaded source");
  const { width: sw, height: sh, duration } = source;

  const saved = project.webcam.rect;
  const fallback: Rect = { x: 0, y: 0, w: Math.round(sw * 0.25), h: Math.round(sw * 0.25 * (9 / 16)) };
  const [rect, setRect] = useState<Rect>(saved ?? fallback);
  const [time, setTime] = useState(clamp(initialTime, 0, Math.max(0, duration - 0.5)));
  const [busy, setBusy] = useState<null | "save" | "none" | "detect">(null);

  const dirty = !saved || saved.x !== rect.x || saved.y !== rect.y || saved.w !== rect.w || saved.h !== rect.h;

  const run = async (kind: "save" | "none" | "detect") => {
    setBusy(kind);
    try {
      if (kind === "detect") {
        applyProject(await api.rerun(project.id, "webcam"));
        toast.info("Detecting the webcam again...");
      } else {
        applyProject(await api.patchProject(project.id, { webcam: { rect: kind === "save" ? rect : null } }));
        toast.info(kind === "save" ? "Webcam rectangle saved" : "Webcam removed: split layout falls back to fill");
      }
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const wc = project.webcam;

  return (
    <Modal
      titleId="webcam-editor-title"
      icon={<ScanFace className="size-5 text-indigo-300" aria-hidden />}
      title="Webcam rectangle"
      onClose={onClose}
      extra={
        <span className="text-xs text-zinc-400">
          Current: <b className="text-zinc-200">{wc.source}</b>
          {wc.rect ? ` · confidence ${Math.round(wc.confidence * 100)}%` : wc.source === "none" ? " · no webcam" : " · nothing found"}
        </span>
      }
    >
      <RectStage projectId={project.id} time={time} rect={rect} onChange={setRect} size={{ width: sw, height: sh }} label="Webcam rectangle" />

      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <RectFields rect={rect} onChange={setRect} size={{ width: sw, height: sh }} />
        <FrameTime time={time} max={Math.max(0, duration - 0.5)} onChange={setTime} />
      </div>
      {!saved && <p className="text-xs text-amber-300">No webcam rectangle is set. Position the rectangle and save it to enable the split layout.</p>}

      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
        <Button variant="primary" onClick={() => void run("save")} disabled={busy !== null || !dirty}>
          <Save className="size-4" aria-hidden /> Save
        </Button>
        <Button onClick={() => saved && setRect(saved)} disabled={!saved || !dirty}>
          <RotateCcw className="size-4" aria-hidden /> Reset
        </Button>
        <span className="flex-1" />
        <Button onClick={() => void run("none")} disabled={busy !== null}>
          <VideoOff className="size-4" aria-hidden /> No webcam
        </Button>
        <Button onClick={() => void run("detect")} disabled={busy !== null}>
          <ScanFace className="size-4" aria-hidden /> Detect again
        </Button>
      </div>
    </Modal>
  );
}
