import { lazy } from 'react'
import { Navigate } from 'react-router-dom'

const Dashboard = lazy(() => import('@/app/dashboard/page'))

export interface RouteConfig {
  path: string
  element: React.ReactNode
  children?: RouteConfig[]
}

export const routes: RouteConfig[] = [
  {
    path: '/',
    element: <Navigate to="dashboard" replace />
  },
  {
    path: '/dashboard',
    element: <Dashboard />
  },
  {
    path: '*',
    element: <Navigate to="dashboard" replace />
  }
]
