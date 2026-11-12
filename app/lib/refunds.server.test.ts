import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, isNull } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

const state = vi.hoisted(() => ({
  database: null as ReturnType<typeof createTestDb> | null,
  userId: null as number | null,
}));
vi.mock("~/db", () => ({
  db: new Proxy(
    {},
    {
      get(_target, property) {
        const value = Reflect.get(state.database!, property);
        return typeof value === "function" ? value.bind(state.database) : value;
      },
    }
  ),
}));
vi.mock("~/lib/session", () => ({
  getCurrentUserId: async () => state.userId,
}));
vi.mock("~/lib/country.server", () => ({ resolveCountry: async () => "US" }));
import {
  canReviewRefunds,
  createRefundRequest,
  decideRefund,
  recordRefundPayment,
  requireSupport,
} from "./refunds.server";
import { getAccess } from "./access.server";
import { loader as settingsLoader } from "~/routes/settings";
import { loader as queueLoader } from "~/routes/support.refunds";
import { action as reviewAction } from "~/routes/support.refunds.$refundId";
import { action as purchaseAction } from "~/routes/courses.$slug.purchase";

const {
  RefundStatus: Decision,
  RefundPaymentStatus: Payment,
  UserRole,
} = schema;
let database: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let support: typeof schema.users.$inferSelect;
let purchase: typeof schema.purchases.$inferSelect;
const request = () => new Request("http://localhost/support/refunds");
function latestEvent(id: number) {
  return database
    .select()
    .from(schema.refundPaymentEvents)
    .where(eq(schema.refundPaymentEvents.refundId, id))
    .all()
    .at(-1)!.id;
}
function pay(
  id: number,
  status: schema.RefundPaymentStatus,
  note = "External payment reference"
) {
  recordRefundPayment(id, support.id, status, note, latestEvent(id), database);
}
function approve() {
  const refund = createRefundRequest(
    purchase.id,
    "I need another course.",
    database
  );
  decideRefund(
    refund.id,
    support.id,
    Decision.Approved,
    "Full refund approved.",
    database
  );
  return refund;
}
beforeEach(() => {
  database = createTestDb();
  state.database = database;
  base = seedBaseData(database);
  support = database
    .insert(schema.users)
    .values({
      name: "Support",
      email: "support@example.com",
      role: UserRole.Support,
    })
    .returning()
    .get();
  purchase = database
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 7900,
    })
    .returning()
    .get();
  database
    .insert(schema.enrollments)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      completedAt: "2026-01-01",
    })
    .run();
  state.userId = base.user.id;
});

