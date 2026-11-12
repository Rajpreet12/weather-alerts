# Weather Alerts (serverless)

Daily email alerts when the forecast crosses your rule (rain, snow, cold, heat, wind).
EventBridge Scheduler → Lambda → Open-Meteo → SNS email, with subscriptions in DynamoDB. Deployed with AWS SAM.

```bash
npm test                 # unit tests for the alert rules
sam build && sam deploy --guided
sam delete               # remove everything
```

Full walkthrough: [ARTICLE.md](ARTICLE.md). Weather data by [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0).
