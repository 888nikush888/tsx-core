"use client";

import { lazy, Suspense, useEffect } from "react";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useLocation, useNavigate } from "@/lib/navigation";

const Dashboard = lazy(() => import("@/app/dashboard/page"));

export function AppRouter() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (location.pathname !== "/dashboard")
      navigate("/dashboard", { replace: true });
  }, [location.pathname, navigate]);

  return (
    <Suspense fallback={<LoadingSpinner />}>
      <Dashboard />
    </Suspense>
  );
}
