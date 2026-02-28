import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

function createAppRouter() {
  return createRouter({
    routeTree,
    defaultPreload: 'intent',
  })
}

let routerInstance: ReturnType<typeof createAppRouter> | null = null

export function getRouter() {
  if (!routerInstance) {
    routerInstance = createAppRouter()
  }

  return routerInstance
}

export const router = getRouter()

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
