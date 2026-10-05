// Lists the app's search indexes (src/indexes.js) and their status.
// Atlas builds search indexes in the background; an index can be used once it is queryable.

const { connect } = require('../src/db');
const { searchIndexStatus } = require('../src/indexes');

async function main() {
  const { client, db } = await connect();

  try {
    console.log(`${db.databaseName} search indexes:`);
    for (const { index, exists, status, queryable } of await searchIndexStatus(db)) {
      const where = `${index.collection}.${index.name} (${index.type})`;
      console.log(exists
        ? `  ${where}: status ${status}, queryable: ${queryable}`
        : `  ${where}: missing. Run "npm run setup".`);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Index status failed:', err.message);
  process.exit(1);
});
