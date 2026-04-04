import React from "react";

type Props = { children: React.ReactNode };
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
    console.error("[ErrorBoundary]", error, info.componentStack);
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
            页面出现异常
          </h2>
          <p style={{ color: "var(--muted)", fontSize: 14, marginBottom: 20 }}>
            {this.state.error?.message ?? "未知错误"}
          </p>
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
      );
    }

    return this.props.children;
  }
}
