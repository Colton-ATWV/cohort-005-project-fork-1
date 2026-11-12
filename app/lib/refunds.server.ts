import { and, desc, eq, isNull, notExists, sql } from "drizzle-orm";
import { data } from "react-router";
import { db } from "~/db";
import {
  coupons,
  enrollments,
  purchases,
  refunds,
  refundPaymentEvents,
  users,
  RefundStatus,
  RefundPaymentStatus,
  UserRole,
} from "~/db/schema";
import { requireUserId } from "~/lib/access.server";

export class RefundWorkflowError extends Error {
  constructor(
    message: string,
    public status = 409
  ) {
    super(message);
  }
}

export function canReviewRefunds(role: UserRole) {
  return role === UserRole.Support || role === UserRole.Admin;
}

export async function requireSupport(request: Request) {
  const userId = await requireUserId(request);
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || !canReviewRefunds(user.role)) {
    throw data(
      "Only support team members and administrators can review refunds.",
      { status: 403 }
    );
  }
  return user;
}

export function purchaseHasIssuedRefund(purchaseId: number, database = db) {
  return !!database
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.paymentStatus, RefundPaymentStatus.Issued)
      )
    )
    .get();
}

export function createRefundRequest(
  purchaseId: number,
  reason: string,
  database = db
) {
  return database.transaction(
    (tx) => {
      const blocked = tx
        .select()
        .from(refunds)
        .where(
          and(
            eq(refunds.purchaseId, purchaseId),
            sql`${refunds.status} in ('open', 'approved')`
          )
        )
        .get();
      if (blocked)
        throw new RefundWorkflowError(
          "This purchase already has an open or approved refund request."
        );
      return tx
        .insert(refunds)
        .values({ purchaseId, reason })
        .returning()
        .get();
    },
    { behavior: "immediate" }
  );
}

export function decideRefund(
  refundId: number,
  actorUserId: number,
  decision: RefundStatus.Approved | RefundStatus.Declined,
  explanation: string,
  database = db
) {
  explanation = explanation.trim();
  if (!explanation || explanation.length > 2000)
    throw new RefundWorkflowError(
      "Enter an explanation of 1–2000 characters.",
      400
    );
  return database.transaction(
    (tx) => {
      const actor = tx
        .select()
        .from(users)
        .where(eq(users.id, actorUserId))
        .get();
      if (!actor || !canReviewRefunds(actor.role))
        throw new RefundWorkflowError("Support access required.", 403);
      const request = tx
        .select()
        .from(refunds)
        .where(eq(refunds.id, refundId))
        .get();
      if (!request)
        throw new RefundWorkflowError("Refund request not found.", 404);
      if (request.status !== RefundStatus.Open)
        throw new RefundWorkflowError(
          "Another reviewer has already decided this request. The saved decision is shown below."
        );
      const purchase = tx
        .select()
        .from(purchases)
        .where(eq(purchases.id, request.purchaseId))
        .get()!;
      const approved = decision === RefundStatus.Approved;
      tx.update(refunds)
        .set({
          status: decision,
          decisionExplanation: explanation,
          resolvedByUserId: actorUserId,
          resolvedAt: new Date().toISOString(),
          amountRefunded: approved ? purchase.amountPaid : null,
          paymentStatus: approved ? RefundPaymentStatus.Pending : null,
        })
        .where(
          and(eq(refunds.id, refundId), eq(refunds.status, RefundStatus.Open))
        )
        .run();
      if (approved)
        tx.insert(refundPaymentEvents)
          .values({
            refundId,
            actorUserId,
            status: RefundPaymentStatus.Pending,
            note: "Refund approved; awaiting external payment.",
          })
          .run();
    },
    { behavior: "immediate" }
  );
}

