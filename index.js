const { connect } = require('./db');
const config = require('./config');

async function main() {
  const { client, db } = await connect();

  try {
    await db.admin().command({ ping: 1 });
    console.log('Connected to MongoDB Atlas!');

    for (const name of Object.values(config.collections)) {
      const count = await db.collection(name).countDocuments();
      console.log(`${db.databaseName}.${name} has ${count} MDB doc(s)`);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Connection failed:', err.message);
  process.exit(1);
});
