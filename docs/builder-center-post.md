*Get an email at 7 a.m. only on the days it matters: "rain chance ≥ 60%", "low ≤ −10°C", "wind ≥ 50 km/h". One SAM template, no servers, no API keys, about $0 a month.*

**Repo:** https://github.com/Rajpreet12/weather-alerts · **Time:** ~30 minutes · **You'll need:** an AWS account, AWS CLI v2, AWS SAM CLI, Node.js 20+

## The problem

Weather apps tell you everything, every day, so you learn to ignore them. I wanted the opposite: **silence, unless something I care about is about to happen.** I live in Calgary, where "is it going below −10 tonight?" decides whether I plug in the car.

By the end you'll have a signup API (email + city + rule), double opt-in and unsubscribe links without writing email code, a 7 a.m. job that emails only the people whose rule triggered, retries and dead-letter queues, abuse limits, least-privilege IAM, and a clean-up path.

**Who it's for:** you plus **family and friends**: tens of people, one home timezone you pick at deploy time. That keeps AWS limits irrelevant and the cost near zero.

**How to read it:** you won't type application code. You clone the repo, deploy, and verify. Each step explains what a part does first, then shows the code so you know where to change it.

## Architecture

[IMAGE: 1-architecture.png]

| Choice | Why | Tradeoff |
|---|---|---|
| **EventBridge Scheduler** (not a scheduled rule) | Timezone-aware: 7 a.m. stays 7 a.m. across daylight saving. Own retry policy and DLQ. | None really. |
| **SNS email + filter policies** (not SES) | SES needs a verified sender and starts in a sandbox (only verified recipients) until AWS grants production access, and you'd build opt-in/unsubscribe yourself. SNS gives both free, and can add mobile push later. | Plain text, generic sender. Use SES for branded HTML email. |
| **Cloud** (not a phone app) | Runs while your phone is off, no install, one forecast call serves a whole city. | For one person, a phone app could do this. |
| **Open-Meteo** | Free, no API key, so no secret to manage. | Non-commercial use; credit required. |
| **DynamoDB + a GSI** | Pay per request. The job `Query`s only what's due, already grouped by city. | Writes also update the index. |
| **Lambda on arm64** | ~20% cheaper than x86. | None for plain JavaScript. |

## Step 1: Get the code

```bash
aws login                       # or: aws configure
aws sts get-caller-identity     # confirm the account you're deploying to
git clone https://github.com/Rajpreet12/weather-alerts && cd weather-alerts
npm test
```

## Step 2: Understand (and customize) the alert rules

The five rule types live in `src/rules.mjs`, ordinary source code you can edit **before deploying**. It has no AWS calls, so tests run in milliseconds. To add a rule (say humidity), add one line pointing at an Open-Meteo daily field.

```js
// src/rules.mjs
export const RULES = {
  rain:  { label: 'Rain', unit: '%',  min: 1,   max: 100, field: 'precipitation_probability_max', ... },
  below: { label: 'Cold', unit: '°C', min: -60, max: 50,  field: 'temperature_2m_min', ... },
  // snow, above, wind ...
}

export function evaluate(rule, daily, dayIndex = 0) {
  const value = daily?.[RULES[rule.type].field]?.[dayIndex]
  if (typeof value !== 'number') return { triggered: false, value: null } // missing data never alerts
  const triggered = rule.type === 'below' ? value <= rule.threshold : value >= rule.threshold
  return { triggered, value }
}
```

If the API returns `null`, the safe failure is silence, not an email saying "null°C". `npm test` → `ℹ pass 13  ℹ fail 0`.

> **Snag to avoid:** in your own test scripts use plain `node --test`. Adding a folder (`node --test test/`) silently found **zero** tests on Windows when I tried it.

## Step 3: How the weather data is fetched

`src/weather.mjs` geocodes the city and fetches *today's* forecast from Open-Meteo. Two settings matter: every call has a **5-second timeout** (a hanging API shouldn't eat your Lambda budget; change `timeoutMs` if needed), and `timezone: 'auto'` makes "today" mean today *in that city*, not UTC.

