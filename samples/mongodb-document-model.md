# The MongoDB Document Model

An introduction for developers who know relational databases (RDBMS) and want to understand how MongoDB stores data, how to design a schema for it, and where it has an advantage over tables and joins.

## Documents, collections and BSON

MongoDB stores data as documents: records made of field-and-value pairs, much like JSON objects. A value can be a string, a number, a date, a boolean, an array, or another document nested inside the first one. Documents are grouped into collections, which play roughly the role of tables, and collections are grouped into databases.

On disk and over the network, documents are encoded as BSON (Binary JSON). BSON adds types that plain JSON lacks, such as dates, 64-bit integers, Decimal128 for exact money values, binary data, and ObjectId. Every document has an `_id` field that is unique within its collection. If you don't supply one, the driver generates an ObjectId: a 12-byte value that includes a timestamp, so ObjectIds created later sort after earlier ones.

A single document can be at most 16 MB, and nested documents can go at most 100 levels deep. These limits are rarely reached by well-designed schemas; a document that approaches 16 MB is usually a sign that an array is growing without bound (see Anti-patterns). Larger files, such as videos, can be split into pieces with GridFS.

Example of an order stored as one document:

```json
{
  "_id": { "$oid": "665f1c2e9b1e8a3d4c5b6a70" },
  "customer": { "name": "Ada Park", "email": "ada@example.com" },
  "status": "shipped",
  "items": [
    { "sku": "KB-104", "name": "Keyboard", "qty": 1, "price": 49.00 },
    { "sku": "MS-220", "name": "Mouse", "qty": 2, "price": 19.50 }
  ],
  "orderedAt": { "$date": "2026-03-14T09:30:00Z" }
}
```

In a relational database the same order would usually span three tables (orders, order_items, customers) and need joins to read back.

## Advantages over relational databases

### Data that is read together is stored together

The main rule of document design is: data that is accessed together should be stored together. Reading the order above takes one lookup by `_id`, with no joins. In a normalized relational schema, the application issues a query that joins several tables, and the database has to find and combine rows that may sit in different places on disk. For read-heavy workloads with a clear access pattern, one document per read is simpler and usually faster.

### Documents map to objects in code

A document looks like the object your application already works with. There is no object-relational mapping layer to translate between rows and nested objects, and no need to reassemble an object from several result sets. This removes a whole category of code and bugs.

### Flexible schema

Documents in the same collection don't need identical fields. You can add a field to new documents without a migration that locks or rewrites a large table, and different kinds of product can carry different attributes in one collection. Flexible doesn't mean unvalidated: a collection can enforce rules with JSON Schema validation (the `$jsonSchema` operator), such as required fields, types and allowed values.

### Horizontal scaling

MongoDB scales out by sharding: a collection is split across several servers by a shard key, and queries that include the shard key go only to the shard that holds the data. Because related data sits in one document, most operations touch one shard. Scaling a relational database across servers is possible but harder, because joins and foreign keys assume the rows live together.

### High availability

A replica set keeps copies of the data on several servers, typically three. One member is the primary and accepts writes; the others replicate from it. If the primary fails, the remaining members elect a new primary automatically, usually within seconds, and the drivers reconnect to it without application changes.

## Modeling relationships: embed or reference

Every relationship is either embedded (the related data is nested inside the document) or referenced (the document stores the `_id` of a document in another collection, like a foreign key).

Embed when:
- the related data is read together with the parent most of the time;
- it belongs to the parent and has no life of its own (an order's line items, a person's addresses);
- the number of related items is small and bounded.

Reference when:
- the related data is large or often read on its own;
- many parents share it (many orders refer to the same product);
- the number of related items can grow without limit (a user's activity log).

A common middle ground is the extended reference pattern: store the `_id` plus the few fields you display most often, such as a product's name and price, and fetch the full document only when needed. The cost is that the copied fields must be updated in both places if they change.

When a query does need data from another collection, the aggregation stage `$lookup` performs a left outer join. It works, but if every read needs a `$lookup`, the data probably should have been embedded.

## Schema design patterns

- Bucket pattern: group many small items into one document per time window, such as one document per sensor per hour holding an array of readings. Fewer, larger documents mean smaller indexes and faster range queries. Time series collections apply this automatically.
- Computed pattern: store a value that is expensive to calculate, such as a product's average rating, and update it on write instead of calculating it on every read.
- Subset pattern: keep the most-used part of a large list in the main document (the ten most recent reviews) and the rest in a separate collection.
- Attribute pattern: turn many optional fields into an array of key-value pairs (`[{ k: "color", v: "red" }]`) so that one index covers all of them.
- Outlier pattern: handle the rare document that would break the design (a celebrity with millions of followers) with an overflow document and a flag, instead of designing everything around the exception.
- Schema versioning pattern: add a `schemaVersion` field so old and new shapes can live side by side while the application migrates documents gradually.

## Transactions and consistency

A write to a single document is always atomic, including all of its nested fields and arrays. Because related data is usually embedded, most operations need nothing more. For the cases that do span several documents, MongoDB supports multi-document ACID transactions: on replica sets since version 4.0 and on sharded clusters since version 4.2. Transactions have a performance cost and a default time limit of 60 seconds, so the recommended approach is to model data so that transactions are the exception, not the rule.

Write concern controls how many replica set members must confirm a write before it counts as successful (`w: "majority"` is the default in recent versions). Read concern controls how up to date and durable the data returned by a read must be.

## Indexes

Without an index, a query scans every document in the collection. MongoDB supports single-field, compound, multikey (one index entry per array element, created automatically when the field holds an array), text, geospatial, hashed, wildcard and TTL indexes. A TTL index deletes documents automatically after a set time, which suits sessions and logs. A partial index covers only documents that match a filter, and a unique partial index enforces uniqueness among those documents only.

For compound indexes, follow the ESR guideline: put fields tested for Equality first, then fields used for Sorting, then fields used in Range filters. Use `explain("executionStats")` to check whether a query used an index (IXSCAN) or scanned the collection (COLLSCAN).

## Anti-patterns

- Unbounded arrays: an array that grows forever (every comment ever posted, every login) makes the document keep growing toward the 16 MB limit and slows down every read of it. Use referencing or the bucket pattern.
- Treating MongoDB like a relational database: splitting every entity into its own collection and joining with `$lookup` on every read gives you the costs of both models and the benefits of neither.
- Too many collections: thousands of collections, each with its own indexes, waste memory. Prefer fewer collections with a field that distinguishes the kinds.
- Unnecessary indexes: every index slows down writes and uses memory. Remove indexes that no query uses; the `$indexStats` stage shows how often each one is used.
- Case-insensitive queries without a collation index: a regular expression with the `i` flag can't use an index efficiently. Create an index with a case-insensitive collation instead.

## When a relational database fits better

Relational databases remain a strong choice when the data is highly interconnected and queried in many unpredictable ways, when most operations need to update many entities at once in transactions, or when a team relies on existing SQL tooling and reporting. Document databases shine when access patterns are known, objects are naturally hierarchical, the schema evolves quickly, or the data must scale across many servers.
