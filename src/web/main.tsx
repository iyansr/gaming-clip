import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Link, usePath } from "./lib/router";
import { ToastProvider } from "./lib/toast";
import { HomePage } from "./pages/HomePage";
import { ProjectPage } from "./pages/ProjectPage";

const homeLinkClass = "rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500";

function NotFound() {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex flex-col items-center gap-3">
        <p className="text-zinc-300">Page not found.</p>
        <Link href="/" className={homeLinkClass}>
          Back to projects
        </Link>
      </div>
    </div>
  );
}

function Routes() {
  const path = usePath();
  if (path === "/" || path === "") return <HomePage />;
  const raw = /^\/project\/([^/]+)\/?$/.exec(path)?.[1];
  if (raw) {
    let id: string | null = null;
    try {
      id = decodeURIComponent(raw);
    } catch {
      // malformed escape sequence: no project can have this id
    }
    if (id) return <ProjectPage key={id} id={id} />;
  }
  return <NotFound />;
}

/** Keeps a render crash from blanking the whole app. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid h-full place-items-center p-6">
        <div role="alert" className="flex max-w-xl flex-col items-center gap-3 text-center">
          <p className="text-lg font-semibold text-red-200">Something went wrong</p>
          <pre className="max-w-full overflow-auto rounded-md border border-red-800 bg-red-950/60 p-3 text-left text-xs whitespace-pre-wrap text-red-100">
            {this.state.error.message}
          </pre>
          <a href="/" className={homeLinkClass}>
            Back to projects
          </a>
        </div>
      </div>
    );
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <ErrorBoundary>
    <ToastProvider>
      <Routes />
    </ToastProvider>
  </ErrorBoundary>,
);