```js
async function getJson(url, timeoutMs = 5000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })   // the timeout
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
// getDailyForecast(): ...?latitude=..&longitude=..&daily=<fields>&timezone=auto&forecast_days=1
```

## Step 4: One topic, one subscription per person

**What's a filter policy?** An SNS topic is a broadcast channel: every message goes to every subscriber. A **filter policy** on a subscription says *"only deliver messages whose attributes match this"*. So:

- **One topic** for everyone.
- **One email subscription per person**, filter `{"recipientId": ["<hash of their email>"]}`.
- The daily job tags each alert with that person's `recipientId`, so it reaches that inbox only.

**Why not one topic per city?** Two people in Calgary have *different rules*. A city topic would email both whenever either rule fired. "Does this person get an email?" is a per-person decision.

[IMAGE: 2-one-topic-many-inboxes.png]

```js
// src/subscribe.mjs (core)
const recipientId = recipientIdFor(email)   // sha256(email), 32 hex chars
const sub = await sns.send(new SubscribeCommand({
  TopicArn: TOPIC_ARN, Protocol: 'email', Endpoint: email,
  Attributes: { FilterPolicy: JSON.stringify({ recipientId: [recipientId] }) },
  ReturnSubscriptionArn: true,
}))
// then save the alert: id, recipientId, unsubscribeToken, place, rule, checkHour, locKey
```

SNS gives you **double opt-in** (nothing is delivered until the person clicks *Confirm subscription*) and an **unsubscribe-everything** link in every email.

> **Real snag: a second city for the same email failed.** My first version made one SNS subscription per *alert*, filtered on the alert id. A reviewer asked about two cities; the second signup failed with `InvalidParameterException: Subscription already exists with different attributes`. **SNS treats topic + protocol + email as one subscription:** the same attributes return the existing one, different attributes are rejected. Filtering on the *person* fixed it. A second city now returns `"Added to your existing alerts. No confirmation needed."`

**Stop just one city.** Each alert email also contains `Stop only this <city> alert: https://<api>/unsubscribe?id=…&token=…`. A **GET** shows a "Yes, stop this alert" button and deletes nothing, because inbox security scanners auto-click links. The **POST** deletes the alert only if the secret token matches (`ConditionExpression: 'unsubscribeToken = :t'`), and removes the SNS subscription if it was the person's last alert.

> **Real snag: IAM wanted the topic ARN.** I granted `sns:GetSubscriptionAttributes` on `<topic-arn>:*` and got `AuthorizationErrorException`. SNS authorizes it against the **topic** ARN: `Resource: !Ref AlertsTopic`.

### Threat model for the public signup endpoint

The endpoint has no login, and each call makes AWS email an address **the caller chose**. Validation keeps bad data out; it isn't protection.

| Threat | Stopped here by | Add for a public launch |
|---|---|---|
| **Inbox bombing** (one victim, many signups) | Max 3 alerts per address; no repeat email once confirmed | — |
| **Spraying** (thousands of different victims) | API throttling: 2 req/s, burst 5 | **AWS WAF** rate-based rule per IP |
| **Bots** | Throttling | **CAPTCHA** |
| **Unwanted alerts** | SNS double opt-in | — |
| **Sender reputation** (spam complaints) | All of the above | Monitor SNS delivery metrics |
| **Unsubscribing others** | Secret token; GET shows, POST deletes | — |

## Step 5: The daily job

Every morning: find the alerts due now, get one forecast per city, and email only the people whose rule is crossed. You don't need to edit this; it shows where retries and duplicate protection live.

Each alert has two attributes feeding a GSI, `ByCheckHour`: partition key `checkHour` (`"07"`) and sort key `locKey` (`"51.05,-114.09#<id>"`, location rounded to ~1 km). A Query returns only what's due, **already sorted by city**, so one pass groups it.

