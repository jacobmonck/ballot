import { MotionConfig } from "motion/react";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CenteredMessage } from "./components/Status";
import "./index.css";
import { Brother } from "./screens/Brother";
import { Join } from "./screens/Join";

// Phones only need the join page and ballot, so the host and projector screens load on demand.
const Host = lazy(() => import("./screens/Host").then((module) => ({ default: module.Host })));
const Projector = lazy(() => import("./screens/Projector").then((module) => ({ default: module.Projector })));

// Brothers vote at /r, the host runs the room at /host, and the projector shows it at /p.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <ErrorBoundary>
        <BrowserRouter>
          <Suspense fallback={<CenteredMessage title="Loading" />}>
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
          </Suspense>
        </BrowserRouter>
      </ErrorBoundary>
    </MotionConfig>
  </StrictMode>,
);
