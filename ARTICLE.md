# Build Serverless Weather Alerts with EventBridge Scheduler, Lambda, DynamoDB and SNS

*Get an email at 7 a.m. only on the days it matters — "rain chance ≥ 60%", "low ≤ −10°C", "wind ≥ 50 km/h". One SAM template, three AWS services doing the heavy lifting, no servers, no API keys, and about $0 a month at hobby scale.*

**Repo:** https://github.com/Rajpreet12/weather-alerts
**Time:** ~30 minutes · **You'll need:** an AWS account, AWS CLI v2, AWS SAM CLI, Node.js 20+

---

## The problem

Weather apps tell you everything, every day. I wanted the opposite: **silence, unless something I care about is about to happen.** I live in Calgary, where "is it going below −10 tonight?" decides whether I plug in the car. A daily forecast notification trains you to ignore it. An alert that only fires when a rule is crossed doesn't.

By the end of this tutorial you'll have:

- A public `POST /subscriptions` endpoint: give it an email, a city and a rule.
- A confirmation email (double opt-in) and an unsubscribe link — without writing any email code.
- A Lambda that runs every morning on a schedule, checks the forecast, and emails only the people whose rule triggered.
- Retries, a dead-letter queue, idempotency, abuse limits and least-privilege IAM.
- A clean-up command that removes all of it.

## Architecture

```
              POST /subscriptions
 curl / form ───────────────────► API Gateway (HTTP API, throttled)
                                        │
                                        ▼
                               SubscribeFunction (Lambda)
                                 │  geocode city (Open-Meteo)
                                 │  sns:Subscribe  + filter policy {subscriptionId:[id]}
                                 ▼
                          DynamoDB: Subscriptions  (GSI ByEmail)
                                 ▲
 EventBridge Scheduler           │ Scan
 cron(0 7 * * ? *)  ───────► CheckFunction (Lambda)
 America/Edmonton                │  1 forecast call per location (Open-Meteo)
                                 │  evaluate rules
                                 ▼
                          SNS topic ──(filter)──► only the matching inbox
                                 │
                failures ──► SQS dead-letter queues
```

### Why these services (and not the alternatives)

| Choice | Why | What I gave up |
|---|---|---|
| **EventBridge Scheduler** (not the older EventBridge *rule* with `schedule`) | Supports a **timezone**, so "7 a.m." stays 7 a.m. across daylight saving. Rules are UTC-only. Also has its own retry policy and DLQ. | Nothing meaningful — it's the newer, recommended option. |
| **SNS email + filter policies** (not SES) | SNS sends the confirmation email, handles the **unsubscribe link**, and needs no domain verification or "SES sandbox" exit request. One shared topic, and a filter policy per subscription routes each message to one inbox. | Plain-text emails only, the "From" name is generic, and SNS email isn't designed for high volume. For a real product with HTML emails, move to SES. |
| **Open-Meteo** (not OpenWeather etc.) | Free, **no API key**, so there's no secret to store in Secrets Manager. Has geocoding too. | Free tier is for non-commercial use and you must credit them (the email footer does). |
| **DynamoDB on-demand** | Pay per request; zero cost when idle. | A daily `Scan` is fine for thousands of subscriptions, not millions (see "Scaling" below). |
| **Lambda on arm64 (Graviton)** | ~20% cheaper per GB-second than x86, and this code has no native dependencies. | None for pure JavaScript. |

---

## Step 1 — Get the code

```bash
git clone https://github.com/Rajpreet12/weather-alerts weather-alerts
cd weather-alerts
npm test
```

Project layout:

```
template.yaml          # all infrastructure (SAM)
src/rules.mjs          # pure alert logic — no AWS, unit tested
src/weather.mjs        # Open-Meteo geocoding + forecast
src/subscribe.mjs      # POST /subscriptions
src/check.mjs          # daily scheduled job
test/rules.test.mjs
```

There's **no `npm install`** for the Lambdas. Node.js 24 Lambda includes the AWS SDK v3 and a global `fetch`, so the deployment package is just these four files.

---

## Step 2 — The alert rules (pure logic first)

I kept everything that decides "should we alert?" in a file with no AWS calls, so it's testable in milliseconds without deploying anything.

