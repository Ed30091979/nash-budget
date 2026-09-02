/**
 * Account deletion — 6.8.
 *
 * "Удаление аккаунта убирает строку `account`, все его устройства, членства и, если это был
 * последний участник семьи, саму семью со всеми конвертами и приглашениями." Four properties carry
 * the whole of this route, and each of them is a decision that could be made wrongly in a way no
 * test would notice by itself:
 *
 *  - **the server decides.** Whether this was the family's last live member is counted here, from
 *    the `member` table, in the same transaction that acts on the answer. It is not asked of the
 *    caller, not inferred from what the caller sent, and not read from anything the caller can
 *    write. The same holds for which devices and which memberships are "this account's": every one
 *    of them is selected by `account_id`, which comes from the token the server signed. A body
 *    listing what to delete would be the party bound by a limit supplying its measurement.
 *
 *  - **a fresh sign-in, not a live token** (see `ServerContext.requireFreshAuth`). This is the one
 *    act in the whole API that destroys data belonging to people who are not the caller — the
 *    family's envelopes go with the family — and it is the one act that cannot be undone by
 *    anything the server offers afterwards.
 *
 *  - **one transaction.** A half-deleted account is worse than an undeleted one: it leaves
 *    memberships pointing at nothing, wraps addressed to devices that no longer exist and a family
 *    with no live member and no route that would ever notice. `better-sqlite3` is synchronous and
 *    the handler contains no `await`, so the transaction below is also the answer to every race —
 *    a rotation being declared, an invite arriving, the second member leaving at the same moment.
 *    Each of those either completed before this transaction opened, and is counted, or begins after
 *    it committed, and finds the account gone.
 *
 *  - **the same answer to "no such account" and "not your account".** The identifier in the URL is
 *    compared with the token's and nothing else; every other value gets `404` in the same words,
 *    whether or not that account exists. Deletion is exactly the request an enumerator would like
 *    to use as an oracle.
 *
 * One consequence is named rather than hidden. The owner may delete their account while other
 * members remain — 6.8 grants the right unconditionally, and `families.ts` sends the owner here
 * because 6.6 refuses them the `leave` route. Handing the role to somebody else is outside this
 * plan (section 1), so the family that survives has no live owner: it keeps its journal and its
 * key, and no one can issue an invite or declare a rotation in it any more. Refusing the deletion
 * instead would mean an owner could never exercise the right the privacy policy promises, which is
 * the worse of the two, and the state is visible — `GET /v1/families/me` answers with an
 * `ownerMemberId` that matches no member.
 *
 * What this route does *not* do is touch the device it is called from. 6.8: "Локальные данные на
 * устройстве при этом не трогаются — их удаляет отдельная существующая команда". A server that
 * could order a client to erase a budget would be a server worth attacking for that alone.
 */
import type { FastifyInstance } from "fastify";

import type { ServerContext } from "../context.ts";
import { notFound } from "../errors.ts";
import { body, uuidField } from "./fields.ts";

interface AccountRow {
  readonly account_id: string;
  readonly email: string;
}

export interface AccountDeletion {
  readonly deletedAt: number;
  readonly devices: number;
  readonly memberships: number;
  /** The families that had no live member left once this account's memberships were removed. */
  readonly deletedFamilyIds: readonly string[];
  /** A family survived this deletion, so 6.6's mandatory rotation applies to it. */
  readonly rotationRequired: boolean;
}

/**
 * Everything 6.8 removes, in one transaction, named table by table.
 *
 * Exported because the tests count rows against it and because the order below is not arbitrary:
 * children before parents, so that the result does not depend on which of these tables happens to
 * carry a declared foreign key. Three of them carry none at all — `key_wrap`, `epoch_confirm` and
 * `throttle` — and a cascade would leave their rows behind for ever.
 */
