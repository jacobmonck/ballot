import { Component, type ReactNode } from "react";
import { CenteredMessage } from "./Status";

// Votes live on the server, so reloading is always a safe way back.
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <CenteredMessage title="Something went wrong">
        <p>Your saved votes are safe.</p>
        <button type="button" className="btn btn-primary mt-4" onClick={() => location.reload()}>
          Reload
        </button>
      </CenteredMessage>
    );
  }
}
