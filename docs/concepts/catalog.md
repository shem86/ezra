# Concept naming catalog

The standard name for each planned card on the [concepts page](index.html),
checked before the card is written. Use this as the input for new cards.

## Rules for every card

1. **Title with the industry name.** A term we coined goes under "Also called"
   and is marked as a project term.
2. **Say so when no standard name exists.** Use a plain description instead of
   inventing a pattern name.
3. **Check claims against code first.** The architecture doc holds rationale,
   and some of its details have drifted from the code.
4. **Check library behaviour against the pinned source** when the docs describe
   a different language or version.
5. **Cite a primary source** for each name: a standard, the original author, or
   official docs. A blog post doesn't qualify.
6. **Rate maturity by evidence.** "Proven live" needs a real production event.

In the tables, *To verify* means nobody has checked a primary source yet. Do
that before writing the card. *None* means no established name was found.

## Names that are easy to get wrong

| Don't say | Why | Say |
|---|---|---|
| Fire-and-fold | Project term | Asynchronous human-in-the-loop approval |
| Co-commit | Project term | Exactly-once state writes, solving the dual-write problem |
| Retry budget (for the socket) | Google's term limits retries as a share of traffic. Our socket has a capped attempt count. | Bounded retries with backoff |
| Poison pill | In concurrency it usually means a deliberate shutdown message | Poison message |
| Fence (alone) | Project term | Spotlighting, delimiting technique |
| Tokenomics | Mainly a crypto term | LLM unit economics, or cost per turn |
| Approval binding | Project term | Correlation identifier |
| Delivery class | Project term | At-least-once or at-most-once delivery |

## Building the agent

