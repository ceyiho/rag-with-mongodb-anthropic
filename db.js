const { MongoClient } = require('mongodb');

const { MONGODB_URI, DB_NAME } = process.env;

if (!MONGODB_URI || MONGODB_URI.startsWith('paste-')) {
  console.error('Missing MONGODB_URI - add your Atlas connection string to .env');
  process.exit(1);
}
if (!DB_NAME) {
  console.error('Missing DB_NAME - add it to .env (see .env.example)');
  process.exit(1);
}

// Opens a connection and returns the client (to close it later) and the database.
async function connect() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  return { client, db: client.db(DB_NAME) };
}

module.exports = { connect };
