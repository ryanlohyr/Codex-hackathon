import { HeadContent, Link, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import { VoiceAgentWidget } from '../components/chat/VoiceAgentWidget'
import { useAppStore } from '../store/useAppStore'
import appCss from '../styles/app.css?url'

function NotFoundPage() {
  return (
    <div className="grid h-full w-full place-items-center bg-slate-950 text-slate-100">
      <div className="space-y-4 text-center">
        <p className="text-sm uppercase tracking-[0.18em] text-slate-400">404</p>
        <h1 className="text-2xl font-semibold">Page not found</h1>
        <Link to="/" className="text-cyan-300 hover:text-cyan-200">
          Return to canvas
        </Link>
      </div>
    </div>
  )
}

function RootDocument() {
  const theme = useAppStore((state) => state.theme)

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <main
          id="mc-root-layout"
          data-theme={theme}
          className="h-screen w-screen overflow-hidden"
        >
          <Outlet />
          <VoiceAgentWidget />
        </main>
        <Scripts />
      </body>
    </html>
  )
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'MindCanvas 3D' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootDocument,
  notFoundComponent: NotFoundPage,
})

