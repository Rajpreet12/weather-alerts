import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'
import { evaluate, formatAlert } from './rules.mjs'
import { getDailyForecast } from './weather.mjs'
import { DEFAULT_CHECK_HOUR, groupSorted, toCheckHour } from './keys.mjs'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const sns = new SNSClient({})
const { TABLE_NAME, TOPIC_ARN, API_URL } = process.env
const CONCURRENCY = 5

/**
 * Reads only the subscriptions due at this hour, via the ByCheckHour GSI.
 * (v1 used a full-table Scan here — see "What I changed after feedback".)
 * Results come back sorted by locKey, i.e. already grouped by location.
 */
async function loadDueSubscriptions(checkHour) {
  const items = []
  let ExclusiveStartKey
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'ByCheckHour',
        KeyConditionExpression: 'checkHour = :h',
        ExpressionAttributeValues: { ':h': checkHour },
        ExclusiveStartKey,
      }),
    )
    items.push(...(page.Items ?? []))
    ExclusiveStartKey = page.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return items
}

async function alertOne(sub, daily) {
  const forecastDate = daily.time?.[0]
  // Idempotency: if a retry re-runs the whole job, people already alerted today are skipped.
  if (sub.lastAlertDate === forecastDate) return 'already_sent'

  const { triggered, value } = evaluate(sub.rule, daily)
  if (!triggered) return 'not_triggered'

  const unsubscribeUrl = `${API_URL}/unsubscribe?id=${encodeURIComponent(sub.id)}&token=${encodeURIComponent(sub.unsubscribeToken)}`
  const { subject, message } = formatAlert(sub, daily, value, 0, unsubscribeUrl)
  await sns.send(
    new PublishCommand({
      TopicArn: TOPIC_ARN,
      Subject: subject,
      Message: message,
      // Routed to this person's single SNS subscription (filter policy: recipientId).
      MessageAttributes: { recipientId: { DataType: 'String', StringValue: sub.recipientId } },
    }),
  )
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { id: sub.id },
      UpdateExpression: 'SET lastAlertDate = :d',
      ExpressionAttributeValues: { ':d': forecastDate },
    }),
  )
  return 'sent'
}

export const handler = async (event = {}) => {
  // The schedule runs at 7 a.m.; a manual invoke can pass {"checkHour":"07"} or any other hour.
  const checkHour = toCheckHour(event.checkHour ?? DEFAULT_CHECK_HOUR)
  const subs = await loadDueSubscriptions(checkHour)
  const groups = groupSorted(subs)
  const stats = { checkHour, subscriptions: subs.length, locations: groups.length, sent: 0, not_triggered: 0, already_sent: 0, failed: 0 }

  // Small fixed concurrency: fast enough, and polite to a free weather API.
  for (let i = 0; i < groups.length; i += CONCURRENCY) {
    await Promise.all(
      groups.slice(i, i + CONCURRENCY).map(async (g) => {
        let daily
        try {
          daily = await getDailyForecast(g.latitude, g.longitude)
        } catch (err) {
          stats.failed += g.subs.length
          console.error(JSON.stringify({ msg: 'forecast_failed', lat: g.latitude, lon: g.longitude, error: err.message }))
          return
        }
        for (const sub of g.subs) {
          try {
            stats[await alertOne(sub, daily)]++
          } catch (err) {
            stats.failed++
            console.error(JSON.stringify({ msg: 'alert_failed', id: sub.id, error: err.name }))
          }
        }
      }),
    )
  }

  console.log(JSON.stringify({ msg: 'run_complete', ...stats }))
  // Throwing makes Lambda retry the async invocation; idempotency above makes that safe.
  if (stats.failed > 0) throw new Error(`${stats.failed} alert(s) failed`)
  return stats
}
