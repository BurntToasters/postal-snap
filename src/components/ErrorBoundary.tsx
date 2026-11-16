import { Component, createRef, type ReactNode } from "react";
import { ModalRecoveryFallback, RecoveryContent } from "./ErrorRecovery";

interface Props {
  children: ReactNode;
  /** Short text for a contained area, such as the reader. */
  help?: string;
  /** Remount the children when this changes, e.g. the open message id. */
  resetKey?: unknown;
  className?: string;
  /** Keeps ids that splitters and layout code point at. */
  id?: string;
  /** Reload data before remounting a failed view. */
  onReset?: () => void | Promise<void>;
  onClose?: () => void;
  focusSelector?: string;
  modal?: boolean;
}

interface State {
  failed: boolean;
  resetKey?: unknown;
  retrying: boolean;
  retryFailed: boolean;
}

const recoveryFocusSelector =
  'button, input, select, textarea, a[href], [role="option"][tabindex], [tabindex="0"], [contenteditable="true"]';

function canReceiveRecoveryFocus(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  return (
    !element.matches(":disabled, [aria-disabled='true']") &&
    !element.closest(
      "[aria-disabled='true'], [hidden], [inert], [aria-hidden='true']",
    ) &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    element.getClientRects().length > 0
  );
}

/**
 * Keeps one broken view from blanking the whole window. Nothing is logged:
 * errors can carry message content.
 */
export class ErrorBoundary extends Component<Props, State> {
  private headingRef = createRef<HTMLHeadingElement>();

  state: State = {
    failed: false,
    resetKey: this.props.resetKey,
    retrying: false,
    retryFailed: false,
  };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true, retrying: false, retryFailed: false };
  }

  static getDerivedStateFromProps(props: Props, state: State): State | null {
    if (props.resetKey !== state.resetKey) {
      return {
        failed: false,
        resetKey: props.resetKey,
        retrying: false,
        retryFailed: false,
      };
    }
    return null;
  }

  componentDidCatch(): void {
    this.headingRef.current?.focus();
  }

  componentDidUpdate(_previousProps: Props, previousState: State): void {
    if (previousState.failed && !this.state.failed) {
      window.requestAnimationFrame(() => this.focusRecoveredView());
    }
  }

  private async tryAgain(): Promise<void> {
    this.setState({ retrying: true, retryFailed: false });
    try {
      await this.props.onReset?.();
    } catch {
      this.setState({ retrying: false, retryFailed: true });
      return;
    }
    this.setState({
      failed: false,
      resetKey: this.props.resetKey,
      retrying: false,
      retryFailed: false,
    });
  }

  private focusRecoveredView(): void {
    const root = this.props.id
      ? document.getElementById(this.props.id)
      : document;
    const preferred = this.props.focusSelector
      ? [...document.querySelectorAll<HTMLElement>(this.props.focusSelector)]
          .filter(canReceiveRecoveryFocus)
          .at(0)
      : undefined;
    const fallback = root
      ? [...root.querySelectorAll<HTMLElement>(recoveryFocusSelector)]
          .filter(canReceiveRecoveryFocus)
          .at(0)
      : undefined;
    const target = preferred ?? fallback;
    target?.focus();
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const content = (
      <RecoveryContent
        help={this.props.help}
        retrying={this.state.retrying}
        retryFailed={this.state.retryFailed}
        headingRef={this.headingRef}
        onTryAgain={() => void this.tryAgain()}
        onReload={() => window.location.reload()}
        onClose={this.props.onClose}
      />
    );
    const className = this.props.className ?? "crash-recovery";
    if (this.props.modal) {
      return (
        <ModalRecoveryFallback
          className={className}
          retrying={this.state.retrying}
          onClose={this.props.onClose}
        >
          {content}
        </ModalRecoveryFallback>
      );
    }
    return (
      <div
        className={className}
        id={this.props.id}
        role="alert"
        aria-busy={this.state.retrying || undefined}
      >
        {content}
      </div>
    );
  }
}
