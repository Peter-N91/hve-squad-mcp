// COST-2: a monthly resource-group budget with 70 / 90 / 100% alerts.

@description('Budget name.')
param name string

@description('Monthly amount in the billing currency (USD).')
@minValue(1)
param amount int

@description('First day of the budget month (YYYY-MM-01). A new budget must start in the current month or up to 12 months ahead.')
param startDate string

@description('Email addresses that receive the alerts.')
@minLength(1)
param contactEmails string[]

var thresholds = [
  70
  90
  100
]

resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: name
  properties: {
    category: 'Cost'
    amount: amount
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: startDate
    }
    notifications: toObject(thresholds, t => 'alert${t}', t => {
      enabled: true
      operator: 'GreaterThanOrEqualTo'
      threshold: t
      thresholdType: 'Actual'
      contactEmails: contactEmails
    })
  }
}