export function deleteAccount(context: ServerContext, accountId: string): AccountDeletion {
  const now = context.now();
  const run = context.db.transaction((): AccountDeletion => {
    const account = context.db
      .prepare("SELECT account_id, email FROM account WHERE account_id = ?")
      .get(accountId) as AccountRow | undefined;
    // Reachable only through a device row whose foreign key names this account, so an absent row
    // is not a case a caller can produce. It is still not an error: the end state this function
    // promises is "no such account", and that state is already true.
    if (account === undefined) {
      return { deletedAt: now, devices: 0, memberships: 0, deletedFamilyIds: [], rotationRequired: false };
    }

    const devices = context.db
      .prepare("SELECT device_id FROM device WHERE account_id = ?")
      .all(accountId) as { device_id: string }[];
    // Every membership, live or ended. 6.8 says "все его членства", and a row left behind by an
    // earlier departure is still a record that this person was in that family.
    const memberships = context.db
      .prepare("SELECT member_id, family_id, role, removed_at FROM member WHERE account_id = ?")
      .all(accountId) as {
      member_id: string;
      family_id: string;
      role: string;
      removed_at: number | null;
    }[];
    const familyIds = [...new Set(memberships.map((row) => row.family_id))];

    const deletedFamilyIds: string[] = [];
    let survivingFamily = false;
    for (const familyId of familyIds) {
      // The decision of 6.8, computed by the server from its own table: is anybody else still a
      // live member of this family? Not "did the caller say they were alone", and not "how many
      // members did the caller's last list request show" — both of those are the measurement being
      // taken by the party it binds. The count runs inside the transaction, so a member who joined
      // a moment ago is either already committed and counted, or arrives to find no family.
      const others = context.db
        .prepare(
          "SELECT COUNT(*) AS n FROM member WHERE family_id = ? AND removed_at IS NULL" +
            " AND account_id <> ?",
        )
        .get(familyId, accountId) as { n: number };
      if (others.n > 0) {
        survivingFamily = true;
        continue;
      }
      deletedFamilyIds.push(familyId);
      // 5.5 keeps `key_wrap` and `epoch_confirm` alive past the epoch they belong to, so neither
      // has a foreign key to `epoch` and neither would be reached by a cascade from `family`. They
      // are deleted first and by family, which also covers the epochs a cancelled rotation left.
      context.db.prepare("DELETE FROM key_wrap WHERE family_id = ?").run(familyId);
      context.db.prepare("DELETE FROM epoch_confirm WHERE family_id = ?").run(familyId);
      context.db.prepare("DELETE FROM envelope WHERE family_id = ?").run(familyId);
      context.db.prepare("DELETE FROM invite WHERE family_id = ?").run(familyId);
      context.db.prepare("DELETE FROM epoch WHERE family_id = ?").run(familyId);
      context.db.prepare("DELETE FROM member WHERE family_id = ?").run(familyId);
      context.db.prepare("DELETE FROM family WHERE family_id = ?").run(familyId);
      // The family's invite-creation window (5.3). The bucket names an identifier that will never
      // exist again, so nothing is being reset — the row is simply left over.
      context.throttleClear(`invite-create:family:${familyId}`);
    }

    for (const device of devices) {
      // A staging rotation led by a device that is about to stop existing can never be finished,
      // and while it stands the whole family is refused writes (3.3 step 2) until the idle sweep
      // reaches it half an hour later. Cancelling it here is the same act 5.5 gives the owner, on
      // the same grounds: an attempt stuck on a device nobody has must not hold the family. If the
      // family was deleted above there is nothing left to cancel, and this finds nothing.
      const staging = context.db
        .prepare("SELECT family_id, key_epoch FROM epoch WHERE state = 'staging' AND rotating_device_id = ?")
        .get(device.device_id) as { family_id: string; key_epoch: number } | undefined;
      if (staging !== undefined) context.cancelRotation(staging.family_id, staging.key_epoch);
      // Wraps addressed *to* this device, in every family it was ever wrapped for. Wraps it
      // *sent* are deliberately untouched: those are the copies of the family key that the
      // remaining devices read with `GET /keys`, and deleting them would take the family key away
      // from people whose account was not the one deleted.
      context.db.prepare("DELETE FROM key_wrap WHERE device_id = ?").run(device.device_id);
      // The submission window of this device (3.2). Same reasoning as the family bucket above.
      context.throttleClear(`envelopes:${device.device_id}`);
      // An invite of a surviving family may record this device as the one that used it. The row is
      // the family's history and stays; the reference to a device that no longer exists does not.
      context.db
        .prepare("UPDATE invite SET used_by_device_id = NULL WHERE used_by_device_id = ?")
        .run(device.device_id);
    }

    // A live invite is a code that hands the family key to whoever holds it, and only the owner
    // issues one (5.3). If the owner's account is going and the family is not, no route left
    // behind could withdraw those codes — there is no owner to call it. So they go with the
    // account that issued them, on the same grounds 5.5 step 7 deletes them at a rotation. Used
    // invites stay: they are spent, they carry no ciphertext, and the devices of the remaining
    // members name them in `device.invite_id`.
    const ownedFamilyIds = memberships
      .filter((row) => row.role === "owner" && row.removed_at === null)
      .map((row) => row.family_id)
      .filter((familyId) => !deletedFamilyIds.includes(familyId));
    for (const familyId of ownedFamilyIds) {
      context.db
        .prepare("DELETE FROM invite WHERE family_id = ? AND used_at IS NULL")
        .run(familyId);
    }

    context.db.prepare("DELETE FROM device WHERE account_id = ?").run(accountId);
    context.db.prepare("DELETE FROM member WHERE account_id = ?").run(accountId);
    // The address itself, in the two places it is written outside the account row: the pending
    // one-time code of 6.1 and the per-address window that counts requests for one. Both are keyed
    // by the e-mail in the clear, so leaving them would leave the address on the server after the
    // row that justified holding it is gone. The per-source window is *not* cleared: it is keyed
    // by an address of the network, belongs to no account, and is the backstop that stops the
    // per-address limit from being multiplied by every address anyone cares to type.
    context.db.prepare("DELETE FROM login_code WHERE email = ?").run(account.email);
    context.throttleClear(`login-code:email:${account.email}`);
    // The invite-lookup failure counter of 5.3, keyed by an account that will not exist. Not a
    // limit being reset: a new sign-in mints a new `accountId`, so this bucket is unreachable
    // either way, and the counter that actually stands between a copied invite box and a 60-bit
    // code is the per-IP one, which is left exactly where it is.
    context.throttleClear(`invite-claim:account:${accountId}`);
    context.db.prepare("DELETE FROM account WHERE account_id = ?").run(accountId);

    return {
      deletedAt: now,
      devices: devices.length,
      memberships: memberships.length,
      deletedFamilyIds,
      rotationRequired: survivingFamily,
    };
  });
  return run();
}

export function registerAccountRoutes(app: FastifyInstance, context: ServerContext): void {
  app.delete(
    "/v1/accounts/:accountId",
    { schema: { params: body({ accountId: uuidField }, ["accountId"]) } },
    async (request) => {
      const auth = context.authenticate(request);
      const { accountId } = request.params as { accountId: string };
      // Addressed rather than "me", like every other route that names its object — and answered
      // identically for an account that exists and one that never did. There is no branch here in
      // which the server says anything about another account at all.
      if (accountId !== auth.accountId) throw notFound("no such account");
      context.requireFreshAuth(auth);

      const result = deleteAccount(context, accountId);
      return {
        accountId,
        deletedAt: result.deletedAt,
        devices: result.devices,
        memberships: result.memberships,
        // 6.8 names this outcome, so it is reported rather than left to be inferred from silence.
        familyDeleted: result.deletedFamilyIds.length > 0,
        // 6.6, unchanged by the door the caller left through: a family that survives has lost a
        // participant who keeps the family key in local storage, and the owner's device owes it a
        // rotation. The server cannot perform one and does not pretend to.
        rotationRequired: result.rotationRequired,
      };
    },
  );
}