```js
// src/rules.mjs
export const RULES = {
  rain:  { label: 'Rain', unit: '%',    min: 1,   max: 100, field: 'precipitation_probability_max', describe: (t) => `rain chance ≥ ${t}%` },
  snow:  { label: 'Snow', unit: 'cm',   min: 0.1, max: 200, field: 'snowfall_sum',                  describe: (t) => `snowfall ≥ ${t} cm` },
  below: { label: 'Cold', unit: '°C',   min: -60, max: 50,  field: 'temperature_2m_min',            describe: (t) => `low ≤ ${t}°C` },
  above: { label: 'Heat', unit: '°C',   min: -30, max: 60,  field: 'temperature_2m_max',            describe: (t) => `high ≥ ${t}°C` },
  wind:  { label: 'Wind', unit: 'km/h', min: 1,   max: 300, field: 'wind_speed_10m_max',            describe: (t) => `wind ≥ ${t} km/h` },
}

export function evaluate(rule, daily, dayIndex = 0) {
  const def = RULES[rule.type]
  const value = daily?.[def.field]?.[dayIndex]
  if (typeof value !== 'number') return { triggered: false, value: null } // missing data never alerts
  const triggered = rule.type === 'below' ? value <= rule.threshold : value >= rule.threshold
  return { triggered, value }
}
```

Adding a new rule type is one line: pick an Open-Meteo daily field and a comparison. The forecast request asks for exactly the fields the rules use (`DAILY_FIELDS`), so nothing else changes.

Notice `missing data never alerts`. If the weather API returns `null` for a value, the safe failure is *silence*, not an alert reading "null°C".

```bash
npm test
```

```
✔ rain triggers at or above threshold
✔ below compares the daily low, inclusive
✔ above, snow and wind
✔ missing forecast data never alerts
✔ validateRule rejects bad input
✔ formatAlert subject stays under the SNS 100-char limit
ℹ pass 6
```

> **Small snag:** my first `package.json` used `"test": "node --test test/"`. On Windows that ran zero tests and reported a failure. Plain `node --test` (which auto-discovers `*.test.mjs`) works on every OS.

---

## Step 3 — Weather data with no API key

```js
// src/weather.mjs
async function getJson(url, timeoutMs = 5000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`)
  return res.json()
}

export async function geocode(city) {
  const data = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`)
  const r = data.results?.[0]
  if (!r) return null
  return {
    placeName: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: r.timezone ?? 'auto',
  }
}

export async function getDailyForecast(latitude, longitude) {
  const params = new URLSearchParams({
    latitude: String(latitude), longitude: String(longitude),
    daily: DAILY_FIELDS.join(','),
    timezone: 'auto',          // "today" means today *where the city is*
    forecast_days: '1',
  })
  const data = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`)
  if (!data.daily) throw new Error('Forecast response had no daily block')
  return data.daily
}
```

Two details that matter in production:

- **Always set a timeout on `fetch`.** Without `AbortSignal.timeout`, a hanging third-party API burns your whole Lambda timeout (and your money).
- **`timezone: 'auto'`** makes the daily values line up with the city's local calendar day, not UTC.

You can try it locally before touching AWS:

```bash
node -e "import('./src/weather.mjs').then(async m => { const p = await m.geocode('Calgary'); console.log(p, await m.getDailyForecast(p.latitude, p.longitude)) })"
```

Real output from my run:

```
{ placeName: 'Calgary, Alberta, Canada', latitude: 51.05011, longitude: -114.08529, timezone: 'America/Edmonton' }
{ time: ['2026-11-09'], precipitation_probability_max: [1], snowfall_sum: [0],
  temperature_2m_min: [3.4], temperature_2m_max: [10.4], wind_speed_10m_max: [33.6] }
```

---

## Step 4 — Subscribing: let SNS do the email work

The trick that keeps this project small: **one SNS topic for everyone, plus a filter policy on each subscription.**

```js
// src/subscribe.mjs (core)
const id = randomUUID()

const sub = await sns.send(new SubscribeCommand({
  TopicArn: TOPIC_ARN,
  Protocol: 'email',
  Endpoint: email,
  Attributes: { FilterPolicy: JSON.stringify({ subscriptionId: [id] }) },
  ReturnSubscriptionArn: true,
}))

