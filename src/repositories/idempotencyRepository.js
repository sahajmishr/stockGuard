const pool = require('../config/db');

const checkIdempotencyRecord = async ({ owner_id, operation, idempotencykey }, client = pool) => {
  const {rows}  = await client.query(
    `SELECT request_hash, response_code, response_body
       FROM idempotency_keys
      WHERE actor_id = $1 AND operation = $2 AND idempotency_key = $3`,
    [owner_id, operation, idempotencykey],
  );
  return rows[0] ?? null;
};

const createIdempotencyErrorRow =  async({actorId , operation , idempotencyKey , currentHash , errorResponseStatus , errorResponseBody} , client = pool)=>{
    await client.query(
        `INSERT INTO idempotency_keys (actor_id, operation, idempotency_key, request_hash, response_code, response_body)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [actorId, operation, idempotencyKey, currentHash, errorResponseStatus, errorResponseBody]
      );

}

const createIdempotencySuccessRow =  async({actorId , operation , idempotencyKey , currentHash , successResponseStatus , successResponseBody} , client = pool)=>{
    await client.query(
        `INSERT INTO idempotency_keys (actor_id, operation, idempotency_key, request_hash, response_code, response_body)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [actorId, operation, idempotencyKey, currentHash, successResponseStatus, successResponseBody]
      );

}




module.exports ={checkIdempotencyRecord , createIdempotencyErrorRow , createIdempotencySuccessRow};