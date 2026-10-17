import {
  boolean,
  integer,
  pgTable,
  varchar,
  text,
  uuid,
  timestamp,
  index,
  unique,
  jsonb,
} from "drizzle-orm/pg-core";

export const usersTable = pgTable("users", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: varchar({ length: 255 }).notNull(),
  age: integer().notNull(),
  email: varchar({ length: 255 }).notNull().unique(),
  tenantHourlyLimit: integer().notNull().default(100),
});

export const sendersTable = pgTable(
  "senders",
  {
    id: uuid().primaryKey().defaultRandom(),

    userId: integer()
      .notNull()
      .references(() => usersTable.id),

    fromName: varchar({ length: 255 }).notNull(),
    fromEmail: varchar({ length: 320 }).notNull(),

    hourlyLimit: integer().notNull(),

    isActive: boolean().notNull().default(true),

    // Null webhook = sender has no Slack connection. Never store fake tokens.
    slackWebhookUrl: varchar({ length: 500 }),
    slackConnectedAt: timestamp({ withTimezone: true }),

    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("senders_user_from_email_unique").on(
      table.userId,
      table.fromEmail,
    ),
    index("senders_user_idx").on(table.userId),
  ],
);


export const emailBatchesTable = pgTable(
  "email_batches",
  {
    id: uuid().primaryKey().defaultRandom(),

    userId: integer()
      .notNull()
      .references(() => usersTable.id),

    senderId: uuid().references(() => sendersTable.id),

    subject: varchar({ length: 998 }).notNull(),
    body: text().notNull(),

    startAt: timestamp({ withTimezone: true }).notNull(),
    delayMs: integer().notNull(),
    hourlyLimit: integer().notNull(),

    totalEmails: integer().notNull().default(0),

    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("email_batches_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
  ],
);

export const emailsTable = pgTable(
  "emails",
  {
    id: uuid().primaryKey().defaultRandom(),

    batchId: uuid()
      .notNull()
      .references(() => emailBatchesTable.id),

    senderId: uuid().references(() => sendersTable.id),

    recipient: varchar({ length: 320 }).notNull(),
    subject: varchar({ length: 998 }).notNull(),
    body: text().notNull(),

    scheduledAt: timestamp({ withTimezone: true }).notNull(),

    status: varchar({ length: 20 })
      .notNull()
      .default("scheduled"),

    idempotencyKey: varchar({ length: 255 })
      .notNull()
      .unique(),

    sentAt: timestamp({ withTimezone: true }),
    providerMessageId: varchar({ length: 255 }),
    lastError: text(),

    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("emails_batch_idx").on(table.batchId),
    index("emails_status_scheduled_idx").on(
      table.status,
      table.scheduledAt,
    ),
    index("emails_sender_idx").on(table.senderId),
  ],
);


export const sendAttemptsTable = pgTable(
  "send_attempts",
  {
    id: uuid().primaryKey().defaultRandom(),

    emailId: uuid()
      .notNull()
      .references(() => emailsTable.id),

    attemptNumber: integer().notNull(),

    status: varchar({ length: 20 }).notNull(),

    providerMessageId: varchar({ length: 255 }),
    error: text(),

    attemptedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("send_attempts_email_attempt_unique").on(
      table.emailId,
      table.attemptNumber,
    ),
    index("send_attempts_email_idx").on(table.emailId),
  ],
);


export const outboxEventsTable = pgTable(
  "outbox_events",
  {
    id: uuid().primaryKey().defaultRandom(),

    eventType: varchar({ length: 100 }).notNull(),
    aggregateType: varchar({ length: 100 }).notNull(),
    aggregateId: uuid().notNull(),

    payload: jsonb()
      .$type<Record<string, unknown>>()
      .notNull(),

    status: varchar({ length: 20 })
      .notNull()
      .default("pending"),

    attempts: integer().notNull().default(0),

    availableAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow(),

    processedAt: timestamp({ withTimezone: true }),
    lastError: text(),

    createdAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("outbox_pending_idx").on(
      table.status,
      table.availableAt,
    ),
  ],
);
