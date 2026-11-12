# Keep manual refund payment history separate from the decision

Payment is handled outside the app, so approval creates a Pending Refund rather than claiming that repayment has succeeded. Support records issuance with a payment reference or failure with an explanation. A Failed Refund can return to Pending for another attempt without changing the approved request.

Retain each payment action with its actor and timestamp so retries do not overwrite the evidence of earlier attempts. The support workspace includes a queue, request details, and decision and payment history; learners see their request history, decision explanations, and payment status in the existing refund area. Real email delivery is outside this feature's scope.
