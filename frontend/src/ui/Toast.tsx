import React from "react";

type ToastType = "success" | "error" | "warning" | "info";

type ToastItem = {
  id: number;
  message: string;
  type: ToastType;
};

type ToastContextType = {
  toast: (message: string, type?: ToastType) => void;
};

const ToastContext = React.createContext<ToastContextType>({
  toast: () => {},
});

export function useToast() {
  return React.useContext(ToastContext);
}

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);

  const toast = React.useCallback((message: string, type: ToastType = "info") => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="toastContainer">
        {toasts.map((t) => (
          <div key={t.id} className={`toastItem toastItem--${t.type}`}>
            <span className="toastIcon">
              {t.type === "success" ? "ok" : t.type === "error" ? "X" : t.type === "warning" ? "!" : "i"}
            </span>
            <span className="toastMsg">{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
