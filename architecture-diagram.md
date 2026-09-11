# Architecture Diagram

This is the target shape at scale (see `docs/technical-note.md` §2–3). What's
actually running today (`npm start`) is the single-process form: the Scheduler
box below is a real `node-cron` job, but it calls the Orchestrator directly —
no Job Queue, no separate Workers yet. The API box is real but minimal
(`GET /health`, `POST /sync/trigger`, `GET /sync/status`), not the full
consolidated-data read API shown here.

```mermaid
flowchart TB
    subgraph Client
      App[Octaraa Application]
    end

    subgraph API
      REST[Sync/Accounts REST API]
    end

    subgraph Scheduling
      Scheduler["Sync Scheduler\n(cron + on-demand trigger)"]
      Queue[("Job Queue\nSQS / BullMQ")]
    end

    subgraph Workers
      Orchestrator["Sync Orchestrator\n(per-account lock, cursor resume)"]
      Retry[Retry / Rate-Limit Handler]
      Adapters["Provider Adapters\n(Plaid, Yodlee, ...)"]
    end

    subgraph Storage
      PG[("Postgres\nprovider_accounts, transactions, sync_runs")]
      Secrets[("Secrets Manager\nOAuth tokens, KMS-encrypted")]
    end

    subgraph Observability
      Logs[Structured Logs]
      Metrics[Metrics / Alerts]
    end

    App -->|read consolidated data| REST --> PG
    App -->|trigger sync| REST --> Queue
    Scheduler -->|enqueue periodic sync jobs| Queue
    Queue --> Orchestrator
    Orchestrator --> Retry --> Adapters
    Adapters -->|external provider APIs| Providers[(External Providers)]
    Orchestrator -->|dedupe + upsert| PG
    Orchestrator --> Logs --> Metrics
    Adapters -.->|fetch credentials| Secrets
```
