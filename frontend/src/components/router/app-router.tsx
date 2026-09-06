"use client";

import { lazy, Suspense, useEffect } from "react";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useLocation, useNavigate } from "@/lib/navigation";

const RecoveryPage = lazy(() => import("@/features/operations/recovery-page").then((module) => ({ default: module.RecoveryPage })));
const OperatorApp = lazy(() => import("@/app/operator-app").then((module) => ({ default: module.OperatorApp })));

export function AppRouter() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (location.pathname === "/") navigate("/cockpit", { replace: true });
    if (location.pathname === '/dashboard') navigate('/workflows/builder', { replace: true });
  }, [location.pathname, navigate]);

  return (
    <Suspense fallback={<LoadingSpinner />}>
      {location.pathname === "/recovery" ? <RecoveryPage /> : <OperatorApp />}
    </Suspense>
  );
}
