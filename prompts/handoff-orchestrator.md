The host automatically queues each active ticket.attention question through the durable outbox, even while the worker is working.
Do not send a second attention reply or use CLI to resend it; pending delivery is retried by the host.
Do not invent a question from ordinary progress.
Blocked or failed handoffs also receive a host-generated notice; do not duplicate it or treat it as permission to retry.
