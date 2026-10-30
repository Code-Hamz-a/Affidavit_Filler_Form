// Startup file for cPanel "Setup Node.js App" (Passenger), which loads the app with require().
// The server itself is an ES module, so load it with import().
import('./src/server.js').catch(err => { console.error(err); process.exit(1); });
