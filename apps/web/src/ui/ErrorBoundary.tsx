/**
 * A render error stays where it happened (WEB-011). Without a boundary React unmounts the whole
 * root on one bad value in one card, and the window goes blank with the rail and its Reload
 * inside it. The shell wraps the page in one of these (and each overlay in its own), so the rail,
 * the keys and ⌘R keep working, the page says what happened, and going anywhere else recovers.
 * Orr is never in an error (structure.md §5): the fallback is a plain notice.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./controls.js";
import { Notice } from "./states.js";

interface Props {
  children: ReactNode;
  /** What failed, in words: "This page", "Settings". */
  what?: string;
  /** Where "Today" (or another way out) goes; omitted, only Reload is offered. */
  onLeave?: { label: string; run: () => void };
}

export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // For whoever opens the console; the page itself never shows raw exception text.
    console.error(`[orrama] ${this.props.what ?? "This page"} hit an error`, error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const what = this.props.what ?? "This page";
    return (
      <div className="ui error-page">
        <Notice
          title={`${what} hit an error.`}
          text="Reload to try again, or go somewhere else: the rest of the app still works."
          actions={
            <>
              <Button size="sm" onClick={() => location.reload()}>
                Reload
              </Button>
              {this.props.onLeave && (
                <Button size="sm" kind="quiet" onClick={this.props.onLeave.run}>
                  {this.props.onLeave.label}
                </Button>
              )}
            </>
          }
        />
      </div>
    );
  }
}
