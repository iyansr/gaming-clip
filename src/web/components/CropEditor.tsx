import { Crop, RotateCcw, ScanFace } from "lucide-react";
import { useState } from "react";

import type { Project, Rect } from "../../shared/types";
import { clamp } from "../lib/format";
import { FrameTime, Modal, RectFields, RectStage } from "./RectEditor";
import { Button } from "./ui";

/** Source-frame editor for what part of the video one free-form element shows. */
export function CropEditor({
  project,
  title,
  initial,
  initialTime,
  onApply,
  onClose,
}: {
  project: Project;
  title: string;
  initial: Rect;
  initialTime: number;
  onApply: (src: Rect) => void;
  onClose: () => void;
}) {
  const source = project.source;
  if (!source) throw new Error("CropEditor needs a downloaded source");
  const size = { width: source.width, height: source.height };
  const [rect, setRect] = useState<Rect>(initial);
  const [time, setTime] = useState(clamp(initialTime, 0, Math.max(0, source.duration - 0.5)));
  const webcam = project.webcam.rect;
  const dirty = rect.x !== initial.x || rect.y !== initial.y || rect.w !== initial.w || rect.h !== initial.h;

  return (
    <Modal
      titleId="crop-editor-title"
      icon={<Crop className="size-5 text-indigo-300" aria-hidden />}
      title={`Crop: ${title}`}
      onClose={onClose}
    >
      <RectStage
        projectId={project.id}
        time={time}
        rect={rect}
        onChange={setRect}
        size={size}
        label={`${title} crop`}
      />
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <RectFields rect={rect} onChange={setRect} size={size} />
        <FrameTime time={time} max={Math.max(0, source.duration - 0.5)} onChange={setTime} />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
        <Button
          variant="primary"
          onClick={() => {
            onApply(rect);
            onClose();
          }}
          disabled={!dirty}
        >
          <Crop className="size-4" aria-hidden /> Apply crop
        </Button>
        <Button onClick={() => setRect(initial)} disabled={!dirty}>
          <RotateCcw className="size-4" aria-hidden /> Reset
        </Button>
        <Button onClick={() => setRect({ x: 0, y: 0, w: size.width, h: size.height })}>Whole frame</Button>
        {webcam && (
          <Button onClick={() => setRect(webcam)} title="The project's webcam rectangle">
            <ScanFace className="size-4" aria-hidden /> Detected webcam
          </Button>
        )}
      </div>
    </Modal>
  );
}
