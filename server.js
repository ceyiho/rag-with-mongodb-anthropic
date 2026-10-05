// Starts the API server (milestone 7): connects to Atlas once, mounts the routes in
// src/api/, and serves the web page from public/ (milestone 8), so page and API share
// one address. Routes and formats are in API_SPEC.md.
// Usage: npm start, or npm run dev to restart whenever a file changes.
// Listens on 127.0.0.1 (this computer only) unless HOST is set in .env; PORT
// defaults to 3000.

const path = require('path');
const express = require('express');
const { connect } = require('./src/db');
const health = require('./src/api/health');
const uploads = require('./src/api/uploads');
const { routeNotFound, handleErrors } = require('./src/api/errors');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;

async function main() {
  // One connection for the whole server, shared by every request. Without the
  // database the server is no use, so it doesn't start; a connection lost later is
  // reported by GET /api/health instead.
  let client, db;
  try {
    ({ client, db } = await connect());
  } catch (err) {
    console.error(`Can't connect to Atlas: ${err.message}`);
    console.error('If your IP address has changed, add it in Atlas Network Access.');
    process.exit(1);
  }

  // Every request passes through these in order (middleware), until one replies.
  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/api', health(db));
  app.use('/api', uploads(db));
  app.use('/api', routeNotFound);   // no route above matched
  app.use(handleErrors);            // turns thrown errors into { error: { code, message } }

  const server = app.listen(PORT, HOST, (err) => {
    if (err) {
      console.error(`Can't listen on ${HOST}:${PORT}: ${err.message}`);
      process.exit(1);
    }
    console.log(`API server on http://${HOST}:${PORT}`);
  });

  // Ctrl+C (SIGINT) or SIGTERM: stop taking requests, then close the database
  // connection so the process can exit. The message shows the stop was clean.
  // On Windows, npm run dev's watcher ends the server with a hard kill instead (on
  // Ctrl+C and on each restart), so this doesn't run and no message shows. That's
  // harmless: Windows closes the connections, and Atlas drops them.
  const stop = async () => {
    server.close();
    await client.close();
    console.log('Server stopped.');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
