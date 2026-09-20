import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { useI18n } from '@/i18n/I18nProvider'

export function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const location = useLocation()
  const { dir } = useI18n()

  useEffect(() => setMobileOpen(false), [location.pathname])

  return (
    <div className="staff-shell flex h-screen overflow-hidden bg-[#f7f6f2] text-[#14233b]">
      <div className="hidden shrink-0 lg:block">
        <Sidebar />
      </div>

      <AnimatePresence>
        {mobileOpen && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <motion.button
              type="button"
              aria-label="Close navigation"
              className="absolute inset-0 h-full w-full bg-[#071426]/60 backdrop-blur-sm"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setMobileOpen(false)}
            />
            <motion.div
              className="absolute inset-y-0 start-0"
              initial={{ x: dir === 'rtl' ? '100%' : '-100%' }} animate={{ x: 0 }} exit={{ x: dir === 'rtl' ? '100%' : '-100%' }}
              transition={{ type: 'spring', stiffness: 320, damping: 34 }}
            >
              <Sidebar onNavigate={() => setMobileOpen(false)} />
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <div className="min-w-0 flex flex-1 flex-col overflow-hidden">
        <Topbar onMenu={() => setMobileOpen(true)} />
        <main className="staff-main flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto w-full max-w-[1680px] px-3 py-3 sm:px-4 sm:py-4 xl:px-5">
            <AnimatePresence mode="wait">
              <motion.div
                key={location.pathname}
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              >
                <Outlet />
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </div>
    </div>
  )
}
