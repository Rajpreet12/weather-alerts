import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { BatchGetCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { DEFAULT_CHECK_HOUR } from './keys.mjs'
import { RUN_PREFIX, dateInTz, lastNDates } from './runlog.mjs'
import { renderStatusPage } from './statuspage.mjs'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const { TABLE_NAME } = process.env
const SCHEDULE_TZ = process.env.SCHEDULE_TZ || 'UTC'

/** Active alerts and distinct cities, from the same GSI the daily job uses (Query, not Scan). */
async function countDue(checkHour) {
  const cells = new Set()
  let alerts = 0
  let ExclusiveStartKey
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'ByCheckHour',
        KeyConditionExpression: 'checkHour = :h',
        ExpressionAttributeValues: { ':h': checkHour },
        ProjectionExpression: 'locKey',
        ExclusiveStartKey,
      }),
    )
    for (const it of page.Items ?? []) {
      alerts++
      cells.add(it.locKey.slice(0, it.locKey.indexOf('#')))
    }
    ExclusiveStartKey = page.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return { alerts, cities: cells.size }
}

async function lastRuns(dates) {
  const res = await ddb.send(
    new BatchGetCommand({ RequestItems: { [TABLE_NAME]: { Keys: dates.map((d) => ({ id: `${RUN_PREFIX}${d}` })) } } }),
  )
  const byDate = new Map((res.Responses?.[TABLE_NAME] ?? []).map((r) => [r.runDate, r]))
  return dates.map((date) => ({ date, run: byDate.get(date) }))
}

export const handler = async () => {
  try {
    const dates = lastNDates(dateInTz(new Date(), SCHEDULE_TZ), 7)
    const [{ alerts, cities }, days] = await Promise.all([countDue(DEFAULT_CHECK_HOUR), lastRuns(dates)])
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=30' },
      body: renderStatusPage({ alerts, cities, timezone: SCHEDULE_TZ, checkHour: DEFAULT_CHECK_HOUR, days }),
    }
  } catch (err) {
    console.error(JSON.stringify({ msg: 'status_failed', name: err.name }))
    return { statusCode: 503, headers: { 'Content-Type': 'text/plain' }, body: 'Status temporarily unavailable' }
  }
}
