import React from "react";
import { createRoot } from "react-dom/client";

const root = createRoot(document.getElementById("root")!);
root.render(<p style={{ padding: "2rem", fontFamily: "system-ui" }}>正在加载 Agent Pocket…</p>);
void import("./main").then(({ App }) => root.render(<App />)).catch((error) => {
  root.render(<main style={{ padding: "2rem", fontFamily: "system-ui" }}><h1>网页端加载失败</h1><p>{error instanceof Error ? error.message : String(error)}</p><button onClick={() => location.reload()}>重新加载</button></main>);
});
