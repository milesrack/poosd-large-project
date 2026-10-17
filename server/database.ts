import type { Db } from "mongodb";

export async function prepareDatabase(db: Db) {
  if (
    await db.listCollections({ name: "sessions" }, { nameOnly: true }).hasNext()
  ) {
    await db.collection("sessions").rename("runs");
  }

  await Promise.all([
    db.collection("runs").createIndex({ id: 1 }, { unique: true }),
    db.collection("runs").createIndex({ ownerId: 1, startedAt: -1 }),
    db.collection("preferences").createIndex({ ownerId: 1 }, { unique: true }),
    db.collection("weightProfiles").createIndex({ id: 1 }, { unique: true }),
    db.collection("weightProfiles").createIndex({ ownerId: 1 }),
    db.collection("user").createIndex({ email: 1 }, { unique: true }),
    db.collection("session").createIndex({ token: 1 }, { unique: true }),
    db
      .collection("session")
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
}
