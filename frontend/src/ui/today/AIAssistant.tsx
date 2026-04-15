import React from "react";
import { askProductionAgent } from "../../services/api";
import "./today.css";

const QUICK_QUESTIONS = [
  "今天有哪些订单需要紧急处理？",
  "哪些工厂最近延期严重？",
  "哪些订单利润率最低？",
  "下周有哪些产能瓶颈？",
  "哪些物料有缺口风险？",
];

export function AIAssistant() {
  const [open, setOpen] = React.useState(false);
  const [question, setQuestion] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [history, setHistory] = React.useState<Array<{ q: string; a: string; tools: string[] }>>([]);

  async function handleAsk(q?: string) {
    const text = q ?? question;
    if (!text.trim()) return;

    setLoading(true);
    setQuestion("");
    try {
      const res = await askProductionAgent(text);
      setHistory((prev) => [{ q: text, a: res.answer, tools: res.tools_used }, ...prev]);
    } catch {
      setHistory((prev) => [{ q: text, a: "请求失败，请稍后重试", tools: [] }, ...prev]);
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button className="aiFloatBtn" onClick={() => setOpen(true)} title="AI 生产助手">
        AI
      </button>
    );
  }

  return (
    <div className="aiAssistant">
      <div className="aiAssistantHeader">
        <div className="aiAssistantTitle">
          <span className="todayAiBadge">AI</span>
          <span>生产助手</span>
        </div>
        <button className="orderDrawerClose" onClick={() => setOpen(false)}>x</button>
      </div>

      {/* Quick questions */}
      <div className="aiQuickList">
        {QUICK_QUESTIONS.map((q, i) => (
          <button key={i} className="aiQuickBtn" onClick={() => handleAsk(q)} disabled={loading}>
            {q}
          </button>
        ))}
      </div>

      {/* Input */}
      <div className="aiInputRow">
        <input
          className="aiInput"
          placeholder="问任何生产问题..."
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleAsk(); }}
          disabled={loading}
        />
        <button className="btn primary" onClick={() => handleAsk()} disabled={loading || !question.trim()}>
          {loading ? "..." : "发送"}
        </button>
      </div>

      {/* History */}
      <div className="aiHistory">
        {loading && (
          <div className="aiMsg aiMsg--loading">
            <span className="todayAiBadge">AI</span>
            <span>思考中...</span>
          </div>
        )}
        {history.map((item, i) => (
          <div key={i} className="aiConversation">
            <div className="aiMsg aiMsg--user">{item.q}</div>
            <div className="aiMsg aiMsg--agent">
              <div className="aiMsgText">{item.a}</div>
              {item.tools.length > 0 && (
                <div className="aiToolsUsed">
                  调用了: {item.tools.join(", ")}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
