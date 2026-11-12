import { randomUUID } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { SNSClient, SubscribeCommand } from '@aws-sdk/client-sns'
import { validateRule, RULES } from './rules.mjs'
import { geocode } from './weather.mjs'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const sns = new SNSClient({})

const { TABLE_NAME, TOPIC_ARN } = process.env
const MAX_PER_EMAIL = Number(process.env.MAX_PER_EMAIL ?? 3)
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const handler = async (event) => {
  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return json(400, { error: 'Body must be JSON' })
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const city = typeof body.city === 'string' ? body.city.trim() : ''
  const rule = body.rule

  if (!EMAIL_RE.test(email)) return json(400, { error: 'A valid email is required' })
  if (!city || city.length > 80) return json(400, { error: 'city is required (max 80 characters)' })
  const ruleError = validateRule(rule)
  if (ruleError) return json(400, { error: ruleError })

  try {
    // Anyone can call this endpoint, and each call makes SNS email someone.
    // Cap subscriptions per address so it can't be used to spam an inbox.
    const existing = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'ByEmail',
        KeyConditionExpression: 'email = :e',
        ExpressionAttributeValues: { ':e': email },
        Select: 'COUNT',
      }),
    )
    if ((existing.Count ?? 0) >= MAX_PER_EMAIL) {
      return json(429, { error: `This email already has ${MAX_PER_EMAIL} alerts` })
    }

    const place = await geocode(city)
    if (!place) return json(404, { error: `Couldn't find a place called "${city}"` })

    const id = randomUUID()

    // One shared topic; a filter policy makes each email receive only its own alerts.
    // SNS sends the confirmation email (double opt-in) and adds an unsubscribe link for us.
    const sub = await sns.send(
      new SubscribeCommand({
        TopicArn: TOPIC_ARN,
        Protocol: 'email',
        Endpoint: email,
        Attributes: { FilterPolicy: JSON.stringify({ subscriptionId: [id] }) },
        ReturnSubscriptionArn: true,
      }),
    )

    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          id,
          email,
          ...place,
          rule: { type: rule.type, threshold: rule.threshold },
          snsSubscriptionArn: sub.SubscriptionArn,
          createdAt: new Date().toISOString(),
        },
      }),
    )

    console.log(JSON.stringify({ msg: 'subscribed', id, rule: rule.type, place: place.placeName }))
    return json(201, {
      id,
      place: place.placeName,
      rule: RULES[rule.type].describe(rule.threshold),
      next: 'Check your inbox and click "Confirm subscription" — alerts only start after that.',
    })
  } catch (err) {
    console.error(JSON.stringify({ msg: 'subscribe_failed', name: err.name, message: err.message }))
    return json(502, { error: 'Could not create the alert, please try again' })
  }
}
