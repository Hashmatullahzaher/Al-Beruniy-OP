import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from './components/AppLayout'
import { ToastHost } from './components/toast'
import { Login } from './pages/Login'
import { Dashboard } from './pages/Dashboard'
import { Projects } from './pages/Projects'
import { Inventory } from './pages/Inventory'
import { BlockDetail } from './pages/BlockDetail'
import { Customers } from './pages/Customers'
import { CustomerDetail } from './pages/CustomerDetail'
import { Contracts } from './pages/Contracts'
import { Finance } from './pages/Finance'
import { Reports } from './pages/Reports'
import { Construction } from './pages/Construction'
import { Procurement } from './pages/Procurement'
import { HumanResources } from './pages/HumanResources'
import { Documents } from './pages/Documents'
import { Assistant } from './pages/Assistant'
import { SettingsPage } from './pages/Settings'
import { PortalLayout } from './portal/PortalLayout'
import { PortalHome } from './portal/PortalHome'

export function App() {
  return (
    <BrowserRouter>
      <ToastHost />
      <Routes>
        <Route path="/" element={<Navigate to="/app/dashboard" replace />} />
        <Route path="/login" element={<Login />} />

        <Route path="/app" element={<AppLayout />}>
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="projects" element={<Projects />} />
          <Route path="inventory" element={<Inventory />} />
          <Route path="inventory/blocks/:blockId" element={<BlockDetail />} />
          <Route path="customers" element={<Customers />} />
          <Route path="customers/:customerId" element={<CustomerDetail />} />
          <Route path="contracts" element={<Contracts />} />
          <Route path="finance" element={<Finance />} />
          <Route path="construction" element={<Construction />} />
          <Route path="procurement" element={<Procurement />} />
          <Route path="hr" element={<HumanResources />} />
          <Route path="reports" element={<Reports />} />
          <Route path="assistant" element={<Assistant />} />
          <Route path="ai-insights" element={<Assistant />} />
          <Route path="documents" element={<Documents />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>

        <Route path="/portal" element={<PortalLayout />}>
          <Route index element={<PortalHome />} />
        </Route>

        <Route path="*" element={<Navigate to="/app/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
