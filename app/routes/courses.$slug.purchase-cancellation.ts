import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/courses.$slug.purchase-cancellation";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import {
  courses,
  coupons,
  lessons,
  modules,
  purchases,
  purchaseCancellationRequests,
  users,
  videoWatchEvents,
  PurchaseCancellationRequestStatus,
} from "~/db/schema";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { parseFormData, parseParams } from "~/lib/validation";
import { getDiscountForCountry } from "~/lib/ppp";
import { formatPrice } from "~/lib/utils";

const PURCHASE_CANCELLATION_WINDOW_DAYS = 14;
const MAX_WATCHED_HOURS = 2;

const purchaseCancellationParamsSchema = z.object({
  slug: z.string().min(1),
});

const purchaseCancellationActionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Tell us a little more about why you want to cancel.")
    .max(1000, "Please keep your reason under 1000 characters."),
});

function getCourseBySlug(slug: string) {
  return db.select().from(courses).where(eq(courses.slug, slug)).get();
}

function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

function getLessonIdsForCourse(courseId: number): number[] {
  const rows = db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all();

  return rows.map((row) => row.id);
}

function getPendingPurchaseCancellationRequest(purchaseId: number) {
  return db
    .select()
    .from(purchaseCancellationRequests)
    .where(
      and(
        eq(purchaseCancellationRequests.purchaseId, purchaseId),
        eq(
          purchaseCancellationRequests.status,
          PurchaseCancellationRequestStatus.Requested
        )
      )
    )
    .get();
}

// The fourteen-day window is counted in whole days, not hours — someone who
// buys at 23:00 should still get the whole of their fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function lastDayOfWindow(purchasedAtIso: string): string {
  const deadline = new Date(purchasedAtIso);
  deadline.setDate(deadline.getDate() + PURCHASE_CANCELLATION_WINDOW_DAYS);
  return calendarDay(deadline);
}

/**
 * The confirmation the learner gets in their inbox. There is no mail
 * transport wired up yet, so the built message goes to the server log.
 */
function buildPurchaseCancellationRequestEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
}) {
  return {
    to: input.learnerEmail,
    subject: `Purchase cancellation requested — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have your purchase cancellation request for "${input.courseTitle}".`,
      `The amount requested is ${formatPrice(input.amount)}. If approved, this amount will be returned to the card you paid with.`,
      "",
      "Your purchase cancellation request is awaiting review. Your purchase has not yet been cancelled. You do not need to do anything else — we will email you again with the decision.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in to cancel a purchase.", { status: 401 });
  }

  const { slug } = parseParams(params, purchaseCancellationParamsSchema);
  const course = getCourseBySlug(slug);

  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  const learner = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!learner) {
    throw data("User not found", { status: 404 });
  }

  const purchase = getLatestPurchase(currentUserId, course.id);

  if (!purchase) {
    throw data("You have not bought this course.", { status: 403 });
  }

  if (getPendingPurchaseCancellationRequest(purchase.id)) {
    throw data(
      "You already have a purchase cancellation request awaiting review for this purchase.",
      {
        status: 409,
      }
    );
  }

  // A seat that came out of a team licence, and has been claimed, belongs to
  // the team — the learner cannot hand it back on their own.
  const claimedSeat = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchase.id), isNotNull(coupons.redeemedAt))
    )
    .get();

  if (claimedSeat) {
    throw data("A claimed team seat cannot be cancelled.", { status: 403 });
  }

  const today = calendarDay(new Date());
  const withinPurchaseCancellationWindow =
    today <= lastDayOfWindow(purchase.createdAt);

  if (!withinPurchaseCancellationWindow) {
    throw data(
      `The ${PURCHASE_CANCELLATION_WINDOW_DAYS}-day window has closed.`,
      {
        status: 403,
      }
    );
  }

  const courseLessonIds = getLessonIdsForCourse(course.id);

  let watchedSeconds = 0;
  if (courseLessonIds.length > 0) {
    const furthestPerLesson = db
      .select({
        furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
      })
      .from(videoWatchEvents)
      .where(
        and(
          eq(videoWatchEvents.userId, currentUserId),
          inArray(videoWatchEvents.lessonId, courseLessonIds)
        )
      )
      .groupBy(videoWatchEvents.lessonId)
      .all();

    watchedSeconds = furthestPerLesson.reduce(
      (total, row) => total + row.furthest,
      0
    );
  }

  if (watchedSeconds >= MAX_WATCHED_HOURS * 60 * 60) {
    throw data("You have watched too much of this course to cancel it.", {
      status: 403,
    });
  }

  // A purchase made at a purchasing-power price is given back at that price,
  // not at the list price of the course.
  const pppDiscount = getDiscountForCountry(purchase.country);
  const refundableAmount = pppDiscount > 0 ? purchase.amountPaid : course.price;

  const formData = await request.formData();
  const parsed = parseFormData(formData, purchaseCancellationActionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  db.insert(purchaseCancellationRequests)
    .values({
      purchaseId: purchase.id,
      status: PurchaseCancellationRequestStatus.Requested,
      reason: parsed.data.reason,
    })
    .returning()
    .get();

  const email = buildPurchaseCancellationRequestEmail({
    learnerName: learner.name,
    learnerEmail: learner.email,
    courseTitle: course.title,
    amount: refundableAmount,
  });

  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);

  return redirect("/settings");
}
