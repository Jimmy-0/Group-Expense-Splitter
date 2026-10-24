// OpenAPI 3.1 description of the HTTP API. Served at /api/openapi.json and rendered at /api/docs.

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object, example?: unknown) => ({
  content: { "application/json": { schema, ...(example === undefined ? {} : { example }) } },
});
const error = (description: string) => ({ description, ...json(ref("Error")) });

const groupId = { name: "groupId", in: "path", required: true, schema: { type: "string" }, example: "a9a18Djkd35X" };
const memberId = { name: "memberId", in: "path", required: true, schema: { type: "integer" } };
const expenseId = { name: "expenseId", in: "path", required: true, schema: { type: "integer" } };

const decimal = (description: string, example: string) => ({
  type: "string",
  pattern: "^(?=\\.?\\d)\\d{0,8}(\\.\\d{0,2})?$",
  description,
  example,
});

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Split — group expense splitter API",
    version: "1.0.0",
    description: [
      "All money in responses is **integer cents**. Money in requests is a **decimal string** with at most",
      "2 decimal places (`\"100\"`, `\"10.01\"`, `\".5\"`); JSON numbers are rejected so floating point never",
      "touches money. Balances and the settle-up plan are always computed on the server.",
      "",
      "Errors: `400` invalid input (with per-field `details` for shape errors), `404` unknown group/expense/member,",
      "`409` conflict (stale `version`, duplicate name, member still in use, payment no longer in the plan),",
      "`413` body over 100 KB.",
    ].join("\n"),
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "Groups" },
    { name: "Members" },
    { name: "Expenses" },
    { name: "Settle up" },
    { name: "Live updates" },
  ],
  paths: {
    "/api/groups": {
      post: {
        tags: ["Groups"],
        summary: "Create a group with its initial members",
        requestBody: { required: true, ...json(ref("CreateGroupInput"), { name: "Lisbon trip", members: ["Ann", "Bob", "Cat"] }) },
        responses: {
          201: { description: "Created", ...json(ref("GroupSnapshot")) },
          400: error("Invalid name, no members, more than 50 members, or duplicate names (case/Unicode-insensitive)"),
        },
      },
    },
    "/api/groups/{groupId}": {
      get: {
        tags: ["Groups"],
        summary: "Everything the UI needs: members, expenses, balances, and the settle-up plan",
        parameters: [groupId],
        responses: {
          200: { description: "OK", ...json(ref("GroupSnapshot")) },
          404: error("Group not found"),
        },
      },
    },
    "/api/groups/{groupId}/members": {
      post: {
        tags: ["Members"],
        summary: "Add a member",
        parameters: [groupId],
        requestBody: { required: true, ...json(ref("AddMemberInput"), { name: "Dan" }) },
        responses: {
          201: { description: "Added", ...json(ref("GroupSnapshot")) },
          400: error("Invalid name"),
          404: error("Group not found"),
          409: error("Name already used by an active member, or the group already has 50 members"),
        },
      },
    },
    "/api/groups/{groupId}/members/{memberId}": {
      delete: {
        tags: ["Members"],
        summary: "Remove (archive) a member",
        description: "Members are archived, not deleted, so history still resolves their name. Blocked while they are in an active expense.",
        parameters: [groupId, memberId],
        responses: {
          200: { description: "Archived", ...json(ref("GroupSnapshot")) },
          404: error("Group or active member not found"),
          409: error("Member is the payer or in the split of an active expense"),
        },
      },
    },
    "/api/groups/{groupId}/expenses": {
      post: {
        tags: ["Expenses"],
        summary: "Log an expense",
        parameters: [groupId],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: ref("ExpenseInput"),
              examples: {
                equal: {
                  summary: "$100 split equally three ways",
                  value: { description: "Dinner", amount: "100", paidBy: 1, split: { mode: "equal", memberIds: [1, 2, 3] } },
                },
                exact: {
                  summary: "Exact amounts (must add up to the total)",
                  value: {
                    description: "Groceries",
                    amount: "50",
                    paidBy: 1,
                    split: {
                      mode: "exact",
                      shares: [
                        { memberId: 1, amount: "20" },
                        { memberId: 2, amount: "20" },
                        { memberId: 3, amount: "10" },
                      ],
                    },
                  },
                },
                percent: {
                  summary: "Percentages (must add up to 100)",
                  value: {
                    description: "Taxi",
                    amount: "10.01",
                    paidBy: 3,
                    split: {
                      mode: "percent",
                      shares: [
                        { memberId: 1, percent: "50" },
                        { memberId: 2, percent: "25" },
                        { memberId: 3, percent: "25" },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Created", ...json(ref("Expense")) },
          400: error("Bad amount, shares that don't add up, or payer/participant not an active member of this group"),
          404: error("Group not found"),
        },
      },
    },
    "/api/groups/{groupId}/expenses/{expenseId}": {
      put: {
        tags: ["Expenses"],
        summary: "Edit an expense (optimistic concurrency)",
        description: "Send the `version` you loaded. Splits are replaced and a revision is appended in one transaction.",
        parameters: [groupId, expenseId],
        requestBody: { required: true, ...json(ref("UpdateExpenseInput")) },
        responses: {
          200: { description: "Updated; `version` incremented", ...json(ref("Expense")) },
          400: error("Invalid input"),
          404: error("Group or expense not found (or already deleted)"),
          409: {
            description: "Someone else changed the expense; `details.current` is the latest version",
            ...json(ref("Error")),
          },
        },
      },
      delete: {
        tags: ["Expenses"],
        summary: "Delete an expense (soft delete with a revision)",
        parameters: [
          groupId,
          expenseId,
          { name: "version", in: "query", required: true, schema: { type: "integer", minimum: 1 } },
        ],
        responses: {
          204: { description: "Deleted" },
          400: error("Missing version"),
          404: error("Group or expense not found"),
          409: error("Stale version"),
        },
      },
    },
    "/api/groups/{groupId}/expenses/{expenseId}/history": {
      get: {
        tags: ["Expenses"],
        summary: "All revisions of an expense, oldest first (including deleted expenses)",
        parameters: [groupId, expenseId],
        responses: {
          200: { description: "OK", ...json({ type: "array", items: ref("ExpenseRevision") }) },
          404: error("Expense not found in this group"),
        },
      },
    },
    "/api/groups/{groupId}/settlements": {
      post: {
        tags: ["Settle up"],
        summary: "Record that a settle-up payment was made",
        description:
          "The transfer must exactly match a line of the current plan. Recorded as an expense with `isPayment: true` " +
          "(debtor pays, creditor owes the full amount), so a double tap records it only once.",
        parameters: [groupId],
        requestBody: { required: true, ...json(ref("Transfer"), { from: 2, to: 1, amountCents: 3333 }) },
        responses: {
          201: { description: "Payment recorded", ...json(ref("Expense")) },
          400: error("Invalid input"),
          404: error("Group not found"),
          409: error("Transfer is not in the current plan (already paid, or balances changed)"),
        },
      },
    },
    "/api/groups/{groupId}/events": {
      get: {
        tags: ["Live updates"],
        summary: "Server-Sent Events stream",
        description: "Emits `event: change` whenever the group changes; clients refetch the snapshot. Not usable from Swagger UI.",
        parameters: [groupId],
        responses: {
          200: { description: "Event stream", content: { "text/event-stream": { schema: { type: "string" } } } },
          404: error("Group not found"),
        },
      },
    },
  },
  components: {
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: { error: { type: "string" }, details: {} },
        example: { error: "exact shares add up to $40.00 but the expense is $50.00 (off by $10.00)" },
      },
      CreateGroupInput: {
        type: "object",
        required: ["name", "members"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 60 },
          members: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 1, maxLength: 40 } },
        },
      },
      AddMemberInput: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", minLength: 1, maxLength: 40 } },
      },
      ExpenseInput: {
        type: "object",
        required: ["description", "amount", "paidBy", "split"],
        properties: {
          description: { type: "string", minLength: 1, maxLength: 120 },
          amount: decimal("Total, > 0, max 10,000,000.00", "100.00"),
          paidBy: { type: "integer", description: "Active member id; need not be in the split" },
          split: {
            oneOf: [ref("EqualSplit"), ref("ExactSplit"), ref("PercentSplit")],
            discriminator: {
              propertyName: "mode",
              mapping: {
                equal: "#/components/schemas/EqualSplit",
                exact: "#/components/schemas/ExactSplit",
                percent: "#/components/schemas/PercentSplit",
              },
            },
          },
        },
      },
      UpdateExpenseInput: {
        allOf: [
          ref("ExpenseInput"),
          { type: "object", required: ["version"], properties: { version: { type: "integer", minimum: 1 } } },
        ],
      },
      EqualSplit: {
        type: "object",
        required: ["mode", "memberIds"],
        description: "Leftover cents go to the largest remainders, ties by list order: $100 / 3 = 33.34, 33.33, 33.33.",
        properties: {
          mode: { const: "equal" },
          memberIds: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: { type: "integer" } },
        },
      },
      ExactSplit: {
        type: "object",
        required: ["mode", "shares"],
        description: "Shares must add up to exactly the amount.",
        properties: {
          mode: { const: "exact" },
          shares: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              required: ["memberId", "amount"],
              properties: { memberId: { type: "integer" }, amount: decimal("Share", "20.00") },
            },
          },
        },
      },
      PercentSplit: {
        type: "object",
        required: ["mode", "shares"],
        description: "Percentages (max 2 decimals) must add up to exactly 100. Cents are allocated by largest remainder.",
        properties: {
          mode: { const: "percent" },
          shares: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              required: ["memberId", "percent"],
              properties: {
                memberId: { type: "integer" },
                percent: { type: "string", pattern: "^(?=\\.?\\d)\\d{0,3}(\\.\\d{0,2})?$", example: "33.33" },
              },
            },
          },
        },
      },
      Member: {
        type: "object",
        required: ["id", "name", "archived"],
        properties: { id: { type: "integer" }, name: { type: "string" }, archived: { type: "boolean" } },
      },
      ExpenseShare: {
        type: "object",
        required: ["memberId", "input", "amountCents"],
        properties: {
          memberId: { type: "integer" },
          input: {
            type: ["integer", "null"],
            description: "What was entered: cents (exact), basis points where 1% = 100 (percent), null (equal)",
          },
          amountCents: { type: "integer", description: "Resolved share" },
        },
      },
      Expense: {
        type: "object",
        required: ["id", "description", "amountCents", "paidBy", "splitMode", "isPayment", "version", "createdAt", "updatedAt", "shares"],
        properties: {
          id: { type: "integer" },
          description: { type: "string" },
          amountCents: { type: "integer" },
          paidBy: { type: "integer" },
          splitMode: { enum: ["equal", "exact", "percent"] },
          isPayment: { type: "boolean", description: "Recorded via /settlements" },
          version: { type: "integer" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          shares: { type: "array", items: ref("ExpenseShare") },
        },
      },
      Balance: {
        type: "object",
        required: ["memberId", "paidCents", "owedCents", "netCents"],
        properties: {
          memberId: { type: "integer" },
          paidCents: { type: "integer" },
          owedCents: { type: "integer" },
          netCents: { type: "integer", description: "paid − owed; positive = gets money back. Sums to 0 across the group." },
        },
      },
      Transfer: {
        type: "object",
        required: ["from", "to", "amountCents"],
        properties: {
          from: { type: "integer", description: "Member who pays" },
          to: { type: "integer", description: "Member who receives" },
          amountCents: { type: "integer", minimum: 1 },
        },
      },
      GroupSnapshot: {
        type: "object",
        required: ["id", "name", "createdAt", "members", "expenses", "balances", "settlements"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          members: { type: "array", items: ref("Member"), description: "Includes archived members" },
          expenses: { type: "array", items: ref("Expense"), description: "Active expenses, newest first" },
          balances: { type: "array", items: ref("Balance") },
          settlements: {
            type: "array",
            items: ref("Transfer"),
            description: "Minimum number of payments that clears all balances",
          },
        },
      },
      ExpenseRevision: {
        type: "object",
        required: ["version", "action", "createdAt", "snapshot"],
        properties: {
          version: { type: "integer" },
          action: { enum: ["create", "update", "delete"] },
          createdAt: { type: "string", format: "date-time" },
          snapshot: { description: "The expense as of this version (without version/timestamps)" },
        },
      },
    },
  },
} as const;
