import React from "react";

type Props = { children: React.ReactNode; name?: string };
type State = { hasError: boolean; error: Error | null };

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.name ? `:${this.props.name}` : ""}]`, error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: 40,
          textAlign: "center",
          color: "var(--text)",
          maxWidth: 500,
          margin: "80px auto",
        }}>
          <h2 style={{ color: "var(--danger)", marginBottom: 12 }}>
            {this.props.name ? `${this.props.name} 出现异常` : "页面出现异常"}
          </h2>
          <p style={{ color: "var(--muted)", fontSize: 14, marginBottom: 20 }}>
            {this.state.error?.message ?? "未知错误"}
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button
              className="btn"
              onClick={() => this.setState({ hasError: false, error: null })}
            >
              重试
            </button>
            <button
              className="btn primary"
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
            >
              重新加载
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

/** Page-level error boundary — wraps individual modules so one crash doesn't take down the whole app */
export function PageBoundary({ name, children }: { name: string; children: React.ReactNode }) {
  return <ErrorBoundary name={name}>{children}</ErrorBoundary>;
}