await ddb.send(new PutCommand({
  TableName: TABLE_NAME,
  Item: { id, email, ...place, rule: { type: rule.type, threshold: rule.threshold },
          snsSubscriptionArn: sub.SubscriptionArn, createdAt: new Date().toISOString() },
}))
```

Later, the daily job publishes to the shared topic with a message attribute `subscriptionId = <id>`. SNS compares it to every subscription's filter policy and delivers to **only** the one that matches. Without the filter policy, every subscriber would get every alert.

What SNS gives you for free here:

1. **Double opt-in.** The person gets "AWS Notification – Subscription Confirmation" and nothing is delivered until they click *Confirm subscription*. So nobody can sign someone else up for alerts.
2. **Unsubscribe.** Every alert email has an unsubscribe link.

### Protecting a public endpoint

This endpoint has no login, and every successful call makes AWS send an email to an address the caller chose. That's an abuse vector, so there are three layers:

```js
// Validate everything
if (!EMAIL_RE.test(email)) return json(400, { error: 'A valid email is required' })
if (!city || city.length > 80) return json(400, { error: 'city is required (max 80 characters)' })
const ruleError = validateRule(rule)
if (ruleError) return json(400, { error: ruleError })

// Cap subscriptions per address (GSI query, COUNT only)
const existing = await ddb.send(new QueryCommand({
  TableName: TABLE_NAME, IndexName: 'ByEmail',
  KeyConditionExpression: 'email = :e', ExpressionAttributeValues: { ':e': email },
  Select: 'COUNT',
}))
if ((existing.Count ?? 0) >= MAX_PER_EMAIL) return json(429, { error: `This email already has ${MAX_PER_EMAIL} alerts` })
```

…plus API Gateway throttling (2 requests/second, burst 5) in the template. For a public launch I'd add AWS WAF rate-based rules or a CAPTCHA in front, too.

---

## Step 5 — The daily job

```js
// src/check.mjs (core)
export const handler = async () => {
  const subs = await loadSubscriptions()        // paginated Scan
  const groups = groupByLocation(subs)          // 50 people in Calgary → 1 forecast call
  const stats = { subscriptions: subs.length, locations: groups.length, sent: 0, not_triggered: 0, already_sent: 0, failed: 0 }

  for (let i = 0; i < groups.length; i += CONCURRENCY) {
    await Promise.all(groups.slice(i, i + CONCURRENCY).map(async (g) => {
      let daily
      try { daily = await getDailyForecast(g.latitude, g.longitude) }
      catch (err) { stats.failed += g.subs.length; return }
      for (const sub of g.subs) {
        try { stats[await alertOne(sub, daily)]++ }
        catch { stats.failed++ }
      }
    }))
  }

  console.log(JSON.stringify({ msg: 'run_complete', ...stats }))
  if (stats.failed > 0) throw new Error(`${stats.failed} alert(s) failed`)   // → retry
  return stats
}
```

Three production decisions in here:

**1. Group by location.** Subscriptions are bucketed by latitude/longitude rounded to 2 decimals (~1 km). The number of weather API calls scales with *places*, not *people*.

**2. Bounded concurrency.** 5 forecast calls at a time. Fast enough, and polite to a free API.

**3. Idempotency, so retries are safe.**

```js
async function alertOne(sub, daily) {
  const forecastDate = daily.time?.[0]
  if (sub.lastAlertDate === forecastDate) return 'already_sent'   // retry-safe

  const { triggered, value } = evaluate(sub.rule, daily)
  if (!triggered) return 'not_triggered'

  const { subject, message } = formatAlert(sub, daily, value)
  await sns.send(new PublishCommand({
    TopicArn: TOPIC_ARN, Subject: subject, Message: message,
    MessageAttributes: { subscriptionId: { DataType: 'String', StringValue: sub.id } },
  }))
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME, Key: { id: sub.id },
    UpdateExpression: 'SET lastAlertDate = :d',
    ExpressionAttributeValues: { ':d': forecastDate },
  }))
  return 'sent'
}
```

If one city's forecast call fails, the function throws at the end and Lambda retries the **whole** run. Without `lastAlertDate`, everyone who was already alerted would get a second email. With it, the retry only does the work that failed.

The order (publish, *then* record) is deliberate: if Lambda crashes between the two, the worst case is one duplicate email. Recording first would make the worst case a *missed* alert, which is worse for "it's going to be −25°C tonight".

---

## Step 6 — Infrastructure (SAM)

The full `template.yaml` is in the repo. The interesting parts:

### The schedule, in local time

```yaml
  CheckFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: check.handler
      Timeout: 300
      Policies:
        - DynamoDBCrudPolicy:
            TableName: !Ref SubscriptionsTable
        - SNSPublishMessagePolicy:
            TopicName: !GetAtt AlertsTopic.TopicName
      EventInvokeConfig:
        MaximumRetryAttempts: 2
        MaximumEventAgeInSeconds: 3600
        DestinationConfig:
          OnFailure:
            Type: SQS
      Events:
        DailyCheck:
          Type: ScheduleV2
          Properties:
            Name: !Sub ${AWS::StackName}-daily-check           # see "Step 7" for why
            ScheduleExpression: !Ref ScheduleExpression        # cron(0 7 * * ? *)
            ScheduleExpressionTimezone: !Ref ScheduleTimezone  # America/Edmonton
            RetryPolicy:
              MaximumRetryAttempts: 3
              MaximumEventAgeInSeconds: 3600
            DeadLetterConfig:
              Type: SQS
