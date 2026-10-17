import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";
import { accessVerifier } from "../server/access.ts";

const sid = "123456789012345678901234";
const uid = "abcdefabcdefabcdefabcdef";

test("JWT identity requires a valid signature and an active matching MongoDB session", async () => {
  let active = true;
  const auth = {
    api: {
      verifyJWT: async ({ body }: { body: { token: string } }) => {
        assert.equal(body.token, "signed.jwt.token");

        return { payload: { sid, sub: uid } };
      },
    },
  };
  const db = {
    collection: (name: string) => ({
      findOne: async (query: {
        emailVerified?: boolean;
        _id: ObjectId;
        expiresAt: { $gt: Date };
      }) => {
        if (name === "user") {
          assert.equal(query.emailVerified, true);

          return active ? {} : null;
        }

        assert.equal(query._id.toHexString(), sid);
        assert.ok(query.expiresAt.$gt instanceof Date);

        return active ? { userId: new ObjectId(uid) } : null;
      },
    }),
  };
  const verify = accessVerifier(
    auth,
    db as unknown as Parameters<typeof accessVerifier>[1],
  );
  const request = { headers: { authorization: "Bearer signed.jwt.token" } };

  assert.deepEqual(await verify(request), {
    session: { id: sid },
    user: { id: uid },
  });

  active = false;
  assert.equal(await verify(request), null);
});

test("forged, missing, malformed and revoked JWTs do not authenticate", async () => {
  const verify = accessVerifier(
    {
      api: {
        verifyJWT: async () => {
          throw Error("Signature invalid");
        },
      },
    },
    {} as unknown as Parameters<typeof accessVerifier>[1],
  );

  for (const headers of [
    {},
    { cookie: "zetafly_access=%broken" },
    { authorization: "Bearer forged.jwt.token" },
    { cookie: `zetafly_access=${"x".repeat(5000)}` },
  ]) {
    assert.equal(await verify({ headers }), null);
  }
});
