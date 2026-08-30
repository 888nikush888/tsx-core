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
  if (!GTM_ID) return;

  if (!IS_PRODUCTION) return;

  // Initialize dataLayer
  window.dataLayer = window.dataLayer || [];

  // GTM script injection
  const gtmScript = document.createElement("script");
  gtmScript.innerHTML = `
    (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
    new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
    j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
    'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
    })(window,document,'script','dataLayer','${GTM_ID}');
  `;
  document.head.appendChild(gtmScript);

  // GTM noscript fallback
  const noscript = document.createElement("noscript");
  noscript.innerHTML = `
    <iframe src="https://www.googletagmanager.com/ns.html?id=${GTM_ID}"
    height="0" width="0" style="display:none;visibility:hidden"></iframe>
  `;
  document.body.insertBefore(noscript, document.body.firstChild);

};
