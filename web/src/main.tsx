import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { GroupPage } from "./GroupPage.tsx";
import { Home } from "./Home.tsx";
import "./styles.css";

function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const groupId = /^\/g\/([\w-]+)/.exec(path)?.[1];
  return groupId ? <GroupPage key={groupId} groupId={groupId} /> : <Home />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