describe("refund workflow", () => {
  it("allows Support and Admin, while denying learner and instructor loaders and actions", async () => {
    for (const role of Object.values(UserRole))
      expect(canReviewRefunds(role)).toBe(
        role === UserRole.Admin || role === UserRole.Support
      );
    const refund = createRefundRequest(
      purchase.id,
      "Please refund this course.",
      database
    );
    for (const user of [base.user, base.instructor]) {
      state.userId = user.id;
      await expect(requireSupport(request())).rejects.toMatchObject({
        init: { status: 403 },
      });
      await expect(
        reviewAction({
          params: { refundId: String(refund.id) },
          request: new Request("http://localhost", {
            method: "POST",
            body: new URLSearchParams({
              intent: "decide",
              decision: "approved",
              explanation: "Approve",
            }),
          }),
        } as never)
      ).rejects.toMatchObject({ init: { status: 403 } });
      expect(() =>
        decideRefund(refund.id, user.id, Decision.Approved, "Approve", database)
      ).toThrow("Support access required");
    }
    state.userId = null;
    await expect(requireSupport(request())).rejects.toMatchObject({
      init: { status: 401 },
    });
    state.userId = support.id;
    expect((await requireSupport(request())).id).toBe(support.id);
    const admin = database
      .insert(schema.users)
      .values({
        name: "Admin",
        email: "admin@example.com",
        role: UserRole.Admin,
      })
      .returning()
      .get();
    state.userId = admin.id;
    expect((await requireSupport(request())).id).toBe(admin.id);
  });

  it("retains every decision and permits a fresh request only after a decline", () => {
    const first = createRefundRequest(
      purchase.id,
      "Initial explanation",
      database
    );
    expect(() =>
      createRefundRequest(purchase.id, "Duplicate request", database)
    ).toThrow("already has");
    expect(() =>
      decideRefund(first.id, support.id, Decision.Declined, "  ", database)
    ).toThrow("explanation");
    decideRefund(
      first.id,
      support.id,
      Decision.Declined,
      "Please provide more details.",
      database
    );
    const second = createRefundRequest(
      purchase.id,
      "Updated explanation with new circumstances",
      database
    );
    expect(() =>
      decideRefund(
        first.id,
        support.id,
        Decision.Approved,
        "A competing review",
        database
      )
    ).toThrow("already decided");
    decideRefund(
      second.id,
      support.id,
      Decision.Approved,
      "New circumstances accepted.",
      database
    );
    expect(() =>
      createRefundRequest(purchase.id, "Third request", database)
    ).toThrow("already has");
    const history = database.select().from(schema.refunds).all();
    expect(history.map((r) => r.status)).toEqual([
      Decision.Declined,
      Decision.Approved,
    ]);
    expect(history[0]).toMatchObject({
      resolvedByUserId: support.id,
      decisionExplanation: "Please provide more details.",
      amountRefunded: null,
      paymentStatus: null,
    });
    expect(history[0].resolvedAt).toBeTruthy();
    expect(history[1].amountRefunded).toBe(purchase.amountPaid);
  });

  it("continues access through approval, failure and retry; issuance revokes access while retaining learning data", async () => {
    const module = database
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "Module", position: 0 })
      .returning()
      .get();
    const lesson = database
      .insert(schema.lessons)
      .values({ moduleId: module.id, title: "Lesson", position: 0 })
      .returning()
      .get();
    database
      .insert(schema.lessonProgress)
      .values({
        userId: base.user.id,
        lessonId: lesson.id,
        status: schema.LessonProgressStatus.Completed,
      })
      .run();
    database
      .insert(schema.videoWatchEvents)
      .values({
        userId: base.user.id,
        lessonId: lesson.id,
        eventType: "pause",
        positionSeconds: 42,
      })
      .run();
    database
      .insert(schema.comments)
      .values({
        userId: base.user.id,
        lessonId: lesson.id,
        body: "Retain this contribution",
      })
      .run();
    database
      .insert(schema.courseRatings)
      .values({ userId: base.user.id, courseId: base.course.id, rating: 4 })
      .run();
    const refund = approve();
    expect((await getAccess(request(), base.course.id)).canViewContent).toBe(
      true
    );
    expect(() => pay(refund.id, Payment.Issued, " ")).toThrow(
      "payment reference"
    );
    const staleEventId = latestEvent(refund.id);
    pay(refund.id, Payment.Failed, "Bank rejected payment.");
    expect((await getAccess(request(), base.course.id)).canViewContent).toBe(
      true
    );
    pay(refund.id, Payment.Pending);
    expect(() =>
      recordRefundPayment(
        refund.id,
        support.id,
        Payment.Issued,
        "stale tab",
        staleEventId,
        database
      )
    ).toThrow("status has changed");
    pay(refund.id, Payment.Issued, "BANK-123");
    expect((await getAccess(request(), base.course.id)).canViewContent).toBe(
      false
    );
    expect(database.select().from(schema.enrollments).get()).toMatchObject({
      completedAt: "2026-01-01",
      accessRevokedAt: expect.any(String),
    });
    expect(database.select().from(schema.lessonProgress).all()).toHaveLength(1);
    expect(
      database.select().from(schema.videoWatchEvents).get()?.positionSeconds
    ).toBe(42);
    expect(database.select().from(schema.comments).all()).toHaveLength(1);
    expect(database.select().from(schema.courseRatings).all()).toHaveLength(1);
    expect(() => pay(refund.id, Payment.Failed)).toThrow("transition");
    expect(
      database
        .select()
        .from(schema.refundPaymentEvents)
        .all()
        .map((e) => e.status)
    ).toEqual([
      Payment.Pending,
      Payment.Failed,
      Payment.Pending,
      Payment.Issued,
    ]);
    // A repurchase restores course completion without duplicating lesson history.
    await expect(
      purchaseAction({
        params: { slug: base.course.slug },
        request: new Request("http://localhost", {
          method: "POST",
          body: new URLSearchParams({ intent: "confirm-purchase" }),
        }),
      } as never)
    ).rejects.toMatchObject({ status: 302 });
    expect((await getAccess(request(), base.course.id)).canViewContent).toBe(
      true
    );
    expect(
      database
        .select()
        .from(schema.enrollments)
        .where(isNull(schema.enrollments.accessRevokedAt))
        .get()?.completedAt
    ).toBe("2026-01-01");
    expect(database.select().from(schema.lessonProgress).all()).toHaveLength(1);
  });

  it("does not revoke access from another valid purchase when an old refund is issued", async () => {
    const refund = approve();
    database
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 9900,
      })
      .run();
    pay(refund.id, Payment.Issued);
    expect((await getAccess(request(), base.course.id)).canViewContent).toBe(
      true
    );
  });

  it("retains access through a separately purchased team seat", async () => {
    const refund = approve();
    const team = database.insert(schema.teams).values({}).returning().get();
    const teamPurchase = database
      .insert(schema.purchases)
      .values({
        userId: base.instructor.id,
        courseId: base.course.id,
        amountPaid: 9900,
      })
      .returning()
      .get();
    database
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        purchaseId: teamPurchase.id,
        code: "ANOTHER-PURCHASE",
        redeemedByUserId: base.user.id,
        redeemedAt: new Date().toISOString(),
      })
      .run();
    pay(refund.id, Payment.Issued);
    expect((await getAccess(request(), base.course.id)).canViewContent).toBe(
      true
    );
  });

  it("shows learner history without internal payment references and filters support follow-up", async () => {
    const refund = approve();
    pay(refund.id, Payment.Failed, "Internal bank details");
    const learnerView = await settingsLoader({ request: request() } as never);
    expect(learnerView.refundRequests).toHaveLength(1);
    expect(learnerView.refundRequests[0]).toMatchObject({
      status: Decision.Approved,
      paymentStatus: Payment.Failed,
      explanation: "Full refund approved.",
    });
    expect(JSON.stringify(learnerView)).not.toContain("Internal bank details");
    state.userId = support.id;
    expect(
      (await queueLoader({ request: request() } as never)).requests
    ).toHaveLength(1);
    pay(refund.id, Payment.Pending);
    pay(refund.id, Payment.Issued);
    expect(
      (await queueLoader({ request: request() } as never)).requests
    ).toHaveLength(0);
    expect(
      (
        await queueLoader({
          request: new Request(
            "http://localhost/support/refunds?decision=approved&payment=issued"
          ),
        } as never)
      ).requests
    ).toHaveLength(1);
  });
});