| Standard name | Project term | Primary source |
|---|---|---|
| Agent harness with an application-owned loop | "DBOS owns the loop" | [Anthropic: long-running harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) |
| Typed tool definitions | `defineTool` registry | To verify |
| Tool call and result pairing | Every `tool_use` gets a `tool_result` | To verify |
| Iteration cap with a forced final answer | `MAX_ROUNDS` | [OWASP LLM10](https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/) (related risk) |
| Asynchronous human-in-the-loop approval | Fire-and-fold | Card written |
| Compare-and-swap (conditional update) | Execute-once guard | To verify |
| Time-of-check to time-of-use (TOCTOU) | Revalidation at execution | [CWE-367](https://cwe.mitre.org/data/definitions/367) |
| Rule-based decision before the model | Keyword approve/deny | None |
| Prompt caching with a stable prefix | Byte-stable prefix | [Claude docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) |
| Current-time injection | "The model had no clock" | None |
| Context compaction | Compaction | [Anthropic: context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) |
| Retrieval as a tool (agentic RAG) | Pull-only recall | To verify |
| System of record plus semantic memory | Tiered memory | To verify |
| Dependency injection | `deps` object | To verify |

## Guardrails

| Standard name | Project term | Primary source |
|---|---|---|
| Risk-tiered tool permissions | Risk tiers | [OWASP LLM06](https://genai.owasp.org/llm-top-10/) (Excessive Agency) |
| Sender allowlist | Scoped to one conversation | To verify |
| Schema validation at trust boundaries | Zod at every boundary | To verify |
| Fail-safe defaults | Ambiguous calls fail safe | To verify (Saltzer and Schroeder, 1975) |
| Indirect prompt injection defence: spotlighting | Untrusted-content fence, ADR-0005 | [Hines et al., arXiv 2403.14720](https://arxiv.org/pdf/2403.14720) |
| Spend limit against unbounded consumption | Provider-side ceiling | [OWASP LLM10](https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/) |

## Measurement and evaluation

| Standard name | Project term | Primary source |
|---|---|---|
| Outcome-based agent evals | Assert on state, not wording | [Anthropic: evals for agents](https://www.anthropic.com/research/demystifying-evals-for-ai-agents) |
| Classifier accuracy evaluation | Relatedness dashboard | To verify |
| Distributed tracing, with telemetry that can't fail the request | Trace callbacks never throw | To verify |
| LLM unit economics | Tokenomics, cost gate | To verify |
| Removing a premature optimization by measurement | Removing the router, ADR-0003 | None |

## Keeping it reliable

| Standard name | Project term | Primary source |
|---|---|---|
| Durable execution | DBOS workflows | [Temporal: workflow definition](https://docs.temporal.io/workflow-definition) |
| Deterministic replay | Determinism lint rule | [Temporal: workflow definition](https://docs.temporal.io/workflow-definition) |
| Exactly-once state writes | Co-commit | Card written |
| Sequential convoy | Conversation lane | [Azure Architecture Center](https://learn.microsoft.com/azure/architecture/patterns/sequential-convoy) |
| Guaranteed delivery, acknowledge after persist | Durable enqueue before ack | [EIP index](https://www.enterpriseintegrationpatterns.com/patterns/messaging/) |
| Idempotent receiver | Inbound dedupe | [EIP](https://www.enterpriseintegrationpatterns.com/patterns/messaging/IdempotentReceiver.html) |
| Aggregator with a time-based completion rule | Consumer-side debounce | [EIP](https://www.enterpriseintegrationpatterns.com/patterns/messaging/Aggregator.html) |
| Message loop prevention | Self-echo filtering | None |
| Poison message and dead letter channel | LEDGER-15 | [EIP](https://www.enterpriseintegrationpatterns.com/patterns/messaging/DeadLetterChannel.html) |
| Idempotency key | `deriveIdempotencyKey` | [Stripe docs](https://docs.stripe.com/idempotency) |
| Deterministic external IDs | Calendar event ID, 409 fold | None |
| At-least-once and at-most-once delivery | Send classes, `sent_log` | To verify |
| Workflow versioning | Version-scoped recovery | [Temporal: versioning](https://docs.temporal.io/develop/typescript/workflows/versioning) |
| Dead man's switch | Dead-man ping | Card written |
| Failure domain isolation for alerting | No shared fate | To verify |
| Liveness versus readiness | HEALTH-GRACE-001 | [Kubernetes docs](https://www.kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/) |
| Bounded retries with backoff | SOCKET-DEAD-001 | To verify |
| Startup gating | PROX-SEND-001 | [Kubernetes docs](https://www.kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/) |
| Roll forward | Pin, watch, fall forward, ADR-0006 | To verify |
| Point-in-time recovery, RPO and RTO | PITR backups | To verify |
| Reconciliation and compensating transactions | Effects don't roll back | [Azure Architecture Center](https://learn.microsoft.com/azure/architecture/patterns/compensating-transaction) |
| Non-restorable state (forward-only ratchet) | Restore-hostile Baileys state | To verify (Signal Double Ratchet) |
| Forward-only migrations | Migrate gate | To verify. Expand/contract ([Fowler](https://www.martinfowler.com/bliki/ParallelChange.html)) applies only if the code really does it. |

## Security and operations

| Standard name | Project term | Primary source |
|---|---|---|
| Default-deny egress | Egress allowlist | To verify |
| DNS-based allowlist staleness | Rotating single-record hosts | None |
| Dependency pinning | Exact pins, full transitive review | To verify |
| Secrets isolation and log redaction | LOG-KEYS-001 | To verify |
| Principle of least privilege | Read-only role | To verify (Saltzer and Schroeder, 1975) |
| Public-key backup encryption | Host can't decrypt its own backups | To verify |
| Workload identity federation | OIDC deploy role | [GitHub docs](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws) |
| Remote management with no inbound ports | Deploy over SSM | To verify |
| Immutable artifacts and automated rollback | `:sha-` tags, auto-rollback | To verify |
| Importing existing infrastructure into IaC | Adopt, don't replace | To verify |
| Private network access | Console over Tailscale | To verify |
| Fault injection testing | Kill-mid-flight suite | To verify |
| Single source of truth, docs as code | `STATUS.md` and `check:docs` | To verify |
