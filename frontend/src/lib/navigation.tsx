import * as React from "react"

interface NavigationLocation {
  pathname: string
  search: string
}

interface NavigationContextValue {
  basename: string
  location: NavigationLocation
  navigate: (to: string, options?: NavigateOptions) => void
}

interface NavigateOptions {
  replace?: boolean
}

type SearchParamsUpdate =
  | URLSearchParams
  | ((current: URLSearchParams) => URLSearchParams)

const NavigationContext = React.createContext<NavigationContextValue | null>(null)

function normalizeBasename(value: string) {
  const trimmed = value.trim()
  if (!trimmed || trimmed === "/") return ""
  let start = 0
  while (trimmed[start] === "/") start += 1
  let end = trimmed.length
  while (end > start && trimmed[end - 1] === "/") end -= 1
  const normalized = trimmed.slice(start, end)
  return normalized ? `/${normalized}` : ""
}

function logicalLocation(basename: string): NavigationLocation {
  const browserPath = window.location.pathname || "/"
  const pathname = basename && (browserPath === basename || browserPath.startsWith(`${basename}/`))
    ? browserPath.slice(basename.length) || "/"
    : browserPath
  return { pathname: pathname.startsWith("/") ? pathname : `/${pathname}`, search: window.location.search }
}

function splitTarget(to: string): NavigationLocation {
  const target = new URL(to, window.location.origin)
  if (target.origin !== window.location.origin) {
    throw new Error("Navigation is restricted to this dashboard.")
  }
  return { pathname: target.pathname || "/", search: target.search }
}

function browserUrl(location: NavigationLocation, basename: string) {
  const pathname = location.pathname === "/" ? "" : location.pathname
  return `${basename}${pathname || "/"}${location.search}`
}

export function NavigationProvider({
  basename = "",
  children,
}: Readonly<{ basename?: string; children: React.ReactNode }>) {
  const normalizedBasename = React.useMemo(() => normalizeBasename(basename), [basename])
  const [location, setLocation] = React.useState(() => logicalLocation(normalizedBasename))

  React.useEffect(() => {
    const updateLocation = () => setLocation(logicalLocation(normalizedBasename))
    window.addEventListener("popstate", updateLocation)
    return () => window.removeEventListener("popstate", updateLocation)
  }, [normalizedBasename])

  const navigate = React.useCallback((to: string, options: NavigateOptions = {}) => {
    const nextLocation = splitTarget(to)
    const method = options.replace ? "replaceState" : "pushState"
    window.history[method]({}, "", browserUrl(nextLocation, normalizedBasename))
    setLocation(nextLocation)
  }, [normalizedBasename])

  const value = React.useMemo(
    () => ({ basename: normalizedBasename, location, navigate }),
    [location, navigate, normalizedBasename],
  )

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>
}

function useNavigation() {
  const navigation = React.useContext(NavigationContext)
  if (!navigation) throw new Error("Navigation hooks require NavigationProvider.")
  return navigation
}

export function useLocation() {
  return useNavigation().location
}

export function useNavigate() {
  return useNavigation().navigate
}

export function useSearchParams(): [
  URLSearchParams,
  (next: SearchParamsUpdate, options?: NavigateOptions) => void,
] {
  const { location, navigate } = useNavigation()
  const searchParams = React.useMemo(() => new URLSearchParams(location.search), [location.search])
  const setSearchParams = React.useCallback((update: SearchParamsUpdate, options?: NavigateOptions) => {
    const current = new URLSearchParams(location.search)
    const next = typeof update === "function" ? update(current) : update
    const query = next.toString()
    const search = query ? `?${query}` : ""
    navigate(location.pathname + search, options)
  }, [location.pathname, location.search, navigate])
  return [searchParams, setSearchParams]
}

export const Link = React.forwardRef<
  HTMLAnchorElement,
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { to: string }
>(({ to, onClick, target, ...props }, ref) => {
  const { basename, navigate } = useNavigation()
  const targetLocation = splitTarget(to)
  const href = browserUrl(targetLocation, basename)

  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    const opensCurrentPage = !target || target === "_self"
    const plainPrimaryClick = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
    if (event.defaultPrevented || !opensCurrentPage || !plainPrimaryClick) return
    event.preventDefault()
    navigate(to)
  }

  return <a {...props} ref={ref} href={href} target={target} onClick={handleClick} />
})

Link.displayName = "Link"
