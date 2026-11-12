import { data, Form, Link, useNavigation } from "react-router";
import { and, asc, countDistinct, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Route } from "./+types/support.refunds.$refundId";
import { db } from "~/db";
import {
  courses,
  lessons,
  lessonProgress,
  modules,
  purchases,
  refunds,
  refundPaymentEvents,
  users,
  videoWatchEvents,
  RefundStatus,
  RefundPaymentStatus,
  LessonProgressStatus,
} from "~/db/schema";
import {
  decideRefund,
  recordRefundPayment,
  RefundWorkflowError,
  requireSupport,
} from "~/lib/refunds.server";
import { formatPrice } from "~/lib/utils";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Input } from "~/components/ui/input";

const idSchema = z.coerce.number().int().positive();
const actionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("decide"),
    decision: z.enum([RefundStatus.Approved, RefundStatus.Declined]),
    explanation: z.string().trim().min(1).max(2000),
  }),
  z.object({
    intent: z.literal("payment"),
    status: z.nativeEnum(RefundPaymentStatus),
    note: z.string().trim().max(2000),
    eventId: z.coerce.number().int().nonnegative(),
  }),
]);

export function meta() {
  return [{ title: "Review Refund Request — Cadence" }];
}
export function shouldRevalidate() {
  return true;
}

export async function loader({ params, request }: Route.LoaderArgs) {
  await requireSupport(request);
  const id = idSchema.safeParse(params.refundId);
  if (!id.success) throw data("Refund request not found.", { status: 404 });
  const details = db
    .select({
      refund: refunds,
      purchase: purchases,
      learner: users,
      course: courses,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.id, id.data))
    .get();
  if (!details) throw data("Refund request not found.", { status: 404 });
  const courseLessons = db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, details.course.id))
    .all();
  const lessonIds = courseLessons.map((l) => l.id);
  const completed = lessonIds.length
    ? db
        .select({ count: countDistinct(lessonProgress.lessonId) })
        .from(lessonProgress)
        .where(
          and(
            eq(lessonProgress.userId, details.learner.id),
            inArray(lessonProgress.lessonId, lessonIds),
            eq(lessonProgress.status, LessonProgressStatus.Completed)
          )
        )
        .get()!.count
    : 0;
  const watched = lessonIds.length
    ? db
        .select({
          furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
        })
        .from(videoWatchEvents)
        .where(
          and(
            eq(videoWatchEvents.userId, details.learner.id),
            inArray(videoWatchEvents.lessonId, lessonIds)
          )
        )
        .groupBy(videoWatchEvents.lessonId)
        .all()
        .reduce((total, row) => total + row.furthest, 0)
    : 0;
  const history = db
    .select({ refund: refunds, actorName: users.name })
    .from(refunds)
    .leftJoin(users, eq(refunds.resolvedByUserId, users.id))
    .where(eq(refunds.purchaseId, details.purchase.id))
    .orderBy(desc(refunds.requestedAt), desc(refunds.id))
    .all();
  const payments = db
    .select({ event: refundPaymentEvents, actorName: users.name })
    .from(refundPaymentEvents)
    .innerJoin(users, eq(refundPaymentEvents.actorUserId, users.id))
    .where(eq(refundPaymentEvents.refundId, id.data))
    .orderBy(asc(refundPaymentEvents.id))
    .all();
  return {
    ...details,
    completed,
    lessonCount: lessonIds.length,
    watched,
    history,
    payments,
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const actor = await requireSupport(request);
  const id = idSchema.safeParse(params.refundId);
  if (!id.success) throw data("Refund request not found.", { status: 404 });
  const parsed = actionSchema.safeParse(
    Object.fromEntries(await request.formData())
  );
  if (!parsed.success)
    return data(
      {
        error:
          "Check the action and enter the required explanation or payment reference (up to 2000 characters).",
      },
      { status: 400 }
    );
  try {
    const input = parsed.data;
    if (input.intent === "decide")
      decideRefund(id.data, actor.id, input.decision, input.explanation);
    else
      recordRefundPayment(
        id.data,
        actor.id,
        input.status,
        input.note,
        input.eventId
      );
    return { error: null };
  } catch (error) {
    if (error instanceof RefundWorkflowError)
      return data({ error: error.message }, { status: error.status });
    throw error;
  }
}