```

### Two retry layers — and why you need both

This confused me at first, so it's worth spelling out:

- **Scheduler's `RetryPolicy` + `DeadLetterConfig`** cover failures to *deliver* the invocation to Lambda (throttling, permission problems).
- Scheduler invokes Lambda **asynchronously**. Once Lambda accepts the event, if *your code* throws, **Lambda's** async retries (`EventInvokeConfig`) take over, and after those are exhausted the event goes to the `OnFailure` SQS queue.

Setting only the Scheduler retry policy looks right but doesn't catch bugs in your function. SAM creates both SQS queues for you when you write `Type: SQS` with no destination.

### Least-privilege IAM

Each function gets only what it uses:

```yaml
  SubscribeFunction:
    Properties:
      Policies:
        - DynamoDBCrudPolicy:
            TableName: !Ref SubscriptionsTable
        - Statement:
            - Effect: Allow
              Action: sns:Subscribe
              Resource: !Ref AlertsTopic
```

The subscribe function can't publish, and the check function can't subscribe anyone.

### Encryption at rest

The table stores email addresses, so it has encryption and point-in-time recovery turned on, and the SNS topic uses the AWS-managed KMS key:

```yaml
      SSESpecification:
        SSEEnabled: true
      PointInTimeRecoverySpecification:
        PointInTimeRecoveryEnabled: true
  AlertsTopic:
    Type: AWS::SNS::Topic
    Properties:
      KmsMasterKeyId: alias/aws/sns
```

Validate before deploying:

```bash
sam validate --lint
```

---

## Step 7 — Deploy

```bash
sam build
sam deploy --guided
```

Accept the defaults or set your own timezone when prompted for `ScheduleTimezone` (any IANA name, e.g. `Europe/London`, `Asia/Kolkata`). Then grab the API URL:

```bash
aws cloudformation describe-stacks --stack-name weather-alerts \
  --query "Stacks[0].Outputs" --output table
```

My first deploy went through cleanly. But when I went to inspect the schedule afterwards, I noticed something:

```bash
aws scheduler list-schedules --query "Schedules[].Name"
```

```json
["CheckFunctionDailyCheck"]
```

When you don't give a `ScheduleV2` event a name, SAM names the schedule after the function and event (`CheckFunctionDailyCheck`). **It doesn't include the stack name**, and schedule names must be unique within a schedule group. So a second copy of this stack in the same account (a `dev` and a `prod`, or a reader deploying it twice) would fail on a name clash. The fix is one line in the event properties:

```yaml
            Name: !Sub ${AWS::StackName}-daily-check
```

After redeploying, CloudFormation created `weather-alerts-daily-check` and deleted the old one. Confirm your schedule looks right (note the retry policy lives under `Target`, not at the top level):

```bash
aws scheduler get-schedule --name weather-alerts-daily-check \
  --query "{expr:ScheduleExpression,tz:ScheduleExpressionTimezone,state:State,retry:Target.RetryPolicy}"
```

```json
{
  "expr": "cron(0 7 * * ? *)",
  "tz": "America/Edmonton",
  "state": "ENABLED",
  "retry": { "MaximumEventAgeInSeconds": 3600, "MaximumRetryAttempts": 3 }
}
```

---

## Step 8 — Verify it works

### 1. Subscribe

Pick a rule that will trigger **today** so you can test right away (for example `above` with a threshold below today's high):

```bash
API=<ApiUrl from the outputs>

curl -s -X POST "$API/subscriptions" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","city":"Calgary","rule":{"type":"above","threshold":-30}}'
```

```json
{"id":"…","place":"Calgary, Alberta, Canada","rule":"high ≥ -30°C",
 "next":"Check your inbox and click \"Confirm subscription\" — alerts only start after that."}
