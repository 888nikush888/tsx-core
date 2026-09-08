/**
 * Analytics utility for Google Tag Manager integration
 * Uses environment variables to conditionally load GTM in production
 */

declare global {
  interface Window {
    dataLayer: unknown[];
  }
}

export const GTM_ID = import.meta.env.VITE_GTM_ID || "";
const IS_PRODUCTION = import.meta.env.PROD;

/**
 * Initialize Google Tag Manager
 * Only loads GTM if VITE_GTM_ID environment variable is set AND in production mode
 */
export const initGTM = (): void => {
  if (!/^GTM-[A-Z0-9]+$/.test(GTM_ID)) return;

  if (!IS_PRODUCTION) return;

  // Initialize dataLayer
  window.dataLayer = window.dataLayer || [];

  // Keep the configured identifier out of executable JavaScript and HTML.
  const gtmScript = document.createElement("script");
  window.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
  gtmScript.async = true;
  const scriptUrl = new URL("https://www.googletagmanager.com/gtm.js");
  scriptUrl.searchParams.set("id", GTM_ID);
  gtmScript.src = scriptUrl.href;
  document.head.appendChild(gtmScript);

  // GTM noscript fallback
  const noscript = document.createElement("noscript");
  const iframe = document.createElement("iframe");
  const fallbackUrl = new URL("https://www.googletagmanager.com/ns.html");
  fallbackUrl.searchParams.set("id", GTM_ID);
  iframe.src = fallbackUrl.href;
  iframe.height = "0";
  iframe.width = "0";
  iframe.style.display = "none";
  iframe.style.visibility = "hidden";
  iframe.title = "Google Tag Manager";
  noscript.appendChild(iframe);
  document.body.insertBefore(noscript, document.body.firstChild);

};