export default function RefundReview({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const {
    refund,
    purchase,
    learner,
    course,
    completed,
    lessonCount,
    watched,
    history,
    payments,
  } = loaderData;
  const busy = useNavigation().state !== "idle";
  const eventId = payments.at(-1)?.event.id ?? 0;
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6 lg:p-8">
      <Link to="/support/refunds" className="text-sm text-primary underline">
        Back to refund queue
      </Link>
      <div>
        <h1 className="text-3xl font-bold">Refund Request #{refund.id}</h1>
        <p className="mt-2 capitalize">
          {refund.status}
          {refund.paymentStatus && ` · Refund ${refund.paymentStatus}`}
        </p>
      </div>
      {actionData?.error && (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-destructive"
        >
          {actionData.error}
        </p>
      )}
      <Card>
        <CardHeader>
          <h2 className="text-xl font-semibold">{course.title}</h2>
        </CardHeader>
        <CardContent className="space-y-3">
          <p>
            {learner.name} · {learner.email}
          </p>
          <p>
            Purchase #{purchase.id} · {formatPrice(purchase.amountPaid)} ·{" "}
            {new Date(purchase.createdAt).toLocaleString()}
          </p>
          <p className="text-sm text-muted-foreground">
            Current progress: {completed} of {lessonCount} lessons completed ·{" "}
            {Math.round(watched / 60)} minutes watched across this course’s
            learning history.
          </p>
          <div>
            <h3 className="font-medium">Learner’s reason</h3>
            <p className="whitespace-pre-wrap">{refund.reason}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Requested {new Date(refund.requestedAt).toLocaleString()}
            </p>
          </div>
        </CardContent>
      </Card>
      {refund.status === RefundStatus.Open && (
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">Make a decision</h2>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-4">
              <input type="hidden" name="intent" value="decide" />
              <label className="block space-y-2">
                <span>Explanation for the learner</span>
                <Textarea
                  name="explanation"
                  required
                  maxLength={2000}
                  rows={4}
                />
              </label>
              <p className="text-sm text-muted-foreground">
                Approval authorizes a full refund of{" "}
                {formatPrice(purchase.amountPaid)}. Access continues until
                payment is confirmed issued.
              </p>
              <div className="flex gap-3">
                <Button name="decision" value="approved" disabled={busy}>
                  Approve request
                </Button>
                <Button
                  name="decision"
                  value="declined"
                  variant="outline"
                  disabled={busy}
                >
                  Decline request
                </Button>
              </div>
            </Form>
          </CardContent>
        </Card>
      )}
      {refund.status === RefundStatus.Approved &&
        refund.paymentStatus !== RefundPaymentStatus.Issued && (
          <Card>
            <CardHeader>
              <h2 className="text-lg font-semibold">Record payment outcome</h2>
            </CardHeader>
            <CardContent>
              <p className="mb-4 text-sm text-muted-foreground">
                Handle repayment outside the app. Confirm issuance only after
                the full {formatPrice(purchase.amountPaid)} has been refunded.
                This ends access from this purchase; progress remains saved.
              </p>
              {refund.paymentStatus === RefundPaymentStatus.Failed ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="payment" />
                  <input type="hidden" name="status" value="pending" />
                  <input type="hidden" name="note" value="" />
                  <input type="hidden" name="eventId" value={eventId} />
                  <Button disabled={busy}>Start payment retry</Button>
                </Form>
              ) : (
                <div className="grid gap-6 sm:grid-cols-2">
                  <Form method="post" className="space-y-3">
                    <input type="hidden" name="intent" value="payment" />
                    <input type="hidden" name="status" value="issued" />
                    <input type="hidden" name="eventId" value={eventId} />
                    <label className="block space-y-2">
                      <span>Payment reference</span>
                      <Input name="note" required maxLength={2000} />
                    </label>
                    <Button disabled={busy}>Confirm refund issued</Button>
                  </Form>
                  <Form method="post" className="space-y-3">
                    <input type="hidden" name="intent" value="payment" />
                    <input type="hidden" name="status" value="failed" />
                    <input type="hidden" name="eventId" value={eventId} />
                    <label className="block space-y-2">
                      <span>Failure explanation</span>
                      <Input name="note" required maxLength={2000} />
                    </label>
                    <Button variant="outline" disabled={busy}>
                      Record failed payment
                    </Button>
                  </Form>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">
            Request and decision history for purchase #{purchase.id}
          </h2>
        </CardHeader>
        <CardContent className="space-y-4">
          {history.map(({ refund: item, actorName }) => (
            <div key={item.id} className="rounded-md border p-3">
              <Link
                to={`/support/refunds/${item.id}`}
                className="font-medium underline"
              >
                Request #{item.id} · {item.status}
              </Link>
              <p className="whitespace-pre-wrap text-sm">{item.reason}</p>
              <p className="text-xs text-muted-foreground">
                Requested {new Date(item.requestedAt).toLocaleString()}
              </p>
              {item.resolvedAt && (
                <>
                  <p className="mt-2 whitespace-pre-wrap">
                    {item.decisionExplanation}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {actorName} · {new Date(item.resolvedAt).toLocaleString()}
                  </p>
                </>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
      {payments.length > 0 && (
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">
              Payment history for request #{refund.id}
            </h2>
          </CardHeader>
          <CardContent className="space-y-4">
            {payments.map(({ event, actorName }) => (
              <div key={event.id} className="border-b pb-3">
                <p className="font-medium capitalize">{event.status}</p>
                <p className="whitespace-pre-wrap">{event.note}</p>
                <p className="text-xs text-muted-foreground">
                  {actorName} · {new Date(event.createdAt).toLocaleString()}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
