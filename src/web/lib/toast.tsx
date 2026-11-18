import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { errorMessage } from "./api";

interface ToastItem {
  id: number;
  kind: "error" | "info";
  text: string;
}

interface Toaster {
  error: (error: unknown) => void;
  info: (text: string) => void;
}

const ToastContext = createContext<Toaster | null>(null);

export function useToast(): Toaster {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast outside ToastProvider");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const container = useRef<HTMLDivElement>(null);

  // A modal <dialog> sits in the browser's top layer and would hide the toasts. A manual popover is top-layer too;
  // showing it again moves it above a dialog that opened after it.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    if (element.matches(":popover-open")) element.hidePopover();
    if (items.length > 0) element.showPopover();
  }, [items]);

  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (kind: ToastItem["kind"], text: string) => {
      const id = nextId.current++;
      setItems((all) => [...all.slice(-4), { id, kind, text }]);
      window.setTimeout(() => dismiss(id), kind === "error" ? 9000 : 4000);
    },
    [dismiss],
  );

  const toaster = useMemo<Toaster>(
    () => ({ error: (e) => push("error", errorMessage(e)), info: (text) => push("info", text) }),
    [push],
  );

  return (
    <ToastContext.Provider value={toaster}>
      {children}
      <div
        ref={container}
        popover="manual"
        className="pointer-events-none fixed inset-auto right-4 bottom-20 z-[60] m-0 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-visible border-0 bg-transparent p-0 text-inherit"
        role="status"
        aria-live="polite"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-xl ${
              t.kind === "error"
                ? "border-red-800 bg-red-950 text-red-100"
                : "border-zinc-700 bg-zinc-900 text-zinc-100"
            }`}
          >
            {t.kind === "error" ? (
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-400" aria-hidden />
            ) : (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" aria-hidden />
            )}
            <span className="min-w-0 flex-1 break-words">{t.text}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="rounded p-0.5 text-zinc-400 hover:text-white"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
