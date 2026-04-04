import React from "react";
import { login } from "../../services/auth";

type Props = {
  onLogin: () => void;
};

export function LoginPage({ onLogin }: Props) {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email, password);
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="loginContainer">
      <div className="loginCard">
        <div className="loginHeader">
          <div className="logo" />
          <h1>Production OS</h1>
          <p>排产管理 + 巡厂定位</p>
        </div>

        <form onSubmit={handleSubmit} className="loginForm">
          {error && <div className="loginError">{error}</div>}

          <label className="loginLabel">
            邮箱
            <input
              type="email"
              className="loginInput"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
              autoFocus
              autoComplete="email"
            />
          </label>

          <label className="loginLabel">
            密码
            <input
              type="password"
              className="loginInput"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="输入密码"
              required
              autoComplete="current-password"
            />
          </label>

          <button
            type="submit"
            className="btn primary loginBtn"
            disabled={loading || !email || !password}
          >
            {loading ? "登录中..." : "登录"}
          </button>
        </form>
      </div>
    </div>
  );
}
