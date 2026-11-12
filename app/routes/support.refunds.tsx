import { Form, Link } from "react-router";
import { and, asc, desc, eq, or } from "drizzle-orm";
import type { Route } from "./+types/support.refunds";
import { db } from "~/db";
import {
  courses,
  purchases,
  refunds,
  users,
  RefundStatus,
  RefundPaymentStatus,
} from "~/db/schema";
import { requireSupport } from "~/lib/refunds.server";
import { formatPrice } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";

export function meta() {
  return [{ title: "Refund Requests — Cadence" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireSupport(request);
  const params = new URL(request.url).searchParams;
  const decision = params.get("decision") ?? "actionable";
  const payment = params.get("payment") ?? "all";
  const decisionFilter =
    decision === "actionable"
      ? or(
          eq(refunds.status, RefundStatus.Open),
          and(
            eq(refunds.status, RefundStatus.Approved),
            or(
              eq(refunds.paymentStatus, RefundPaymentStatus.Pending),
              eq(refunds.paymentStatus, RefundPaymentStatus.Failed)
            )
          )
        )
      : Object.values(RefundStatus).includes(decision as RefundStatus)
        ? eq(refunds.status, decision as RefundStatus)
        : undefined;
  const paymentFilter = Object.values(RefundPaymentStatus).includes(
    payment as RefundPaymentStatus
  )
    ? eq(refunds.paymentStatus, payment as RefundPaymentStatus)
    : undefined;
  const requests = db
    .select({
      request: refunds,
      learner: users,
      purchase: purchases,
      course: courses,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(and(decisionFilter, paymentFilter))
    .orderBy(asc(refunds.status), desc(refunds.requestedAt), desc(refunds.id))
    .all();
  // Open requests come first; payment follow-up remains visible in the same queue.
  requests.sort(
    (a, b) =>
      Number(b.request.status === RefundStatus.Open) -
      Number(a.request.status === RefundStatus.Open)
  );
  return { requests, decision, payment };
}

export default function RefundQueue({ loaderData }: Route.ComponentProps) {
  const { requests, decision, payment } = loaderData;
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6 lg:p-8">
      <div>
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-2 text-muted-foreground">
          Review learner requests and follow up on payments.
        </p>
      </div>
      <Form method="get" className="flex flex-wrap items-end gap-4">
        <label className="space-y-1 text-sm">
          Requests
          <select
            key={decision}
            name="decision"
            defaultValue={decision}
            className="block rounded-md border bg-background p-2"
          >
            <option value="actionable">Needs attention</option>
            <option value="all">All requests</option>
            <option value="open">Open</option>
            <option value="approved">Approved</option>
            <option value="declined">Declined</option>
          </select>
        </label>
        <label className="space-y-1 text-sm">
          Payment
          <select
            key={payment}
            name="payment"
            defaultValue={payment}
            className="block rounded-md border bg-background p-2"
          >
            <option value="all">All payment statuses</option>
            <option value="pending">Pending</option>
            <option value="issued">Issued</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </Form>
      {requests.length === 0 && (
        <p className="text-muted-foreground">
          No refund requests match these filters.
        </p>
      )}
      {requests.map(({ request, learner, purchase, course }) => (
        <Card key={request.id}>
          <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
            <div>
              <Link
                className="font-semibold hover:underline"
                to={`/support/refunds/${request.id}`}
              >
                #{request.id} · {course.title}
              </Link>
              <p className="text-sm text-muted-foreground">
                {learner.name} · {learner.email}
              </p>
              <p className="mt-1 text-sm">
                {formatPrice(purchase.amountPaid)} ·{" "}
                {new Date(request.requestedAt).toLocaleString()}
              </p>
            </div>
            <div className="text-sm capitalize">
              {request.status}
              {request.paymentStatus && <p>Refund {request.paymentStatus}</p>}
              <Link
                className="mt-2 block text-primary underline"
                to={`/support/refunds/${request.id}`}
              >
                Review request
              </Link>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
