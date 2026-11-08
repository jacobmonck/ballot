import { MotionConfig } from "motion/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CenteredMessage } from "./components/Status";
import "./index.css";
import { Brother } from "./screens/Brother";
import { Host } from "./screens/Host";
import { Join } from "./screens/Join";
import { Projector } from "./screens/Projector";

// Brothers vote at /r, the host runs the room at /host, and the projector shows it at /p.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <ErrorBoundary>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Join />} />
            <Route path="/r/:code" element={<Brother />} />
            <Route path="/host/:code" element={<Host />} />
            <Route path="/p/:code" element={<Projector />} />
            <Route
              path="*"
              element={
                <CenteredMessage title="Page not found">
                  <a className="link" href="/">
                    Go to the join page
                  </a>
                </CenteredMessage>
              }
            />
          </Routes>
        </BrowserRouter>
      </ErrorBoundary>
    </MotionConfig>
  </StrictMode>,
);
