// Lists the search indexes on the chunks collection and their status.
// Atlas builds search indexes in the background; an index can be used once it is queryable.

const { connect } = require('../src/db');
const config = require('../src/config');

async function main() {
  const { client, db } = await connect();

  try {
    const chunks = db.collection(config.collections.chunks);
    const indexes = await chunks.listSearchIndexes().toArray();

    if (indexes.length === 0) {
      console.log(`No search indexes on ${db.databaseName}.${chunks.collectionName}. Run "npm run setup".`);
      return;
    }

    console.log(`${db.databaseName}.${chunks.collectionName} search indexes:`);
    for (const index of indexes) {
      console.log(`  ${index.name} (${index.type}): status ${index.status}, queryable: ${index.queryable}`);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Index status failed:', err.message);
  process.exit(1);
});