```

### 2. Confirm

Open the "AWS Notification – Subscription Confirmation" email and click **Confirm subscription**. Check it took:

```bash
aws sns list-subscriptions-by-topic --topic-arn <AlertsTopicArn> \
  --query "Subscriptions[].[Endpoint,SubscriptionArn]" --output table
```

`PendingConfirmation` means you haven't clicked yet.

### 3. Run the daily job now, instead of waiting until 7 a.m.

```bash
aws lambda invoke --function-name <CheckFunctionName> response.json && cat response.json
```

```json
{"subscriptions":1,"locations":1,"sent":1,"not_triggered":0,"already_sent":0,"failed":0}
```

You should get the alert email within a minute. **Run the same command again:**

```json
{"subscriptions":1,"locations":1,"sent":0,"not_triggered":0,"already_sent":1,"failed":0}
```

That's idempotency working: no duplicate email.

### 4. Check the guard rails

```bash
# Bad rule → 400
curl -s -X POST "$API/subscriptions" -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","city":"Calgary","rule":{"type":"hail","threshold":1}}'

# Unknown city → 404
curl -s -X POST "$API/subscriptions" -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","city":"Nowhereville Zzzq","rule":{"type":"rain","threshold":50}}'
```

Real responses from my deployed stack:

```
{"error":"rule.type must be one of: rain, snow, below, above, wind"}    [400]
{"error":"A valid email is required"}                                    [400]
{"error":"Couldn't find a place called \"Nowhereville Zzzq\""}           [404]
{"error":"Body must be JSON"}                                            [400]
```

The per-email cap defaults to 3 (`MaxAlertsPerEmail`). With one alert already set up, two more subscribe calls succeed and the next returns `429 This email already has 3 alerts`. Each successful call sends a confirmation email, so expect those in your inbox.

### 5. Logs

```bash
sam logs --stack-name weather-alerts --name CheckFunction --tail
```

---

## What it costs

At hobby scale (say 100 subscribers, one run a day), everything here fits inside the AWS Free Tier or rounds to cents:

| Service | Usage per month | Notes |
|---|---|---|
| EventBridge Scheduler | 30 invocations | Free tier: 14 million/month |
| Lambda (arm64) | 30 runs + a few subscribe calls | Well inside free tier |
| DynamoDB on-demand | ~3,000 reads, a few writes | Cents at most |
| SNS email | only triggered days | Free tier: 1,000 email notifications/month |
| API Gateway HTTP API | a few hundred requests | Free tier: 1 million/month for 12 months |
| Open-Meteo | 30 × number of distinct cities | Free (non-commercial) |

Check current prices on the [AWS pricing pages](https://aws.amazon.com/pricing/) for your region. The real cost driver at scale would be SNS email volume, and at that point you'd move to SES anyway.

---

## Scaling and limits (honest version)

- **Scan is fine to ~tens of thousands of rows** on a once-a-day job. Beyond that, add a GSI keyed on a location cell and fan out per location with SQS, so each location is processed by its own Lambda invocation.
- **One Lambda run has a 15-minute ceiling.** Same fix: fan out via SQS.
- **SNS email** is meant for notifications, not newsletters. For branded HTML emails or high volume, use Amazon SES with a verified domain.
- **Unsubscribed users stay in DynamoDB.** SNS stops delivering to them (so they get nothing), but the daily job still evaluates them. A cleanup could check `GetSubscriptionAttributes` weekly and delete rows whose subscription is gone.
- **Single daily timezone.** Everyone is checked at 7 a.m. in one timezone. Per-user times would mean bucketing subscriptions by hour and running the schedule hourly.

---

## Clean up

```bash
sam delete --stack-name weather-alerts
```

This removes the API, both Lambdas, the table, the SNS topic (and therefore all email subscriptions), the schedule and both SQS queues. Nothing is left running or billing. Delete the `response.json` file from Step 8 if you like.

---

## What I learned

1. **EventBridge Scheduler beats scheduled rules** for anything human-facing, because of timezone and daylight saving support.
2. **SNS filter policies turn one topic into per-user delivery**, and you get double opt-in and unsubscribe links without writing email code.
3. **Async invocations have two retry layers.** Scheduler's retry policy doesn't catch errors thrown by your code; Lambda's `EventInvokeConfig` does.
4. **Retries need idempotency.** A `lastAlertDate` field is all it took to make "retry the whole job" safe.
5. **Keep decision logic pure.** `rules.mjs` has no AWS in it, so the part most likely to have bugs is tested in milliseconds without a deploy.

**Full code:** https://github.com/Rajpreet12/weather-alerts
