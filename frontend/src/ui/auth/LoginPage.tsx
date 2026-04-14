import React from "react";
import { login, signup } from "../../services/auth";

type Props = {
  onLogin: () => void;
};

export function LoginPage({ onLogin }: Props) {
  const [mode, setMode] = React.useState<"login" | "register">("login");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);
    try {
      if (mode === "login") {
        await login(email, password);
        onLogin();
      } else {
        if (password.length < 6) {
          setError("密码至少 6 位");
          setLoading(false);
          return;
        }
        const result = await signup(email, password, name || undefined);
        if (result.user && !result.session) {
          setSuccess("注册成功！请检查邮箱确认链接，或直接登录。");
          setMode("login");
        } else if (result.session) {
          onLogin();
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="loginContainer">
      <div className="loginCard">
        <div className="loginHeader">
          <div className="sidebarLogo" style={{ width: 40, height: 40, margin: "0 auto 12px" }} />
          <h1>Production OS</h1>
          <p>AI 服装生产运营系统</p>
        </div>

        {/* Mode Toggle */}
        <div className="loginToggle">
          <button
            className={`loginToggleBtn ${mode === "login" ? "loginToggleBtn--active" : ""}`}
            onClick={() => { setMode("login"); setError(null); setSuccess(null); }}
            type="button"
          >
            登录
          </button>
          <button
            className={`loginToggleBtn ${mode === "register" ? "loginToggleBtn--active" : ""}`}
            onClick={() => { setMode("register"); setError(null); setSuccess(null); }}
            type="button"
          >
            注册
          </button>
        </div>

        <form onSubmit={handleSubmit} className="loginForm">
          {error && <div className="loginError">{error}</div>}
          {success && <div className="loginSuccess">{success}</div>}

          {mode === "register" && (
            <label className="loginLabel">
              姓名
              <input
                type="text"
                className="loginInput"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="你的姓名"
                autoComplete="name"
              />
            </label>
          )}

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
              placeholder={mode === "register" ? "至少 6 位密码" : "输入密码"}
              required
              minLength={mode === "register" ? 6 : undefined}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
            />
          </label>

          <button
            type="submit"
            className="btn primary loginBtn"
            disabled={loading || !email || !password}
          >
            {loading ? (mode === "login" ? "登录中..." : "注册中...") : (mode === "login" ? "登录" : "注册")}
          </button>
        </form>
      </div>
    </div>
  );
}