export function recordRefundPayment(
  refundId: number,
  actorUserId: number,
  status: RefundPaymentStatus,
  note: string,
  expectedEventId: number,
  database = db
) {
  note = note.trim();
  if (status !== RefundPaymentStatus.Pending && (!note || note.length > 2000)) {
    throw new RefundWorkflowError(
      "Enter a payment reference for issuance or an explanation for failure (1–2000 characters).",
      400
    );
  }
  return database.transaction(
    (tx) => {
      const actor = tx
        .select()
        .from(users)
        .where(eq(users.id, actorUserId))
        .get();
      if (!actor || !canReviewRefunds(actor.role))
        throw new RefundWorkflowError("Support access required.", 403);
      const request = tx
        .select()
        .from(refunds)
        .where(eq(refunds.id, refundId))
        .get();
      if (!request)
        throw new RefundWorkflowError("Refund request not found.", 404);
      const latestEvent = tx
        .select()
        .from(refundPaymentEvents)
        .where(eq(refundPaymentEvents.refundId, refundId))
        .orderBy(desc(refundPaymentEvents.id))
        .get();
      if ((latestEvent?.id ?? 0) !== expectedEventId)
        throw new RefundWorkflowError(
          "Payment status has changed. Review the latest history before continuing."
        );
      const valid =
        request.status === RefundStatus.Approved &&
        ((request.paymentStatus === RefundPaymentStatus.Pending &&
          (status === RefundPaymentStatus.Issued ||
            status === RefundPaymentStatus.Failed)) ||
          (request.paymentStatus === RefundPaymentStatus.Failed &&
            status === RefundPaymentStatus.Pending));
      if (!valid)
        throw new RefundWorkflowError(
          "That payment transition is no longer available."
        );
      const now = new Date().toISOString();
      tx.update(refunds)
        .set({ paymentStatus: status })
        .where(eq(refunds.id, refundId))
        .run();
      tx.insert(refundPaymentEvents)
        .values({
          refundId,
          actorUserId,
          status,
          note:
            status === RefundPaymentStatus.Pending
              ? "Retry started; awaiting external payment."
              : note,
          createdAt: now,
        })
        .run();
      if (status !== RefundPaymentStatus.Issued) return;
      const purchase = tx
        .select()
        .from(purchases)
        .where(eq(purchases.id, request.purchaseId))
        .get()!;
      const seats = tx
        .select()
        .from(coupons)
        .where(eq(coupons.purchaseId, purchase.id))
        .all();
      const affectedUsers = new Set([
        ...(seats.length ? [] : [purchase.userId]),
        ...seats.flatMap((s) =>
          s.redeemedByUserId === null ? [] : [s.redeemedByUserId]
        ),
      ]);
      for (const userId of affectedUsers) {
        // Team purchases grant access through redeemed seats, never to the buyer directly.
        const ownPurchase = tx
          .select({ id: purchases.id })
          .from(purchases)
          .where(
            and(
              eq(purchases.userId, userId),
              eq(purchases.courseId, purchase.courseId),
              notExists(
                tx
                  .select({ id: coupons.id })
                  .from(coupons)
                  .where(eq(coupons.purchaseId, purchases.id))
              ),
              notExists(
                tx
                  .select({ id: refunds.id })
                  .from(refunds)
                  .where(
                    and(
                      eq(refunds.purchaseId, purchases.id),
                      eq(refunds.paymentStatus, RefundPaymentStatus.Issued)
                    )
                  )
              )
            )
          )
          .get();
        const seat = tx
          .select({ id: coupons.id })
          .from(coupons)
          .where(
            and(
              eq(coupons.redeemedByUserId, userId),
              eq(coupons.courseId, purchase.courseId),
              notExists(
                tx
                  .select({ id: refunds.id })
                  .from(refunds)
                  .where(
                    and(
                      eq(refunds.purchaseId, coupons.purchaseId),
                      eq(refunds.paymentStatus, RefundPaymentStatus.Issued)
                    )
                  )
              )
            )
          )
          .get();
        if (!ownPurchase && !seat)
          tx.update(enrollments)
            .set({ accessRevokedAt: now })
            .where(
              and(
                eq(enrollments.userId, userId),
                eq(enrollments.courseId, purchase.courseId),
                isNull(enrollments.accessRevokedAt)
              )
            )
            .run();
      }
    },
    { behavior: "immediate" }
  );
}
