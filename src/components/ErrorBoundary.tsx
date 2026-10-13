import { Component, type ReactNode } from "react";
import { strings } from "../i18n";

interface Props {
  children: ReactNode;
  /** Short text for a contained area, such as the reader. */
  help?: string;
  /** Remount the children when this changes, e.g. the open message id. */
  resetKey?: unknown;
  className?: string;
  /** Keeps ids that splitters and layout code point at. */
  id?: string;
}

interface State {
  failed: boolean;
  resetKey?: unknown;
}

/**
 * Keeps one broken view from blanking the whole window. Nothing is logged:
 * errors can carry message content.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): State | null {
    if (props.resetKey !== state.resetKey) {
      return { failed: false, resetKey: props.resetKey };
    }
    return null;
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        className={this.props.className ?? "crash-recovery"}
        id={this.props.id}
        role="alert"
      >
        <h2>{strings.app.crashTitle}</h2>
        <p>{this.props.help ?? strings.app.crashHelp}</p>
        <button
          type="button"
          className="primary-button"
          onClick={() => window.location.reload()}
        >
          {strings.app.crashReload}
        </button>
      </div>
    );
  }
}
