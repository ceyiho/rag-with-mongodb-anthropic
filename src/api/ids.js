// Upload ids in the API are 24-character hex strings (an upload's _id). The vector index
// filter needs real ObjectIds (a string would silently match nothing), so routes
// convert them here, and a malformed id is a 400 instead of a confusing "not found".

const { ObjectId } = require('mongodb');
const { ApiError } = require('./errors');

const HEX_ID = /^[0-9a-f]{24}$/i;

function toObjectId(id) {
  // Checked by pattern: ObjectId.isValid would also accept any 12-character string.
  if (typeof id !== 'string' || !HEX_ID.test(id)) {
    throw new ApiError(400, 'invalidId', `"${id}" is not a valid upload id.`);
  }
  return new ObjectId(id);
}

module.exports = { toObjectId };