```js
const page = await ddb.send(new QueryCommand({
  TableName: TABLE_NAME, IndexName: 'ByCheckHour',
  KeyConditionExpression: 'checkHour = :h', ExpressionAttributeValues: { ':h': '07' },
  ExclusiveStartKey,                       // paginate
}))
// group adjacent items by city → 1 forecast call per city, 5 at a time
```

**Idempotency** makes retries safe:

```js
async function alertOne(sub, daily) {
  if (sub.lastAlertDate === daily.time[0]) return 'already_sent'   // retry-safe
  const { triggered, value } = evaluate(sub.rule, daily)
  if (!triggered) return 'not_triggered'
  await sns.send(new PublishCommand({ TopicArn: TOPIC_ARN, Subject: subject, Message: message,
    MessageAttributes: { recipientId: { DataType: 'String', StringValue: sub.recipientId } } }))
  await ddb.send(new UpdateCommand({ TableName: TABLE_NAME, Key: { id: sub.id },
    UpdateExpression: 'SET lastAlertDate = :d', ExpressionAttributeValues: { ':d': daily.time[0] } }))
  return 'sent'
}
```

If any city fails, the job throws and Lambda retries the whole run; `lastAlertDate` skips people already emailed. Publishing *before* recording means a crash costs at most one duplicate, never a missed −25°C warning.

[IMAGE: 3-idempotent-retries.png]

## Step 6: The infrastructure (SAM)

The full `template.yaml` is in the repo. The key parts:

```yaml
  SubscriptionsTable:          # PAY_PER_REQUEST, SSE + point-in-time recovery on
    GlobalSecondaryIndexes:
      - IndexName: ByCheckHour             # daily job: Query, not Scan
        KeySchema:
          - { AttributeName: checkHour, KeyType: HASH }
          - { AttributeName: locKey, KeyType: RANGE }
        Projection: { ProjectionType: ALL }
      - IndexName: ByEmail                 # per-email cap; only counts
        KeySchema: [{ AttributeName: email, KeyType: HASH }]
        Projection: { ProjectionType: KEYS_ONLY }

  CheckFunction:
    EventInvokeConfig:                     # layer 2: your code throws
      MaximumRetryAttempts: 2
      DestinationConfig: { OnFailure: { Type: SQS } }
    Events:
      DailyCheck:
        Type: ScheduleV2
        Properties:
          Name: !Sub ${AWS::StackName}-daily-check
          ScheduleExpression: cron(0 7 * * ? *)
          ScheduleExpressionTimezone: America/Edmonton
          RetryPolicy: { MaximumRetryAttempts: 3 }   # layer 1: delivery fails
          DeadLetterConfig: { Type: SQS }
```

**Two retry layers.** Scheduler's retry policy covers failures to *deliver* the invocation. Scheduler invokes Lambda asynchronously, so if *your code* throws, Lambda's `EventInvokeConfig` retries and then sends the event to SQS. Set only the first and a bug fails silently.

[IMAGE: 4-two-retry-layers.png]

**Least privilege:** the subscribe function can subscribe but not publish; the daily job can publish but not subscribe; each gets only its table. The SNS topic uses KMS (`alias/aws/sns`).

## Step 7: Deploy

```bash
sam validate --lint
sam build
sam deploy --guided            # choose your ScheduleTimezone, e.g. Europe/London
aws cloudformation describe-stacks --stack-name weather-alerts --query "Stacks[0].Outputs" --output table
```

> **Real snag: the schedule name.** Without `Name:`, SAM named the schedule `CheckFunctionDailyCheck`, with **no stack name**. A second copy of the stack in the same account would clash. `Name: !Sub ${AWS::StackName}-daily-check` fixes it.

## Step 8: Verify it works

**1. Subscribe** with a rule that triggers today:

```bash
curl -s -X POST "$API/subscriptions" -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","city":"Calgary","rule":{"type":"above","threshold":-30}}'
```

```json
{"place":"Calgary, Alberta, Canada","rule":"high ≥ -30°C","next":"Check your inbox and click \"Confirm subscription\"..."}
```

**2. Confirm** via the AWS email.

