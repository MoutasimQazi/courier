/**
 * Passenger startup shim.
 *
 * cPanel's Node.js selector defaults its "Application startup file" to app.js
 * in the application root, and that lookup was landing on the browser bundle
 * that used to live at public/app.js. Node forbids network imports, so the
 * Firebase CDN import at the top of it killed the process at boot with
 * ERR_NETWORK_IMPORT_DISALLOWED before Express ever started.
 *
 * The browser bundle is now public/client.js, so no file named app.js carries
 * a network import. This shim keeps "app.js" pointing at the real entry point,
 * src/server.js (also declared as "main" in package.json).
 */

import "./src/server.js";
