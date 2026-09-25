const { MongoClient } = require('mongodb');

const { MONGODB_URI, DB_NAME, COLLECTION_NAME } = process.env;

if (!MONGODB_URI || MONGODB_URI.startsWith('paste-')) {
  console.error('Missing MONGODB_URI - add your Atlas connection string to .env');
  process.exit(1);
}

async function main() {
  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    console.log('Connected to MongoDB Atlas!');

    const collection = client.db(DB_NAME).collection(COLLECTION_NAME);
    const count = await collection.countDocuments();
    console.log(`${DB_NAME}.${COLLECTION_NAME} has ${count} document(s)`);

    const sample = await collection.findOne();
    console.log('Sample document:', sample);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Connection failed:', err.message);
  process.exit(1);
});