**3. Run the job now** instead of waiting for 7 a.m.:

```bash
aws lambda invoke --function-name <CheckFunctionName> out.json && cat out.json
```

The first run sends (`"sent":1`). The real output when I ran it again:

```json
{"checkHour":"07","subscriptions":1,"locations":1,"sent":0,"already_sent":1,"failed":0}
```

No duplicate email. Passing `--payload '{"checkHour":"08"}'` returned `"subscriptions":0`: the index reads only what's due.

[IMAGE: 5-alert-email.png]

**4. Add a second city, then stop just that one** (real results):

```
POST /subscriptions Toronto  → 201 "Added to your existing alerts. No confirmation needed."
GET  /unsubscribe            → 200 "Stop this alert?"   (nothing deleted)
POST, wrong token            → 404 "Already stopped"
POST, right token            → 200 "You won't get the Toronto alert any more. Your other 1 alert(s) keep working."
SNS subscriptions left: 1    (Calgary still works)
```

**5. Guard rails** (real responses): bad rule → `400`, bad email → `400`, unknown city → `404 Couldn't find a place called "Nowhereville Zzzq"`, not JSON → `400`. A 4th alert for one address → `429`.

## What I changed after community feedback

A reviewer's first comment: *never like seeing a DynamoDB Scan here; use a GSI or transacted secondary records.* They were right. My v1 Scanned **every row every morning**, including unsubscribed people and alerts due at other hours, then grouped in memory.

[IMAGE: 6-scan-vs-query.png]

I chose the **GSI** over secondary records written with `TransactWriteItems`: DynamoDB keeps the index in sync for me, while transactions mean keeping two records consistent on every write (at 2× write cost). Keying on `checkHour` also makes per-user alert times an easy next step.

> **Real snag: CloudFormation finished before the index did.** `sam deploy` said `UPDATE_COMPLETE` in 55 seconds, then the job failed with `ValidationException: Cannot read from backfilling global secondary index`. The index was still `CREATING` and took ~7 more minutes. **Add a GSI to a live table in two deploys:** add the index, backfill old rows (a one-time conditional `UpdateItem` per row) and wait for `ACTIVE`, then ship the code that queries it.

## Cost

At hobby scale (~100 subscribers, one run a day) it fits in the AWS Free Tier or rounds to cents:

| Service | Monthly use | Free tier |
|---|---|---|
| EventBridge Scheduler | 30 runs | 14M invocations |
| Lambda (arm64) | 30 runs + signups | Well within |
| DynamoDB on-demand | ~3,000 reads | Cents |
| SNS email | Triggered days only | 1,000 emails |
| API Gateway HTTP API | A few hundred calls | 1M (12 months) |

At scale the cost driver is SNS email, and then you'd move to SES anyway.

## Scaling and limits

- All 7 a.m. alerts share one GSI partition key; at millions, shard it (`07#0` … `07#9`).
- One Lambda run has a 15-minute limit; for huge runs, fan out one SQS message per city.
- Rows for people who unsubscribed via SNS's link remain until a periodic cleanup removes them.
- One alert time for everyone; per-user times need an `hour` field and an hourly schedule.

## Clean up

```bash
sam delete --stack-name weather-alerts
# sam delete leaves Lambda's log groups behind:
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/weather-alerts- \
  --query "logGroups[].logGroupName" --output text | tr '\t' '\n' | \
  xargs -I{} aws logs delete-log-group --log-group-name {}
```

## What I learned

1. **EventBridge Scheduler beats scheduled rules** for anything people see: timezones and daylight saving just work.
2. **Filter on the person, not the alert.** SNS treats topic + protocol + email as one subscription.
3. **Async invocations have two retry layers**, and retries need idempotency.
4. **Design the table around the daily question.** "Who's due now, by city?" is a GSI Query, not a Scan.
5. **State the threat model, then pick controls.** That's what makes WAF and CAPTCHA make sense.
6. **CloudFormation's "complete" isn't DynamoDB's "ready".**

**Full code:** https://github.com/Rajpreet12/weather-alerts
