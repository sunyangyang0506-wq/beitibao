import React from "react";
import { createRoot } from "react-dom/client";
import { ConnectedPc } from "./ConnectedPc.jsx";
import { PrototypeAccess } from "./PrototypeAccess.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {import.meta.env.MODE === "connected" ? <ConnectedPc /> : <PrototypeAccess />}
  </React.StrictMode>,
);
