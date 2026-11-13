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

### Who this is for

This is built for **you and a small group: family and friends**, all checked at 7 a.m. in one home timezone (you pick it when you deploy). Tens of people, not millions. That keeps every AWS limit irrelevant and the cost at about zero. The "Scaling" section says what changes if you ever outgrow that.

### How to read this tutorial

**You won't type any application code.** You clone a working repo, deploy it with two commands, and verify it end to end. The code in each step is there to show *how the part works* and *where to change it* (a new rule type, a different timeout, your timezone). Every step starts with what the part does and why, then shows the code.

## Architecture

[IMAGE: 1-architecture.png]

### Why these services (and not the alternatives)

| Choice | Why | What I gave up |
|---|---|---|
| **EventBridge Scheduler** (not the older EventBridge *rule* with `schedule`) | Supports a **timezone**, so "7 a.m." stays 7 a.m. across daylight saving. Rules are UTC-only. Also has its own retry policy and DLQ. | Nothing meaningful — it's the newer, recommended option. |
| **SNS email + filter policies** (not SES) | With **Amazon SES** you must verify a sender address or domain, and new accounts start in the *SES sandbox*, where you can only email addresses you've verified yourself until AWS approves production access. You'd also build confirmation and unsubscribe handling yourself. **SNS** sends the confirmation email (double opt-in) and an unsubscribe link for free, and the same topic can later deliver **mobile push** notifications too. | Plain-text emails only and a generic sender name. For branded HTML email at volume, move to SES. |
| **A cloud service** (not a phone app) | Runs while your phone is off, needs no app install, works for anyone with an email address, and one forecast call serves everyone in the same city. | For a single person, a phone app with a scheduled background task could do this locally. The cloud version earns its keep when you share it. |
| **Open-Meteo** (not OpenWeather etc.) | Free, **no API key**, so there's no secret to store in Secrets Manager. Has geocoding too. | Free tier is for non-commercial use and you must credit them (the email footer does). |
| **DynamoDB on-demand + a GSI** | Pay per request; zero cost when idle. A GSI lets the daily job `Query` only what's due, already grouped by city. | Every write also updates the index. At millions of rows, one `checkHour` value needs sharding (see "Scaling"). |
| **Lambda on arm64 (Graviton)** | ~20% cheaper per GB-second than x86, and this code has no native dependencies. | None for pure JavaScript. |

---

## Step 1 — Get the code

Make sure the CLI is signed in to the account you want to deploy into:

```bash
aws login                       # or: aws configure
aws sts get-caller-identity     # shows the account you're about to deploy to
```

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
src/unsubscribe.mjs    # GET/POST /unsubscribe (stop one alert)
src/check.mjs          # daily scheduled job
src/keys.mjs           # key helpers — pure, unit tested
test/rules.test.mjs
test/keys.test.mjs
```

---

## Step 2 — Understand (and customize) the alert rules

**What it is:** the five rule types (rain, snow, cold, heat, wind) live in `src/rules.mjs` in the repo. It's ordinary source code you can edit **before you deploy**. It has no AWS calls in it, so the tests run in milliseconds on your laptop.

**When you'd change it:** to add a rule type. A humidity rule, for example, is one new line pointing at an Open-Meteo daily field, plus a comparison.

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
ℹ tests 13  ℹ pass 13  ℹ fail 0
```

> **Snag to avoid:** if you write your own test script, use plain `node --test`, with no folder argument. It finds every `*.test.mjs` file on Windows, macOS and Linux. Adding a folder (`node --test test/`) silently found **zero** tests on Windows when I tried it. The repo's `npm test` already uses the safe form, so you only hit this if you change it.

---

## Step 3 — How the weather data is fetched (no API key)

**What it does:** `src/weather.mjs` turns a city name into coordinates (geocoding) and fetches *today's* forecast for those coordinates from Open-Meteo, which is free and needs no API key, so there's no secret to manage.

Two details matter, and both are settings you can change:

- **Every call has a 5-second timeout.** Without it, a hanging weather API would burn your whole Lambda timeout (and your money). Change `timeoutMs` if you need a different limit.
- **`timezone: 'auto'`** makes "today" mean today *in the city's own timezone*, not UTC.

Here's where both live:

```js
// src/weather.mjs
async function getJson(url, timeoutMs = 5000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })   // ← the timeout
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`)
  return res.json()
}

export async function getDailyForecast(latitude, longitude) {
  const params = new URLSearchParams({
    latitude: String(latitude), longitude: String(longitude),
    daily: DAILY_FIELDS.join(','),
    timezone: 'auto',          // ← "today" where the city is
    forecast_days: '1',
  })
  const data = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`)
  if (!data.daily) throw new Error('Forecast response had no daily block')
  return data.daily
}
```

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

## Step 4 — Subscribing: one topic, one subscription per person

### What's a filter policy?

An **SNS topic** is a broadcast channel: by default, every message published to it goes to **every** subscriber. A **filter policy** is a rule you attach to one subscription that says *"only deliver messages whose attributes match this"*. Messages carry attributes (key/value tags) set by whoever publishes them.

So the design is:

- **One topic for everyone.**
- **One email subscription per person**, with the filter policy `{"recipientId": ["<hash of their email>"]}`.
- The daily job publishes each alert with the attribute `recipientId = <that person's hash>`, so SNS delivers it to that one inbox only.

**Why not one topic per city?** Because two people in Calgary have *different rules*: one wants rain alerts, the other cold alerts. A per-city topic would email both every time either rule fired. The decision "does this person get an email today?" has to be made per person, and filter policies do exactly that.

[IMAGE: 2-one-topic-many-inboxes.png]

```js
// src/subscribe.mjs (core)
const id = randomUUID()                      // this alert
const recipientId = recipientIdFor(email)    // this person: sha256(email), first 32 hex chars

const sub = await sns.send(new SubscribeCommand({
  TopicArn: TOPIC_ARN,
  Protocol: 'email',
  Endpoint: email,
  Attributes: { FilterPolicy: JSON.stringify({ recipientId: [recipientId] }) },
  ReturnSubscriptionArn: true,
}))
const attrs = await sns.send(new GetSubscriptionAttributesCommand({ SubscriptionArn: sub.SubscriptionArn }))
const confirmed = attrs.Attributes?.PendingConfirmation === 'false'   // tell the user if they must click "Confirm"

await ddb.send(new PutCommand({
  TableName: TABLE_NAME,
  Item: { id, email, recipientId, unsubscribeToken: newUnsubscribeToken(), ...place,
          rule: { type: rule.type, threshold: rule.threshold },
          checkHour: '07', locKey: locKey(place.latitude, place.longitude, id),   // Step 5's index
          snsSubscriptionArn: sub.SubscriptionArn, createdAt: new Date().toISOString() },
}))
```

What SNS gives you for free:

1. **Double opt-in.** The first time an address subscribes, it gets "AWS Notification – Subscription Confirmation", and nothing is delivered until they click *Confirm subscription*. Nobody can sign someone else up.
2. **"Stop everything".** Every email has an SNS unsubscribe link that removes that person from all alerts.

> **Real snag: a second city for the same email broke.** My first version gave every *alert* its own SNS subscription, with a filter on the alert id. A reviewer asked "what if I want two cities?" I tried it, and the second signup failed:
>
> ```
> InvalidParameterException: Invalid parameter: Attributes Reason: Subscription already exists with different attributes
> ```
>
> **SNS treats topic + protocol + email as one subscription.** Calling `Subscribe` again with the *same* attributes just returns the existing subscription (no new confirmation email). With *different* attributes, it's rejected. The fix is the design above: the filter policy depends only on the **person** (`recipientId`), never on the alert. Every alert for that email shares one subscription. A second city now returns `"Added to your existing alerts. No confirmation needed."`

### Stop just one city

The SNS link stops *everything*. To stop only "Toronto rain", each alert email also includes its own link:

```
Stop only this Toronto, Ontario, Canada alert: https://<api>/unsubscribe?id=<alert id>&token=<secret>
```

`src/unsubscribe.mjs` handles it in two steps, on purpose:

- **GET shows a page with a "Yes, stop this alert" button. It deletes nothing.** Email security scanners (common in work and school inboxes) automatically "click" every link in incoming mail. If a GET deleted the alert, a scanner would silently unsubscribe people.
- **POST deletes the alert**, but only if the `token` matches the one stored with it, so knowing an alert's id isn't enough. If it was that person's last alert, it also removes their SNS subscription, so nothing is left behind.

```js
// src/unsubscribe.mjs (core): POST
const deleted = await ddb.send(new DeleteCommand({
  TableName: TABLE_NAME, Key: { id },
  ConditionExpression: 'unsubscribeToken = :t',      // wrong or old token → "Already stopped"
  ExpressionAttributeValues: { ':t': token },
  ReturnValues: 'ALL_OLD',
}))
```

> **Real snag: IAM wanted the topic ARN.** To say "no confirmation needed", the subscribe function calls `GetSubscriptionAttributes`. I granted it on the *subscription* ARN (`<topic-arn>:*`) and got `AuthorizationErrorException ... not authorized to perform: SNS:GetSubscriptionAttributes on resource: <topic-arn>`. **SNS authorizes this action against the topic ARN.** The fix in `template.yaml` is `Resource: !Ref AlertsTopic`.

### The threat model for a public signup endpoint

`POST /subscriptions` has no login, and a successful call makes AWS send an email to an address **the caller chose**. Input validation (a real-looking email, a city under 80 characters, a known rule type) keeps bad data out, but it isn't protection. These are the threats, and what handles each:

| Threat | What it looks like | What stops it here | What I'd add for a public launch |
|---|---|---|---|
| **Inbox bombing** | Someone submits a victim's address over and over, flooding them with AWS confirmation emails | Max 3 alerts per address; repeat signups for an already-confirmed address send no new email | — |
| **Spraying many victims** | One attacker cycles through *thousands of different* addresses (the per-address cap doesn't help) | API Gateway throttling: 2 requests/second, burst 5, for the whole API | **AWS WAF rate-based rule** per source IP, so one client can't use the whole budget |
| **Bots** | Scripts filling in the form automatically | Throttling only | **CAPTCHA** (e.g. AWS WAF CAPTCHA) on the signup form |
| **Unwanted alerts** | Signing someone up who didn't ask | SNS double opt-in: nothing is delivered until the owner confirms | — |
| **Your sender reputation** | Recipients mark AWS confirmation emails as spam, and AWS can throttle your account's SNS email | All of the above keeps unsolicited emails rare | Monitor SNS delivery metrics |
| **Unsubscribing someone else** | Guessing alert ids, or a mail scanner pre-clicking links | Secret per-alert token + GET-shows-a-button, POST-deletes | — |

For the "family and friends" audience this tutorial targets, the right-hand column is optional. For a public product it isn't.

---

## Step 5 — The daily job

**What it does:** every morning at 7, find the alerts that are due, get one forecast per city, and email only the people whose rule is crossed. You don't need to change this code to use the project; it's here so you know where the retry and duplicate-email protection live.

The job must not read the whole table every morning. Instead, every subscription carries two extra attributes that feed a **global secondary index (GSI)**:

| GSI `ByCheckHour` | Example | Answers |
|---|---|---|
| Partition key `checkHour` | `"07"` | *Which subscriptions are due at this hour?* |
| Sort key `locKey` | `"51.05,-114.09#b780f6ac-…"` | Sorted by location (lat/lon rounded to ~1 km), then id |

`src/keys.mjs` builds `locKey` as `` `${lat.toFixed(2)},${lon.toFixed(2)}#${id}` ``. Because Query returns items sorted by that key, same-city alerts arrive next to each other, and `groupSorted()` groups them in one pass.

```js
// src/check.mjs (core)
async function loadDueSubscriptions(checkHour) {
  const items = []
  let ExclusiveStartKey
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'ByCheckHour',
      KeyConditionExpression: 'checkHour = :h',
      ExpressionAttributeValues: { ':h': checkHour },
      ExclusiveStartKey,
    }))
    items.push(...(page.Items ?? []))
    ExclusiveStartKey = page.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return items
}

export const handler = async (event = {}) => {
  const checkHour = toCheckHour(event.checkHour ?? DEFAULT_CHECK_HOUR)   // "07"
  const subs = await loadDueSubscriptions(checkHour)   // only what's due
  const groups = groupSorted(subs)                      // 50 people in Calgary → 1 forecast call
  const stats = { checkHour, subscriptions: subs.length, locations: groups.length, sent: 0, not_triggered: 0, already_sent: 0, failed: 0 }

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

> My first version used a full-table `Scan` here. A reader called it out, and they were right; see **"What I changed after community feedback"** below.

Three production decisions in here:

**1. Group by location, for free.** Because the GSI sort key starts with the rounded location, the Query returns each city's subscriptions next to each other. The number of weather API calls scales with *places*, not *people*, without any grouping work in memory.

**2. Bounded concurrency.** 5 forecast calls at a time. Fast enough, and polite to a free API.

**3. Idempotency, so retries are safe.**

```js
async function alertOne(sub, daily) {
  const forecastDate = daily.time?.[0]
  if (sub.lastAlertDate === forecastDate) return 'already_sent'   // retry-safe

  const { triggered, value } = evaluate(sub.rule, daily)
  if (!triggered) return 'not_triggered'

  const { subject, message } = formatAlert(sub, daily, value, 0, unsubscribeUrl)   // includes "Stop only this alert"
  await sns.send(new PublishCommand({
    TopicArn: TOPIC_ARN, Subject: subject, Message: message,
    MessageAttributes: { recipientId: { DataType: 'String', StringValue: sub.recipientId } },  // → one inbox
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

[IMAGE: 3-idempotent-retries.png]

---

## Step 6 — Infrastructure (SAM)

The full `template.yaml` is in the repo. The interesting parts:

### The index the daily job queries

```yaml
  SubscriptionsTable:
    Type: AWS::DynamoDB::Table
    Properties:
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - { AttributeName: id,        AttributeType: S }
        - { AttributeName: email,     AttributeType: S }
        - { AttributeName: checkHour, AttributeType: S }
        - { AttributeName: locKey,    AttributeType: S }
      KeySchema:
        - { AttributeName: id, KeyType: HASH }
      GlobalSecondaryIndexes:
        - IndexName: ByCheckHour            # daily job: Query, not Scan
          KeySchema:
            - { AttributeName: checkHour, KeyType: HASH }
            - { AttributeName: locKey,    KeyType: RANGE }
          Projection: { ProjectionType: ALL }
        - IndexName: ByEmail                # signup: per-email cap
          KeySchema:
            - { AttributeName: email, KeyType: HASH }
          Projection: { ProjectionType: KEYS_ONLY }
```

`ProjectionType: ALL` because the job needs the whole subscription (location, rule, `lastAlertDate`). `ByEmail` only counts, so `KEYS_ONLY` keeps it small.

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

[IMAGE: 4-two-retry-layers.png]

### Least privilege and encryption

Each function gets only the permissions it uses: the subscribe function can `sns:Subscribe` but not publish, the daily job can publish but not subscribe anyone, and each gets CRUD on only its own table. The table stores email addresses, so it has `SSEEnabled` and point-in-time recovery on, and the SNS topic is encrypted with the AWS-managed key `alias/aws/sns`.

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

On a day the rule triggers and no alert has gone out yet:

```json
{"checkHour":"07","subscriptions":1,"locations":1,"sent":1,"not_triggered":0,"already_sent":0,"failed":0}
```

You should get the alert email within a minute. **Run the same command again** — this is the real output from my stack:

```json
{"checkHour":"07","subscriptions":1,"locations":1,"sent":0,"not_triggered":0,"already_sent":1,"failed":0}
```

That's idempotency working: no duplicate email. It also holds across *different* runs. In my case the scheduled 7 a.m. run had already emailed me that morning, and my manual run later the same day skipped it.

[IMAGE: 5-alert-email.png]

You can also check that the index only returns what's due. Ask for a different hour:

```bash
aws lambda invoke --function-name <CheckFunctionName> \
  --cli-binary-format raw-in-base64-out --payload '{"checkHour":"08"}' response.json && cat response.json
```

```json
{"checkHour":"08","subscriptions":0,"locations":0,"sent":0,"not_triggered":0,"already_sent":0,"failed":0}
```

### 4. Add a second city, then stop just that one

```bash
curl -s -X POST "$API/subscriptions" -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","city":"Toronto","rule":{"type":"rain","threshold":50}}'
```

Real output (no new confirmation email, and still one SNS subscription for the address):

```json
{"id":"b92d4b86-…","place":"Toronto, Ontario, Canada","rule":"rain chance ≥ 50%",
 "next":"Added to your existing alerts. No confirmation needed."}
```

Each alert email has a *"Stop only this … alert"* link. Opening it shows a confirm page; pressing the button removes only that city. These are the real results from testing every path with curl:

```
GET  /unsubscribe?id=…&token=…     → 200 "Stop this alert?"   (nothing deleted: 2 alerts remain)
POST with a wrong token            → 404 "Already stopped"
POST with the right token          → 200 "You won't get the Toronto, Ontario, Canada alert any more.
                                          Your other 1 alert(s) keep working."
POST again                         → 404 "Already stopped"
alerts left: 1 · SNS subscriptions left: 1 (Calgary still works)
```

### 5. Check the guard rails

Send a bad rule, a bad email, an unknown city and a non-JSON body. Real responses from my deployed stack:

```
{"error":"rule.type must be one of: rain, snow, below, above, wind"}    [400]
{"error":"A valid email is required"}                                    [400]
{"error":"Couldn't find a place called \"Nowhereville Zzzq\""}           [404]
{"error":"Body must be JSON"}                                            [400]
```

The per-email cap defaults to 3 (`MaxAlertsPerEmail`). With one alert already set up, two more subscribe calls succeed and the next returns `429 This email already has 3 alerts`. No extra confirmation email is sent for an address that's already confirmed.

### 6. Logs

```bash
sam logs --stack-name weather-alerts --name CheckFunction --tail
```

---

## What I changed after community feedback

I shared a first draft in the contest Slack. The first comment was blunt and correct: *never like seeing a DynamoDB Scan; it looks simple to avoid here, with a GSI and/or secondary records written in a transaction.*

### Why the Scan was wrong

My v1 daily job did `Scan` → group in memory → check. A Scan reads **every item, every day**:

- **Cost grows with the table, not with the work.** It reads people who unsubscribed months ago and alerts due at other times.
- **It's slow at scale.** It reads at most 1 MB per page, one page after another.
- **It doesn't use the shape of the data.** I was sorting into cities in memory, work the database could have done.

In v1's "limits" section I'd written "Scan is fine to tens of thousands of rows". That was me defending a shortcut, not a design.

[IMAGE: 6-scan-vs-query.png]

### The two options

| Option | How it works | Why I did / didn't pick it |
|---|---|---|
| **GSI `ByCheckHour`** ✅ | Each subscription gets `checkHour` + `locKey`; DynamoDB maintains the index | No extra writes in my code, nothing to keep in sync. The Query returns items already grouped by location. |
| Secondary "location" records + `TransactWriteItems` | Write `LOC#<cell>` / `SUB#<id>` items in the same transaction as the subscription | Also correct, but every create, update and delete must keep two records in sync, and transactions cost 2× per write. |

The GSI also fixes another v1 limit: with `checkHour` as the partition key, switching the schedule to hourly and letting people choose their own hour is now a change to the signup API, not a redesign.

### Real snag #3: CloudFormation finished before the index did

I deployed the GSI and the new Query code together. `sam deploy` printed `UPDATE_COMPLETE` in 55 seconds. Then I invoked the job right away:

```
ValidationException: Cannot read from backfilling global secondary index: ByCheckHour
```

`aws dynamodb describe-table` showed:

```
ByEmail      ACTIVE
ByCheckHour  CREATING
```

**CloudFormation reports success when the GSI is *created*, not when it's *readable*.** On my one-row table the index took about **7 more minutes** to reach `ACTIVE`. DynamoDB keeps filling ("backfilling") the index in the background, and Queries fail until it's `ACTIVE`. If the 7 a.m. schedule had fired in that window, the run would have failed. The two retry layers from Step 6 would probably have covered it, but "probably" isn't a plan.

**The safe way to add a GSI to a live table is two deploys:**

1. Deploy the template with the new GSI, but keep the old code.
2. Backfill the new attributes on existing items, and wait until the index is `ACTIVE`.
3. Deploy the code that queries it.

### Backfilling existing rows

If you deployed an earlier version, rows written before the change don't have `checkHour` / `locKey`, so the index can't see them. I backfilled them once: a paginated Scan, then for each row an `UpdateItem` with `SET checkHour = :h, locKey = :l` and `ConditionExpression: attribute_not_exists(checkHour)`, so it's safe to re-run and never overwrites rows the new code already wrote. (Fresh deploys don't need this.)

Yes, a migration is the one place a Scan is fine: it runs once, not every morning.

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

- **A single `checkHour` value is one GSI partition key.** At millions of subscribers due at the same hour, split it into shards (`07#0` … `07#9`) and Query each shard in parallel.
- **One Lambda run has a 15-minute ceiling.** For very large runs, have the job enqueue one SQS message per location group and let a worker Lambda process each one.
- **SNS email** is meant for notifications, not newsletters. For branded HTML emails or high volume, use Amazon SES with a verified domain.
- **Unsubscribed users stay in DynamoDB.** SNS stops delivering to them (so they get nothing), but the daily job still evaluates them. A cleanup could check `GetSubscriptionAttributes` weekly and delete rows whose subscription is gone.
- **One alert time for everyone (for now).** The GSI is already keyed by hour. Per-user times only need an `hour` field on signup and an hourly schedule that queries the current hour.

---

## Clean up

```bash
sam delete --stack-name weather-alerts
```

This removes the API, both Lambdas, the table, the SNS topic (and therefore all email subscriptions), the schedule and both SQS queues.

`sam delete` does **not** remove the CloudWatch log groups, because Lambda creates them on first run, outside the stack. Delete them too, or they'll sit in your account (tiny, but not "clean"):

```bash
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/weather-alerts- \
  --query "logGroups[].logGroupName" --output text | tr '\t' '\n' | \
  xargs -I{} aws logs delete-log-group --log-group-name {}
```

Finally, confirm nothing is left:

```bash
aws cloudformation describe-stacks --stack-name weather-alerts   # → "Stack ... does not exist"
```

---

## What I learned

1. **EventBridge Scheduler beats scheduled rules** for anything human-facing, because of timezone and daylight saving support.
2. **SNS filter policies turn one topic into per-user delivery**, and you get double opt-in and unsubscribe links without writing email code.
3. **Async invocations have two retry layers.** Scheduler's retry policy doesn't catch errors thrown by your code; Lambda's `EventInvokeConfig` does.
4. **Retries need idempotency.** A `lastAlertDate` field is all it took to make "retry the whole job" safe.
5. **Design the table around the question you ask every day.** "Who's due now, grouped by city?" is a GSI Query, not a Scan. A reader spotted it in one sentence.
6. **Know what your service treats as "the same thing".** SNS sees topic + protocol + email as one subscription, so per-alert filter policies broke the second city. Filter on the person, not the alert.
7. **State the threat model, then pick controls.** "Validate the email" isn't protection; naming inbox bombing and spraying is what makes WAF and CAPTCHA make sense.
8. **CloudFormation's "complete" isn't DynamoDB's "ready".** Add a GSI, wait for `ACTIVE`, *then* ship code that reads it.
9. **Keep decision logic pure.** `rules.mjs` has no AWS in it, so the part most likely to have bugs is tested in milliseconds without a deploy.

**Full code:** https://github.com/Rajpreet12/weather-alerts
