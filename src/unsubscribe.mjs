import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { SNSClient, UnsubscribeCommand } from '@aws-sdk/client-sns'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const sns = new SNSClient({})
const { TABLE_NAME } = process.env

const ID_RE = /^[0-9a-f-]{36}$/
const TOKEN_RE = /^[0-9a-f]{48}$/

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const page = (statusCode, title, bodyHtml) => ({
  statusCode,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:440px;margin:15vh auto;padding:0 20px;color:#0f172a}button{background:#e11d48;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:16px;cursor:pointer}</style>
</head><body><h1>${esc(title)}</h1>${bodyHtml}</body></html>`,
})

function readParams(event) {
  if (event.requestContext?.http?.method === 'POST') {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || ''
    return Object.fromEntries(new URLSearchParams(raw))
  }
  return event.queryStringParameters ?? {}
}

export const handler = async (event) => {
  const { id = '', token = '' } = readParams(event)
  if (!ID_RE.test(id) || !TOKEN_RE.test(token)) return page(400, 'Invalid link', '<p>This unsubscribe link is incomplete.</p>')

  // GET only shows a button. Email security scanners "click" every link in an email;
  // if GET deleted the alert, a scanner could silently unsubscribe people.
  if (event.requestContext?.http?.method !== 'POST') {
    return page(
      200,
      'Stop this alert?',
      `<p>This removes just this one weather alert. Your other alerts keep working.</p>
       <form method="post"><input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="token" value="${esc(token)}">
       <button type="submit">Yes, stop this alert</button></form>`,
    )
  }

  try {
    // The token must match, so knowing (or guessing) an alert id isn't enough.
    const deleted = await ddb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { id },
        ConditionExpression: 'unsubscribeToken = :t',
        ExpressionAttributeValues: { ':t': token },
        ReturnValues: 'ALL_OLD',
      }),
    )
    const alert = deleted.Attributes

    // Last alert for this address? Remove the SNS subscription too, so nothing is left behind.
    const remaining = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'ByEmail',
        KeyConditionExpression: 'email = :e',
        ExpressionAttributeValues: { ':e': alert.email },
      }),
    )
    const others = (remaining.Items ?? []).filter((i) => i.id !== id) // GSI reads can lag the delete
    if (others.length === 0 && alert.snsSubscriptionArn?.startsWith('arn:')) {
      await sns.send(new UnsubscribeCommand({ SubscriptionArn: alert.snsSubscriptionArn }))
    }

    console.log(JSON.stringify({ msg: 'unsubscribed', id, remaining: others.length }))
    return page(200, 'Alert stopped', `<p>You won't get the <b>${esc(alert.placeName)}</b> alert any more.${others.length ? ` Your other ${others.length} alert(s) keep working.` : ''}</p>`)
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return page(404, 'Already stopped', '<p>This alert was already removed, or the link is wrong.</p>')
    }
    console.error(JSON.stringify({ msg: 'unsubscribe_failed', name: err.name }))
    return page(502, 'Something went wrong', '<p>Please try again in a minute.</p>')
  }
}
